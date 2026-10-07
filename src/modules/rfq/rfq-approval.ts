import {
  ERROR_CODES,
  RFQ_VERSION_STATUS_LABELS,
  type ProposalRecord,
  type RfqEdits,
  NO_RFQ_EDITS,
} from '../../shared/index.ts';
import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import { conflict } from '../../lib/errors.ts';
import { RfqStateModel, RfqVersionModel, type RfqVersionDoc } from './rfq.model.ts';

// Whether a case's RFQ may go to insurers (R-5): its latest version approved, and the case and the
// RFQ's edits unchanged since that version was generated. Sending, marking sent and reminders
// that carry the RFQ all ask here, and attach that version's files.

/** What the RFQ is made from: the case as the RFQ prints it, and the edits. Not who it went to. */
export function rfqFingerprint(record: ProposalRecord, edits: RfqEdits): string {
  const {
    insurers: _insurers,
    activity: _activity,
    stage: _stage,
    nextStage: _nextStage,
    closedReason: _closedReason,
    locked: _locked,
    missing: _missing,
    updatedAt: _updatedAt,
    existingPolicyLookup: _lookup,
    existingPolicy,
    ...content
  } = record;
  const policy = existingPolicy ? { ...existingPolicy, fetchedAt: null } : null;
  return createHash('sha256')
    .update(JSON.stringify({ content, policy, edits }))
    .digest('hex')
    .slice(0, 32);
}

export async function rfqEditsOf(proposalId: string): Promise<RfqEdits> {
  const state = await RfqStateModel.findOne({ proposalId: new Types.ObjectId(proposalId) }).lean();
  return state?.edits ?? NO_RFQ_EDITS;
}

export interface RfqStanding {
  latest: Omit<RfqVersionDoc, 'xlsx' | 'pdf' | 'record'> | null;
  stale: boolean;
  /** Why the RFQ may not be sent; null when it may. */
  blocked: string | null;
}

/** Where the RFQ of a case stands for sending. */
export async function rfqStanding(record: ProposalRecord, edits?: RfqEdits): Promise<RfqStanding> {
  const latest = await RfqVersionModel.findOne(
    { proposalId: new Types.ObjectId(record.id) },
    { xlsx: 0, pdf: 0, record: 0 },
  )
    .sort({ version: -1 })
    .lean();
  if (!latest) {
    return {
      latest: null,
      stale: false,
      blocked: 'Generate the RFQ and have it approved before sending it.',
    };
  }
  const stale =
    latest.fingerprint !== rfqFingerprint(record, edits ?? (await rfqEditsOf(record.id)));
  const blocked = stale
    ? `The case or the RFQ changed since v${latest.version} was generated. Generate a new version and have it approved.`
    : latest.status !== 'APPROVED'
      ? `RFQ v${latest.version} is ${RFQ_VERSION_STATUS_LABELS[latest.status].toLowerCase()}: it must be approved before it is sent.`
      : null;
  return { latest, stale, blocked };
}

/** The approved RFQ version to send, with its files; refuses an unapproved or outdated RFQ. */
export async function approvedRfq(record: ProposalRecord): Promise<RfqVersionDoc> {
  const standing = await rfqStanding(record);
  if (standing.blocked || !standing.latest) {
    throw conflict(ERROR_CODES.RFQ_NOT_APPROVED, standing.blocked ?? 'The RFQ is not approved.');
  }
  const version = await RfqVersionModel.findById(standing.latest._id).lean();
  if (!version) throw conflict(ERROR_CODES.RFQ_NOT_APPROVED, 'The RFQ is not approved.');
  return version;
}

/** A stored file, read back (a lean read gives a BSON Binary). */
export function bufferOf(raw: unknown): Buffer {
  return Buffer.isBuffer(raw) ? raw : Buffer.from((raw as { buffer: Uint8Array }).buffer);
}
