import {
  EB_PRODUCTS,
  GHI_RELATIONSHIPS,
  PLAN_ASSIGNMENT_SOURCES,
  GHI_CASE_TYPES,
  GHI_INSURER_STATUSES,
  GHI_STAGES,
  MAIL_RESULTS,
  type GhiCaseType,
  type GhiInsurerStatus,
  type GhiRequirementsInput,
  type EbProduct,
  type GhiRelationship,
  type GhiStage,
  type MailResult,
  type PlanAssignmentSource,
} from '../../shared/index.ts';
import { Schema, model, type Types } from 'mongoose';

/**
 * A group health (GHI) case (G1): one placement of a group's health cover. The Data Sheet (G2) is
 * kept as validated JSON with its money as strings, exactly as the API received it; the census,
 * quotes, QCRs, payments and files are in their own collections, keyed by the case.
 */
export interface GhiCaseInsurerDoc {
  insurerId: Types.ObjectId;
  status: GhiInsurerStatus;
  sentVia: 'APP' | 'OUTSIDE' | null;
  sentAt: Date | null;
  sentBy: Types.ObjectId | null;
  dueDate: string | null;
  lastDispatch: { at: Date; result: MailResult; error: string | null } | null;
  declineReason: string | null;
  /** Set while a mail to this insurer is being sent, so two sends cannot both mail it. */
  sending: { sendId: string; at: Date } | null;
}

/** The plan version a case uses and a copy of its slots, kept until a user assigns again (N2). */
export interface PlanAssignmentDoc {
  planId: Types.ObjectId;
  code: string;
  name: string;
  versionNumber: number;
  effectiveFrom: string;
  slots: Array<{
    name: string;
    min: number;
    max: number;
    relationships: Array<{ relationship: GhiRelationship; max: number }>;
  }>;
  parentsAndInLawsMixed: boolean;
  openQuestions: number[];
  source: PlanAssignmentSource;
  assignedAt: Date;
  assignedBy: Types.ObjectId | null;
}

/** The age band set a case uses (N4): a copy of its bands at one revision of the master. */
export interface AgeBandSelectionDoc {
  setId: Types.ObjectId;
  name: string;
  revision: number;
  bands: Array<{ label: string; min: number; max: number | null }>;
  selectedAt: Date;
  selectedBy: Types.ObjectId;
}

/** A GPA/GTLI case's placement (N1): set once, when the placement slip is issued. */
export interface EbPlacementDoc {
  snapshotId: Types.ObjectId;
  issuedAt: Date;
  issuedBy: Types.ObjectId;
  policyNumber: string | null;
  policyStart: string | null;
  policyEnd: string | null;
}

