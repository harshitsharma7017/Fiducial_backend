import { z } from 'zod';
import {
  CursorSchema,
  DecimalStringSchema,
  IsoDateTimeSchema,
  LimitSchema,
  ObjectIdSchema,
  blankAsNull,
  paginatedSchema,
} from './common.ts';
import { RISK_TYPES, RiskTypeSchema, type RiskType } from './risk-types.ts';

export const RISK_GRADES = ['RG1', 'RG2', 'RG3', 'RG4', 'RG5', 'RG6', 'RG7', 'RG8', 'RG9'] as const;
export const RiskGradeSchema = z.enum(RISK_GRADES);
export type RiskGrade = z.infer<typeof RiskGradeSchema>;

/**
 * AIFT earthquake zones as numbered in the pincode master.
 * Zone 1 is the occupancy sheet's "Zone I" column (highest EQ rates); zone 4 is "Zone IV" (lowest).
 */
export const EQ_ZONES = [1, 2, 3, 4] as const;
export type EqZone = (typeof EQ_ZONES)[number];
export const EqZoneSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
export const EQ_ZONE_LABELS: Record<EqZone, string> = {
  1: 'Zone I',
  2: 'Zone II',
  3: 'Zone III',
  4: 'Zone IV',
};

export const MASTER_TYPES = ['OCCUPANCY', 'PINCODE'] as const;
export const MasterTypeSchema = z.enum(MASTER_TYPES);
export type MasterType = z.infer<typeof MasterTypeSchema>;

/** DRAFT after import, ACTIVE once an admin activates it, SUPERSEDED when a newer version is activated. */
export const MASTER_VERSION_STATUSES = ['DRAFT', 'ACTIVE', 'SUPERSEDED'] as const;
export const MasterVersionStatusSchema = z.enum(MASTER_VERSION_STATUSES);
export type MasterVersionStatus = z.infer<typeof MasterVersionStatusSchema>;

/** TAC occupancy codes are text: the sheet mixes numbers and values such as 1001_2. */
export const TacCodeSchema = z
  .string()
  .trim()
  .min(1, 'Enter an occupancy code')
  .max(20, 'Occupancy code is too long')
  .regex(/^[A-Za-z0-9_./-]+$/, 'Occupancy codes contain only letters, digits and _ . / -');

export const PincodeValueSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Enter a 6-digit pincode');

/** Minimum EQ rates per mille by zone. zone1 = "Zone I" ... zone4 = "Zone IV". */
export const ZoneRatesSchema = z.object({
  zone1: DecimalStringSchema.nullable(),
  zone2: DecimalStringSchema.nullable(),
  zone3: DecimalStringSchema.nullable(),
  zone4: DecimalStringSchema.nullable(),
});
export type ZoneRates = z.infer<typeof ZoneRatesSchema>;

export const OccupancySchema = z.object({
  id: ObjectIdSchema,
  versionId: ObjectIdSchema,
  serialNo: z.number().int().nullable(),
  tacCode: z.string(),
  description: z.string(),
  riskGrade: RiskGradeSchema.nullable(),
  /** IIB rate per mille. Null when the sheet holds text instead of a rate (see iibRateNote). */
  iibRate: DecimalStringSchema.nullable(),
  iibRateNote: z.string().nullable(),
  fireRiskType: RiskTypeSchema.nullable(),
  terrorismRiskType: RiskTypeSchema.nullable(),
  minStfiRate: DecimalStringSchema.nullable(),
  minEqRates: ZoneRatesSchema,
});
export type Occupancy = z.infer<typeof OccupancySchema>;

/** EQ rates per mille by risk type for one pincode. */
export const EqRatesSchema = z.object({
  residential: DecimalStringSchema.nullable(),
  nonIndustrial: DecimalStringSchema.nullable(),
  industrial: DecimalStringSchema.nullable(),
});
export type EqRates = z.infer<typeof EqRatesSchema>;

export const EQ_RATE_KEY_BY_RISK_TYPE: Record<RiskType, keyof EqRates> = {
  RESIDENTIAL: 'residential',
  NON_INDUSTRIAL: 'nonIndustrial',
  INDUSTRIAL: 'industrial',
};

export const PincodeRecordSchema = z.object({
  id: ObjectIdSchema,
  versionId: ObjectIdSchema,
  pincode: z.string(),
  state: z.string(),
  district: z.string(),
  eqZone: EqZoneSchema.nullable(),
  eqRates: EqRatesSchema,
});
export type PincodeRecord = z.infer<typeof PincodeRecordSchema>;

