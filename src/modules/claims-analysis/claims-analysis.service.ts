import {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  CLAIMS_ANALYSIS_AGE_BANDS,
  ERROR_CODES,
  GHI_RELATIONSHIP_LABELS,
  OUTSTANDING_BASIS_LABELS,
  TPA_CLAIM_STATUS_LABELS,
  TPA_REQUEST_TYPE_LABELS,
  UNCLASSIFIED_CHAPTER,
  analyseClaims,
  bucketOf,
  completedAge,
  fromPaise,
  icdChapterOf,
  paidAndOutstanding,
  type AgeBand,
  type AnalysisClaim,
  type ClaimsAnalysisDetail,
  type ClaimsAnalysisQuery,
  type ClaimsAnalysisResponse,
  type PremiumAdjustmentInput,
} from '../../shared/index.ts';
import { Types } from 'mongoose';
import { withTransaction } from '../../lib/db.ts';
import { Decimal, toDecimal128 } from '../../lib/decimal.ts';
import { conflict, notFound, validationError } from '../../lib/errors.ts';
import { istDay } from '../../lib/ist-day.ts';
import { escapeRegExp } from '../../lib/text.ts';
import { AgeBandSetModel } from '../age-bands/age-band-set.model.ts';
import { writeAudit } from '../audit/audit.service.ts';
import { ClaimModel } from '../claims/claim.model.ts';
import { GhiMemberModel } from '../ghi/ghi-census.model.ts';
import { nameOf, userNames, type Actor } from '../ghi/ghi-common.ts';
import {
  loadInsuredPolicy,
  type InsuredPolicy,
} from '../insured-policies/insured-policies.service.ts';
import { PremiumAdjustmentModel, TpaClaimModel, type TpaClaimDoc } from '../tpa/tpa.model.ts';

// The claims analysis (N10) of one placed policy, from its imported TPA claims, its census and its
// premium (as placed, with recorded additions and deletions). The figures come from the shared
// analyseClaims, so the screen and both files are the same. Diagnosis details only for users who
// process claims; the ICD chapter is aggregate and shown to every claims viewer.

const amount = (value: Types.Decimal128 | null) =>
  value === null ? null : new Decimal(value.toString()).toFixed(2);

// Premium additions and deletions

export async function premiumAdjustments(caseId: string) {
  const { doc, policy } = await loadInsuredPolicy(caseId);
  const items = await PremiumAdjustmentModel.find({ caseId: doc._id })
    .sort({ effectiveDate: 1, _id: 1 })
    .lean();
  const names = await userNames(items.map((item) => item.createdBy));
  return {
    basePremium: policy.basePremium,
    gst: policy.gst,
    policyStart: policy.policyStart,
    policyEnd: policy.policyEnd,
    items: items.map((item) => ({
      id: item._id.toHexString(),
      kind: item.kind,
      amount: new Decimal(item.amount.toString()).toFixed(2),
      effectiveDate: item.effectiveDate,
      reference: item.reference,
      note: item.note,
      voided: item.voided,
      createdAt: item.createdAt.toISOString(),
      createdBy: nameOf(names, item.createdBy),
    })),
  };
}

export async function addPremiumAdjustment(
  caseId: string,
  input: PremiumAdjustmentInput,
  actor: Actor,
) {
  const { doc, policy } = await loadInsuredPolicy(caseId);
  if (input.effectiveDate < policy.policyStart || input.effectiveDate > policy.policyEnd) {
    throw validationError([
      {
        location: 'body',
        path: 'effectiveDate',
        message: `The date must be within the policy period (${policy.policyStart} to ${policy.policyEnd})`,
      },
    ]);
  }
  await withTransaction(async (session) => {
    const [created] = await PremiumAdjustmentModel.create(
      [
        {
          caseId: doc._id,
          ...input,
          amount: toDecimal128(input.amount),
          voided: false,
          createdBy: new Types.ObjectId(actor.id),
        },
      ],
      { session },
    );
    await writeAudit(
      {
        userId: actor.id,
        action: AUDIT_ACTIONS.PREMIUM_ADJUSTMENT_RECORDED,
        entity: AUDIT_ENTITIES.INSURED_POLICY,
        entityId: caseId,
        before: null,
        after: { id: created!._id.toHexString(), ...input },
        requestId: actor.requestId,
      },
      session,
    );
  });
  return premiumAdjustments(caseId);
}

