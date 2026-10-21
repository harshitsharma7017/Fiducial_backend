import {
  AUDIT_ACTIONS,
  ERROR_CODES,
  PDF_CONTENT_TYPE,
  XLSX_CONTENT_TYPE,
  emptyGhiQuoteTerms,
  type GhiQcr,
  type GhiQcrDecisionRequest,
  type GhiQcrListResponse,
  type GhiSendOutcome,
  type RecordGhiClientDecisionRequest,
  type SaveGhiQcrRequest,
  type SendGhiQcrRequest,
} from '../../shared/index.ts';
import { Types, type mongo } from 'mongoose';
import { withTransaction } from '../../lib/db.ts';
import { Decimal } from '../../lib/decimal.ts';
import { conflict, notFound, validationError } from '../../lib/errors.ts';
import { istDay } from '../../lib/ist-day.ts';
import type { MailTransport } from '../mail/transport.ts';
import {
  advanceStage,
  assertOpen,
  auditCase,
  insurerNames,
  loadCase,
  loadSummary,
  nameOf,
  returnToStage,
  stageIndex,
  toCaseRecord,
  userNames,
  type Actor,
} from './ghi-common.ts';
import { GhiCaseModel, type GhiCaseDoc } from './ghi-case.model.ts';
import { qcrDocument } from './ghi-documents.ts';
import { assertCaseFiles, fileNames } from './ghi-files.service.ts';
import {
  assertMailOn,
  deliver,
  dispatchesOf,
  logDispatch,
  prepareAttachment,
  prepareMail,
} from './ghi-mail.ts';
import { compareTerms, lowestTotals } from './ghi-quote-calc.ts';
import { gmcFamilyCover } from './products/gmc.ts';
import { latestFinalIds } from './ghi-quotes.service.ts';
import { caseLetterhead } from './ghi-rfq.service.ts';
import { toPdf, toXlsx } from './ghi-sheet.ts';
import {
  GhiDispatchModel,
  GhiQcrModel,
  GhiQuoteModel,
  type GhiQcrDoc,
} from './ghi-workflow.model.ts';

// The GHI QCR (G6): up to five insurers' final quotes side by side against the RFQ, the lowest
// total marked, deviations and missing information flagged, the broker's recommendation, approval
// by an Approver, the mail to the client and the client's decision. Each version is kept.

const money = (value: Types.Decimal128 | null) => new Decimal(value?.toString() ?? '0').toFixed(2);

