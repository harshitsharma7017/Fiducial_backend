import {
  AUDIT_ACTION_KINDS,
  RoleSchema,
  auditChanges,
  roleLabel,
  type AuditActor,
  type AuditLogEntry,
  type Role,
} from '../../shared/index.ts';
import type { AuditLogDoc } from './audit.model.ts';

/** Names resolved for one page of entries: actors by user id, records by "entity:id". */
export interface AuditLookups {
  actors: ReadonlyMap<string, AuditActor>;
  labels: ReadonlyMap<string, string>;
  /** Role key → name, so custom roles are named. */
  roleNames?: ReadonlyMap<string, string>;
}

export function recordKey(entity: string, id: string): string {
  return `${entity}:${id}`;
}

/** A JSON copy of a stored snapshot, so dates and ObjectIds leave the API as strings. */
function toJson(value: unknown): unknown {
  return value === undefined || value === null
    ? null
    : (JSON.parse(JSON.stringify(value)) as unknown);
}

function asDetails(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The public view of an audit entry. Sign-in events carry details (email tried, IP, reason);
 * every other event carries its field changes, each with the old and the new value.
 */
/** Valid role codes from a stored snapshot (ignores any that are no longer roles). */
function snapshotRoles(stored: readonly string[] | undefined): Role[] | null {
  if (!stored || stored.length === 0) return null;
  const valid = stored.filter((role): role is Role => RoleSchema.safeParse(role).success);
  return valid.length > 0 ? valid : null;
}

export function toAuditLogEntry(doc: AuditLogDoc, lookups: AuditLookups): AuditLogEntry {
  const kind = AUDIT_ACTION_KINDS[doc.action];
  const before = toJson(doc.before);
  const after = toJson(doc.after);
  const isSession = kind === 'SESSION';
  const actorId = doc.userId ? doc.userId.toHexString() : null;
  // Users are deactivated, never deleted, so an actor is always found in practice.
  const base: AuditActor | null = actorId
    ? (lookups.actors.get(actorId) ?? { id: actorId, name: 'Unknown user', email: '' })
    : null;
  // A1: the role shown is the snapshot taken when the action occurred; only when an entry has no
  // snapshot (written before snapshots existed) does it fall back to the actor's current roles.
  const snapshot = snapshotRoles(doc.actorRoles);
  const actor: AuditActor | null = base
    ? snapshot
      ? { ...base, roles: snapshot, roleLabel: roleLabel(snapshot, lookups.roleNames) }
      : base
    : null;
  return {
    id: doc._id.toHexString(),
    at: doc.at.toISOString(),
    action: doc.action,
    kind,
    entity: doc.entity,
    entityId: doc.entityId,
    entityLabel: doc.entityId
      ? (lookups.labels.get(recordKey(doc.entity, doc.entityId)) ?? null)
      : null,
    actor,
    changes: isSession ? [] : auditChanges(before, after),
    details: isSession ? asDetails(after) : null,
    requestId: doc.requestId,
  };
}
