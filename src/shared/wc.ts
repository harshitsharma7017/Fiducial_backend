import { z } from 'zod';
import { IsoDateTimeSchema, ObjectIdSchema } from './common.ts';

// Workmen's Compensation (WC), an Employee Benefits line in the client's format ("WC Format.xlsx":
// Data Sheet, RFQ and Quote sheets). A case has any number of worker categories (designation,
// persons and monthly wage per person), coverage options to quote (with or without medical
// expenses), clauses to be attached and conditions: each list starts from the client's format and
// is added to or trimmed per proposal. Insurers quote a premium (GST included) per coverage option.

export const WC_TYPES = ['NEW', 'RENEWAL', 'ROLLOVER'] as const;
export type WcType = (typeof WC_TYPES)[number];
export const WC_TYPE_LABELS: Record<WcType, string> = {
  NEW: 'New business',
  RENEWAL: 'Renewal',
  ROLLOVER: 'Roll over',
};

export const MAX_WC_CATEGORIES = 50;
export const MAX_WC_COVERAGE_OPTIONS = 10;
export const MAX_WC_CLAUSES = 50;
export const MAX_WC_QUOTES = 10;

/** The coverage options of the client's RFQ: each is quoted by every insurer. */
export const WC_DEFAULT_COVERAGE_OPTIONS = [
  'Without Medical Expenses',
  'With 1 Lakh Medical Expenses',
  'With 5 Lakh Medical Expenses',
] as const;

/** "Clauses to be attached" of the client's RFQ. */
export const WC_DEFAULT_CLAUSES = [
  'Policy on Designation Basis',
  'Coverage available only during the course of employment either within the factory or on official duty',
  'Endorsement No 179 : Contract & Sub - contract Workers to be covered',
  'Fatal Accident covered as per Fatal Accident Law Act',
  'Common Law: Maximum of 100 times the monthly wages of the employee at the time of accident subject to the Condition of Average as per the Employees Compensation Insurance Policy Wording',
  'WC Act / Employers Liability Law is Covered',
] as const;

/** "Conditions" of the client's RFQ. */
export const WC_DEFAULT_CONDITIONS = [
  'Attendance & Wages Register containing details of Employees working on site to be maintained and must be available for inspection for both employees and contract employees',
  'Occupational Diseases not covered under this scope of coverage',
  'Warranted that in case of a claim, if the declared wages is found to be less than the actual wages then three times the difference of the premium charged and the actual premium payable shall be charged prior to the settlement of the claim.',
  'Medical expenses due to accident is covered for Maximum of 2 years from Date of injury subject to submission of original bills',
] as const;

/** The worker categories of the client's Data Sheet, offered on a new case (persons and wages blank). */
export const WC_DEFAULT_CATEGORIES = [
  'Management, Admin & Other Staffs',
  'Skilled Workers / Labours',
  'Contract & Sub-Contract Workers / Labours',
] as const;

/** The conditions printed under the Data Sheet's table, as the client's format words them. */
export const WC_DATA_SHEET_CONDITIONS = [
  'Only Non-ESI Employees are covered',
  'ESI Employees cannot be covered under Workmen Compensation (WC) policy. If cover is required, then you need to provide details of ESI Employees separately.',
] as const;

export const WC_DEFAULT_POLICY_PERIOD = 'One year from the payment date';

const text = (max: number) => z.string().trim().max(max, 'This is too long');
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, 'This is too long')
    .nullable()
    .transform((value) => (value ? value : null));
/** A list entry's id, made by the screen so rows keep their identity while edited. */
const RowIdSchema = z.string().trim().min(1).max(40);
/** Whole rupees, digits only. */
const RupeesSchema = z.string().regex(/^\d{1,13}$/, 'Enter whole rupees, digits only');
/** Rupees with up to two decimals (a premium including GST). */
const AmountSchema = z
  .string()
  .regex(/^\d{1,13}(\.\d{1,2})?$/, 'Enter an amount in rupees, for example 14891.60');

