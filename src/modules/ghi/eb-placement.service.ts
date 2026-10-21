import {
  AUDIT_ACTIONS,
  ERROR_CODES,
  GHI_PAYMENT_STATUS_LABELS,
  PDF_CONTENT_TYPE,
  XLSX_CONTENT_TYPE,
  formatDate,
  paymentsSummary,
  type EbPaymentsResponse,
  type EbPlacementState,
  type GhiCensusSummary,
  type GhiPayment,
  type IssueEbPlacementRequest,
  type RecordEbClientDecisionRequest,
  type SaveEbPaymentRequest,
} from '../../shared/index.ts';
import { Types, type mongo } from 'mongoose';
import { withTransaction } from '../../lib/db.ts';
import { Decimal, moneyString, toDecimal128 } from '../../lib/decimal.ts';
import { conflict, notFound, validationError } from '../../lib/errors.ts';
import { istDay } from '../../lib/ist-day.ts';
import { caseBands } from '../age-bands/case-bands.ts';
import { notifyGhiCaseEvent } from '../notifications/proposal-notifications.ts';
import { toEbCaseRecord } from './eb-cases.service.ts';
import { ebPlacementSlipDocument, type PlacementSlipInput } from './eb-documents.ts';
import { membersForEbDocuments, summaryOf } from './eb-members.service.ts';
import {
  EbPolicySnapshotMemberModel,
  EbPolicySnapshotModel,
  type EbPolicySnapshotDoc,
} from './eb-placement.model.ts';
import { planView } from './eb-plan-view.ts';
import { ebQcrOutOfDate, getEbQcr, latestEbQcr, loadLatestEbQcr } from './eb-qcr.service.ts';
import { GhiCaseModel, type GhiCaseDoc } from './ghi-case.model.ts';
import { GhiMemberModel } from './ghi-census.model.ts';
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
import { assertCaseFiles, fileNames } from './ghi-files.service.ts';
import { caseLetterhead } from './ghi-rfq.service.ts';
import { toPdf, toXlsx } from './ghi-sheet.ts';
import {
  GhiPaymentModel,
  GhiQcrModel,
  GhiQuoteModel,
  type GhiPaymentDoc,
  type GhiQcrDoc,
} from './ghi-workflow.model.ts';
import type { CaseScope } from './products/profile.ts';

// The end of the GPA and GTLI workflow (Requirements 9 to 11): the client's decision within
// Approval (open question 1), the payments against the agreed premium, and the placement slip,
// which places the case and freezes its census and plan in a policy snapshot (design D14).

const money = (value: Types.Decimal128 | null | undefined) =>
  moneyString(new Decimal(value?.toString() ?? '0'));

/** The accepted decision in force: on the latest QCR, approved, accepted (9.2). */
export async function acceptedDecision(caseId: Types.ObjectId, session?: mongo.ClientSession) {
  const qcr = await latestEbQcr(caseId, session);
  if (
    !qcr ||
    qcr.status !== 'APPROVED' ||
    qcr.clientDecision?.decision !== 'ACCEPTED' ||
    !qcr.clientDecision.quoteId ||
    !qcr.clientDecision.agreedPremium
  ) {
    return null;
  }
  return { qcr, decision: qcr.clientDecision };
}

const decisionAudit = (decision: GhiQcrDoc['clientDecision'], insurer: string | null) =>
  decision
    ? {
        decision: decision.decision,
        insurer,
        agreedPremium: decision.agreedPremium ? money(decision.agreedPremium) : null,
        quoteVersion: decision.quoteVersion ?? null,
        decidedOn: decision.decidedOn,
        files: decision.fileIds.length,
      }
    : null;

/**
 * Records the client's decision on the latest approved QCR (Requirement 9). An acceptance sets
 * the agreed premium from the chosen quote version and moves the case to Payment; a rejection
 * returns it to QCR. A decision may be replaced while no payment is RECEIVED; at Payment only by
 * an acceptance (design D10).
 */
