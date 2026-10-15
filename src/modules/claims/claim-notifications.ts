import {
  AUDIT_ACTIONS,
  CLAIM_STATUS_LABELS,
  ERROR_CODES,
  formatDate,
  formatIndianNumber,
  renderClaimMail,
  type ClaimEmailAudience,
  type ClaimNotification,
  type ClaimStatus,
} from '../../shared/index.ts';
import { Types, type mongo } from 'mongoose';
import { withTransaction } from '../../lib/db.ts';
import { conflict, notFound } from '../../lib/errors.ts';
import { istDay } from '../../lib/ist-day.ts';
import type { Logger } from '../../lib/logger.ts';
import { ClientModel } from '../clients/client.model.ts';
import type { MailTransport } from '../mail/transport.ts';
import { auditClaim, toNotification, type ClaimActor } from './claim-common.ts';
import {
  ClaimEventModel,
  ClaimNotificationModel,
  type ClaimDoc,
  type ClaimNotificationDoc,
} from './claim.model.ts';
import { ClaimHrContactModel } from './claim-settings.model.ts';
import { claimTemplate } from './claim-templates.service.ts';

// Claim emails (C3) follow the outbox pattern. A status change writes its notifications in the
// same transaction as the change, so they exist exactly when the change does. Sending happens
// after the commit: a failure is recorded and retried, and never undoes the change.

/** Automatic tries per notification before it is left Failed for a person to retry. */
export const CLAIM_MAIL_ATTEMPTS = 3;
/** Waits before the 2nd and 3rd automatic tries. */
export const CLAIM_MAIL_BACKOFF_MS = [60_000, 5 * 60_000];
/** A send that started this long ago and never finished (a crash) is tried again. */
export const CLAIM_MAIL_STALE_MS = 10 * 60_000;

interface Recipient {
  audience: ClaimEmailAudience;
  email: string;
  name: string | null;
}

/** Who a status change emails: the claimant, and HR when configured and switched on. */
async function recipientsOf(claim: ClaimDoc, session: mongo.ClientSession): Promise<Recipient[]> {
  const recipients: Recipient[] = [
    { audience: 'CLAIMANT', email: claim.contactEmail.toLowerCase(), name: claim.employee.name },
  ];
  const hr = await ClaimHrContactModel.findOne({ clientId: claim.clientId })
    .session(session)
    .lean();
  if (hr?.notify && hr.email && hr.email.toLowerCase() !== recipients[0]!.email) {
    recipients.push({ audience: 'HR', email: hr.email.toLowerCase(), name: hr.name });
  }
  return recipients;
}

/** Queues the emails a status change owes, in the change's transaction. */
export async function enqueueStatusEmails(
  claim: ClaimDoc,
  change: { eventId: Types.ObjectId; from: ClaimStatus; to: ClaimStatus; remark: string; at: Date },
  session: mongo.ClientSession,
): Promise<void> {
  const client = await ClientModel.findById(claim.clientId, { name: 1 }).session(session).lean();
  const base = {
    claimNumber: claim.claimNumber,
    employeeName: claim.employee.name,
    patientName: claim.patient.name,
    companyName: client?.name ?? '',
    hospital: claim.hospital.city
      ? `${claim.hospital.name}, ${claim.hospital.city}`
      : claim.hospital.name,
    amount: `₹${formatIndianNumber(claim.amountClaimed.toString(), 2)}`,
    status: CLAIM_STATUS_LABELS[change.to],
    previousStatus: CLAIM_STATUS_LABELS[change.from],
    date: formatDate(istDay(change.at)),
    remark: change.remark,
  };
  const docs = [];
  for (const recipient of await recipientsOf(claim, session)) {
    const template = await claimTemplate(change.to, recipient.audience);
    const mail = renderClaimMail(template, { ...base, recipientName: recipient.name ?? '' });
    docs.push({
      claimId: claim._id,
      eventId: change.eventId,
      audience: recipient.audience,
      recipient: recipient.email,
      recipientName: recipient.name,
      toStatus: change.to,
      templateVersion: template.version,
      ...mail,
      status: 'PENDING' as const,
      attempts: 0,
      lastAttemptAt: null,
      nextAttemptAt: change.at,
      sendingSince: null,
      error: null,
      messageId: null,
    });
  }
  await ClaimNotificationModel.insertMany(docs, { session });
}

