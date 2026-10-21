import {
  GHI_GENDERS,
  GHI_RELATIONSHIPS,
  type GhiGender,
  type GhiRelationship,
} from '../../shared/index.ts';
import { Schema, model, type Types } from 'mongoose';
import type { NomineeDoc } from './ghi-census.model.ts';

// The policy snapshot of a placed GPA or GTLI case (Requirement 11.2, design D14): a header and
// one document per member, so a large census never nears the document size limit. Neither is
// ever changed or deleted: the hooks below refuse it, as ghi_dispatches does.

export interface EbPolicySnapshotDoc {
  _id: Types.ObjectId;
  caseId: Types.ObjectId;
  product: 'GPA' | 'GTLI';
  insurerId: Types.ObjectId;
  qcrId: Types.ObjectId;
  quoteId: Types.ObjectId;
  quoteVersion: number;
  basePremium: Types.Decimal128;
  gst: Types.Decimal128;
  agreedTotal: Types.Decimal128;
  plan: {
    planId: Types.ObjectId;
    code: string;
    name: string;
    versionNumber: number;
    slots: Array<{
      name: string;
      min: number;
      max: number;
      relationships: Array<{ relationship: GhiRelationship; max: number }>;
    }>;
    parentsAndInLawsMixed: boolean;
  };
  census: {
    revision: number;
    employees: number;
    lives: number;
    byRelationship: Record<GhiRelationship, number>;
    totalSumInsured: Types.Decimal128;
  };
  receivedPayments: Array<{
    paymentId: Types.ObjectId;
    amount: Types.Decimal128;
    paidOn: string;
    reference: string;
  }>;
  policyNumber: string | null;
  policyStart: string | null;
  policyEnd: string | null;
  issuedAt: Date;
  issuedBy: Types.ObjectId;
  /**
   * N4 to N6, missing on snapshots taken before: the Data Sheet as placed (sum insured basis,
   * GPA relationship rules, salary input, nominee setting) and the age bands the case used.
   */
  requirements?: Record<string, unknown>;
  ageBands?: { setId: Types.ObjectId | null; name: string; revision: number; bands: unknown[] };
}

export interface EbPolicySnapshotMemberDoc {
  _id: Types.ObjectId;
  snapshotId: Types.ObjectId;
  caseId: Types.ObjectId;
  memberId: Types.ObjectId;
  employeeId: string;
  employeeKey: string;
  name: string;
  gender: GhiGender;
  dateOfBirth: string;
  relationship: GhiRelationship;
  dateOfJoining: string | null;
  sumInsured: Types.Decimal128 | null;
  annualSalary: Types.Decimal128 | null;
  /** The sum insured that covers the member when placed. */
  coveredSumInsured: Types.Decimal128 | null;
  employeeIdentityId: Types.ObjectId | null;
  /** N5, N6: missing on snapshots taken before. */
  monthlySalary?: Types.Decimal128 | null;
  nominee?: NomineeDoc | null;
  coverageBasis?: string | null;
}

const noId = { _id: false, versionKey: false as const, strict: true as const };
const decimal = { type: Schema.Types.Decimal128, required: true };

function appendOnly(schema: Schema, collection: string): void {
  const reject = () => {
    throw new Error(`${collection} is append-only: updates and deletes are not allowed`);
  };
  schema.pre(
    [
      'updateOne',
      'updateMany',
      'findOneAndUpdate',
      'findOneAndReplace',
      'replaceOne',
      'deleteOne',
      'deleteMany',
      'findOneAndDelete',
    ],
    { document: false, query: true },
    reject,
  );
}