export async function recordEbClientDecision(
  scope: CaseScope,
  id: string,
  qcrId: string,
  input: RecordEbClientDecisionRequest,
  actor: Actor,
) {
  const doc = await loadCase(id, undefined, scope);
  assertWritable(doc);
  if (doc.stage !== 'APPROVAL' && doc.stage !== 'PAYMENT') {
    throw conflict(
      ERROR_CODES.EB_STAGE,
      'The client’s decision is recorded on an approved QCR at the Approval stage.',
    );
  }
  const qcr = await loadLatestEbQcr(doc, qcrId);
  if (qcr.status !== 'APPROVED') {
    throw conflict(
      ERROR_CODES.QCR_NOT_APPROVED,
      `QCR v${qcr.version} must be approved before the client’s decision is recorded.`,
    );
  }
  if (await ebQcrOutOfDate(doc, qcr)) {
    throw conflict(
      ERROR_CODES.QCR_NOT_APPROVED,
      `QCR v${qcr.version} is out of date: a compared quote changed. Prepare and approve a new version.`,
    );
  }
  const view = await getEbQcr(doc, qcrId);
  if (view.fingerprint !== input.fingerprint) {
    throw conflict(
      ERROR_CODES.QCR_CHANGED,
      'The QCR changed since you opened it. Reload it and check it again.',
    );
  }
  if (await GhiPaymentModel.exists({ caseId: doc._id, status: 'RECEIVED' })) {
    throw conflict(
      ERROR_CODES.EB_STAGE,
      'A payment has been received against the agreed premium: the client’s decision no longer changes.',
    );
  }
  if (doc.stage === 'PAYMENT' && input.decision === 'REJECTED') {
    throw conflict(
      ERROR_CODES.EB_STAGE,
      'At the Payment stage a decision can only be replaced by an acceptance. Close the case if the client withdraws.',
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
  const column =
    input.decision === 'ACCEPTED'
      ? view.columns.find((item) => item.insurerId === input.insurerId)
      : undefined;
  if (input.decision === 'ACCEPTED' && !column) {
    issues.push({
      location: 'body',
      path: 'insurerId',
      message: 'Choose one of the insurers on the approved QCR',
    });
  }
  if (issues.length > 0) throw validationError(issues);
  const fileIds = await assertCaseFiles(doc._id, input.fileIds, 'CLIENT_DECISION', 'fileIds');
  const actorId = new Types.ObjectId(actor.id);
  const names = await insurerNames(
    [qcr.clientDecision?.insurerId, column ? new Types.ObjectId(column.insurerId) : null].filter(
      (item): item is Types.ObjectId => Boolean(item),
    ),
  );
  const next = {
    decision: input.decision,
    insurerId: column ? new Types.ObjectId(column.insurerId) : null,
    quoteId: column ? new Types.ObjectId(column.quoteId) : null,
    agreedPremium: column ? toDecimal128(column.totalPremium) : null,
    quoteVersion: column ? column.quoteVersion : null,
    decidedOn: input.decidedOn,
    confirmedBy: input.confirmedBy,
    note: input.decision === 'ACCEPTED' ? input.note : input.reason,
    fileIds,
    recordedAt: new Date(),
    recordedBy: actorId,
  };
  await withTransaction(async (session) => {
    const result = await GhiQcrModel.updateOne(
      { _id: qcr._id, status: 'APPROVED' },
      { $set: { clientDecision: next, updatedBy: actorId } },
      { session },
    );
    if (result.matchedCount === 0)
      throw conflict(ERROR_CODES.CONFLICT, 'The QCR changed meanwhile. Reload it.');
    if (await GhiPaymentModel.exists({ caseId: doc._id, status: 'RECEIVED' }).session(session)) {
      throw conflict(
        ERROR_CODES.EB_STAGE,
        'A payment was received meanwhile: the decision no longer changes.',
      );
    }
    await GhiCaseModel.updateOne(
      { _id: doc._id },
      {
        $set: { updatedBy: actorId },
        $push: {
          activity: {
            at: new Date(),
            actorId,
            message:
              input.decision === 'ACCEPTED'
                ? `Client accepted QCR v${qcr.version}: ${column?.insurerName ?? 'insurer'}, agreed premium ₹${column?.totalPremium} (confirmed by ${input.confirmedBy})`
                : `Client rejected QCR v${qcr.version}: ${input.reason}`,
          },
        },
      },
      { session },
    );
    if (input.decision === 'ACCEPTED') await advanceStage(doc._id, 'PAYMENT', actorId, session);
    else await returnToStage(doc._id, 'QCR', ['APPROVAL'], actorId, session);
    await auditCase(
      actor,
      AUDIT_ACTIONS.GHI_CLIENT_DECISION_RECORDED,
      id,
      decisionAudit(
        qcr.clientDecision,
        qcr.clientDecision?.insurerId
          ? (names.get(qcr.clientDecision.insurerId.toHexString()) ?? null)
          : null,
      ),
      {
        version: qcr.version,
        ...decisionAudit(next, column?.insurerName ?? null),
        confirmedBy: input.confirmedBy,
      },
      session,
      scope,
    );
  });
  return getEbQcr(await loadCase(id, undefined, scope), qcrId);
}

// Payments (Requirement 10)

function toPayment(
  doc: GhiPaymentDoc,
  names: ReadonlyMap<string, string>,
  files: ReadonlyMap<string, string>,
): GhiPayment {
  return {
    id: doc._id.toHexString(),
    amount: money(doc.amount),
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

async function agreedPremium(
  doc: GhiCaseDoc,
  session?: mongo.ClientSession,
): Promise<string | null> {
  const accepted = await acceptedDecision(doc._id, session);
  return accepted ? money(accepted.decision.agreedPremium) : null;
}

export async function listEbPayments(scope: CaseScope, id: string): Promise<EbPaymentsResponse> {
  const doc = await loadCase(id, undefined, scope);
  const payments = await GhiPaymentModel.find({ caseId: doc._id })
    .sort({ paidOn: 1, _id: 1 })
    .lean();
  const [names, files, agreed] = await Promise.all([
    userNames(payments.flatMap((payment) => [payment.createdBy, payment.updatedBy])),
    fileNames(payments.flatMap((payment) => payment.fileIds)),
    agreedPremium(doc),
  ]);
  const summary = paymentsSummary(
    agreed,
    payments.map((payment) => ({ amount: payment.amount.toString(), status: payment.status })),
  );
  return {
    agreedPremium: agreed,
    ...summary,
    items: payments.map((payment) => toPayment(payment, names, files)),
  };
}

async function checkPayment(doc: GhiCaseDoc, input: SaveEbPaymentRequest) {
  assertWritable(doc);
  if (!(await acceptedDecision(doc._id))) {
    throw conflict(
      ERROR_CODES.EB_STAGE,
      'Record the client’s acceptance of the approved QCR first: payments are against the agreed premium.',
    );
  }
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

/** Moves the case to Placement Slip once RECEIVED payments cover the agreed premium (10.2). */
async function settle(doc: GhiCaseDoc, actorId: Types.ObjectId, session: mongo.ClientSession) {
  const [payments, agreed] = await Promise.all([
    GhiPaymentModel.find({ caseId: doc._id }, { amount: 1, status: 1 }).session(session).lean(),
    agreedPremium(doc, session),
  ]);
  const summary = paymentsSummary(
    agreed,
    payments.map((payment) => ({ amount: payment.amount.toString(), status: payment.status })),
  );
  if (summary.covered) await advanceStage(doc._id, 'PLACEMENT_SLIP', actorId, session);
}

const paymentAudit = (
  payment: Pick<
    GhiPaymentDoc,
    'amount' | 'paidOn' | 'reference' | 'mode' | 'status' | 'payer' | 'note'
  >,
) => ({
  amount: money(payment.amount),
  paidOn: payment.paidOn,
  reference: payment.reference,
  mode: payment.mode,
  status: payment.status,
  payer: payment.payer,
  note: payment.note,
});

export async function addEbPayment(
  scope: CaseScope,
  id: string,
  input: SaveEbPaymentRequest,
  actor: Actor,
) {
  const doc = await loadCase(id, undefined, scope);
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
      { _id: doc._id, placement: { $in: [null] } },
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
      scope,
    );
  });
  // A4: after the EB payment commits, tell the case owner and creator.
  await notifyGhiCaseEvent({
    caseId: id,
    event: 'PAYMENT_RECORDED',
    actorId: actor.id,
    title: 'Payment recorded',
    message: `A payment of ₹${moneyString(new Decimal(input.amount))} was recorded (${input.reference}).`,
    milestone: `payment-recorded:${id}:${input.reference}:${input.paidOn}`,
  });
  return listEbPayments(scope, id);
}

export async function updateEbPayment(
  scope: CaseScope,
  id: string,
  paymentId: string,
  input: SaveEbPaymentRequest,
  actor: Actor,
) {
  const doc = await loadCase(id, undefined, scope);
  const current = await GhiPaymentModel.findOne({
    _id: new Types.ObjectId(paymentId),
    caseId: doc._id,
  }).lean();
  if (!current) throw notFound('Payment not found');
  const fileIds = await checkPayment(doc, input);
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
      scope,
    );
  });
  return listEbPayments(scope, id);
}

