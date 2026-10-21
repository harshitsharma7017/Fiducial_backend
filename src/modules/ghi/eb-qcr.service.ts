import {
  AUDIT_ACTIONS,
  ERROR_CODES,
  PDF_CONTENT_TYPE,
  XLSX_CONTENT_TYPE,
  compareGpaTerms,
  compareGtliTerms,
  lowestMarks,
  qcrCandidates,
  qcrContentKey,
  type EbComparedRow,
  type EbQcr,
  type EbQcrDecisionRequest,
  type EbQcrListResponse,
  type GhiSendOutcome,
  type GpaQuoteTerms,
  type GtliQuoteTerms,
  type SaveEbQcrRequest,
} from '../../shared/index.ts';
import { createHash } from 'node:crypto';
import { Types, type mongo } from 'mongoose';
import { withTransaction } from '../../lib/db.ts';
import { Decimal } from '../../lib/decimal.ts';
import { conflict, notFound, validationError } from '../../lib/errors.ts';
import type { MailTransport } from '../mail/transport.ts';
import { toEbCaseRecord } from './eb-cases.service.ts';
import { gpaRequirementsOf, gtliRequirementsOf } from './eb-census-context.ts';
import { ebQcrDocument } from './eb-documents.ts';
import { summaryOf } from './eb-members.service.ts';
import { ebDeviations, ebQuoteViews } from './eb-quotes.service.ts';
import { GhiCaseModel, type GhiCaseDoc } from './ghi-case.model.ts';
import {
  advanceStage,
  assertWritable,
  auditCase,
  insurerNames,
  loadCase,
  nameOf,
  returnToStage,
  stageIndex,
  userNames,
  type Actor,
} from './ghi-common.ts';
import { fileNames } from './ghi-files.service.ts';
import {
  assertMailOn,
  deliver,
  dispatchesOf,
  logDispatch,
  prepareAttachment,
  prepareMail,
} from './ghi-mail.ts';
import { caseLetterhead } from './ghi-rfq.service.ts';
import { toPdf, toXlsx } from './ghi-sheet.ts';
import {
  GhiDispatchModel,
  GhiQcrModel,
  GhiQuoteModel,
  type GhiQcrDoc,
  type GhiQuoteDoc,
} from './ghi-workflow.model.ts';
import type { CaseScope } from './products/profile.ts';

// The GPA and GTLI QCR (Requirement 8): each insurer's latest recorded quote that has not
// declined, side by side, with its GST, total and deviations, every lowest total marked, an
// optional recommendation and remarks. The approver approves the exact content shown (the
// fingerprint); a later change to that content voids the submission or approval (8.4).

const money = (value: Types.Decimal128 | null) => new Decimal(value?.toString() ?? '0').toFixed(2);

/** What a new QCR would compare now: the latest recorded quote of each insurer not declined. */
export async function currentCandidates(doc: GhiCaseDoc): Promise<GhiQuoteDoc[]> {
  const quotes = await GhiQuoteModel.find({ caseId: doc._id, kind: 'QUOTE' }).lean();
  const declined = new Set(
    doc.insurers
      .filter((item) => item.status === 'DECLINED')
      .map((item) => item.insurerId.toHexString()),
  );
  const order = doc.insurers.map((item) => item.insurerId.toHexString());
  const chosen = qcrCandidates(
    quotes.map((quote) => ({
      id: quote._id.toHexString(),
      insurerId: quote.insurerId.toHexString(),
      version: quote.version,
      status: quote.status,
      totalPremium: quote.totalPremium?.toString() ?? null,
    })),
    declined,
  );
  return chosen
    .map((item) => quotes.find((quote) => quote._id.toHexString() === item.id)!)
    .sort(
      (a, b) => order.indexOf(a.insurerId.toHexString()) - order.indexOf(b.insurerId.toHexString()),
    );
}

function compareRows(doc: GhiCaseDoc, terms: unknown): EbComparedRow[] {
  return doc.product === 'GTLI'
    ? compareGtliTerms(gtliRequirementsOf(doc), terms as GtliQuoteTerms)
    : compareGpaTerms(gpaRequirementsOf(doc), terms as GpaQuoteTerms);
}

interface Content {
  columns: EbQcr['columns'];
  rows: EbQcr['rows'];
  fingerprint: string;
}

