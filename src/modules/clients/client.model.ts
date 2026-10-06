import { Schema, model, type Types } from 'mongoose';

export interface ContactDoc {
  name: string;
  designation: string | null;
  email: string | null;
  phone: string | null;
}

export interface OccupancyRefDoc {
  tacCode: string;
  description: string;
}

export interface AddressDoc {
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  pincode: string;
}

export interface ClientDoc {
  _id: Types.ObjectId;
  name: string;
  /** Lower-case name, for sorting. */
  nameKey: string;
  /** Upper case without spaces. Null for an insured without GST registration. */
  gstin: string | null;
  address: AddressDoc;
  contacts: ContactDoc[];
  natureOfBusiness: string;
  /** The occupancy as it was in the active master when chosen. */
  occupancy: OccupancyRefDoc;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const nullableString = { type: String, default: null };

export const contactSchema = new Schema<ContactDoc>(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    designation: nullableString,
    email: nullableString,
    phone: nullableString,
  },
  { _id: false, strict: 'throw' },
);

export const occupancyRefSchema = new Schema<OccupancyRefDoc>(
  {
    tacCode: { type: String, required: true },
    description: { type: String, required: true },
  },
  { _id: false, strict: 'throw' },
);

export const addressSchema = new Schema<AddressDoc>(
  {
    line1: { type: String, required: true, maxlength: 200 },
    line2: nullableString,
    city: { type: String, required: true, maxlength: 100 },
    state: { type: String, required: true, maxlength: 100 },
    pincode: { type: String, required: true, match: /^\d{6}$/ },
  },
  { _id: false, strict: 'throw' },
);

const clientSchema = new Schema<ClientDoc>(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    nameKey: { type: String, required: true },
    gstin: { type: String, default: null, match: /^[0-9A-Z]{15}$/ },
    address: { type: addressSchema, required: true },
    contacts: { type: [contactSchema], default: [] },
    natureOfBusiness: { type: String, required: true, maxlength: 300 },
    occupancy: { type: occupancyRefSchema, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { collection: 'clients', timestamps: true, strict: 'throw' },
);

// One client per GSTIN. Clients without a GSTIN are not indexed, so any number may have none.
clientSchema.index(
  { gstin: 1 },
  { unique: true, partialFilterExpression: { gstin: { $type: 'string' } } },
);
// The list's name order, with the id breaking ties for the cursor.
clientSchema.index({ nameKey: 1, _id: 1 });

export const ClientModel = model<ClientDoc>('Client', clientSchema);