export const MasterVersionStatsSchema = z.object({
  rowsRead: z.number().int(),
  recordsImported: z.number().int(),
  rowsSkipped: z.number().int(),
  warningCount: z.number().int(),
  errorCount: z.number().int(),
});
export type MasterVersionStats = z.infer<typeof MasterVersionStatsSchema>;

export const MasterVersionSchema = z.object({
  id: ObjectIdSchema,
  type: MasterTypeSchema,
  status: MasterVersionStatusSchema,
  sourceFileName: z.string(),
  sourceSha256: z.string(),
  importedBy: ObjectIdSchema.nullable(),
  importedAt: IsoDateTimeSchema,
  effectiveFrom: IsoDateTimeSchema.nullable(),
  effectiveTo: IsoDateTimeSchema.nullable(),
  activatedBy: ObjectIdSchema.nullable(),
  activatedAt: IsoDateTimeSchema.nullable(),
  stats: MasterVersionStatsSchema,
});
export type MasterVersion = z.infer<typeof MasterVersionSchema>;

export const OccupancySearchQuerySchema = z.strictObject({
  q: z.string().trim().max(100, 'Search text is too long').optional(),
  limit: LimitSchema,
  cursor: CursorSchema.optional(),
});
export type OccupancySearchQuery = z.infer<typeof OccupancySearchQuerySchema>;

export const OccupancyListResponseSchema = paginatedSchema(OccupancySchema);
export type OccupancyListResponse = z.infer<typeof OccupancyListResponseSchema>;

export const TacCodeParamsSchema = z.strictObject({ tacCode: TacCodeSchema });
export const PincodeParamsSchema = z.strictObject({ pincode: PincodeValueSchema });

export const MasterVersionListQuerySchema = z.strictObject({
  type: MasterTypeSchema.optional(),
  status: MasterVersionStatusSchema.optional(),
  limit: LimitSchema,
  cursor: CursorSchema.optional(),
});
export type MasterVersionListQuery = z.infer<typeof MasterVersionListQuerySchema>;

export const MasterVersionListResponseSchema = paginatedSchema(MasterVersionSchema);
export type MasterVersionListResponse = z.infer<typeof MasterVersionListResponseSchema>;

export const MasterVersionIdParamsSchema = z.strictObject({ id: ObjectIdSchema });

export const ActivateMasterVersionRequestSchema = z.strictObject({
  /** Date (YYYY-MM-DD, read as midnight IST) or date-time. Defaults to the time of activation. */
  effectiveFrom: z.union([z.iso.date(), z.iso.datetime({ offset: true })]).optional(),
});
export type ActivateMasterVersionRequest = z.infer<typeof ActivateMasterVersionRequestSchema>;

// Master upload (Import data page) and download

/** Largest IIB workbook accepted, in bytes (the client's file is about 0.75 MB). */
export const MASTER_WORKBOOK_MAX_BYTES = 20 * 1024 * 1024;

export const MasterImportQuerySchema = z.strictObject({
  /** Checks the workbook and reports without saving. Defaults to true; pass false to import. */
  dryRun: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  /** The uploaded file's name, kept on the new versions. */
  fileName: z.string().trim().min(1).max(200, 'File name is too long').default('IIB master.xlsx'),
});
export type MasterImportQuery = z.infer<typeof MasterImportQuerySchema>;

export const MasterImportResultSchema = z.object({
  dryRun: z.boolean(),
  sourceFileName: z.string(),
  /** A problem with the file itself (wrong sheets or headers); nothing else is filled in then. */
  fileError: z.string().nullable(),
  occupancy: MasterVersionStatsSchema.nullable(),
  pincode: MasterVersionStatsSchema.nullable(),
  /** The validation report as text: data issues found, row by row. */
  reportText: z.string().nullable(),
  /** This exact file was imported before, so importing it again creates no new versions. */
  alreadyImported: z.boolean(),
  /** The versions created (DRAFT) or found (already imported). Empty on a dry run. */
  versions: z.array(MasterVersionSchema),
});
export type MasterImportResult = z.infer<typeof MasterImportResultSchema>;

export const MasterWorkbookQuerySchema = z.strictObject({
  /** true returns the empty workbook (headers only) instead of the active masters. */
  template: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});

// Editing the active masters (Admin). Corrections change the active version in place and are
// audited with every field's old and new value; bulk changes are uploaded as a new version.