/** The content of a QCR over the given quotes (8.1, 8.3), with its fingerprint. */
async function contentOf(
  doc: GhiCaseDoc,
  quotes: readonly GhiQuoteDoc[],
  recommendedInsurerId: string | null,
  remarks: string | null,
): Promise<Content> {
  const insurers = await insurerNames(quotes.map((quote) => quote.insurerId));
  const totals = quotes.map((quote) => money(quote.totalPremium));
  const lowest = lowestMarks(totals);
  const columns = quotes.map((quote, index) => ({
    quoteId: quote._id.toHexString(),
    insurerId: quote.insurerId.toHexString(),
    insurerName: insurers.get(quote.insurerId.toHexString()) ?? 'Insurer',
    quoteVersion: quote.version,
    basePremium: money(quote.basePremium),
    gst: money(quote.gst),
    totalPremium: totals[index]!,
    lowest: lowest.has(index),
    recommended: recommendedInsurerId === quote.insurerId.toHexString(),
    deviations: ebDeviations(doc, quote.terms as never),
  }));
  const compared = quotes.map((quote) => compareRows(doc, quote.terms));
  const template = compared[0] ?? [];
  const rows = template.map((row, rowIndex) => ({
    key: row.key,
    label: row.label,
    requested: row.requested,
    values: compared.map((items) => ({
      text: items[rowIndex]!.offered,
      kind: items[rowIndex]!.kind,
    })),
  }));
  const fingerprint = createHash('sha256')
    .update(qcrContentKey({ columns, recommendedInsurerId, remarks }))
    .digest('hex');
  return { columns, rows, fingerprint };
}

async function storedQuotes(doc: GhiCaseDoc, qcr: GhiQcrDoc): Promise<GhiQuoteDoc[]> {
  const quotes = await GhiQuoteModel.find({ _id: { $in: qcr.quoteIds }, caseId: doc._id }).lean();
  return qcr.quoteIds.flatMap((quoteId) => {
    const quote = quotes.find((item) => item._id.equals(quoteId));
    return quote ? [quote] : [];
  });
}

/** A submitted or approved QCR whose quotes are no longer each insurer's latest is void (8.4). */
async function isOutOfDate(doc: GhiCaseDoc, qcr: GhiQcrDoc): Promise<boolean> {
  if (qcr.status !== 'SUBMITTED' && qcr.status !== 'APPROVED') return false;
  const current = (await currentCandidates(doc)).map((quote) => quote._id.toHexString()).sort();
  const stored = qcr.quoteIds.map((id) => id.toHexString()).sort();
  return current.length !== stored.length || current.some((id, index) => id !== stored[index]);
}

async function qcrView(doc: GhiCaseDoc, qcr: GhiQcrDoc, latestId: string | null): Promise<EbQcr> {
  const quotes = await storedQuotes(doc, qcr);
  const recommended = qcr.recommendedInsurerId?.toHexString() ?? null;
  const content = await contentOf(doc, quotes, recommended, qcr.remarks);
  const decision = qcr.clientDecision;
  const [users, files, sends, insurers, outOfDate] = await Promise.all([
    userNames([qcr.createdBy, qcr.submitted?.by, qcr.decision?.by, decision?.recordedBy]),
    fileNames(decision?.fileIds ?? []),
    dispatchesOf(doc._id, { kind: 'QCR', documentId: qcr._id }),
    insurerNames(decision?.insurerId ? [decision.insurerId] : []),
    isOutOfDate(doc, qcr),
  ]);
  return {
    id: qcr._id.toHexString(),
    version: qcr.version,
    status: qcr.status,
    latest: latestId === qcr._id.toHexString(),
    outOfDate,
    fingerprint: content.fingerprint,
    columns: content.columns,
    rows: content.rows,
    recommendedInsurerId: recommended,
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
    clientDecision: decision
      ? {
          decision: decision.decision,
          insurerId: decision.insurerId?.toHexString() ?? null,
          insurerName: decision.insurerId
            ? (insurers.get(decision.insurerId.toHexString()) ?? 'Insurer')
            : null,
          quoteId: decision.quoteId?.toHexString() ?? null,
          quoteVersion: decision.quoteVersion ?? null,
          agreedPremium: decision.agreedPremium ? money(decision.agreedPremium) : null,
          decidedOn: decision.decidedOn,
          confirmedBy: decision.confirmedBy,
          note: decision.note,
          files: decision.fileIds.map((fileId) => ({
            id: fileId.toHexString(),
            fileName: files.get(fileId.toHexString()) ?? 'File',
          })),
          recordedAt: decision.recordedAt.toISOString(),
          recordedBy: nameOf(users, decision.recordedBy),
        }
      : null,
    createdAt: qcr.createdAt.toISOString(),
    createdBy: nameOf(users, qcr.createdBy),
  };
}

export async function latestEbQcr(caseId: Types.ObjectId, session?: mongo.ClientSession) {
  return GhiQcrModel.findOne({ caseId })
    .sort({ version: -1 })
    .session(session ?? null)
    .lean();
}