// Placement (Requirement 11)

interface PlacementInputs {
  missing: string[];
  accepted: Awaited<ReturnType<typeof acceptedDecision>>;
  received: GhiPaymentDoc[];
  agreed: string | null;
}

async function placementInputs(
  doc: GhiCaseDoc,
  session?: mongo.ClientSession,
): Promise<PlacementInputs> {
  const accepted = await acceptedDecision(doc._id, session);
  const payments = await GhiPaymentModel.find({ caseId: doc._id })
    .session(session ?? null)
    .lean();
  const agreed = accepted ? money(accepted.decision.agreedPremium) : null;
  const summary = paymentsSummary(
    agreed,
    payments.map((payment) => ({ amount: payment.amount.toString(), status: payment.status })),
  );
  const missing: string[] = [];
  if (!accepted)
    missing.push(
      'Record the client’s acceptance of the approved QCR (chosen insurer and agreed premium)',
    );
  else if (!summary.covered) {
    missing.push(
      `Record the premium received: ₹${summary.outstanding} of the agreed ₹${agreed} is outstanding`,
    );
  }
  if (doc.stage === 'CLOSED') missing.push('The case is closed');
  return {
    missing,
    accepted,
    received: payments.filter((payment) => payment.status === 'RECEIVED'),
    agreed,
  };
}

