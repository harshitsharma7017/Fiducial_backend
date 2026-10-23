import { PERMISSIONS, legacyRolePermissions } from '../src/shared/index.ts';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLogModel } from '../src/modules/audit/audit.model.ts';
import { RoleModel } from '../src/modules/roles/role.model.ts';
import { bearer, createTestApp, tokenFor, useTestDatabase } from './helpers/app.ts';
import { createRole, tokenWithPermissions, userWithRoles } from './helpers/roles.ts';

// Database-driven roles (docs/RBAC.md): creating, editing, activating and deactivating roles, with
// the catalog, uniqueness, escalation, lock and audit rules.

useTestDatabase();
const app = createTestApp();

let admin: string;

beforeAll(async () => {
  admin = (await tokenFor(app, ['ADMIN'])).token;
});

describe('listing roles', () => {
  it('lists the five migrated system roles with their permissions and user counts', async () => {
    const { body } = await request(app).get('/api/v1/roles').set(bearer(admin)).expect(200);
    const byKey = new Map(body.items.map((role: { key: string }) => [role.key, role]));
    for (const key of ['ADMIN', 'MANAGER', 'ACCOUNT_MANAGER', 'PLACEMENT_EXEC', 'READ_ONLY']) {
      expect(byKey.get(key)).toMatchObject({ key, isSystem: true, active: true });
    }
    expect(byKey.get('ADMIN')).toMatchObject({
      name: 'Admin',
      allPermissions: true,
      locked: true,
      permissions: PERMISSIONS,
    });
    expect(byKey.get('READ_ONLY')).toMatchObject({
      name: 'Read-only',
      permissions: legacyRolePermissions('READ_ONLY'),
      locked: false,
    });
    expect((byKey.get('ADMIN') as { userCount: number }).userCount).toBeGreaterThanOrEqual(1);
  });

  it('needs roles.view or users.assign_roles', async () => {
    await request(app).get('/api/v1/roles').expect(401);
    const viewer = (await tokenFor(app, ['READ_ONLY'])).token;
    await request(app).get('/api/v1/roles').set(bearer(viewer)).expect(403);
    const assigner = await tokenWithPermissions(app, admin, ['users.view', 'users.assign_roles']);
    await request(app).get('/api/v1/roles').set(bearer(assigner.token)).expect(200);
  });
});

describe('creating roles', () => {
  it('creates a role with catalog permissions, a stable key and an audit entry', async () => {
    const { body } = await request(app)
      .post('/api/v1/roles')
      .set(bearer(admin))
      .send({
        name: 'GHI Claims Handler',
        description: 'Works group health claims',
        permissions: ['claims.view', 'claims.process', 'gmc.view'],
      })
      .expect(201);
    expect(body).toMatchObject({
      key: 'GHI_CLAIMS_HANDLER',
      name: 'GHI Claims Handler',
      // Stored in catalog order.
      permissions: ['gmc.view', 'claims.view', 'claims.process'],
      isSystem: false,
      locked: false,
      active: true,
      userCount: 0,
      version: 0,
    });
    const audit = await AuditLogModel.findOne({
      action: 'ROLE_CREATED',
      entityId: body.key,
    }).lean();
    expect(audit?.after).toMatchObject({
      key: 'GHI_CLAIMS_HANDLER',
      permissions: ['gmc.view', 'claims.view', 'claims.process'],
    });
  });

  it('refuses duplicate names, ignoring case and spaces', async () => {
    await createRole(app, admin, ['property.view'], 'Fire Underwriter');
    const duplicate = await request(app)
      .post('/api/v1/roles')
      .set(bearer(admin))
      .send({ name: '  fire   UNDERWRITER ', permissions: [] })
      .expect(409);
    expect(duplicate.body.code).toBe('ROLE_NAME_TAKEN');
    // A legacy role's name is taken too.
    await request(app)
      .post('/api/v1/roles')
      .set(bearer(admin))
      .send({ name: 'read-only', permissions: [] })
      .expect(409);
  });

  it('gives a unique key when names differ only in punctuation', async () => {
    const first = await createRole(app, admin, [], 'Finance & Reporting');
    const second = await createRole(app, admin, [], 'Finance, Reporting');
    expect(first).toBe('FINANCE_REPORTING');
    expect(second).toBe('FINANCE_REPORTING_2');
  });

  it('refuses permissions outside the catalog and malformed bodies', async () => {
    for (const permissions of [['proposals.view'], ['everything'], ['gmc.view', 'gmc.view']]) {
      await request(app)
        .post('/api/v1/roles')
        .set(bearer(admin))
        .send({ name: `Bad ${permissions.join(' ')}`.replace(/\./g, ' '), permissions })
        .expect(400);
    }
    await request(app)
      .post('/api/v1/roles')
      .set(bearer(admin))
      .send({ name: 'Sneaky', permissions: [], allPermissions: true })
      .expect(400);
  });

  it('needs roles.create, and roles.assign_permissions to start with permissions', async () => {
    const creator = await tokenWithPermissions(app, admin, [
      'roles.view',
      'roles.create',
      'gmc.view',
    ]);
    await request(app)
      .post('/api/v1/roles')
      .set(bearer(creator.token))
      .send({ name: 'Empty starter', permissions: [] })
      .expect(201);
    await request(app)
      .post('/api/v1/roles')
      .set(bearer(creator.token))
      .send({ name: 'With permissions', permissions: ['gmc.view'] })
      .expect(403);
    const manager = (await tokenFor(app, ['ACCOUNT_MANAGER'])).token;
    await request(app)
      .post('/api/v1/roles')
      .set(bearer(manager))
      .send({ name: 'Nope', permissions: [] })
      .expect(403);
  });

  it('refuses to grant permissions the creator does not hold', async () => {
    const delegate = await tokenWithPermissions(app, admin, [
      'roles.view',
      'roles.create',
      'roles.assign_permissions',
      'gmc.view',
    ]);
    const refused = await request(app)
      .post('/api/v1/roles')
      .set(bearer(delegate.token))
      .send({ name: 'Escalation', permissions: ['gmc.view', 'users.assign_roles'] })
      .expect(403);
    expect(refused.body).toMatchObject({
      code: 'PERMISSION_ESCALATION',
      details: { missing: ['users.assign_roles'] },
    });
  });
});