async function qcrView(
  caseDoc: GhiCaseDoc,
  qcr: GhiQcrDoc,
  latestId: string | null,
): Promise<GhiQcr> {
  const quotes = await GhiQuoteModel.find({
    _id: { $in: qcr.quoteIds },
    caseId: caseDoc._id,
  }).lean();
  const ordered = qcr.quoteIds.flatMap((quoteId) => {
    const quote = quotes.find((item) => item._id.equals(quoteId));
    return quote ? [quote] : [];
  });
  const [insurers, users, files, sends] = await Promise.all([
    insurerNames([
      ...ordered.map((quote) => quote.insurerId),
      ...(qcr.clientDecision?.insurerId ? [qcr.clientDecision.insurerId] : []),
    ]),
    userNames([qcr.createdBy, qcr.submitted?.by, qcr.decision?.by, qcr.clientDecision?.recordedBy]),
    fileNames(qcr.clientDecision?.fileIds ?? []),
    dispatchesOf(caseDoc._id, { kind: 'QCR', documentId: qcr._id }),
  ]);
  const lowest = lowestTotals(ordered.map((quote) => money(quote.totalPremium)));
  const { parentsCovered } = gmcFamilyCover(caseDoc);
  const compared = ordered.map((quote) =>
    compareTerms(caseDoc.requirements, quote.terms, parentsCovered),
  );
  const template = compareTerms(
    caseDoc.requirements,
    ordered[0]?.terms ?? emptyGhiQuoteTerms(),
    parentsCovered,
  );
  return {
    id: qcr._id.toHexString(),
    version: qcr.version,
    status: qcr.status,
    latest: latestId === qcr._id.toHexString(),
    columns: ordered.map((quote, index) => ({
      quoteId: quote._id.toHexString(),
      insurerId: quote.insurerId.toHexString(),
      insurerName: insurers.get(quote.insurerId.toHexString()) ?? 'Insurer',
      quoteVersion: quote.version,
      basePremium: money(quote.basePremium),
      gst: money(quote.gst),
      totalPremium: money(quote.totalPremium),
      lowest: lowest.has(index),
      recommended: qcr.recommendedInsurerId?.equals(quote.insurerId) ?? false,
      deviations: compared[index]!.filter((row) => row.kind === 'DEVIATION').length,
      missing: compared[index]!.filter((row) => row.kind === 'MISSING').length,
    })),
    rows: template.map((row, rowIndex) => ({
      key: row.key,
      label: row.label,
      requested: row.requested,
      values: compared.map((rows) => ({
        text: rows[rowIndex]!.offered,
        kind: rows[rowIndex]!.kind,
      })),
    })),
    recommendedInsurerId: qcr.recommendedInsurerId?.toHexString() ?? null,
    remarks: qcr.remarks,
    submitted: qcr.submitted
      ? { at: qcr.submitted.at.toISOString(), by: nameOf(users, qcr.submitted.by) }
      : null,
    decision: qcr.decision
      ? {
          status: qcr.decision.status,
          at: qcr.decision.at.toISOString(),
          by: nameOf(users, qcr.decision.by),
          comment: qcr.decision.comment,
        }
      : null,
    sends,
    clientDecision: qcr.clientDecision
      ? {
          decision: qcr.clientDecision.decision,
          insurerId: qcr.clientDecision.insurerId?.toHexString() ?? null,
          insurerName: qcr.clientDecision.insurerId
            ? (insurers.get(qcr.clientDecision.insurerId.toHexString()) ?? 'Insurer')
            : null,
          quoteId: qcr.clientDecision.quoteId?.toHexString() ?? null,
          decidedOn: qcr.clientDecision.decidedOn,
          confirmedBy: qcr.clientDecision.confirmedBy,
          note: qcr.clientDecision.note,
          files: qcr.clientDecision.fileIds.map((fileId) => ({
            id: fileId.toHexString(),
            fileName: files.get(fileId.toHexString()) ?? 'File',
          })),
          recordedAt: qcr.clientDecision.recordedAt.toISOString(),
          recordedBy: nameOf(users, qcr.clientDecision.recordedBy),
        }
      : null,
    createdAt: qcr.createdAt.toISOString(),
    createdBy: nameOf(users, qcr.createdBy),
  };
}

async function latestQcr(caseId: Types.ObjectId, session?: mongo.ClientSession) {
  return GhiQcrModel.findOne({ caseId })
    .sort({ version: -1 })
    .session(session ?? null)
    .lean();
}

export async function listQcrs(id: string, transport: MailTransport): Promise<GhiQcrListResponse> {
  const doc = await loadCase(id);
  const qcrs = await GhiQcrModel.find({ caseId: doc._id }).sort({ version: -1 }).lean();
  const latestId = qcrs[0]?._id.toHexString() ?? null;
  return {
    items: await Promise.all(qcrs.map((qcr) => qcrView(doc, qcr, latestId))),
    mailEnabled: transport.name !== 'off',
  };
}

async function getQcr(doc: GhiCaseDoc, qcrId: string): Promise<GhiQcr> {
  const qcr = await GhiQcrModel.findOne({ _id: new Types.ObjectId(qcrId), caseId: doc._id }).lean();
  if (!qcr) throw notFound('QCR not found');
  const latest = await latestQcr(doc._id);
  return qcrView(doc, qcr, latest?._id.toHexString() ?? null);
}

