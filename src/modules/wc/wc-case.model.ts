import { WC_TYPES, type WcType } from '../../shared/index.ts';
import { Schema, model, type Types } from 'mongoose';

// A workmen compensation case: the Data Sheet (worker categories, coverage options, clauses,
// conditions and, on a renewal, the expiring policy) and the insurers' quotes. Amounts are kept
// as strings of rupees, exactly as entered.

export interface WcCategoryDoc {
  id: string;
  designation: string;
  persons: number;
  monthlyWage: string;
}

export interface WcCoverageOptionDoc {
  id: string;
  label: string;
}

export interface WcExpiringPolicyDoc {
  policyYear: string | null;
  policyNumber: string | null;
  insurer: string | null;
  persons: number | null;
  sumInsured: string | null;
  premiumInclGst: string | null;
  coverageOption: string | null;
  claimAmount: string | null;
  changes: string | null;
}

export interface WcQuoteDoc {
  insurerId: Types.ObjectId;
  paymentInFavourOf: string | null;
  premiums: { optionId: string; premium: string | null }[];
}

export interface WcRfqInsurerDoc {
  insurerId: Types.ObjectId;
  sentOn: string | null;
}

export interface WcPlacementDoc {
  insurerId: Types.ObjectId;
  optionId: string;
  policyNumber: string | null;
  policyStart: string | null;
  policyEnd: string | null;
  updatedAt: Date;
}

export interface WcCaseDoc {
  _id: Types.ObjectId;
  reference: string;
  type: WcType;
  clientId: Types.ObjectId;
  ownerId: Types.ObjectId;
  gstRatePercent: string;
  policyPeriod: string;
  natureOfBusiness: string | null;
  workingHeight: string | null;
  riskLocation: string | null;
  categoryDescription: string | null;
  categories: WcCategoryDoc[];
  coverageOptions: WcCoverageOptionDoc[];
  clauses: string[];
  conditions: string[];
  expiringPolicy: WcExpiringPolicyDoc | null;
  rfqInsurers?: WcRfqInsurerDoc[];
  quotes: WcQuoteDoc[];
  recommendedInsurerId: Types.ObjectId | null;
  placement?: WcPlacementDoc | null;
  remarks: string | null;
  createdBy: Types.ObjectId;
  updatedBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const nullableString = { type: String, default: null };

const categorySchema = new Schema<WcCategoryDoc>(
  {
    id: { type: String, required: true },
    designation: { type: String, required: true },
    persons: { type: Number, required: true },
    monthlyWage: { type: String, required: true },
  },
  { _id: false, strict: 'throw' },
);

const optionSchema = new Schema<WcCoverageOptionDoc>(
  { id: { type: String, required: true }, label: { type: String, required: true } },
  { _id: false, strict: 'throw' },
);

const expiringSchema = new Schema<WcExpiringPolicyDoc>(
  {
    policyYear: nullableString,
    policyNumber: nullableString,
    insurer: nullableString,
    persons: { type: Number, default: null },
    sumInsured: nullableString,
    premiumInclGst: nullableString,
    coverageOption: nullableString,
    claimAmount: nullableString,
    changes: nullableString,
  },
  { _id: false, strict: 'throw' },
);

const quoteSchema = new Schema<WcQuoteDoc>(
  {
    insurerId: { type: Schema.Types.ObjectId, ref: 'Insurer', required: true },
    paymentInFavourOf: nullableString,
    premiums: {
      type: [
        new Schema(
          { optionId: { type: String, required: true }, premium: nullableString },
          { _id: false, strict: 'throw' },
        ),
      ],
      default: [],
    },
  },
  { _id: false, strict: 'throw' },
);

const rfqInsurerSchema = new Schema<WcRfqInsurerDoc>(
  {
    insurerId: { type: Schema.Types.ObjectId, ref: 'Insurer', required: true },
    sentOn: nullableString,
  },
  { _id: false, strict: 'throw' },
);

const placementSchema = new Schema<WcPlacementDoc>(
  {
    insurerId: { type: Schema.Types.ObjectId, ref: 'Insurer', required: true },
    optionId: { type: String, required: true },
    policyNumber: nullableString,
    policyStart: nullableString,
    policyEnd: nullableString,
    updatedAt: { type: Date, required: true },
  },
  { _id: false, strict: 'throw' },
);

const wcCaseSchema = new Schema<WcCaseDoc>(
  {
    reference: { type: String, required: true },
    type: { type: String, enum: WC_TYPES, required: true },
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    gstRatePercent: { type: String, required: true },
    policyPeriod: { type: String, required: true },
    natureOfBusiness: nullableString,
    workingHeight: nullableString,
    riskLocation: nullableString,
    categoryDescription: nullableString,
    categories: { type: [categorySchema], default: [] },
    coverageOptions: { type: [optionSchema], default: [] },
    clauses: { type: [String], default: [] },
    conditions: { type: [String], default: [] },
    expiringPolicy: { type: expiringSchema, default: null },
    rfqInsurers: { type: [rfqInsurerSchema], default: [] },
    quotes: { type: [quoteSchema], default: [] },
    recommendedInsurerId: { type: Schema.Types.ObjectId, ref: 'Insurer', default: null },
    placement: { type: placementSchema, default: null },
    remarks: nullableString,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { collection: 'wc_cases', timestamps: true, strict: 'throw' },
);

wcCaseSchema.index({ reference: 1 }, { unique: true });
wcCaseSchema.index({ updatedAt: -1 });

export const WcCaseModel = model<WcCaseDoc>('WcCase', wcCaseSchema);
