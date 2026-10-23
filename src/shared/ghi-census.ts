import { z } from 'zod';
import { MemberPrivateFieldSchema } from './masking.ts';
import { IsoDateTimeSchema, ObjectIdSchema, blankAsNull } from './common.ts';
import { SearchTextSchema } from './clients.ts';
import { GhiRupeesSchema } from './ghi.ts';

// The employee census of a GHI case (G3) and its summary (G4). Members are added one by one or
// imported from the census template; every change is checked against the family rules of the
// case's Data Sheet and its age limits.

export const GHI_RELATIONSHIPS = [
  'SELF',
  'SPOUSE',
  'CHILD',
  'FATHER',
  'MOTHER',
  'FATHER_IN_LAW',
  'MOTHER_IN_LAW',
] as const;
export const GhiRelationshipSchema = z.enum(GHI_RELATIONSHIPS);
export type GhiRelationship = z.infer<typeof GhiRelationshipSchema>;
export const GHI_RELATIONSHIP_LABELS: Record<GhiRelationship, string> = {
  SELF: 'Self (employee)',
  SPOUSE: 'Spouse',
  CHILD: 'Child',
  FATHER: 'Father',
  MOTHER: 'Mother',
  FATHER_IN_LAW: 'Father-in-law',
  MOTHER_IN_LAW: 'Mother-in-law',
};

/**
 * What the census template accepts for each relationship (compared ignoring case, spaces, dots
 * and hyphens). The first is what the template's drop-down offers.
 */
export const GHI_RELATIONSHIP_ALIASES: Record<GhiRelationship, readonly string[]> = {
  SELF: ['Self', 'Employee', 'E', 'Emp', 'Member'],
  SPOUSE: ['Spouse', 'Wife', 'Husband', 'S'],
  CHILD: ['Child', 'Son', 'Daughter', 'Kid', 'C'],
  FATHER: ['Father', 'F'],
  MOTHER: ['Mother', 'M'],
  FATHER_IN_LAW: ['Father-in-law', 'Father in law', 'FIL'],
  MOTHER_IN_LAW: ['Mother-in-law', 'Mother in law', 'MIL'],
};

export const GHI_GENDERS = ['MALE', 'FEMALE', 'OTHER'] as const;
export const GhiGenderSchema = z.enum(GHI_GENDERS);
export type GhiGender = z.infer<typeof GhiGenderSchema>;
export const GHI_GENDER_LABELS: Record<GhiGender, string> = {
  MALE: 'Male',
  FEMALE: 'Female',
  OTHER: 'Other',
};
export const GHI_GENDER_ALIASES: Record<GhiGender, readonly string[]> = {
  MALE: ['Male', 'M'],
  FEMALE: ['Female', 'F'],
  OTHER: ['Other', 'O', 'Transgender'],
};

/** The census columns, in the template's order, with the field names errors refer to. */
export const GHI_CENSUS_COLUMNS = [
  { key: 'employeeId', header: 'Employee ID', required: true },
  { key: 'name', header: 'Name', required: true },
  { key: 'gender', header: 'Gender', required: true },
  { key: 'dateOfBirth', header: 'Date of Birth', required: true },
  { key: 'relationship', header: 'Relationship', required: true },
  { key: 'dateOfJoining', header: 'Date of Joining', required: false },
  { key: 'sumInsured', header: 'Sum Insured', required: false },
] as const;
export type GhiCensusField = (typeof GHI_CENSUS_COLUMNS)[number]['key'];
export const GHI_CENSUS_FIELDS = GHI_CENSUS_COLUMNS.map((column) => column.key) as [
  GhiCensusField,
  ...GhiCensusField[],
];
export const GHI_CENSUS_FIELD_LABELS: Record<GhiCensusField, string> = Object.fromEntries(
  GHI_CENSUS_COLUMNS.map((column) => [column.key, column.header]),
) as Record<GhiCensusField, string>;
export const GHI_CENSUS_SHEET = 'Census';
/** Rows per census file. */
export const MAX_GHI_CENSUS_ROWS = 10_000;
export const MAX_GHI_CENSUS_BYTES = 10 * 1024 * 1024;

/** One member as typed on screen. Dates are YYYY-MM-DD. */
export const GhiMemberInputSchema = z.strictObject({
  employeeId: z
    .string()
    .trim()
    .min(1, 'Enter the employee ID')
    .max(40, 'Use at most 40 characters')
    .regex(/^[A-Za-z0-9][A-Za-z0-9/_.-]*$/, 'Use letters, digits, / _ . or -'),
  name: z.string().trim().min(1, 'Enter the name').max(120, 'This is too long'),
  gender: GhiGenderSchema,
  dateOfBirth: z.iso.date({ error: 'Enter the date of birth' }),
  relationship: GhiRelationshipSchema,
  dateOfJoining: blankAsNull(z.iso.date({ error: 'Enter a date' })),
  sumInsured: blankAsNull(GhiRupeesSchema),
});
export type GhiMemberInput = z.infer<typeof GhiMemberInputSchema>;
export type GhiMemberFormValues = z.input<typeof GhiMemberInputSchema>;

