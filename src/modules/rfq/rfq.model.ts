import { RFQ_VERSION_STATUSES, type RfqEdits, type RfqVersionStatus } from '../../shared/index.ts';
import { Schema, model, type Types } from 'mongoose';

// The RFQ of a case (R-2, R-5): the edits made on it, and its versions. A version keeps the case as
// it was generated from (for its preview) and the two files, so what is approved is what is sent.

/** The edits made on the RFQ of a case, one document per case. */
export interface RfqStateDoc {
  _id: Types.ObjectId;
  proposalId: Types.ObjectId;
  edits: RfqEdits;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const rfqStateSchema = new Schema<RfqStateDoc>(
  {
    proposalId: { type: Schema.Types.ObjectId, ref: 'Proposal', required: true },
    edits: { type: Schema.Types.Mixed, required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { collection: 'rfq_states', timestamps: true, strict: 'throw', minimize: false },
);
rfqStateSchema.index({ proposalId: 1 }, { unique: true });
export const RfqStateModel = model<RfqStateDoc>('RfqState', rfqStateSchema);

export interface RfqEventDoc {
  action: 'GENERATED' | 'SUBMITTED' | 'APPROVED' | 'RETURNED';
  at: Date;
  by: Types.ObjectId;
  /** A2/A1: the actor's role codes at the time of the event; undefined on older events. */
  byRoles?: string[];
  comment: string | null;
}

export interface RfqVersionDoc {
  _id: Types.ObjectId;
  proposalId: Types.ObjectId;
  version: number;
  status: RfqVersionStatus;
  layout: 'template' | 'built-in';
  /** The case (the API record) and the edits it was generated from. */
  record: Record<string, unknown>;
  edits: RfqEdits;
  /** What the RFQ was made from; a different one now means the case or the edits changed. */
  fingerprint: string;
  fileName: string;
  /** The version's Excel and PDF, kept in the file store (S3) under these keys. */
  xlsxKey: string | null;
  pdfKey: string | null;
  /** Legacy: the bytes of a version saved before files moved to S3 (npm run files:to-s3). */
  xlsx?: Buffer;
  pdf?: Buffer;
  events: RfqEventDoc[];
  createdBy: Types.ObjectId;
  createdAt: Date;
}

const rfqVersionSchema = new Schema<RfqVersionDoc>(
  {
    proposalId: { type: Schema.Types.ObjectId, ref: 'Proposal', required: true },
    version: { type: Number, required: true, min: 1 },
    status: { type: String, enum: RFQ_VERSION_STATUSES, required: true },
    layout: { type: String, enum: ['template', 'built-in'], required: true },
    record: { type: Schema.Types.Mixed, required: true },
    edits: { type: Schema.Types.Mixed, required: true },
    fingerprint: { type: String, required: true },
    fileName: { type: String, required: true },
    xlsxKey: { type: String, default: null },
    pdfKey: { type: String, default: null },
    xlsx: { type: Buffer, default: undefined },
    pdf: { type: Buffer, default: undefined },
    events: [
      new Schema(
        {
          action: {
            type: String,
            enum: ['GENERATED', 'SUBMITTED', 'APPROVED', 'RETURNED'],
            required: true,
          },
          at: { type: Date, required: true },
          by: { type: Schema.Types.ObjectId, ref: 'User', required: true },
          // A2/A1: role snapshot at the time of the event; not required, so older events stay valid.
          byRoles: { type: [String], default: undefined },
          comment: { type: String, default: null },
        },
        { _id: false, versionKey: false, strict: true },
      ),
    ],
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  {
    collection: 'rfq_versions',
    timestamps: { createdAt: true, updatedAt: false },
    strict: 'throw',
    minimize: false,
  },
);
// v1, v2, v3 per case: two generations at once cannot both be v2.
rfqVersionSchema.index({ proposalId: 1, version: 1 }, { unique: true });
export const RfqVersionModel = model<RfqVersionDoc>('RfqVersion', rfqVersionSchema);