/** The quotes a QCR may compare: final quotes of this case, each its insurer's latest, one per insurer. */
async function checkQcrInput(doc: GhiCaseDoc, input: SaveGhiQcrRequest) {
  const ids = input.quoteIds.map((quoteId) => new Types.ObjectId(quoteId));
  const quotes = await GhiQuoteModel.find({ _id: { $in: ids }, caseId: doc._id }).lean();
  const all = await GhiQuoteModel.find(
    { caseId: doc._id, status: 'FINAL', kind: 'QUOTE' },
    { insurerId: 1, version: 1, status: 1, kind: 1 },
  ).lean();
  const latest = latestFinalIds(all);
  const issues: { location: 'body'; path: string; message: string }[] = [];
  const insurers = new Set<string>();
  input.quoteIds.forEach((quoteId, index) => {
    const quote = quotes.find((item) => item._id.toHexString() === quoteId);
    const path = `quoteIds.${index}`;
    if (!quote) issues.push({ location: 'body', path, message: 'Choose a quote of this case' });
    else if (quote.status !== 'FINAL' || quote.kind !== 'QUOTE') {
      issues.push({
        location: 'body',
        path,
        message: 'Only recorded (final) quotes go on the QCR',
      });
    } else if (!latest.has(quoteId)) {
      issues.push({ location: 'body', path, message: 'Use the insurer’s latest quote' });
    } else if (insurers.has(quote.insurerId.toHexString())) {
      issues.push({ location: 'body', path, message: 'One quote per insurer' });
    } else insurers.add(quote.insurerId.toHexString());
  });
  if (input.recommendedInsurerId && !insurers.has(input.recommendedInsurerId)) {
    issues.push({
      location: 'body',
      path: 'recommendedInsurerId',
      message: 'Recommend one of the insurers compared',
    });
  }
  if (issues.length > 0) throw validationError(issues);
}

function assertBeforeFinal(doc: GhiCaseDoc): void {
  assertOpen(doc);
  if (doc.finalQcr)
    throw conflict(
      ERROR_CODES.CONFLICT,
      'The final QCR is recorded; the QCR can no longer change.',
    );
}

/** Prepares a new QCR version (a draft). A rejected QCR or a client's rejection leads here. */
export async function createQcr(
  id: string,
  input: SaveGhiQcrRequest,
  actor: Actor,
): Promise<GhiQcr> {
  const doc = await loadCase(id);
  assertBeforeFinal(doc);
  if (stageIndex(doc.stage) < stageIndex('QCR')) {
    throw conflict(ERROR_CODES.CONFLICT, 'Record at least one insurer’s final quote first.');
  }
  await checkQcrInput(doc, input);
  const actorId = new Types.ObjectId(actor.id);
  const saved = await withTransaction(async (session) => {
    const latest = await latestQcr(doc._id, session);
    if (latest && (latest.status === 'DRAFT' || latest.status === 'SUBMITTED')) {
      throw conflict(
        ERROR_CODES.CONFLICT,
        `QCR v${latest.version} is ${latest.status === 'DRAFT' ? 'still a draft: edit it' : 'awaiting approval'}.`,
      );
    }
    if (latest?.clientDecision?.decision === 'ACCEPTED') {
      throw conflict(
        ERROR_CODES.CONFLICT,
        'The client accepted the QCR. Record the final terms instead.',
      );
    }
    const version = (latest?.version ?? 0) + 1;
    const [qcr] = await GhiQcrModel.create(
      [
        {
          caseId: doc._id,
          version,
          status: 'DRAFT',
          quoteIds: input.quoteIds.map((quoteId) => new Types.ObjectId(quoteId)),
          recommendedInsurerId: input.recommendedInsurerId
            ? new Types.ObjectId(input.recommendedInsurerId)
            : null,
          remarks: input.remarks,
          submitted: null,
          decision: null,
          clientDecision: null,
          createdBy: actorId,
          updatedBy: actorId,
        },
      ],
      { session },
    );
    if (!qcr) throw new Error('QCR was not saved');
    await returnToStage(doc._id, 'QCR', ['APPROVAL'], actorId, session);
    await GhiCaseModel.updateOne(
      { _id: doc._id },
      {
        $push: {
          activity: {
            at: new Date(),
            actorId,
            message: `QCR v${version} prepared (${input.quoteIds.length} insurers)`,
          },
        },
      },
      { session },
    );
    await auditCase(actor, AUDIT_ACTIONS.GHI_QCR_SAVED, id, null, { version, ...input }, session);
    return qcr.toObject();
  });
  return qcrView(doc, saved, saved._id.toHexString());
}