describe('editing roles', () => {
  it('adds and removes permissions, bumps the version and audits before and after', async () => {
    const key = await createRole(app, admin, ['property.view'], 'Property Manager');
    const { body } = await request(app)
      .patch(`/api/v1/roles/${key}`)
      .set(bearer(admin))
      .send({ permissions: ['property.view', 'property.edit'], expectedVersion: 0 })
      .expect(200);
    expect(body).toMatchObject({ permissions: ['property.view', 'property.edit'], version: 1 });
    const audit = await AuditLogModel.findOne({ action: 'ROLE_UPDATED', entityId: key }).lean();
    expect(audit?.before).toMatchObject({ permissions: ['property.view'] });
    expect(audit?.after).toMatchObject({ permissions: ['property.view', 'property.edit'] });

    const renamed = await request(app)
      .patch(`/api/v1/roles/${key}`)
      .set(bearer(admin))
      .send({ name: 'Property Lead', permissions: [], expectedVersion: 1 })
      .expect(200);
    // The key never changes.
    expect(renamed.body).toMatchObject({ key, name: 'Property Lead', permissions: [] });
  });

  it('refuses a stale edit', async () => {
    const key = await createRole(app, admin, []);
    await request(app)
      .patch(`/api/v1/roles/${key}`)
      .set(bearer(admin))
      .send({ description: 'one', expectedVersion: 0 })
      .expect(200);
    const stale = await request(app)
      .patch(`/api/v1/roles/${key}`)
      .set(bearer(admin))
      .send({ description: 'two', expectedVersion: 0 })
      .expect(409);
    expect(stale.body.code).toBe('ROLE_VERSION_CONFLICT');
  });

  it('keeps the Administrator role locked and system roles named', async () => {
    const locked = await request(app)
      .patch('/api/v1/roles/ADMIN')
      .set(bearer(admin))
      .send({ permissions: ['users.view'], expectedVersion: 0 })
      .expect(409);
    expect(locked.body.code).toBe('ROLE_LOCKED');
    await request(app).post('/api/v1/roles/ADMIN/deactivate').set(bearer(admin)).expect(409);
    const role = await RoleModel.findOne({ key: 'READ_ONLY' }).lean();
    const rename = await request(app)
      .patch('/api/v1/roles/READ_ONLY')
      .set(bearer(admin))
      .send({ name: 'Viewer', expectedVersion: role!.version })
      .expect(409);
    expect(rename.body.code).toBe('ROLE_LOCKED');
  });

  it('lets an administrator narrow a legacy role; holders lose the permission on their next request', async () => {
    const role = await createRole(app, admin, [
      'gpa.view',
      'employees.view',
      'employees.view_salary',
    ]);
    const holder = await userWithRoles(app, admin, [role]);
    const me = async () =>
      (await request(app).get('/api/v1/auth/me').set(bearer(holder.token)).expect(200)).body;
    expect((await me()).permissions).toContain('employees.view_salary');
    await request(app)
      .patch(`/api/v1/roles/${role}`)
      .set(bearer(admin))
      .send({ permissions: ['gpa.view', 'employees.view'], expectedVersion: 0 })
      .expect(200);
    // Same token, no new sign-in.
    expect((await me()).permissions).toEqual(['gpa.view', 'employees.view']);
  });

  it('checks the permission of each field: roles.update for the name, roles.assign_permissions for permissions', async () => {
    const key = await createRole(app, admin, []);
    const renamer = await tokenWithPermissions(app, admin, ['roles.view', 'roles.update']);
    await request(app)
      .patch(`/api/v1/roles/${key}`)
      .set(bearer(renamer.token))
      .send({ description: 'renamed', expectedVersion: 0 })
      .expect(200);
    await request(app)
      .patch(`/api/v1/roles/${key}`)
      .set(bearer(renamer.token))
      .send({ permissions: [], expectedVersion: 1 })
      .expect(403);
  });

  it('refuses to add permissions the editor does not hold', async () => {
    const key = await createRole(app, admin, []);
    const editor = await tokenWithPermissions(app, admin, [
      'roles.view',
      'roles.assign_permissions',
      'property.view',
    ]);
    await request(app)
      .patch(`/api/v1/roles/${key}`)
      .set(bearer(editor.token))
      .send({ permissions: ['property.view'], expectedVersion: 0 })
      .expect(200);
    const refused = await request(app)
      .patch(`/api/v1/roles/${key}`)
      .set(bearer(editor.token))
      .send({ permissions: ['property.view', 'property.approve'], expectedVersion: 1 })
      .expect(403);
    expect(refused.body.code).toBe('PERMISSION_ESCALATION');
    // Nor can they widen the role they hold themselves.
    await request(app)
      .patch(`/api/v1/roles/${editor.role}`)
      .set(bearer(editor.token))
      .send({
        permissions: ['roles.view', 'roles.assign_permissions', 'property.view', 'audit.view'],
        expectedVersion: 0,
      })
      .expect(403);
  });
});

