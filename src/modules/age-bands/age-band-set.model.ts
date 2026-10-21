import { Schema, model, type Types } from 'mongoose';

// The Age Band Master (N4): named sets of bands. A set is edited in place (its revision rises);
// cases keep a copy of the bands they were given and RFQ versions a copy of the bands they used,
// so an edit never changes a case, an RFQ or a policy. Nothing is deleted.

export interface AgeBandSetDoc {
  _id: Types.ObjectId;
  name: string;
  /** Lower-case name with single spaces: names are unique. */
  nameKey: string;
  description: string | null;
  bands: Array<{ label: string; min: number; max: number | null }>;
  active: boolean;
  revision: number;
  /** Set on the sets created at startup (DEFAULT_AGE_BAND_SETS). */
  seedKey: string | null;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const noId = { _id: false, versionKey: false as const, strict: true as const };

const ageBandSetSchema = new Schema<AgeBandSetDoc>(
  {
    name: { type: String, required: true },
    nameKey: { type: String, required: true },
    description: { type: String, default: null },
    bands: [
      new Schema(
        {
          label: { type: String, required: true },
          min: { type: Number, required: true, min: 0 },
          max: { type: Number, default: null },
        },
        noId,
      ),
    ],
    active: { type: Boolean, required: true, default: true },
    revision: { type: Number, required: true, default: 1, min: 1 },
    seedKey: { type: String, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { collection: 'age_band_sets', timestamps: true, strict: 'throw', minimize: false },
);
ageBandSetSchema.index({ nameKey: 1 }, { unique: true });
// A default set is created once, also when two API instances start at once.
ageBandSetSchema.index(
  { seedKey: 1 },
  { unique: true, partialFilterExpression: { seedKey: { $type: 'string' } } },
);
ageBandSetSchema.index({ active: 1, nameKey: 1 });

export const AgeBandSetModel = model<AgeBandSetDoc>('AgeBandSet', ageBandSetSchema);
