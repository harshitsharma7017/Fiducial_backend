import { z } from 'zod';
import { AgeBandSchema, bandIndexOf, type AgeBand } from './age-bands.ts';
import { IsoDateTimeSchema, ObjectIdSchema } from './common.ts';
import { EbProductSchema } from './eb-products.ts';
import { GHI_GENDERS, GHI_RELATIONSHIPS, type GhiRelationship } from './ghi-census.ts';
import { ICD10_CHAPTERS, ICD_VERSION, UNCLASSIFIED_CHAPTER } from './icd.ts';
import {
  TPA_CLAIM_STATUSES,
  TpaClaimStatusSchema,
  TpaClaimTypeSchema,
  TpaRequestTypeSchema,
  type TpaClaimStatus,
  type TpaClaimType,
  type TpaRequestType,
} from './tpa-claims.ts';

// The claims analysis (N10) and the premium it is measured against, pure so the API, the
// documents and the tests compute exactly the same figures. Amounts are rupees with paise as text,
// computed in BigInt paise; percentages are rounded half up to 2 decimals.

// Money in paise

export const toPaise = (amount: string | null | undefined): bigint => {
  if (amount === null || amount === undefined || amount === '') return 0n;
  const [whole = '0', fraction = ''] = amount.split('.');
  return BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
};
export const fromPaise = (paise: bigint): string => {
  const sign = paise < 0n ? '-' : '';
  const value = paise < 0n ? -paise : paise;
  return `${sign}${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
};
/** n / d rounded half up (both non-negative; d > 0). */
const halfUp = (n: bigint, d: bigint) => (n * 2n + d) / (2n * d);
/** a / b × 100 to 2 decimals, half up; null when b is 0. */
export function percentOf(numerator: bigint, denominator: bigint): string | null {
  if (denominator <= 0n) return null;
  const negative = numerator < 0n;
  const hundredths = halfUp((negative ? -numerator : numerator) * 10_000n, denominator);
  return `${negative ? '-' : ''}${hundredths / 100n}.${String(hundredths % 100n).padStart(2, '0')}`;
}

// Status classification, defined once (N10 A, F)

/**
 * How a TPA record counts. A pre-authorisation linked to its main claim is NOT_COUNTED (the main
 * claim carries the claim); every other record is in exactly one of the four statuses.
 */
export type ClaimBucket = TpaClaimStatus | 'NOT_COUNTED';

export interface BucketInput {
  status: TpaClaimStatus;
  requestType: TpaRequestType;
  /** A pre-authorisation whose main claim is linked. */
  parentLinked: boolean;
}

export function bucketOf(claim: BucketInput): ClaimBucket {
  if (claim.requestType === 'PRE_AUTH' && claim.parentLinked) return 'NOT_COUNTED';
  return claim.status;
}

/** How an outstanding claim is reserved (open question ICR-2). */
export const OUTSTANDING_BASES = ['SANCTIONED_ELSE_CLAIMED', 'CLAIMED'] as const;
export type OutstandingBasis = (typeof OUTSTANDING_BASES)[number];
export const OUTSTANDING_BASIS_LABELS: Record<OutstandingBasis, string> = {
  SANCTIONED_ELSE_CLAIMED: 'The sanctioned amount, else the claimed amount',
  CLAIMED: 'The claimed amount',
};

export interface AmountInput {
  claimedAmount: string | null;
  sanctionedAmount: string | null;
  settledAmount: string | null;
  disallowedAmount: string | null;
}

/** Paid and outstanding of one record (N10 F): a claim is paid, outstanding or neither. */
export function paidAndOutstanding(
  claim: BucketInput & AmountInput,
  basis: OutstandingBasis,
): { paid: bigint; outstanding: bigint } {
  const bucket = bucketOf(claim);
  if (bucket === 'SETTLED') return { paid: toPaise(claim.settledAmount), outstanding: 0n };
  if (bucket !== 'OUTSTANDING') return { paid: 0n, outstanding: 0n };
  const sanctioned = toPaise(claim.sanctionedAmount);
  const reserve =
    basis === 'SANCTIONED_ELSE_CLAIMED' && sanctioned > 0n
      ? sanctioned
      : toPaise(claim.claimedAmount);
  return { paid: 0n, outstanding: reserve };
}

// Premium (N10 F)

export const PREMIUM_ADJUSTMENT_KINDS = ['ADDITION', 'DELETION'] as const;
export type PremiumAdjustmentKind = (typeof PREMIUM_ADJUSTMENT_KINDS)[number];

export interface PremiumInput {
  /** Premium before GST of the policy as placed. */
  basePremium: string | null;
  policyStart: string;
  policyEnd: string;
  /** Endorsement premiums before GST, each from its effective date to the policy end. */
  adjustments: ReadonlyArray<{
    kind: PremiumAdjustmentKind;
    amount: string;
    effectiveDate: string;
  }>;
}

const DAY = 86_400_000;
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY) + 1;

/** The part of a premium earned from `from` to the reporting date, by days in force (inclusive). */
function earned(paise: bigint, from: string, end: string, asOf: string): bigint {
  if (asOf < from) return 0n;
  const term = daysBetween(from, end);
  if (term <= 0) return 0n;
  const elapsed = Math.min(daysBetween(from, asOf < end ? asOf : end), term);
  return halfUp(paise * BigInt(elapsed), BigInt(term));
}

export interface PremiumBasis {
  base: string | null;
  additions: string;
  deletions: string;
  /** Base + additions − deletions: the premium after additions and deletions. */
  total: string | null;
  /** Earned to the reporting date: each part × days in force ÷ days of its term. */
  prorated: string | null;
  asOf: string;
  daysElapsed: number;
  policyDays: number;
}

/** The two premiums the ICR is measured against (N10 F), never substituted for each other. */
export function premiumBasis(input: PremiumInput, asOf: string): PremiumBasis {
  const policyDays = daysBetween(input.policyStart, input.policyEnd);
  const daysElapsed =
    asOf < input.policyStart ? 0 : Math.min(daysBetween(input.policyStart, asOf), policyDays);
  let additions = 0n;
  let deletions = 0n;
  let earnedAdjustments = 0n;
  for (const item of input.adjustments) {
    const paise = toPaise(item.amount);
    const part = earned(paise, item.effectiveDate, input.policyEnd, asOf);
    if (item.kind === 'ADDITION') {
      additions += paise;
      earnedAdjustments += part;
    } else {
      deletions += paise;
      earnedAdjustments -= part;
    }
  }
  if (input.basePremium === null) {
    return {
      base: null,
      additions: fromPaise(additions),
      deletions: fromPaise(deletions),
      total: null,
      prorated: null,
      asOf,
      daysElapsed,
      policyDays,
    };
  }
  const base = toPaise(input.basePremium);
  return {
    base: fromPaise(base),
    additions: fromPaise(additions),
    deletions: fromPaise(deletions),
    total: fromPaise(base + additions - deletions),
    prorated: fromPaise(earned(base, input.policyStart, input.policyEnd, asOf) + earnedAdjustments),
    asOf,
    daysElapsed,
    policyDays,
  };
}

/** ICR (%) = (paid + outstanding) ÷ premium × 100, or null with the reason. */
export function icrOf(
  incurred: bigint,
  premium: string | null,
): { percent: string | null; reason: string | null } {
  if (premium === null) return { percent: null, reason: 'No premium is recorded for the policy' };
  const paise = toPaise(premium);
  if (paise <= 0n)
    return { percent: null, reason: 'The premium is zero or below, so no ratio can be worked out' };
  return { percent: percentOf(incurred, paise), reason: null };
}

// The analysis

export interface AnalysisClaim extends BucketInput, AmountInput {
  id: string;
  sourceStatus: string;
  claimType: TpaClaimType | null;
  relationship: GhiRelationship | null;
  gender: 'MALE' | 'FEMALE' | 'OTHER' | null;
  /** Completed years at the age reference (admission), or null when unknown. */
  age: number | null;
  /** The ICD chapter key, or UNCLASSIFIED. */
  icdChapter: string;
}

const Amount = z.string();
const RowSchema = z.object({
  key: z.string(),
  label: z.string(),
  count: z.number().int(),
  claimed: Amount,
  paid: Amount,
  outstanding: Amount,
  incurred: Amount,
});
export type AnalysisRow = z.infer<typeof RowSchema>;

export const ClaimsAnalysisSchema = z.object({
  reported: RowSchema,
  status: z.array(RowSchema),
  outstandingBySubStatus: z.array(RowSchema),
  members: z.array(RowSchema),
  gender: z.array(RowSchema),
  relationship: z.array(RowSchema),
  ageBands: z.array(RowSchema),
  claimType: z.array(RowSchema),
  disease: z.array(RowSchema),
  icdVersion: z.string(),
  notCounted: z.number().int(),
  outstandingBasis: z.enum(OUTSTANDING_BASES),
  premium: z.object({
    base: Amount.nullable(),
    additions: Amount,
    deletions: Amount,
    total: Amount.nullable(),
    prorated: Amount.nullable(),
    asOf: z.iso.date(),
    daysElapsed: z.number().int(),
    policyDays: z.number().int(),
  }),
  icr: z.object({
    paid: Amount,
    outstanding: Amount,
    incurred: Amount,
    prorated: z.object({
      percent: z.string().nullable(),
      reason: z.string().nullable(),
      premium: Amount.nullable(),
    }),
    total: z.object({
      percent: z.string().nullable(),
      reason: z.string().nullable(),
      premium: Amount.nullable(),
    }),
  }),
});
export type ClaimsAnalysis = z.infer<typeof ClaimsAnalysisSchema>;

export const RELATIONSHIP_ANALYSIS_LABELS: Record<GhiRelationship, string> = {
  SELF: 'Self (employee)',
  SPOUSE: 'Spouse',
  CHILD: 'Children',
  FATHER: 'Father',
  MOTHER: 'Mother',
  FATHER_IN_LAW: 'Father-in-law',
  MOTHER_IN_LAW: 'Mother-in-law',
};
const STATUS_ROW_LABELS: Record<TpaClaimStatus, string> = {
  SETTLED: 'Settled',
  OUTSTANDING: 'Outstanding',
  REJECTED: 'Rejected',
  WITHDRAWN: 'Withdrawn / closed',
};

interface Tally {
  count: number;
  claimed: bigint;
  paid: bigint;
  outstanding: bigint;
}
const empty = (): Tally => ({ count: 0, claimed: 0n, paid: 0n, outstanding: 0n });
const rowOf = (key: string, label: string, tally: Tally): AnalysisRow => ({
  key,
  label,
  count: tally.count,
  claimed: fromPaise(tally.claimed),
  paid: fromPaise(tally.paid),
  outstanding: fromPaise(tally.outstanding),
  incurred: fromPaise(tally.paid + tally.outstanding),
});

/**
 * The analysis of the claims given (already filtered). Each counted claim is in exactly one row of
 * every dimension (an unknown value has its own row), so every dimension adds up to "reported".
 */
export function analyseClaims(input: {
  claims: readonly AnalysisClaim[];
  bands: readonly AgeBand[];
  premium: PremiumInput;
  asOf: string;
  outstandingBasis: OutstandingBasis;
}): ClaimsAnalysis {
  const reported = empty();
  const byStatus = new Map<TpaClaimStatus, Tally>(
    TPA_CLAIM_STATUSES.map((status) => [status, empty()]),
  );
  const bySubStatus = new Map<string, Tally>();
  const members = { main: empty(), dependant: empty(), unknown: empty() };
  const genders = new Map<string, Tally>(
    [...GHI_GENDERS, 'UNKNOWN'].map((gender) => [gender, empty()]),
  );
  const relationships = new Map<string, Tally>(
    [...GHI_RELATIONSHIPS, 'UNKNOWN'].map((key) => [key, empty()]),
  );
  const bands = input.bands.map(empty);
  const outside = empty();
  const ageUnknown = empty();
  const types = new Map<string, Tally>([
    ['CASHLESS', empty()],
    ['REIMBURSEMENT', empty()],
    ['UNKNOWN', empty()],
  ]);
  const diseases = new Map<string, Tally>(
    [...ICD10_CHAPTERS.map((chapter) => chapter.key), UNCLASSIFIED_CHAPTER.key].map((key) => [
      key,
      empty(),
    ]),
  );
  let notCounted = 0;
  const add = (tally: Tally, claimed: bigint, paid: bigint, outstanding: bigint) => {
    tally.count += 1;
    tally.claimed += claimed;
    tally.paid += paid;
    tally.outstanding += outstanding;
  };
  for (const claim of input.claims) {
    const bucket = bucketOf(claim);
    if (bucket === 'NOT_COUNTED') {
      notCounted += 1;
      continue;
    }
    const claimed = toPaise(claim.claimedAmount);
    const { paid, outstanding } = paidAndOutstanding(claim, input.outstandingBasis);
    const put = (tally: Tally) => add(tally, claimed, paid, outstanding);
    put(reported);
    put(byStatus.get(bucket)!);
    if (bucket === 'OUTSTANDING') {
      const key = claim.sourceStatus.trim() || 'Outstanding';
      if (!bySubStatus.has(key)) bySubStatus.set(key, empty());
      put(bySubStatus.get(key)!);
    }
    put(
      claim.relationship === null
        ? members.unknown
        : claim.relationship === 'SELF'
          ? members.main
          : members.dependant,
    );
    put(genders.get(claim.gender ?? 'UNKNOWN')!);
    put(relationships.get(claim.relationship ?? 'UNKNOWN')!);
    if (claim.age === null) put(ageUnknown);
    else {
      const index = bandIndexOf(claim.age, input.bands);
      put(index === null ? outside : bands[index]!);
    }
    put(types.get(claim.claimType ?? 'UNKNOWN')!);
    put(
      diseases.get(diseases.has(claim.icdChapter) ? claim.icdChapter : UNCLASSIFIED_CHAPTER.key)!,
    );
  }
  const basis = premiumBasis(input.premium, input.asOf);
  const incurred = reported.paid + reported.outstanding;
  const keepNonEmpty = (rows: AnalysisRow[], always: readonly string[] = []) =>
    rows.filter((row) => row.count > 0 || always.includes(row.key));
  return {
    reported: rowOf('REPORTED', 'Reported claims', reported),
    status: TPA_CLAIM_STATUSES.map((status) =>
      rowOf(status, STATUS_ROW_LABELS[status], byStatus.get(status)!),
    ),
    outstandingBySubStatus: [...bySubStatus.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, tally]) => rowOf(key, key, tally)),
    members: keepNonEmpty(
      [
        rowOf('MAIN', 'Main member (employee)', members.main),
        rowOf('DEPENDANT', 'Dependants', members.dependant),
        rowOf('UNKNOWN', 'Relationship not known', members.unknown),
      ],
      ['MAIN', 'DEPENDANT'],
    ),
    gender: keepNonEmpty(
      [
        rowOf('MALE', 'Male', genders.get('MALE')!),
        rowOf('FEMALE', 'Female', genders.get('FEMALE')!),
        rowOf('OTHER', 'Other', genders.get('OTHER')!),
        rowOf('UNKNOWN', 'Not known', genders.get('UNKNOWN')!),
      ],
      ['MALE', 'FEMALE'],
    ),
    relationship: keepNonEmpty(
      [
        ...GHI_RELATIONSHIPS.map((key) =>
          rowOf(key, RELATIONSHIP_ANALYSIS_LABELS[key], relationships.get(key)!),
        ),
        rowOf('UNKNOWN', 'Not known', relationships.get('UNKNOWN')!),
      ],
      [...GHI_RELATIONSHIPS],
    ),
    ageBands: keepNonEmpty(
      [
        ...input.bands.map((band, index) => rowOf(band.label, band.label, bands[index]!)),
        rowOf('OUTSIDE', 'Outside the age bands', outside),
        rowOf('UNKNOWN', 'Age not known', ageUnknown),
      ],
      input.bands.map((band) => band.label),
    ),
    claimType: keepNonEmpty(
      [
        rowOf('CASHLESS', 'Cashless', types.get('CASHLESS')!),
        rowOf('REIMBURSEMENT', 'Reimbursement', types.get('REIMBURSEMENT')!),
        rowOf('UNKNOWN', 'Type not stated', types.get('UNKNOWN')!),
      ],
      ['CASHLESS', 'REIMBURSEMENT'],
    ),
    disease: keepNonEmpty([
      ...ICD10_CHAPTERS.map((chapter) =>
        rowOf(
          chapter.key,
          `${chapter.numeral}. ${chapter.title} (${chapter.from}–${chapter.to})`,
          diseases.get(chapter.key)!,
        ),
      ),
      rowOf(
        UNCLASSIFIED_CHAPTER.key,
        UNCLASSIFIED_CHAPTER.title,
        diseases.get(UNCLASSIFIED_CHAPTER.key)!,
      ),
    ]),
    icdVersion: ICD_VERSION,
    notCounted,
    outstandingBasis: input.outstandingBasis,
    premium: basis,
    icr: {
      paid: fromPaise(reported.paid),
      outstanding: fromPaise(reported.outstanding),
      incurred: fromPaise(incurred),
      prorated: { ...icrOf(incurred, basis.prorated), premium: basis.prorated },
      total: { ...icrOf(incurred, basis.total), premium: basis.total },
    },
  };
}

/** The age bands the claims analysis starts with (open question CA-1: boundaries to confirm). */
export const CLAIMS_ANALYSIS_AGE_BANDS: readonly AgeBand[] = [
  { label: '0–10', min: 0, max: 10 },
  { label: '11–20', min: 11, max: 20 },
  { label: '21–30', min: 21, max: 30 },
  { label: '31–40', min: 31, max: 40 },
  { label: '41–50', min: 41, max: 50 },
  { label: '51–60', min: 51, max: 60 },
  { label: '61–70', min: 61, max: 70 },
  { label: 'Above 70', min: 71, max: null },
];

// The report request and response

export const ClaimsAnalysisQuerySchema = z.strictObject({
  caseId: ObjectIdSchema,
  /** Admissions from / to (inclusive); default: the policy period. */
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  /** The reporting date the prorated premium is earned to; default: today, at most the policy end. */
  asOf: z.iso.date().optional(),
  status: TpaClaimStatusSchema.optional(),
  claimType: TpaClaimTypeSchema.optional(),
  requestType: TpaRequestTypeSchema.optional(),
  member: z.enum(['MAIN', 'DEPENDANT']).optional(),
  relationship: z.enum(GHI_RELATIONSHIPS).optional(),
  ageBandSetId: ObjectIdSchema.optional(),
  outstandingBasis: z.enum(OUTSTANDING_BASES).default('SANCTIONED_ELSE_CLAIMED'),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ClaimsAnalysisQuery = z.infer<typeof ClaimsAnalysisQuerySchema>;
export const ClaimsAnalysisDocumentQuerySchema = ClaimsAnalysisQuerySchema.omit({
  page: true,
  limit: true,
}).extend({
  format: z.enum(['xlsx', 'pdf']).default('xlsx'),
});

export const ClaimsAnalysisDetailSchema = z.object({
  id: ObjectIdSchema,
  tpaClaimId: z.string(),
  requestType: TpaRequestTypeSchema,
  bucket: z.enum([...TPA_CLAIM_STATUSES, 'NOT_COUNTED']),
  sourceStatus: z.string(),
  employeeId: z.string().nullable(),
  patientName: z.string().nullable(),
  relationship: z.enum(GHI_RELATIONSHIPS).nullable(),
  gender: z.enum(GHI_GENDERS).nullable(),
  age: z.number().int().nullable(),
  admissionDate: z.iso.date().nullable(),
  dischargeDate: z.iso.date().nullable(),
  claimType: TpaClaimTypeSchema.nullable(),
  hospital: z.string().nullable(),
  claimedAmount: z.string().nullable(),
  paid: z.string(),
  outstanding: z.string(),
  icdChapter: z.string(),
  /** Only for users who process claims (claims.process). */
  icdCode: z.string().nullable(),
  diagnosis: z.string().nullable(),
});
export type ClaimsAnalysisDetail = z.infer<typeof ClaimsAnalysisDetailSchema>;

export const ClaimsAnalysisResponseSchema = z.object({
  header: z.object({
    company: z.string(),
    caseId: ObjectIdSchema,
    reference: z.string(),
    product: EbProductSchema,
    policyNumber: z.string().nullable(),
    insurerName: z.string().nullable(),
    policyStart: z.iso.date(),
    policyEnd: z.iso.date(),
    from: z.iso.date(),
    to: z.iso.date(),
    asOf: z.iso.date(),
    ageBands: z.object({ name: z.string(), bands: z.array(AgeBandSchema) }),
    filters: z.array(z.object({ label: z.string(), value: z.string() })),
    generatedAt: IsoDateTimeSchema,
    /** Whether diagnosis details are shown to this user (claims.process). */
    diagnosisVisible: z.boolean(),
    /** Board claims of the policy that no TPA record is linked to yet (not in the figures). */
    unreportedBoardClaims: z.number().int(),
  }),
  analysis: ClaimsAnalysisSchema,
  details: z.object({
    items: z.array(ClaimsAnalysisDetailSchema),
    total: z.number().int(),
    page: z.number().int(),
    limit: z.number().int(),
  }),
});
export type ClaimsAnalysisResponse = z.infer<typeof ClaimsAnalysisResponseSchema>;

// Premium adjustments (additions and deletions) as recorded per policy

export const PremiumAdjustmentInputSchema = z.strictObject({
  kind: z.enum(PREMIUM_ADJUSTMENT_KINDS),
  /** Premium before GST, rupees with at most 2 decimals, above 0. */
  amount: z
    .string()
    .trim()
    .regex(/^\d{1,13}(\.\d{1,2})?$/, 'Enter rupees, with paise at most')
    .refine((value) => toPaise(value) > 0n, 'Enter an amount above 0'),
  effectiveDate: z.iso.date({ error: 'Enter the effective date' }),
  reference: z.string().trim().min(1, 'Enter the endorsement reference').max(100),
  note: z.string().trim().max(500).nullable().default(null),
});
export type PremiumAdjustmentInput = z.infer<typeof PremiumAdjustmentInputSchema>;
export const PremiumAdjustmentSchema = z.object({
  id: ObjectIdSchema,
  kind: z.enum(PREMIUM_ADJUSTMENT_KINDS),
  amount: z.string(),
  effectiveDate: z.iso.date(),
  reference: z.string(),
  note: z.string().nullable(),
  voided: z.boolean(),
  createdAt: IsoDateTimeSchema,
  createdBy: z.string(),
});
export const PremiumAdjustmentListResponseSchema = z.object({
  basePremium: z.string().nullable(),
  gst: z.string().nullable(),
  policyStart: z.iso.date(),
  policyEnd: z.iso.date(),
  items: z.array(PremiumAdjustmentSchema),
});
export const PremiumAdjustmentParamsSchema = z.strictObject({
  caseId: ObjectIdSchema,
  adjustmentId: ObjectIdSchema,
});
export const CasePolicyParamsSchema = z.strictObject({ caseId: ObjectIdSchema });
