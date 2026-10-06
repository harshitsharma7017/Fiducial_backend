import { describe, expect, it } from 'vitest';
import { PERMISSIONS, ROLE_PERMISSIONS, can, type Permission } from './permissions.ts';
import { ROLES, type Role } from './roles.ts';

// Who may do what (document 01 personas; Q12 in document 06 to confirm). Changing this table
// changes access in both the API and the web app.
const EXPECTED: Record<Permission, readonly Role[]> = {
  'proposals.view': ['ADMIN', 'MANAGER', 'ACCOUNT_MANAGER', 'PLACEMENT_EXEC', 'READ_ONLY'],
  'proposals.create': ['ADMIN', 'ACCOUNT_MANAGER'],
  'proposals.edit': ['ADMIN', 'ACCOUNT_MANAGER', 'PLACEMENT_EXEC'],
  'proposals.approve': ['ADMIN', 'MANAGER'],
  'proposals.send': ['ADMIN', 'ACCOUNT_MANAGER', 'PLACEMENT_EXEC'],
  'proposals.export': ['ADMIN', 'MANAGER', 'ACCOUNT_MANAGER', 'PLACEMENT_EXEC'],
  'masters.view': ['ADMIN', 'MANAGER', 'ACCOUNT_MANAGER', 'PLACEMENT_EXEC', 'READ_ONLY'],
  'masters.manage': ['ADMIN'],
  'rating.use': ['ADMIN', 'MANAGER', 'ACCOUNT_MANAGER', 'PLACEMENT_EXEC'],
  'users.manage': ['ADMIN'],
  'settings.view': ['ADMIN'],
  'audit.view': ['ADMIN'],
};

describe('ROLE_PERMISSIONS', () => {
  it.each(PERMISSIONS)('grants %s to exactly the agreed roles', (permission) => {
    expect(ROLES.filter((role) => can([role], permission))).toEqual(EXPECTED[permission]);
  });

  it('gives Admin every permission', () => {
    expect(PERMISSIONS.every((permission) => can(['ADMIN'], permission))).toBe(true);
  });

  it('lets Read-only users view and nothing else', () => {
    expect(ROLE_PERMISSIONS.READ_ONLY.every((permission) => permission.endsWith('.view'))).toBe(
      true,
    );
  });

  it('lists each permission at most once per role', () => {
    for (const role of ROLES) {
      const permissions = ROLE_PERMISSIONS[role];
      expect(new Set(permissions).size).toBe(permissions.length);
    }
  });
});

describe('can', () => {
  it('combines the permissions of several roles', () => {
    expect(can(['MANAGER'], 'proposals.create')).toBe(false);
    expect(can(['MANAGER', 'ACCOUNT_MANAGER'], 'proposals.create')).toBe(true);
    expect(can(['MANAGER', 'ACCOUNT_MANAGER'], 'proposals.approve')).toBe(true);
  });

  it('denies everything to a user without roles', () => {
    expect(PERMISSIONS.some((permission) => can([], permission))).toBe(false);
  });
});
