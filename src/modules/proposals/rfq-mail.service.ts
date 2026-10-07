import {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  ERROR_CODES,
  INSURER_STATUS_LABELS,
  MAX_ATTACHMENT_BYTES,
  formatDate,
  isAwaitingResponse,
  mergeValuesFor,
  renderMail,
  type EmailTemplateKind,
  type InsurerStatus,
  type MailAttachmentFormat,
  type MailPreviewResponse,
  type PreviewMailRequest,
  type ProposalInsurer,
  type ProposalRecord,
  type RfqRecipient,
  type SendMailResponse,
  type SendReminderRequest,
  type SendResult,
  type SendRfqRequest,
} from '../../shared/index.ts';
import { Types } from 'mongoose';
import { withTransaction } from '../../lib/db.ts';
import { conflict, notFound, unprocessable, validationError } from '../../lib/errors.ts';
import { istDay } from '../../lib/ist-day.ts';
import { writeAudit } from '../audit/audit.service.ts';
import { getEmailTemplate } from '../email-templates/email-templates.service.ts';
import type { EmailTemplateDoc } from '../email-templates/email-template.model.ts';
import { MailLogModel, type MailLogDoc } from '../mail/mail-log.model.ts';
import {
  fitsAttachmentLimit,
  mailsOfSend,
  storeAttachment,
  type StoredAttachment,
} from '../mail/mail-log.service.ts';
import type { MailTransport } from '../mail/transport.ts';
import { UserModel } from '../users/user.model.ts';
import { ProposalModel, type ProposalDoc } from './proposal.model.ts';
import {
  closed,
  getProposal,
  keepStage,
  loadDoc,
  recordOf,
  type Actor,
} from './proposals.service.ts';
import { rfqFileFor } from './rfq-document.ts';

export interface MailDeps {
  transport: MailTransport;
  /** GST when the case has none and the tax master has no rate (config GST_RATE_PERCENT). */
  defaultGstRatePercent: string;
}

/** A claim older than this is taken to be from a send that stopped (the server went down). */
export const CLAIM_STALE_MS = 10 * 60 * 1000;

const nameOf = (insurer: Pick<ProposalInsurer, 'company' | 'branch'>) =>
  `${insurer.company}, ${insurer.branch}`;

function assertMailOn(transport: MailTransport): void {
  if (transport.name === 'off') {
    throw conflict(
      ERROR_CODES.MAIL_DISABLED,
      'Sending mail is turned off on this server. Send the RFQ outside the app and mark it sent.',
    );
  }
}

/** The case, open and with a complete Data Sheet, for mailing its RFQ. */
async function mailableCase(id: string): Promise<{ doc: ProposalDoc; record: ProposalRecord }> {
  const doc = await loadDoc(id);
  if (doc.stage === 'CLOSED') throw closed();
  const record = await recordOf(doc);
  if (record.missing.length > 0) {
    throw conflict(
      ERROR_CODES.DATA_SHEET_INCOMPLETE,
      'Finish the Data Sheet before sending the RFQ.',
      { missing: record.missing },
    );
  }
  return { doc, record };
}

function assertDueDate(dueDate: string): void {
  if (dueDate < istDay(new Date())) {
    throw validationError([
      { location: 'body', path: 'dueDate', message: 'The due date cannot be before today' },
    ]);
  }
}

/** The insurer's own addresses: its RFQ addresses and its contacts' emails, with the contact's name. */
function addressBook(insurer: ProposalInsurer): Map<string, string | null> {
  const book = new Map<string, string | null>();
  for (const email of insurer.rfqEmails) book.set(email.toLowerCase(), null);
  for (const contact of insurer.contacts) {
    const email = contact.email.toLowerCase();
    if (!book.get(email)) book.set(email, contact.name);
  }
  return book;
}

interface Recipient {
  insurer: ProposalInsurer;
  to: string[];
  contactName: string | null;
}

/**
 * Each insurer must be on the case and active, and each address one of its own in the insurer
 * master. Anything else refuses the whole request, so nothing is sent.
 */
