import {
  CLOUD_DOCUMENT_KINDS,
  MAIL_ATTACHMENT_FORMATS,
  type CloudDocumentKind,
  type MailAttachmentFormat,
} from '../../shared/index.ts';
import { Schema, model, type Types } from 'mongoose';

/**
 * A document a user saved to cloud storage (client review, 27 Oct 2026): where it is in the store,
 * what it is and who saved it. The file itself is only in the store; removing it keeps this
 * record (with who removed it) so the history stays.
 */
export interface CloudDocumentDoc {
  _id: Types.ObjectId;
  proposalId: Types.ObjectId;
  document: CloudDocumentKind;
  format: MailAttachmentFormat;
  fileName: string;
  contentType: string;
  size: number;
  /** SHA-256 of the file, hex: what was saved can be checked against what is read back. */
  sha256: string;
  /** "s3://bucket" (or the test store) and the object's key there. */
  location: string;
  key: string;
  detail: string | null;
  savedBy: Types.ObjectId;
  savedAt: Date;
  removed: { at: Date; by: Types.ObjectId } | null;
}

const cloudDocumentSchema = new Schema<CloudDocumentDoc>(
  {
    proposalId: { type: Schema.Types.ObjectId, ref: 'Proposal', required: true },
    document: { type: String, enum: CLOUD_DOCUMENT_KINDS, required: true },
    format: { type: String, enum: MAIL_ATTACHMENT_FORMATS, required: true },
    fileName: { type: String, required: true },
    contentType: { type: String, required: true },
    size: { type: Number, required: true, min: 0 },
    sha256: { type: String, required: true },
    location: { type: String, required: true },
    key: { type: String, required: true },
    detail: { type: String, default: null },
    savedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    savedAt: { type: Date, required: true },
    removed: {
      type: new Schema(
        {
          at: { type: Date, required: true },
          by: { type: Schema.Types.ObjectId, ref: 'User', required: true },
        },
        { _id: false, versionKey: false, strict: true },
      ),
      default: null,
    },
  },
  { collection: 'cloud_documents', versionKey: false, strict: 'throw', minimize: false },
);

cloudDocumentSchema.index({ proposalId: 1, savedAt: -1 });

export const CloudDocumentModel = model<CloudDocumentDoc>('CloudDocument', cloudDocumentSchema);
