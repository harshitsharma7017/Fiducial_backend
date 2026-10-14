import {
  AUDIT_ACTIONS,
  ERROR_CODES,
  PDF_CONTENT_TYPE,
  XLSX_CONTENT_TYPE,
  type DispatchGhiRfqRequest,
  type DispatchGhiRfqResponse,
  type GhiCaseRecord,
  type GhiDecisionRequest,
  type GhiDocumentPreview,
  type GhiRfqState,
  type GhiRfqVersion,
  type GhiSendOutcome,
  type MarkGhiRfqSentRequest,
} from '../../shared/index.ts';
import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import { withTransaction } from '../../lib/db.ts';
import { toDecimal128 } from '../../lib/decimal.ts';
import { conflict, notFound, validationError } from '../../lib/errors.ts';
import { openTemplate } from '../documents/excel-template.ts';
import { letterheadOf, type Letterhead } from '../documents/sheet-pdf.ts';
import { templateFile } from '../documents/templates.service.ts';
import { InsurerModel } from '../insurers/insurer.model.ts';
import type { MailTransport } from '../mail/transport.ts';
import { censusIssues, membersForDocuments } from './census.service.ts';
import {
  advanceStage,
  assertOpen,
  auditCase,
  insurerNames,
  isLocked,
  loadCase,
  loadSummary,
  missingCensus,
  missingRequirements,
  nameOf,
  toCaseRecord,
  userNames,
  type Actor,
} from './ghi-common.ts';
import { GhiCaseModel, type GhiCaseDoc } from './ghi-case.model.ts';
import { rfqDocument } from './ghi-documents.ts';
import {
  assertMailOn,
  deliver,
  dispatchesOf,
  logDispatch,
  prepareAttachment,
  prepareMail,
} from './ghi-mail.ts';
import { toPdf, toPreview, toXlsx } from './ghi-sheet.ts';
import {
  GhiDispatchModel,
  GhiFileModel,
  GhiRfqModel,
  type GhiRfqDoc,
} from './ghi-workflow.model.ts';

// The GHI RFQ (G5): generated from the saved Data Sheet and census as a version (Excel and PDF,
// kept exactly as generated), submitted and approved, then emailed to each insurer. Only the
// latest version, approved and not out of date, can go to insurers.

/** A send to the same insurer that started this long ago is taken to have died. */
const CLAIM_STALE_MS = 10 * 60 * 1000;

const fingerprintOf = (doc: Pick<GhiCaseDoc, 'requirementsRevision' | 'censusRevision'>) =>
  `${doc.requirementsRevision}:${doc.censusRevision}`;

/** The letterhead of the client's uploaded RFQ format, when there is one. */
export async function caseLetterhead(): Promise<Letterhead> {
  const template = await templateFile('RFQ');
  if (!template) return { logo: null, address: null };
  try {
    return letterheadOf(await openTemplate(template.data));
  } catch {
    return { logo: null, address: null };
  }
}

function toVersion(
  rfq: GhiRfqDoc,
  doc: GhiCaseDoc,
  names: ReadonlyMap<string, string>,
): GhiRfqVersion {
  return {
    id: rfq._id.toHexString(),
    version: rfq.version,
    status: rfq.status,
    stale: rfq.fingerprint !== fingerprintOf(doc),
    generatedAt: rfq.createdAt.toISOString(),
    generatedBy: nameOf(names, rfq.generatedBy),
    submitted: rfq.submitted
      ? { at: rfq.submitted.at.toISOString(), by: nameOf(names, rfq.submitted.by) }
      : null,
    decision: rfq.decision
      ? {
          status: rfq.decision.status,
          at: rfq.decision.at.toISOString(),
          by: nameOf(names, rfq.decision.by),
          comment: rfq.decision.comment,
        }
      : null,
    census: {
      employees: rfq.census.employees,
      lives: rfq.census.lives,
      totalSumInsured: rfq.census.totalSumInsured?.toString() ?? null,
    },
  };
}