export const GhiMemberSchema = z.object({
  id: ObjectIdSchema,
  employeeId: z.string(),
  name: z.string(),
  gender: GhiGenderSchema,
  /** Null when withheld (see `hidden`). */
  dateOfBirth: z.iso.date().nullable(),
  relationship: GhiRelationshipSchema,
  dateOfJoining: z.iso.date().nullable(),
  /** As entered: a family floater's dependants may leave it blank (they share the employee's). */
  sumInsured: z.string().nullable(),
  /** In completed years on the case's age reference date. */
  age: z.number().int(),
  source: z.enum(['MANUAL', 'IMPORT']),
  updatedAt: IsoDateTimeSchema,
  /** Fields withheld from this user (no permission to see them). */
  hidden: z.array(MemberPrivateFieldSchema).optional(),
});
export type GhiMember = z.infer<typeof GhiMemberSchema>;

export const GhiMemberListQuerySchema = z.strictObject({
  q: SearchTextSchema.optional(),
  relationship: GhiRelationshipSchema.optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
});
export type GhiMemberListQuery = z.infer<typeof GhiMemberListQuerySchema>;

export const GhiMemberListResponseSchema = z.object({
  items: z.array(GhiMemberSchema),
  total: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
});
export type GhiMemberListResponse = z.infer<typeof GhiMemberListResponseSchema>;

export const GhiMemberParamsSchema = z.strictObject({
  id: ObjectIdSchema,
  memberId: ObjectIdSchema,
});

/** A problem with one field of a member or census row, worded for the person fixing it. */
export const GhiCensusIssueSchema = z.object({
  field: z.enum(GHI_CENSUS_FIELDS).nullable(),
  message: z.string(),
  /** N3: an ERROR keeps the row out of the import; a WARNING does not. Missing means ERROR. */
  severity: z.enum(['ERROR', 'WARNING']).optional(),
  /** N3: what to change. */
  fix: z.string().optional(),
  code: z.string().optional(),
});
export type GhiCensusIssue = z.infer<typeof GhiCensusIssueSchema>;

// Summary (G4)

/** Age bands, in completed years on the case's age reference date. */
export const GHI_AGE_BANDS = [
  { key: '0-18', label: '0–18', min: 0, max: 18 },
  { key: '19-35', label: '19–35', min: 19, max: 35 },
  { key: '36-45', label: '36–45', min: 36, max: 45 },
  { key: '46-55', label: '46–55', min: 46, max: 55 },
  { key: '56-65', label: '56–65', min: 56, max: 65 },
  { key: '66+', label: '66+', min: 66, max: null },
] as const;
export type GhiAgeBand = (typeof GHI_AGE_BANDS)[number]['key'];

export const GhiCensusSummarySchema = z.object({
  /** Employees (Self rows). */
  employees: z.number().int(),
  /** Every member: employees and dependants. */
  lives: z.number().int(),
  byRelationship: z.record(GhiRelationshipSchema, z.number().int()),
  byAgeBand: z.array(z.object({ band: z.string(), label: z.string(), lives: z.number().int() })),
  /** Lives per sum insured (each member at the sum insured that covers them). */
  bySumInsured: z.array(
    z.object({ sumInsured: z.string(), families: z.number().int(), lives: z.number().int() }),
  ),
  /**
   * Family floater: the employees' (family) sums insured added up; individual: every member's.
   * Null until the Data Sheet chooses the coverage type.
   */
  totalSumInsured: z.string().nullable(),
  coverageType: z.enum(['FLOATER', 'INDIVIDUAL']).nullable(),
  ageReferenceDate: z.iso.date(),
  averageAge: z.string().nullable(),
  /** The Data Sheet's declared employee count, when it differs from the census. */
  declaredEmployees: z.number().int().nullable(),
  /** Members whose sum insured is missing although the coverage needs it. */
  missingSumInsured: z.number().int(),
  revision: z.number().int(),
  /** GTLI only: the free cover limit asked for, and the members above it (Requirement 5.3). */
  freeCoverLimit: z.string().nullable().optional(),
  aboveFreeCoverLimit: z.number().int().optional(),
  /** N4: the age band set the bands come from; null for the standard bands. */
  ageBands: z.object({ name: z.string(), revision: z.number().int() }).nullable().optional(),
  /** N4: lives in no band of the case's set, and lives with no valid date of birth. */
  outsideAgeBands: z.number().int().optional(),
  ageUnknown: z.number().int().optional(),
});
export type GhiCensusSummary = z.infer<typeof GhiCensusSummarySchema>;

// Import (G3): upload, preview with row errors, correct rows, then import by an explicit policy.

