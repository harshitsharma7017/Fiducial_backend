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
  CLIENT_CREATED: 'CLIENT_CREATED',
  CLIENT_UPDATED: 'CLIENT_UPDATED',
  CLIENT_LOCATION_CREATED: 'CLIENT_LOCATION_CREATED',
  CLIENT_LOCATION_UPDATED: 'CLIENT_LOCATION_UPDATED',
  INSURER_CREATED: 'INSURER_CREATED',
  INSURER_UPDATED: 'INSURER_UPDATED',
  PROPOSAL_CREATED: 'PROPOSAL_CREATED',
  PROPOSAL_UPDATED: 'PROPOSAL_UPDATED',
  PROPOSAL_STAGE_CHANGED: 'PROPOSAL_STAGE_CHANGED',
  RFQ_DOWNLOADED: 'RFQ_DOWNLOADED',
  RFQ_SENT: 'RFQ_SENT',
  RFQ_EMAILED: 'RFQ_EMAILED',
  RFQ_REMINDER_EMAILED: 'RFQ_REMINDER_EMAILED',
  RFQ_EMAIL_FAILED: 'RFQ_EMAIL_FAILED',
  INSURER_RESPONSE_RECORDED: 'INSURER_RESPONSE_RECORDED',
  EMAIL_TEMPLATE_UPDATED: 'EMAIL_TEMPLATE_UPDATED',
  MASTER_IMPORTED: 'MASTER_IMPORTED',
  OCCUPANCY_CREATED: 'OCCUPANCY_CREATED',
  OCCUPANCY_UPDATED: 'OCCUPANCY_UPDATED',
  PINCODE_CREATED: 'PINCODE_CREATED',
  PINCODE_UPDATED: 'PINCODE_UPDATED',
  MASTER_ACTIVATED: 'MASTER_ACTIVATED',
  MASTER_SUPERSEDED: 'MASTER_SUPERSEDED',
  CATALOG_IMPORTED: 'CATALOG_IMPORTED',
  CATALOG_ITEM_CREATED: 'CATALOG_ITEM_CREATED',
  CATALOG_ITEM_UPDATED: 'CATALOG_ITEM_UPDATED',
  TEMPLATE_UPLOADED: 'TEMPLATE_UPLOADED',
  ADDON_FAVOURITES_UPDATED: 'ADDON_FAVOURITES_UPDATED',
  QUOTE_RECORDED: 'QUOTE_RECORDED',
  QUOTE_ATTACHMENT_UPLOADED: 'QUOTE_ATTACHMENT_UPLOADED',
  QCR_SAVED: 'QCR_SAVED',
  QCR_APPROVED: 'QCR_APPROVED',
  QCR_DOWNLOADED: 'QCR_DOWNLOADED',
  QCR_EMAILED: 'QCR_EMAILED',
  QCR_EMAIL_FAILED: 'QCR_EMAIL_FAILED',
  CLIENT_APPROVAL_RECORDED: 'CLIENT_APPROVAL_RECORDED',
  CLIENT_APPROVAL_FILE_UPLOADED: 'CLIENT_APPROVAL_FILE_UPLOADED',
  PLACEMENT_SLIP_SAVED: 'PLACEMENT_SLIP_SAVED',
  PLACEMENT_SLIP_APPROVED: 'PLACEMENT_SLIP_APPROVED',
  PLACEMENT_SLIP_DOWNLOADED: 'PLACEMENT_SLIP_DOWNLOADED',
  PLACEMENT_SLIP_EMAILED: 'PLACEMENT_SLIP_EMAILED',
  PLACEMENT_SLIP_EMAIL_FAILED: 'PLACEMENT_SLIP_EMAIL_FAILED',
  PLACEMENT_FILE_UPLOADED: 'PLACEMENT_FILE_UPLOADED',
  PLACEMENT_RECORDED: 'PLACEMENT_RECORDED',
  RFQ_EDITED: 'RFQ_EDITED',
  RFQ_GENERATED: 'RFQ_GENERATED',
  RFQ_SUBMITTED: 'RFQ_SUBMITTED',
  RFQ_APPROVED: 'RFQ_APPROVED',
  RFQ_RETURNED: 'RFQ_RETURNED',
} as const;
export const AuditActionSchema = z.enum(AUDIT_ACTIONS);
export type AuditAction = z.infer<typeof AuditActionSchema>;

