import { z } from 'zod';
import { fromPaise, percentOf, toPaise } from './claims-analysis.ts';
import { IsoDateTimeSchema, ObjectIdSchema } from './common.ts';
import { EbProductSchema, type EbProduct } from './eb-products.ts';

// The benefit and cost analysis for a renewal (N8): three policy years side by side and the
// insurers' quotes for the coming year. Every figure is worked out from what is stored for the
// year; a figure that cannot be worked out (missing data, zero denominator) is null with the
// reason, never zero. Averages say what they divide by. Pure, so screen and files agree.

export interface PolicyYearFigures {
  /** Where the year comes from: a placed case in the app, or a year recorded by hand. */
  source: 'POLICY' | 'RECORDED';
  sourceId: string;
  label: string;
  product: EbProduct;
  policyNumber: string | null;
  insurerName: string | null;
  policyStart: string;
  policyEnd: string;
  employees: number | null;
  /** All insured lives: employees and dependants. */
  lives: number | null;
  /** Lives by the sum insured that covers them; null when not known. */
  bySumInsured: Array<{ amount: string; families: number; lives: number }> | null;
  /** Floater: each family's sum insured once; individual: every member's. */
  totalSumInsured: string | null;
  premiumBeforeGst: string | null;
  gst: string | null;
  claims: {
    /** Paid + outstanding (incurred) to the date below. */
    toDate: string | null;
    paid: string | null;
    outstanding: string | null;
    count: number | null;
    asOf: string | null;
    source: 'TPA' | 'RECORDED' | 'NONE';
  };
  /** The policy year is not over on the report date (its claims are not final). */
  incomplete: boolean;
  notes: string[];
}

const Metric = z.object({ value: z.string().nullable(), reason: z.string().nullable() });
type MetricValue = z.infer<typeof Metric>;

export const RenewalYearSchema = z.object({
  source: z.enum(['POLICY', 'RECORDED']),
  sourceId: z.string(),
  label: z.string(),
  product: EbProductSchema,
  policyNumber: z.string().nullable(),
  insurerName: z.string().nullable(),
  policyStart: z.iso.date(),
  policyEnd: z.iso.date(),
  incomplete: z.boolean(),
  notes: z.array(z.string()),
  employees: Metric,
  dependants: Metric,
  lives: Metric,
  bySumInsured: z
    .array(z.object({ amount: z.string(), families: z.number().int(), lives: z.number().int() }))
    .nullable(),
  totalSumInsured: Metric,
  premiumBeforeGst: Metric,
  gst: Metric,
  premiumWithGst: Metric,
  claimsToDate: Metric,
  claimsPaid: Metric,
  claimsOutstanding: Metric,
  claimsCount: Metric,
  claimsAsOf: z.iso.date().nullable(),
  claimsSource: z.enum(['TPA', 'RECORDED', 'NONE']),
  claimsRatio: Metric,
  premiumPerFamily: Metric,
  premiumPerLife: Metric,
  premiumPerLakh: Metric,
});
export type RenewalYear = z.infer<typeof RenewalYearSchema>;

export const RENEWAL_METRICS = [
  'employees',
  'dependants',
  'lives',
  'totalSumInsured',
  'premiumBeforeGst',
  'gst',
  'premiumWithGst',
  'claimsToDate',
  'claimsCount',
  'claimsRatio',
  'premiumPerFamily',
  'premiumPerLife',
  'premiumPerLakh',
] as const;
export type RenewalMetric = (typeof RENEWAL_METRICS)[number];
export const RENEWAL_METRIC_LABELS: Record<RenewalMetric, string> = {
  employees: 'Employees (families)',
  dependants: 'Dependants',
  lives: 'Total insured lives (group size)',
  totalSumInsured: 'Total sum insured',
  premiumBeforeGst: 'Premium before GST',
  gst: 'GST',
  premiumWithGst: 'Premium including GST',
  claimsToDate: 'Claims to date (paid + outstanding)',
  claimsCount: 'Number of claims',
  claimsRatio: 'Claims ratio (claims to date ÷ premium before GST)',
  premiumPerFamily: 'Average premium per family (÷ employees)',
  premiumPerLife: 'Average premium per person (÷ insured lives)',
  premiumPerLakh: 'Premium per lakh of sum insured',
};
/** Metrics that are percentages (their change is in percentage points). */
const PERCENT_METRICS: readonly RenewalMetric[] = ['claimsRatio'];
const COUNT_METRICS: readonly RenewalMetric[] = ['employees', 'dependants', 'lives', 'claimsCount'];

