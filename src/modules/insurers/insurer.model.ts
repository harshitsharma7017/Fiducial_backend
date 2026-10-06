import { Schema, model, type Types } from 'mongoose';
import { contactSchema, type ContactDoc } from '../clients/client.model.ts';

/** One branch of an insurance company that Fiducial sends RFQs to. */
export interface InsurerDoc {
  _id: Types.ObjectId;
  company: string;
  branch: string;
  /** Lower-case company and branch, for sorting and the duplicate check. */
  companyKey: string;
  branchKey: string;
  contacts: ContactDoc[];
  /** Where RFQs to this branch are sent. Lower case. */
  rfqEmails: string[];
  active: boolean;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const insurerSchema = new Schema<InsurerDoc>(
  {
    company: { type: String, required: true, trim: true, maxlength: 200 },
    branch: { type: String, required: true, trim: true, maxlength: 200 },
    companyKey: { type: String, required: true },
    branchKey: { type: String, required: true },
    contacts: { type: [contactSchema], default: [] },
    rfqEmails: {
      type: [{ type: String, lowercase: true, trim: true }],
      required: true,
      validate: {
        validator: (emails: string[]) => emails.length > 0,
        message: 'An insurer needs at least one RFQ email address',
      },
    },
    active: { type: Boolean, required: true, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { collection: 'insurers', timestamps: true, strict: 'throw' },
);

// One record per company branch; also the list order.
insurerSchema.index({ companyKey: 1, branchKey: 1 }, { unique: true });

export const InsurerModel = model<InsurerDoc>('Insurer', insurerSchema);
