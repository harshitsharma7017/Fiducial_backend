import { z } from 'zod';
import { MemberPrivateFieldSchema } from './masking.ts';
import { IsoDateTimeSchema, ObjectIdSchema, blankAsNull } from './common.ts';
import { EbProductSchema, type EbProduct } from './eb-products.ts';
import {
  NOMINEE_RELATIONSHIP_ALIASES,
  NomineeRelationshipSchema,
  NomineeSchema,
  nomineeRequiredFor,
  type NomineeRequirement,
} from './eb-nominees.ts';
import { PositiveRupeesSchema, salaryInputOf, type SumInsuredBasis } from './eb-requirements.ts';
import { planRelationships, type PlanSlot } from './family-plans.ts';
import { GhiRupeesSchema } from './ghi.ts';
import {
  GHI_IMPORT_POLICIES,
  GHI_IMPORT_STATUSES,
  GHI_RELATIONSHIP_ALIASES,
  GhiMemberInputSchema,
  GhiRelationshipSchema,
  type GhiCensusField,
  type GhiRelationship,
} from './ghi-census.ts';

// The Employee Benefits census (N3): the product templates' columns, the header aliases an upload
// accepts, a row as text, the issue shape (errors and warnings, each with its fix) and the import
// by policy and mode. GMC's own census contract (ghi-census.ts) is unchanged.

export const EB_CENSUS_FIELDS = [
  'employeeId',
  'name',
  'gender',
  'dateOfBirth',
  'relationship',
  'dateOfJoining',
  'sumInsured',
  'annualSalary',
  'monthlySalary',
  'nomineeName',
  'nomineeRelationship',
  'nomineeDateOfBirth',
  'nomineeAge',
] as const;
export type EbCensusField = (typeof EB_CENSUS_FIELDS)[number];
/** Fields added by N5 and N6: rows stored before them read these as blank. */
export const EB_LATER_CENSUS_FIELDS = [
  'monthlySalary',
  'nomineeName',
  'nomineeRelationship',
  'nomineeDateOfBirth',
  'nomineeAge',
] as const satisfies readonly EbCensusField[];
export const NOMINEE_FIELDS = [
  'nomineeName',
  'nomineeRelationship',
  'nomineeDateOfBirth',
  'nomineeAge',
] as const satisfies readonly EbCensusField[];
export const EbCensusFieldSchema = z.enum(EB_CENSUS_FIELDS);

export const EB_CENSUS_FIELD_LABELS: Record<EbCensusField, string> = {
  employeeId: 'Employee ID',
  name: 'Name',
  gender: 'Gender',
  dateOfBirth: 'Date of Birth',
  relationship: 'Relationship',
  dateOfJoining: 'Date of Joining',
  sumInsured: 'Sum Insured',
  annualSalary: 'Annual Salary',
  monthlySalary: 'Monthly Salary',
  nomineeName: 'Nominee Name',
  nomineeRelationship: 'Nominee Relationship',
  nomineeDateOfBirth: 'Nominee Date of Birth',
  nomineeAge: 'Nominee Age',
};

/**
 * How a template column is required (design D15): filled on every row, filled on the employee's
 * (Self) rows, or not required. A column of either required level must be in an uploaded file.
 */
export const COLUMN_REQUIREMENTS = ['ALWAYS', 'EMPLOYEE_ROW', 'NO'] as const;
export type ColumnRequirement = (typeof COLUMN_REQUIREMENTS)[number];
export const COLUMN_REQUIREMENT_LABELS: Record<ColumnRequirement, string> = {
  ALWAYS: 'Yes',
  EMPLOYEE_ROW: 'Yes, on the employee’s row',
  NO: 'No',
};

export interface TemplateColumn {
  key: EbCensusField;
  header: string;
  required: ColumnRequirement;
  help: string;
}

/** The value a relationship takes in a template's drop-down (the first alias). */
export const relationshipValueOf = (relationship: GhiRelationship) =>
  GHI_RELATIONSHIP_ALIASES[relationship][0] ?? relationship;

