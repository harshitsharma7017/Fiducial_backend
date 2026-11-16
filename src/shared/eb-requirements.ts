import { z } from 'zod';
import { EbAddonsSchema } from './addon-lists.ts';
import { blankAsNull } from './common.ts';
import { NomineeRequirementSchema } from './eb-nominees.ts';
import { formatIndianNumber } from './format.ts';
import {
  GHI_RELATIONSHIP_LABELS,
  GhiRelationshipSchema,
  type GhiRelationship,
} from './ghi-census.ts';
import {
  GHI_CLAIM_YEARS,
  GhiClaimYearInputSchema,
  GhiRequirementsInputSchema,
  type GhiAgeGroup,
} from './ghi.ts';

// The GPA and GTLI Data Sheets (N1, Requirements 4 and 5). Each is a strict object: a field of
// GMC or of the other product is refused, naming it. Amounts are decimal strings, never JSON
// numbers. The client has not given the GPA and GTLI rules, so what a case asks for is a
// setting of the case (open questions 7, 9, 10, 11, 13).

const OptionalText = (max: number) => blankAsNull(z.string().trim().max(max, 'This is too long'));

/** Whole rupees above 0, 1 to 13 digits. */
export const PositiveRupeesSchema = z
  .string({ error: 'Enter whole rupees as text, for example "500000"' })
  .trim()
  .regex(/^\d{1,13}$/, 'Enter whole rupees, digits only')
  // The regex has reported anything that is not digits; BigInt would throw on it.
  .refine((value) => !/^\d+$/.test(value) || BigInt(value) > 0n, 'Enter an amount above 0');

/** Above 0, at most 100, at most 2 decimal places (multipliers and percentages). */
const UpToHundred = (what: string) =>
  z
    .string({ error: `Enter the ${what} as text, for example "3" or "2.5"` })
    .trim()
    .regex(/^\d{1,3}(\.\d{1,2})?$/, `Enter the ${what} with at most 2 decimal places`)
    .refine(
      (value) => Number(value) > 0 && Number(value) <= 100,
      `Enter a ${what} above 0 and at most 100`,
    );

/** A multiple of annual salary: a technical bound of 100, not a client rule. */
export const MultiplierSchema = UpToHundred('multiplier');
export const PercentSchema = UpToHundred('percentage');

export const SUM_INSURED_BASES = ['FLAT', 'GRADED', 'SALARY_MULTIPLE'] as const;
export type SumInsuredBasisKind = (typeof SUM_INSURED_BASES)[number];
export const SUM_INSURED_BASIS_LABELS: Record<SumInsuredBasisKind, string> = {
  FLAT: 'One flat amount',
  GRADED: 'Graded (one of several amounts)',
  SALARY_MULTIPLE: 'Multiple of annual salary',
};
export const MAX_GRADED_AMOUNTS = 10;

/**
 * Which salary the census gives for a multiple of salary (N6): the annual salary, or the monthly
 * salary from which the annual CTC is worked out as monthly × 12. Missing (a Data Sheet saved
 * before N6) is ANNUAL.
 */
export const SALARY_INPUTS = ['ANNUAL', 'MONTHLY'] as const;
export type SalaryInput = (typeof SALARY_INPUTS)[number];
export const SALARY_INPUT_LABELS: Record<SalaryInput, string> = {
  ANNUAL: 'Annual salary (CTC) in the census',
  MONTHLY: 'Monthly salary in the census (annual CTC = monthly × 12)',
};
export const salaryInputOf = (basis: { salaryInput?: SalaryInput }): SalaryInput =>
  basis.salaryInput ?? 'ANNUAL';

/** How each member's sum insured is set (open question 7); only the chosen basis's values. */
export const SumInsuredBasisSchema = z
  .discriminatedUnion(
    'kind',
    [
      z.strictObject({ kind: z.literal('FLAT'), amount: PositiveRupeesSchema }),
      z.strictObject({
        kind: z.literal('GRADED'),
        amounts: z
          .array(PositiveRupeesSchema)
          .min(1, 'Enter at least one amount')
          .max(MAX_GRADED_AMOUNTS, `Offer at most ${MAX_GRADED_AMOUNTS} amounts`)
          .refine(
            (values) =>
              new Set(values.map((value) => value.replace(/^0+(?=\d)/, ''))).size === values.length,
            'List each amount once',
          ),
      }),
      z.strictObject({
        kind: z.literal('SALARY_MULTIPLE'),
        multiplier: MultiplierSchema,
        maximum: PositiveRupeesSchema.nullable(),
        salaryInput: z.enum(SALARY_INPUTS).optional(),
      }),
    ],
    { error: 'Choose the sum insured basis: FLAT, GRADED or SALARY_MULTIPLE' },
  )
  .nullable();