describe('activating and deactivating roles', () => {
  it('refuses to deactivate a role that is still assigned', async () => {
    const key = await createRole(app, admin, ['gmc.view']);
    await userWithRoles(app, admin, [key]);
    const refused = await request(app)
      .post(`/api/v1/roles/${key}/deactivate`)
      .set(bearer(admin))
      .expect(409);
    expect(refused.body).toMatchObject({ code: 'ROLE_IN_USE', details: { userCount: 1 } });
  });

  it('deactivates an unassigned role, which then cannot be assigned, and reactivates it; both audited', async () => {
    const key = await createRole(app, admin, ['gmc.view']);
    const { body } = await request(app)
      .post(`/api/v1/roles/${key}/deactivate`)
      .set(bearer(admin))
      .expect(200);
    expect(body.active).toBe(false);
    const email = `inactive.${Date.now()}@example.com`;
    const refused = await request(app)
      .post('/api/v1/users')
      .set(bearer(admin))
      .send({ email, name: 'X', password: 'correct horse battery staple', roles: [key] })
      .expect(400);
    expect(JSON.stringify(refused.body.details)).toContain('inactive');
    await request(app).post(`/api/v1/roles/${key}/activate`).set(bearer(admin)).expect(200);
    expect(
      await AuditLogModel.countDocuments({
        entityId: key,
        action: { $in: ['ROLE_DEACTIVATED', 'ROLE_ACTIVATED'] },
      }),
    ).toBe(2);
  });

  it('grants nothing through an inactive role', async () => {
    const key = await createRole(app, admin, ['gmc.view']);
    const holder = await userWithRoles(app, admin, [key]);
    // Made inactive directly (the API refuses while it is assigned): the role grants nothing.
    await RoleModel.updateOne({ key }, { $set: { active: false } });
    await request(app).get('/api/v1/ghi/cases').set(bearer(holder.token)).expect(403);
    const me = (await request(app).get('/api/v1/auth/me').set(bearer(holder.token)).expect(200))
      .body;
    expect(me.permissions).toEqual([]);
  });

  it('needs roles.deactivate', async () => {
    const key = await createRole(app, admin, []);
    const viewer = await tokenWithPermissions(app, admin, ['roles.view']);
    await request(app)
      .post(`/api/v1/roles/${key}/deactivate`)
      .set(bearer(viewer.token))
      .expect(403);
  });
});
