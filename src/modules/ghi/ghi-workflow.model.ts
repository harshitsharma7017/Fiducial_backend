import {
  GHI_FILE_PURPOSES,
  GHI_PAYMENT_MODES,
  GHI_PAYMENT_STATUSES,
  GHI_QCR_STATUSES,
  GHI_RFQ_STATUSES,
  MAIL_RESULTS,
  type GhiFilePurpose,
  type GhiPaymentMode,
  type GhiPaymentStatus,
  type GhiQcrStatus,
  type GhiQuoteTermsInput,
  type GhiRfqStatus,
  type MailResult,
} from '../../shared/index.ts';
import { Schema, model, type Types } from 'mongoose';

// The GHI workflow's records after the census. Quotes and dispatches are never changed once
// final or sent: a revision is a new version, and the history stays.

const noId = { _id: false, versionKey: false as const, strict: true as const };
const text = { type: String, default: null };
const by = { type: Schema.Types.ObjectId, ref: 'User', required: true };
const decisionSchema = (statuses: readonly string[]) =>
  new Schema(
    {
      status: { type: String, enum: statuses, required: true },
      at: { type: Date, required: true },
      by,
      comment: text,
    },
    noId,
  );
const stampSchema = () => new Schema({ at: { type: Date, required: true }, by }, noId);

/** One generated version of a case's RFQ (G5), its approval, and the files as generated. */
export interface GhiRfqDoc {
  _id: Types.ObjectId;
  caseId: Types.ObjectId;
  version: number;
  status: GhiRfqStatus;
  /** "requirementsRevision:censusRevision" when generated; a change makes the version stale. */
  fingerprint: string;
  census: { employees: number; lives: number; totalSumInsured: Types.Decimal128 | null };
  xlsxFileId: Types.ObjectId;
  pdfFileId: Types.ObjectId;
  generatedBy: Types.ObjectId;
  submitted: { at: Date; by: Types.ObjectId } | null;
  decision: {
    status: 'APPROVED' | 'RETURNED';
    at: Date;
    by: Types.ObjectId;
    comment: string | null;
  } | null;
  createdAt: Date;
  updatedAt: Date;
}

const ghiRfqSchema = new Schema<GhiRfqDoc>(
  {
    caseId: { type: Schema.Types.ObjectId, ref: 'GhiCase', required: true },
    version: { type: Number, required: true, min: 1 },
    status: { type: String, enum: GHI_RFQ_STATUSES, required: true },
    fingerprint: { type: String, required: true },
    census: {
      type: new Schema(
        {
          employees: { type: Number, required: true },
          lives: { type: Number, required: true },
          totalSumInsured: { type: Schema.Types.Decimal128, default: null },
        },
        noId,
      ),
      required: true,
    },
    xlsxFileId: { type: Schema.Types.ObjectId, ref: 'GhiFile', required: true },
    pdfFileId: { type: Schema.Types.ObjectId, ref: 'GhiFile', required: true },
    generatedBy: by,
    submitted: { type: stampSchema(), default: null },
    decision: { type: decisionSchema(['APPROVED', 'RETURNED']), default: null },
  },
  { collection: 'ghi_rfqs', timestamps: true, strict: 'throw' },
);
ghiRfqSchema.index({ caseId: 1, version: 1 }, { unique: true });

export const GhiRfqModel = model<GhiRfqDoc>('GhiRfq', ghiRfqSchema);

/**
 * One version of an insurer's quote (G6), or of the final agreed terms (G7). A DRAFT can change;
 * a FINAL version never does.
 */