const snapshotSchema = new Schema<EbPolicySnapshotDoc>(
  {
    caseId: { type: Schema.Types.ObjectId, ref: 'GhiCase', required: true },
    product: { type: String, enum: ['GPA', 'GTLI'], required: true },
    insurerId: { type: Schema.Types.ObjectId, ref: 'Insurer', required: true },
    qcrId: { type: Schema.Types.ObjectId, ref: 'GhiQcr', required: true },
    quoteId: { type: Schema.Types.ObjectId, ref: 'GhiQuote', required: true },
    quoteVersion: { type: Number, required: true },
    basePremium: decimal,
    gst: decimal,
    agreedTotal: decimal,
    plan: {
      type: new Schema(
        {
          planId: { type: Schema.Types.ObjectId, ref: 'FamilyPlan', required: true },
          code: { type: String, required: true },
          name: { type: String, required: true },
          versionNumber: { type: Number, required: true },
          slots: { type: Schema.Types.Mixed, required: true },
          parentsAndInLawsMixed: { type: Boolean, required: true },
        },
        noId,
      ),
      required: true,
    },
    census: {
      type: new Schema(
        {
          revision: { type: Number, required: true },
          employees: { type: Number, required: true },
          lives: { type: Number, required: true },
          byRelationship: { type: Schema.Types.Mixed, required: true },
          totalSumInsured: decimal,
        },
        noId,
      ),
      required: true,
    },
    receivedPayments: [
      new Schema(
        {
          paymentId: { type: Schema.Types.ObjectId, ref: 'GhiPayment', required: true },
          amount: decimal,
          paidOn: { type: String, required: true },
          reference: { type: String, required: true },
        },
        noId,
      ),
    ],
    policyNumber: { type: String, default: null },
    policyStart: { type: String, default: null },
    policyEnd: { type: String, default: null },
    issuedAt: { type: Date, required: true },
    issuedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    requirements: { type: Schema.Types.Mixed, default: undefined },
    ageBands: {
      type: new Schema(
        {
          setId: { type: Schema.Types.ObjectId, ref: 'AgeBandSet', default: null },
          name: { type: String, required: true },
          revision: { type: Number, required: true },
          bands: { type: Schema.Types.Mixed, required: true },
        },
        noId,
      ),
      default: undefined,
    },
  },
  { collection: 'eb_policy_snapshots', versionKey: false, minimize: false, strict: 'throw' },
);
// One placement per case: a second issue fails even under a race (Requirement 11.4).
snapshotSchema.index({ caseId: 1 }, { unique: true });
appendOnly(snapshotSchema, 'eb_policy_snapshots');

export const EbPolicySnapshotModel = model<EbPolicySnapshotDoc>('EbPolicySnapshot', snapshotSchema);

const snapshotMemberSchema = new Schema<EbPolicySnapshotMemberDoc>(
  {
    snapshotId: { type: Schema.Types.ObjectId, ref: 'EbPolicySnapshot', required: true },
    caseId: { type: Schema.Types.ObjectId, ref: 'GhiCase', required: true },
    memberId: { type: Schema.Types.ObjectId, ref: 'GhiMember', required: true },
    employeeId: { type: String, required: true },
    employeeKey: { type: String, required: true },
    name: { type: String, required: true },
    gender: { type: String, enum: GHI_GENDERS, required: true },
    dateOfBirth: { type: String, required: true },
    relationship: { type: String, enum: GHI_RELATIONSHIPS, required: true },
    dateOfJoining: { type: String, default: null },
    sumInsured: { type: Schema.Types.Decimal128, default: null },
    annualSalary: { type: Schema.Types.Decimal128, default: null },
    coveredSumInsured: { type: Schema.Types.Decimal128, default: null },
    employeeIdentityId: { type: Schema.Types.ObjectId, ref: 'EbEmployee', default: null },
    monthlySalary: { type: Schema.Types.Decimal128, default: undefined },
    nominee: { type: Schema.Types.Mixed, default: undefined },
    coverageBasis: { type: String, default: undefined },
  },
  { collection: 'eb_policy_snapshot_members', versionKey: false, strict: 'throw' },
);
snapshotMemberSchema.index({ snapshotId: 1, employeeKey: 1 });
appendOnly(snapshotMemberSchema, 'eb_policy_snapshot_members');

export const EbPolicySnapshotMemberModel = model<EbPolicySnapshotMemberDoc>(
  'EbPolicySnapshotMember',
  snapshotMemberSchema,
);