/**
 * Sends one notification if it is due, recording the attempt as a timeline event. A notification
 * is taken for sending atomically, so two workers (or a worker and a request) never send it twice.
 * Returns the notification as it ends, or null when it was not due.
 */
export async function sendClaimNotification(
  id: Types.ObjectId,
  transport: MailTransport,
  options: { manualRetry?: boolean } = {},
): Promise<ClaimNotificationDoc | null> {
  const now = new Date();
  const taken = await ClaimNotificationModel.findOneAndUpdate(
    {
      _id: id,
      $or: [
        { status: 'PENDING', nextAttemptAt: { $lte: now } },
        { status: 'SENDING', sendingSince: { $lt: new Date(now.getTime() - CLAIM_MAIL_STALE_MS) } },
      ],
    },
    { $set: { status: 'SENDING', sendingSince: now }, $inc: { attempts: 1 } },
    { returnDocument: 'after' },
  ).lean();
  if (!taken) return null;

  let ok = false;
  let result: 'ACCEPTED' | 'OUTBOX' | 'FAILED' = 'FAILED';
  let error: string | null = null;
  let messageId: string | null = null;
  if (transport.name === 'off') {
    error = 'Sending mail is turned off on this server';
  } else {
    try {
      const sent = await transport.send({
        from: transport.from ?? '',
        replyTo: null,
        to: [taken.recipient],
        subject: taken.subject,
        text: taken.text,
        html: taken.html,
        attachment: null,
      });
      if (sent.ok) {
        ok = true;
        result = sent.result === 'OUTBOX' ? 'OUTBOX' : 'ACCEPTED';
        messageId = sent.messageId;
      } else {
        error = sent.reason;
      }
    } catch {
      error = 'The mail could not be sent';
    }
  }

  // Mail off is not retried by itself; other failures are, with a growing wait, up to the limit.
  const retryAutomatically =
    !ok && transport.name !== 'off' && !options.manualRetry && taken.attempts < CLAIM_MAIL_ATTEMPTS;
  const backoff =
    CLAIM_MAIL_BACKOFF_MS[Math.min(taken.attempts - 1, CLAIM_MAIL_BACKOFF_MS.length - 1)] ?? 0;
  const at = new Date();
  return withTransaction(async (session) => {
    const updated = await ClaimNotificationModel.findOneAndUpdate(
      { _id: taken._id, status: 'SENDING', sendingSince: now },
      {
        $set: {
          status: ok ? result : retryAutomatically ? 'PENDING' : 'FAILED',
          lastAttemptAt: at,
          nextAttemptAt: retryAutomatically ? new Date(at.getTime() + backoff) : null,
          sendingSince: null,
          error,
          messageId,
        },
      },
      { returnDocument: 'after', session },
    ).lean();
    await ClaimEventModel.create(
      [
        {
          claimId: taken.claimId,
          type: ok ? 'EMAIL_SENT' : 'EMAIL_FAILED',
          at,
          actorKind: 'SYSTEM',
          actorId: null,
          fromStatus: null,
          toStatus: taken.toStatus,
          remark: null,
          changes: [],
          email: {
            notificationId: taken._id,
            audience: taken.audience,
            recipient: taken.recipient,
            subject: taken.subject,
            attempt: taken.attempts,
            result,
            error,
            messageId,
          },
          detail: null,
        },
      ],
      { session },
    );
    await auditClaim(
      null,
      ok ? AUDIT_ACTIONS.CLAIM_EMAIL_SENT : AUDIT_ACTIONS.CLAIM_EMAIL_FAILED,
      taken.claimId.toHexString(),
      null,
      {
        audience: taken.audience,
        to: taken.recipient,
        status: taken.toStatus,
        attempt: taken.attempts,
        result,
        ...(error ? { error } : {}),
      },
      session,
    );
    return updated ?? taken;
  });
}