export const WcCategorySchema = z.strictObject({
  id: RowIdSchema,
  designation: text(200).min(1, 'Enter the category of workers'),
  persons: z.number().int('Enter a whole number').min(0).max(1_000_000),
  /** Wages per person per month. */
  monthlyWage: RupeesSchema,
});
export type WcCategory = z.infer<typeof WcCategorySchema>;

export const WcCoverageOptionSchema = z.strictObject({
  id: RowIdSchema,
  label: text(200).min(1, 'Name the coverage option'),
});
export type WcCoverageOption = z.infer<typeof WcCoverageOptionSchema>;

/** The policy in force on a renewal ("Expiring Policy details"). */
export const WcExpiringPolicySchema = z.strictObject({
  policyYear: optionalText(20),
  policyNumber: optionalText(100),
  insurer: optionalText(200),
  persons: z.number().int().min(0).max(1_000_000).nullable(),
  sumInsured: RupeesSchema.nullable(),
  premiumInclGst: AmountSchema.nullable(),
  coverageOption: optionalText(200),
  claimAmount: RupeesSchema.nullable(),
  changes: optionalText(1000),
});
export type WcExpiringPolicy = z.infer<typeof WcExpiringPolicySchema>;

const uniqueIds = (rows: readonly { id: string }[]) =>
  new Set(rows.map((row) => row.id)).size === rows.length;
const distinctText = (rows: readonly string[]) =>
  new Set(rows.map((row) => row.toLowerCase())).size === rows.length;

/** The Data Sheet: what the RFQ asks the insurers to quote. */
export const WcDataSheetInputSchema = z.strictObject({
  policyPeriod: text(200).min(1, 'Enter the policy period'),
  natureOfBusiness: optionalText(500),
  workingHeight: optionalText(200),
  riskLocation: optionalText(500),
  /** "Category" on the RFQ: who is covered, in words. */
  categoryDescription: optionalText(500),
  categories: z
    .array(WcCategorySchema)
    .max(MAX_WC_CATEGORIES, `Add at most ${MAX_WC_CATEGORIES} categories`)
    .refine(uniqueIds, 'Each category once'),
  coverageOptions: z
    .array(WcCoverageOptionSchema)
    .min(1, 'Keep at least one coverage option')
    .max(MAX_WC_COVERAGE_OPTIONS, `Add at most ${MAX_WC_COVERAGE_OPTIONS} coverage options`)
    .refine(uniqueIds, 'Each coverage option once'),
  clauses: z
    .array(text(1000).min(1, 'Enter the clause or remove it'))
    .max(MAX_WC_CLAUSES, `Add at most ${MAX_WC_CLAUSES} clauses`)
    .refine(distinctText, 'Each clause once'),
  conditions: z
    .array(text(1000).min(1, 'Enter the condition or remove it'))
    .max(MAX_WC_CLAUSES, `Add at most ${MAX_WC_CLAUSES} conditions`)
    .refine(distinctText, 'Each condition once'),
  /** A renewal's policy in force; null on new business. */
  expiringPolicy: WcExpiringPolicySchema.nullable(),
});
export type WcDataSheetInput = z.infer<typeof WcDataSheetInputSchema>;

export const WcQuoteInputSchema = z.strictObject({
  insurerId: ObjectIdSchema,
  /** "Cheque / payment in favour of". */
  paymentInFavourOf: optionalText(300),
  /** The premium including GST for each coverage option; null where it was not quoted. */
  premiums: z.array(z.strictObject({ optionId: RowIdSchema, premium: AmountSchema.nullable() })),
});
export type WcQuoteInput = z.infer<typeof WcQuoteInputSchema>;

export const WcQuotesInputSchema = z
  .strictObject({
    quotes: z.array(WcQuoteInputSchema).max(MAX_WC_QUOTES, `Add at most ${MAX_WC_QUOTES} insurers`),
    recommendedInsurerId: ObjectIdSchema.nullable(),
    remarks: optionalText(2000),
  })
  .refine((input) => new Set(input.quotes.map((q) => q.insurerId)).size === input.quotes.length, {
    path: ['quotes'],
    message: 'Each insurer once',
  })
  .refine(
    (input) =>
      input.recommendedInsurerId === null ||
      input.quotes.some((quote) => quote.insurerId === input.recommendedInsurerId),
    { path: ['recommendedInsurerId'], message: 'Recommend one of the insurers quoted' },
  );
