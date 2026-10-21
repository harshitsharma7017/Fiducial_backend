import {
  EB_CENSUS_FIELDS,
  EB_IMPORT_MODES,
  EB_PRODUCTS,
  GHI_GENDERS,
  GHI_IMPORT_POLICIES,
  GHI_IMPORT_STATUSES,
  GHI_RELATIONSHIPS,
  NOMINEE_RELATIONSHIPS,
  type GhiCensusIssue,
  type GhiCensusRowValues,
  type GhiGender,
  type GhiImportPolicy,
  type GhiImportStatus,
  type EbCensusField,
  type EbImportMode,
  type EbImportResult,
  type EbProduct,
  type GhiRelationship,
  type NomineeRelationship,
} from '../../shared/index.ts';
import { Schema, model, type Types } from 'mongoose';

export interface NomineeDoc {
  name: string;
  relationship: NomineeRelationship;
  dateOfBirth: string | null;
  age: number | null;
}

const nomineeSchema = new Schema<NomineeDoc>(
  {
    name: { type: String, required: true },
    relationship: { type: String, enum: NOMINEE_RELATIONSHIPS, required: true },
    dateOfBirth: { type: String, default: null, match: /^\d{4}-\d{2}-\d{2}$/ },
    age: { type: Number, default: null, min: 0, max: 120 },
  },
  { _id: false, versionKey: false, strict: true },
);