function snapshotSummary(snapshot: EbPolicySnapshotDoc, live: GhiCensusSummary): GhiCensusSummary {
  return {
    ...live,
    employees: snapshot.census.employees,
    lives: snapshot.census.lives,
    byRelationship: snapshot.census.byRelationship,
    totalSumInsured: new Decimal(snapshot.census.totalSumInsured.toString()).toFixed(0),
    revision: snapshot.census.revision,
  };
}

export async function ebPlacementState(scope: CaseScope, id: string): Promise<EbPlacementState> {
  const doc = await loadCase(id, undefined, scope);
  const summary = await summaryOf(doc);
  if (doc.placement) {
    const snapshot = await EbPolicySnapshotModel.findOne({
      caseId: doc._id,
    }).lean<EbPolicySnapshotDoc>();
    if (snapshot) {
      const [insurers, names] = await Promise.all([
        insurerNames([snapshot.insurerId]),
        userNames([snapshot.issuedBy]),
      ]);
      return {
        ready: false,
        placed: true,
        missing: [],
        insurerName: insurers.get(snapshot.insurerId.toHexString()) ?? 'Insurer',
        quoteVersion: snapshot.quoteVersion,
        basePremium: money(snapshot.basePremium),
        gst: money(snapshot.gst),
        agreedPremium: money(snapshot.agreedTotal),
        receivedPayments: snapshot.receivedPayments.map((payment) => ({
          amount: money(payment.amount),
          paidOn: payment.paidOn,
          reference: payment.reference,
        })),
        plan: await planView(
          {
            ...snapshot.plan,
            effectiveFrom: doc.planAssignment?.effectiveFrom ?? '2000-01-01',
            openQuestions: doc.planAssignment?.openQuestions ?? [],
            source: doc.planAssignment?.source ?? 'USER',
            assignedAt: doc.planAssignment?.assignedAt ?? snapshot.issuedAt,
            assignedBy: doc.planAssignment?.assignedBy ?? null,
          },
          scope.product,
        ),
        summary: snapshotSummary(snapshot, summary),
        policyNumber: snapshot.policyNumber,
        policyStart: snapshot.policyStart,
        policyEnd: snapshot.policyEnd,
        issuedAt: snapshot.issuedAt.toISOString(),
        issuedBy: nameOf(names, snapshot.issuedBy),
      };
    }
  }
  const inputs = await placementInputs(doc);
  const quote = inputs.accepted
    ? await GhiQuoteModel.findOne({ _id: inputs.accepted.decision.quoteId, caseId: doc._id }).lean()
    : null;
  const insurers = quote ? await insurerNames([quote.insurerId]) : new Map<string, string>();
  return {
    ready: inputs.missing.length === 0 && doc.stage === 'PLACEMENT_SLIP',
    placed: false,
    missing: inputs.missing,
    insurerName: quote ? (insurers.get(quote.insurerId.toHexString()) ?? 'Insurer') : null,
    quoteVersion: quote?.version ?? null,
    basePremium: quote ? money(quote.basePremium) : null,
    gst: quote ? money(quote.gst) : null,
    agreedPremium: inputs.agreed,
    receivedPayments: inputs.received.map((payment) => ({
      amount: money(payment.amount),
      paidOn: payment.paidOn,
      reference: payment.reference,
    })),
    plan: await planView(doc.planAssignment, scope.product),
    summary,
    policyNumber: null,
    policyStart: null,
    policyEnd: null,
    issuedAt: null,
    issuedBy: null,
  };
}