/** What stops an RFQ being generated now: the Data Sheet, the census and its checks. */
async function rfqBlockers(doc: GhiCaseDoc): Promise<string[]> {
  const summary = await loadSummary(doc);
  const issues = await censusIssues(doc);
  return [
    ...missingRequirements(doc),
    ...missingCensus(summary),
    ...(issues.length > 0
      ? [
          `${issues.length} census member(s) do not fit the Data Sheet: correct them on the Census tab`,
        ]
      : []),
  ];
}

export async function rfqState(id: string, transport: MailTransport): Promise<GhiRfqState> {
  const doc = await loadCase(id);
  const versions = await GhiRfqModel.find({ caseId: doc._id }).sort({ version: -1 }).lean();
  const names = await userNames(
    versions.flatMap((rfq) => [rfq.generatedBy, rfq.submitted?.by, rfq.decision?.by]),
  );
  const views = versions.map((rfq) => toVersion(rfq, doc, names));
  return {
    versions: views,
    current: views[0] ?? null,
    missing: await rfqBlockers(doc),
    mailEnabled: transport.name !== 'off',
    dispatches: await dispatchesOf(doc._id, { kind: 'RFQ' }),
  };
}

async function rfqModel(doc: GhiCaseDoc, version: number) {
  const [record, summary, members] = await Promise.all([
    toCaseRecord(doc),
    loadSummary(doc),
    membersForDocuments(doc),
  ]);
  return { model: rfqDocument(record, summary, members, version), summary };
}

/** The RFQ as it would be generated now, for the screen. */
export async function rfqPreview(id: string): Promise<GhiDocumentPreview> {
  const doc = await loadCase(id);
  const latest = await GhiRfqModel.findOne({ caseId: doc._id }, { version: 1 })
    .sort({ version: -1 })
    .lean();
  const { model } = await rfqModel(
    doc,
    latest && latest.status === 'DRAFT' ? latest.version : (latest?.version ?? 0) + 1,
  );
  return toPreview(model);
}

/** Generates a new RFQ version from the saved Data Sheet and census; the case moves to RFQ. */
export async function generateRfq(
  id: string,
  actor: Actor,
  transport: MailTransport,
): Promise<GhiRfqState> {
  const doc = await loadCase(id);
  assertOpen(doc);
  if (isLocked(doc)) {
    throw conflict(
      ERROR_CODES.GHI_LOCKED,
      'The RFQ has gone to insurers; it cannot be generated again.',
    );
  }
  const blockers = await rfqBlockers(doc);
  if (blockers.length > 0) {
    throw conflict(ERROR_CODES.GHI_INCOMPLETE, `The RFQ needs: ${blockers.join('; ')}.`, {
      missing: blockers,
    });
  }
  const latest = await GhiRfqModel.findOne({ caseId: doc._id }, { version: 1 })
    .sort({ version: -1 })
    .lean();
  const version = (latest?.version ?? 0) + 1;
  const { model, summary } = await rfqModel(doc, version);
  const [xlsx, pdf] = await Promise.all([toXlsx(model), toPdf(model, await caseLetterhead())]);
  const actorId = new Types.ObjectId(actor.id);
  await withTransaction(async (session) => {
    // The Data Sheet and census must still be what the files were made from.
    const current = await GhiCaseModel.findById(doc._id).session(session).lean<GhiCaseDoc>();
    if (!current || fingerprintOf(current) !== fingerprintOf(doc)) {
      throw conflict(
        ERROR_CODES.CONFLICT,
        'The Data Sheet or census changed while the RFQ was being generated. Generate it again.',
      );
    }
    const files = await GhiFileModel.create(
      [
        { file: xlsx, name: `${model.fileBase}.xlsx`, type: XLSX_CONTENT_TYPE },
        { file: pdf, name: `${model.fileBase}.pdf`, type: PDF_CONTENT_TYPE },
      ].map((item) => ({
        caseId: doc._id,
        purpose: 'RFQ',
        fileName: item.name,
        contentType: item.type,
        size: item.file.length,
        sha256: createHash('sha256').update(item.file).digest('hex'),
        data: item.file,
        uploadedBy: actorId,
      })),
      { session, ordered: true },
    );
    await GhiRfqModel.create(
      [
        {
          caseId: doc._id,
          version,
          status: 'DRAFT',
          fingerprint: fingerprintOf(doc),
          census: {
            employees: summary.employees,
            lives: summary.lives,
            totalSumInsured:
              summary.totalSumInsured === null ? null : toDecimal128(summary.totalSumInsured),
          },
          xlsxFileId: files[0]!._id,
          pdfFileId: files[1]!._id,
          generatedBy: actorId,
          submitted: null,
          decision: null,
        },
      ],
      { session },
    );
    await GhiCaseModel.updateOne(
      { _id: doc._id },
      { $push: { activity: { at: new Date(), actorId, message: `RFQ v${version} generated` } } },
      { session },
    );
    await advanceStage(doc._id, 'RFQ', actorId, session);
    await auditCase(
      actor,
      AUDIT_ACTIONS.GHI_RFQ_GENERATED,
      id,
      null,
      {
        version,
        employees: summary.employees,
        lives: summary.lives,
        totalSumInsured: summary.totalSumInsured,
      },
      session,
    );
  });
  return rfqState(id, transport);
}