export type WcQuotesInput = z.infer<typeof WcQuotesInputSchema>;

export const CreateWcCaseRequestSchema = z.strictObject({
  clientId: ObjectIdSchema,
  type: z.enum(WC_TYPES, { error: 'Choose new business or renewal' }),
});
export type CreateWcCaseRequest = z.infer<typeof CreateWcCaseRequestSchema>;

export const WcCaseIdParamsSchema = z.strictObject({ id: ObjectIdSchema });

export const WC_DOCUMENT_KINDS = ['data-sheet', 'rfq', 'qcr', 'placement-slip'] as const;
export type WcDocumentKind = (typeof WC_DOCUMENT_KINDS)[number];
export const WC_DOCUMENT_LABELS: Record<WcDocumentKind, string> = {
  'data-sheet': 'Data Sheet',
  rfq: 'RFQ',
  qcr: 'Quote comparison (QCR)',
  'placement-slip': 'Placement slip',
};

/**
 * The stages of a case, as on the other lines: each is reached by the work itself. The Data Sheet
 * is complete; the RFQ has gone to an insurer; an insurer has quoted; the QCR recommends one; the
 * insurer and coverage accepted are chosen for the placement slip; the policy number is recorded.
 */
export const WC_STAGES = [
  'DATA_SHEET',
  'RFQ',
  'QUOTES',
  'QCR',
  'PLACEMENT_SLIP',
  'PLACED',
] as const;
export type WcStage = (typeof WC_STAGES)[number];
export const WC_STAGE_LABELS: Record<WcStage, string> = {
  DATA_SHEET: 'Data Sheet',
  RFQ: 'RFQ',
  QUOTES: 'Quotes',
  QCR: 'QCR',
  PLACEMENT_SLIP: 'Placement slip',
  PLACED: 'Placed',
};

/** The insurers the RFQ goes to, and the day it was sent to each (blank: not sent yet). */
export const WcRfqInputSchema = z
  .strictObject({
    insurers: z
      .array(
        z.strictObject({
          insurerId: ObjectIdSchema,
          sentOn: z.iso.date({ error: 'Enter the date as YYYY-MM-DD' }).nullable(),
        }),
      )
      // Each one gets a column on the Quotes tab: as many as quotes can hold.
      .max(MAX_WC_QUOTES, `Choose at most ${MAX_WC_QUOTES} insurers`),
  })
  .refine(
    (input) => new Set(input.insurers.map((item) => item.insurerId)).size === input.insurers.length,
    { path: ['insurers'], message: 'Each insurer once' },
  );
export type WcRfqInput = z.infer<typeof WcRfqInputSchema>;

/** The client's decision and the policy: the insurer and coverage option accepted. */
export const WcPlacementInputSchema = z
  .strictObject({
    insurerId: ObjectIdSchema,
    optionId: RowIdSchema,
    /** Recorded once the insurer issues the policy; the case is then placed. */
    policyNumber: optionalText(100),
    policyStart: z.iso.date({ error: 'Enter the date as YYYY-MM-DD' }).nullable(),
    policyEnd: z.iso.date({ error: 'Enter the date as YYYY-MM-DD' }).nullable(),
  })
  .refine(
    (input) => !input.policyStart || !input.policyEnd || input.policyEnd > input.policyStart,
    { path: ['policyEnd'], message: 'The policy must end after it starts' },
  );
export type WcPlacementInput = z.infer<typeof WcPlacementInputSchema>;
export const WcDocumentParamsSchema = z.strictObject({
  id: ObjectIdSchema,
  kind: z.enum(WC_DOCUMENT_KINDS),
});
export const WcDocumentQuerySchema = z.strictObject({
  format: z.enum(['xlsx', 'pdf']).default('pdf'),
});

