import {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  ERROR_CODES,
  MAX_ATTACHMENT_BYTES,
  PDF_CONTENT_TYPE,
  QUOTE_OPTION_LABELS,
  XLSX_CONTENT_TYPE,
  mergeValuesFor,
  renderMail,
  type MailAttachmentFormat,
  type ProposalRecord,
  type Qcr,
  type QcrSendResponse,
  type SaveQcrRequest,
  type SendQcrRequest,
} from '../../shared/index.ts';
import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import type ExcelJS from 'exceljs';
import { withTransaction } from '../../lib/db.ts';
import { conflict, notFound, unprocessable, validationError } from '../../lib/errors.ts';
import { istDay } from '../../lib/ist-day.ts';
import { writeAudit } from '../audit/audit.service.ts';
import { catalogItems, taxRatePercentOn } from '../catalog/catalog.service.ts';
import { ClientModel } from '../clients/client.model.ts';
import { openTemplate, saveWorkbook } from '../documents/excel-template.ts';
import { letterheadOf, workbookToPdf, type Letterhead } from '../documents/sheet-pdf.ts';
import { templateFile } from '../documents/templates.service.ts';
import { getEmailTemplate } from '../email-templates/email-templates.service.ts';
import { MailLogModel } from '../mail/mail-log.model.ts';
import { fitsAttachmentLimit, storeAttachment } from '../mail/mail-log.service.ts';
import type { MailTransport } from '../mail/transport.ts';
import { ProposalModel } from '../proposals/proposal.model.ts';
import { closed, loadDoc, recordOf, type Actor } from '../proposals/proposals.service.ts';
import { pdfSheets } from '../proposals/rfq-document.ts';
import { proposalQuotes } from '../quotes/quotes.service.ts';
import { UserModel } from '../users/user.model.ts';
import { buildComparison } from './qcr-build.ts';
import { QcrModel, type QcrDoc } from './qcr.model.ts';
import { fillQcrTemplate } from './qcr-template.ts';
import { buildQcrWorkbookDocument } from './qcr-workbook.ts';

// The QCR (QC-1 to QC-6): built from the latest quotes each time it is read; the broker's part is
// kept per case. Approval is for exactly what the approver saw (a fingerprint of the figures and
// the broker's part): a new quote version or an edit afterwards voids it, and only an approved QCR
// is mailed to the insured.

export interface QcrDeps {
  defaultGstRatePercent: string;
  transport: MailTransport;
}

interface Loaded {
  record: ProposalRecord;
  qcr: Qcr;
  doc: QcrDoc | null;
  /** Each compared insurer's latest deductibles and conditions, for the schedule. */
  terms: Map<string, { deductibles: string | null; conditions: string | null }>;
}

async function names(
  ids: readonly (Types.ObjectId | null | undefined)[],
): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.flatMap((id) => (id ? [id.toHexString()] : [])))];
  const users = await UserModel.find({ _id: { $in: wanted } }, { name: 1 }).lean();
  return new Map(users.map((user) => [user._id.toHexString(), user.name]));
}

function fingerprintOf(
  qcr: Omit<
    Qcr,
    | 'fingerprint'
    | 'approval'
    | 'status'
    | 'sends'
    | 'missing'
    | 'recipients'
    | 'updatedAt'
    | 'updatedBy'
  >,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        insurers: qcr.insurers.map((insurer) => insurer.insurerId),
        options: qcr.options.map((option) => ({
          option: option.option,
          sections: option.sections,
          quotes: option.quotes.map((quote) => [quote.insurerId, quote.quoteId]),
        })),
        recommendedInsurerId: qcr.recommendedInsurerId,
        recommendedOption: qcr.recommendedOption,
        recommendation: qcr.recommendation,
        remarks: qcr.remarks,
        paymentInFavourOf: qcr.paymentInFavourOf,
      }),
    )
    .digest('hex')
    .slice(0, 32);
}

