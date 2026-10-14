import {
  AUDIT_ACTIONS,
  ERROR_CODES,
  GHI_PAYMENT_STATUS_LABELS,
  PDF_CONTENT_TYPE,
  XLSX_CONTENT_TYPE,
  formatDate,
  type GhiCaseRecord,
  type GhiFinalQcrState,
  type GhiPayment,
  type GhiPaymentsResponse,
  type GhiPlacementState,
  type RecordGhiFinalQcrRequest,
  type RecordGhiPolicyRequest,
  type SaveGhiPaymentRequest,
} from '../../shared/index.ts';
import { Types, type mongo } from 'mongoose';
import { withTransaction } from '../../lib/db.ts';
import { Decimal, moneyString, toDecimal128 } from '../../lib/decimal.ts';
import { conflict, notFound, validationError } from '../../lib/errors.ts';
import { istDay } from '../../lib/ist-day.ts';
import { membersForDocuments } from './census.service.ts';
import {
  advanceStage,
  assertOpen,
  auditCase,
  insurerNames,
  loadCase,
  loadSummary,
  nameOf,
  stageIndex,
  toCaseRecord,
  userNames,
  type Actor,
} from './ghi-common.ts';
import { GhiCaseModel, type GhiCaseDoc } from './ghi-case.model.ts';
import { placementSlipDocument } from './ghi-documents.ts';
import { assertCaseFiles, fileNames } from './ghi-files.service.ts';
import { acceptedQcr } from './ghi-qcr.service.ts';
import { premiumOf } from './ghi-quote-calc.ts';
import { quoteViews } from './ghi-quotes.service.ts';
import { caseLetterhead } from './ghi-rfq.service.ts';
import { toPdf, toXlsx } from './ghi-sheet.ts';
import {
  GhiFileModel,
  GhiPaymentModel,
  GhiQcrModel,
  GhiQuoteModel,
  type GhiPaymentDoc,
} from './ghi-workflow.model.ts';

// After the client accepts (G7): the final agreed terms as a new quote version (earlier quotes
// stay as they were), the premium payments, the placement slip and the policy the insurer issued.

export async function finalQcrState(id: string): Promise<GhiFinalQcrState> {
  const doc = await loadCase(id);
  const accepted = await acceptedQcr(doc._id);
  const finals = accepted
    ? await GhiQuoteModel.find({
        caseId: doc._id,
        insurerId: accepted.quote.insurerId,
        kind: 'FINAL_AGREED',
      })
        .sort({ version: -1 })
        .lean()
    : [];
  const views = await quoteViews(doc, [...(accepted ? [accepted.quote] : []), ...finals]);
  const acceptedView = accepted ? views[0]! : null;
  const history = accepted ? views.slice(1) : [];
  const current = doc.finalQcr
    ? (history.find((quote) => quote.id === doc.finalQcr!.quoteId.toHexString()) ?? null)
    : null;
  return {
    accepted:
      acceptedView && accepted
        ? {
            qcrId: accepted.qcr._id.toHexString(),
            qcrVersion: accepted.qcr.version,
            quote: acceptedView,
          }
        : null,
    current,
    history,
    note: doc.finalQcr?.note ?? null,
  };
}