function recipientsOf(record: ProposalRecord, chosen: readonly RfqRecipient[]): Recipient[] {
  const issues: Array<{ location: 'body'; path: string; message: string }> = [];
  const recipients: Recipient[] = [];
  chosen.forEach((entry, index) => {
    const insurer = record.insurers.find((item) => item.insurerId === entry.insurerId);
    if (!insurer) {
      issues.push({
        location: 'body',
        path: `insurers.${index}.insurerId`,
        message: 'Choose insurers already on the case',
      });
      return;
    }
    if (!insurer.active) {
      issues.push({
        location: 'body',
        path: `insurers.${index}.insurerId`,
        message: `${nameOf(insurer)} is inactive in the insurer master`,
      });
      return;
    }
    recipients.push(recipientOf(insurer, entry.to, `insurers.${index}.to`, issues));
  });
  if (issues.length > 0) throw validationError(issues);
  return recipients;
}

function recipientOf(
  insurer: ProposalInsurer,
  addresses: readonly string[],
  path: string,
  issues: Array<{ location: 'body'; path: string; message: string }>,
): Recipient {
  const book = addressBook(insurer);
  const to = addresses.map((address) => address.toLowerCase());
  for (const address of to) {
    if (!book.has(address)) {
      issues.push({
        location: 'body',
        path,
        message: `${address} is not an address of ${nameOf(insurer)} in the insurer master`,
      });
    }
  }
  const contactName = to.map((address) => book.get(address) ?? null).find(Boolean) ?? null;
  return { insurer, to, contactName };
}

async function senderOf(actor: Actor): Promise<{ name: string; email: string }> {
  const user = await UserModel.findById(actor.id, { name: 1, email: 1 }).lean();
  if (!user) throw notFound('Your user account no longer exists');
  return { name: user.name, email: user.email };
}

/** The RFQ file, kept once for every mail of the send; refused over the attachment limit. */
async function rfqAttachment(
  record: ProposalRecord,
  format: MailAttachmentFormat,
  deps: MailDeps,
): Promise<StoredAttachment> {
  const file = await rfqFileFor(record, format, deps.defaultGstRatePercent);
  if (!fitsAttachmentLimit(file.data.length)) {
    throw unprocessable(
      ERROR_CODES.RFQ_ATTACHMENT_TOO_LARGE,
      `The RFQ file is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB, too large to email. Download it and send it another way.`,
      { size: file.data.length },
    );
  }
  return storeAttachment({
    fileName: file.fileName,
    contentType: file.contentType,
    data: file.data,
  });
}

function render(
  template: Pick<EmailTemplateDoc, 'subject' | 'body'>,
  record: ProposalRecord,
  recipient: Recipient,
  dueDate: string,
  senderName: string,
) {
  return renderMail(
    template,
    mergeValuesFor({
      record,
      insurer: recipient.insurer,
      contactName: recipient.contactName,
      dueDate,
      senderName,
    }),
  );
}

/** A result answered from the log: the insurer already had this send's mail. */
function resultFromLog(insurer: ProposalInsurer, entry: MailLogDoc): SendResult {
  const failed = entry.result === 'FAILED';
  return {
    insurerId: insurer.insurerId,
    insurerName: nameOf(insurer),
    outcome: failed ? 'FAILED' : 'SENT',
    mailId: entry._id.toHexString(),
    reason: failed ? entry.error : null,
  };
}

/**
 * Claims an insurer for one mail: only when its status allows the mail and no other send holds
 * a live claim. Two sends from two tabs cannot both mail it.
 */
async function claim(
  doc: ProposalDoc,
  insurerId: string,
  statuses: readonly InsurerStatus[],
  sendId: string,
): Promise<boolean> {
  const now = new Date();
  const result = await ProposalModel.collection.updateOne(
    { _id: doc._id },
    { $set: { 'insurers.$[target].sending': { sendId, at: now } } },
    {
      arrayFilters: [
        {
          'target.insurerId': new Types.ObjectId(insurerId),
          'target.status': { $in: [...statuses] },
          $or: [
            { 'target.sending': null },
            { 'target.sending.at': { $lt: new Date(now.getTime() - CLAIM_STALE_MS) } },
          ],
        },
      ],
    },
  );
  return result.modifiedCount === 1;
}