const ok = (value: string): MetricValue => ({ value, reason: null });
const missing = (reason: string): MetricValue => ({ value: null, reason });

/** a ÷ b to the paisa (amounts) as text; b > 0. */
const divide = (numeratorPaise: bigint, denominator: bigint) =>
  fromPaise((numeratorPaise * 2n + denominator) / (2n * denominator));

export function renewalYear(year: PolicyYearFigures): RenewalYear {
  const employees =
    year.employees === null ? missing('Employees not recorded') : ok(String(year.employees));
  const lives =
    year.lives === null ? missing('Insured lives not recorded') : ok(String(year.lives));
  const dependants =
    year.employees === null || year.lives === null
      ? missing('Needs employees and insured lives')
      : year.lives < year.employees
        ? missing('Fewer insured lives than employees: check the year’s figures')
        : ok(String(year.lives - year.employees));
  const premium = year.premiumBeforeGst === null ? null : toPaise(year.premiumBeforeGst);
  const premiumBeforeGst =
    premium === null ? missing('Premium not recorded') : ok(fromPaise(premium));
  const gst = year.gst === null ? missing('GST not recorded') : ok(fromPaise(toPaise(year.gst)));
  const premiumWithGst =
    premium === null || year.gst === null
      ? missing('Needs the premium and the GST')
      : ok(fromPaise(premium + toPaise(year.gst)));
  const claims = year.claims.toDate === null ? null : toPaise(year.claims.toDate);
  const claimsToDate =
    claims === null ? missing('No claims data for this year') : ok(fromPaise(claims));
  const claimsRatio =
    claims === null
      ? missing('No claims data for this year')
      : premium === null
        ? missing('Premium not recorded')
        : premium <= 0n
          ? missing('Premium is zero')
          : ok(percentOf(claims, premium)!);
  const perFamily =
    premium === null
      ? missing('Premium not recorded')
      : !year.employees
        ? missing('No employees recorded')
        : ok(divide(premium, BigInt(year.employees)));
  const perLife =
    premium === null
      ? missing('Premium not recorded')
      : !year.lives
        ? missing('No insured lives recorded')
        : ok(divide(premium, BigInt(year.lives)));
  const sumInsured = year.totalSumInsured === null ? null : toPaise(year.totalSumInsured);
  const perLakh =
    premium === null
      ? missing('Premium not recorded')
      : sumInsured === null
        ? missing('Total sum insured not recorded')
        : sumInsured <= 0n
          ? missing('Total sum insured is zero')
          : // premium ÷ (sum insured ÷ 1,00,000): premium paise × 1,00,000 ÷ sum insured rupees.
            ok(divide(premium * 100_000n * 100n, sumInsured));
  return {
    source: year.source,
    sourceId: year.sourceId,
    label: year.label,
    product: year.product,
    policyNumber: year.policyNumber,
    insurerName: year.insurerName,
    policyStart: year.policyStart,
    policyEnd: year.policyEnd,
    incomplete: year.incomplete,
    notes: year.notes,
    employees,
    dependants,
    lives,
    bySumInsured: year.bySumInsured,
    totalSumInsured:
      sumInsured === null ? missing('Total sum insured not recorded') : ok(fromPaise(sumInsured)),
    premiumBeforeGst,
    gst,
    premiumWithGst,
    claimsToDate,
    claimsPaid:
      year.claims.paid === null
        ? missing('Not recorded')
        : ok(fromPaise(toPaise(year.claims.paid))),
    claimsOutstanding:
      year.claims.outstanding === null
        ? missing('Not recorded')
        : ok(fromPaise(toPaise(year.claims.outstanding))),
    claimsCount:
      year.claims.count === null ? missing('Not recorded') : ok(String(year.claims.count)),
    claimsAsOf: year.claims.asOf,
    claimsSource: year.claims.source,
    claimsRatio,
    premiumPerFamily: perFamily,
    premiumPerLife: perLife,
    premiumPerLakh: perLakh,
  };
}