async function loadLatest(doc: GhiCaseDoc, qcrId: string): Promise<GhiQcrDoc> {
  const qcr = await GhiQcrModel.findOne({ _id: new Types.ObjectId(qcrId), caseId: doc._id }).lean();
  if (!qcr) throw notFound('QCR not found');
  const latest = await latestQcr(doc._id);
  if (!latest?._id.equals(qcr._id)) {
    throw conflict(
      ERROR_CODES.CONFLICT,
      `QCR v${qcr.version} has been replaced by v${latest?.version}; it is kept as history.`,
    );
  }
  return qcr;
}

/** Edits a draft or rejected QCR; a rejected one becomes a draft again. */
export async function updateQcr(
  id: string,
  qcrId: string,
  input: SaveGhiQcrRequest,
  actor: Actor,
): Promise<GhiQcr> {
  const doc = await loadCase(id);
  assertBeforeFinal(doc);
  const qcr = await loadLatest(doc, qcrId);
  if (qcr.status !== 'DRAFT' && qcr.status !== 'REJECTED') {
    throw conflict(
      ERROR_CODES.CONFLICT,
      `QCR v${qcr.version} is ${qcr.status === 'APPROVED' ? 'approved: prepare a new version to change it' : 'awaiting approval'}.`,
    );
  }
  await checkQcrInput(doc, input);
  const actorId = new Types.ObjectId(actor.id);
  await withTransaction(async (session) => {
    const result = await GhiQcrModel.updateOne(
      { _id: qcr._id, status: qcr.status },
      {
        $set: {
          status: 'DRAFT',
          decision: null,
          quoteIds: input.quoteIds.map((quoteId) => new Types.ObjectId(quoteId)),
          recommendedInsurerId: input.recommendedInsurerId
            ? new Types.ObjectId(input.recommendedInsurerId)
            : null,
          remarks: input.remarks,
          updatedBy: actorId,
        },
      },
      { session },
    );
    if (result.modifiedCount === 0)
      throw conflict(ERROR_CODES.CONFLICT, 'The QCR changed meanwhile. Reload it.');
    await auditCase(
      actor,
      AUDIT_ACTIONS.GHI_QCR_SAVED,
      id,
      {
        version: qcr.version,
        quoteIds: qcr.quoteIds.map(String),
        recommendedInsurerId: qcr.recommendedInsurerId?.toHexString() ?? null,
        remarks: qcr.remarks,
      },
      { version: qcr.version, ...input },
      session,
    );
  });
  return getQcr(doc, qcrId);
}

export async function submitQcr(id: string, qcrId: string, actor: Actor): Promise<GhiQcr> {
  const doc = await loadCase(id);
  assertBeforeFinal(doc);
  const qcr = await loadLatest(doc, qcrId);
  if (qcr.status !== 'DRAFT')
    throw conflict(ERROR_CODES.CONFLICT, `QCR v${qcr.version} is not a draft.`);
  const actorId = new Types.ObjectId(actor.id);
  await withTransaction(async (session) => {
    const result = await GhiQcrModel.updateOne(
      { _id: qcr._id, status: 'DRAFT' },
      {
        $set: {
          status: 'SUBMITTED',
          submitted: { at: new Date(), by: actorId },
          updatedBy: actorId,
        },
      },
      { session },
    );
    if (result.modifiedCount === 0)
      throw conflict(ERROR_CODES.CONFLICT, 'The QCR changed meanwhile. Reload it.');
    await GhiCaseModel.updateOne(
      { _id: doc._id },
      {
        $push: {
          activity: {
            at: new Date(),
            actorId,
            message: `QCR v${qcr.version} submitted for approval`,
          },
        },
      },
      { session },
    );
    await advanceStage(doc._id, 'APPROVAL', actorId, session);
    await auditCase(
      actor,
      AUDIT_ACTIONS.GHI_QCR_SUBMITTED,
      id,
      { version: qcr.version, status: 'DRAFT' },
      { version: qcr.version, status: 'SUBMITTED' },
      session,
    );
  });
  return getQcr(doc, qcrId);
}