/** The placement slip as Excel or A4 PDF (11.1): from the snapshot once placed (11.6 audited). */
export async function ebPlacementSlipFile(
  scope: CaseScope,
  id: string,
  format: 'xlsx' | 'pdf',
  actor: Actor,
) {
  const doc = await loadCase(id, undefined, scope);
  const state = await ebPlacementState(scope, id);
  if (!state.placed && state.missing.length > 0) {
    throw conflict(ERROR_CODES.EB_STAGE, `The placement slip needs: ${state.missing.join('; ')}.`, {
      missing: state.missing,
    });
  }
  const accepted = await acceptedDecision(doc._id);
  const record = await toEbCaseRecord(doc);
  const members = doc.placement
    ? (
        await EbPolicySnapshotMemberModel.find({ caseId: doc._id })
          .sort({ employeeKey: 1, _id: 1 })
          .lean()
      ).map((member) => ({
        id: member.memberId.toHexString(),
        employeeId: member.employeeId,
        name: member.name,
        gender: member.gender,
        dateOfBirth: member.dateOfBirth,
        relationship: member.relationship,
        dateOfJoining: member.dateOfJoining,
        sumInsured: member.sumInsured?.toString() ?? null,
        annualSalary: member.annualSalary?.toString() ?? null,
        monthlySalary: member.monthlySalary?.toString() ?? null,
        nominee: member.nominee ?? null,
        coveredSumInsured: member.coveredSumInsured?.toString() ?? null,
        coverageBasis: member.coverageBasis ?? null,
        age: 0,
        source: 'IMPORT' as const,
        employeeIdentityId: member.employeeIdentityId?.toHexString() ?? null,
        updatedAt: new Date().toISOString(),
      }))
    : await membersForEbDocuments(doc);
  const qcr = accepted?.qcr ?? (await latestEbQcr(doc._id));
  const input: PlacementSlipInput = {
    insurerName: state.insurerName ?? 'Insurer',
    quoteVersion: state.quoteVersion ?? 0,
    qcrVersion: qcr?.version ?? 0,
    basePremium: state.basePremium ?? '0.00',
    gstRatePercent: new Decimal(doc.gstRatePercent.toString()).toFixed(),
    gst: state.gst ?? '0.00',
    agreedPremium: state.agreedPremium ?? '0.00',
    receivedPayments: state.receivedPayments,
    plan: state.plan,
    byRelationship: state.summary.byRelationship,
    employees: state.summary.employees,
    lives: state.summary.lives,
    totalSumInsured: state.summary.totalSumInsured,
    policyNumber: state.policyNumber,
    policyStart: state.policyStart,
    policyEnd: state.policyEnd,
    placed: state.placed,
  };
  const model = ebPlacementSlipDocument(record, input, state.summary, members);
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
  await auditCase(
    actor,
    AUDIT_ACTIONS.EB_PLACEMENT_SLIP_DOWNLOADED,
    id,
    null,
    { format, insurer: state.insurerName, quoteVersion: state.quoteVersion, placed: state.placed },
    undefined,
    scope,
  );
  return file;
}

