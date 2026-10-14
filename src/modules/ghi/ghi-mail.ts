import {
  ERROR_CODES,
  MAX_ATTACHMENT_BYTES,
  formatDate,
  policyPeriodText,
  renderMail,
  type EmailTemplateKind,
  type GhiDispatch,
  type MailResult,
} from '../../shared/index.ts';
import type { Types, mongo } from 'mongoose';
import { conflict, notFound, unprocessable } from '../../lib/errors.ts';
import { getEmailTemplate } from '../email-templates/email-templates.service.ts';
import { fitsAttachmentLimit, storeAttachment } from '../mail/mail-log.service.ts';
import type { MailTransport } from '../mail/transport.ts';
import { UserModel } from '../users/user.model.ts';
import { nameOf, userNames } from './ghi-common.ts';
import type { GhiCaseDoc } from './ghi-case.model.ts';
import { GhiDispatchModel, type GhiDispatchDoc } from './ghi-workflow.model.ts';

// Mail for GHI cases goes through the same transport, templates and attachment store as
// Property (E-2): the RFQ template to insurers, the QCR template to the client. A mail is
// reported as sent only when the transport accepted it; every attempt is kept in ghi_dispatches.

export function assertMailOn(transport: MailTransport, what: string): void {
  if (transport.name === 'off') {
    throw conflict(
      ERROR_CODES.MAIL_DISABLED,
      `Sending mail is turned off on this server. Download the ${what} and send it outside the app.`,
    );
  }
}

export interface Delivery {
  ok: boolean;
  result: MailResult;
  messageId: string | null;
  error: string | null;
}

export interface PreparedMail {
  subject: string;
  text: string;
  html: string;
  replyTo: string;
  templateKind: EmailTemplateKind;
}

/** The mail from an Admin-edited template, with the case's merge values. */
export async function prepareMail(
  kind: 'RFQ' | 'QCR',
  doc: GhiCaseDoc,
  clientName: string,
  recipientName: string,
  dueDate: string,
  actorId: string,
): Promise<PreparedMail> {
  const sender = await UserModel.findById(actorId, { name: 1, email: 1 }).lean();
  if (!sender) throw notFound('Your user account no longer exists');
  const template = await getEmailTemplate(kind);
  const mail = renderMail(template, {
    insuredName: clientName,
    policyPeriod: policyPeriodText(doc.policyStart, doc.policyEnd),
    dueDate: formatDate(dueDate),
    reference: doc.reference,
    insurerName: recipientName,
    contactName: '',
    senderName: sender.name,
  });
  return { ...mail, replyTo: sender.email, templateKind: kind };
}

export async function prepareAttachment(file: {
  fileName: string;
  contentType: string;
  data: Buffer;
}) {
  if (!fitsAttachmentLimit(file.data.length)) {
    throw unprocessable(
      ERROR_CODES.RFQ_ATTACHMENT_TOO_LARGE,
      `The file is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB, too large to email. Send the PDF or Excel instead, or send it outside the app.`,
      { size: file.data.length },
    );
  }
  return storeAttachment(file);
}

export async function deliver(
  transport: MailTransport,
  mail: PreparedMail,
  to: string[],
  attachment: { fileName: string; contentType: string; data: Buffer },
): Promise<Delivery> {
  try {
    const sent = await transport.send({
      from: transport.from ?? '',
      replyTo: mail.replyTo,
      to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      attachment,
    });
    return sent.ok
      ? { ok: true, result: sent.result, messageId: sent.messageId, error: null }
      : { ok: false, result: 'FAILED', messageId: null, error: sent.reason };
  } catch {
    return { ok: false, result: 'FAILED', messageId: null, error: 'The mail could not be sent' };
  }
}

export async function logDispatch(
  input: {
    caseId: Types.ObjectId;
    kind: 'RFQ' | 'QCR';
    documentId: Types.ObjectId;
    insurerId: Types.ObjectId | null;
    recipient: string;
    sendId: string;
    to: string[];
    mail: PreparedMail;
    attachment: { id: Types.ObjectId; fileName: string };
    dueDate: string | null;
    actorId: Types.ObjectId;
    transport: MailTransport;
    delivery: Delivery;
  },
  session: mongo.ClientSession,
): Promise<void> {
  await GhiDispatchModel.create(
    [
      {
        caseId: input.caseId,
        kind: input.kind,
        documentId: input.documentId,
        insurerId: input.insurerId,
        recipient: input.recipient,
        sendId: input.sendId,
        from: input.transport.from ?? '',
        replyTo: input.mail.replyTo,
        to: input.to,
        subject: input.mail.subject,
        text: input.mail.text,
        attachmentId: input.attachment.id,
        attachmentName: input.attachment.fileName,
        dueDate: input.dueDate,
        sentBy: input.actorId,
        at: new Date(),
        transport: input.transport.name === 'smtp' ? 'smtp' : 'outbox',
        result: input.delivery.result,
        messageId: input.delivery.messageId,
        error: input.delivery.error,
      },
    ],
    { session },
  );
}

export function toDispatch(doc: GhiDispatchDoc, names: ReadonlyMap<string, string>): GhiDispatch {
  return {
    id: doc._id.toHexString(),
    kind: doc.kind,
    insurerId: doc.insurerId?.toHexString() ?? null,
    recipient: doc.recipient,
    to: doc.to,
    subject: doc.subject,
    attachment: doc.attachmentName,
    at: doc.at.toISOString(),
    by: nameOf(names, doc.sentBy),
    result: doc.result,
    error: doc.error,
  };
}

export async function dispatchesOf(
  caseId: Types.ObjectId,
  filter: { kind: 'RFQ' | 'QCR'; documentId?: Types.ObjectId },
): Promise<GhiDispatch[]> {
  const docs = await GhiDispatchModel.find({ caseId, ...filter })
    .sort({ at: -1, _id: -1 })
    .limit(200)
    .lean();
  const names = await userNames(docs.map((doc) => doc.sentBy));
  return docs.map((doc) => toDispatch(doc, names));
}