/** The Relationship values of a template: the slots' relationships; none when only Self. */
export function relationshipValues(
  slots: readonly Pick<PlanSlot, 'relationships'>[],
): GhiRelationship[] {
  const accepted = planRelationships(slots);
  return accepted.length === 1 && accepted[0] === 'SELF' ? [] : accepted;
}

/** "Unknown" when no case is chosen, or the case's basis is not chosen yet (Requirement 19.2). */
export type TemplateBasis = SumInsuredBasis | 'UNKNOWN';

/**
 * A template's Census columns, in order (Requirements 19.1 and 19.2): the Relationship column
 * only when the plan accepts dependants; for GPA and GTLI, Sum Insured for a flat or graded basis,
 * Annual Salary for a multiple of salary, and both (not required) when the basis is unknown.
 */
export function templateColumns(
  product: EbProduct,
  slots: readonly Pick<PlanSlot, 'relationships'>[],
  basis: TemplateBasis,
  options: {
    dependantsOwnAmount?: boolean;
    /** GPA and GTLI: who needs a nominee (N5, N6); nominee columns unless NOT_REQUIRED. */
    nominees?: NomineeRequirement;
  } = {},
): TemplateColumn[] {
  const values = relationshipValues(slots);
  const columns: TemplateColumn[] = [
    {
      key: 'employeeId',
      header: EB_CENSUS_FIELD_LABELS.employeeId,
      required: 'ALWAYS',
      help: 'The employee’s ID, the same on every member of the family. Letters, digits, / _ . or -, up to 40.',
    },
    {
      key: 'name',
      header: EB_CENSUS_FIELD_LABELS.name,
      required: 'ALWAYS',
      help: 'The insured member’s full name, up to 120 characters.',
    },
    {
      key: 'gender',
      header: EB_CENSUS_FIELD_LABELS.gender,
      required: 'ALWAYS',
      help: 'Male, Female or Other (M, F, O accepted).',
    },
    {
      key: 'dateOfBirth',
      header: EB_CENSUS_FIELD_LABELS.dateOfBirth,
      required: 'ALWAYS',
      help: 'DD/MM/YYYY, day first. Not in the future.',
    },
  ];
  if (values.length > 0) {
    columns.push({
      key: 'relationship',
      header: EB_CENSUS_FIELD_LABELS.relationship,
      required: 'ALWAYS',
      help: `${values.map(relationshipValueOf).join(', ')}. Add the employee’s own row (Self) too.`,
    });
  }
  columns.push({
    key: 'dateOfJoining',
    header: EB_CENSUS_FIELD_LABELS.dateOfJoining,
    required: 'NO',
    help: 'The employee’s date of joining, DD/MM/YYYY. Not in the future.',
  });
  const sumInsured = (required: ColumnRequirement, help: string): TemplateColumn => ({
    key: 'sumInsured',
    header: EB_CENSUS_FIELD_LABELS.sumInsured,
    required,
    help,
  });
  const salary = (required: ColumnRequirement, help: string): TemplateColumn => ({
    key: 'annualSalary',
    header: EB_CENSUS_FIELD_LABELS.annualSalary,
    required,
    help,
  });
  if (product === 'GMC') {
    columns.push(
      sumInsured(
        'EMPLOYEE_ROW',
        'Whole rupees, for example 500000. Required on the employee’s row; on every row for individual cover.',
      ),
    );
    return columns;
  }
  if (basis === 'UNKNOWN') {
    columns.push(
      sumInsured(
        'NO',
        'Whole rupees, for example 500000, when the case uses a flat or graded basis.',
      ),
      salary('NO', 'Whole rupees a year, when the sum insured is a multiple of salary.'),
    );
  } else if (basis.kind === 'SALARY_MULTIPLE') {
    if (salaryInputOf(basis) === 'MONTHLY') {
      columns.push({
        key: 'monthlySalary',
        header: EB_CENSUS_FIELD_LABELS.monthlySalary,
        required: 'EMPLOYEE_ROW',
        help: 'The employee’s monthly salary in whole rupees; annual CTC = monthly × 12, and the sum assured is worked out from it.',
      });
    } else {
      columns.push(
        salary(
          'EMPLOYEE_ROW',
          'The employee’s annual salary in whole rupees; the sum insured is worked out from it.',
        ),
      );
    }
    // A GPA dependant with its own amount needs a sum insured column (Requirement 4.5).
    if (options.dependantsOwnAmount && values.length > 0) {
      columns.push(sumInsured('NO', 'Dependants only: their own sum insured in whole rupees.'));
    }
  } else {
    columns.push(
      sumInsured(
        'EMPLOYEE_ROW',
        basis.kind === 'FLAT'
          ? `Whole rupees: ${basis.amount} for every employee.`
          : `Whole rupees: one of ${basis.amounts.join(', ')}.`,
      ),
    );
  }
  const nominees = options.nominees;
  if (nominees && nominees !== 'NOT_REQUIRED') {
    const required: ColumnRequirement = nominees === 'EVERY_MEMBER' ? 'ALWAYS' : 'EMPLOYEE_ROW';
    const who = nomineeRequiredFor(nominees, 'SPOUSE') ? 'every member' : 'the employee’s own row';
    columns.push(
      {
        key: 'nomineeName',
        header: EB_CENSUS_FIELD_LABELS.nomineeName,
        required,
        help: `Who receives the claim, on ${who}. Up to 120 characters.`,
      },
      {
        key: 'nomineeRelationship',
        header: EB_CENSUS_FIELD_LABELS.nomineeRelationship,
        required,
        help: 'The nominee’s relationship to the insured: Spouse, Son, Daughter, Father, Mother, Brother, Sister or Other.',
      },
      {
        key: 'nomineeDateOfBirth',
        header: EB_CENSUS_FIELD_LABELS.nomineeDateOfBirth,
        required: 'NO',
        help: 'DD/MM/YYYY, day first. Give the date of birth or the age.',
      },
      {
        key: 'nomineeAge',
        header: EB_CENSUS_FIELD_LABELS.nomineeAge,
        required: 'NO',
        help: 'Completed years, 0 to 120, when the date of birth is not known.',
      },
    );
  }
  return columns;
}

