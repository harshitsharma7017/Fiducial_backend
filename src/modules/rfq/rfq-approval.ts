import {
  ERROR_CODES,
  RFQ_VERSION_STATUS_LABELS,
  RoleSchema,
  roleLabel,
  type ProposalRecord,
  type RfqAttribution,
  type RfqEdits,
  type Role,
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

/** A user's display name and current roles, by id, for attribution. */
export type AttributionUsers = ReadonlyMap<string, { name: string; roles: readonly Role[] }>;

/**
 * A2: the preparer and approver of an RFQ version, from the authoritative records — the version's
 * `createdBy` and its APPROVED event's `by`. Names and roles are resolved from the users map; an
 * actor no longer found shows "Unknown user" with no role. Never derived from who exports the file.
 */
export function rfqAttributionOf(
  version: Pick<RfqVersionDoc, 'version' | 'status' | 'createdBy' | 'events'>,
  users: AttributionUsers,
  /** Role key → name, so custom roles are named. */
  roleNames?: ReadonlyMap<string, string>,
): RfqAttribution {
  const nameOf = (id: Types.ObjectId) => users.get(id.toHexString())?.name ?? 'Unknown user';
  // Prefer the role snapshotted on the event (the role held when it happened); fall back to the
  // user's current roles only for older events with no snapshot. Invalid stored keys are ignored.
  const snapshot = (stored: readonly string[] | undefined): Role[] | null => {
    const valid = (stored ?? []).filter((role): role is Role => RoleSchema.safeParse(role).success);
    return valid.length > 0 ? valid : null;
  };
  const roleOf = (id: Types.ObjectId, event?: { byRoles?: string[] }) =>
    roleLabel(snapshot(event?.byRoles) ?? users.get(id.toHexString())?.roles ?? [], roleNames);
  const generated = version.events.find((event) => event.action === 'GENERATED');
  const approval = version.events.find((event) => event.action === 'APPROVED');
  return {
    version: version.version,
    status: version.status,
    preparedBy: nameOf(version.createdBy),
    preparedByRole: roleOf(version.createdBy, generated),
    approvedBy: approval ? nameOf(approval.by) : null,
    approvedByRole: approval ? roleOf(approval.by, approval) : null,
    approvedAt: approval ? approval.at.toISOString() : null,
  };
}

/** The ids whose names/roles an attribution needs (the creator and the approver). */
export function rfqAttributionUserIds(
  version: Pick<RfqVersionDoc, 'createdBy' | 'events'>,
): Types.ObjectId[] {
  const approval = version.events.find((event) => event.action === 'APPROVED');
  return approval ? [version.createdBy, approval.by] : [version.createdBy];
}