/** Records the final agreed premium and terms with the insurer the client chose (G7). */
export async function recordFinalQcr(
  id: string,
  input: RecordGhiFinalQcrRequest,
  actor: Actor,
): Promise<GhiFinalQcrState> {
  const doc = await loadCase(id);
  assertOpen(doc);
  if (doc.policy)
    throw conflict(
      ERROR_CODES.CONFLICT,
      'The policy is recorded; the final terms can no longer change.',
    );
  const accepted = await acceptedQcr(doc._id);
  if (!accepted) {
    throw conflict(
      ERROR_CODES.QCR_NOT_APPROVED,
      'Record the client’s acceptance of the approved QCR first.',
    );
  }
  const received = await GhiPaymentModel.exists({ caseId: doc._id, status: 'RECEIVED' });
  if (received && doc.finalQcr) {
    throw conflict(
      ERROR_CODES.CONFLICT,
      'Premium has been received against the final terms. Correct the payments first if the premium changed.',
    );
  }
  if (new Decimal(input.basePremium).lessThanOrEqualTo(0)) {
    throw validationError([
      { location: 'body', path: 'basePremium', message: 'Enter a premium above 0' },
    ]);
  }
  const attachmentIds = await assertCaseFiles(
    doc._id,
    input.attachmentIds,
    'QUOTE',
    'attachmentIds',
  );
  const gstRatePercent = new Decimal(doc.gstRatePercent.toString()).toFixed();
  const premium = premiumOf(input.basePremium, gstRatePercent);
  const actorId = new Types.ObjectId(actor.id);
  const insurerId = accepted.quote.insurerId;
  const insurerName = (await insurerNames([insurerId])).get(insurerId.toHexString()) ?? 'Insurer';
  await withTransaction(async (session) => {
    const last = await GhiQuoteModel.findOne({ caseId: doc._id, insurerId }, { version: 1 })
      .sort({ version: -1 })
      .session(session)
      .lean();
    const now = new Date();
    const [quote] = await GhiQuoteModel.create(
      [
        {
          caseId: doc._id,
          insurerId,
          version: (last?.version ?? 0) + 1,
          status: 'FINAL',
          kind: 'FINAL_AGREED',
          reason: input.note,
          basePremium: toDecimal128(premium.basePremium),
          gstRatePercent: toDecimal128(gstRatePercent),
          gst: toDecimal128(premium.gst),
          totalPremium: toDecimal128(premium.totalPremium),
          terms: input.terms,
          otherTerms: input.otherTerms,
          validUntil: null,
          attachmentIds,
          createdBy: actorId,
          finalizedAt: now,
          finalizedBy: actorId,
        },
      ],
      { session },
    );
    if (!quote) throw new Error('Final terms were not saved');
    const result = await GhiCaseModel.updateOne(
      { _id: doc._id, stage: { $ne: 'CLOSED' }, policy: null },
      {
        $set: {
          finalQcr: {
            quoteId: quote._id,
            qcrId: accepted.qcr._id,
            insurerId,
            note: input.note,
            recordedAt: now,
            recordedBy: actorId,
          },
          updatedBy: actorId,
        },
        $push: {
          activity: {
            at: now,
            actorId,
            message: `Final QCR ${doc.finalQcr ? 'revised' : 'recorded'} with ${insurerName}: total ₹${premium.totalPremium} (accepted quote ₹${new Decimal(accepted.quote.totalPremium?.toString() ?? '0').toFixed(2)})`,
          },
        },
      },
      { session },
    );
    if (result.modifiedCount === 0)
      throw conflict(ERROR_CODES.GHI_LOCKED, 'This case is closed or placed.');
    await advanceStage(doc._id, 'PAYMENT', actorId, session);
    await auditCase(
      actor,
      AUDIT_ACTIONS.GHI_FINAL_QCR_RECORDED,
      id,
      doc.finalQcr ? { quoteId: doc.finalQcr.quoteId.toHexString() } : null,
      {
        insurer: insurerName,
        qcrVersion: accepted.qcr.version,
        version: quote.version,
        ...premium,
        terms: input.terms,
        note: input.note,
      },
      session,
    );
  });
  return finalQcrState(id);
}

function toPayment(
  doc: GhiPaymentDoc,
  names: ReadonlyMap<string, string>,
  files: ReadonlyMap<string, string>,
): GhiPayment {
  return {
    id: doc._id.toHexString(),
    amount: moneyString(new Decimal(doc.amount.toString())),
    paidOn: doc.paidOn,
    reference: doc.reference,
    mode: doc.mode,
    status: doc.status,
    payer: doc.payer,
    note: doc.note,
    files: doc.fileIds.map((fileId) => ({
      id: fileId.toHexString(),
      fileName: files.get(fileId.toHexString()) ?? 'File',
    })),
    recordedAt: doc.createdAt.toISOString(),
    recordedBy: nameOf(names, doc.createdBy),
    updatedAt: doc.updatedAt.toISOString(),
    updatedBy: nameOf(names, doc.updatedBy),
  };
}