/** A rate per mille as typed: up to 4 digits before the point and 6 after. */
export const MasterRateSchema = z
  .string()
  .trim()
  .regex(/^\d{1,4}(\.\d{1,6})?$/, 'Enter a rate per mille, for example 0.05');

const OptionalRateSchema = blankAsNull(MasterRateSchema);

/** A select's value: "" for none. */
function optionalChoice<T extends readonly [string, ...string[]]>(values: T, message: string) {
  return z
    .enum([...values, ''] as unknown as readonly [T[number] | '', ...(T[number] | '')[]], {
      error: message,
    })
    .nullable()
    .transform((value) => (value ? (value as T[number]) : null));
}

const OptionalRiskTypeSchema = optionalChoice(RISK_TYPES, 'Choose a risk type');

export const OccupancyInputSchema = z.strictObject({
  description: z
    .string()
    .trim()
    .min(1, 'Enter the occupancy description')
    .max(500, 'Description is too long'),
  riskGrade: optionalChoice(RISK_GRADES, 'Choose a risk grade from RG1 to RG9'),
  /** Per mille. Null when the master gives text instead (iibRateNote). */
  iibRate: OptionalRateSchema,
  iibRateNote: blankAsNull(z.string().trim().max(300, 'Note is too long')),
  fireRiskType: OptionalRiskTypeSchema,
  terrorismRiskType: OptionalRiskTypeSchema,
  minStfiRate: OptionalRateSchema,
  minEqRates: z.strictObject({
    zone1: OptionalRateSchema,
    zone2: OptionalRateSchema,
    zone3: OptionalRateSchema,
    zone4: OptionalRateSchema,
  }),
});
/** Every editable field is sent; the TAC code is the key and does not change. */
export const UpdateOccupancyRequestSchema = OccupancyInputSchema;
export type UpdateOccupancyRequest = z.infer<typeof UpdateOccupancyRequestSchema>;
export const CreateOccupancyRequestSchema = OccupancyInputSchema.extend({ tacCode: TacCodeSchema });
export type CreateOccupancyRequest = z.infer<typeof CreateOccupancyRequestSchema>;
/** What an occupancy form holds before parsing: blank fields are "". */
export type OccupancyFormValues = z.input<typeof CreateOccupancyRequestSchema>;

const EqZoneInputSchema = z
  .union([EqZoneSchema, z.enum(['1', '2', '3', '4', '']), z.null()], {
    error: 'Choose an earthquake zone from I to IV',
  })
  .transform((value): EqZone | null =>
    value === null || value === '' ? null : (Number(value) as EqZone),
  );

export const PincodeInputSchema = z.strictObject({
  state: z.string().trim().min(1, 'Enter the state').max(100, 'State is too long'),
  district: z.string().trim().min(1, 'Enter the district').max(100, 'District is too long'),
  eqZone: EqZoneInputSchema,
  eqRates: z.strictObject({
    residential: OptionalRateSchema,
    nonIndustrial: OptionalRateSchema,
    industrial: OptionalRateSchema,
  }),
});
/** Every editable field is sent; the pincode is the key and does not change. */
export const UpdatePincodeRequestSchema = PincodeInputSchema;
export type UpdatePincodeRequest = z.infer<typeof UpdatePincodeRequestSchema>;
export const CreatePincodeRequestSchema = PincodeInputSchema.extend({
  pincode: PincodeValueSchema,
});
export type CreatePincodeRequest = z.infer<typeof CreatePincodeRequestSchema>;
/** What a pincode form holds before parsing: blank fields are "". */
export type PincodeFormValues = z.input<typeof CreatePincodeRequestSchema>;

/** Pincodes in order. q is the start of a pincode, or words in the district or state. */
export const PincodeListQuerySchema = z.strictObject({
  q: z.string().trim().max(100, 'Search text is too long').optional(),
  limit: LimitSchema,
  /** The last pincode of the previous page. */
  cursor: PincodeValueSchema.optional(),
});
export type PincodeListQuery = z.infer<typeof PincodeListQuerySchema>;

export const PincodeListResponseSchema = paginatedSchema(PincodeRecordSchema);
export type PincodeListResponse = z.infer<typeof PincodeListResponseSchema>;

/** The master version a value was read from. */
export const MasterVersionRefSchema = z.object({
  id: ObjectIdSchema,
  type: MasterTypeSchema,
  sourceFileName: z.string(),
  effectiveFrom: IsoDateTimeSchema.nullable(),
  activatedAt: IsoDateTimeSchema.nullable(),
});
export type MasterVersionRef = z.infer<typeof MasterVersionRefSchema>;
