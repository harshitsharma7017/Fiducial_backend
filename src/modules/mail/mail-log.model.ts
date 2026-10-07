import {
  EMAIL_TEMPLATE_KINDS,
  MAIL_RESULTS,
  type EmailTemplateKind,
  type MailResult,
} from '../../shared/index.ts';
import { Schema, model, type Types } from 'mongoose';

/** One mail sent, stored in the outbox or refused, against its case (E-6). Append-only. */
export interface MailLogDoc {
  _id: Types.ObjectId;
  proposalId: Types.ObjectId;
  /** Null for a mail to the insured (the QCR). */
  insurerId: Types.ObjectId | null;
  kind: EmailTemplateKind;
  /** The send it belongs to (made by the web app); a repeated send is answered from the log. */
  sendId: string;
  from: string;
  replyTo: string;
  /** Lower case: the insurer's own addresses only. */
  to: string[];
  subject: string;
  text: string;
  html: string;
  templateVersion: number;
  attachmentId: Types.ObjectId | null;
  dueDate: string | null;
  sentBy: Types.ObjectId;
  at: Date;
  transport: 'smtp' | 'outbox';
  result: MailResult;
  messageId: string | null;
  error: string | null;
}

const mailLogSchema = new Schema<MailLogDoc>(
  {
    proposalId: { type: Schema.Types.ObjectId, ref: 'Proposal', required: true },
    insurerId: { type: Schema.Types.ObjectId, ref: 'Insurer', default: null },
    kind: { type: String, enum: EMAIL_TEMPLATE_KINDS, required: true },
    sendId: { type: String, required: true },
    from: { type: String, required: true },
    replyTo: { type: String, required: true },
    to: { type: [String], required: true },
    subject: { type: String, required: true },
    text: { type: String, required: true },
    html: { type: String, required: true },
    templateVersion: { type: Number, required: true },
    attachmentId: { type: Schema.Types.ObjectId, ref: 'MailAttachment', default: null },
    dueDate: { type: String, default: null },
    sentBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    at: { type: Date, required: true },
    transport: { type: String, enum: ['smtp', 'outbox'], required: true },
    result: { type: String, enum: MAIL_RESULTS, required: true },
    messageId: { type: String, default: null },
    error: { type: String, default: null },
  },
  { collection: 'mail_log', versionKey: false, minimize: false, strict: 'throw' },
);

// The case's log, newest first; and one entry per insurer per send, so a repeated send (same
// sendId) can never log, or mail, an insurer twice.
mailLogSchema.index({ proposalId: 1, at: -1, _id: -1 });
mailLogSchema.index({ sendId: 1, insurerId: 1, kind: 1 }, { unique: true });

// Like audit_logs, the mail log is append-only: an accidental update or delete fails loudly.
function rejectMutation(): never {
  throw new Error('mail_log is append-only: updates and deletes are not allowed');
}
mailLogSchema.pre(
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
mailLogSchema.pre(['updateOne', 'deleteOne'], { document: true, query: false }, rejectMutation);
mailLogSchema.pre('save', function rejectResave() {
  if (!this.isNew) rejectMutation();
});

export const MailLogModel = model<MailLogDoc>('MailLog', mailLogSchema);