async function expectedPremium(
  doc: GhiCaseDoc,
  session?: mongo.ClientSession,
): Promise<Decimal | null> {
  if (!doc.finalQcr) return null;
  const quote = await GhiQuoteModel.findOne(
    { _id: doc.finalQcr.quoteId, caseId: doc._id },
    { totalPremium: 1 },
  )
    .session(session ?? null)
    .lean();
  return quote?.totalPremium ? new Decimal(quote.totalPremium.toString()) : null;
}

function totals(
  payments: readonly Pick<GhiPaymentDoc, 'amount' | 'status'>[],
  expected: Decimal | null,
) {
  const sum = (status: string) =>
    payments
      .filter((payment) => payment.status === status)
      .reduce((total, payment) => total.plus(payment.amount.toString()), new Decimal(0));
  const received = sum('RECEIVED');
  return {
    received,
    pending: sum('PENDING'),
    outstanding: expected ? Decimal.max(expected.minus(received), 0) : null,
    settled: expected !== null && received.greaterThanOrEqualTo(expected),
  };
}

export async function listPayments(id: string): Promise<GhiPaymentsResponse> {
  const doc = await loadCase(id);
  const payments = await GhiPaymentModel.find({ caseId: doc._id })
    .sort({ paidOn: 1, _id: 1 })
    .lean();
  const [names, files, expected] = await Promise.all([
    userNames(payments.flatMap((payment) => [payment.createdBy, payment.updatedBy])),
    fileNames(payments.flatMap((payment) => payment.fileIds)),
    expectedPremium(doc),
  ]);
  const sums = totals(payments, expected);
  return {
    expected: expected ? moneyString(expected) : null,
    received: moneyString(sums.received),
    pending: moneyString(sums.pending),
    outstanding: sums.outstanding ? moneyString(sums.outstanding) : null,
    settled: sums.settled,
    items: payments.map((payment) => toPayment(payment, names, files)),
  };
}

async function checkPayment(doc: GhiCaseDoc, input: SaveGhiPaymentRequest) {
  assertOpen(doc);
  if (!doc.finalQcr)
    throw conflict(
      ERROR_CODES.CONFLICT,
      'Record the final QCR first: the payment is against its premium.',
    );
  if (input.status !== 'PENDING' && input.paidOn > istDay(new Date())) {
    throw validationError([
      {
        location: 'body',
        path: 'paidOn',
        message: 'A received or failed payment cannot be dated in the future',
      },
    ]);
  }
  return assertCaseFiles(doc._id, input.fileIds, 'PAYMENT', 'fileIds');
}

/** Moves the case to Placement Slip once the premium received covers the final premium. */
async function settle(doc: GhiCaseDoc, actorId: Types.ObjectId, session: mongo.ClientSession) {
  const [payments, expected] = await Promise.all([
    GhiPaymentModel.find({ caseId: doc._id }, { amount: 1, status: 1 }).session(session).lean(),
    expectedPremium(doc, session),
  ]);
  if (totals(payments, expected).settled)
    await advanceStage(doc._id, 'PLACEMENT_SLIP', actorId, session);
}

const paymentAudit = (
  payment: Pick<
    GhiPaymentDoc,
    'amount' | 'paidOn' | 'reference' | 'mode' | 'status' | 'payer' | 'note'
  >,
) => ({
  amount: moneyString(new Decimal(payment.amount.toString())),
  paidOn: payment.paidOn,
  reference: payment.reference,
  mode: payment.mode,
  status: payment.status,
  payer: payment.payer,
  note: payment.note,
});

export async function addPayment(
  id: string,
  input: SaveGhiPaymentRequest,
  actor: Actor,
): Promise<GhiPaymentsResponse> {
  const doc = await loadCase(id);
  const fileIds = await checkPayment(doc, input);
  const actorId = new Types.ObjectId(actor.id);
  await withTransaction(async (session) => {
    const [payment] = await GhiPaymentModel.create(
      [
        {
          caseId: doc._id,
          ...input,
          amount: toDecimal128(moneyString(new Decimal(input.amount))),
          fileIds,
          createdBy: actorId,
          updatedBy: actorId,
        },
      ],
      { session },
    );
    if (!payment) throw new Error('Payment was not saved');
    await GhiCaseModel.updateOne(
      { _id: doc._id },
      {
        $push: {
          activity: {
            at: new Date(),
            actorId,
            message: `Payment ₹${moneyString(new Decimal(input.amount))} (${input.reference}, ${formatDate(input.paidOn)}) recorded as ${GHI_PAYMENT_STATUS_LABELS[input.status].toLowerCase()}`,
          },
        },
      },
      { session },
    );
    await settle(doc, actorId, session);
    await auditCase(
      actor,
      AUDIT_ACTIONS.GHI_PAYMENT_RECORDED,
      id,
      null,
      { paymentId: payment._id.toHexString(), ...paymentAudit(payment) },
      session,
    );
  });
  return listPayments(id);
}