export interface GhiCaseDoc {
  _id: Types.ObjectId;
  /** Employee Benefits product; missing on cases stored before N1, which are GMC (design D1). */
  product?: EbProduct;
  reference: string;
  type: GhiCaseType;
  stage: GhiStage;
  closedReason: string | null;
  clientId: Types.ObjectId;
  ownerId: Types.ObjectId;
  policyStart: string | null;
  policyEnd: string | null;
  dueDate: string;
  existingInsurer: string | null;
  existingPolicyNumber: string | null;
  gstRatePercent: Types.Decimal128;
  requirements: GhiRequirementsInput;
  /** False until the Data Sheet is first saved. */
  requirementsSaved: boolean;
  requirementsRevision: number;
  censusRevision: number;
  insurers: GhiCaseInsurerDoc[];
  finalQcr: {
    quoteId: Types.ObjectId;
    qcrId: Types.ObjectId;
    insurerId: Types.ObjectId;
    note: string | null;
    recordedAt: Date;
    recordedBy: Types.ObjectId;
  } | null;
  policy: {
    policyNumber: string;
    issuedOn: string;
    policyStart: string;
    policyEnd: string;
    renewalDate: string;
    insurerId: Types.ObjectId;
    quoteId: Types.ObjectId;
    qcrId: Types.ObjectId;
    fileId: Types.ObjectId;
    census: {
      employees: number;
      lives: number;
      totalSumInsured: Types.Decimal128;
      revision: number;
    };
    ageBands?: { name: string; revision: number | null; bands: unknown[] };
    recordedAt: Date;
    recordedBy: Types.ObjectId;
  } | null;
  /** The family plan assigned to the case; missing or null: none (GMC uses its Data Sheet). */
  planAssignment?: PlanAssignmentDoc | null;
  /** GPA/GTLI only: set when the placement slip places the case (policy stays null). */
  placement?: EbPlacementDoc | null;
  /** N4: missing or null, the standard bands (as before N4). */
  ageBandSelection?: AgeBandSelectionDoc | null;
  activity: Array<{ at: Date; actorId: Types.ObjectId | null; message: string }>;
  createdBy: Types.ObjectId;
  updatedBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const noId = { _id: false, versionKey: false as const, strict: true as const };
const text = { type: String, default: null };

const planAssignmentSchema = new Schema<PlanAssignmentDoc>(
  {
    planId: { type: Schema.Types.ObjectId, ref: 'FamilyPlan', required: true },
    code: { type: String, required: true },
    name: { type: String, required: true },
    versionNumber: { type: Number, required: true },
    effectiveFrom: { type: String, required: true },
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
    parentsAndInLawsMixed: { type: Boolean, required: true },
    openQuestions: { type: [Number], default: [] },
    source: { type: String, enum: PLAN_ASSIGNMENT_SOURCES, required: true },
    assignedAt: { type: Date, required: true },
    assignedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  noId,
);

const ghiCaseSchema = new Schema<GhiCaseDoc>(
  {
    // Not defaulted: cases stored before N1 have no product and read as GMC (never rewritten).
    product: { type: String, enum: EB_PRODUCTS },
    reference: { type: String, required: true },
    type: { type: String, enum: GHI_CASE_TYPES, required: true },
    stage: { type: String, enum: GHI_STAGES, required: true },
    closedReason: text,
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    policyStart: text,
    policyEnd: text,
    dueDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    existingInsurer: text,
    existingPolicyNumber: text,
    gstRatePercent: { type: Schema.Types.Decimal128, required: true },
    // Validated by GhiRequirementsInputSchema before every write.
    requirements: { type: Schema.Types.Mixed, required: true },
    requirementsSaved: { type: Boolean, required: true, default: false },
    requirementsRevision: { type: Number, required: true, default: 0, min: 0 },
    censusRevision: { type: Number, required: true, default: 0, min: 0 },
    insurers: [
      new Schema(
        {
          insurerId: { type: Schema.Types.ObjectId, ref: 'Insurer', required: true },
          status: { type: String, enum: GHI_INSURER_STATUSES, required: true },
          sentVia: { type: String, enum: ['APP', 'OUTSIDE', null], default: null },
          sentAt: { type: Date, default: null },
          sentBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
          dueDate: text,
          lastDispatch: {
            type: new Schema(
              {
                at: { type: Date, required: true },
                result: { type: String, enum: MAIL_RESULTS, required: true },
                error: text,
              },
              noId,
            ),
            default: null,
          },
          declineReason: text,
          sending: {
            type: new Schema(
              { sendId: { type: String, required: true }, at: { type: Date, required: true } },
              noId,
            ),
            default: null,
          },
        },
        noId,
      ),
    ],
    finalQcr: {
      type: new Schema(
        {
          quoteId: { type: Schema.Types.ObjectId, ref: 'GhiQuote', required: true },
          qcrId: { type: Schema.Types.ObjectId, ref: 'GhiQcr', required: true },
          insurerId: { type: Schema.Types.ObjectId, ref: 'Insurer', required: true },
          note: text,
          recordedAt: { type: Date, required: true },
          recordedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
        },
        noId,
      ),
      default: null,
    },
    policy: {
      type: new Schema(
        {
          policyNumber: { type: String, required: true },
          issuedOn: { type: String, required: true },
          policyStart: { type: String, required: true },
          policyEnd: { type: String, required: true },
          renewalDate: { type: String, required: true },
          insurerId: { type: Schema.Types.ObjectId, ref: 'Insurer', required: true },
          quoteId: { type: Schema.Types.ObjectId, ref: 'GhiQuote', required: true },
          qcrId: { type: Schema.Types.ObjectId, ref: 'GhiQcr', required: true },
          fileId: { type: Schema.Types.ObjectId, ref: 'GhiFile', required: true },
          census: {
            type: new Schema(
              {
                employees: { type: Number, required: true },
                lives: { type: Number, required: true },
                totalSumInsured: { type: Schema.Types.Decimal128, required: true },
                revision: { type: Number, required: true },
              },
              noId,
            ),
            required: true,
          },
          // N4: the age bands in force when the policy was recorded; missing before N4.
          ageBands: { type: Schema.Types.Mixed, default: undefined },
          recordedAt: { type: Date, required: true },
          recordedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
        },
        noId,
      ),
      default: null,
    },
    planAssignment: { type: planAssignmentSchema, default: undefined },
    placement: {
      type: new Schema(
        {
          snapshotId: { type: Schema.Types.ObjectId, ref: 'EbPolicySnapshot', required: true },
          issuedAt: { type: Date, required: true },
          issuedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
          policyNumber: text,
          policyStart: text,
          policyEnd: text,
        },
        noId,
      ),
      default: undefined,
    },
    ageBandSelection: {
      type: new Schema<AgeBandSelectionDoc>(
        {
          setId: { type: Schema.Types.ObjectId, ref: 'AgeBandSet', required: true },
          name: { type: String, required: true },
          revision: { type: Number, required: true },
          bands: [
            new Schema(
              {
                label: { type: String, required: true },
                min: { type: Number, required: true },
                max: { type: Number, default: null },
              },
              noId,
            ),
          ],
          selectedAt: { type: Date, required: true },
          selectedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
        },
        noId,
      ),
      default: undefined,
    },
    activity: [
      new Schema(
        {
          at: { type: Date, required: true },
          actorId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
          message: { type: String, required: true },
        },
        noId,
      ),
    ],
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { collection: 'ghi_cases', timestamps: true, strict: 'throw', minimize: false },
);

ghiCaseSchema.index({ reference: 1 }, { unique: true });
ghiCaseSchema.index({ clientId: 1, _id: -1 });
ghiCaseSchema.index({ stage: 1, _id: -1 });
ghiCaseSchema.index({ updatedAt: -1, _id: -1 });
// Employee Benefits (N1, N2): lists by product, and the open cases using a plan.
ghiCaseSchema.index({ product: 1, updatedAt: -1, _id: -1 });
ghiCaseSchema.index({ 'planAssignment.planId': 1, stage: 1 });
// N4: the open cases holding a copy of an age band set.
ghiCaseSchema.index(
  { 'ageBandSelection.setId': 1, stage: 1 },
  { partialFilterExpression: { 'ageBandSelection.setId': { $exists: true } } },
);

export const GhiCaseModel = model<GhiCaseDoc>('GhiCase', ghiCaseSchema);
