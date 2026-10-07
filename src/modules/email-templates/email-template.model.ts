import { EMAIL_TEMPLATE_KINDS, type EmailTemplateKind } from '../../shared/index.ts';
import { Schema, model, type Types } from 'mongoose';

/** The wording of one kind of mail (RFQ, Reminder); Admins edit it, every mail records its version. */
export interface EmailTemplateDoc {
  _id: Types.ObjectId;
  kind: EmailTemplateKind;
  subject: string;
  body: string;
  version: number;
  isDefault: boolean;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const emailTemplateSchema = new Schema<EmailTemplateDoc>(
  {
    kind: { type: String, enum: EMAIL_TEMPLATE_KINDS, required: true },
    subject: { type: String, required: true },
    body: { type: String, required: true },
    version: { type: Number, required: true, min: 1 },
    isDefault: { type: Boolean, required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { collection: 'email_templates', timestamps: true, strict: 'throw' },
);

emailTemplateSchema.index({ kind: 1 }, { unique: true });

export const EmailTemplateModel = model<EmailTemplateDoc>('EmailTemplate', emailTemplateSchema);