export const RenewalChangeSchema = z.object({
  metric: z.enum(RENEWAL_METRICS),
  from: z.string(),
  to: z.string(),
  /** to − from (a count, an amount, or percentage points for a ratio). */
  absolute: z.string().nullable(),
  /** (to − from) ÷ from × 100; null when either is missing or from is zero (or for a ratio). */
  percent: z.string().nullable(),
  reason: z.string().nullable(),
});
export type RenewalChange = z.infer<typeof RenewalChangeSchema>;

/** Changes from one year to the next, for each metric (N8). */
export function renewalChanges(from: RenewalYear, to: RenewalYear): RenewalChange[] {
  return RENEWAL_METRICS.map((metric) => {
    const a = from[metric];
    const b = to[metric];
    const base = { metric, from: from.label, to: to.label };
    if (a.value === null || b.value === null) {
      return { ...base, absolute: null, percent: null, reason: a.reason ?? b.reason };
    }
    const count = COUNT_METRICS.includes(metric);
    const left = count ? BigInt(a.value) * 100n : toPaise(a.value);
    const right = count ? BigInt(b.value) * 100n : toPaise(b.value);
    const difference = right - left;
    const absolute = count ? String(difference / 100n) : fromPaise(difference);
    if (PERCENT_METRICS.includes(metric)) {
      return {
        ...base,
        absolute,
        percent: null,
        reason: 'A change in a ratio is shown in percentage points',
      };
    }
    if (left === 0n)
      return { ...base, absolute, percent: null, reason: 'The earlier year is zero' };
    const negative = difference < 0n;
    const magnitude = percentOf(negative ? -difference : difference, left < 0n ? -left : left)!;
    return { ...base, absolute, percent: negative ? `-${magnitude}` : magnitude, reason: null };
  });
}

export const RenewalQuoteSchema = z.object({
  insurerName: z.string(),
  quoteVersion: z.number().int(),
  basePremium: z.string().nullable(),
  gst: z.string().nullable(),
  totalPremium: z.string().nullable(),
  /** Against the latest selected year's premium before GST. */
  changeAbsolute: z.string().nullable(),
  changePercent: z.string().nullable(),
  lowest: z.boolean(),
});
export type RenewalQuote = z.infer<typeof RenewalQuoteSchema>;

/** The coming year's quotes against the latest year's premium before GST. */
export function renewalQuotes(
  quotes: ReadonlyArray<{
    insurerName: string;
    quoteVersion: number;
    basePremium: string | null;
    gst: string | null;
    totalPremium: string | null;
  }>,
  latestPremium: string | null,
): RenewalQuote[] {
  const bases = quotes.map((quote) =>
    quote.basePremium === null ? null : toPaise(quote.basePremium),
  );
  const known = bases.filter((value): value is bigint => value !== null);
  const lowest =
    known.length > 0 ? known.reduce((min, value) => (value < min ? value : min)) : null;
  const latest = latestPremium === null ? null : toPaise(latestPremium);
  return quotes.map((quote, index) => {
    const base = bases[index]!;
    const difference = base === null || latest === null ? null : base - latest;
    return {
      ...quote,
      changeAbsolute: difference === null ? null : fromPaise(difference),
      changePercent:
        difference === null || latest === null || latest <= 0n
          ? null
          : `${difference < 0n ? '-' : ''}${percentOf(difference < 0n ? -difference : difference, latest)!}`,
      lowest: base !== null && base === lowest,
    };
  });
}