export async function voidPremiumAdjustment(caseId: string, adjustmentId: string, actor: Actor) {
  const { doc } = await loadInsuredPolicy(caseId);
  const item = await PremiumAdjustmentModel.findOne({ _id: adjustmentId, caseId: doc._id }).lean();
  if (!item) throw notFound('Premium addition or deletion not found');
  if (item.voided) throw conflict(ERROR_CODES.CONFLICT, 'It is already voided.');
  await withTransaction(async (session) => {
    await PremiumAdjustmentModel.updateOne(
      { _id: item._id, voided: false },
      { $set: { voided: true, voidedAt: new Date(), voidedBy: new Types.ObjectId(actor.id) } },
      { session },
    );
    await writeAudit(
      {
        userId: actor.id,
        action: AUDIT_ACTIONS.PREMIUM_ADJUSTMENT_VOIDED,
        entity: AUDIT_ENTITIES.INSURED_POLICY,
        entityId: caseId,
        before: { id: adjustmentId, voided: false },
        after: { id: adjustmentId, voided: true },
        requestId: actor.requestId,
      },
      session,
    );
  });
  return premiumAdjustments(caseId);
}

// The analysis

async function bandsFor(setId: string | undefined): Promise<{ name: string; bands: AgeBand[] }> {
  const set = setId
    ? await AgeBandSetModel.findById(setId).lean()
    : await AgeBandSetModel.findOne({ seedKey: 'CLAIMS_ANALYSIS' }).lean();
  if (setId && !set)
    throw validationError([
      { location: 'query', path: 'ageBandSetId', message: 'Age band set not found' },
    ]);
  if (!set)
    return { name: 'Claims analysis: 0–10 to Above 70', bands: [...CLAIMS_ANALYSIS_AGE_BANDS] };
  return {
    name: set.name,
    bands: set.bands.map((band) => ({ label: band.label, min: band.min, max: band.max })),
  };
}

interface Prepared {
  doc: TpaClaimDoc;
  claim: AnalysisClaim;
  employeeId: string | null;
  patientName: string | null;
  dateOfBirth: string | null;
}

/** The policy's TPA claims with the census member's own relationship, gender and age. */
async function prepare(
  caseId: Types.ObjectId,
  query: ClaimsAnalysisQuery,
  period: { from: string; to: string; explicit: boolean },
) {
  const filter: Record<string, unknown> = { caseId };
  if (period.explicit) filter.admissionDate = { $gte: period.from, $lte: period.to };
  const docs = await TpaClaimModel.find(filter)
    .sort({ admissionDate: 1, _id: 1 })
    .lean<TpaClaimDoc[]>();
  const members = new Map(
    (
      await GhiMemberModel.find(
        { _id: { $in: docs.flatMap((doc) => (doc.member.memberId ? [doc.member.memberId] : [])) } },
        { relationship: 1, gender: 1, dateOfBirth: 1, employeeId: 1, name: 1 },
      ).lean()
    ).map((member) => [member._id.toHexString(), member]),
  );
  const prepared: Prepared[] = docs.map((doc) => {
    const member = doc.member.memberId ? members.get(doc.member.memberId.toHexString()) : undefined;
    const dateOfBirth = member?.dateOfBirth ?? doc.dateOfBirth;
    const ageOn = doc.admissionDate ?? period.to;
    const age = dateOfBirth ? completedAge(dateOfBirth, ageOn) : doc.age;
    return {
      doc,
      employeeId: member?.employeeId ?? doc.employeeId,
      patientName: member?.name ?? doc.memberName,
      dateOfBirth,
      claim: {
        id: doc._id.toHexString(),
        status: doc.status,
        requestType: doc.requestType,
        parentLinked: doc.parent.id !== null,
        sourceStatus: doc.sourceStatus,
        claimType: doc.claimType,
        relationship: member?.relationship ?? doc.relationship,
        gender: member?.gender ?? doc.gender,
        age,
        icdChapter: icdChapterOf(doc.icdCode)?.key ?? UNCLASSIFIED_CHAPTER.key,
        claimedAmount: amount(doc.claimedAmount),
        sanctionedAmount: amount(doc.sanctionedAmount),
        settledAmount: amount(doc.settledAmount),
        disallowedAmount: amount(doc.disallowedAmount),
      },
    };
  });
  const q = query.q ? new RegExp(escapeRegExp(query.q), 'i') : null;
  return prepared.filter(({ claim, doc, employeeId, patientName }) => {
    if (query.status && bucketOf(claim) !== query.status) return false;
    if (query.claimType && claim.claimType !== query.claimType) return false;
    if (query.requestType && claim.requestType !== query.requestType) return false;
    if (query.relationship && claim.relationship !== query.relationship) return false;
    if (query.member === 'MAIN' && claim.relationship !== 'SELF') return false;
    if (
      query.member === 'DEPENDANT' &&
      (claim.relationship === null || claim.relationship === 'SELF')
    )
      return false;
    if (q && !q.test(doc.tpaClaimId) && !q.test(employeeId ?? '') && !q.test(patientName ?? ''))
      return false;
    return true;
  });
}

