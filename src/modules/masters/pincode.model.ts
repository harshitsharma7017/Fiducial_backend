import type { EqZone } from '../../shared/index.ts';
import { Schema, model, type Types } from 'mongoose';

export interface EqRatesDoc {
  residential: Types.Decimal128 | null;
  nonIndustrial: Types.Decimal128 | null;
  industrial: Types.Decimal128 | null;
}

export interface PincodeDoc {
  _id: Types.ObjectId;
  versionId: Types.ObjectId;
  /** Six digits, stored as text. */
  pincode: string;
  state: string;
  district: string;
  /** AIFT earthquake zone 1 to 4 (1 = "Zone I", highest rates). */
  eqZone: EqZone | null;
  /** EQ rate per mille by risk type. */
  eqRates: EqRatesDoc;
  sourceRow: number;
}

const decimal = { type: Schema.Types.Decimal128, default: null };

const eqRatesSchema = new Schema<EqRatesDoc>(
  { residential: decimal, nonIndustrial: decimal, industrial: decimal },
  { _id: false },
);

const pincodeSchema = new Schema<PincodeDoc>(
  {
    versionId: { type: Schema.Types.ObjectId, ref: 'MasterVersion', required: true },
    pincode: { type: String, required: true, match: /^\d{6}$/ },
    // Blank values are imported (and reported) rather than rejected.
    state: { type: String, default: '' },
    district: { type: String, default: '' },
    eqZone: { type: Number, enum: [1, 2, 3, 4], default: null },
    eqRates: { type: eqRatesSchema, required: true },
    sourceRow: { type: Number, required: true },
  },
  { collection: 'pincodes', versionKey: false, strict: 'throw' },
);

pincodeSchema.index({ versionId: 1, pincode: 1 }, { unique: true });

export const PincodeModel = model<PincodeDoc>('Pincode', pincodeSchema);