async function currentVersion(doc: GhiCaseDoc): Promise<GhiRfqDoc> {
  const rfq = await GhiRfqModel.findOne({ caseId: doc._id }).sort({ version: -1 }).lean();
  if (!rfq) throw conflict(ERROR_CODES.RFQ_NOT_APPROVED, 'Generate the RFQ first.');
  return rfq;
}

function assertFresh(rfq: GhiRfqDoc, doc: GhiCaseDoc): void {
  if (rfq.fingerprint !== fingerprintOf(doc)) {
    throw conflict(
      ERROR_CODES.RFQ_NOT_APPROVED,
      `The Data Sheet or census changed after RFQ v${rfq.version} was generated. Generate a new version.`,
    );
  }
}

export async function submitRfq(
  id: string,
  actor: Actor,
  transport: MailTransport,
): Promise<GhiRfqState> {
  const doc = await loadCase(id);
  assertOpen(doc);
  const rfq = await currentVersion(doc);
  assertFresh(rfq, doc);
  if (rfq.status !== 'DRAFT' && rfq.status !== 'RETURNED') {
    throw conflict(
      ERROR_CODES.CONFLICT,
      `RFQ v${rfq.version} is ${rfq.status === 'APPROVED' ? 'already approved' : 'already awaiting approval'}.`,
    );
  }
  const actorId = new Types.ObjectId(actor.id);
  await withTransaction(async (session) => {
    const result = await GhiRfqModel.updateOne(
      { _id: rfq._id, status: rfq.status },
      { $set: { status: 'SUBMITTED', submitted: { at: new Date(), by: actorId }, decision: null } },
      { session },
    );
    if (result.modifiedCount === 0)
      throw conflict(ERROR_CODES.CONFLICT, 'The RFQ changed meanwhile. Reload it.');
    await GhiCaseModel.updateOne(
      { _id: doc._id },
      {
        $push: {
          activity: {
            at: new Date(),
            actorId,
            message: `RFQ v${rfq.version} submitted for approval`,
          },
        },
      },
      { session },
    );
    await auditCase(
      actor,
      AUDIT_ACTIONS.GHI_RFQ_SUBMITTED,
      id,
      { version: rfq.version, status: rfq.status },
      { version: rfq.version, status: 'SUBMITTED' },
      session,
    );
  });
  return rfqState(id, transport);
}