/** The type of record an entry is about (audit_logs.entity). */
export const AUDIT_ENTITIES = {
  USER: 'user',
  CLIENT: 'client',
  CLIENT_LOCATION: 'client_location',
  INSURER: 'insurer',
  PROPOSAL: 'proposal',
  MASTER_VERSION: 'master_version',
  OCCUPANCY: 'occupancy',
  PINCODE: 'pincode',
  /** A whole product and cover master (entity id: its code, such as "addons"), for imports. */
  CATALOG: 'catalog',
  CATALOG_ITEM: 'catalog_item',
  /** A document template (entity id: its kind, such as "RFQ"). */
  DOCUMENT_TEMPLATE: 'document_template',
  /** An email template (entity id: its kind, "RFQ" or "REMINDER"). */
  EMAIL_TEMPLATE: 'email_template',
} as const;
export const AuditEntitySchema = z.enum(AUDIT_ENTITIES);
export type AuditEntity = z.infer<typeof AuditEntitySchema>;

/**
 * The kind of event, as feature F-3 and requirement AUD-01 list them. SEND covers the RFQ:
 * emailing it, reminding, a failed mail and marking it sent by hand; EXPORT covers downloading it.
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
  CLIENT_CREATED: 'CREATE',
  CLIENT_UPDATED: 'EDIT',
  CLIENT_LOCATION_CREATED: 'CREATE',
  CLIENT_LOCATION_UPDATED: 'EDIT',
  INSURER_CREATED: 'CREATE',
  INSURER_UPDATED: 'EDIT',
  PROPOSAL_CREATED: 'CREATE',
  PROPOSAL_UPDATED: 'EDIT',
  PROPOSAL_STAGE_CHANGED: 'EDIT',
  RFQ_DOWNLOADED: 'EXPORT',
  RFQ_SENT: 'SEND',
  RFQ_EMAILED: 'SEND',
  RFQ_REMINDER_EMAILED: 'SEND',
  RFQ_EMAIL_FAILED: 'SEND',
  INSURER_RESPONSE_RECORDED: 'EDIT',
  EMAIL_TEMPLATE_UPDATED: 'EDIT',
  MASTER_IMPORTED: 'CREATE',
  OCCUPANCY_CREATED: 'CREATE',
  OCCUPANCY_UPDATED: 'EDIT',
  PINCODE_CREATED: 'CREATE',
  PINCODE_UPDATED: 'EDIT',
  MASTER_ACTIVATED: 'APPROVE',
  MASTER_SUPERSEDED: 'EDIT',
  CATALOG_IMPORTED: 'CREATE',
  CATALOG_ITEM_CREATED: 'CREATE',
  CATALOG_ITEM_UPDATED: 'EDIT',
  TEMPLATE_UPLOADED: 'EDIT',
  ADDON_FAVOURITES_UPDATED: 'EDIT',
  QUOTE_RECORDED: 'CREATE',
  QUOTE_ATTACHMENT_UPLOADED: 'CREATE',
  QCR_SAVED: 'EDIT',
  QCR_APPROVED: 'APPROVE',
  QCR_DOWNLOADED: 'EXPORT',
  QCR_EMAILED: 'SEND',
  QCR_EMAIL_FAILED: 'SEND',
  CLIENT_APPROVAL_RECORDED: 'EDIT',
  CLIENT_APPROVAL_FILE_UPLOADED: 'CREATE',
  PLACEMENT_SLIP_SAVED: 'EDIT',
  PLACEMENT_SLIP_APPROVED: 'APPROVE',
  PLACEMENT_SLIP_DOWNLOADED: 'EXPORT',
  PLACEMENT_SLIP_EMAILED: 'SEND',
  PLACEMENT_SLIP_EMAIL_FAILED: 'SEND',
  PLACEMENT_FILE_UPLOADED: 'CREATE',
  PLACEMENT_RECORDED: 'EDIT',
  RFQ_EDITED: 'EDIT',
  RFQ_GENERATED: 'CREATE',
  RFQ_SUBMITTED: 'EDIT',
  RFQ_APPROVED: 'APPROVE',
  RFQ_RETURNED: 'APPROVE',
};

export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  AUTH_LOGIN_SUCCEEDED: 'Signed in',
  AUTH_LOGIN_FAILED: 'Sign-in failed',
  AUTH_LOGOUT: 'Signed out',
  USER_CREATED: 'User created',
  USER_UPDATED: 'User edited',
  CLIENT_CREATED: 'Client created',
  CLIENT_UPDATED: 'Client edited',
  CLIENT_LOCATION_CREATED: 'Risk location added',
  CLIENT_LOCATION_UPDATED: 'Risk location edited',
  INSURER_CREATED: 'Insurer created',
  INSURER_UPDATED: 'Insurer edited',
  PROPOSAL_CREATED: 'Proposal created',
  PROPOSAL_UPDATED: 'Proposal edited',
  PROPOSAL_STAGE_CHANGED: 'Proposal stage changed',
  RFQ_DOWNLOADED: 'RFQ downloaded',
  RFQ_SENT: 'RFQ marked as sent',
  RFQ_EMAILED: 'RFQ emailed',
  RFQ_REMINDER_EMAILED: 'RFQ reminder emailed',
  RFQ_EMAIL_FAILED: 'RFQ email failed',
  INSURER_RESPONSE_RECORDED: 'Insurer response recorded',
  EMAIL_TEMPLATE_UPDATED: 'Email template edited',
  MASTER_IMPORTED: 'Master imported',
  OCCUPANCY_CREATED: 'Occupancy added',
  OCCUPANCY_UPDATED: 'Occupancy edited',
  PINCODE_CREATED: 'Pincode added',
  PINCODE_UPDATED: 'Pincode edited',
  MASTER_ACTIVATED: 'Master activated',
  MASTER_SUPERSEDED: 'Master superseded',
  CATALOG_IMPORTED: 'Product and cover master imported',
  CATALOG_ITEM_CREATED: 'Master row added',
  CATALOG_ITEM_UPDATED: 'Master row edited',
  TEMPLATE_UPLOADED: 'Document template uploaded',
  ADDON_FAVOURITES_UPDATED: 'Add-on favourites changed',
  QUOTE_RECORDED: 'Quote recorded',
  QUOTE_ATTACHMENT_UPLOADED: 'Quote attachment uploaded',
  QCR_SAVED: 'QCR edited',
  QCR_APPROVED: 'QCR approved',
  QCR_DOWNLOADED: 'QCR downloaded',
  QCR_EMAILED: 'QCR emailed to the insured',
  QCR_EMAIL_FAILED: 'QCR email failed',
  CLIENT_APPROVAL_RECORDED: 'Client approval recorded',
  CLIENT_APPROVAL_FILE_UPLOADED: 'Client approval file uploaded',
  PLACEMENT_SLIP_SAVED: 'Placement slip edited',
  PLACEMENT_SLIP_APPROVED: 'Placement slip approved',
  PLACEMENT_SLIP_DOWNLOADED: 'Placement slip downloaded',
  PLACEMENT_SLIP_EMAILED: 'Placement slip emailed to the insurer',
  PLACEMENT_SLIP_EMAIL_FAILED: 'Placement slip email failed',
  PLACEMENT_FILE_UPLOADED: 'Policy or cover note uploaded',
  PLACEMENT_RECORDED: 'Policy or cover note recorded',
  RFQ_EDITED: 'RFQ edited',
  RFQ_GENERATED: 'RFQ version generated',
  RFQ_SUBMITTED: 'RFQ submitted for approval',
  RFQ_APPROVED: 'RFQ approved',
  RFQ_RETURNED: 'RFQ returned',
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
  client: 'Client',
  client_location: 'Risk location',
  insurer: 'Insurer',
  proposal: 'Proposal',
  master_version: 'Master version',
  occupancy: 'Occupancy',
  pincode: 'Pincode',
  catalog: 'Product and cover master',
  catalog_item: 'Master row',
  document_template: 'Document template',
  email_template: 'Email template',
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
  /**
   * A readable name for the record: the user's email, the client's name, the client and location
   * names, the insurer and branch, or the master type and file name.
   */
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