/** The case's QCR as it stands now. */
async function load(id: string, deps: Pick<QcrDeps, 'defaultGstRatePercent'>): Promise<Loaded> {
  const proposal = await loadDoc(id);
  const record = await recordOf(proposal);
  const [quotes, doc, client] = await Promise.all([
    proposalQuotes(id, deps.defaultGstRatePercent),
    QcrModel.findOne({ proposalId: proposal._id }).lean(),
    ClientModel.findById(proposal.clientId, { contacts: 1 }).lean(),
  ]);
  const comparison = buildComparison(record, quotes, quotes.gstRatePercent);
  const users = await names([
    doc?.updatedBy,
    doc?.approval?.by,
    ...(doc?.sends ?? []).map((send) => send.by),
  ]);
  const base = {
    gstRatePercent: quotes.gstRatePercent,
    insurers: comparison.insurers.map((insurer) => ({
      insurerId: insurer.insurerId,
      company: insurer.company,
      branch: insurer.branch,
      status: insurer.status,
    })),
    options: comparison.options,
    recommendedInsurerId: doc?.recommendedInsurerId?.toHexString() ?? null,
    recommendedOption: doc?.recommendedOption ?? null,
    recommendation: doc?.recommendation ?? null,
    remarks: doc?.remarks ?? null,
    paymentInFavourOf: doc?.paymentInFavourOf ?? null,
  };
  const fingerprint = fingerprintOf(base);

  const missing: string[] = [];
  if (!comparison.options.some((option) => option.quotes.length > 0)) {
    missing.push('Record at least one insurer’s quote.');
  }
  if (!base.recommendedInsurerId || !base.recommendedOption) {
    missing.push('Choose the insurer and the option recommended.');
  } else {
    const option = comparison.options.find((item) => item.option === base.recommendedOption);
    if (!option?.quotes.some((quote) => quote.insurerId === base.recommendedInsurerId)) {
      missing.push(
        `The recommended insurer has no quote in the QCR for ${QUOTE_OPTION_LABELS[base.recommendedOption]}.`,
      );
    }
  }
  if (!base.paymentInFavourOf) missing.push('Enter who the cheque / payment is in favour of.');

  const approvalCurrent = doc?.approval?.fingerprint === fingerprint;
  const sentNow = (doc?.sends ?? []).some(
    (send) => send.fingerprint === fingerprint && send.result !== 'FAILED',
  );
  const terms = new Map<string, { deductibles: string | null; conditions: string | null }>();
  for (const insurer of quotes.insurers) {
    const latest = insurer.quotes
      .flatMap((entry) => entry.versions.slice(0, 1))
      .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (latest)
      terms.set(insurer.insurerId, {
        deductibles: latest.deductibles,
        conditions: latest.conditions,
      });
  }
  const qcr: Qcr = {
    ...base,
    status: approvalCurrent ? (sentNow ? 'SENT' : 'APPROVED') : 'DRAFT',
    updatedAt: doc?.updatedAt.toISOString() ?? null,
    updatedBy: doc?.updatedBy ? (users.get(doc.updatedBy.toHexString()) ?? 'Unknown user') : null,
    fingerprint,
    approval: doc?.approval
      ? {
          at: doc.approval.at.toISOString(),
          by: users.get(doc.approval.by.toHexString()) ?? 'Unknown user',
          current: approvalCurrent,
        }
      : null,
    missing,
    sends: (doc?.sends ?? [])
      .toSorted((a, b) => b.at.getTime() - a.at.getTime())
      .map((send) => ({
        mailId: send.mailId.toHexString(),
        at: send.at.toISOString(),
        by: users.get(send.by.toHexString()) ?? 'Unknown user',
        to: [...send.to],
        result: send.result,
        error: send.error,
      })),
    recipients: (client?.contacts ?? []).flatMap((contact) =>
      contact.email ? [{ name: contact.name, email: contact.email }] : [],
    ),
  };
  return { record, qcr, doc, terms };
}

export async function getQcr(
  id: string,
  deps: Pick<QcrDeps, 'defaultGstRatePercent'>,
): Promise<Qcr> {
  return (await load(id, deps)).qcr;
}

