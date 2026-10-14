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
  PROPOSAL_DELETED: 'PROPOSAL_DELETED',
  PROPOSAL_RESTORED: 'PROPOSAL_RESTORED',
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
  GHI_CASE_CREATED: 'GHI_CASE_CREATED',
  GHI_CASE_UPDATED: 'GHI_CASE_UPDATED',
  GHI_CASE_CLOSED: 'GHI_CASE_CLOSED',
  GHI_REQUIREMENTS_SAVED: 'GHI_REQUIREMENTS_SAVED',
  GHI_MEMBER_CREATED: 'GHI_MEMBER_CREATED',
  GHI_MEMBER_UPDATED: 'GHI_MEMBER_UPDATED',
  GHI_MEMBER_DELETED: 'GHI_MEMBER_DELETED',
  GHI_CENSUS_UPLOADED: 'GHI_CENSUS_UPLOADED',
  GHI_CENSUS_ROW_CORRECTED: 'GHI_CENSUS_ROW_CORRECTED',
  GHI_CENSUS_IMPORTED: 'GHI_CENSUS_IMPORTED',
  GHI_CENSUS_IMPORT_DISCARDED: 'GHI_CENSUS_IMPORT_DISCARDED',
  GHI_INSURERS_UPDATED: 'GHI_INSURERS_UPDATED',
  GHI_RFQ_GENERATED: 'GHI_RFQ_GENERATED',
  GHI_RFQ_SUBMITTED: 'GHI_RFQ_SUBMITTED',
  GHI_RFQ_APPROVED: 'GHI_RFQ_APPROVED',
  GHI_RFQ_RETURNED: 'GHI_RFQ_RETURNED',
  GHI_RFQ_DOWNLOADED: 'GHI_RFQ_DOWNLOADED',
  GHI_RFQ_EMAILED: 'GHI_RFQ_EMAILED',
  GHI_RFQ_EMAIL_FAILED: 'GHI_RFQ_EMAIL_FAILED',
  GHI_RFQ_MARKED_SENT: 'GHI_RFQ_MARKED_SENT',
  GHI_INSURER_DECLINED: 'GHI_INSURER_DECLINED',
  GHI_QUOTE_SAVED: 'GHI_QUOTE_SAVED',
  GHI_QUOTE_FINALIZED: 'GHI_QUOTE_FINALIZED',
  GHI_QUOTE_DELETED: 'GHI_QUOTE_DELETED',
  GHI_QCR_SAVED: 'GHI_QCR_SAVED',
  GHI_QCR_SUBMITTED: 'GHI_QCR_SUBMITTED',
  GHI_QCR_APPROVED: 'GHI_QCR_APPROVED',
  GHI_QCR_REJECTED: 'GHI_QCR_REJECTED',
  GHI_QCR_DOWNLOADED: 'GHI_QCR_DOWNLOADED',
  GHI_QCR_EMAILED: 'GHI_QCR_EMAILED',
  GHI_QCR_EMAIL_FAILED: 'GHI_QCR_EMAIL_FAILED',
  GHI_CLIENT_DECISION_RECORDED: 'GHI_CLIENT_DECISION_RECORDED',
  GHI_FINAL_QCR_RECORDED: 'GHI_FINAL_QCR_RECORDED',
  GHI_PAYMENT_RECORDED: 'GHI_PAYMENT_RECORDED',
  GHI_PAYMENT_UPDATED: 'GHI_PAYMENT_UPDATED',
  GHI_PLACEMENT_SLIP_DOWNLOADED: 'GHI_PLACEMENT_SLIP_DOWNLOADED',
  GHI_POLICY_RECORDED: 'GHI_POLICY_RECORDED',
  GHI_FILE_UPLOADED: 'GHI_FILE_UPLOADED',
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
  /** A group health (GHI) case; its census, quotes and payments are audited against it. */
  GHI_CASE: 'ghi_case',
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
  PROPOSAL_DELETED: 'EDIT',
  PROPOSAL_RESTORED: 'EDIT',
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
  GHI_CASE_CREATED: 'CREATE',
  GHI_CASE_UPDATED: 'EDIT',
  GHI_CASE_CLOSED: 'EDIT',
  GHI_REQUIREMENTS_SAVED: 'EDIT',
  GHI_MEMBER_CREATED: 'CREATE',
  GHI_MEMBER_UPDATED: 'EDIT',
  GHI_MEMBER_DELETED: 'EDIT',
  GHI_CENSUS_UPLOADED: 'CREATE',
  GHI_CENSUS_ROW_CORRECTED: 'EDIT',
  GHI_CENSUS_IMPORTED: 'CREATE',
  GHI_CENSUS_IMPORT_DISCARDED: 'EDIT',
  GHI_INSURERS_UPDATED: 'EDIT',
  GHI_RFQ_GENERATED: 'CREATE',
  GHI_RFQ_SUBMITTED: 'EDIT',
  GHI_RFQ_APPROVED: 'APPROVE',
  GHI_RFQ_RETURNED: 'APPROVE',
  GHI_RFQ_DOWNLOADED: 'EXPORT',
  GHI_RFQ_EMAILED: 'SEND',
  GHI_RFQ_EMAIL_FAILED: 'SEND',
  GHI_RFQ_MARKED_SENT: 'SEND',
  GHI_INSURER_DECLINED: 'EDIT',
  GHI_QUOTE_SAVED: 'CREATE',
  GHI_QUOTE_FINALIZED: 'EDIT',
  GHI_QUOTE_DELETED: 'EDIT',
  GHI_QCR_SAVED: 'EDIT',
  GHI_QCR_SUBMITTED: 'EDIT',
  GHI_QCR_APPROVED: 'APPROVE',
  GHI_QCR_REJECTED: 'APPROVE',
  GHI_QCR_DOWNLOADED: 'EXPORT',
  GHI_QCR_EMAILED: 'SEND',
  GHI_QCR_EMAIL_FAILED: 'SEND',
  GHI_CLIENT_DECISION_RECORDED: 'EDIT',
  GHI_FINAL_QCR_RECORDED: 'EDIT',
  GHI_PAYMENT_RECORDED: 'CREATE',
  GHI_PAYMENT_UPDATED: 'EDIT',
  GHI_PLACEMENT_SLIP_DOWNLOADED: 'EXPORT',
  GHI_POLICY_RECORDED: 'EDIT',
  GHI_FILE_UPLOADED: 'CREATE',
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
  PROPOSAL_DELETED: 'Proposal moved to the Deleted bin',
  PROPOSAL_RESTORED: 'Proposal restored from the Deleted bin',
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
  CATALOG_IMPORTED: 'Policy and cover master imported',
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
  GHI_CASE_CREATED: 'Group health case created',
  GHI_CASE_UPDATED: 'Group health case edited',
  GHI_CASE_CLOSED: 'Group health case closed',
  GHI_REQUIREMENTS_SAVED: 'Group health Data Sheet saved',
  GHI_MEMBER_CREATED: 'Census member added',
  GHI_MEMBER_UPDATED: 'Census member edited',
  GHI_MEMBER_DELETED: 'Census member removed',
  GHI_CENSUS_UPLOADED: 'Census file checked',
  GHI_CENSUS_ROW_CORRECTED: 'Census row corrected',
  GHI_CENSUS_IMPORTED: 'Census imported',
  GHI_CENSUS_IMPORT_DISCARDED: 'Census file discarded',
  GHI_INSURERS_UPDATED: 'Group health insurers chosen',
  GHI_RFQ_GENERATED: 'Group health RFQ generated',
  GHI_RFQ_SUBMITTED: 'Group health RFQ submitted for approval',
  GHI_RFQ_APPROVED: 'Group health RFQ approved',
  GHI_RFQ_RETURNED: 'Group health RFQ returned',
  GHI_RFQ_DOWNLOADED: 'Group health RFQ downloaded',
  GHI_RFQ_EMAILED: 'Group health RFQ emailed',
  GHI_RFQ_EMAIL_FAILED: 'Group health RFQ email failed',
  GHI_RFQ_MARKED_SENT: 'Group health RFQ marked as sent',
  GHI_INSURER_DECLINED: 'Group health insurer declined',
  GHI_QUOTE_SAVED: 'Group health quote saved',
  GHI_QUOTE_FINALIZED: 'Group health quote recorded',
  GHI_QUOTE_DELETED: 'Group health draft quote deleted',
  GHI_QCR_SAVED: 'Group health QCR saved',
  GHI_QCR_SUBMITTED: 'Group health QCR submitted for approval',
  GHI_QCR_APPROVED: 'Group health QCR approved',
  GHI_QCR_REJECTED: 'Group health QCR rejected',
  GHI_QCR_DOWNLOADED: 'Group health QCR downloaded',
  GHI_QCR_EMAILED: 'Group health QCR emailed to the client',
  GHI_QCR_EMAIL_FAILED: 'Group health QCR email failed',
  GHI_CLIENT_DECISION_RECORDED: 'Group health client decision recorded',
  GHI_FINAL_QCR_RECORDED: 'Group health final QCR recorded',
  GHI_PAYMENT_RECORDED: 'Group health payment recorded',
  GHI_PAYMENT_UPDATED: 'Group health payment edited',
  GHI_PLACEMENT_SLIP_DOWNLOADED: 'Group health placement slip downloaded',
  GHI_POLICY_RECORDED: 'Group health policy recorded',
  GHI_FILE_UPLOADED: 'Group health file uploaded',
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
  catalog: 'Policy and cover master',
  catalog_item: 'Master row',
  document_template: 'Document template',
  email_template: 'Email template',
  ghi_case: 'Group health case',
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