export type SumInsuredBasis = NonNullable<z.infer<typeof SumInsuredBasisSchema>>;

/**
 * Options 2–4 of a GPA or GTLI case (client review 4/11/2026, as in GMC and Fire): other sum
 * insured bases each insurer quotes besides Option 1 (the Data Sheet's own basis).
 */
export const EB_MAX_QUOTE_OPTIONS = 4;
const EbQuoteOptionsSchema = z
  .array(z.strictObject({ basis: SumInsuredBasisSchema.unwrap() }))
  .max(EB_MAX_QUOTE_OPTIONS - 1, `Offer at most ${EB_MAX_QUOTE_OPTIONS} options`)
  .default([]);

export interface EbQuoteOptionInfo {
  /** 1 to 4. */
  option: number;
  label: string;
  /** The option's sum insured basis (Option 1: the Data Sheet's). */
  basis: SumInsuredBasis | null;
}

/** The options each insurer quotes: Option 1 (the Data Sheet's basis), then those added. */
export function ebQuoteOptions(requirements: {
  sumInsuredBasis: SumInsuredBasis | null;
  quoteOptions?: readonly { basis: SumInsuredBasis }[] | undefined;
}): EbQuoteOptionInfo[] {
  return [
    { option: 1, label: 'Option 1', basis: requirements.sumInsuredBasis },
    ...(requirements.quoteOptions ?? []).map((item, index) => ({
      option: index + 2,
      label: `Option ${index + 2}`,
      basis: item.basis,
    })),
  ];
}

/** The GPA covers asked for (open question 10). */
export const GPA_COVERS = [
  'accidentalDeath',
  'permanentTotal',
  'permanentPartial',
  'temporaryTotal',
] as const;
export type GpaCover = (typeof GPA_COVERS)[number];
export const GPA_COVER_LABELS: Record<GpaCover, string> = {
  accidentalDeath: 'Accidental death',
  permanentTotal: 'Permanent total disablement',
  permanentPartial: 'Permanent partial disablement',
  temporaryTotal: 'Temporary total disablement',
};
export const COVER_CHOICES = ['REQUIRED', 'NOT_REQUIRED'] as const;
export type CoverChoice = (typeof COVER_CHOICES)[number];
export const COVER_CHOICE_LABELS: Record<CoverChoice, string> = {
  REQUIRED: 'Required',
  NOT_REQUIRED: 'Not required',
};
export const CoverChoiceSchema = z.enum(COVER_CHOICES).nullable();

/**
 * Covers added to a GPA case besides the four standard ones (alteration 3/11/2026: add and delete
 * in each cover). `id` keeps the insurer's quote terms attached to the right cover.
 */
export const MAX_CUSTOM_GPA_COVERS = 20;
export const GpaCustomCoverSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9]{1,16}$/, 'A cover id is letters and digits'),
  name: z.string().trim().min(1, 'Name the cover').max(120, 'This is too long'),
  choice: CoverChoiceSchema,
  /** The limit asked for, as the client states it (amount or text). */
  limit: OptionalText(200),
});
export type GpaCustomCover = z.infer<typeof GpaCustomCoverSchema>;

/** One cover of a case as the RFQ, the quotes and the QCR show it. */
export interface GpaCoverEntry {
  /** `covers.<standard key>` or `customCovers.<id>`: the field it is kept in. */
  key: string;
  label: string;
  choice: CoverChoice | null;
  limit: string | null;
  /** The standard cover it is, or null for an added one. */
  standard: GpaCover | null;
  /** The added cover's id. */
  customId: string | null;
}

/**
 * The covers of a case, in order: the standard ones not deleted, then the added ones. Cases saved
 * before covers could be added or deleted have all four standard covers.
 */