export interface GhiQuoteDoc {
  _id: Types.ObjectId;
  caseId: Types.ObjectId;
  insurerId: Types.ObjectId;
  version: number;
  status: 'DRAFT' | 'FINAL';
  kind: 'QUOTE' | 'FINAL_AGREED';
  reason: string | null;
  basePremium: Types.Decimal128 | null;
  gstRatePercent: Types.Decimal128;
  gst: Types.Decimal128 | null;
  totalPremium: Types.Decimal128 | null;
  terms: GhiQuoteTermsInput;
  otherTerms: string | null;
  validUntil: string | null;
  attachmentIds: Types.ObjectId[];
  createdBy: Types.ObjectId;
  finalizedAt: Date | null;
  finalizedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const ghiQuoteSchema = new Schema<GhiQuoteDoc>(
  {
    caseId: { type: Schema.Types.ObjectId, ref: 'GhiCase', required: true },
    insurerId: { type: Schema.Types.ObjectId, ref: 'Insurer', required: true },
    version: { type: Number, required: true, min: 1 },
    status: { type: String, enum: ['DRAFT', 'FINAL'], required: true },
    kind: { type: String, enum: ['QUOTE', 'FINAL_AGREED'], required: true },
    reason: text,
    basePremium: { type: Schema.Types.Decimal128, default: null },
    gstRatePercent: { type: Schema.Types.Decimal128, required: true },
    gst: { type: Schema.Types.Decimal128, default: null },
    totalPremium: { type: Schema.Types.Decimal128, default: null },
    // Validated by GhiQuoteTermsInputSchema before every write.
    terms: { type: Schema.Types.Mixed, required: true },
    otherTerms: text,
    validUntil: text,
    attachmentIds: [{ type: Schema.Types.ObjectId, ref: 'GhiFile' }],
    createdBy: by,
    finalizedAt: { type: Date, default: null },
    finalizedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { collection: 'ghi_quotes', timestamps: true, strict: 'throw', minimize: false },
);
// One version number per insurer: two saves at once cannot both be version 2.
ghiQuoteSchema.index({ caseId: 1, insurerId: 1, version: 1 }, { unique: true });

export const GhiQuoteModel = model<GhiQuoteDoc>('GhiQuote', ghiQuoteSchema);

/** One version of a case's QCR (G6): the quotes compared, its approval and the client's answer. */
export interface GhiQcrDoc {
  _id: Types.ObjectId;
  caseId: Types.ObjectId;
  version: number;
  status: GhiQcrStatus;
  quoteIds: Types.ObjectId[];
  recommendedInsurerId: Types.ObjectId | null;
  remarks: string | null;
  submitted: { at: Date; by: Types.ObjectId } | null;
  decision: {
    status: 'APPROVED' | 'REJECTED';
    at: Date;
    by: Types.ObjectId;
    comment: string | null;
  } | null;
  clientDecision: {
    decision: 'ACCEPTED' | 'REJECTED';
    insurerId: Types.ObjectId | null;
    quoteId: Types.ObjectId | null;
    decidedOn: string;
    confirmedBy: string;
    note: string | null;
    fileIds: Types.ObjectId[];
    recordedAt: Date;
    recordedBy: Types.ObjectId;
  } | null;
  createdBy: Types.ObjectId;
  updatedBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const ghiQcrSchema = new Schema<GhiQcrDoc>(
  {
    caseId: { type: Schema.Types.ObjectId, ref: 'GhiCase', required: true },
    version: { type: Number, required: true, min: 1 },
    status: { type: String, enum: GHI_QCR_STATUSES, required: true },
    quoteIds: [{ type: Schema.Types.ObjectId, ref: 'GhiQuote', required: true }],
    recommendedInsurerId: { type: Schema.Types.ObjectId, ref: 'Insurer', default: null },
    remarks: text,
    submitted: { type: stampSchema(), default: null },
    decision: { type: decisionSchema(['APPROVED', 'REJECTED']), default: null },
    clientDecision: {
      type: new Schema(
        {
          decision: { type: String, enum: ['ACCEPTED', 'REJECTED'], required: true },
          insurerId: { type: Schema.Types.ObjectId, ref: 'Insurer', default: null },
          quoteId: { type: Schema.Types.ObjectId, ref: 'GhiQuote', default: null },
          decidedOn: { type: String, required: true },
          confirmedBy: { type: String, required: true },
          note: text,
          fileIds: [{ type: Schema.Types.ObjectId, ref: 'GhiFile' }],
          recordedAt: { type: Date, required: true },
          recordedBy: by,
        },
        noId,
      ),
      default: null,
    },
    createdBy: by,
    updatedBy: by,
  },
  { collection: 'ghi_qcrs', timestamps: true, strict: 'throw' },
);
ghiQcrSchema.index({ caseId: 1, version: 1 }, { unique: true });

export const GhiQcrModel = model<GhiQcrDoc>('GhiQcr', ghiQcrSchema);

/** A premium payment towards the final agreed premium (G7). Amounts in rupees with paise. */
export interface GhiPaymentDoc {
  _id: Types.ObjectId;
  caseId: Types.ObjectId;
  amount: Types.Decimal128;
  paidOn: string;
  reference: string;
  mode: GhiPaymentMode;
  status: GhiPaymentStatus;
  payer: string | null;
  note: string | null;
  fileIds: Types.ObjectId[];
  createdBy: Types.ObjectId;
  updatedBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const ghiPaymentSchema = new Schema<GhiPaymentDoc>(
  {
    caseId: { type: Schema.Types.ObjectId, ref: 'GhiCase', required: true },
    amount: { type: Schema.Types.Decimal128, required: true },
    paidOn: { type: String, required: true },
    reference: { type: String, required: true },
    mode: { type: String, enum: GHI_PAYMENT_MODES, required: true },
    status: { type: String, enum: GHI_PAYMENT_STATUSES, required: true },
    payer: text,
    note: text,
    fileIds: [{ type: Schema.Types.ObjectId, ref: 'GhiFile' }],
    createdBy: by,
    updatedBy: by,
  },
  { collection: 'ghi_payments', timestamps: true, strict: 'throw' },
);
ghiPaymentSchema.index({ caseId: 1, _id: 1 });

export const GhiPaymentModel = model<GhiPaymentDoc>('GhiPayment', ghiPaymentSchema);

/** A file kept on a case: an RFQ as generated, a quote, the client's decision, a payment proof, the policy copy. */
export interface GhiFileDoc {
  _id: Types.ObjectId;
  caseId: Types.ObjectId;
  purpose: GhiFilePurpose | 'RFQ';
  fileName: string;
  contentType: string;
  size: number;
  sha256: string;
  data: Buffer;
  uploadedBy: Types.ObjectId;
  createdAt: Date;
}

const ghiFileSchema = new Schema<GhiFileDoc>(
  {
    caseId: { type: Schema.Types.ObjectId, ref: 'GhiCase', required: true },
    purpose: { type: String, enum: [...GHI_FILE_PURPOSES, 'RFQ'], required: true },
    fileName: { type: String, required: true },
    contentType: { type: String, required: true },
    size: { type: Number, required: true },
    sha256: { type: String, required: true },
    data: { type: Buffer, required: true },
    uploadedBy: by,
  },
  { collection: 'ghi_files', timestamps: { createdAt: true, updatedAt: false }, strict: 'throw' },
);
ghiFileSchema.index({ caseId: 1, purpose: 1, _id: -1 });

export const GhiFileModel = model<GhiFileDoc>('GhiFile', ghiFileSchema);

/**
 * Every RFQ mail to an insurer and QCR mail to the client (G5, G6), sent or failed. Append-only,
 * like the Property mail log: a repeated send (same sendId) is answered from here.
 */
export interface GhiDispatchDoc {
  _id: Types.ObjectId;
  caseId: Types.ObjectId;
  kind: 'RFQ' | 'QCR';
  /** The RFQ or QCR version sent. */
  documentId: Types.ObjectId;
  insurerId: Types.ObjectId | null;
  /** Who it went to, in words (the insurer's branch or the client). */
  recipient: string;
  sendId: string;
  from: string;
  replyTo: string;
  to: string[];
  subject: string;
  text: string;
  attachmentId: Types.ObjectId | null;
  attachmentName: string | null;
  dueDate: string | null;
  sentBy: Types.ObjectId;
  at: Date;
  transport: 'smtp' | 'outbox';
  result: MailResult;
  messageId: string | null;
  error: string | null;
}

const ghiDispatchSchema = new Schema<GhiDispatchDoc>(
  {
    caseId: { type: Schema.Types.ObjectId, ref: 'GhiCase', required: true },
    kind: { type: String, enum: ['RFQ', 'QCR'], required: true },
    documentId: { type: Schema.Types.ObjectId, required: true },
    insurerId: { type: Schema.Types.ObjectId, ref: 'Insurer', default: null },
    recipient: { type: String, required: true },
    sendId: { type: String, required: true },
    from: { type: String, required: true },
    replyTo: { type: String, required: true },
    to: { type: [String], required: true },
    subject: { type: String, required: true },
    text: { type: String, required: true },
    attachmentId: { type: Schema.Types.ObjectId, ref: 'MailAttachment', default: null },
    attachmentName: text,
    dueDate: text,
    sentBy: by,
    at: { type: Date, required: true },
    transport: { type: String, enum: ['smtp', 'outbox'], required: true },
    result: { type: String, enum: MAIL_RESULTS, required: true },
    messageId: text,
    error: text,
  },
  { collection: 'ghi_dispatches', versionKey: false, minimize: false, strict: 'throw' },
);
ghiDispatchSchema.index({ caseId: 1, at: -1, _id: -1 });
ghiDispatchSchema.index({ sendId: 1, kind: 1, recipient: 1 }, { unique: true });

function rejectMutation(): never {
  throw new Error('ghi_dispatches is append-only: updates and deletes are not allowed');
}
ghiDispatchSchema.pre(
  [
    'updateOne',
    'updateMany',
    'findOneAndUpdate',
    'findOneAndReplace',
    'replaceOne',
    'deleteOne',
    'deleteMany',
    'findOneAndDelete',
  ],
  { document: false, query: true },
  rejectMutation,
);

export const GhiDispatchModel = model<GhiDispatchDoc>('GhiDispatch', ghiDispatchSchema);