/** An Approver approves or rejects the QCR (G6); a rejection sends the case back to QCR. */
export async function decideQcr(
  id: string,
  qcrId: string,
  input: GhiQcrDecisionRequest,
  actor: Actor,
): Promise<GhiQcr> {
  const doc = await loadCase(id);
  assertBeforeFinal(doc);
  const qcr = await loadLatest(doc, qcrId);
  if (qcr.status !== 'SUBMITTED')
    throw conflict(ERROR_CODES.CONFLICT, `QCR v${qcr.version} is not awaiting approval.`);
  const actorId = new Types.ObjectId(actor.id);
  await withTransaction(async (session) => {
    const result = await GhiQcrModel.updateOne(
      { _id: qcr._id, status: 'SUBMITTED' },
      {
        $set: {
          status: input.decision,
          decision: { status: input.decision, at: new Date(), by: actorId, comment: input.comment },
          updatedBy: actorId,
        },
      },
      { session },
    );
    if (result.modifiedCount === 0)
      throw conflict(ERROR_CODES.CONFLICT, 'The QCR changed meanwhile. Reload it.');
    await GhiCaseModel.updateOne(
      { _id: doc._id },
      {
        $push: {
          activity: {
            at: new Date(),
            actorId,
            message: `QCR v${qcr.version} ${input.decision === 'APPROVED' ? 'approved' : `rejected: ${input.comment ?? ''}`}`,
          },
        },
      },
      { session },
    );
    if (input.decision === 'REJECTED')
      await returnToStage(doc._id, 'QCR', ['APPROVAL'], actorId, session);
    await auditCase(
      actor,
      input.decision === 'APPROVED'
        ? AUDIT_ACTIONS.GHI_QCR_APPROVED
        : AUDIT_ACTIONS.GHI_QCR_REJECTED,
      id,
      { version: qcr.version, status: 'SUBMITTED' },
      { version: qcr.version, status: input.decision, comment: input.comment },
      session,
    );
  });
  return getQcr(doc, qcrId);
}

async function qcrFileOf(doc: GhiCaseDoc, qcr: GhiQcr, format: 'xlsx' | 'pdf') {
  const model = qcrDocument(await toCaseRecord(doc), qcr, await loadSummary(doc));
  return format === 'pdf'
    ? {
        fileName: `${model.fileBase}.pdf`,
        contentType: PDF_CONTENT_TYPE,
        data: await toPdf(model, await caseLetterhead()),
      }
    : {
        fileName: `${model.fileBase}.xlsx`,
        contentType: XLSX_CONTENT_TYPE,
        data: await toXlsx(model),
      };
}

export async function qcrFile(id: string, qcrId: string, format: 'xlsx' | 'pdf', actor: Actor) {
  const doc = await loadCase(id);
  const qcr = await getQcr(doc, qcrId);
  const file = await qcrFileOf(doc, qcr, format);
  await auditCase(actor, AUDIT_ACTIONS.GHI_QCR_DOWNLOADED, id, null, {
    version: qcr.version,
    status: qcr.status,
    format,
  });
  return file;
}

/**
 * Mails the approved QCR to the client, To the client's contacts from the client master only.
 * Reported as sent only when the transport accepted it; a repeated sendId mails nobody twice.
 */
