import { z } from 'zod';
import {
  CursorSchema,
  IsoDateTimeSchema,
  LimitSchema,
  ObjectIdSchema,
  paginatedSchema,
} from './common.ts';

/**
 * Audit actions as stored in audit_logs.action. Each action has a kind and a label below. A new
 * create, edit, approve, send or export action is added here and written with writeAudit(), in
 * the same transaction as the change.
 */
export const AUDIT_ACTIONS = {
  LOGIN_SUCCEEDED: 'AUTH_LOGIN_SUCCEEDED',
  LOGIN_FAILED: 'AUTH_LOGIN_FAILED',
  LOGOUT: 'AUTH_LOGOUT',
  USER_CREATED: 'USER_CREATED',
  USER_UPDATED: 'USER_UPDATED',
  MASTER_IMPORTED: 'MASTER_IMPORTED',
  MASTER_ACTIVATED: 'MASTER_ACTIVATED',
  MASTER_SUPERSEDED: 'MASTER_SUPERSEDED',
} as const;
export const AuditActionSchema = z.enum(AUDIT_ACTIONS);
export type AuditAction = z.infer<typeof AuditActionSchema>;

/** The type of record an entry is about (audit_logs.entity). */
export const AUDIT_ENTITIES = {
  USER: 'user',
  MASTER_VERSION: 'master_version',
} as const;
export const AuditEntitySchema = z.enum(AUDIT_ENTITIES);
export type AuditEntity = z.infer<typeof AuditEntitySchema>;

/**
 * The kind of event, as feature F-3 and requirement AUD-01 list them. SEND and EXPORT have no
 * actions yet: they arrive with RFQ email and document export.
 */
export const AUDIT_KINDS = ['SESSION', 'CREATE', 'EDIT', 'APPROVE', 'SEND', 'EXPORT'] as const;
export const AuditKindSchema = z.enum(AUDIT_KINDS);
export type AuditKind = z.infer<typeof AuditKindSchema>;

export const AUDIT_ACTION_KINDS: Record<AuditAction, AuditKind> = {
  AUTH_LOGIN_SUCCEEDED: 'SESSION',
  AUTH_LOGIN_FAILED: 'SESSION',
  AUTH_LOGOUT: 'SESSION',
  USER_CREATED: 'CREATE',
  USER_UPDATED: 'EDIT',
  MASTER_IMPORTED: 'CREATE',
  MASTER_ACTIVATED: 'APPROVE',
  MASTER_SUPERSEDED: 'EDIT',
};

export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  AUTH_LOGIN_SUCCEEDED: 'Signed in',
  AUTH_LOGIN_FAILED: 'Sign-in failed',
  AUTH_LOGOUT: 'Signed out',
  USER_CREATED: 'User created',
  USER_UPDATED: 'User edited',
  MASTER_IMPORTED: 'Master imported',
  MASTER_ACTIVATED: 'Master activated',
  MASTER_SUPERSEDED: 'Master superseded',
};

export const AUDIT_KIND_LABELS: Record<AuditKind, string> = {
  SESSION: 'Sign-in',
  CREATE: 'Create',
  EDIT: 'Edit',
  APPROVE: 'Approve',
  SEND: 'Send',
  EXPORT: 'Export',
};

export const AUDIT_ENTITY_LABELS: Record<AuditEntity, string> = {
  user: 'User',
  master_version: 'Master version',
};

/** The actions of one kind, for filtering the log. */
export function auditActionsOfKind(kind: AuditKind): AuditAction[] {
  return Object.values(AUDIT_ACTIONS).filter((action) => AUDIT_ACTION_KINDS[action] === kind);
}

/** One field of a record with its value before and after the change. Null means no value. */
export const AuditChangeSchema = z.object({
  field: z.string(),
  before: z.unknown(),
  after: z.unknown(),
});
export type AuditChange = z.infer<typeof AuditChangeSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep equality for JSON values: object key order is ignored, array order is not. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => sameJson(item, b[index]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && sameJson(a[key], b[key]))
    );
  }
  return false;
}

/**
 * The top-level fields that differ between two audit snapshots, with their old and new values.
 * A missing snapshot (a create) or a missing field counts as null. Fields follow the order of
 * `after`, then any that only `before` has.
 */
export function auditChanges(before: unknown, after: unknown): AuditChange[] {
  const previous = isRecord(before) ? before : {};
  const next = isRecord(after) ? after : {};
  const fields = [...new Set([...Object.keys(next), ...Object.keys(previous)])];
  return fields.flatMap((field) => {
    const was = previous[field] ?? null;
    const now = next[field] ?? null;
    return sameJson(was, now) ? [] : [{ field, before: was, after: now }];
  });
}

export const AuditActorSchema = z.object({
  id: ObjectIdSchema,
  name: z.string(),
  email: z.string(),
});
export type AuditActor = z.infer<typeof AuditActorSchema>;

export const AuditLogEntrySchema = z.object({
  id: ObjectIdSchema,
  at: IsoDateTimeSchema,
  action: AuditActionSchema,
  kind: AuditKindSchema,
  entity: AuditEntitySchema,
  entityId: z.string().nullable(),
  /** A readable name for the record: the user's email, or the master type and file name. */
  entityLabel: z.string().nullable(),
  /** Who acted. Null for a failed sign-in and for an import run without --by. */
  actor: AuditActorSchema.nullable(),
  /** Old and new values: every field for a create, only the changed fields otherwise. */
  changes: z.array(AuditChangeSchema),
  /** What a sign-in or sign-out recorded (email tried, IP address, reason): not field changes. */
  details: z.record(z.string(), z.unknown()).nullable(),
  requestId: z.string().nullable(),
});
export type AuditLogEntry = z.infer<typeof AuditLogEntrySchema>;

export const AuditLogQuerySchema = z
  .strictObject({
    kind: AuditKindSchema.optional(),
    entity: AuditEntitySchema.optional(),
    entityId: ObjectIdSchema.optional(),
    actorId: ObjectIdSchema.optional(),
    limit: LimitSchema,
    cursor: CursorSchema.optional(),
  })
  .refine((query) => query.entityId === undefined || query.entity !== undefined, {
    message: 'Choose the record type (entity) to filter by record',
    path: ['entityId'],
  });
export type AuditLogQuery = z.infer<typeof AuditLogQuerySchema>;

export const AuditLogListResponseSchema = paginatedSchema(AuditLogEntrySchema);
export type AuditLogListResponse = z.infer<typeof AuditLogListResponseSchema>;