export const WcCaseSchema = WcDataSheetInputSchema.safeExtend({
  id: ObjectIdSchema,
  reference: z.string(),
  type: z.enum(WC_TYPES),
  client: z.object({
    id: ObjectIdSchema,
    name: z.string(),
    gstin: z.string().nullable(),
    address: z.string(),
  }),
  /** GST % in force when the case was created, for the "Premium incl GST" headings. */
  gstRatePercent: z.string(),
  totals: z.object({ persons: z.number(), monthlyWages: z.string(), annualWages: z.string() }),
  quotes: z.array(
    WcQuoteInputSchema.extend({
      insurerName: z.string(),
      paymentInFavourOf: z.string().nullable(),
    }),
  ),
  recommendedInsurerId: ObjectIdSchema.nullable(),
  remarks: z.string().nullable(),
  stage: z.enum(WC_STAGES),
  /** The RFQ has gone to an insurer: the Data Sheet stays as it was quoted on. */
  locked: z.boolean(),
  rfqInsurers: z.array(
    z.object({
      insurerId: ObjectIdSchema,
      insurerName: z.string(),
      sentOn: z.iso.date().nullable(),
    }),
  ),
  placement: z
    .object({
      insurerId: ObjectIdSchema,
      insurerName: z.string(),
      optionId: z.string(),
      optionLabel: z.string(),
      premium: z.string().nullable(),
      paymentInFavourOf: z.string().nullable(),
      policyNumber: z.string().nullable(),
      policyStart: z.iso.date().nullable(),
      policyEnd: z.iso.date().nullable(),
      updatedAt: IsoDateTimeSchema,
    })
    .nullable(),
  /** What the Data Sheet still needs before the RFQ; empty when complete. */
  missing: z.array(z.string()),
  owner: z.object({ id: ObjectIdSchema, name: z.string() }),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type WcCase = z.infer<typeof WcCaseSchema>;

export const WcCaseSummarySchema = z.object({
  id: ObjectIdSchema,
  reference: z.string(),
  type: z.enum(WC_TYPES),
  stage: z.enum(WC_STAGES),
  clientName: z.string(),
  persons: z.number(),
  insurers: z.number(),
  ready: z.boolean(),
  updatedAt: IsoDateTimeSchema,
});
export type WcCaseSummary = z.infer<typeof WcCaseSummarySchema>;
export const WcCaseListSchema = z.object({ items: z.array(WcCaseSummarySchema) });

/** Annual wages of a category: persons × wage per month × 12, in whole rupees. */
export function wcAnnualWages(category: Pick<WcCategory, 'persons' | 'monthlyWage'>): string {
  return (BigInt(category.persons) * BigInt(category.monthlyWage || '0') * 12n).toString();
}

/** The table's totals: persons, wages per month and per annum across the categories. */
export function wcTotals(categories: readonly Pick<WcCategory, 'persons' | 'monthlyWage'>[]) {
  let persons = 0;
  let monthly = 0n;
  for (const category of categories) {
    persons += category.persons;
    monthly += BigInt(category.persons) * BigInt(category.monthlyWage || '0');
  }
  return { persons, monthlyWages: monthly.toString(), annualWages: (monthly * 12n).toString() };
}

/** What the Data Sheet needs before an RFQ is sent. */
export function wcMissing(
  sheet: Pick<WcDataSheetInput, 'categories' | 'natureOfBusiness'>,
): string[] {
  const missing: string[] = [];
  if (!sheet.natureOfBusiness) missing.push('Enter the nature of business');
  if (sheet.categories.length === 0) missing.push('Add at least one category of workers');
  else if (sheet.categories.every((category) => category.persons === 0))
    missing.push('Enter the number of persons');
  return missing;
}

/** The stage a case has reached, from its work. */
export function wcStage(record: {
  missing: readonly string[];
  rfqSent: boolean;
  quoted: boolean;
  recommended: boolean;
  placement: { policyNumber: string | null } | null;
}): WcStage {
  if (record.placement?.policyNumber) return 'PLACED';
  if (record.placement) return 'PLACEMENT_SLIP';
  if (record.recommended) return 'QCR';
  if (record.quoted) return 'QUOTES';
  if (record.rfqSent) return 'RFQ';
  return record.missing.length === 0 ? 'RFQ' : 'DATA_SHEET';
}
