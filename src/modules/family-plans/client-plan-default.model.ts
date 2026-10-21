import { EB_PRODUCTS, type EbProduct } from '../../shared/index.ts';
import { Schema, model, type Types } from 'mongoose';

/**
 * A company's default family plan for one product (Requirement 15.1): at most one per company and
 * product. New cases of the company take it; existing cases keep their own assignment.
 */
export interface ClientPlanDefaultDoc {
  _id: Types.ObjectId;
  clientId: Types.ObjectId;
  product: EbProduct;
  planId: Types.ObjectId;
  setAt: Date;
  setBy: Types.ObjectId;
}

const clientPlanDefaultSchema = new Schema<ClientPlanDefaultDoc>(
  {
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true },
    product: { type: String, enum: EB_PRODUCTS, required: true },
    planId: { type: Schema.Types.ObjectId, ref: 'FamilyPlan', required: true },
    setAt: { type: Date, required: true },
    setBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { collection: 'eb_client_plan_defaults', versionKey: false, strict: 'throw' },
);
clientPlanDefaultSchema.index({ clientId: 1, product: 1 }, { unique: true });
clientPlanDefaultSchema.index({ planId: 1 });

export const ClientPlanDefaultModel = model<ClientPlanDefaultDoc>(
  'ClientPlanDefault',
  clientPlanDefaultSchema,
);
