import { PERMISSIONS, legacyRolePermissions } from '../src/shared/index.ts';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLogModel } from '../src/modules/audit/audit.model.ts';
import { UserModel } from '../src/modules/users/user.model.ts';
import {
  bearer,
  createTestApp,
  DEFAULT_PASSWORD,
  tokenFor,
  uniqueEmail,
  useTestDatabase,
} from './helpers/app.ts';
import { createRole, tokenWithPermissions, userWithRoles } from './helpers/roles.ts';

// Assigning database roles to users (docs/RBAC.md): validation, escalation, self rules, effective
// permissions, prompt effect and the last-administrator safeguard.

useTestDatabase();
const app = createTestApp();

let admin: { id: string; token: string };

beforeAll(async () => {
  const created = await tokenFor(app, ['ADMIN']);
  admin = { id: created.user.id, token: created.token };
});

const newUser = (roles: unknown) => ({
  email: uniqueEmail('assign'),
  name: 'Assigned User',
  password: DEFAULT_PASSWORD,
  roles,
});

describe('assigning roles', () => {
  it('creates a user with one custom role, named in the user record', async () => {
    const key = await createRole(app, admin.token, ['gpa.view'], 'GPA Viewer');
    const { body } = await request(app)
      .post('/api/v1/users')
      .set(bearer(admin.token))
      .send(newUser([key]))
      .expect(201);
    expect(body).toMatchObject({ roles: [key], roleNames: ['GPA Viewer'] });
  });

  it('gives a user with several roles the union of their permissions', async () => {
    const a = await createRole(app, admin.token, ['gpa.view', 'gpa.edit']);
    const b = await createRole(app, admin.token, ['gtli.view', 'gpa.view']);
    const user = await userWithRoles(app, admin.token, [a, b]);
    const me = (await request(app).get('/api/v1/auth/me').set(bearer(user.token)).expect(200)).body;
    expect(me.permissions).toEqual(['gpa.view', 'gpa.edit', 'gtli.view']);
    expect(me.roles).toEqual([a, b]);
  });

  it('reports the effective permissions of a legacy role exactly as migrated', async () => {
    const manager = await tokenFor(app, ['MANAGER']);
    const me = (await request(app).get('/api/v1/auth/me').set(bearer(manager.token)).expect(200))
      .body;
    expect(me.permissions).toEqual(legacyRolePermissions('MANAGER'));
    expect(me.roleNames).toEqual(['Approver']);
    const adminMe = (await request(app).get('/api/v1/auth/me').set(bearer(admin.token)).expect(200))
      .body;
    expect(adminMe.permissions).toEqual(PERMISSIONS);
  });

  it('refuses roles that do not exist or are malformed', async () => {
    const missing = await request(app)
      .post('/api/v1/users')
      .set(bearer(admin.token))
      .send(newUser(['ROOT']))
      .expect(400);
    expect(JSON.stringify(missing.body.details)).toContain('There is no role ROOT');
    await request(app)
      .post('/api/v1/users')
      .set(bearer(admin.token))
      .send(newUser(['root']))
      .expect(400);
  });

  it('refuses permission arrays in user requests', async () => {
    await request(app)
      .post('/api/v1/users')
      .set(bearer(admin.token))
      .send({ ...newUser(['READ_ONLY']), permissions: ['users.assign_roles'] })
      .expect(400);
    const target = await userWithRoles(app, admin.token, ['READ_ONLY']);
    await request(app)
      .patch(`/api/v1/users/${target.id}`)
      .set(bearer(admin.token))
      .send({ permissions: ['audit.view'] })
      .expect(400);
  });

  it('changes a user’s roles, audited, and the change applies to their next request', async () => {
    const target = await userWithRoles(app, admin.token, ['READ_ONLY']);
    await request(app).get('/api/v1/claims').set(bearer(target.token)).expect(403);
    const { body } = await request(app)
      .patch(`/api/v1/users/${target.id}`)
      .set(bearer(admin.token))
      .send({ roles: ['READ_ONLY', 'PLACEMENT_EXEC'] })
      .expect(200);
    expect(body.roleNames).toEqual(['Read-only', 'Underwriting / Placement']);
    // The same token, without signing in again.
    await request(app).get('/api/v1/claims').set(bearer(target.token)).expect(200);
    const audit = await AuditLogModel.findOne({
      action: 'USER_UPDATED',
      entityId: target.id,
    }).lean();
    expect(audit?.before).toMatchObject({ roles: ['READ_ONLY'] });
    expect(audit?.after).toMatchObject({ roles: ['READ_ONLY', 'PLACEMENT_EXEC'] });
  });

  it('needs users.assign_roles to change roles and to create users', async () => {
    const renamer = await tokenWithPermissions(app, admin.token, ['users.view', 'users.update']);
    // A target whose access is within the renamer's (only users.view).
    const narrow = await createRole(app, admin.token, ['users.view']);
    const target = await userWithRoles(app, admin.token, [narrow]);
    await request(app)
      .patch(`/api/v1/users/${target.id}`)
      .set(bearer(renamer.token))
      .send({ name: 'Renamed' })
      .expect(200);
    await request(app)
      .patch(`/api/v1/users/${target.id}`)
      .set(bearer(renamer.token))
      .send({ roles: [narrow, 'MANAGER'] })
      .expect(403);
    const creator = await tokenWithPermissions(app, admin.token, ['users.view', 'users.create']);
    await request(app)
      .post('/api/v1/users')
      .set(bearer(creator.token))
      .send(newUser(['READ_ONLY']))
      .expect(403);
  });

  it('refuses to assign roles granting permissions the assigner does not hold', async () => {
    const assigner = await tokenWithPermissions(app, admin.token, [
      'users.view',
      'users.create',
      'users.assign_roles',
      'property.view',
      'clients.view',
      'masters.view',
    ]);
    const refused = await request(app)
      .post('/api/v1/users')
      .set(bearer(assigner.token))
      .send(newUser(['ADMIN']))
      .expect(403);
    expect(refused.body.code).toBe('PERMISSION_ESCALATION');
    // Nor can they give themselves a broader role.
    await request(app)
      .patch(`/api/v1/users/${assigner.id}`)
      .set(bearer(assigner.token))
      .send({ roles: [assigner.role, 'MANAGER'] })
      .expect(403);
  });

  it('refuses to manage a user whose access exceeds the actor’s', async () => {
    const deactivator = await tokenWithPermissions(app, admin.token, [
      'users.view',
      'users.deactivate',
    ]);
    const otherAdmin = await tokenFor(app, ['ADMIN']);
    const refused = await request(app)
      .patch(`/api/v1/users/${otherAdmin.user.id}`)
      .set(bearer(deactivator.token))
      .send({ active: false })
      .expect(403);
    expect(refused.body.code).toBe('PERMISSION_ESCALATION');
  });

  it('stops ordinary users from changing their own roles', async () => {
    const user = (await tokenFor(app, ['ACCOUNT_MANAGER'])) as {
      user: { id: string };
      token: string;
    };
    await request(app)
      .patch(`/api/v1/users/${user.user.id}`)
      .set(bearer(user.token))
      .send({ roles: ['ADMIN'] })
      .expect(403);
  });
});

