import {
  GHI_CASE_TYPES,
  GHI_INSURER_STATUSES,
  GHI_STAGES,
  MAIL_RESULTS,
  type GhiCaseType,
  type GhiInsurerStatus,
  type GhiRequirementsInput,
  type GhiStage,
  type MailResult,
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

export interface GhiCaseDoc {
  _id: Types.ObjectId;
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
    recordedAt: Date;
    recordedBy: Types.ObjectId;
  } | null;
  activity: Array<{ at: Date; actorId: Types.ObjectId | null; message: string }>;
  createdBy: Types.ObjectId;
  updatedBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const noId = { _id: false, versionKey: false as const, strict: true as const };
const text = { type: String, default: null };

const ghiCaseSchema = new Schema<GhiCaseDoc>(
  {
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
          recordedAt: { type: Date, required: true },
          recordedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
        },
        noId,
      ),
      default: null,
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

export const GhiCaseModel = model<GhiCaseDoc>('GhiCase', ghiCaseSchema);