export function gpaCoverList(sheet: {
  covers: Record<GpaCover, CoverChoice | null>;
  removedCovers?: readonly GpaCover[] | undefined;
  customCovers?: readonly GpaCustomCover[] | undefined;
}): GpaCoverEntry[] {
  const removed = new Set(sheet.removedCovers ?? []);
  return [
    ...GPA_COVERS.filter((cover) => !removed.has(cover)).map((cover) => ({
      key: `covers.${cover}`,
      label: GPA_COVER_LABELS[cover],
      choice: sheet.covers[cover],
      limit: null,
      standard: cover,
      customId: null,
    })),
    ...(sheet.customCovers ?? []).map((cover) => ({
      key: `customCovers.${cover.id}`,
      label: cover.name,
      choice: cover.choice,
      limit: cover.limit,
      standard: null,
      customId: cover.id,
    })),
  ];
}

/** How a GPA dependant's sum insured is set (open question 11). */
export const DEPENDANT_BASES = [
  'EMPLOYEE_SUM_INSURED',
  'OWN_AMOUNT',
  'PERCENT_OF_EMPLOYEE',
  'BY_RELATIONSHIP',
] as const;
export type DependantBasisKind = (typeof DEPENDANT_BASES)[number];
export const DEPENDANT_BASIS_LABELS: Record<DependantBasisKind, string> = {
  EMPLOYEE_SUM_INSURED: 'The employee’s sum insured',
  OWN_AMOUNT: 'The dependant’s own amount (from the census)',
  PERCENT_OF_EMPLOYEE: 'A percentage of the employee’s sum insured',
  BY_RELATIONSHIP: 'A rule for each relationship (N5)',
};

/** One relationship's GPA cover rule (N5): a percentage, a fixed amount, the employee's, or own. */
export const RELATIONSHIP_RULE_KINDS = [
  'PERCENT_OF_EMPLOYEE',
  'FIXED_AMOUNT',
  'EMPLOYEE_SUM_INSURED',
  'OWN_AMOUNT',
] as const;
export type RelationshipRuleKind = (typeof RELATIONSHIP_RULE_KINDS)[number];
export const RELATIONSHIP_RULE_LABELS: Record<RelationshipRuleKind, string> = {
  PERCENT_OF_EMPLOYEE: 'A percentage of the employee’s sum insured',
  FIXED_AMOUNT: 'A fixed amount for each member',
  EMPLOYEE_SUM_INSURED: 'The employee’s sum insured',
  OWN_AMOUNT: 'The member’s own amount (from the census)',
};
const DependantRelationshipSchema = GhiRelationshipSchema.refine(
  (relationship) => relationship !== 'SELF',
  'The employee’s own cover is the sum insured basis, not a relationship rule',
);
export const RelationshipRuleSchema = z.discriminatedUnion(
  'kind',
  [
    z.strictObject({
      relationship: DependantRelationshipSchema,
      kind: z.literal('PERCENT_OF_EMPLOYEE'),
      percent: PercentSchema,
    }),
    z.strictObject({
      relationship: DependantRelationshipSchema,
      kind: z.literal('FIXED_AMOUNT'),
      amount: PositiveRupeesSchema,
    }),
    z.strictObject({
      relationship: DependantRelationshipSchema,
      kind: z.literal('EMPLOYEE_SUM_INSURED'),
    }),
    z.strictObject({ relationship: DependantRelationshipSchema, kind: z.literal('OWN_AMOUNT') }),
  ],
  {
    error: 'Choose the rule: PERCENT_OF_EMPLOYEE, FIXED_AMOUNT, EMPLOYEE_SUM_INSURED or OWN_AMOUNT',
  },
);
export type RelationshipRule = z.infer<typeof RelationshipRuleSchema>;

/**
 * The client's examples (spouse 50% of the employee's sum insured, each child ₹50,000), offered
 * as sample values to fill the rules with. They are not a rule of the application.
 */
export const GPA_SAMPLE_RELATIONSHIP_RULES: readonly RelationshipRule[] = [
  { relationship: 'SPOUSE', kind: 'PERCENT_OF_EMPLOYEE', percent: '50' },
  { relationship: 'CHILD', kind: 'FIXED_AMOUNT', amount: '50000' },
];