/** Saves the broker's part (QC-3): recommendation, remarks and payment. Voids an approval. */
export async function saveQcr(
  id: string,
  input: SaveQcrRequest,
  actor: Actor,
  deps: Pick<QcrDeps, 'defaultGstRatePercent'>,
): Promise<Qcr> {
  const proposal = await loadDoc(id);
  if (proposal.stage === 'CLOSED') throw closed();
  if (
    input.recommendedInsurerId &&
    !proposal.insurers.some(
      (insurer) => insurer.insurerId.toHexString() === input.recommendedInsurerId,
    )
  ) {
    throw validationError([
      { location: 'body', path: 'recommendedInsurerId', message: 'Choose an insurer on this case' },
    ]);
  }
  const before = await load(id, deps);
  await withTransaction(async (session) => {
    await QcrModel.updateOne(
      { proposalId: proposal._id },
      {
        $set: {
          recommendedInsurerId: input.recommendedInsurerId
            ? new Types.ObjectId(input.recommendedInsurerId)
            : null,
          recommendedOption: input.recommendedOption,
          recommendation: input.recommendation,
          remarks: input.remarks,
          paymentInFavourOf: input.paymentInFavourOf,
          updatedBy: new Types.ObjectId(actor.id),
        },
        $setOnInsert: { approval: null, sends: [] },
      },
      { upsert: true, session },
    );
    await writeAudit(
      {
        userId: actor.id,
        action: AUDIT_ACTIONS.QCR_SAVED,
        entity: AUDIT_ENTITIES.PROPOSAL,
        entityId: id,
        before: auditView(before.qcr),
        after: { ...input },
        requestId: actor.requestId,
      },
      session,
    );
  });
  return getQcr(id, deps);
}

function auditView(qcr: Qcr) {
  return {
    recommendedInsurerId: qcr.recommendedInsurerId,
    recommendedOption: qcr.recommendedOption,
    recommendation: qcr.recommendation,
    remarks: qcr.remarks,
    paymentInFavourOf: qcr.paymentInFavourOf,
  };
}

/** Approves the QCR exactly as the approver saw it (QC-6). */
export async function approveQcr(
  id: string,
  fingerprint: string,
  actor: Actor,
  deps: Pick<QcrDeps, 'defaultGstRatePercent'>,
): Promise<Qcr> {
  const { qcr, record } = await load(id, deps);
  if (record.stage === 'CLOSED') throw closed();
  if (qcr.missing.length > 0) {
    throw conflict(ERROR_CODES.QCR_INCOMPLETE, 'The QCR is not ready for approval.', {
      missing: qcr.missing,
    });
  }
  if (qcr.fingerprint !== fingerprint) {
    throw conflict(
      ERROR_CODES.QCR_CHANGED,
      'The QCR changed since you opened it (a quote or the recommendation). Review it again before approving.',
    );
  }
  const at = new Date();
  const actorId = new Types.ObjectId(actor.id);
  await withTransaction(async (session) => {
    await QcrModel.updateOne(
      { proposalId: new Types.ObjectId(id) },
      { $set: { approval: { at, by: actorId, fingerprint } }, $setOnInsert: { sends: [] } },
      { upsert: true, session },
    );
    await ProposalModel.updateOne(
      { _id: new Types.ObjectId(id) },
      { $push: { activity: { at, actorId, message: 'QCR approved' } } },
      { session },
    );
    await writeAudit(
      {
        userId: actor.id,
        action: AUDIT_ACTIONS.QCR_APPROVED,
        entity: AUDIT_ENTITIES.PROPOSAL,
        entityId: id,
        before: null,
        after: { ...auditView(qcr), fingerprint },
        requestId: actor.requestId,
      },
      session,
    );
  });
  return getQcr(id, deps);
}