async function release(doc: ProposalDoc, insurerId: string): Promise<void> {
  await ProposalModel.collection.updateOne(
    { _id: doc._id },
    { $set: { 'insurers.$[target].sending': null } },
    { arrayFilters: [{ 'target.insurerId': new Types.ObjectId(insurerId) }] },
  );
}

interface Delivery {
  doc: ProposalDoc;
  record: ProposalRecord;
  recipient: Recipient;
  kind: EmailTemplateKind;
  sendId: string;
  dueDate: string;
  template: EmailTemplateDoc;
  attachment: StoredAttachment | null;
  sender: { name: string; email: string };
  actor: Actor;
  transport: MailTransport;
}

/** Renders, sends and records one claimed mail: log, insurer, activity, stage and audit together. */
async function deliver(delivery: Delivery): Promise<SendResult> {
  const { doc, record, recipient, kind, actor, transport, attachment } = delivery;
  const insurer = recipient.insurer;
  let mail;
  try {
    mail = render(delivery.template, record, recipient, delivery.dueDate, delivery.sender.name);
  } catch (error) {
    await release(doc, insurer.insurerId);
    throw error;
  }
  const from = transport.from ?? '';
  const replyTo = delivery.sender.email;
  let sent;
  try {
    sent = await transport.send({
      from,
      replyTo,
      to: recipient.to,
      ...mail,
      attachment: attachment
        ? {
            fileName: attachment.fileName,
            contentType: attachment.contentType,
            data: attachment.data,
          }
        : null,
    });
  } catch {
    sent = { ok: false as const, reason: 'The mail could not be sent' };
  }
  const at = new Date();
  const mailId = new Types.ObjectId();
  const result = sent.ok ? sent.result : 'FAILED';
  const actorId = new Types.ObjectId(actor.id);
  const label = kind === 'RFQ' ? 'RFQ' : 'Reminder';
  const activity = sent.ok
    ? `${label} emailed to ${nameOf(insurer)} (${recipient.to.join(', ')}); quotes due ${formatDate(delivery.dueDate)}${result === 'OUTBOX' ? ' (kept in the outbox, not delivered)' : ''}`
    : `${label} email to ${nameOf(insurer)} failed: ${sent.reason}`;
  const nextStatus: InsurerStatus = !sent.ok
    ? insurer.status
    : kind === 'RFQ'
      ? 'SENT'
      : 'REMINDED';
  // $[target] is the insurer; $[waiting] is the insurer only while its status still allows this
  // mail, so an answer recorded meanwhile is never overwritten by Sent or Reminded.
  const set: Record<string, unknown> = {
    updatedBy: actorId,
    'insurers.$[target].sending': null,
    'insurers.$[target].lastMail': { id: mailId, kind, at, result },
  };
  const update: Record<string, unknown> = {
    $set: set,
    $push: { activity: { at, actorId, message: activity } },
  };
  if (sent.ok && kind === 'RFQ') {
    Object.assign(set, {
      'insurers.$[waiting].status': 'SENT',
      'insurers.$[waiting].sentVia': 'APP',
      'insurers.$[waiting].sentAt': at,
      'insurers.$[waiting].sentBy': actorId,
      'insurers.$[waiting].dueDate': delivery.dueDate,
    });
  } else if (sent.ok) {
    Object.assign(set, {
      'insurers.$[waiting].status': 'REMINDED',
      'insurers.$[waiting].lastRemindedAt': at,
    });
    update.$inc = { 'insurers.$[waiting].reminderCount': 1 };
  }
  const insurerKey = new Types.ObjectId(insurer.insurerId);
  const arrayFilters: Record<string, unknown>[] = [{ 'target.insurerId': insurerKey }];
  if (sent.ok) {
    arrayFilters.push({
      'waiting.insurerId': insurerKey,
      'waiting.status': { $in: kind === 'RFQ' ? ['NOT_SENT'] : ['SENT', 'REMINDED'] },
    });
  }

  await withTransaction(async (session) => {
    await MailLogModel.create(
      [
        {
          _id: mailId,
          proposalId: doc._id,
          insurerId: insurerKey,
          kind,
          sendId: delivery.sendId,
          from,
          replyTo,
          to: recipient.to,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
          templateVersion: delivery.template.version,
          attachmentId: attachment?.id ?? null,
          dueDate: delivery.dueDate,
          sentBy: actorId,
          at,
          transport: transport.name === 'smtp' ? 'smtp' : 'outbox',
          result,
          messageId: sent.ok ? sent.messageId : null,
          error: sent.ok ? null : sent.reason,
        },
      ],
      { session },
    );
    const updated = await ProposalModel.findOneAndUpdate({ _id: doc._id }, update, {
      arrayFilters,
      returnDocument: 'after',
      session,
    }).lean();
    if (!updated) throw notFound('Proposal not found');
    await keepStage(updated, session);
    await writeAudit(
      {
        userId: actor.id,
        action: !sent.ok
          ? AUDIT_ACTIONS.RFQ_EMAIL_FAILED
          : kind === 'RFQ'
            ? AUDIT_ACTIONS.RFQ_EMAILED
            : AUDIT_ACTIONS.RFQ_REMINDER_EMAILED,
        entity: AUDIT_ENTITIES.PROPOSAL,
        entityId: record.id,
        before: { insurer: nameOf(insurer), status: INSURER_STATUS_LABELS[insurer.status] },
        after: {
          insurer: nameOf(insurer),
          status: INSURER_STATUS_LABELS[nextStatus],
          kind,
          to: recipient.to.join(', '),
          mailId: mailId.toHexString(),
          result,
          dueDate: delivery.dueDate,
          attachment: attachment?.fileName ?? null,
          ...(sent.ok ? {} : { error: sent.reason }),
        },
        requestId: actor.requestId,
      },
      session,
    );
  });
  return {
    insurerId: insurer.insurerId,
    insurerName: nameOf(insurer),
    outcome: sent.ok ? 'SENT' : 'FAILED',
    mailId: mailId.toHexString(),
    reason: sent.ok ? null : sent.reason,
  };
}