export async function decideRfq(
  id: string,
  input: GhiDecisionRequest,
  actor: Actor,
  transport: MailTransport,
): Promise<GhiRfqState> {
  const doc = await loadCase(id);
  assertOpen(doc);
  const rfq = await currentVersion(doc);
  assertFresh(rfq, doc);
  if (rfq.status !== 'SUBMITTED') {
    throw conflict(ERROR_CODES.CONFLICT, `RFQ v${rfq.version} is not awaiting approval.`);
  }
  const actorId = new Types.ObjectId(actor.id);
  await withTransaction(async (session) => {
    const result = await GhiRfqModel.updateOne(
      { _id: rfq._id, status: 'SUBMITTED' },
      {
        $set: {
          status: input.decision,
          decision: { status: input.decision, at: new Date(), by: actorId, comment: input.comment },
        },
      },
      { session },
    );
    if (result.modifiedCount === 0)
      throw conflict(ERROR_CODES.CONFLICT, 'The RFQ changed meanwhile. Reload it.');
    await GhiCaseModel.updateOne(
      { _id: doc._id },
      {
        $push: {
          activity: {
            at: new Date(),
            actorId,
            message: `RFQ v${rfq.version} ${input.decision === 'APPROVED' ? 'approved' : `returned: ${input.comment ?? ''}`}`,
          },
        },
      },
      { session },
    );
    await auditCase(
      actor,
      input.decision === 'APPROVED'
        ? AUDIT_ACTIONS.GHI_RFQ_APPROVED
        : AUDIT_ACTIONS.GHI_RFQ_RETURNED,
      id,
      { version: rfq.version, status: 'SUBMITTED' },
      { version: rfq.version, status: input.decision, comment: input.comment },
      session,
    );
  });
  return rfqState(id, transport);
}

/** A generated RFQ file, exactly as it was generated (the latest version unless one is named). */
export async function rfqFile(
  id: string,
  format: 'xlsx' | 'pdf',
  actor: Actor,
  versionId?: string,
): Promise<{ fileName: string; contentType: string; data: Buffer }> {
  const doc = await loadCase(id);
  const rfq = versionId
    ? await GhiRfqModel.findOne({ _id: new Types.ObjectId(versionId), caseId: doc._id }).lean()
    : await GhiRfqModel.findOne({ caseId: doc._id }).sort({ version: -1 }).lean();
  if (!rfq) throw notFound('Generate the RFQ first');
  const file = await GhiFileModel.findOne({
    _id: format === 'pdf' ? rfq.pdfFileId : rfq.xlsxFileId,
    caseId: doc._id,
  }).lean();
  if (!file) throw notFound('RFQ file not found');
  await auditCase(actor, AUDIT_ACTIONS.GHI_RFQ_DOWNLOADED, id, null, {
    version: rfq.version,
    format,
  });
  const raw = file.data as unknown as Buffer | { buffer: Uint8Array };
  return {
    fileName: file.fileName,
    contentType: file.contentType,
    data: Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer),
  };
}

async function approvedForSending(doc: GhiCaseDoc): Promise<GhiRfqDoc> {
  const rfq = await currentVersion(doc);
  assertFresh(rfq, doc);
  if (rfq.status !== 'APPROVED') {
    throw conflict(
      ERROR_CODES.RFQ_NOT_APPROVED,
      `RFQ v${rfq.version} must be approved before it goes to insurers.`,
    );
  }
  return rfq;
}

function insurersOnCase(doc: GhiCaseDoc, insurerIds: readonly string[]) {
  const issues: { location: 'body'; path: string; message: string }[] = [];
  const items = insurerIds.map((insurerId, index) => {
    const item = doc.insurers.find((insurer) => insurer.insurerId.toHexString() === insurerId);
    if (!item)
      issues.push({
        location: 'body',
        path: `insurerIds.${index}`,
        message: 'Choose an insurer on this case',
      });
    return item;
  });
  if (issues.length > 0) throw validationError(issues);
  return items.filter((item) => item !== undefined);
}