/** The QCR as a workbook: the client's template filled, else the built-in layout. */
async function qcrWorkbook(
  loaded: Loaded,
  defaultGstRatePercent: string,
): Promise<{ workbook: ExcelJS.Workbook; letterhead: Letterhead }> {
  const { record, qcr, terms } = loaded;
  const client = await ClientModel.findById(record.client.id).lean();
  if (!client) throw notFound('The proposal’s client no longer exists');
  const [gstRatePercent, products, sections, notes, addons, template] = await Promise.all([
    record.gstRatePercent ??
      taxRatePercentOn('GST', istDay(new Date(record.createdAt)), defaultGstRatePercent),
    catalogItems('products'),
    catalogItems('sections'),
    catalogItems('notes'),
    catalogItems('addons'),
    templateFile('QCR'),
  ]);
  const masters = { gstRatePercent, products, sections, notes, addons };
  if (template) {
    const workbook = await openTemplate(template.data);
    const letterhead = letterheadOf(workbook);
    fillQcrTemplate(workbook, record, client, masters, qcr, terms);
    return { workbook, letterhead };
  }
  return {
    workbook: buildQcrWorkbookDocument(record, client, masters, qcr),
    letterhead: { logo: null, address: null },
  };
}

async function fileOf(loaded: Loaded, format: MailAttachmentFormat, defaultGstRatePercent: string) {
  const { workbook, letterhead } = await qcrWorkbook(loaded, defaultGstRatePercent);
  const name = `QCR-${loaded.record.reference}`;
  return format === 'pdf'
    ? {
        fileName: `${name}.pdf`,
        contentType: PDF_CONTENT_TYPE,
        data: await workbookToPdf(workbook, {
          sheets: pdfSheets(workbook, loaded.record),
          letterhead,
          title: `QCR ${loaded.record.reference} — ${loaded.record.client.name}`,
          footer: `QCR ${loaded.record.reference} · ${loaded.record.client.name}`,
        }),
      }
    : {
        fileName: `${name}.xlsx`,
        contentType: XLSX_CONTENT_TYPE,
        data: await saveWorkbook(workbook),
      };
}

/** The QCR to download (QC-5), audited as an export. A draft can be downloaded to review. */
export async function qcrDocument(
  id: string,
  format: MailAttachmentFormat,
  actor: Actor,
  deps: Pick<QcrDeps, 'defaultGstRatePercent'>,
): Promise<{ fileName: string; contentType: string; data: Buffer; status: Qcr['status'] }> {
  const loaded = await load(id, deps);
  if (!loaded.qcr.options.some((option) => option.quotes.length > 0)) {
    throw conflict(ERROR_CODES.QCR_INCOMPLETE, 'There are no quotes to compare yet.', {
      missing: loaded.qcr.missing,
    });
  }
  const file = await fileOf(loaded, format, deps.defaultGstRatePercent);
  await writeAudit({
    userId: actor.id,
    action: AUDIT_ACTIONS.QCR_DOWNLOADED,
    entity: AUDIT_ENTITIES.PROPOSAL,
    entityId: id,
    after: { reference: loaded.record.reference, format, status: loaded.qcr.status },
    requestId: actor.requestId,
  });
  return { ...file, status: loaded.qcr.status };
}