export const DependantBasisSchema = z
  .discriminatedUnion(
    'kind',
    [
      z.strictObject({ kind: z.literal('EMPLOYEE_SUM_INSURED') }),
      z.strictObject({ kind: z.literal('OWN_AMOUNT') }),
      z.strictObject({ kind: z.literal('PERCENT_OF_EMPLOYEE'), percent: PercentSchema }),
      z.strictObject({
        kind: z.literal('BY_RELATIONSHIP'),
        rules: z
          .array(RelationshipRuleSchema)
          .min(1, 'Add a rule for at least one relationship')
          .max(6, 'One rule per relationship')
          .refine(
            (rules) => new Set(rules.map((rule) => rule.relationship)).size === rules.length,
            'Give each relationship one rule',
          ),
      }),
    ],
    { error: 'Choose how dependants’ sums insured are set' },
  )
  .nullable();
export type DependantBasis = NonNullable<z.infer<typeof DependantBasisSchema>>;

/** The rule a dependant's cover follows: the basis itself, or the relationship's rule. */
export type DependantRule =
  | { kind: 'EMPLOYEE_SUM_INSURED' }
  | { kind: 'OWN_AMOUNT' }
  | { kind: 'PERCENT_OF_EMPLOYEE'; percent: string }
  | { kind: 'FIXED_AMOUNT'; amount: string };

/** The rule for a relationship; null when the basis is not chosen or has no rule for it. */
export function dependantRuleOf(
  basis: DependantBasis | null,
  relationship: GhiRelationship,
): DependantRule | null {
  if (basis === null) return null;
  if (basis.kind !== 'BY_RELATIONSHIP') return basis;
  const rule = basis.rules.find((item) => item.relationship === relationship);
  if (!rule) return null;
  switch (rule.kind) {
    case 'PERCENT_OF_EMPLOYEE':
      return { kind: rule.kind, percent: rule.percent };
    case 'FIXED_AMOUNT':
      return { kind: rule.kind, amount: rule.amount };
    default:
      return { kind: rule.kind };
  }
}

/** Whether some dependants give their own amount, so the census needs a Sum Insured column. */
export function dependantsGiveOwnAmount(basis: DependantBasis | null): boolean {
  if (basis === null) return false;
  if (basis.kind === 'OWN_AMOUNT') return true;
  return basis.kind === 'BY_RELATIONSHIP' && basis.rules.some((rule) => rule.kind === 'OWN_AMOUNT');
}

/** One line for a rule, for screens and documents. */
export function dependantRuleText(rule: DependantRule | null): string {
  if (rule === null) return 'No rule';
  switch (rule.kind) {
    case 'PERCENT_OF_EMPLOYEE':
      return `${rule.percent}% of the employee’s sum insured`;
    case 'FIXED_AMOUNT':
      return `₹${formatIndianNumber(rule.amount, 0)} each`;
    default:
      return RELATIONSHIP_RULE_LABELS[rule.kind];
  }
}

const shared = GhiRequirementsInputSchema.shape;
const ClaimsSchema = z
  .array(GhiClaimYearInputSchema)
  .max(GHI_CLAIM_YEARS, `Enter at most ${GHI_CLAIM_YEARS} years`);
const EmployeeCountSchema = z
  .number({ error: 'Enter a whole number' })
  .int('Enter a whole number')
  .min(1, 'Enter 1 or more')
  .max(1_000_000, 'Enter at most 1,000,000')
  .nullable();

function uniqueClaimYears(
  claims: readonly { policyYear: string }[],
  context: z.RefinementCtx,
): void {
  const years = claims.map((claim) => claim.policyYear);
  if (new Set(years).size !== years.length) {
    context.addIssue({ code: 'custom', path: ['claims'], message: 'Each policy year once' });
  }
}