/**
 * Emails the approved RFQ to each insurer chosen, one mail per insurer, To the insurer's RFQ
 * addresses from the insurer master only. An insurer is Sent only when its mail was accepted; a
 * repeated request (same sendId) mails nobody twice.
 */
export async function dispatchRfq(
  id: string,
  input: DispatchGhiRfqRequest,
  actor: Actor,
  transport: MailTransport,
): Promise<DispatchGhiRfqResponse> {
  assertMailOn(transport, 'RFQ');
  const doc = await loadCase(id);
  assertOpen(doc);
  const rfq = await approvedForSending(doc);
  const items = insurersOnCase(doc, input.insurerIds);
  const masters = await InsurerModel.find({
    _id: { $in: items.map((item) => item.insurerId) },
  }).lean();
  const record = await toCaseRecord(doc);
  const file = await GhiFileModel.findOne({
    _id: input.format === 'pdf' ? rfq.pdfFileId : rfq.xlsxFileId,
    caseId: doc._id,
  }).lean();
  if (!file) throw notFound('RFQ file not found');
  const raw = file.data as unknown as Buffer | { buffer: Uint8Array };
  const attachmentFile = {
    fileName: file.fileName,
    contentType: file.contentType,
    data: Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer),
  };
  const attachment = await prepareAttachment(attachmentFile);
  const actorId = new Types.ObjectId(actor.id);
  const results: GhiSendOutcome[] = [];

  for (const item of items) {
    const master = masters.find((insurer) => insurer._id.equals(item.insurerId));
    const recipient = master ? `${master.company}, ${master.branch}` : 'Insurer';
    const earlier = await GhiDispatchModel.findOne({
      sendId: input.sendId,
      kind: 'RFQ',
      insurerId: item.insurerId,
    }).lean();
    if (earlier) {
      results.push({
        insurerId: item.insurerId.toHexString(),
        recipient,
        outcome: earlier.result === 'FAILED' ? 'FAILED' : 'SENT',
        result: earlier.result,
        reason: earlier.error,
      });
      continue;
    }
    const to = master?.active ? master.rfqEmails.map((email) => email.toLowerCase()) : [];
    if (to.length === 0) {
      results.push({
        insurerId: item.insurerId.toHexString(),
        recipient,
        outcome: 'FAILED',
        result: 'FAILED',
        reason: master
          ? 'The insurer is inactive or has no RFQ email address in the insurer master'
          : 'The insurer no longer exists',
      });
      continue;
    }
    // Claim the insurer for this send, so a second send at the same time cannot mail it too.
    const claimed = await GhiCaseModel.updateOne(
      {
        _id: doc._id,
        insurers: {
          $elemMatch: {
            insurerId: item.insurerId,
            $or: [
              { sending: null },
              { 'sending.at': { $lt: new Date(Date.now() - CLAIM_STALE_MS) } },
            ],
          },
        },
      },
      { $set: { 'insurers.$.sending': { sendId: input.sendId, at: new Date() } } },
    );
    if (claimed.modifiedCount === 0) {
      results.push({
        insurerId: item.insurerId.toHexString(),
        recipient,
        outcome: 'FAILED',
        result: 'FAILED',
        reason: 'Another send to this insurer is in progress. Try again in a moment.',
      });
      continue;
    }
    const mail = await prepareMail(
      'RFQ',
      doc,
      record.client.name,
      recipient,
      input.dueDate,
      actor.id,
    );
    const delivery = await deliver(transport, mail, to, attachmentFile);
    const at = new Date();
    await withTransaction(async (session) => {
      await logDispatch(
        {
          caseId: doc._id,
          kind: 'RFQ',
          documentId: rfq._id,
          insurerId: item.insurerId,
          recipient,
          sendId: input.sendId,
          to,
          mail,
          attachment: { id: attachment.id, fileName: attachment.fileName },
          dueDate: input.dueDate,
          actorId,
          transport,
          delivery,
        },
        session,
      );
      const set: Record<string, unknown> = {
        'insurers.$[target].sending': null,
        'insurers.$[target].lastDispatch': { at, result: delivery.result, error: delivery.error },
        updatedBy: actorId,
      };
      if (delivery.ok) {
        Object.assign(set, {
          'insurers.$[target].sentVia': 'APP',
          'insurers.$[target].sentAt': at,
          'insurers.$[target].sentBy': actorId,
          'insurers.$[target].dueDate': input.dueDate,
          ...(item.status === 'NOT_SENT' ? { 'insurers.$[target].status': 'SENT' } : {}),
        });
      }
      await GhiCaseModel.updateOne(
        { _id: doc._id },
        {
          $set: set,
          $push: {
            activity: {
              at,
              actorId,
              message: delivery.ok
                ? `RFQ v${rfq.version} emailed to ${recipient} (${to.join(', ')})${delivery.result === 'OUTBOX' ? ' (kept in the outbox, not delivered)' : ''}`
                : `RFQ email to ${recipient} failed: ${delivery.error}`,
            },
          },
        },
        { session, arrayFilters: [{ 'target.insurerId': item.insurerId }] },
      );
      await auditCase(
        actor,
        delivery.ok ? AUDIT_ACTIONS.GHI_RFQ_EMAILED : AUDIT_ACTIONS.GHI_RFQ_EMAIL_FAILED,
        id,
        null,
        {
          version: rfq.version,
          insurer: recipient,
          to: to.join(', '),
          result: delivery.result,
          attachment: attachment.fileName,
          ...(delivery.ok ? {} : { error: delivery.error }),
        },
        session,
      );
    });
    results.push({
      insurerId: item.insurerId.toHexString(),
      recipient,
      outcome: delivery.ok ? 'SENT' : 'FAILED',
      result: delivery.result,
      reason: delivery.error,
    });
  }
  return { results, case: await toCaseRecord(await loadCase(id)) };
}

