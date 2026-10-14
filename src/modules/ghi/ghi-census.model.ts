import {
  GHI_GENDERS,
  GHI_IMPORT_POLICIES,
  GHI_IMPORT_STATUSES,
  GHI_RELATIONSHIPS,
  type GhiCensusIssue,
  type GhiCensusRowValues,
  type GhiGender,
  type GhiImportPolicy,
  type GhiImportStatus,
  type GhiRelationship,
} from '../../shared/index.ts';
import { Schema, model, type Types } from 'mongoose';

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
  importedCount: number;
  uploadedBy: Types.ObjectId;
  importedAt: Date | null;
  importedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const noId = { _id: false, versionKey: false as const, strict: true as const };

const ghiCensusImportSchema = new Schema<GhiCensusImportDoc>(
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
    importedCount: { type: Number, required: true, default: 0 },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    importedAt: { type: Date, default: null },
    importedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { collection: 'ghi_census_imports', timestamps: true, strict: 'throw', minimize: false },
);

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