export async function sendQcr(
  id: string,
  qcrId: string,
  input: SendGhiQcrRequest,
  actor: Actor,
  transport: MailTransport,
): Promise<{ result: GhiSendOutcome; qcr: GhiQcr }> {
  assertMailOn(transport, 'QCR');
  const doc = await loadCase(id);
  assertOpen(doc);
  const qcrDoc = await loadLatest(doc, qcrId);
  if (qcrDoc.status !== 'APPROVED') {
    throw conflict(
      ERROR_CODES.QCR_NOT_APPROVED,
      `QCR v${qcrDoc.version} must be approved before it goes to the client.`,
    );
  }
  const record = await toCaseRecord(doc);
  const allowed = new Set(record.client.contacts.map((contact) => contact.email.toLowerCase()));
  const outside = input.to.filter((email) => !allowed.has(email.toLowerCase()));
  if (outside.length > 0) {
    throw validationError([
      {
        location: 'body',
        path: 'to',
        message: `Send only to the client’s contacts in the client master (not ${outside.join(', ')})`,
      },
    ]);
  }
  const recipient = record.client.name;
  const earlier = await GhiDispatchModel.findOne({
    sendId: input.sendId,
    kind: 'QCR',
    recipient,
  }).lean();
  if (earlier) {
    return {
      result: {
        insurerId: null,
        recipient,
        outcome: earlier.result === 'FAILED' ? 'FAILED' : 'SENT',
        result: earlier.result,
        reason: earlier.error,
      },
      qcr: await getQcr(doc, qcrId),
    };
  }
  const qcr = await getQcr(doc, qcrId);
  const file = await qcrFileOf(doc, qcr, input.format);
  const attachment = await prepareAttachment(file);
  const recommended = qcr.columns.find((column) => column.recommended)?.insurerName ?? '';
  const mail = await prepareMail(
    'QCR',
    doc,
    record.client.name,
    recommended,
    doc.dueDate,
    actor.id,
  );
  const to = input.to.map((email) => email.toLowerCase());
  const delivery = await deliver(transport, mail, to, file);
  const actorId = new Types.ObjectId(actor.id);
  await withTransaction(async (session) => {
    await logDispatch(
      {
        caseId: doc._id,
        kind: 'QCR',
        documentId: qcrDoc._id,
        insurerId: null,
        recipient,
        sendId: input.sendId,
        to,
        mail,
        attachment: { id: attachment.id, fileName: attachment.fileName },
        dueDate: null,
        actorId,
        transport,
        delivery,
      },
      session,
    );
    await GhiCaseModel.updateOne(
      { _id: doc._id },
      {
        $push: {
          activity: {
            at: new Date(),
            actorId,
            message: delivery.ok
              ? `QCR v${qcrDoc.version} emailed to the client (${to.join(', ')})${delivery.result === 'OUTBOX' ? ' (kept in the outbox, not delivered)' : ''}`
              : `QCR email to the client failed: ${delivery.error}`,
          },
        },
      },
      { session },
    );
    await auditCase(
      actor,
      delivery.ok ? AUDIT_ACTIONS.GHI_QCR_EMAILED : AUDIT_ACTIONS.GHI_QCR_EMAIL_FAILED,
      id,
      null,
      {
        version: qcrDoc.version,
        to: to.join(', '),
        result: delivery.result,
        ...(delivery.ok ? {} : { error: delivery.error }),
      },
      session,
    );
  });
  return {
    result: {
      insurerId: null,
      recipient,
      outcome: delivery.ok ? 'SENT' : 'FAILED',
      result: delivery.result,
      reason: delivery.error,
    },
    qcr: await getQcr(doc, qcrId),
  };
}

/**
 * Records the client's answer to the approved QCR: accepted with the insurer chosen (the case
 * moves to Final QCR), or rejected with the reason (back to QCR for a new version).
 */
