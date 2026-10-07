import { Schema, model, type Types } from 'mongoose';

/**
 * A file a mail carried, kept exactly as sent (at most MAX_ATTACHMENT_BYTES). Stored once per
 * content: every mail of a send points at the same file. Insert-only.
 */
export interface MailAttachmentDoc {
  _id: Types.ObjectId;
  sha256: string;
  fileName: string;
  contentType: string;
  size: number;
  data: Buffer;
  createdAt: Date;
}

const mailAttachmentSchema = new Schema<MailAttachmentDoc>(
  {
    sha256: { type: String, required: true },
    fileName: { type: String, required: true },
    contentType: { type: String, required: true },
    size: { type: Number, required: true },
    data: { type: Buffer, required: true },
    createdAt: { type: Date, required: true, default: () => new Date() },
  },
  { collection: 'mail_attachments', versionKey: false, strict: 'throw' },
);

// The same bytes under the same name are one file; the name is part of the key so a mail always
// shows the name it was sent with.
mailAttachmentSchema.index({ sha256: 1, fileName: 1 }, { unique: true });

export const MailAttachmentModel = model<MailAttachmentDoc>('MailAttachment', mailAttachmentSchema);
