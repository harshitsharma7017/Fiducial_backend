import {
  EB_PRODUCTS,
  GHI_RELATIONSHIPS,
  PLAN_VERSION_STATUSES,
  type EbProduct,
  type GhiRelationship,
  type PlanVersionStatus,
} from '../../shared/index.ts';
import { Schema, model, type Types } from 'mongoose';

/**
 * A family plan of the Family Plan Master (N2): who a family may include for one product, with
 * its numbered versions embedded. Nothing is ever deleted (Requirement 12.10), so a version's
 * number is the count of versions before it plus one, written with a filter on __v.
 */
export interface FamilyPlanVersionDoc {
  number: number;
  status: PlanVersionStatus;
  effectiveFrom: string;
  effectiveTo: string | null;
  clientConfirmed: boolean;
  parentsAndInLawsMixed: boolean;
  slots: Array<{
    name: string;
    min: number;
    max: number;
    relationships: Array<{ relationship: GhiRelationship; max: number }>;
  }>;
  createdAt: Date;
  createdBy: Types.ObjectId | null;
  activatedAt: Date | null;
  activatedBy: Types.ObjectId | null;
}

export interface FamilyPlanDoc {
  _id: Types.ObjectId;
  product: EbProduct;
  code: string;
  name: string;
  active: boolean;
  /** One of the seven default plans of Requirement 14.2. */
  isDefault: boolean;
  openQuestions: number[];
  versions: FamilyPlanVersionDoc[];
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
  __v: number;
}

const noId = { _id: false, versionKey: false as const, strict: true as const };

const versionSchema = new Schema<FamilyPlanVersionDoc>(
  {
    number: { type: Number, required: true, min: 1 },
    status: { type: String, enum: PLAN_VERSION_STATUSES, required: true },
    effectiveFrom: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    effectiveTo: { type: String, default: null },
    clientConfirmed: { type: Boolean, required: true, default: false },
    parentsAndInLawsMixed: { type: Boolean, required: true },
    slots: [
      new Schema(
        {
          name: { type: String, required: true },
          min: { type: Number, required: true },
          max: { type: Number, required: true },
          relationships: [
            new Schema(
              {
                relationship: { type: String, enum: GHI_RELATIONSHIPS, required: true },
                max: { type: Number, required: true },
              },
              noId,
            ),
          ],
        },
        noId,
      ),
    ],
    createdAt: { type: Date, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    activatedAt: { type: Date, default: null },
    activatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  noId,
);

const familyPlanSchema = new Schema<FamilyPlanDoc>(
  {
    product: { type: String, enum: EB_PRODUCTS, required: true },
    code: { type: String, required: true },
    name: { type: String, required: true },
    active: { type: Boolean, required: true, default: true },
    isDefault: { type: Boolean, required: true, default: false },
    openQuestions: { type: [Number], default: [] },
    versions: [versionSchema],
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { collection: 'family_plans', timestamps: true, strict: 'throw', minimize: false },
);
// At most one plan per product and code, also when two API instances seed at once (14.1).
familyPlanSchema.index({ product: 1, code: 1 }, { unique: true });
familyPlanSchema.index({ product: 1, active: 1, code: 1 });

export const FamilyPlanModel = model<FamilyPlanDoc>('FamilyPlan', familyPlanSchema);
