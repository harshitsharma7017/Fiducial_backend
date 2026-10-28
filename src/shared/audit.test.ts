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
      'ROLE_CREATED',
      'ROLE_SEEDED',
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
      'COVERAGE_CONFIRMATION_RECORDED',
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
      'EB_CASE_CREATED',
      'EB_MEMBER_CREATED',
      'EB_CENSUS_UPLOADED',
      'EB_CENSUS_IMPORTED',
      'EB_RFQ_GENERATED',
      'EB_QUOTE_SAVED',
      'EB_QCR_SAVED',
      'EB_PAYMENT_RECORDED',
      'EB_PLACEMENT_ISSUED',
      'EB_FILE_UPLOADED',
      'FAMILY_PLAN_CREATED',
      'FAMILY_PLAN_VERSION_CREATED',
      'EB_EMPLOYEE_CREATED',
      // N4 adds the Age Band Master.
      'AGE_BAND_SET_CREATED',
      // N8 to N10 add TPA formats and imports, premium adjustments, policy years and saved analyses.
      'TPA_FORMAT_CREATED',
      'TPA_IMPORT_UPLOADED',
      'TPA_IMPORT_COMMITTED',
      'PREMIUM_ADJUSTMENT_RECORDED',
      'POLICY_YEAR_RECORDED',
      'RENEWAL_REPORT_SAVED',
    ]);
    expect(auditActionsOfKind('EDIT')).toEqual([
      'USER_UPDATED',
      'ROLE_UPDATED',
      'ROLE_ACTIVATED',
      'ROLE_DEACTIVATED',
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
      'CLOUD_DOCUMENT_REMOVED',
      'COVERAGE_CONFIRMATION_UPDATED',
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
      'EB_CASE_UPDATED',
      'EB_CASE_CLOSED',
      'EB_REQUIREMENTS_SAVED',
      'EB_PLAN_ASSIGNED',
      'EB_MEMBER_UPDATED',
      'EB_MEMBER_DELETED',
      'EB_CENSUS_ROW_CORRECTED',
      'EB_CENSUS_IMPORT_DISCARDED',
      'EB_INSURERS_UPDATED',
      'EB_INSURER_DECLINED',
      'EB_RFQ_SUBMITTED',
      'EB_QUOTE_FINALIZED',
      'EB_QUOTE_DELETED',
      'EB_QCR_SUBMITTED',
      'EB_CLIENT_DECISION_RECORDED',
      'EB_PAYMENT_UPDATED',
      'FAMILY_PLAN_UPDATED',
      'FAMILY_PLAN_ACTIVATED',
      'FAMILY_PLAN_DEACTIVATED',
      'FAMILY_PLAN_VERSION_UPDATED',
      'FAMILY_PLAN_VERSION_ENDED',
      'FAMILY_PLAN_VERSION_CONFIRMED',
      'CLIENT_PLAN_DEFAULT_SET',
      'CLIENT_PLAN_DEFAULT_CLEARED',
      'EB_EMPLOYEE_UPDATED',
      'EB_EMPLOYEE_RESOLVED',
      'EB_EMPLOYEE_LINKED',
      // N4 adds the Age Band Master and the case's choice of age bands.
      'AGE_BAND_SET_UPDATED',
      'AGE_BAND_SET_ACTIVATED',
      'AGE_BAND_SET_DEACTIVATED',
      'GHI_AGE_BANDS_SELECTED',
      'EB_AGE_BANDS_SELECTED',
      // N8 to N10.
      'TPA_FORMAT_UPDATED',
      'TPA_IMPORT_DISCARDED',
      'TPA_CLAIM_LINKED',
      'PREMIUM_ADJUSTMENT_VOIDED',
      'POLICY_YEAR_UPDATED',
      'CLAIM_IMPORT_SETTINGS_UPDATED',
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
      'EB_RFQ_APPROVED',
      'EB_RFQ_RETURNED',
      'EB_QCR_APPROVED',
      'EB_QCR_REJECTED',
      'FAMILY_PLAN_VERSION_ACTIVATED',
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
      'COVERAGE_CONFIRMATION_EMAILED',
      'COVERAGE_CONFIRMATION_EMAIL_FAILED',
      'GHI_RFQ_EMAILED',
      'GHI_RFQ_EMAIL_FAILED',
      'GHI_RFQ_MARKED_SENT',
      'GHI_QCR_EMAILED',
      'GHI_QCR_EMAIL_FAILED',
      'CLAIM_EMAIL_SENT',
      'CLAIM_EMAIL_FAILED',
      'CLAIM_EMAIL_RETRIED',
      'EB_RFQ_EMAILED',
      'EB_RFQ_EMAIL_FAILED',
      'EB_RFQ_MARKED_SENT',
      'EB_QCR_EMAILED',
      'EB_QCR_EMAIL_FAILED',
    ]);
    expect(auditActionsOfKind('EXPORT')).toEqual([
      'RFQ_DOWNLOADED',
      'QCR_DOWNLOADED',
      'PLACEMENT_SLIP_DOWNLOADED',
      'CLOUD_DOCUMENT_SAVED',
      'CLOUD_DOCUMENT_DOWNLOADED',
      'COVERAGE_CONFIRMATION_DOWNLOADED',
      'GHI_RFQ_DOWNLOADED',
      'GHI_QCR_DOWNLOADED',
      'GHI_PLACEMENT_SLIP_DOWNLOADED',
      'CLAIM_DOCUMENT_DOWNLOADED',
      'EB_RFQ_DOWNLOADED',
      'EB_QCR_DOWNLOADED',
      'EB_PLACEMENT_SLIP_DOWNLOADED',
      'EB_CENSUS_TEMPLATE_DOWNLOADED',
      'EB_CENSUS_ERROR_REPORT_DOWNLOADED',
      // N7 adds the RFQ selection summary download.
      'GHI_SELECTION_SUMMARY_DOWNLOADED',
      'EB_SELECTION_SUMMARY_DOWNLOADED',
      // N10 and N8 add the claims and renewal analysis downloads.
      'CLAIMS_ANALYSIS_DOWNLOADED',
      'RENEWAL_REPORT_DOWNLOADED',
      // N12: the TPA import problems report is audited as an export.
      'TPA_ERROR_REPORT_DOWNLOADED',
    ]);
    // N12 adds the VIEW kind: claim data read, and access refused.
    expect(auditActionsOfKind('VIEW')).toEqual([
      // The quote PDF auto-fill reads a stored attachment and changes nothing.
      'QUOTE_PDF_READ',
      'CLAIM_VIEWED',
      'CLAIMS_LISTED',
      'TPA_CLAIM_VIEWED',
      'CLAIMS_ANALYSIS_VIEWED',
      'CLAIM_ACCESS_DENIED',
    ]);
  });
});

describe('employee benefits audit vocabulary', () => {
  it('gives every employee benefits, family plan and employee action one kind and a label', () => {
    const added = Object.values(AUDIT_ACTIONS).filter((action) =>
      /^(EB_|FAMILY_PLAN_|CLIENT_PLAN_DEFAULT_)/.test(action),
    );
    expect(added.length).toBeGreaterThan(50);
    for (const action of added) {
      expect(AUDIT_ACTION_KINDS[action]).toMatch(/^(CREATE|EDIT|APPROVE|SEND|EXPORT)$/);
      expect(AUDIT_ACTION_LABELS[action].length).toBeGreaterThan(0);
    }
  });

  it('keeps every group health action and label as it was', () => {
    expect(AUDIT_ACTION_LABELS.GHI_CASE_CREATED).toBe('Group health case created');
    expect(AUDIT_ACTION_KINDS.GHI_POLICY_RECORDED).toBe('EDIT');
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