export const GpaRequirementsInputSchema = z
  .strictObject({
    company: shared.company,
    employeeCount: EmployeeCountSchema,
    sumInsuredBasis: SumInsuredBasisSchema,
    quoteOptions: EbQuoteOptionsSchema,
    covers: z.strictObject(
      Object.fromEntries(GPA_COVERS.map((cover) => [cover, CoverChoiceSchema])) as Record<
        GpaCover,
        typeof CoverChoiceSchema
      >,
    ),
    temporaryTotal: z.strictObject({
      weeklyBenefit: PositiveRupeesSchema.nullable(),
      /** 1 to 520: a technical bound, not a client rule. */
      weeks: z.number().int('Enter a whole number').min(1).max(520).nullable(),
    }),
    /** Standard covers deleted from this case: not asked, not quoted, not compared. */
    removedCovers: z
      .array(z.enum(GPA_COVERS))
      .max(GPA_COVERS.length)
      .refine((values) => new Set(values).size === values.length, 'Each cover once')
      .default([]),
    customCovers: z
      .array(GpaCustomCoverSchema)
      .max(MAX_CUSTOM_GPA_COVERS, `Add at most ${MAX_CUSTOM_GPA_COVERS} covers`)
      .refine(
        (covers) => new Set(covers.map((cover) => cover.id)).size === covers.length,
        'Each cover once',
      )
      .default([]),
    otherCovers: OptionalText(1000),
    dependantBasis: DependantBasisSchema,
    /** Who needs a nominee (N5); missing: each employee's own row. */
    nominees: NomineeRequirementSchema.optional(),
    ageLimits: shared.ageLimits,
    ageReferenceDate: shared.ageReferenceDate,
    claims: ClaimsSchema,
    /** Add-on covers from the Employee Benefits add-on list. */
    addons: EbAddonsSchema,
    otherRequirements: OptionalText(2000),
  })
  .superRefine((input, context) => {
    uniqueClaimYears(input.claims, context);
    const names = new Set<string>();
    input.customCovers.forEach((cover, index) => {
      const key = cover.name.toLowerCase();
      const standard = GPA_COVERS.some((item) => GPA_COVER_LABELS[item].toLowerCase() === key);
      if (names.has(key) || standard) {
        context.addIssue({
          code: 'custom',
          path: ['customCovers', index, 'name'],
          message: 'There is already a cover with this name',
        });
      }
      names.add(key);
    });
    if (
      input.covers.temporaryTotal !== 'REQUIRED' ||
      input.removedCovers.includes('temporaryTotal')
    ) {
      for (const key of ['weeklyBenefit', 'weeks'] as const) {
        if (input.temporaryTotal[key] !== null) {
          context.addIssue({
            code: 'custom',
            path: ['temporaryTotal', key],
            message: 'Temporary total disablement is not Required: leave this blank',
          });
        }
      }
    }
  });
export type GpaRequirementsInput = z.infer<typeof GpaRequirementsInputSchema>;
export type GpaRequirementsFormValues = z.input<typeof GpaRequirementsInputSchema>;

export const GtliRequirementsInputSchema = z
  .strictObject({
    company: shared.company,
    employeeCount: EmployeeCountSchema,
    sumInsuredBasis: SumInsuredBasisSchema,
    quoteOptions: EbQuoteOptionsSchema,
    /** The free cover limit asked for: recorded and flagged, not enforced (open question 12). */
    freeCoverLimit: PositiveRupeesSchema.nullable(),
    /** Who needs a nominee (N6); missing: each employee's own row. */
    nominees: NomineeRequirementSchema.optional(),
    ageLimits: shared.ageLimits,
    ageReferenceDate: shared.ageReferenceDate,
    claims: ClaimsSchema,
    additionalBenefits: OptionalText(2000),
    /** Add-on covers from the Employee Benefits add-on list. */
    addons: EbAddonsSchema,
    otherRequirements: OptionalText(2000),
  })
  .superRefine((input, context) => uniqueClaimYears(input.claims, context));
export type GtliRequirementsInput = z.infer<typeof GtliRequirementsInputSchema>;
export type GtliRequirementsFormValues = z.input<typeof GtliRequirementsInputSchema>;

const noLimit = { min: null, max: null };
const noAgeLimits = (): Record<GhiAgeGroup, { min: number | null; max: number | null }> => ({
  employee: { ...noLimit },
  spouse: { ...noLimit },
  child: { ...noLimit },
  parent: { ...noLimit },
});
const noCompany = () => ({
  natureOfBusiness: null,
  contactName: null,
  contactEmail: null,
  contactPhone: null,
  locations: null,
});

export function emptyGpaRequirements(): GpaRequirementsInput {
  return {
    company: noCompany(),
    employeeCount: null,
    sumInsuredBasis: null,
    quoteOptions: [],
    covers: {
      accidentalDeath: null,
      permanentTotal: null,
      permanentPartial: null,
      temporaryTotal: null,
    },
    temporaryTotal: { weeklyBenefit: null, weeks: null },
    removedCovers: [],
    customCovers: [],
    otherCovers: null,
    dependantBasis: null,
    ageLimits: noAgeLimits(),
    ageReferenceDate: null,
    claims: [],
    addons: [],
    otherRequirements: null,
  };
}

