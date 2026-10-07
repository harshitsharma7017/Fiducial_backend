import {
  FIRE_GROUPS,
  FIRE_ITEM_KEYS,
  OTHER_SECTIONS,
  PROPOSAL_STAGES,
  type FireGroup,
  type FireItemKey,
  type OtherSection,
  type ProposalStage,
} from '../../shared/index.ts';
import { Schema, model, type Types } from 'mongoose';

type Money = Types.Decimal128 | null;

export interface FireItemDoc {
  key: FireItemKey;
  sqFt: Money;
  ratePerSqFt: Money;
  /** As typed; null on a measured item means area × rate. */
  amount: Money;
}

export interface ProposalLocationDoc {
  locationId: Types.ObjectId;
  fire: FireItemDoc[];
  hypothecation: string | null;
  openStock: string | null;
  /** Missing when empty (Mongoose drops empty objects in nested documents). */
  risk?: Record<string, string | null>;
}

export interface ProposalInsurerDoc {
  insurerId: Types.ObjectId;
  status: 'NOT_SENT' | 'SENT';
  sentAt: Date | null;
  sentBy: Types.ObjectId | null;
}

export interface ProposalDoc {
  _id: Types.ObjectId;
  reference: string;
  type: 'NEW';
  stage: ProposalStage;
  clientId: Types.ObjectId;
  ownerId: Types.ObjectId;
  /** Dates as YYYY-MM-DD (India time), never shifted by time zones. */
  dueDate: string;
  policyStart: string | null;
  locations: ProposalLocationDoc[];
  fireOption2: Array<{ group: FireGroup; amount: Money }>;
  sections: Array<{ code: OtherSection; included: boolean; proposed1: Money; proposed2: Money }>;
  claims: Array<{
    period: string;
    policyType: string | null;
    sumInsured: Money;
    premium: Money;
    claimedAmount: Money;
    remarks: string | null;
    insurer: string | null;
  }>;
  notes: string | null;
  insurers: ProposalInsurerDoc[];
  activity: Array<{ at: Date; actorId: Types.ObjectId | null; message: string }>;
  createdBy: Types.ObjectId;
  updatedBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const money = { type: Schema.Types.Decimal128, default: null };
const text = { type: String, default: null };
// Nested parts drop unknown fields rather than throw: Mongoose's transaction wrapper sets an internal
// `__v` on nested documents when it resets them. Requests are validated strictly before this anyway.
const noId = { _id: false, versionKey: false as const, strict: true as const };

const proposalSchema = new Schema<ProposalDoc>(
  {
    reference: { type: String, required: true },
    type: { type: String, enum: ['NEW'], required: true, default: 'NEW' },
    stage: { type: String, enum: PROPOSAL_STAGES, required: true },
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    dueDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    policyStart: { type: String, default: null },
    locations: [
      new Schema(
        {
          locationId: { type: Schema.Types.ObjectId, ref: 'ClientLocation', required: true },
          fire: [
            new Schema(
              {
                key: { type: String, enum: FIRE_ITEM_KEYS, required: true },
                sqFt: money,
                ratePerSqFt: money,
                amount: money,
              },
              noId,
            ),
          ],
          hypothecation: text,
          openStock: text,
          risk: { type: Schema.Types.Mixed, default: {} },
        },
        noId,
      ),
    ],
    fireOption2: [
      new Schema(
        { group: { type: String, enum: FIRE_GROUPS, required: true }, amount: money },
        noId,
      ),
    ],
    sections: [
      new Schema(
        {
          code: { type: String, enum: OTHER_SECTIONS, required: true },
          included: { type: Boolean, required: true },
          proposed1: money,
          proposed2: money,
        },
        noId,
      ),
    ],
    claims: [
      new Schema(
        {
          period: { type: String, required: true },
          policyType: text,
          sumInsured: money,
          premium: money,
          claimedAmount: money,
          remarks: text,
          insurer: text,
        },
        noId,
      ),
    ],
    notes: text,
    insurers: [
      new Schema(
        {
          insurerId: { type: Schema.Types.ObjectId, ref: 'Insurer', required: true },
          status: { type: String, enum: ['NOT_SENT', 'SENT'], required: true },
          sentAt: { type: Date, default: null },
          sentBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
        },
        noId,
      ),
    ],
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
  { collection: 'proposals', timestamps: true, strict: 'throw', minimize: false },
);

proposalSchema.index({ reference: 1 }, { unique: true });
proposalSchema.index({ clientId: 1, _id: -1 });
proposalSchema.index({ stage: 1, _id: -1 });

export const ProposalModel = model<ProposalDoc>('Proposal', proposalSchema);

/** Sequence numbers, one document per series (for example "proposal-2026"). */
interface CounterDoc {
  _id: string;
  seq: number;
}

const counterSchema = new Schema<CounterDoc>(
  { _id: { type: String, required: true }, seq: { type: Number, required: true } },
  { collection: 'counters', versionKey: false },
);

export const CounterModel = model<CounterDoc>('Counter', counterSchema);