/** The headers an upload accepts for each field (GMC's, plus salary). Case and spaces ignored. */
export const EB_HEADER_ALIASES: Record<EbCensusField, readonly string[]> = {
  employeeId: ['Employee ID', 'Emp ID', 'Employee Code', 'Emp Code', 'Employee No', 'Emp No'],
  name: ['Name', 'Member Name', 'Insured Name', 'Full Name', 'Employee Name'],
  gender: ['Gender', 'Sex'],
  dateOfBirth: ['Date of Birth', 'DOB', 'Birth Date'],
  relationship: ['Relationship', 'Relation', 'Relationship with Employee'],
  dateOfJoining: ['Date of Joining', 'DOJ', 'Joining Date'],
  sumInsured: ['Sum Insured', 'SI', 'Sum Assured'],
  annualSalary: ['Annual Salary', 'CTC', 'Salary', 'Annual CTC'],
  monthlySalary: ['Monthly Salary', 'Monthly CTC', 'Salary per Month', 'Monthly Gross'],
  nomineeName: ['Nominee Name', 'Nominee'],
  nomineeRelationship: ['Nominee Relationship', 'Relationship with Nominee', 'Nominee Relation'],
  nomineeDateOfBirth: ['Nominee Date of Birth', 'Nominee DOB'],
  nomineeAge: ['Nominee Age'],
};

/** The nominee relationship values a template lists. */
export const NOMINEE_RELATIONSHIP_VALUES = Object.values(NOMINEE_RELATIONSHIP_ALIASES).map(
  (aliases) => aliases[0]!,
);