// Requests and responses

export const RenewalYearRefSchema = z.strictObject({
  source: z.enum(['POLICY', 'RECORDED']),
  id: ObjectIdSchema,
});
export const RenewalAnalysisRequestSchema = z
  .strictObject({
    clientId: ObjectIdSchema,
    product: EbProductSchema,
    /** Up to three policy years, oldest first. */
    years: z
      .array(RenewalYearRefSchema)
      .min(1, 'Choose at least one policy year')
      .max(3, 'Choose at most three policy years'),
    /** The renewal case whose recorded quotes are compared (optional). */
    upcomingCaseId: ObjectIdSchema.nullable().default(null),
    /** Claims are counted to this date (default: today). */
    asOf: z.iso.date().optional(),
  })
  .superRefine((input, context) => {
    const ids = input.years.map((year) => `${year.source}:${year.id}`);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: 'custom',
        path: ['years'],
        message: 'Choose each policy year once',
      });
    }
  });
export type RenewalAnalysisRequest = z.infer<typeof RenewalAnalysisRequestSchema>;

export const RenewalAnalysisSchema = z.object({
  company: z.string(),
  clientId: ObjectIdSchema,
  product: EbProductSchema,
  asOf: z.iso.date(),
  generatedAt: IsoDateTimeSchema,
  years: z.array(RenewalYearSchema),
  changes: z.array(z.array(RenewalChangeSchema)),
  upcoming: z
    .object({
      caseId: ObjectIdSchema,
      reference: z.string(),
      policyStart: z.iso.date().nullable(),
      quotes: z.array(RenewalQuoteSchema),
    })
    .nullable(),
  /** How each figure is worked out, for the reader (N8: calculation parameters). */
  parameters: z.array(z.object({ label: z.string(), value: z.string() })),
  warnings: z.array(z.string()),
});
export type RenewalAnalysis = z.infer<typeof RenewalAnalysisSchema>;

export const SavedRenewalReportSchema = z.object({
  id: ObjectIdSchema,
  title: z.string(),
  createdAt: IsoDateTimeSchema,
  createdBy: z.string(),
  analysis: RenewalAnalysisSchema,
});
export type SavedRenewalReport = z.infer<typeof SavedRenewalReportSchema>;
export const SavedRenewalReportListResponseSchema = z.object({
  items: z.array(
    SavedRenewalReportSchema.omit({ analysis: true }).extend({
      years: z.array(z.string()),
      product: EbProductSchema,
    }),
  ),
});
export const SaveRenewalReportRequestSchema = RenewalAnalysisRequestSchema.safeExtend({
  title: z.string().trim().min(1, 'Name the report').max(120),
});
export const RenewalReportParamsSchema = z.strictObject({ reportId: ObjectIdSchema });
export const RenewalDocumentQuerySchema = z.strictObject({
  format: z.enum(['xlsx', 'pdf']).default('xlsx'),
});

/** The policy years a company has for a product: placed cases and years recorded by hand. */
export const RenewalYearOptionSchema = z.object({
  source: z.enum(['POLICY', 'RECORDED']),
  id: ObjectIdSchema,
  label: z.string(),
  policyStart: z.iso.date(),
  policyEnd: z.iso.date(),
  insurerName: z.string().nullable(),
  policyNumber: z.string().nullable(),
});
export const RenewalOptionsQuerySchema = z.strictObject({
  clientId: ObjectIdSchema,
  product: EbProductSchema,
});
export const RenewalOptionsResponseSchema = z.object({
  years: z.array(RenewalYearOptionSchema),
  /** Open cases of the company and product with recorded quotes (the coming year). */
  upcoming: z.array(
    z.object({
      caseId: ObjectIdSchema,
      reference: z.string(),
      type: z.string(),
      quotes: z.number().int(),
    }),
  ),
});

