import { PERMISSIONS, ROLES, legacyRolePermissions } from '../src/shared/index.ts';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuditLogModel } from '../src/modules/audit/audit.model.ts';
import { RoleModel } from '../src/modules/roles/role.model.ts';
import { ensureSystemRoles, resolvePermissions } from '../src/modules/roles/roles.service.ts';
import { UserModel } from '../src/modules/users/user.model.ts';
import { createTestUser, useTestDatabase } from './helpers/app.ts';

// The migration of the five legacy roles (docs/RBAC.md 4): idempotent, exact, and never
// overwriting an administrator's changes or touching users.

useTestDatabase();

beforeEach(async () => {
  await RoleModel.deleteMany({});
});

describe('ensureSystemRoles', () => {
  it('creates the five system roles with exactly the legacy access, audited', async () => {
    const report = await ensureSystemRoles();
    expect(report.created).toEqual([...ROLES]);
    for (const key of ROLES) {
      const role = await RoleModel.findOne({ key }).lean();
      expect(role).toMatchObject({ key, isSystem: true, active: true, locked: key === 'ADMIN' });
      expect(role?.allPermissions).toBe(key === 'ADMIN');
      expect([...(await resolvePermissions([key]))]).toEqual(
        key === 'ADMIN' ? PERMISSIONS : legacyRolePermissions(key),
      );
    }
    expect(await AuditLogModel.countDocuments({ action: 'ROLE_SEEDED' })).toBeGreaterThanOrEqual(5);
  });

  it('is idempotent: a second run creates nothing', async () => {
    await ensureSystemRoles();
    const again = await ensureSystemRoles();
    expect(again.created).toEqual([]);
    expect(again.existing).toEqual([...ROLES]);
    expect(await RoleModel.countDocuments({ isSystem: true })).toBe(5);
  });

  it('never overwrites a role an administrator changed', async () => {
    await ensureSystemRoles();
    await RoleModel.updateOne(
      { key: 'READ_ONLY' },
      { $set: { permissions: ['property.view'], description: 'Narrowed' } },
    );
    await ensureSystemRoles();
    const role = await RoleModel.findOne({ key: 'READ_ONLY' }).lean();
    expect(role).toMatchObject({ permissions: ['property.view'], description: 'Narrowed' });
  });

  it('leaves users unchanged and gives them the same access through the roles they hold', async () => {
    const user = await createTestUser({ roles: ['ACCOUNT_MANAGER', 'MANAGER'] });
    const before = await UserModel.findById(user.id).lean();
    await ensureSystemRoles();
    const after = await UserModel.findById(user.id).lean();
    expect(after).toEqual(before);
    expect([...(await resolvePermissions(after!.roles))].sort()).toEqual(
      [
        ...new Set([
          ...legacyRolePermissions('ACCOUNT_MANAGER'),
          ...legacyRolePermissions('MANAGER'),
        ]),
      ].sort(),
    );
  });

  it('reports without writing in check mode, and lists unknown and custom role keys', async () => {
    const report = await ensureSystemRoles({ dryRun: true });
    expect(report.created).toEqual([...ROLES]);
    expect(await RoleModel.countDocuments({})).toBe(0);
    await ensureSystemRoles();
    const odd = await createTestUser({ roles: ['READ_ONLY'] });
    await UserModel.updateOne({ _id: odd.id }, { $set: { roles: ['READ_ONLY', 'GONE_ROLE'] } });
    const checked = await ensureSystemRoles({ dryRun: true });
    expect(checked.usersWithUnknownRoles.map((u) => u.id)).toContain(odd.id);
    expect(checked.usersWithCustomRoles.map((u) => u.id)).toContain(odd.id);
  });

  it('grants nothing through a role key that has no role', async () => {
    await ensureSystemRoles();
    expect([...(await resolvePermissions(['GONE_ROLE']))]).toEqual([]);
  });
});