/** Mails the approved QCR to the insured (QC-6); an unapproved one cannot be sent. */
export async function sendQcr(
  id: string,
  input: SendQcrRequest,
  actor: Actor,
  deps: QcrDeps,
): Promise<QcrSendResponse> {
  if (deps.transport.name === 'off') {
    throw conflict(
      ERROR_CODES.MAIL_DISABLED,
      'Sending mail is turned off on this server. Download the QCR and send it outside the app.',
    );
  }
  const loaded = await load(id, deps);
  const { record, qcr, doc } = loaded;
  if (record.stage === 'CLOSED') throw closed();
  // The same send again (a retry) is answered from what it did.
  const earlier = doc?.sends.find((send) => send.sendId === input.sendId);
  if (earlier) {
    return {
      outcome: earlier.result === 'FAILED' ? 'FAILED' : 'SENT',
      reason: earlier.error,
      qcr,
    };
  }
  if (qcr.status === 'DRAFT') {
    throw conflict(
      ERROR_CODES.QCR_NOT_APPROVED,
      qcr.approval
        ? 'The QCR changed after it was approved. It must be approved again before it is sent.'
        : 'The QCR must be approved before it is sent to the insured.',
    );
  }
  const file = await fileOf(loaded, input.format, deps.defaultGstRatePercent);
  if (!fitsAttachmentLimit(file.data.length)) {
    throw unprocessable(
      ERROR_CODES.RFQ_ATTACHMENT_TOO_LARGE,
      `The QCR file is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB, too large to email.`,
      { size: file.data.length },
    );
  }
  const attachment = await storeAttachment(file);
  const sender = await UserModel.findById(actor.id, { name: 1, email: 1 }).lean();
  if (!sender) throw notFound('Your user account no longer exists');
  const template = await getEmailTemplate('QCR');
  const recommended = qcr.insurers.find(
    (insurer) => insurer.insurerId === qcr.recommendedInsurerId,
  );
  const contact = qcr.recipients.find(
    (item) => input.to.includes(item.email.toLowerCase()) || input.to.includes(item.email),
  );
  const mail = renderMail(
    template,
    mergeValuesFor({
      record,
      insurer: recommended ?? { company: '', branch: '' },
      contactName: contact?.name ?? null,
      dueDate: record.dueDate,
      senderName: sender.name,
    }),
  );
  const to = input.to.map((email) => email.toLowerCase());
  let sent;
  try {
    sent = await deps.transport.send({
      from: deps.transport.from ?? '',
      replyTo: sender.email,
      to,
      ...mail,
      attachment: { fileName: file.fileName, contentType: file.contentType, data: file.data },
    });
  } catch {
    sent = { ok: false as const, reason: 'The mail could not be sent' };
  }
  const at = new Date();
  const mailId = new Types.ObjectId();
  const result = sent.ok ? sent.result : 'FAILED';
  const actorId = new Types.ObjectId(actor.id);
  const proposalId = new Types.ObjectId(id);
  await withTransaction(async (session) => {
    await MailLogModel.create(
      [
        {
          _id: mailId,
          proposalId,
          insurerId: null,
          kind: 'QCR',
          sendId: input.sendId,
          from: deps.transport.from ?? '',
          replyTo: sender.email,
          to,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
          templateVersion: template.version,
          attachmentId: attachment.id,
          dueDate: null,
          sentBy: actorId,
          at,
          transport: deps.transport.name === 'smtp' ? 'smtp' : 'outbox',
          result,
          messageId: sent.ok ? sent.messageId : null,
          error: sent.ok ? null : sent.reason,
        },
      ],
      { session },
    );
    await QcrModel.updateOne(
      { proposalId },
      {
        $push: {
          sends: {
            mailId,
            sendId: input.sendId,
            at,
            by: actorId,
            to,
            result,
            error: sent.ok ? null : sent.reason,
            fingerprint: qcr.fingerprint,
          },
        },
      },
      { session },
    );
    await ProposalModel.updateOne(
      { _id: proposalId },
      {
        $push: {
          activity: {
            at,
            actorId,
            message: sent.ok
              ? `QCR emailed to the insured (${to.join(', ')})${result === 'OUTBOX' ? ' (kept in the outbox, not delivered)' : ''}`
              : `QCR email to the insured failed: ${sent.reason}`,
          },
        },
      },
      { session },
    );
    await writeAudit(
      {
        userId: actor.id,
        action: sent.ok ? AUDIT_ACTIONS.QCR_EMAILED : AUDIT_ACTIONS.QCR_EMAIL_FAILED,
        entity: AUDIT_ENTITIES.PROPOSAL,
        entityId: id,
        before: null,
        after: {
          to: to.join(', '),
          mailId: mailId.toHexString(),
          result,
          attachment: file.fileName,
          fingerprint: qcr.fingerprint,
          ...(sent.ok ? {} : { error: sent.reason }),
        },
        requestId: actor.requestId,
      },
      session,
    );
  });
  return {
    outcome: sent.ok ? 'SENT' : 'FAILED',
    reason: sent.ok ? null : sent.reason,
    qcr: await getQcr(id, deps),
  };
}
