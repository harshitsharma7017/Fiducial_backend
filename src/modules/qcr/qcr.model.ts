import {
  MAIL_RESULTS,
  QUOTE_OPTIONS,
  type MailResult,
  type QuoteOption,
} from '../../shared/index.ts';
import { Schema, model, type Types } from 'mongoose';

/** A case's QCR (QC-3, QC-6): the broker's part, its approval and the mails to the insured. */
export interface QcrDoc {
  _id: Types.ObjectId;
  proposalId: Types.ObjectId;
  recommendedInsurerId: Types.ObjectId | null;
  recommendedOption: QuoteOption | null;
  recommendation: string | null;
  remarks: string | null;
  paymentInFavourOf: string | null;
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
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const noId = { _id: false, versionKey: false as const, strict: true as const };

const qcrSchema = new Schema<QcrDoc>(
  {
    proposalId: { type: Schema.Types.ObjectId, ref: 'Proposal', required: true },
    recommendedInsurerId: { type: Schema.Types.ObjectId, ref: 'Insurer', default: null },
    recommendedOption: { type: String, enum: [...QUOTE_OPTIONS, null], default: null },
    recommendation: { type: String, default: null },
    remarks: { type: String, default: null },
    paymentInFavourOf: { type: String, default: null },
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
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { collection: 'qcrs', timestamps: true, strict: 'throw', minimize: false },
);

qcrSchema.index({ proposalId: 1 }, { unique: true });

export const QcrModel = model<QcrDoc>('Qcr', qcrSchema);