export function emptyGtliRequirements(): GtliRequirementsInput {
  return {
    company: noCompany(),
    employeeCount: null,
    sumInsuredBasis: null,
    quoteOptions: [],
    freeCoverLimit: null,
    ageLimits: noAgeLimits(),
    ageReferenceDate: null,
    claims: [],
    additionalBenefits: null,
    addons: [],
    otherRequirements: null,
  };
}

/** An item the Data Sheet still needs before the RFQ, naming its field. */
export interface MissingItem {
  field: string;
  label: string;
}

function basisMissing(basis: SumInsuredBasis | null): MissingItem[] {
  if (basis === null) {
    return [
      {
        field: 'sumInsuredBasis',
        label: 'Sum insured basis (flat, graded or a multiple of salary)',
      },
    ];
  }
  switch (basis.kind) {
    case 'FLAT':
      return basis.amount
        ? []
        : [{ field: 'sumInsuredBasis.amount', label: 'The flat sum insured' }];
    case 'GRADED':
      return basis.amounts.length > 0
        ? []
        : [{ field: 'sumInsuredBasis.amounts', label: 'At least one graded sum insured' }];
    case 'SALARY_MULTIPLE':
      return basis.multiplier
        ? []
        : [{ field: 'sumInsuredBasis.multiplier', label: 'The multiple of annual salary' }];
  }
}

/** What the GPA Data Sheet still needs before the RFQ (Requirement 4.7). */
export function gpaMissing(
  input: GpaRequirementsInput,
  context: {
    planHasDependants: boolean;
    /** The dependant relationships the plan accepts: each needs a rule under BY_RELATIONSHIP. */
    dependantRelationships?: readonly GhiRelationship[];
  },
): MissingItem[] {
  const missing = basisMissing(input.sumInsuredBasis);
  for (const cover of gpaCoverList(input)) {
    if (cover.choice === null) {
      missing.push({ field: cover.key, label: `${cover.label}: Required or Not required` });
    }
  }
  if (context.planHasDependants && input.dependantBasis === null) {
    missing.push({ field: 'dependantBasis', label: 'How dependants’ sums insured are set' });
  }
  if (input.dependantBasis?.kind === 'BY_RELATIONSHIP') {
    const ruled = new Set(input.dependantBasis.rules.map((rule) => rule.relationship));
    for (const relationship of context.dependantRelationships ?? []) {
      if (relationship !== 'SELF' && !ruled.has(relationship)) {
        missing.push({
          field: 'dependantBasis.rules',
          label: `The cover rule for ${GHI_RELATIONSHIP_LABELS[relationship]} (the plan covers this relationship)`,
        });
      }
    }
  }
  return missing;
}

/** What the GTLI Data Sheet still needs before the RFQ (Requirement 5.6). */
export function gtliMissing(
  input: GtliRequirementsInput,
  context: { renewal: boolean },
): MissingItem[] {
  const missing: MissingItem[] = [];
  if (input.employeeCount === null) {
    missing.push({ field: 'employeeCount', label: 'Employees to be covered' });
  }
  missing.push(...basisMissing(input.sumInsuredBasis));
  if (context.renewal && input.claims.length === 0) {
    missing.push({ field: 'claims', label: 'Previous years’ premium and claims (renewal)' });
  }
  return missing;
}

/** The basis as one line, for documents and screens. */
export function basisText(basis: SumInsuredBasis | null): string {
  if (basis === null) return 'Not chosen';
  const rupees = (value: string) => `₹${formatIndianNumber(value, 0)}`;
  switch (basis.kind) {
    case 'FLAT':
      return `Flat: ${rupees(basis.amount)}`;
    case 'GRADED':
      return `Graded: ${basis.amounts.map(rupees).join(', ')}`;
    case 'SALARY_MULTIPLE':
      return `${basis.multiplier} × annual ${salaryInputOf(basis) === 'MONTHLY' ? 'CTC (monthly salary × 12)' : 'salary'}${basis.maximum ? `, at most ${rupees(basis.maximum)}` : ''}`;
  }
}
