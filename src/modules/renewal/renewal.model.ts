import { EB_PRODUCTS, type EbProduct } from '../../shared/index.ts';
import { Schema, model, type Types } from 'mongoose';

// N8: policy years recorded by hand (years before the app, or placed elsewhere) and saved
// renewal analyses. A saved analysis is a snapshot of its figures and parameters: regenerating
// an analysis never changes it, and neither changes a placed policy.

export interface RecordedPolicyYearDoc {
  _id: Types.ObjectId;
  clientId: Types.ObjectId;
  product: EbProduct;
  policyStart: string;
  policyEnd: string;
  insurerName: string;
  policyNumber: string | null;
  employees: number | null;
  lives: number | null;
  totalSumInsured: Types.Decimal128 | null;
  bySumInsured: Array<{ amount: string; families: number; lives: number }> | null;
  premiumBeforeGst: Types.Decimal128 | null;
  gst: Types.Decimal128 | null;
  claimsPaid: Types.Decimal128 | null;
  claimsOutstanding: Types.Decimal128 | null;
  claimsCount: number | null;
  claimsAsOf: string | null;
  source: string;
  createdBy: Types.ObjectId;
  updatedBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const decimal = { type: Schema.Types.Decimal128, default: null };
const recordedYearSchema = new Schema<RecordedPolicyYearDoc>(
  {
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true },
    product: { type: String, enum: EB_PRODUCTS, required: true },
    policyStart: { type: String, required: true },
    policyEnd: { type: String, required: true },
    insurerName: { type: String, required: true },
    policyNumber: { type: String, default: null },
    employees: { type: Number, default: null },
    lives: { type: Number, default: null },
    totalSumInsured: decimal,
    bySumInsured: { type: Schema.Types.Mixed, default: null },
    premiumBeforeGst: decimal,
    gst: decimal,
    claimsPaid: decimal,
    claimsOutstanding: decimal,
    claimsCount: { type: Number, default: null },
    claimsAsOf: { type: String, default: null },
    source: { type: String, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { collection: 'recorded_policy_years', timestamps: true, strict: 'throw', minimize: false },
);
recordedYearSchema.index({ clientId: 1, product: 1, policyStart: -1 });
export const RecordedPolicyYearModel = model<RecordedPolicyYearDoc>(
  'RecordedPolicyYear',
  recordedYearSchema,
);

export interface RenewalReportDoc {
  _id: Types.ObjectId;
  clientId: Types.ObjectId;
  product: EbProduct;
  title: string;
  request: Record<string, unknown>;
  /** The RenewalAnalysis as generated. */
  analysis: Record<string, unknown>;
  createdBy: Types.ObjectId;
  createdAt: Date;
}

const renewalReportSchema = new Schema<RenewalReportDoc>(
  {
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true },
    product: { type: String, enum: EB_PRODUCTS, required: true },
    title: { type: String, required: true },
    request: { type: Schema.Types.Mixed, required: true },
    analysis: { type: Schema.Types.Mixed, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  {
    collection: 'renewal_reports',
    timestamps: { createdAt: true, updatedAt: false },
    strict: 'throw',
    minimize: false,
  },
);
renewalReportSchema.index({ clientId: 1, createdAt: -1 });
// A saved analysis is never changed.
renewalReportSchema.pre(
  ['updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndReplace', 'replaceOne'],
  { document: false, query: true },
  () => {
    throw new Error('renewal_reports are kept as saved: updates are not allowed');
  },
);
export const RenewalReportModel = model<RenewalReportDoc>('RenewalReport', renewalReportSchema);
