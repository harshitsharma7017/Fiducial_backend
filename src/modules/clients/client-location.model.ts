import { EQ_ZONES, type EqZone } from '../../shared/index.ts';
import { Schema, model, type Types } from 'mongoose';
import {
  addressSchema,
  occupancyRefSchema,
  type AddressDoc,
  type OccupancyRefDoc,
} from './client.model.ts';

/**
 * A risk location of a client. Locations are their own collection so a client can have any
 * number of them. The state, district and EQ zone come from the pincode master version recorded
 * in pincodeVersionId.
 */
export interface ClientLocationDoc {
  _id: Types.ObjectId;
  clientId: Types.ObjectId;
  name: string;
  address: AddressDoc;
  district: string;
  eqZone: EqZone | null;
  pincodeVersionId: Types.ObjectId;
  /** Null when the location has the client's occupancy. */
  occupancy: OccupancyRefDoc | null;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const clientLocationSchema = new Schema<ClientLocationDoc>(
  {
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    address: { type: addressSchema, required: true },
    district: { type: String, default: '' },
    eqZone: { type: Number, enum: [...EQ_ZONES, null], default: null },
    pincodeVersionId: { type: Schema.Types.ObjectId, ref: 'MasterVersion', required: true },
    occupancy: { type: occupancyRefSchema, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { collection: 'client_locations', timestamps: true, strict: 'throw' },
);

// A client's locations in the order they were added.
clientLocationSchema.index({ clientId: 1, _id: 1 });

export const ClientLocationModel = model<ClientLocationDoc>('ClientLocation', clientLocationSchema);
