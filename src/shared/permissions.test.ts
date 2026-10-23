import { describe, expect, it } from 'vitest';
import {
  LEGACY_PERMISSIONS,
  LEGACY_ROLE_PERMISSIONS,
  LEGACY_SOURCE,
  PERMISSIONS,
  PERMISSION_GROUPS,
  PermissionSchema,
  can,
  casePermission,
  hasAnyPermission,
  hasPermission,
  legacyPermissionsOf,
  legacyRolePermissions,
  type LegacyPermission,
} from './permissions.ts';
import { ROLES, type LegacyRole } from './roles.ts';

// Who could do what before roles became configurable (document 01 personas; Q12 in document 06).
// The migration recreates these five roles with exactly this access.
const EXPECTED: Record<LegacyPermission, readonly LegacyRole[]> = {
  'proposals.view': ['ADMIN', 'MANAGER', 'ACCOUNT_MANAGER', 'PLACEMENT_EXEC', 'READ_ONLY'],
  'proposals.create': ['ADMIN', 'ACCOUNT_MANAGER'],
  'proposals.edit': ['ADMIN', 'ACCOUNT_MANAGER', 'PLACEMENT_EXEC'],
  'proposals.approve': ['ADMIN', 'MANAGER'],
  'proposals.send': ['ADMIN', 'ACCOUNT_MANAGER', 'PLACEMENT_EXEC'],
  'proposals.export': ['ADMIN', 'MANAGER', 'ACCOUNT_MANAGER', 'PLACEMENT_EXEC'],
  'proposals.delete': ['ADMIN'],
  'clients.view': ['ADMIN', 'MANAGER', 'ACCOUNT_MANAGER', 'PLACEMENT_EXEC', 'READ_ONLY'],
  'clients.manage': ['ADMIN', 'ACCOUNT_MANAGER'],
  'masters.view': ['ADMIN', 'MANAGER', 'ACCOUNT_MANAGER', 'PLACEMENT_EXEC', 'READ_ONLY'],
  'masters.manage': ['ADMIN'],
  'users.manage': ['ADMIN'],
  'settings.view': ['ADMIN'],
  'audit.view': ['ADMIN'],
  'claims.view': ['ADMIN', 'MANAGER', 'ACCOUNT_MANAGER', 'PLACEMENT_EXEC'],
  'claims.process': ['ADMIN', 'ACCOUNT_MANAGER', 'PLACEMENT_EXEC'],
  'claims.admin': ['ADMIN'],
};

describe('LEGACY_ROLE_PERMISSIONS', () => {
  it.each(LEGACY_PERMISSIONS)('granted %s to exactly the agreed roles', (permission) => {
    expect(ROLES.filter((role) => can([role], permission))).toEqual(EXPECTED[permission]);
  });

  it('let Read-only users view and nothing else', () => {
    expect(
      LEGACY_ROLE_PERMISSIONS.READ_ONLY.every((permission) => permission.endsWith('.view')),
    ).toBe(true);
  });

  it('combined the permissions of several roles', () => {
    expect(can(['MANAGER'], 'proposals.create')).toBe(false);
    expect(can(['MANAGER', 'ACCOUNT_MANAGER'], 'proposals.create')).toBe(true);
    expect(LEGACY_PERMISSIONS.some((permission) => can([], permission))).toBe(false);
  });
});

describe('the permission catalog', () => {
  it('lists every permission in exactly one group, once', () => {
    const grouped = PERMISSION_GROUPS.flatMap((group) => group.permissions.map((p) => p.key));
    expect([...grouped].sort()).toEqual([...PERMISSIONS].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it('describes every permission and only requires catalog permissions', () => {
    for (const group of PERMISSION_GROUPS) {
      for (const permission of group.permissions) {
        expect(permission.label.length).toBeGreaterThan(0);
        expect(permission.description.length).toBeGreaterThan(0);
        for (const required of permission.requires ?? []) {
          expect(PERMISSIONS).toContain(required);
        }
      }
    }
  });

  it('uses resource.action names', () => {
    for (const permission of PERMISSIONS) expect(permission).toMatch(/^[a-z_]+\.[a-z_]+$/);
  });

  it('rejects permissions outside the catalog', () => {
    expect(PermissionSchema.safeParse('proposals.view').success).toBe(false);
    expect(PermissionSchema.safeParse('everything').success).toBe(false);
    expect(PermissionSchema.safeParse('gpa.edit').success).toBe(true);
  });

  it('names case permissions per line of business', () => {
    expect(casePermission('PROPERTY', 'approve')).toBe('property.approve');
    expect(casePermission('GTLI', 'export')).toBe('gtli.export');
  });

  it('checks permission sets', () => {
    expect(hasPermission(['gmc.view'], 'gmc.view')).toBe(true);
    expect(hasPermission(new Set(['gmc.view'] as const), 'gpa.view')).toBe(false);
    expect(hasPermission(undefined, 'gmc.view')).toBe(false);
    expect(hasAnyPermission(['gpa.view'], ['gmc.view', 'gpa.view'])).toBe(true);
  });
});

describe('migration of the legacy roles', () => {
  it('traces every catalog permission to the legacy permission it was split from', () => {
    for (const permission of PERMISSIONS)
      expect(LEGACY_PERMISSIONS).toContain(LEGACY_SOURCE[permission]);
  });

  it.each(ROLES)(
    'gives %s exactly the catalog permissions its legacy permissions covered',
    (role) => {
      const granted = new Set(legacyRolePermissions(role));
      for (const permission of PERMISSIONS) {
        expect(granted.has(permission)).toBe(can([role], LEGACY_SOURCE[permission]));
      }
    },
  );

  it('gives Admin the whole catalog', () => {
    expect(legacyRolePermissions('ADMIN')).toEqual(PERMISSIONS);
  });

  it('gives Read-only users no create, edit, send, approve, export, delete or manage permission', () => {
    const readOnly = legacyRolePermissions('READ_ONLY');
    expect(
      readOnly.filter((permission) =>
        /\.(create|edit|update|send|approve|export|delete|manage|import|assign_roles)$/.test(
          permission,
        ),
      ),
    ).toEqual(['census.export']);
  });

  it('keeps claims away from Read-only users and approvals away from editors', () => {
    expect(legacyRolePermissions('READ_ONLY').some((p) => p.startsWith('claims'))).toBe(false);
    expect(legacyRolePermissions('PLACEMENT_EXEC')).not.toContain('property.approve');
    expect(legacyRolePermissions('MANAGER')).not.toContain('gmc.edit');
  });

  it('combines legacy roles as a union', () => {
    expect(legacyPermissionsOf(['MANAGER', 'ACCOUNT_MANAGER'])).toEqual(
      PERMISSIONS.filter(
        (permission) =>
          legacyRolePermissions('MANAGER').includes(permission) ||
          legacyRolePermissions('ACCOUNT_MANAGER').includes(permission),
      ),
    );
  });
});
