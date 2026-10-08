import {
  MAIL_RESULTS,
  PLACED_DOCUMENT_KINDS,
  type MailResult,
  type PlacedDocumentKind,
} from '../../shared/index.ts';
import { Schema, model, type Types } from 'mongoose';

/**
 * A case's placement slip (one per case): the broker's remarks, the approval of exactly what was
 * shown, the mails to the insurer, and the policy or cover note the insurer issued.
 */
export interface PlacementSlipDoc {
  _id: Types.ObjectId;
  proposalId: Types.ObjectId;
  remarks: string | null;
  /** The approval, for the fingerprint of what was approved: any change after it voids it. */
  approval: { at: Date; by: Types.ObjectId; fingerprint: string } | null;
  sends: Array<{
    mailId: Types.ObjectId;
    sendId: string;
    at: Date;
    by: Types.ObjectId;
    to: string[];
    result: MailResult;
    error: string | null;
    fingerprint: string;
  }>;
  placed: {
    documentKind: PlacedDocumentKind;
    number: string;
    issuedOn: string;
    note: string | null;
    fileIds: Types.ObjectId[];
    recordedAt: Date;
    recordedBy: Types.ObjectId;
  } | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const noId = { _id: false, versionKey: false as const, strict: true as const };

const placementSlipSchema = new Schema<PlacementSlipDoc>(
  {
    proposalId: { type: Schema.Types.ObjectId, ref: 'Proposal', required: true },
    remarks: { type: String, default: null },
    approval: {
      type: new Schema(
        {
          at: { type: Date, required: true },
          by: { type: Schema.Types.ObjectId, ref: 'User', required: true },
          fingerprint: { type: String, required: true },
        },
        noId,
      ),
      default: null,
    },
    sends: [
      new Schema(
        {
          mailId: { type: Schema.Types.ObjectId, ref: 'MailLog', required: true },
          sendId: { type: String, required: true },
          at: { type: Date, required: true },
          by: { type: Schema.Types.ObjectId, ref: 'User', required: true },
          to: { type: [String], required: true },
          result: { type: String, enum: MAIL_RESULTS, required: true },
          error: { type: String, default: null },
          fingerprint: { type: String, required: true },
        },
        noId,
      ),
    ],
    placed: {
      type: new Schema(
        {
          documentKind: { type: String, enum: PLACED_DOCUMENT_KINDS, required: true },
          number: { type: String, required: true },
          issuedOn: { type: String, required: true },
          note: { type: String, default: null },
          fileIds: [{ type: Schema.Types.ObjectId, ref: 'PlacementFile' }],
          recordedAt: { type: Date, required: true },
          recordedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
        },
        noId,
      ),
      default: null,
    },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { collection: 'placement_slips', timestamps: true, strict: 'throw', minimize: false },
);

placementSlipSchema.index({ proposalId: 1 }, { unique: true });

export const PlacementSlipModel = model<PlacementSlipDoc>('PlacementSlip', placementSlipSchema);

/** The insurer's policy or cover note, kept as proof of the placement. */
export interface PlacementFileDoc {
  _id: Types.ObjectId;
  proposalId: Types.ObjectId;
  fileName: string;
  contentType: string;
  size: number;
  sha256: string;
  data: Buffer;
  uploadedBy: Types.ObjectId;
  createdAt: Date;
}

const placementFileSchema = new Schema<PlacementFileDoc>(
  {
    proposalId: { type: Schema.Types.ObjectId, ref: 'Proposal', required: true },
    fileName: { type: String, required: true },
    contentType: { type: String, required: true },
    size: { type: Number, required: true },
    sha256: { type: String, required: true },
    data: { type: Buffer, required: true },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  {
    collection: 'placement_files',
    timestamps: { createdAt: true, updatedAt: false },
    strict: 'throw',
  },
);

placementFileSchema.index({ proposalId: 1 });

export const PlacementFileModel = model<PlacementFileDoc>('PlacementFile', placementFileSchema);
