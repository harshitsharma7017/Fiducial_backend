import {
  MASTER_TYPES,
  MASTER_VERSION_STATUSES,
  type MasterType,
  type MasterVersionStats,
  type MasterVersionStatus,
} from '../../shared/index.ts';
import { Schema, model, type Types } from 'mongoose';

export interface MasterVersionDoc {
  _id: Types.ObjectId;
  type: MasterType;
  status: MasterVersionStatus;
  sourceFileName: string;
  /** SHA-256 of the imported workbook, used to detect a repeated import of the same file. */
  sourceSha256: string;
  importedBy: Types.ObjectId | null;
  importedAt: Date;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  activatedBy: Types.ObjectId | null;
  activatedAt: Date | null;
  stats: MasterVersionStats;
  /** The validation report for this master, kept for review before activation. */
  report: unknown;
  createdAt: Date;
  updatedAt: Date;
}

const statsSchema = new Schema<MasterVersionStats>(
  {
    rowsRead: { type: Number, required: true },
    recordsImported: { type: Number, required: true },
    rowsSkipped: { type: Number, required: true },
    warningCount: { type: Number, required: true },
    errorCount: { type: Number, required: true },
  },
  { _id: false },
);

const masterVersionSchema = new Schema<MasterVersionDoc>(
  {
    type: { type: String, enum: MASTER_TYPES, required: true },
    status: { type: String, enum: MASTER_VERSION_STATUSES, required: true, default: 'DRAFT' },
    sourceFileName: { type: String, required: true },
    sourceSha256: { type: String, required: true },
    importedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    importedAt: { type: Date, required: true },
    effectiveFrom: { type: Date, default: null },
    effectiveTo: { type: Date, default: null },
    activatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    activatedAt: { type: Date, default: null },
    stats: { type: statsSchema, required: true },
    report: { type: Schema.Types.Mixed, default: null },
  },
  { collection: 'master_versions', timestamps: true, strict: 'throw', minimize: false },
);

// At most one ACTIVE version per master type.
masterVersionSchema.index(
  { type: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: 'ACTIVE' }, name: 'one_active_per_type' },
);
masterVersionSchema.index({ type: 1, sourceSha256: 1 });
masterVersionSchema.index({ type: 1, importedAt: -1 });

export const MasterVersionModel = model<MasterVersionDoc>('MasterVersion', masterVersionSchema);