export async function listEbQcrs(
  scope: CaseScope,
  id: string,
  transport: MailTransport,
): Promise<EbQcrListResponse> {
  const doc = await loadCase(id, undefined, scope);
  const qcrs = await GhiQcrModel.find({ caseId: doc._id }).sort({ version: -1 }).lean();
  const latestId = qcrs[0]?._id.toHexString() ?? null;
  return {
    items: await Promise.all(qcrs.map((qcr) => qcrView(doc, qcr, latestId))),
    mailEnabled: transport.name !== 'off',
    candidates: await ebQuoteViews(doc, await currentCandidates(doc)),
  };
}

export async function getEbQcr(doc: GhiCaseDoc, qcrId: string): Promise<EbQcr> {
  const qcr = await GhiQcrModel.findOne({ _id: new Types.ObjectId(qcrId), caseId: doc._id }).lean();
  if (!qcr) throw notFound('QCR not found');
  const latest = await latestEbQcr(doc._id);
  return qcrView(doc, qcr, latest?._id.toHexString() ?? null);
}

/** The QCR of a case: latest only; an earlier version is kept as history. */
export async function loadLatestEbQcr(
  doc: GhiCaseDoc,
  qcrId: string,
  session?: mongo.ClientSession,
) {
  const qcr = await GhiQcrModel.findOne({ _id: new Types.ObjectId(qcrId), caseId: doc._id })
    .session(session ?? null)
    .lean();
  if (!qcr) throw notFound('QCR not found');
  const latest = await latestEbQcr(doc._id, session);
  if (!latest?._id.equals(qcr._id)) {
    throw conflict(
      ERROR_CODES.CONFLICT,
      `QCR v${qcr.version} has been replaced by v${latest?.version}; it is kept as history.`,
    );
  }
  return qcr;
}

function assertBeforeDecision(doc: GhiCaseDoc): void {
  assertWritable(doc);
  if (stageIndex(doc.stage) >= stageIndex('PAYMENT')) {
    throw conflict(
      ERROR_CODES.EB_STAGE,
      'The client has accepted and the agreed premium is set; the QCR no longer changes.',
    );
  }
}

function checkRecommendation(candidates: readonly GhiQuoteDoc[], input: SaveEbQcrRequest): void {
  if (
    input.recommendedInsurerId &&
    !candidates.some((quote) => quote.insurerId.toHexString() === input.recommendedInsurerId)
  ) {
    throw validationError([
      {
        location: 'body',
        path: 'recommendedInsurerId',
        message: 'Recommend one of the insurers compared',
      },
    ]);
  }
}

