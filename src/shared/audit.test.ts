import { describe, expect, it } from 'vitest';
import {
  AUDIT_ACTIONS,
  AUDIT_ACTION_KINDS,
  AUDIT_ACTION_LABELS,
  AuditLogQuerySchema,
  auditActionsOfKind,
  auditChanges,
} from './audit.ts';

describe('auditChanges', () => {
  it('lists every field of a new record, with no old value', () => {
    expect(
      auditChanges(null, { email: 'asha@example.com', roles: ['READ_ONLY'], active: true }),
    ).toEqual([
      { field: 'email', before: null, after: 'asha@example.com' },
      { field: 'roles', before: null, after: ['READ_ONLY'] },
      { field: 'active', before: null, after: true },
    ]);
  });

  it('lists only the fields an edit changed, with the old and new values', () => {
    expect(
      auditChanges(
        { email: 'asha@example.com', name: 'Asha', roles: ['READ_ONLY'], active: true },
        {
          email: 'asha@example.com',
          name: 'Asha Menon',
          roles: ['READ_ONLY', 'MANAGER'],
          active: true,
        },
      ),
    ).toEqual([
      { field: 'name', before: 'Asha', after: 'Asha Menon' },
      { field: 'roles', before: ['READ_ONLY'], after: ['READ_ONLY', 'MANAGER'] },
    ]);
  });

  it('finds no change when only the key order of a nested object differs', () => {
    expect(
      auditChanges(
        { stats: { rows: 5, errors: 0 }, note: null },
        { note: null, stats: { errors: 0, rows: 5 } },
      ),
    ).toEqual([]);
  });

  it('treats reordered arrays and changed nested values as changes', () => {
    expect(auditChanges({ roles: ['A', 'B'] }, { roles: ['B', 'A'] })).toHaveLength(1);
    expect(auditChanges({ stats: { rows: 5 } }, { stats: { rows: 6 } })).toEqual([
      { field: 'stats', before: { rows: 5 }, after: { rows: 6 } },
    ]);
  });

  it('counts a missing field as null and keeps fields only the old snapshot had', () => {
    expect(auditChanges({ status: 'DRAFT', activeVersionId: 'v1' }, { status: 'ACTIVE' })).toEqual([
      { field: 'status', before: 'DRAFT', after: 'ACTIVE' },
      { field: 'activeVersionId', before: 'v1', after: null },
    ]);
    expect(auditChanges({ effectiveTo: null }, {})).toEqual([]);
  });

  it('ignores snapshots that are not objects', () => {
    expect(auditChanges(null, null)).toEqual([]);
    expect(auditChanges(['x'], 'y')).toEqual([]);
  });
});

