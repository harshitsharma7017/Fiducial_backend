import { CATALOG_MASTERS, type CatalogMaster } from '../../shared/index.ts';
import { Schema, model, type Types } from 'mongoose';

/**
 * One row of a product and cover master. The row's fields live in `data`, laid out as the
 * master's columns in src/shared/catalog.ts; amounts and percentages are stored as Decimal128.
 * Every write is validated against the master's row schema first (catalog.service.ts).
 */
export interface CatalogItemDoc {
  _id: Types.ObjectId;
  master: CatalogMaster;
  /** The row's identifying columns, lower case (catalogKeyOf), unique within the master. */
  key: string;
  data: Record<string, unknown>;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const catalogItemSchema = new Schema<CatalogItemDoc>(
  {
    master: { type: String, enum: CATALOG_MASTERS, required: true },
    key: { type: String, required: true },
    data: { type: Schema.Types.Mixed, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { collection: 'catalog_items', timestamps: true, strict: 'throw', minimize: false },
);

catalogItemSchema.index({ master: 1, key: 1 }, { unique: true });

export const CatalogItemModel = model<CatalogItemDoc>('CatalogItem', catalogItemSchema);