describe('administrator safeguards', () => {
  it('stops an administrator removing their own Administrator role or deactivating themselves, whatever the id case (F-01)', async () => {
    const self = await tokenFor(app, ['ADMIN']);
    for (const id of [self.user.id, self.user.id.toUpperCase()]) {
      const demote = await request(app)
        .patch(`/api/v1/users/${id}`)
        .set(bearer(self.token))
        .send({ roles: ['READ_ONLY'] })
        .expect(409);
      expect(demote.body.code).toBe('SELF_UPDATE_NOT_ALLOWED');
      await request(app)
        .patch(`/api/v1/users/${id}`)
        .set(bearer(self.token))
        .send({ active: false })
        .expect(409);
    }
    const stored = await UserModel.findById(self.user.id).lean();
    expect(stored).toMatchObject({ roles: ['ADMIN'], active: true });
  });

  it('never leaves the system without an active administrator', async () => {
    // Leave exactly one active administrator: deactivate every other one.
    const admins = await UserModel.find({ roles: 'ADMIN', active: true }).lean();
    for (const other of admins) {
      if (other._id.toHexString() !== admin.id) {
        await request(app)
          .patch(`/api/v1/users/${other._id.toHexString()}`)
          .set(bearer(admin.token))
          .send({ active: false })
          .expect(200);
      }
    }
    // A second administrator, then the first demotes them and tries to remove the last one.
    const second = await tokenFor(app, ['ADMIN']);
    await request(app)
      .patch(`/api/v1/users/${second.user.id}`)
      .set(bearer(admin.token))
      .send({ roles: ['READ_ONLY'] })
      .expect(200);
    // The only remaining administrator cannot be removed by anyone with the right to try.
    const userAdmin = await tokenWithPermissions(app, admin.token, PERMISSIONS);
    const refused = await request(app)
      .patch(`/api/v1/users/${admin.id}`)
      .set(bearer(userAdmin.token))
      .send({ active: false })
      .expect(409);
    expect(refused.body.code).toBe('LAST_ADMIN');
    await request(app)
      .patch(`/api/v1/users/${admin.id}`)
      .set(bearer(userAdmin.token))
      .send({ roles: [userAdmin.role] })
      .expect(409);
    expect(await UserModel.countDocuments({ roles: 'ADMIN', active: true })).toBe(1);
  });

  it('refuses a deactivated account on its next request, whatever its roles', async () => {
    const target = await userWithRoles(app, admin.token, ['MANAGER']);
    await request(app).get('/api/v1/auth/me').set(bearer(target.token)).expect(200);
    await request(app)
      .patch(`/api/v1/users/${target.id}`)
      .set(bearer(admin.token))
      .send({ active: false })
      .expect(200);
    await request(app).get('/api/v1/auth/me').set(bearer(target.token)).expect(401);
  });
});