/** A header as compared: without a trailing " *", ignoring case, spaces, dots, _ and -. */
export function headerKey(text: string): string {
  return text
    .replace(/\*+\s*$/, '')
    .toLowerCase()
    .replace(/[\s._-]+/g, '');
}

const FIELD_BY_HEADER = new Map<string, EbCensusField>(
  Object.entries(EB_HEADER_ALIASES).flatMap(([field, aliases]) =>
    aliases.map((alias) => [headerKey(alias), field as EbCensusField] as const),
  ),
);

/** The column of each field found in a header row (first one wins), and the headers not known. */
export function resolveHeaders(headers: readonly string[]): {
  columns: Map<EbCensusField, number>;
  unknown: string[];
} {
  const columns = new Map<EbCensusField, number>();
  const unknown: string[] = [];
  headers.forEach((header, index) => {
    if (!header.trim()) return;
    const field = FIELD_BY_HEADER.get(headerKey(header));
    if (!field) unknown.push(header);
    else if (!columns.has(field)) columns.set(field, index);
  });
  return { columns, unknown };
}

/** A row's values as text, as in the file or as corrected (every field, blank when absent). */
export const EbCensusRowValuesSchema = z.strictObject(
  Object.fromEntries(
    EB_CENSUS_FIELDS.map((field) => [
      field,
      (EB_LATER_CENSUS_FIELDS as readonly string[]).includes(field)
        ? z.string().trim().max(200).default('')
        : z.string().trim().max(200),
    ]),
  ) as Record<EbCensusField, z.ZodString>,
);
export type EbCensusRowValues = z.infer<typeof EbCensusRowValuesSchema>;

export function emptyRowValues(): EbCensusRowValues {
  return Object.fromEntries(EB_CENSUS_FIELDS.map((field) => [field, ''])) as EbCensusRowValues;
}

const GMC_FIELDS: ReadonlySet<string> = new Set([
  'employeeId',
  'name',
  'gender',
  'dateOfBirth',
  'relationship',
  'dateOfJoining',
  'sumInsured',
]);
/** A field as the GMC contract names it; null for the fields GMC has no column for. */
export function ghiFieldOf(field: EbCensusField | null): GhiCensusField | null {
  return field !== null && GMC_FIELDS.has(field) ? (field as GhiCensusField) : null;
}

/** Stored row values, with the fields added later (N5, N6) blank when missing. */
export function rowValuesOf(stored: Partial<EbCensusRowValues>): EbCensusRowValues {
  return { ...emptyRowValues(), ...stored };
}

/** One member as typed on screen: the GMC member plus the annual salary (GPA and GTLI). */
export const EbMemberInputSchema = GhiMemberInputSchema.extend({
  annualSalary: blankAsNull(GhiRupeesSchema).optional().default(null),
  /** GTLI or GPA with a monthly salary input (N6). */
  monthlySalary: blankAsNull(PositiveRupeesSchema).optional().default(null),
  /** GPA and GTLI (N5, N6); one nominee per member. */
  nominee: NomineeSchema.nullable().optional().default(null),
});
export type EbMemberInput = z.infer<typeof EbMemberInputSchema>;
export type EbMemberFormValues = z.input<typeof EbMemberInputSchema>;

export const ISSUE_SEVERITIES = ['ERROR', 'WARNING'] as const;
export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number];

/**
 * One problem of a census row or member (Requirement 20.8): where it is, the value as read, what
 * is wrong and how to fix it. An ERROR keeps the row out of the import; a WARNING does not.
 */
export const EbCensusIssueSchema = z.object({
  row: z.number().int().nullable(),
  employeeId: z.string().nullable(),
  name: z.string().nullable(),
  relationship: GhiRelationshipSchema.nullable(),
  field: EbCensusFieldSchema.nullable(),
  value: z.string().nullable(),
  message: z.string(),
  fix: z.string(),
  severity: z.enum(ISSUE_SEVERITIES),
  code: z.string(),
});
export type EbCensusIssue = z.infer<typeof EbCensusIssueSchema>;