export async function recordClientDecision(
  id: string,
  qcrId: string,
  input: RecordGhiClientDecisionRequest,
  actor: Actor,
): Promise<GhiQcr> {
  const doc = await loadCase(id);
  assertBeforeFinal(doc);
  const qcr = await loadLatest(doc, qcrId);
  if (qcr.status !== 'APPROVED') {
    throw conflict(
      ERROR_CODES.QCR_NOT_APPROVED,
      `QCR v${qcr.version} must be approved before the client’s decision is recorded.`,
    );
  }
  const issues: { location: 'body'; path: string; message: string }[] = [];
  if (input.decidedOn > istDay(new Date())) {
    issues.push({
      location: 'body',
      path: 'decidedOn',
      message: 'The date cannot be in the future',
    });
  }
  let quoteId: Types.ObjectId | null = null;
  if (input.decision === 'ACCEPTED' && input.insurerId) {
    const quotes = await GhiQuoteModel.find(
      { _id: { $in: qcr.quoteIds }, caseId: doc._id },
      { insurerId: 1 },
    ).lean();
    const chosen = quotes.find((quote) => quote.insurerId.toHexString() === input.insurerId);
    if (!chosen)
      issues.push({
        location: 'body',
        path: 'insurerId',
        message: 'Choose one of the insurers on the QCR',
      });
    else quoteId = chosen._id;
  }
  if (issues.length > 0) throw validationError(issues);
  const fileIds = await assertCaseFiles(doc._id, input.fileIds, 'CLIENT_DECISION', 'fileIds');
  const actorId = new Types.ObjectId(actor.id);
  const insurerName = input.insurerId
    ? (await insurerNames([new Types.ObjectId(input.insurerId)])).get(input.insurerId)
    : null;
  await withTransaction(async (session) => {
    const result = await GhiQcrModel.updateOne(
      { _id: qcr._id, status: 'APPROVED' },
      {
        $set: {
          clientDecision: {
            decision: input.decision,
            insurerId:
              input.decision === 'ACCEPTED' && input.insurerId
                ? new Types.ObjectId(input.insurerId)
                : null,
            quoteId,
            decidedOn: input.decidedOn,
            confirmedBy: input.confirmedBy,
            note: input.note,
            fileIds,
            recordedAt: new Date(),
            recordedBy: actorId,
          },
          updatedBy: actorId,
        },
      },
      { session },
    );
    if (result.matchedCount === 0)
      throw conflict(ERROR_CODES.CONFLICT, 'The QCR changed meanwhile. Reload it.');
    await GhiCaseModel.updateOne(
      { _id: doc._id },
      {
        $push: {
          activity: {
            at: new Date(),
            actorId,
            message:
              input.decision === 'ACCEPTED'
                ? `Client accepted QCR v${qcr.version}: ${insurerName ?? 'insurer'} (confirmed by ${input.confirmedBy})`
                : `Client rejected QCR v${qcr.version}: ${input.note ?? ''}`,
          },
        },
      },
      { session },
    );
    if (input.decision === 'ACCEPTED') await advanceStage(doc._id, 'FINAL_QCR', actorId, session);
    else await returnToStage(doc._id, 'QCR', ['APPROVAL', 'FINAL_QCR'], actorId, session);
    await auditCase(
      actor,
      AUDIT_ACTIONS.GHI_CLIENT_DECISION_RECORDED,
      id,
      qcr.clientDecision
        ? {
            decision: qcr.clientDecision.decision,
            insurerId: qcr.clientDecision.insurerId?.toHexString() ?? null,
          }
        : null,
      {
        version: qcr.version,
        decision: input.decision,
        insurer: insurerName ?? null,
        decidedOn: input.decidedOn,
        confirmedBy: input.confirmedBy,
        note: input.note,
      },
      session,
    );
  });
  return getQcr(doc, qcrId);
}

/** The latest QCR the client accepted, with its quote; null until then. */
export async function acceptedQcr(caseId: Types.ObjectId) {
  const qcr = await latestQcr(caseId);
  if (
    !qcr ||
    qcr.status !== 'APPROVED' ||
    qcr.clientDecision?.decision !== 'ACCEPTED' ||
    !qcr.clientDecision.quoteId
  ) {
    return null;
  }
  const quote = await GhiQuoteModel.findOne({ _id: qcr.clientDecision.quoteId, caseId }).lean();
  return quote ? { qcr, quote } : null;
}