/**
 * How a checked file is imported. ALL_VALID imports only when every row passes; VALID_ONLY
 * imports the rows that pass and leaves the others (a dependant whose employee's row fails is
 * left out with it). Either way it runs in one transaction, re-checked against the census.
 */
export const GHI_IMPORT_POLICIES = ['ALL_VALID', 'VALID_ONLY'] as const;
export type GhiImportPolicy = (typeof GHI_IMPORT_POLICIES)[number];
export const GHI_IMPORT_POLICY_LABELS: Record<GhiImportPolicy, string> = {
  ALL_VALID: 'Import only if every row is valid',
  VALID_ONLY: 'Import the valid rows, leave the rest',
};

export const GHI_IMPORT_STATUSES = ['PREVIEW', 'IMPORTED', 'DISCARDED'] as const;
export type GhiImportStatus = (typeof GHI_IMPORT_STATUSES)[number];

/** A row's values as text, as they are in the file or as corrected. */
export const GhiCensusRowValuesSchema = z.strictObject(
  Object.fromEntries(
    GHI_CENSUS_COLUMNS.map((column) => [column.key, z.string().trim().max(200)]),
  ) as Record<GhiCensusField, z.ZodString>,
);
export type GhiCensusRowValues = z.infer<typeof GhiCensusRowValuesSchema>;

export const GhiImportRowSchema = z.object({
  /** The row number in Excel. */
  row: z.number().int(),
  values: GhiCensusRowValuesSchema,
  issues: z.array(GhiCensusIssueSchema),
  valid: z.boolean(),
  /** Corrected on screen after the upload. */
  corrected: z.boolean(),
  /** Imported (once the file is imported). */
  imported: z.boolean(),
});
export type GhiImportRow = z.infer<typeof GhiImportRowSchema>;

export const GhiCensusImportSchema = z.object({
  id: ObjectIdSchema,
  fileName: z.string(),
  status: z.enum(GHI_IMPORT_STATUSES),
  /** Problems with the file as a whole (missing columns, unreadable workbook). */
  fileIssues: z.array(z.string()),
  rows: z.array(GhiImportRowSchema),
  counts: z.object({
    rows: z.number().int(),
    valid: z.number().int(),
    invalid: z.number().int(),
    imported: z.number().int(),
  }),
  policy: z.enum(GHI_IMPORT_POLICIES).nullable(),
  uploadedAt: IsoDateTimeSchema,
  uploadedBy: z.string(),
  importedAt: IsoDateTimeSchema.nullable(),
  /** N3 (additive): file warnings, the mode the preview was checked under, the import's counts. */
  fileWarnings: z.array(z.string()).optional(),
  mode: z.enum(['ADD_NEW_ONLY', 'ADD_AND_UPDATE']).nullable().optional(),
  result: z
    .object({
      added: z.number().int(),
      updated: z.number().int(),
      unchanged: z.number().int(),
      skipped: z.number().int(),
      identitiesCreated: z.number().int(),
      identitiesReused: z.number().int(),
    })
    .nullable()
    .optional(),
});
export type GhiCensusImport = z.infer<typeof GhiCensusImportSchema>;

export const GhiImportListResponseSchema = z.object({
  items: z.array(
    GhiCensusImportSchema.pick({
      id: true,
      fileName: true,
      status: true,
      counts: true,
      policy: true,
      uploadedAt: true,
      uploadedBy: true,
      importedAt: true,
    }),
  ),
});

export const GhiImportParamsSchema = z.strictObject({
  id: ObjectIdSchema,
  importId: ObjectIdSchema,
});
export const GhiImportRowParamsSchema = z.strictObject({
  id: ObjectIdSchema,
  importId: ObjectIdSchema,
  row: z.coerce
    .number()
    .int()
    .min(2)
    .max(MAX_GHI_CENSUS_ROWS + 1),
});

export const GhiCensusUploadQuerySchema = z.strictObject({
  fileName: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[^\\/:*?"<>|\r\n]+$/, 'The file name has characters that are not allowed'),
});

export const CorrectGhiImportRowRequestSchema = z.strictObject({
  values: GhiCensusRowValuesSchema,
});

export const CommitGhiImportRequestSchema = z.strictObject({
  policy: z.enum(GHI_IMPORT_POLICIES),
  /** N3 (optional): without it, GMC imports as before (design D8). */
  mode: z.enum(['ADD_NEW_ONLY', 'ADD_AND_UPDATE']).optional(),
});

/** N3 (optional): the preview of a GMC file under an import mode. */
export const GhiImportPreviewQuerySchema = z.strictObject({
  mode: z.enum(['ADD_NEW_ONLY', 'ADD_AND_UPDATE']).optional(),
});

export const GhiCommitResultSchema = z.object({
  imported: z.number().int(),
  skipped: z.number().int(),
  import: GhiCensusImportSchema,
  summary: GhiCensusSummarySchema,
});
export type GhiCommitResult = z.infer<typeof GhiCommitResultSchema>;