/** Add new only: a changed match is an error. Add and update: it updates three fields. */
export const EB_IMPORT_MODES = ['ADD_NEW_ONLY', 'ADD_AND_UPDATE'] as const;
export type EbImportMode = (typeof EB_IMPORT_MODES)[number];
export const EbImportModeSchema = z.enum(EB_IMPORT_MODES);
export const EB_IMPORT_MODE_LABELS: Record<EbImportMode, string> = {
  ADD_NEW_ONLY: 'Add new only',
  ADD_AND_UPDATE: 'Add and update',
};
/**
 * The only fields "Add and update" changes on a matching member (Requirement 22.9), with the
 * monthly salary and the nominee added by N5 and N6.
 */
export const EB_UPDATABLE_FIELDS = [
  'sumInsured',
  'annualSalary',
  'dateOfJoining',
  'monthlySalary',
  'nominee',
] as const;

export const EB_ROW_MATCHES = ['NEW', 'SAME', 'CHANGED'] as const;
export type EbRowMatch = (typeof EB_ROW_MATCHES)[number];

export const EbImportRowSchema = z.object({
  row: z.number().int(),
  values: EbCensusRowValuesSchema,
  issues: z.array(EbCensusIssueSchema),
  /** No ERROR issue (warnings allowed), or already imported. */
  valid: z.boolean(),
  warnings: z.number().int(),
  corrected: z.boolean(),
  imported: z.boolean(),
  /** How the row matches the census under the preview's mode; null in the GMC legacy check. */
  match: z.enum(EB_ROW_MATCHES).nullable(),
});
export type EbImportRow = z.infer<typeof EbImportRowSchema>;

export const EbImportResultSchema = z.object({
  added: z.number().int(),
  updated: z.number().int(),
  unchanged: z.number().int(),
  skipped: z.number().int(),
  identitiesCreated: z.number().int(),
  identitiesReused: z.number().int(),
  leftOut: z.array(
    z.object({
      row: z.number().int(),
      employeeId: z.string().nullable(),
      issues: z.array(EbCensusIssueSchema),
    }),
  ),
});
export type EbImportResult = z.infer<typeof EbImportResultSchema>;

export const EbCensusImportSchema = z.object({
  id: ObjectIdSchema,
  product: EbProductSchema,
  fileName: z.string(),
  status: z.enum(GHI_IMPORT_STATUSES),
  /** Problems with the file as a whole (refused uploads never keep a preview). */
  fileIssues: z.array(z.string()),
  /** Warnings about the file as a whole, for example no product or plan marker (20.13). */
  fileWarnings: z.array(z.string()),
  /** The fields whose columns the file has. */
  columns: z.array(EbCensusFieldSchema),
  /** The product, plan and version the file was made for, when it carries the marker. */
  marker: z
    .object({ product: EbProductSchema, planCode: z.string(), planVersion: z.number().int() })
    .nullable(),
  /** The mode the preview was checked under; null for the GMC legacy check. */
  mode: EbImportModeSchema.nullable(),
  rows: z.array(EbImportRowSchema),
  counts: z.object({
    rows: z.number().int(),
    valid: z.number().int(),
    invalid: z.number().int(),
    warnings: z.number().int(),
    imported: z.number().int(),
  }),
  policy: z.enum(GHI_IMPORT_POLICIES).nullable(),
  result: EbImportResultSchema.nullable(),
  uploadedAt: IsoDateTimeSchema,
  uploadedBy: z.string(),
  importedAt: IsoDateTimeSchema.nullable(),
});
export type EbCensusImport = z.infer<typeof EbCensusImportSchema>;

export const EbImportListResponseSchema = z.object({
  items: z.array(
    EbCensusImportSchema.pick({
      id: true,
      product: true,
      fileName: true,
      status: true,
      policy: true,
      mode: true,
      result: true,
      uploadedAt: true,
      uploadedBy: true,
      importedAt: true,
    }).extend({ importedCount: z.number().int() }),
  ),
});