export async function updatePayment(
  id: string,
  paymentId: string,
  input: SaveGhiPaymentRequest,
  actor: Actor,
): Promise<GhiPaymentsResponse> {
  const doc = await loadCase(id);
  const fileIds = await checkPayment(doc, input);
  if (doc.policy)
    throw conflict(ERROR_CODES.CONFLICT, 'The policy is recorded; payments can no longer change.');
  const current = await GhiPaymentModel.findOne({
    _id: new Types.ObjectId(paymentId),
    caseId: doc._id,
  }).lean();
  if (!current) throw notFound('Payment not found');
  const actorId = new Types.ObjectId(actor.id);
  await withTransaction(async (session) => {
    const updated = await GhiPaymentModel.findOneAndUpdate(
      { _id: current._id, caseId: doc._id },
      {
        $set: {
          ...input,
          amount: toDecimal128(moneyString(new Decimal(input.amount))),
          fileIds,
          updatedBy: actorId,
        },
      },
      { returnDocument: 'after', session },
    ).lean();
    if (!updated) throw notFound('Payment not found');
    await GhiCaseModel.updateOne(
      { _id: doc._id },
      {
        $push: {
          activity: {
            at: new Date(),
            actorId,
            message: `Payment ${input.reference} changed: ₹${moneyString(new Decimal(input.amount))}, ${GHI_PAYMENT_STATUS_LABELS[input.status].toLowerCase()}`,
          },
        },
      },
      { session },
    );
    await settle(doc, actorId, session);
    await auditCase(
      actor,
      AUDIT_ACTIONS.GHI_PAYMENT_UPDATED,
      id,
      { paymentId, ...paymentAudit(current) },
      { paymentId, ...paymentAudit(updated) },
      session,
    );
  });
  return listPayments(id);
}

async function placementInputs(doc: GhiCaseDoc) {
  const missing: string[] = [];
  if (!doc.finalQcr) missing.push('Record the final QCR');
  if (stageIndex(doc.stage) < stageIndex('PLACEMENT_SLIP') || doc.stage === 'CLOSED') {
    if (doc.finalQcr) missing.push('Record the premium received (it must cover the final premium)');
  }
  const quote = doc.finalQcr
    ? await GhiQuoteModel.findOne({ _id: doc.finalQcr.quoteId, caseId: doc._id }).lean()
    : null;
  return { missing, quote };
}

export async function placementState(id: string): Promise<GhiPlacementState> {
  const doc = await loadCase(id);
  const { missing, quote } = await placementInputs(doc);
  const [summary, views] = await Promise.all([
    loadSummary(doc),
    quote ? quoteViews(doc, [quote]) : Promise.resolve([]),
  ]);
  return {
    ready: missing.length === 0 && doc.stage !== 'CLOSED',
    missing,
    insurerName: views[0]?.insurerName ?? null,
    finalQuote: views[0] ?? null,
    summary,
  };
}

