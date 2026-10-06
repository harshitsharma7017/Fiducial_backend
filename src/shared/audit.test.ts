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
    expect(auditActionsOfKind('CREATE')).toEqual(['USER_CREATED', 'MASTER_IMPORTED']);
    expect(auditActionsOfKind('EDIT')).toEqual(['USER_UPDATED', 'MASTER_SUPERSEDED']);
    expect(auditActionsOfKind('APPROVE')).toEqual(['MASTER_ACTIVATED']);
    // Sending and exporting are not built yet.
    expect(auditActionsOfKind('SEND')).toEqual([]);
    expect(auditActionsOfKind('EXPORT')).toEqual([]);
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
    expect(AuditLogQuerySchema.safeParse({ entity: 'client' }).success).toBe(false);
    expect(AuditLogQuerySchema.safeParse({ sort: 'at' }).success).toBe(false);
    expect(AuditLogQuerySchema.parse({}).limit).toBe(20);
  });
});
