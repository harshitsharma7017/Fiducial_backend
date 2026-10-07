import { ADDON_LISTS, type AddonList } from '../../shared/index.ts';
import { Schema, model, type Types } from 'mongoose';

/** A client's favourite add-on covers (C-4), offered first on each of its cases. */
export interface AddonFavouritesDoc {
  _id: Types.ObjectId;
  clientId: Types.ObjectId;
  items: Array<{ list: AddonList; name: string }>;
  updatedBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const addonFavouritesSchema = new Schema<AddonFavouritesDoc>(
  {
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true },
    items: [
      new Schema(
        {
          list: { type: String, enum: ADDON_LISTS, required: true },
          name: { type: String, required: true },
        },
        { _id: false, versionKey: false, strict: true },
      ),
    ],
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { collection: 'client_addon_favourites', timestamps: true, strict: 'throw' },
);

addonFavouritesSchema.index({ clientId: 1 }, { unique: true });

export const AddonFavouritesModel = model<AddonFavouritesDoc>(
  'AddonFavourites',
  addonFavouritesSchema,
);