/** The placement slip from the accepted QCR and the final agreed terms, with the census annexure. */
export async function placementSlipFile(id: string, format: 'xlsx' | 'pdf', actor: Actor) {
  const doc = await loadCase(id);
  const { missing, quote } = await placementInputs(doc);
  if (missing.length > 0 || !quote || !doc.finalQcr) {
    throw conflict(ERROR_CODES.GHI_INCOMPLETE, `The placement slip needs: ${missing.join('; ')}.`, {
      missing,
    });
  }
  const [record, summary, members, [view], payments] = await Promise.all([
    toCaseRecord(doc),
    loadSummary(doc),
    membersForDocuments(doc),
    quoteViews(doc, [quote]),
    GhiPaymentModel.find({ caseId: doc._id, status: 'RECEIVED' }).lean(),
  ]);
  const qcr = await GhiQcrModel.findOne(
    { _id: doc.finalQcr.qcrId, caseId: doc._id },
    { version: 1 },
  ).lean();
  const model = placementSlipDocument(record, view!, qcr?.version ?? 0, summary, members, {
    received: moneyString(
      payments.reduce((total, payment) => total.plus(payment.amount.toString()), new Decimal(0)),
    ),
    references: payments.map((payment) => payment.reference),
  });
  const file =
    format === 'pdf'
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
  await auditCase(actor, AUDIT_ACTIONS.GHI_PLACEMENT_SLIP_DOWNLOADED, id, null, {
    format,
    insurer: view!.insurerName,
    total: view!.totalPremium,
  });
  return file;
}

/**
 * Records the policy the insurer issued (G7), linked to the company, the case, the insurer, the
 * accepted QCR and final quote, and the census as it stands. Correctable; the audit log keeps
 * every version.
 */
export async function recordPolicy(
  id: string,
  input: RecordGhiPolicyRequest,
  actor: Actor,
): Promise<GhiCaseRecord> {
  const doc = await loadCase(id);
  assertOpen(doc);
  const { missing } = await placementInputs(doc);
  if (missing.length > 0 || !doc.finalQcr) {
    throw conflict(ERROR_CODES.GHI_INCOMPLETE, `Before the policy: ${missing.join('; ')}.`, {
      missing,
    });
  }
  if (input.issuedOn > istDay(new Date())) {
    throw validationError([
      { location: 'body', path: 'issuedOn', message: 'The date of issue cannot be in the future' },
    ]);
  }
  const file = await GhiFileModel.exists({
    _id: new Types.ObjectId(input.fileId),
    caseId: doc._id,
    purpose: 'POLICY',
  });
  if (!file) {
    throw validationError([
      { location: 'body', path: 'fileId', message: 'Upload the policy copy to this case first' },
    ]);
  }
  const summary = await loadSummary(doc);
  const actorId = new Types.ObjectId(actor.id);
  const finalQcr = doc.finalQcr;
  const insurerName =
    (await insurerNames([finalQcr.insurerId])).get(finalQcr.insurerId.toHexString()) ?? 'Insurer';
  await withTransaction(async (session) => {
    const now = new Date();
    const result = await GhiCaseModel.updateOne(
      { _id: doc._id, stage: 'PLACEMENT_SLIP' },
      {
        $set: {
          policy: {
            policyNumber: input.policyNumber,
            issuedOn: input.issuedOn,
            policyStart: input.policyStart,
            policyEnd: input.policyEnd,
            renewalDate: input.renewalDate,
            insurerId: finalQcr.insurerId,
            quoteId: finalQcr.quoteId,
            qcrId: finalQcr.qcrId,
            fileId: new Types.ObjectId(input.fileId),
            census: {
              employees: summary.employees,
              lives: summary.lives,
              totalSumInsured: toDecimal128(summary.totalSumInsured ?? '0'),
              revision: summary.revision,
            },
            recordedAt: now,
            recordedBy: actorId,
          },
          updatedBy: actorId,
        },
        $push: {
          activity: {
            at: now,
            actorId,
            message: `${doc.policy ? 'Policy corrected' : 'Placed'}: policy ${input.policyNumber} issued by ${insurerName} on ${formatDate(input.issuedOn)}; renewal due ${formatDate(input.renewalDate)}`,
          },
        },
      },
      { session },
    );
    if (result.modifiedCount === 0)
      throw conflict(ERROR_CODES.CONFLICT, 'The case is not at the Placement Slip stage.');
    await auditCase(
      actor,
      AUDIT_ACTIONS.GHI_POLICY_RECORDED,
      id,
      doc.policy
        ? {
            policyNumber: doc.policy.policyNumber,
            issuedOn: doc.policy.issuedOn,
            renewalDate: doc.policy.renewalDate,
          }
        : null,
      {
        ...input,
        insurer: insurerName,
        employees: summary.employees,
        lives: summary.lives,
        totalSumInsured: summary.totalSumInsured,
      },
      session,
    );
  });
  return toCaseRecord(await loadCase(id));
}