function detailOf(
  item: Prepared,
  query: ClaimsAnalysisQuery,
  diagnosisVisible: boolean,
): ClaimsAnalysisDetail {
  const { paid, outstanding } = paidAndOutstanding(item.claim, query.outstandingBasis);
  return {
    id: item.claim.id,
    tpaClaimId: item.doc.tpaClaimId,
    requestType: item.claim.requestType,
    bucket: bucketOf(item.claim),
    sourceStatus: item.claim.sourceStatus,
    employeeId: item.employeeId,
    patientName: item.patientName,
    relationship: item.claim.relationship,
    gender: item.claim.gender,
    age: item.claim.age,
    admissionDate: item.doc.admissionDate,
    dischargeDate: item.doc.dischargeDate,
    claimType: item.claim.claimType,
    hospital: item.doc.hospital,
    claimedAmount: item.claim.claimedAmount,
    paid: fromPaise(paid),
    outstanding: fromPaise(outstanding),
    icdChapter: item.claim.icdChapter,
    icdCode: diagnosisVisible ? item.doc.icdCode : null,
    diagnosis: diagnosisVisible ? item.doc.diagnosis : null,
  };
}

function filterLabels(query: ClaimsAnalysisQuery): Array<{ label: string; value: string }> {
  const filters: Array<{ label: string; value: string }> = [];
  if (query.status) filters.push({ label: 'Status', value: TPA_CLAIM_STATUS_LABELS[query.status] });
  if (query.claimType)
    filters.push({
      label: 'Claim type',
      value: query.claimType === 'CASHLESS' ? 'Cashless' : 'Reimbursement',
    });
  if (query.requestType)
    filters.push({ label: 'Request type', value: TPA_REQUEST_TYPE_LABELS[query.requestType] });
  if (query.member)
    filters.push({
      label: 'Members',
      value: query.member === 'MAIN' ? 'Main members' : 'Dependants',
    });
  if (query.relationship)
    filters.push({ label: 'Relationship', value: GHI_RELATIONSHIP_LABELS[query.relationship] });
  if (query.q) filters.push({ label: 'Search', value: query.q });
  filters.push({
    label: 'Outstanding claims reserved at',
    value: OUTSTANDING_BASIS_LABELS[query.outstandingBasis],
  });
  return filters;
}

export async function claimsAnalysis(
  query: ClaimsAnalysisQuery,
  options: { diagnosisVisible: boolean; allDetails?: boolean },
): Promise<ClaimsAnalysisResponse & { policy: InsuredPolicy }> {
  const { doc, policy } = await loadInsuredPolicy(query.caseId);
  const from = query.from ?? policy.policyStart;
  const to = query.to ?? policy.policyEnd;
  if (to < from)
    throw validationError([
      { location: 'query', path: 'to', message: 'The period ends before it starts' },
    ]);
  const today = istDay(new Date());
  const asOf = query.asOf ?? (today < policy.policyEnd ? today : policy.policyEnd);
  const bands = await bandsFor(query.ageBandSetId);
  const prepared = await prepare(doc._id, query, {
    from,
    to,
    explicit: query.from !== undefined || query.to !== undefined,
  });
  const adjustments = await PremiumAdjustmentModel.find({ caseId: doc._id, voided: false }).lean();
  const analysis = analyseClaims({
    claims: prepared.map((item) => item.claim),
    bands: bands.bands,
    premium: {
      basePremium: policy.basePremium,
      policyStart: policy.policyStart,
      policyEnd: policy.policyEnd,
      adjustments: adjustments.map((item) => ({
        kind: item.kind,
        amount: new Decimal(item.amount.toString()).toFixed(2),
        effectiveDate: item.effectiveDate,
      })),
    },
    asOf,
    outstandingBasis: query.outstandingBasis,
  });
  const linkedBoards = await TpaClaimModel.distinct('board.claimId', {
    caseId: doc._id,
    'board.claimId': { $ne: null },
  });
  const unreportedBoardClaims = await ClaimModel.countDocuments({
    ghiCaseId: doc._id,
    _id: { $nin: linkedBoards },
  });
  const sorted = [...prepared].sort((a, b) =>
    (b.doc.admissionDate ?? '').localeCompare(a.doc.admissionDate ?? ''),
  );
  const page = options.allDetails
    ? sorted
    : sorted.slice((query.page - 1) * query.limit, query.page * query.limit);
  return {
    policy,
    header: {
      company: policy.clientName,
      caseId: policy.caseId,
      reference: policy.reference,
      product: policy.product,
      policyNumber: policy.policyNumber,
      insurerName: policy.insurerName,
      policyStart: policy.policyStart,
      policyEnd: policy.policyEnd,
      from,
      to,
      asOf,
      ageBands: bands,
      filters: filterLabels(query),
      generatedAt: new Date().toISOString(),
      diagnosisVisible: options.diagnosisVisible,
      unreportedBoardClaims,
    },
    analysis,
    details: {
      items: page.map((item) => detailOf(item, query, options.diagnosisVisible)),
      total: sorted.length,
      page: options.allDetails ? 1 : query.page,
      limit: options.allDetails ? sorted.length : query.limit,
    },
  };
}
