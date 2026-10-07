import { DOCUMENT_KINDS, type DocumentKind, type TemplateCheck } from '../../shared/index.ts';
import { Schema, model, type Types } from 'mongoose';

/** A client format (RFQ, QCR, Placement Slip) uploaded as the template its documents fill. */
export interface DocumentTemplateDoc {
  _id: Types.ObjectId;
  kind: DocumentKind;
  fileName: string;
  data: Buffer;
  size: number;
  sha256: string;
  check: TemplateCheck;
  uploadedBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const documentTemplateSchema = new Schema<DocumentTemplateDoc>(
  {
    kind: { type: String, enum: DOCUMENT_KINDS, required: true },
    fileName: { type: String, required: true },
    data: { type: Buffer, required: true },
    size: { type: Number, required: true },
    sha256: { type: String, required: true },
    check: { type: Schema.Types.Mixed, required: true },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { collection: 'document_templates', timestamps: true, strict: 'throw' },
);

documentTemplateSchema.index({ kind: 1 }, { unique: true });

export const DocumentTemplateModel = model<DocumentTemplateDoc>(
  'DocumentTemplate',
  documentTemplateSchema,
);