/**
 * Issues the placement slip (11.2, 11.3): in one transaction the case is placed and its policy
 * snapshot stored (census at the current revision, plan version and slots, agreed quote and
 * received payments). The unique index on the snapshot refuses a second issue (11.4).
 */
export async function issueEbPlacement(
  scope: CaseScope,
  id: string,
  input: IssueEbPlacementRequest,
  actor: Actor,
) {
  const doc = await loadCase(id, undefined, scope);
  assertWritable(doc);
  const inputs = await placementInputs(doc);
  if (inputs.missing.length > 0 || !inputs.accepted) {
    throw conflict(
      ERROR_CODES.EB_STAGE,
      `Before the placement slip: ${inputs.missing.join('; ')}.`,
      {
        missing: inputs.missing,
      },
    );
  }
  if (stageIndex(doc.stage) < stageIndex('PLACEMENT_SLIP')) {
    throw conflict(ERROR_CODES.EB_STAGE, 'The case has not reached the Placement Slip stage.');
  }
  if (!doc.planAssignment)
    throw conflict(ERROR_CODES.EB_PLAN_REQUIRED, 'The case has no family plan.');
  const plan = doc.planAssignment;
  const accepted = inputs.accepted;
  const actorId = new Types.ObjectId(actor.id);
  const summary = await summaryOf(doc);
  const members = await membersForEbDocuments(doc);
  const quote = await GhiQuoteModel.findOne({
    _id: accepted.decision.quoteId,
    caseId: doc._id,
  }).lean();
  if (!quote) throw conflict(ERROR_CODES.EB_STAGE, 'The agreed quote is missing.');
  const insurer =
    (await insurerNames([quote.insurerId])).get(quote.insurerId.toHexString()) ?? 'Insurer';
  await withTransaction(async (session) => {
    const now = new Date();
    const [snapshot] = await EbPolicySnapshotModel.create(
      [
        {
          caseId: doc._id,
          product: scope.product as 'GPA' | 'GTLI',
          insurerId: quote.insurerId,
          qcrId: accepted.qcr._id,
          quoteId: quote._id,
          quoteVersion: quote.version,
          basePremium: quote.basePremium ?? toDecimal128('0'),
          gst: quote.gst ?? toDecimal128('0'),
          agreedTotal: accepted.decision.agreedPremium!,
          plan: {
            planId: plan.planId,
            code: plan.code,
            name: plan.name,
            versionNumber: plan.versionNumber,
            slots: plan.slots,
            parentsAndInLawsMixed: plan.parentsAndInLawsMixed,
          },
          census: {
            revision: doc.censusRevision,
            employees: summary.employees,
            lives: summary.lives,
            byRelationship: summary.byRelationship,
            totalSumInsured: toDecimal128(summary.totalSumInsured ?? '0'),
          },
          receivedPayments: inputs.received.map((payment) => ({
            paymentId: payment._id,
            amount: payment.amount,
            paidOn: payment.paidOn,
            reference: payment.reference,
          })),
          policyNumber: input.policyNumber,
          policyStart: input.policyStart,
          policyEnd: input.policyEnd,
          issuedAt: now,
          issuedBy: actorId,
          // N4 to N6: the rules the cover was worked out by, and the age bands, as placed.
          requirements: structuredClone(doc.requirements),
          ageBands: (() => {
            const bands = caseBands(doc);
            return {
              setId: bands.setId ? new Types.ObjectId(bands.setId) : null,
              name: bands.name,
              revision: bands.revision ?? 0,
              bands: bands.bands,
            };
          })(),
        },
      ],
      { session },
    );
    if (!snapshot) throw new Error('Policy snapshot was not saved');
    const stored = await GhiMemberModel.find({ caseId: doc._id }).session(session).lean();
    const covered = new Map(members.map((member) => [member.id, member.coveredSumInsured]));
    const basis = new Map(members.map((member) => [member.id, member.coverageBasis]));
    if (stored.length > 0) {
      await EbPolicySnapshotMemberModel.insertMany(
        stored.map((member) => ({
          snapshotId: snapshot._id,
          caseId: doc._id,
          memberId: member._id,
          employeeId: member.employeeId,
          employeeKey: member.employeeKey,
          name: member.name,
          gender: member.gender,
          dateOfBirth: member.dateOfBirth,
          relationship: member.relationship,
          dateOfJoining: member.dateOfJoining,
          sumInsured: member.sumInsured,
          annualSalary: member.annualSalary ?? null,
          coveredSumInsured: covered.get(member._id.toHexString())
            ? toDecimal128(covered.get(member._id.toHexString())!)
            : null,
          employeeIdentityId: member.employeeIdentityId ?? null,
          // N5, N6: the salary, nominee and how the cover was worked out, as placed.
          monthlySalary: member.monthlySalary ?? null,
          nominee: member.nominee ?? null,
          coverageBasis: basis.get(member._id.toHexString()) ?? null,
        })),
        { session },
      );
    }
    const result = await GhiCaseModel.updateOne(
      {
        _id: doc._id,
        stage: 'PLACEMENT_SLIP',
        placement: { $in: [null] },
        censusRevision: doc.censusRevision,
      },
      {
        $set: {
          placement: {
            snapshotId: snapshot._id,
            issuedAt: now,
            issuedBy: actorId,
            policyNumber: input.policyNumber,
            policyStart: input.policyStart,
            policyEnd: input.policyEnd,
          },
          updatedBy: actorId,
        },
        $push: {
          activity: {
            at: now,
            actorId,
            message: `Placed: placement slip issued to ${insurer}${input.policyNumber ? ` (policy ${input.policyNumber})` : ''}`,
          },
        },
      },
      { session },
    );
    if (result.modifiedCount === 0) {
      throw conflict(
        ERROR_CODES.CONFLICT,
        'The case changed meanwhile (or is already placed). Reload it.',
      );
    }
    await auditCase(
      actor,
      AUDIT_ACTIONS.EB_PLACEMENT_ISSUED,
      id,
      null,
      {
        snapshotId: snapshot._id.toHexString(),
        insurer,
        quoteVersion: quote.version,
        agreedTotal: money(accepted.decision.agreedPremium),
        plan: plan.code,
        planVersion: plan.versionNumber,
        censusRevision: doc.censusRevision,
        employees: summary.employees,
        lives: summary.lives,
        totalSumInsured: summary.totalSumInsured,
        policyNumber: input.policyNumber,
        policyStart: input.policyStart,
        policyEnd: input.policyEnd,
      },
      session,
      scope,
    );
  });
  return toEbCaseRecord(await loadCase(id, undefined, scope));
}