/** Sends a claim's due notifications now (after a status change). Errors never reach the caller. */
export async function dispatchClaim(
  claimId: Types.ObjectId,
  transport: MailTransport,
  logger?: Logger,
): Promise<void> {
  const due = await ClaimNotificationModel.find(
    { claimId, status: 'PENDING', nextAttemptAt: { $lte: new Date() } },
    { _id: 1 },
  ).lean();
  for (const item of due) {
    try {
      await sendClaimNotification(item._id, transport);
    } catch (error) {
      // The notification stays Pending or Sending; the worker picks it up again.
      logger?.warn(
        { err: error, notificationId: item._id.toHexString() },
        'Claim email could not be processed',
      );
    }
  }
}

/** One pass of the background worker: every due or stale notification, oldest first. */
export async function processDueClaimNotifications(
  transport: MailTransport,
  logger?: Logger,
  limit = 50,
): Promise<number> {
  const now = new Date();
  const due = await ClaimNotificationModel.find(
    {
      $or: [
        { status: 'PENDING', nextAttemptAt: { $lte: now } },
        { status: 'SENDING', sendingSince: { $lt: new Date(now.getTime() - CLAIM_MAIL_STALE_MS) } },
      ],
    },
    { _id: 1 },
  )
    .sort({ nextAttemptAt: 1, _id: 1 })
    .limit(limit)
    .lean();
  let processed = 0;
  for (const item of due) {
    try {
      if (await sendClaimNotification(item._id, transport)) processed += 1;
    } catch (error) {
      logger?.warn(
        { err: error, notificationId: item._id.toHexString() },
        'Claim email could not be processed',
      );
    }
  }
  return processed;
}

/** Runs the worker every interval until stopped. The timer does not keep the process alive. */
export function startClaimNotificationWorker(options: {
  transport: MailTransport;
  logger: Logger;
  intervalMs?: number;
}): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    processDueClaimNotifications(options.transport, options.logger)
      .catch((error: unknown) => options.logger.error({ err: error }, 'Claim email worker failed'))
      .finally(() => {
        running = false;
      });
  }, options.intervalMs ?? 30_000);
  timer.unref();
  return () => clearInterval(timer);
}

/** A person retries a failed email (after fixing the address or turning mail on). Audited. */
export async function retryClaimNotification(
  claimId: string,
  notificationId: string,
  actor: ClaimActor,
  transport: MailTransport,
): Promise<ClaimNotification> {
  const id = new Types.ObjectId(notificationId);
  const queued = await withTransaction(async (session) => {
    const doc = await ClaimNotificationModel.findOneAndUpdate(
      { _id: id, claimId: new Types.ObjectId(claimId), status: 'FAILED' },
      { $set: { status: 'PENDING', nextAttemptAt: new Date(), error: null } },
      { returnDocument: 'after', session },
    ).lean();
    if (!doc) {
      const exists = await ClaimNotificationModel.exists({
        _id: id,
        claimId: new Types.ObjectId(claimId),
      }).session(session);
      if (!exists) throw notFound('Email not found');
      throw conflict(ERROR_CODES.CONFLICT, 'Only a failed email can be retried.');
    }
    await ClaimEventModel.create(
      [
        {
          claimId: doc.claimId,
          type: 'EMAIL_RETRY_REQUESTED',
          at: new Date(),
          actorKind: 'STAFF',
          actorId: actor.id ? new Types.ObjectId(actor.id) : null,
          fromStatus: null,
          toStatus: doc.toStatus,
          remark: null,
          changes: [],
          email: null,
          detail: doc.recipient,
        },
      ],
      { session },
    );
    await auditClaim(
      actor,
      AUDIT_ACTIONS.CLAIM_EMAIL_RETRIED,
      claimId,
      { status: 'FAILED' },
      { to: doc.recipient, status: doc.toStatus },
      session,
    );
    return doc;
  });
  const sent = await sendClaimNotification(queued._id, transport, { manualRetry: true });
  return toNotification(sent ?? queued);
}
