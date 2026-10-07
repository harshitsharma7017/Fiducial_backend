import {
  ADDON_LISTS,
  BURGLARY_BASES,
  EMAIL_TEMPLATE_KINDS,
  EXISTING_POLICY_STATUSES,
  FIRE_GROUPS,
  FIRE_ITEM_KEYS,
  INSURER_STATUSES,
  MAIL_RESULTS,
  OTHER_SECTIONS,
  PROPOSAL_STAGES,
  PROPOSAL_TYPES,
  RESPONSE_STATUSES,
  type AddonList,
  type BurglaryBasis,
  type EmailTemplateKind,
  type InsurerStatus,
  type MailResult,
  type ProposalType,
  type ResponseStatus,
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

/**
 * One insurer on a case. Proposals saved before RFQ email hold only insurerId, status (Not sent
 * or Sent), sentAt and sentBy; the other fields read as null or 0 when missing.
 */
export interface ProposalInsurerDoc {
  insurerId: Types.ObjectId;
  status: InsurerStatus;
  sentVia?: 'APP' | 'OUTSIDE' | null;
  sentAt: Date | null;
  sentBy: Types.ObjectId | null;
  /** The quote due date given to this insurer (YYYY-MM-DD). */
  dueDate?: string | null;
  reminderCount?: number;
  lastRemindedAt?: Date | null;
  response?: {
    status: ResponseStatus;
    note: string | null;
    at: Date;
    by: Types.ObjectId;
  } | null;
  /** The last mail sent or tried for this insurer (the full mail is in mail_log). */
  lastMail?: {
    id: Types.ObjectId;
    kind: EmailTemplateKind;
    at: Date;
    result: MailResult;
  } | null;
  /** Set while a mail to this insurer is being sent, so two sends cannot both mail it. */
  sending?: { sendId: string; at: Date } | null;
}

export interface AnnexureRowDoc {
  description: string;
  quantity: number | null;
  dimensions: string | null;
  makeModel: string | null;
  serialNo: string | null;
  year: string | null;
  sumInsured: Types.Decimal128;
}

/** Last year's policy as copied onto a renewal (the Existing column). */
export interface ExistingPolicyDoc {
  source: string;
  fetchedAt: Date;
  insurer: string;
  policyNumber: string;
  product: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  sections: Array<{ code: string; sumInsured: Types.Decimal128; premium: Money }>;
  fireLines: Array<{ group: FireGroup; sumInsured: Types.Decimal128 }>;
  totalSumInsured: Types.Decimal128;
  netPremium: Money;
  gst: Money;
  totalPremium: Money;
}

/** Renewals: the Existing column as typed on the Data Sheet (C-2), used instead of the copy. */
export interface ExistingFiguresDoc {
  insurer: string;
  policyNumber: string | null;
  fireLines: Array<{ group: FireGroup; amount: Types.Decimal128 }>;
  /** The Fire total when no line is given. */
  fireTotal: Money;
  sections: Array<{
    code: OtherSection;
    sumInsured: Money;
    lines: Array<{ key: string; value: Types.Decimal128 }>;
  }>;
}

export interface CoverDoc {
  name: string;
  required: boolean;
}

export interface ProposalDoc {
  _id: Types.ObjectId;
  reference: string;
  type: ProposalType;
  /** The current stage, kept for filtering: the override when set, else derived from the work. */
  stage: ProposalStage;
  /** A stage set by the team (Quotes Received onwards, or Closed). */
  stageOverride?: ProposalStage | null;
  closedReason?: string | null;
  clientId: Types.ObjectId;
  ownerId: Types.ObjectId;
  /** Dates as YYYY-MM-DD (India time), never shifted by time zones. */
  dueDate: string;
  policyStart: string | null;
  policyEnd?: string | null;
  existingPolicy?: ExistingPolicyDoc | null;
  existingPolicyLookup?: {
    status: (typeof EXISTING_POLICY_STATUSES)[number];
    message: string | null;
    checkedAt: Date;
  } | null;
  /** Missing until the Data Sheet types the Existing column. */
  existingFigures?: ExistingFiguresDoc | null;
  /** The product chosen (C-1); missing or null follows the suggestion. */
  product?: { code: string; reason: string | null } | null;
  /** Add-on covers chosen from the product's lists (C-4). */
  addons?: Array<{ list: AddonList; name: string }>;
  /** Fire's add-on covers asked for (C-6). */
  fireCovers?: CoverDoc[];
  locations: ProposalLocationDoc[];
  fireOption2: Array<{ group: FireGroup; amount: Money }>;
  sections: Array<{
    code: OtherSection;
    included: boolean;
    proposed1: Money;
    proposed2: Money;
    /** The section's Data Sheet lines (SECTION_LINES); missing on older proposals. */
    lines?: Array<{ key: string; value: Types.Decimal128 }>;
    /** Option 2 of the lines (C-2). */
    lines2?: Array<{ key: string; value: Types.Decimal128 }>;
    /** Burglary and Burglary Floater: the basis (C-3). */
    basis?: BurglaryBasis | null;
    /** The section's add-on covers asked for (C-6). */
    covers?: CoverDoc[];
    /** The annexure grid (ANNEXURE_SECTIONS); missing on older proposals. */
    annexure?: AnnexureRowDoc[];
  }>;
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
  /** GST % in force when the proposal was created (tax master), kept for its documents. */
  gstRatePercent?: Types.Decimal128 | null;
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

const lineSchema = () =>
  new Schema(
    {
      key: { type: String, required: true },
      value: { type: Schema.Types.Decimal128, required: true },
    },
    noId,
  );
const coverSchema = () =>
  new Schema(
    { name: { type: String, required: true }, required: { type: Boolean, required: true } },
    noId,
  );

const proposalSchema = new Schema<ProposalDoc>(
  {
    reference: { type: String, required: true },
    type: { type: String, enum: PROPOSAL_TYPES, required: true, default: 'NEW' },
    stage: { type: String, enum: PROPOSAL_STAGES, required: true },
    stageOverride: { type: String, enum: [...PROPOSAL_STAGES, null], default: null },
    closedReason: text,
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    dueDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    policyStart: { type: String, default: null },
    policyEnd: { type: String, default: null },
    existingPolicy: {
      type: new Schema(
        {
          source: { type: String, required: true },
          fetchedAt: { type: Date, required: true },
          insurer: { type: String, required: true },
          policyNumber: { type: String, required: true },
          product: text,
          periodStart: text,
          periodEnd: text,
          sections: [
            new Schema(
              {
                code: { type: String, required: true },
                sumInsured: { type: Schema.Types.Decimal128, required: true },
                premium: money,
              },
              noId,
            ),
          ],
          fireLines: [
            new Schema(
              {
                group: { type: String, enum: FIRE_GROUPS, required: true },
                sumInsured: { type: Schema.Types.Decimal128, required: true },
              },
              noId,
            ),
          ],
          totalSumInsured: { type: Schema.Types.Decimal128, required: true },
          netPremium: money,
          gst: money,
          totalPremium: money,
        },
        noId,
      ),
      default: null,
    },
    existingPolicyLookup: {
      type: new Schema(
        {
          status: { type: String, enum: EXISTING_POLICY_STATUSES, required: true },
          message: text,
          checkedAt: { type: Date, required: true },
        },
        noId,
      ),
      default: null,
    },
    existingFigures: {
      type: new Schema(
        {
          insurer: { type: String, required: true },
          policyNumber: text,
          fireLines: [
            new Schema(
              {
                group: { type: String, enum: FIRE_GROUPS, required: true },
                amount: { type: Schema.Types.Decimal128, required: true },
              },
              noId,
            ),
          ],
          fireTotal: money,
          sections: [
            new Schema(
              {
                code: { type: String, enum: OTHER_SECTIONS, required: true },
                sumInsured: money,
                lines: [lineSchema()],
              },
              noId,
            ),
          ],
        },
        noId,
      ),
      default: undefined,
    },
    product: {
      type: new Schema({ code: { type: String, required: true }, reason: text }, noId),
      default: undefined,
    },
    addons: {
      type: [
        new Schema(
          {
            list: { type: String, enum: ADDON_LISTS, required: true },
            name: { type: String, required: true },
          },
          noId,
        ),
      ],
      default: undefined,
    },
    fireCovers: { type: [coverSchema()], default: undefined },
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
          lines: [lineSchema()],
          lines2: { type: [lineSchema()], default: undefined },
          basis: { type: String, enum: [...BURGLARY_BASES, null], default: undefined },
          covers: { type: [coverSchema()], default: undefined },
          annexure: [
            new Schema(
              {
                description: { type: String, required: true },
                quantity: { type: Number, default: null },
                dimensions: text,
                makeModel: text,
                serialNo: text,
                year: text,
                sumInsured: { type: Schema.Types.Decimal128, required: true },
              },
              noId,
            ),
          ],
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
    gstRatePercent: money,
    insurers: [
      new Schema(
        {
          insurerId: { type: Schema.Types.ObjectId, ref: 'Insurer', required: true },
          status: { type: String, enum: INSURER_STATUSES, required: true },
          sentVia: { type: String, enum: ['APP', 'OUTSIDE', null], default: null },
          sentAt: { type: Date, default: null },
          sentBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
          dueDate: { type: String, default: null },
          reminderCount: { type: Number, default: 0, min: 0 },
          lastRemindedAt: { type: Date, default: null },
          response: {
            type: new Schema(
              {
                status: { type: String, enum: RESPONSE_STATUSES, required: true },
                note: { type: String, default: null },
                at: { type: Date, required: true },
                by: { type: Schema.Types.ObjectId, ref: 'User', required: true },
              },
              noId,
            ),
            default: null,
          },
          lastMail: {
            type: new Schema(
              {
                id: { type: Schema.Types.ObjectId, ref: 'MailLog', required: true },
                kind: { type: String, enum: EMAIL_TEMPLATE_KINDS, required: true },
                at: { type: Date, required: true },
                result: { type: String, enum: MAIL_RESULTS, required: true },
              },
              noId,
            ),
            default: null,
          },
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
proposalSchema.index({ type: 1, _id: -1 });

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
