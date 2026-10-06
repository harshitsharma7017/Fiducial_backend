import {
  AUDIT_ACTION_KINDS,
  auditChanges,
  type AuditActor,
  type AuditLogEntry,
} from '../../shared/index.ts';
import type { AuditLogDoc } from './audit.model.ts';

/** Names resolved for one page of entries: actors by user id, records by "entity:id". */
export interface AuditLookups {
  actors: ReadonlyMap<string, AuditActor>;
  labels: ReadonlyMap<string, string>;
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
export function toAuditLogEntry(doc: AuditLogDoc, lookups: AuditLookups): AuditLogEntry {
  const kind = AUDIT_ACTION_KINDS[doc.action];
  const before = toJson(doc.before);
  const after = toJson(doc.after);
  const isSession = kind === 'SESSION';
  const actorId = doc.userId ? doc.userId.toHexString() : null;
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
    // Users are deactivated, never deleted, so an actor is always found in practice.
    actor: actorId
      ? (lookups.actors.get(actorId) ?? { id: actorId, name: 'Unknown user', email: '' })
      : null,
    changes: isSession ? [] : auditChanges(before, after),
    details: isSession ? asDetails(after) : null,
    requestId: doc.requestId,
  };
}
