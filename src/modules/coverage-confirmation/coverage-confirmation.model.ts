import {
  COVERAGE_CONFIRMATION_CHANNELS,
  MAIL_RESULTS,
  type CoverageConfirmationChannel,
  type MailResult,
} from '../../shared/index.ts';
import { Schema, model, type Types } from 'mongoose';

/**
 * Q4: a case's coverage confirmation (one per case). It records the insurer's explicit
 * confirmation of cover and the delivery of a confirmation letter / email to the insured. Policy
 * details are NOT stored here: they are read live from the placement slip and the placed policy /
 * cover note when the confirmation is shown or generated, so there is one source of truth and
 * nothing is duplicated. The insurer's confirmation proof reuses the existing placement files
 * (PlacementFile), referenced here by id — no second correspondence store.
 */
export interface CoverageConfirmationDoc {
  _id: Types.ObjectId;
  proposalId: Types.ObjectId;
  confirmedOn: string;
  insurerReference: string | null;
  channel: CoverageConfirmationChannel;
  notes: string | null;
  /** Configurable, unconfirmed by the client: shown as typed text, never as a signature. */
  signatoryName: string | null;
  signatoryTitle: string | null;
  /** Ids into the case's PlacementFile collection: the insurer's confirmation email / document. */
  attachmentIds: Types.ObjectId[];
  /** The emails sent to the insured (the confirmation), each logged in mail_log too. */
  sends: Array<{
    mailId: Types.ObjectId;
    sendId: string;
    at: Date;
    by: Types.ObjectId;
    to: string[];
    result: MailResult;
    error: string | null;
  }>;
  recordedBy: Types.ObjectId;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const noId = { _id: false, versionKey: false as const, strict: true as const };

const coverageConfirmationSchema = new Schema<CoverageConfirmationDoc>(
  {
    proposalId: { type: Schema.Types.ObjectId, ref: 'Proposal', required: true },
    confirmedOn: { type: String, required: true },
    insurerReference: { type: String, default: null },
    channel: { type: String, enum: COVERAGE_CONFIRMATION_CHANNELS, required: true },
    notes: { type: String, default: null },
    signatoryName: { type: String, default: null },
    signatoryTitle: { type: String, default: null },
    attachmentIds: [{ type: Schema.Types.ObjectId, ref: 'PlacementFile' }],
    sends: [
      new Schema(
        {
          mailId: { type: Schema.Types.ObjectId, ref: 'MailLog', required: true },
          sendId: { type: String, required: true },
          at: { type: Date, required: true },
          by: { type: Schema.Types.ObjectId, ref: 'User', required: true },
          to: { type: [String], required: true },
          result: { type: String, enum: MAIL_RESULTS, required: true },
          error: { type: String, default: null },
        },
        noId,
      ),
    ],
    recordedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { collection: 'coverage_confirmations', timestamps: true, strict: 'throw', minimize: false },
);

// One confirmation per case.
coverageConfirmationSchema.index({ proposalId: 1 }, { unique: true });

export const CoverageConfirmationModel = model<CoverageConfirmationDoc>(
  'CoverageConfirmation',
  coverageConfirmationSchema,
);