/** Builds the mails a send would make, from the saved template. Sends and stores nothing. */
export async function previewMails(
  id: string,
  input: PreviewMailRequest,
  actor: Actor,
): Promise<MailPreviewResponse> {
  const { record } = await mailableCase(id);
  if (input.kind === 'RFQ' && input.dueDate) assertDueDate(input.dueDate);
  const recipients = recipientsOf(record, input.insurers);
  const [template, sender] = await Promise.all([getEmailTemplate(input.kind), senderOf(actor)]);
  return {
    mails: recipients.map((recipient) => {
      const dueDate = input.dueDate ?? recipient.insurer.dueDate ?? record.dueDate;
      return {
        insurerId: recipient.insurer.insurerId,
        insurerName: nameOf(recipient.insurer),
        to: recipient.to,
        ...render(template, record, recipient, dueDate, sender.name),
      };
    }),
    attachmentName: input.kind === 'RFQ' ? `RFQ-${record.reference}.${input.format}` : null,
  };
}

/**
 * Emails the RFQ: one mail per insurer, to that insurer's chosen addresses only, with the RFQ
 * attached. A failure for one insurer leaves it Not sent and does not stop the others. Repeating
 * the same sendId mails nobody again.
 */
export async function sendRfq(
  id: string,
  input: SendRfqRequest,
  actor: Actor,
  deps: MailDeps,
): Promise<SendMailResponse> {
  assertMailOn(deps.transport);
  const { doc, record } = await mailableCase(id);
  const recipients = recipientsOf(record, input.insurers);
  const done = await mailsOfSend(doc._id, input.sendId, 'RFQ');
  const pending = recipients.filter((recipient) => !done.has(recipient.insurer.insurerId));
  if (pending.length > 0) assertDueDate(input.dueDate);

  const results = new Map<string, SendResult>();
  for (const recipient of recipients) {
    const entry = done.get(recipient.insurer.insurerId);
    if (entry) results.set(recipient.insurer.insurerId, resultFromLog(recipient.insurer, entry));
  }
  // Requirement 4.9: naming an insurer that already has the RFQ refuses the send. (One sent by
  // this same sendId is answered from the log above; one sent by a racing send is SKIPPED below.)
  const alreadySent = pending.filter((recipient) => recipient.insurer.status !== 'NOT_SENT');
  if (alreadySent.length > 0) {
    throw conflict(
      ERROR_CODES.CONFLICT,
      `The RFQ was already sent to ${alreadySent.map((recipient) => nameOf(recipient.insurer)).join('; ')}. Choose only insurers that are Not sent.`,
      { insurerIds: alreadySent.map((recipient) => recipient.insurer.insurerId) },
    );
  }
  if (pending.length > 0) {
    const [template, sender, attachment] = await Promise.all([
      getEmailTemplate('RFQ'),
      senderOf(actor),
      rfqAttachment(record, input.format, deps),
    ]);
    for (const recipient of pending) {
      const insurerId = recipient.insurer.insurerId;
      if (!(await claim(doc, insurerId, ['NOT_SENT'], input.sendId))) {
        results.set(insurerId, skipped(recipient.insurer));
        continue;
      }
      results.set(
        insurerId,
        await deliver({
          doc,
          record,
          recipient,
          kind: 'RFQ',
          sendId: input.sendId,
          dueDate: input.dueDate,
          template,
          attachment,
          sender,
          actor,
          transport: deps.transport,
        }),
      );
    }
  }
  return {
    results: recipients.flatMap((recipient) => results.get(recipient.insurer.insurerId) ?? []),
    proposal: await getProposal(id),
  };
}

