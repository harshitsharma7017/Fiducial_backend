import { QUOTE_OPTIONS, type QuoteOption } from '../../shared/index.ts';
import { Schema, model, type Types } from 'mongoose';

/**
 * The quote a case's client accepted (one per case): the insurer, option and quote version, the
 * premium as it stood, and the client's confirmation. Recording it again replaces it; the audit
 * log keeps every change.
 */
export interface ClientApprovalDoc {
  _id: Types.ObjectId;
  proposalId: Types.ObjectId;
  insurerId: Types.ObjectId;
  option: QuoteOption;
  quoteId: Types.ObjectId;
  version: number;
  withTerrorism: boolean | null;
  net: Types.Decimal128;
  gst: Types.Decimal128;
  total: Types.Decimal128;
  acceptedOn: string;
  confirmedBy: string;
  note: string | null;
  fileIds: Types.ObjectId[];
  recordedBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const clientApprovalSchema = new Schema<ClientApprovalDoc>(
  {
    proposalId: { type: Schema.Types.ObjectId, ref: 'Proposal', required: true },
    insurerId: { type: Schema.Types.ObjectId, ref: 'Insurer', required: true },
    option: { type: String, enum: QUOTE_OPTIONS, required: true },
    quoteId: { type: Schema.Types.ObjectId, ref: 'Quote', required: true },
    version: { type: Number, required: true, min: 1 },
    withTerrorism: { type: Boolean, default: null },
    net: { type: Schema.Types.Decimal128, required: true },
    gst: { type: Schema.Types.Decimal128, required: true },
    total: { type: Schema.Types.Decimal128, required: true },
    acceptedOn: { type: String, required: true },
    confirmedBy: { type: String, required: true },
    note: { type: String, default: null },
    fileIds: [{ type: Schema.Types.ObjectId, ref: 'ClientApprovalFile' }],
    recordedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { collection: 'client_approvals', timestamps: true, strict: 'throw' },
);

clientApprovalSchema.index({ proposalId: 1 }, { unique: true });

export const ClientApprovalModel = model<ClientApprovalDoc>('ClientApproval', clientApprovalSchema);

/** The client's mail or signed letter, kept as proof of the approval. */
export interface ClientApprovalFileDoc {
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

const clientApprovalFileSchema = new Schema<ClientApprovalFileDoc>(
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
    collection: 'client_approval_files',
    timestamps: { createdAt: true, updatedAt: false },
    strict: 'throw',
  },
);

clientApprovalFileSchema.index({ proposalId: 1 });

export const ClientApprovalFileModel = model<ClientApprovalFileDoc>(
  'ClientApprovalFile',
  clientApprovalFileSchema,
);