describe('audit vocabulary', () => {
  it('gives every action a kind and a label', () => {
    for (const action of Object.values(AUDIT_ACTIONS)) {
      expect(AUDIT_ACTION_KINDS[action]).toBeDefined();
      expect(AUDIT_ACTION_LABELS[action]).not.toBe('');
    }
  });

  it('finds the actions of each kind', () => {
    expect(auditActionsOfKind('SESSION')).toEqual([
      'AUTH_LOGIN_SUCCEEDED',
      'AUTH_LOGIN_FAILED',
      'AUTH_LOGOUT',
    ]);
    expect(auditActionsOfKind('CREATE')).toEqual([
      'USER_CREATED',
      'CLIENT_CREATED',
      'CLIENT_LOCATION_CREATED',
      'INSURER_CREATED',
      'PROPOSAL_CREATED',
      'MASTER_IMPORTED',
      'OCCUPANCY_CREATED',
      'PINCODE_CREATED',
      'CATALOG_IMPORTED',
      'CATALOG_ITEM_CREATED',
      'QUOTE_RECORDED',
      'QUOTE_ATTACHMENT_UPLOADED',
      'CLIENT_APPROVAL_FILE_UPLOADED',
      'PLACEMENT_FILE_UPLOADED',
      'RFQ_GENERATED',
      'GHI_CASE_CREATED',
      'GHI_MEMBER_CREATED',
      'GHI_CENSUS_UPLOADED',
      'GHI_CENSUS_IMPORTED',
      'GHI_RFQ_GENERATED',
      'GHI_QUOTE_SAVED',
      'GHI_PAYMENT_RECORDED',
      'GHI_FILE_UPLOADED',
      'CLAIM_CREATED',
      'CLAIM_SUBMITTED_BY_EMPLOYEE',
      'CLAIM_DOCUMENT_UPLOADED',
      'CLAIM_LINK_CREATED',
    ]);
    expect(auditActionsOfKind('EDIT')).toEqual([
      'USER_UPDATED',
      'CLIENT_UPDATED',
      'CLIENT_LOCATION_UPDATED',
      'INSURER_UPDATED',
      'PROPOSAL_UPDATED',
      'PROPOSAL_STAGE_CHANGED',
      'PROPOSAL_DELETED',
      'PROPOSAL_RESTORED',
      'INSURER_RESPONSE_RECORDED',
      'EMAIL_TEMPLATE_UPDATED',
      'OCCUPANCY_UPDATED',
      'PINCODE_UPDATED',
      'MASTER_SUPERSEDED',
      'CATALOG_ITEM_UPDATED',
      'TEMPLATE_UPLOADED',
      'ADDON_FAVOURITES_UPDATED',
      'QCR_SAVED',
      'CLIENT_APPROVAL_RECORDED',
      'PLACEMENT_SLIP_SAVED',
      'PLACEMENT_RECORDED',
      'RFQ_EDITED',
      'RFQ_SUBMITTED',
      'GHI_CASE_UPDATED',
      'GHI_CASE_CLOSED',
      'GHI_REQUIREMENTS_SAVED',
      'GHI_MEMBER_UPDATED',
      'GHI_MEMBER_DELETED',
      'GHI_CENSUS_ROW_CORRECTED',
      'GHI_CENSUS_IMPORT_DISCARDED',
      'GHI_INSURERS_UPDATED',
      'GHI_RFQ_SUBMITTED',
      'GHI_INSURER_DECLINED',
      'GHI_QUOTE_FINALIZED',
      'GHI_QUOTE_DELETED',
      'GHI_QCR_SAVED',
      'GHI_QCR_SUBMITTED',
      'GHI_CLIENT_DECISION_RECORDED',
      'GHI_FINAL_QCR_RECORDED',
      'GHI_PAYMENT_UPDATED',
      'GHI_POLICY_RECORDED',
      'CLAIM_UPDATED',
      'CLAIM_STATUS_CHANGED',
      'CLAIM_ASSIGNED',
      'CLAIM_REMARK_ADDED',
      'CLAIM_LINK_REVOKED',
      'CLAIM_EMAIL_TEMPLATE_UPDATED',
      'CLAIM_HR_CONTACT_UPDATED',
    ]);
    expect(auditActionsOfKind('APPROVE')).toEqual([
      'MASTER_ACTIVATED',
      'QCR_APPROVED',
      'PLACEMENT_SLIP_APPROVED',
      'RFQ_APPROVED',
      'RFQ_RETURNED',
      'GHI_RFQ_APPROVED',
      'GHI_RFQ_RETURNED',
      'GHI_QCR_APPROVED',
      'GHI_QCR_REJECTED',
    ]);
    expect(auditActionsOfKind('SEND')).toEqual([
      'RFQ_SENT',
      'RFQ_EMAILED',
      'RFQ_REMINDER_EMAILED',
      'RFQ_EMAIL_FAILED',
      'QCR_EMAILED',
      'QCR_EMAIL_FAILED',
      'PLACEMENT_SLIP_EMAILED',
      'PLACEMENT_SLIP_EMAIL_FAILED',
      'GHI_RFQ_EMAILED',
      'GHI_RFQ_EMAIL_FAILED',
      'GHI_RFQ_MARKED_SENT',
      'GHI_QCR_EMAILED',
      'GHI_QCR_EMAIL_FAILED',
      'CLAIM_EMAIL_SENT',
      'CLAIM_EMAIL_FAILED',
      'CLAIM_EMAIL_RETRIED',
    ]);
    expect(auditActionsOfKind('EXPORT')).toEqual([
      'RFQ_DOWNLOADED',
      'QCR_DOWNLOADED',
      'PLACEMENT_SLIP_DOWNLOADED',
      'GHI_RFQ_DOWNLOADED',
      'GHI_QCR_DOWNLOADED',
      'GHI_PLACEMENT_SLIP_DOWNLOADED',
      'CLAIM_DOCUMENT_DOWNLOADED',
    ]);
  });
});

describe('AuditLogQuerySchema', () => {
  const id = '0123456789abcdef01234567';

  it('needs the record type to filter by record', () => {
    expect(AuditLogQuerySchema.safeParse({ entityId: id }).success).toBe(false);
    expect(AuditLogQuerySchema.safeParse({ entity: 'user', entityId: id }).success).toBe(true);
  });

  it('rejects unknown kinds, entities and keys, and defaults the page size', () => {
    expect(AuditLogQuerySchema.safeParse({ kind: 'DELETE' }).success).toBe(false);
    expect(AuditLogQuerySchema.safeParse({ entity: 'quote' }).success).toBe(false);
    expect(AuditLogQuerySchema.safeParse({ sort: 'at' }).success).toBe(false);
    expect(AuditLogQuerySchema.parse({}).limit).toBe(20);
  });
});