// A policy year recorded by hand (years before the app, or placed elsewhere)

const Rupees = z
  .string()
  .trim()
  .regex(/^\d{1,13}(\.\d{1,2})?$/, 'Enter rupees, with paise at most');
const Count = z.number().int('Enter a whole number').min(0).max(10_000_000);

export const RecordedPolicyYearInputSchema = z
  .strictObject({
    clientId: ObjectIdSchema,
    product: EbProductSchema,
    policyStart: z.iso.date({ error: 'Enter the policy start' }),
    policyEnd: z.iso.date({ error: 'Enter the policy end' }),
    insurerName: z.string().trim().min(1, 'Enter the insurer').max(200),
    policyNumber: z.string().trim().max(60).nullable().default(null),
    employees: Count.nullable(),
    lives: Count.nullable(),
    totalSumInsured: Rupees.nullable(),
    bySumInsured: z
      .array(z.strictObject({ amount: Rupees, families: Count, lives: Count }))
      .max(30)
      .nullable()
      .default(null),
    premiumBeforeGst: Rupees.nullable(),
    gst: Rupees.nullable(),
    claimsPaid: Rupees.nullable(),
    claimsOutstanding: Rupees.nullable(),
    claimsCount: Count.nullable(),
    claimsAsOf: z.iso.date().nullable(),
    source: z.string().trim().min(1, 'Say where the figures come from').max(300),
  })
  .superRefine((input, context) => {
    if (input.policyEnd < input.policyStart) {
      context.addIssue({
        code: 'custom',
        path: ['policyEnd'],
        message: 'The policy end is before its start',
      });
    }
    if (input.employees !== null && input.lives !== null && input.lives < input.employees) {
      context.addIssue({
        code: 'custom',
        path: ['lives'],
        message: 'Insured lives include the employees: enter at least the employee count',
      });
    }
    const anyClaims = input.claimsPaid !== null || input.claimsOutstanding !== null;
    if (anyClaims && input.claimsAsOf === null) {
      context.addIssue({
        code: 'custom',
        path: ['claimsAsOf'],
        message: 'Give the date the claims figures are as of',
      });
    }
  });
export type RecordedPolicyYearInput = z.infer<typeof RecordedPolicyYearInputSchema>;
export const RecordedPolicyYearSchema = z.object({
  id: ObjectIdSchema,
  clientId: ObjectIdSchema,
  product: EbProductSchema,
  policyStart: z.iso.date(),
  policyEnd: z.iso.date(),
  insurerName: z.string(),
  policyNumber: z.string().nullable(),
  employees: z.number().int().nullable(),
  lives: z.number().int().nullable(),
  totalSumInsured: z.string().nullable(),
  bySumInsured: z
    .array(z.object({ amount: z.string(), families: z.number().int(), lives: z.number().int() }))
    .nullable(),
  premiumBeforeGst: z.string().nullable(),
  gst: z.string().nullable(),
  claimsPaid: z.string().nullable(),
  claimsOutstanding: z.string().nullable(),
  claimsCount: z.number().int().nullable(),
  claimsAsOf: z.iso.date().nullable(),
  source: z.string(),
  updatedAt: IsoDateTimeSchema,
  updatedBy: z.string(),
});
export type RecordedPolicyYear = z.infer<typeof RecordedPolicyYearSchema>;
export const RecordedPolicyYearListResponseSchema = z.object({
  items: z.array(RecordedPolicyYearSchema),
});
export const RecordedPolicyYearParamsSchema = z.strictObject({ yearId: ObjectIdSchema });
export const RecordedPolicyYearQuerySchema = z.strictObject({
  clientId: ObjectIdSchema,
  product: EbProductSchema.optional(),
});