export const EbImportPreviewQuerySchema = z.strictObject({
  mode: EbImportModeSchema.optional(),
});

export const CorrectEbImportRowRequestSchema = z.strictObject({
  values: EbCensusRowValuesSchema,
  mode: EbImportModeSchema.optional(),
});

/** The import: a policy is required, with no default (22.1); the mode is optional (22.2). */
export const CommitEbImportRequestSchema = z.strictObject({
  policy: z.enum(GHI_IMPORT_POLICIES, { error: 'Choose how to import: ALL_VALID or VALID_ONLY' }),
  mode: EbImportModeSchema.optional(),
});
export type CommitEbImportRequest = z.infer<typeof CommitEbImportRequestSchema>;

export const EbCommitResultSchema = z.object({
  result: EbImportResultSchema,
  import: EbCensusImportSchema,
});
export type EbCommitResult = z.infer<typeof EbCommitResultSchema>;

/** The template download (Requirement 19.3): a product and a plan, optionally a case. */
export const EbCensusTemplateQuerySchema = z.strictObject({
  product: EbProductSchema,
  planId: ObjectIdSchema.optional(),
  caseId: ObjectIdSchema.optional(),
});
export type EbCensusTemplateQuery = z.infer<typeof EbCensusTemplateQuerySchema>;

/** The provisional notice on every template and next to every download (Requirement 19.5). */
export const PROVISIONAL_TEMPLATE_NOTICE =
  'Provisional Fiducial template: this is not the client’s confirmed census format, which has not been received (open question 15).';

/** The rows per census file (as GMC). */
export const MAX_EB_CENSUS_ROWS = 10_000;

/** A census member of a GPA or GTLI case as the API returns it. */
export const EbMemberSchema = z.object({
  id: ObjectIdSchema,
  employeeId: z.string(),
  name: z.string(),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER']),
  /** Null when withheld (see `hidden`). */
  dateOfBirth: z.iso.date().nullable(),
  relationship: GhiRelationshipSchema,
  dateOfJoining: z.iso.date().nullable(),
  sumInsured: z.string().nullable(),
  annualSalary: z.string().nullable(),
  monthlySalary: z.string().nullable(),
  nominee: z
    .object({
      name: z.string(),
      relationship: NomineeRelationshipSchema,
      dateOfBirth: z.iso.date().nullable(),
      age: z.number().int().nullable(),
    })
    .nullable(),
  /** The sum insured that covers the member (worked out from salary or percentage). */
  coveredSumInsured: z.string().nullable(),
  /** How that amount is worked out, for example "50% of the employee’s ₹10,00,000". */
  coverageBasis: z.string().nullable(),
  age: z.number().int(),
  source: z.enum(['MANUAL', 'IMPORT']),
  employeeIdentityId: ObjectIdSchema.nullable(),
  updatedAt: IsoDateTimeSchema,
  /** Fields withheld from this user (no permission to see them). */
  hidden: z.array(MemberPrivateFieldSchema).optional(),
});
export type EbMember = z.infer<typeof EbMemberSchema>;

export const EbMemberListResponseSchema = z.object({
  items: z.array(EbMemberSchema),
  total: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
});
export type EbMemberListResponse = z.infer<typeof EbMemberListResponseSchema>;

/** A family with fewer members in a slot than its minimum (Requirement 18.9). */
export const FamilyShortfallSchema = z.object({
  employeeId: z.string(),
  employeeKey: z.string(),
  slot: z.string(),
  count: z.number().int(),
  min: z.number().int(),
  message: z.string(),
});
export type FamilyShortfall = z.infer<typeof FamilyShortfallSchema>;

export const EbCensusIssuesResponseSchema = z.object({
  items: z.array(z.object({ member: EbMemberSchema, issues: z.array(EbCensusIssueSchema) })),
  shortfalls: z.array(FamilyShortfallSchema),
});
export type EbCensusIssuesResponse = z.infer<typeof EbCensusIssuesResponseSchema>;