/** The approved RFQ went to these insurers outside the app (mail off, portal, by hand). */
export async function markRfqSent(
  id: string,
  input: MarkGhiRfqSentRequest,
  actor: Actor,
): Promise<GhiCaseRecord> {
  const doc = await loadCase(id);
  assertOpen(doc);
  const rfq = await approvedForSending(doc);
  const items = insurersOnCase(doc, input.insurerIds);
  const actorId = new Types.ObjectId(actor.id);
  const names = await insurerNames(items.map((item) => item.insurerId));
  const at = new Date();
  await withTransaction(async (session) => {
    for (const item of items) {
      await GhiCaseModel.updateOne(
        { _id: doc._id },
        {
          $set: {
            'insurers.$[target].sentVia': 'OUTSIDE',
            'insurers.$[target].sentAt': at,
            'insurers.$[target].sentBy': actorId,
            'insurers.$[target].dueDate': input.dueDate,
            ...(item.status === 'NOT_SENT' ? { 'insurers.$[target].status': 'SENT' } : {}),
            updatedBy: actorId,
          },
          $push: {
            activity: {
              at,
              actorId,
              message: `RFQ v${rfq.version} marked as sent outside the app to ${names.get(item.insurerId.toHexString()) ?? 'insurer'}`,
            },
          },
        },
        { session, arrayFilters: [{ 'target.insurerId': item.insurerId }] },
      );
    }
    await auditCase(
      actor,
      AUDIT_ACTIONS.GHI_RFQ_MARKED_SENT,
      id,
      null,
      {
        version: rfq.version,
        insurers: items.map((item) => names.get(item.insurerId.toHexString()) ?? '').join(', '),
        dueDate: input.dueDate,
      },
      session,
    );
  });
  return toCaseRecord(await loadCase(id));
}
