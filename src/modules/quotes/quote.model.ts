import { QUOTE_OPTIONS, SECTION_CODES, type QuoteOption } from '../../shared/index.ts';
import { Schema, model, type Types } from 'mongoose';

// One document per version of an insurer's quote for one option of a case (Q-1, Q-4). Versions are
// never changed: a revision is a new version with its reason.

export interface QuoteDoc {
  _id: Types.ObjectId;
  proposalId: Types.ObjectId;
  insurerId: Types.ObjectId;
  option: QuoteOption;
  version: number;
  reason: string | null;
  sections: Array<{
    code: string;
    sumInsured: Types.Decimal128 | null;
    premium: Types.Decimal128 | null;
    premiumWithoutTerrorism: Types.Decimal128 | null;
  }>;
  terms: Array<{ name: string; accepted: boolean }>;
  deductibles: string | null;
  capacityPercent: Types.Decimal128 | null;
  conditions: string | null;
  validUntil: string | null;
  attachmentIds: Types.ObjectId[];
  /** The case's GST rate when the quote was recorded. */
  gstRatePercent: Types.Decimal128;
  createdBy: Types.ObjectId;
  createdAt: Date;
}

const money = { type: Schema.Types.Decimal128, default: null };
const text = { type: String, default: null };
const noId = { _id: false, versionKey: false as const, strict: true as const };

const quoteSchema = new Schema<QuoteDoc>(
  {
    proposalId: { type: Schema.Types.ObjectId, ref: 'Proposal', required: true },
    insurerId: { type: Schema.Types.ObjectId, ref: 'Insurer', required: true },
    option: { type: String, enum: QUOTE_OPTIONS, required: true },
    version: { type: Number, required: true, min: 1 },
    reason: text,
    sections: [
      new Schema(
        {
          code: { type: String, enum: SECTION_CODES, required: true },
          sumInsured: money,
          premium: money,
          premiumWithoutTerrorism: money,
        },
        noId,
      ),
    ],
    terms: [
      new Schema(
        { name: { type: String, required: true }, accepted: { type: Boolean, required: true } },
        noId,
      ),
    ],
    deductibles: text,
    capacityPercent: money,
    conditions: text,
    validUntil: text,
    attachmentIds: [{ type: Schema.Types.ObjectId, ref: 'QuoteAttachment' }],
    gstRatePercent: { type: Schema.Types.Decimal128, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { collection: 'quotes', timestamps: { createdAt: true, updatedAt: false }, strict: 'throw' },
);

// One version number per insurer and option: two saves at once cannot both be version 2.
quoteSchema.index({ proposalId: 1, insurerId: 1, option: 1, version: 1 }, { unique: true });

export const QuoteModel = model<QuoteDoc>('Quote', quoteSchema);

/** The insurer's mail or PDF, kept as proof of a quote (Q-3). */
export interface QuoteAttachmentDoc {
  _id: Types.ObjectId;
  proposalId: Types.ObjectId;
  insurerId: Types.ObjectId;
  fileName: string;
  contentType: string;
  size: number;
  sha256: string;
  data: Buffer;
  uploadedBy: Types.ObjectId;
  createdAt: Date;
}

const quoteAttachmentSchema = new Schema<QuoteAttachmentDoc>(
  {
    proposalId: { type: Schema.Types.ObjectId, ref: 'Proposal', required: true },
    insurerId: { type: Schema.Types.ObjectId, ref: 'Insurer', required: true },
    fileName: { type: String, required: true },
    contentType: { type: String, required: true },
    size: { type: Number, required: true },
    sha256: { type: String, required: true },
    data: { type: Buffer, required: true },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  {
    collection: 'quote_attachments',
    timestamps: { createdAt: true, updatedAt: false },
    strict: 'throw',
  },
);

quoteAttachmentSchema.index({ proposalId: 1, insurerId: 1 });

export const QuoteAttachmentModel = model<QuoteAttachmentDoc>(
  'QuoteAttachment',
  quoteAttachmentSchema,
);