/** Not mailed now: another send to this insurer is in progress or has just finished. */
function skipped(insurer: ProposalInsurer): SendResult {
  return {
    insurerId: insurer.insurerId,
    insurerName: nameOf(insurer),
    outcome: 'SKIPPED',
    mailId: null,
    reason: `Another send to ${nameOf(insurer)} is in progress or has just finished`,
  };
}

/** Reminds one insurer that has the RFQ and has not answered, with the Reminder template. */
export async function sendReminder(
  id: string,
  insurerId: string,
  input: SendReminderRequest,
  actor: Actor,
  deps: MailDeps,
): Promise<SendMailResponse> {
  assertMailOn(deps.transport);
  const { doc, record } = await mailableCase(id);
  const insurer = record.insurers.find((item) => item.insurerId === insurerId);
  if (!insurer) throw notFound('This insurer is not on the case');
  const issues: Array<{ location: 'body'; path: string; message: string }> = [];
  const recipient = recipientOf(insurer, input.to, 'to', issues);
  if (issues.length > 0) throw validationError(issues);

  const done = (await mailsOfSend(doc._id, input.sendId, 'REMINDER')).get(insurerId);
  let result: SendResult;
  if (done) {
    result = resultFromLog(insurer, done);
  } else if (!isAwaitingResponse(insurer.status)) {
    throw conflict(
      ERROR_CODES.CONFLICT,
      `${nameOf(insurer)} is ${INSURER_STATUS_LABELS[insurer.status]}: only an insurer waiting to answer the RFQ can be reminded.`,
    );
  } else if (!(await claim(doc, insurerId, ['SENT', 'REMINDED'], input.sendId))) {
    result = skipped(insurer);
  } else {
    const [template, sender, attachment] = await Promise.all([
      getEmailTemplate('REMINDER'),
      senderOf(actor),
      input.attachRfq ? rfqAttachment(record, input.format, deps) : Promise.resolve(null),
    ]).catch(async (error: unknown) => {
      await release(doc, insurerId);
      throw error;
    });
    result = await deliver({
      doc,
      record,
      recipient,
      kind: 'REMINDER',
      sendId: input.sendId,
      dueDate: insurer.dueDate ?? record.dueDate,
      template,
      attachment,
      sender,
      actor,
      transport: deps.transport,
    });
  }
  return { results: [result], proposal: await getProposal(id) };
}
