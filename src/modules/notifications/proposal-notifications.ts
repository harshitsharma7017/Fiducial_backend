import type { NotificationEvent } from '../../shared/index.ts';
import type { Logger } from '../../lib/logger.ts';
import { ProposalModel } from '../proposals/proposal.model.ts';
import { approverIds, notify, type NotifyInput } from './notifications.service.ts';

// A4: builds and emits the notifications for Property-proposal events, from the authoritative case
// record. Called AFTER the business transaction commits (a notification must never appear for a
// change that rolled back). Recipients come from real relationships: the case owner, the case
// creator, and the approval group (users who may approve). The acting user is excluded, so a
// person is not notified of their own action. Each notification carries a stable dedupeKey so a
// retried request never duplicates it.

interface CaseActors {
  proposalId: string;
  reference: string;
  ownerId: string | null;
  createdBy: string | null;
}

/** The owner, creator and reference of a case, for addressing its notifications. */
export async function caseActors(proposalId: string): Promise<CaseActors | null> {
  const doc = await ProposalModel.findById(proposalId, {
    reference: 1,
    ownerId: 1,
    createdBy: 1,
  }).lean();
  if (!doc) return null;
  return {
    proposalId,
    reference: doc.reference,
    ownerId: doc.ownerId?.toHexString() ?? null,
    createdBy: doc.createdBy?.toHexString() ?? null,
  };
}

function dedupe(recipients: readonly (string | null | undefined)[], exclude: string): string[] {
  return [...new Set(recipients.filter((id): id is string => Boolean(id) && id !== exclude))];
}

interface ProposalEventOptions {
  proposalId: string;
  event: NotificationEvent;
  /** The user who performed the action; never notified of their own action. */
  actorId: string;
  title: string;
  message: string;
  /** "approvers" notifies the approval group; "owners" notifies the owner and creator. */
  audience: 'approvers' | 'owners';
  /** Makes the notification idempotent for this milestone (e.g. `rfq-approved:v3`). */
  milestone: string;
  logger?: Logger;
}

interface GhiCaseEventOptions {
  caseId: string;
  event: NotificationEvent;
  actorId: string;
  title: string;
  message: string;
  milestone: string;
  logger?: Logger;
}

/**
 * Emits a Group Health / Employee Benefits case notification to the case owner and creator (A4,
 * e.g. a payment recorded). The entity is `eb_case` for GPA/GTLI, else `ghi_case`, so the frontend
 * resolves the right case page. Safe to call after commit.
 */
export async function notifyGhiCaseEvent(options: GhiCaseEventOptions): Promise<number> {
  const { GhiCaseModel } = await import('../ghi/ghi-case.model.ts');
  const doc = await GhiCaseModel.findById(options.caseId, {
    reference: 1,
    ownerId: 1,
    createdBy: 1,
    product: 1,
  }).lean();
  if (!doc) return 0;
  const recipients = dedupe(
    [doc.ownerId?.toHexString(), doc.createdBy?.toHexString()],
    options.actorId,
  );
  if (recipients.length === 0) return 0;
  const entity = doc.product && doc.product !== 'GMC' ? 'eb_case' : 'ghi_case';
  return notify(
    recipients.map((recipientId) => ({
      recipientId,
      event: options.event,
      title: options.title,
      message: options.message,
      entity,
      entityId: options.caseId,
      proposalId: null,
      reference: doc.reference,
      dedupeKey: options.milestone,
    })),
    options.logger,
  );
}

/**
 * Emits a Property-proposal notification to the right audience. Safe to call after commit; returns
 * the number created (0 when the case is gone or no eligible recipient remains).
 */
export async function notifyProposalEvent(options: ProposalEventOptions): Promise<number> {
  const actors = await caseActors(options.proposalId);
  if (!actors) return 0;
  const recipients =
    options.audience === 'approvers'
      ? dedupe(await approverIds(), options.actorId)
      : dedupe([actors.ownerId, actors.createdBy], options.actorId);
  if (recipients.length === 0) return 0;
  const inputs: NotifyInput[] = recipients.map((recipientId) => ({
    recipientId,
    event: options.event,
    title: options.title,
    message: options.message,
    entity: 'proposal',
    entityId: options.proposalId,
    proposalId: options.proposalId,
    reference: actors.reference,
    dedupeKey: `${options.milestone}`,
  }));
  return notify(inputs, options.logger);
}