/** One insured life of a GHI case's census (G3): an employee or one of their dependants. */
export interface GhiMemberDoc {
  _id: Types.ObjectId;
  caseId: Types.ObjectId;
  employeeId: string;
  /** The employee ID upper-cased without spaces: a family's members share it. */
  employeeKey: string;
  name: string;
  /** Lower-case name with single spaces, for duplicate checks and search. */
  nameKey: string;
  gender: GhiGender;
  dateOfBirth: string;
  relationship: GhiRelationship;
  dateOfJoining: string | null;
  sumInsured: Types.Decimal128 | null;
  /** GPA/GTLI: whole rupees a year, when the sum insured is a multiple of salary (N1). */
  annualSalary?: Types.Decimal128 | null;
  /** GPA/GTLI: whole rupees a month, when the census gives the monthly salary (N6). */
  monthlySalary?: Types.Decimal128 | null;
  /** GPA/GTLI: the member's one nominee (N5, N6). */
  nominee?: NomineeDoc | null;
  /** Self members: the company's employee identity (N1, Requirement 17.2). */
  employeeIdentityId?: Types.ObjectId | null;
  source: 'MANUAL' | 'IMPORT';
  importId: Types.ObjectId | null;
  createdBy: Types.ObjectId;
  updatedBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const ghiMemberSchema = new Schema<GhiMemberDoc>(
  {
    caseId: { type: Schema.Types.ObjectId, ref: 'GhiCase', required: true },
    employeeId: { type: String, required: true },
    employeeKey: { type: String, required: true },
    name: { type: String, required: true },
    nameKey: { type: String, required: true },
    gender: { type: String, enum: GHI_GENDERS, required: true },
    dateOfBirth: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    relationship: { type: String, enum: GHI_RELATIONSHIPS, required: true },
    dateOfJoining: { type: String, default: null },
    sumInsured: { type: Schema.Types.Decimal128, default: null },
    annualSalary: { type: Schema.Types.Decimal128, default: undefined },
    monthlySalary: { type: Schema.Types.Decimal128, default: undefined },
    nominee: { type: nomineeSchema, default: undefined },
    employeeIdentityId: { type: Schema.Types.ObjectId, ref: 'EbEmployee', default: undefined },
    source: { type: String, enum: ['MANUAL', 'IMPORT'], required: true },
    importId: { type: Schema.Types.ObjectId, ref: 'GhiCensusImport', default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { collection: 'ghi_members', timestamps: true, strict: 'throw' },
);

ghiMemberSchema.index({ caseId: 1, employeeKey: 1, relationship: 1 });
ghiMemberSchema.index({ caseId: 1, nameKey: 1 });
// At most one employee (Self) row per employee ID per case, even under concurrent writes.
ghiMemberSchema.index(
  { caseId: 1, employeeKey: 1 },
  { unique: true, partialFilterExpression: { relationship: 'SELF' } },
);

// The members linked to an employee identity (only those that have one).
ghiMemberSchema.index(
  { employeeIdentityId: 1 },
  { partialFilterExpression: { employeeIdentityId: { $type: 'objectId' } } },
);

export const GhiMemberModel = model<GhiMemberDoc>('GhiMember', ghiMemberSchema);

/**
 * An uploaded census file (G3): its rows as text, kept so they can be corrected on screen and
 * checked again before the import. The file's hash stops the same file being imported twice.
 */
export interface GhiCensusImportDoc {
  _id: Types.ObjectId;
  caseId: Types.ObjectId;
  fileName: string;
  sha256: string;
  status: GhiImportStatus;
  fileIssues: string[];
  rows: Array<{
    row: number;
    values: GhiCensusRowValues;
    corrected: boolean;
    imported: boolean;
    /** The row's problems when the file was imported (rows left out); empty before. */
    issues: GhiCensusIssue[];
  }>;
  policy: GhiImportPolicy | null;
  /** N3 additions; missing on files uploaded before. */
  mode?: EbImportMode | null;
  columns?: EbCensusField[];
  fileWarnings?: string[];
  marker?: { product: EbProduct; planCode: string; planVersion: number } | null;
  result?: Omit<EbImportResult, 'leftOut'> | null;
  importedCount: number;
  uploadedBy: Types.ObjectId;
  importedAt: Date | null;
  importedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const noId = { _id: false, versionKey: false as const, strict: true as const };

/** The census import schema; GMC keeps ghi_census_imports, GPA/GTLI use its twin (design D4). */
function censusImportSchema(collection: string) {
  return new Schema<GhiCensusImportDoc>(
    {
      caseId: { type: Schema.Types.ObjectId, ref: 'GhiCase', required: true },
      fileName: { type: String, required: true },
      sha256: { type: String, required: true },
      status: { type: String, enum: GHI_IMPORT_STATUSES, required: true },
      fileIssues: { type: [String], default: [] },
      rows: [
        new Schema(
          {
            row: { type: Number, required: true },
            values: { type: Schema.Types.Mixed, required: true },
            corrected: { type: Boolean, required: true, default: false },
            imported: { type: Boolean, required: true, default: false },
            issues: { type: Schema.Types.Mixed, default: [] },
          },
          noId,
        ),
      ],
      policy: { type: String, enum: [...GHI_IMPORT_POLICIES, null], default: null },
      mode: { type: String, enum: [...EB_IMPORT_MODES, null], default: undefined },
      columns: { type: [{ type: String, enum: EB_CENSUS_FIELDS }], default: undefined },
      fileWarnings: { type: [String], default: undefined },
      marker: {
        type: new Schema(
          {
            product: { type: String, enum: EB_PRODUCTS, required: true },
            planCode: { type: String, required: true },
            planVersion: { type: Number, required: true },
          },
          noId,
        ),
        default: undefined,
      },
      result: {
        type: new Schema(
          {
            added: { type: Number, required: true },
            updated: { type: Number, required: true },
            unchanged: { type: Number, required: true },
            skipped: { type: Number, required: true },
            identitiesCreated: { type: Number, required: true },
            identitiesReused: { type: Number, required: true },
          },
          noId,
        ),
        default: undefined,
      },
      importedCount: { type: Number, required: true, default: 0 },
      uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
      importedAt: { type: Date, default: null },
      importedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    },
    { collection, timestamps: true, strict: 'throw', minimize: false },
  );
}

const ghiCensusImportSchema = censusImportSchema('ghi_census_imports');
ghiCensusImportSchema.index({ caseId: 1, _id: -1 });
// The same file can be imported into a case once.
ghiCensusImportSchema.index(
  { caseId: 1, sha256: 1 },
  { unique: true, partialFilterExpression: { status: 'IMPORTED' } },
);

export const GhiCensusImportModel = model<GhiCensusImportDoc>(
  'GhiCensusImport',
  ghiCensusImportSchema,
);

/**
 * GPA and GTLI census files (design D4): the same schema without the unique fingerprint index,
 * so the same file can be imported twice and report every row unchanged (Requirement 22.5).
 */
const ebCensusImportSchema = censusImportSchema('eb_census_imports');
ebCensusImportSchema.index({ caseId: 1, _id: -1 });

export const EbCensusImportModel = model<GhiCensusImportDoc>(
  'EbCensusImport',
  ebCensusImportSchema,
);