/** Prepares a new QCR version (a draft) over the current candidates (8.1, 8.2). */
export async function createEbQcr(
  scope: CaseScope,
  id: string,
  input: SaveEbQcrRequest,
  actor: Actor,
): Promise<EbQcr> {
  const doc = await loadCase(id, undefined, scope);
  assertBeforeDecision(doc);
  if (stageIndex(doc.stage) < stageIndex('QCR')) {
    throw conflict(ERROR_CODES.EB_STAGE, 'Record at least one insurer’s quote first.');
  }
  const candidates = await currentCandidates(doc);
  if (candidates.length === 0) {
    throw conflict(
      ERROR_CODES.QCR_INCOMPLETE,
      'No insurer has a recorded quote that has not declined.',
    );
  }
  checkRecommendation(candidates, input);
  const actorId = new Types.ObjectId(actor.id);
  const saved = await withTransaction(async (session) => {
    const latest = await latestEbQcr(doc._id, session);
    if (latest && (latest.status === 'DRAFT' || latest.status === 'SUBMITTED')) {
      const stale = latest.status === 'SUBMITTED' && (await isOutOfDate(doc, latest));
      if (!stale) {
        throw conflict(
          ERROR_CODES.CONFLICT,
          `QCR v${latest.version} is ${latest.status === 'DRAFT' ? 'still a draft: edit it' : 'awaiting approval'}.`,
        );
      }
    }
    if (
      latest?.status === 'APPROVED' &&
      !(await isOutOfDate(doc, latest)) &&
      !latest.clientDecision
    ) {
      throw conflict(
        ERROR_CODES.CONFLICT,
        `QCR v${latest.version} is approved and current: record the client’s decision on it.`,
      );
    }
    const version = (latest?.version ?? 0) + 1;
    const content = await contentOf(doc, candidates, input.recommendedInsurerId, input.remarks);
    const [qcr] = await GhiQcrModel.create(
      [
        {
          caseId: doc._id,
          version,
          status: 'DRAFT',
          quoteIds: candidates.map((quote) => quote._id),
          recommendedInsurerId: input.recommendedInsurerId
            ? new Types.ObjectId(input.recommendedInsurerId)
            : null,
          remarks: input.remarks,
          fingerprint: content.fingerprint,
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
    await GhiCaseModel.updateOne(
      { _id: doc._id },
      {
        $push: {
          activity: {
            at: new Date(),
            actorId,
            message: `QCR v${version} prepared (${candidates.length} insurers)`,
          },
        },
      },
      { session },
    );
    await auditCase(
      actor,
      AUDIT_ACTIONS.GHI_QCR_SAVED,
      id,
      null,
      {
        version,
        quotes: content.columns.map((column) => `${column.insurerName} v${column.quoteVersion}`),
        ...input,
      },
      session,
      scope,
    );
    return qcr.toObject();
  });
  return qcrView(doc, saved, saved._id.toHexString());
}

/** Edits a draft or rejected QCR over the current candidates; a rejected one becomes a draft. */
export async function updateEbQcr(
  scope: CaseScope,
  id: string,
  qcrId: string,
  input: SaveEbQcrRequest,
  actor: Actor,
): Promise<EbQcr> {
  const doc = await loadCase(id, undefined, scope);
  assertBeforeDecision(doc);
  const qcr = await loadLatestEbQcr(doc, qcrId);
  if (qcr.status !== 'DRAFT' && qcr.status !== 'REJECTED') {
    throw conflict(
      ERROR_CODES.CONFLICT,
      `QCR v${qcr.version} is ${qcr.status === 'APPROVED' ? 'approved: prepare a new version to change it' : 'awaiting approval'}.`,
    );
  }
  const candidates = await currentCandidates(doc);
  if (candidates.length === 0) {
    throw conflict(
      ERROR_CODES.QCR_INCOMPLETE,
      'No insurer has a recorded quote that has not declined.',
    );
  }
  checkRecommendation(candidates, input);
  const content = await contentOf(doc, candidates, input.recommendedInsurerId, input.remarks);
  const actorId = new Types.ObjectId(actor.id);
  await withTransaction(async (session) => {
    const result = await GhiQcrModel.updateOne(
      { _id: qcr._id, status: qcr.status },
      {
        $set: {
          status: 'DRAFT',
          decision: null,
          quoteIds: candidates.map((quote) => quote._id),
          recommendedInsurerId: input.recommendedInsurerId
            ? new Types.ObjectId(input.recommendedInsurerId)
            : null,
          remarks: input.remarks,
          fingerprint: content.fingerprint,
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
        recommendedInsurerId: qcr.recommendedInsurerId?.toHexString() ?? null,
        remarks: qcr.remarks,
      },
      { version: qcr.version, ...input },
      session,
      scope,
    );
  });
  return getEbQcr(doc, qcrId);
}

/** Submits a draft for approval over the current candidates; the case moves to Approval (8.2). */
export async function submitEbQcr(
  scope: CaseScope,
  id: string,
  qcrId: string,
  actor: Actor,
): Promise<EbQcr> {
  const doc = await loadCase(id, undefined, scope);
  assertBeforeDecision(doc);
  const qcr = await loadLatestEbQcr(doc, qcrId);
  if (qcr.status !== 'DRAFT')
    throw conflict(ERROR_CODES.CONFLICT, `QCR v${qcr.version} is not a draft.`);
  const candidates = await currentCandidates(doc);
  if (candidates.length === 0) {
    throw conflict(
      ERROR_CODES.QCR_INCOMPLETE,
      'No insurer has a recorded quote that has not declined.',
    );
  }
  const recommended = qcr.recommendedInsurerId?.toHexString() ?? null;
  const keepRecommendation = candidates.some(
    (quote) => quote.insurerId.toHexString() === recommended,
  );
  const content = await contentOf(
    doc,
    candidates,
    keepRecommendation ? recommended : null,
    qcr.remarks,
  );
  const actorId = new Types.ObjectId(actor.id);
  await withTransaction(async (session) => {
    const result = await GhiQcrModel.updateOne(
      { _id: qcr._id, status: 'DRAFT' },
      {
        $set: {
          status: 'SUBMITTED',
          quoteIds: candidates.map((quote) => quote._id),
          recommendedInsurerId: keepRecommendation ? qcr.recommendedInsurerId : null,
          fingerprint: content.fingerprint,
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
      { version: qcr.version, status: 'SUBMITTED', fingerprint: content.fingerprint },
      session,
      scope,
    );
  });
  return getEbQcr(doc, qcrId);
}

const reload = () =>
  conflict(
    ERROR_CODES.QCR_CHANGED,
    'The QCR changed since you opened it. Reload it and check it again.',
  );

/**
 * An approver approves or rejects the content shown (8.3, 8.5): the fingerprint must be the
 * QCR's as stored and still current. A rejection sends the case back to QCR (3.4).
 */
export async function decideEbQcr(
  scope: CaseScope,
  id: string,
  qcrId: string,
  input: EbQcrDecisionRequest,
  actor: Actor,
): Promise<EbQcr> {
  const doc = await loadCase(id, undefined, scope);
  assertBeforeDecision(doc);
  const qcr = await loadLatestEbQcr(doc, qcrId);
  if (qcr.status !== 'SUBMITTED') {
    throw conflict(ERROR_CODES.CONFLICT, `QCR v${qcr.version} is not awaiting approval.`);
  }
  if ((await isOutOfDate(doc, qcr)) || qcr.fingerprint !== input.fingerprint) throw reload();
  const view = await getEbQcr(doc, qcrId);
  if (view.fingerprint !== input.fingerprint) throw reload();
  const actorId = new Types.ObjectId(actor.id);
  await withTransaction(async (session) => {
    const result = await GhiQcrModel.updateOne(
      { _id: qcr._id, status: 'SUBMITTED', fingerprint: input.fingerprint },
      {
        $set: {
          status: input.decision,
          decision: { status: input.decision, at: new Date(), by: actorId, comment: input.comment },
          updatedBy: actorId,
        },
      },
      { session },
    );
    if (result.modifiedCount === 0) throw reload();
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
      {
        version: qcr.version,
        status: input.decision,
        comment: input.comment,
        fingerprint: input.fingerprint,
        columns: view.columns.map((column) => ({
          insurer: column.insurerName,
          quoteVersion: column.quoteVersion,
          basePremium: column.basePremium,
          gst: column.gst,
          totalPremium: column.totalPremium,
          lowest: column.lowest,
          deviations: column.deviations.length,
        })),
        recommendedInsurerId: view.recommendedInsurerId,
        remarks: view.remarks,
      },
      session,
      scope,
    );
  });
  return getEbQcr(doc, qcrId);
}

async function qcrFileOf(doc: GhiCaseDoc, qcr: EbQcr, format: 'xlsx' | 'pdf') {
  const model = ebQcrDocument(await toEbCaseRecord(doc), qcr, await summaryOf(doc));
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

/** Downloads a QCR version (8.6), audited as an export. */
export async function ebQcrFile(
  scope: CaseScope,
  id: string,
  qcrId: string,
  format: 'xlsx' | 'pdf',
  actor: Actor,
) {
  const doc = await loadCase(id, undefined, scope);
  const qcr = await getEbQcr(doc, qcrId);
  const file = await qcrFileOf(doc, qcr, format);
  await auditCase(
    actor,
    AUDIT_ACTIONS.GHI_QCR_DOWNLOADED,
    id,
    null,
    { version: qcr.version, status: qcr.status, format },
    undefined,
    scope,
  );
  return file;
}

/** Mails the latest approved QCR to the company's contacts only (8.7, 8.8). */
export async function sendEbQcr(
  scope: CaseScope,
  id: string,
  qcrId: string,
  input: { sendId: string; to: string[]; format: 'xlsx' | 'pdf' },
  actor: Actor,
  transport: MailTransport,
): Promise<{ result: GhiSendOutcome; qcr: EbQcr }> {
  assertMailOn(transport, 'QCR');
  const doc = await loadCase(id, undefined, scope);
  assertWritable(doc);
  const qcrDoc = await loadLatestEbQcr(doc, qcrId);
  if (qcrDoc.status !== 'APPROVED' || (await isOutOfDate(doc, qcrDoc))) {
    throw conflict(
      ERROR_CODES.QCR_NOT_APPROVED,
      `QCR v${qcrDoc.version} must be the latest approved and current version before it goes to the client.`,
    );
  }
  const record = await toEbCaseRecord(doc);
  const allowed = new Set(record.client.contacts.map((contact) => contact.email.toLowerCase()));
  const outside = input.to.filter((email) => !allowed.has(email.toLowerCase()));
  if (outside.length > 0) {
    throw validationError([
      {
        location: 'body',
        path: 'to',
        message: `Send only to the company’s contacts in the client master (not ${outside.join(', ')})`,
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
      qcr: await getEbQcr(doc, qcrId),
    };
  }
  const qcr = await getEbQcr(doc, qcrId);
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
      scope,
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
    qcr: await getEbQcr(doc, qcrId),
  };
}

export { isOutOfDate as ebQcrOutOfDate };
