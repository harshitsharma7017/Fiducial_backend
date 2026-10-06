import { ROLES, type Role } from '../src/shared/index.ts';
import express from 'express';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { errorHandler } from '../src/middleware/error-handler.ts';
import { requirePermission } from '../src/middleware/require-permission.ts';
import { AuditLogModel } from '../src/modules/audit/audit.model.ts';
import {
  DEFAULT_PASSWORD,
  bearer,
  createTestApp,
  createTestUser,
  loginAs,
  tokenFor,
  uniqueEmail,
  useTestDatabase,
} from './helpers/app.ts';

useTestDatabase();
const app = createTestApp();

let adminToken: string;
let adminId: string;

beforeAll(async () => {
  const { user, token } = await tokenFor(app, ['ADMIN']);
  adminToken = token;
  adminId = user.id;
});

const newUser = (overrides: Record<string, unknown> = {}) => ({
  email: uniqueEmail('new'),
  name: 'New Person',
  password: 'a sufficiently long password',
  roles: ['PLACEMENT_EXEC'],
  ...overrides,
});

describe('role enforcement on /api/v1/users', () => {
  it('requires authentication', async () => {
    await request(app).get('/api/v1/users').expect(401);
  });

  it.each(ROLES.filter((role) => role !== 'ADMIN'))('forbids %s', async (role) => {
    const { token } = await tokenFor(app, [role]);
    const list = await request(app).get('/api/v1/users').set(bearer(token)).expect(403);
    expect(list.body.code).toBe('FORBIDDEN');
    await request(app).post('/api/v1/users').set(bearer(token)).send(newUser()).expect(403);
  });
});

describe('requirePermission', () => {
  const probe = (roles: Role[] | null) => {
    const probeApp = express();
    probeApp.use((req, _res, next) => {
      if (roles) req.user = { id: 'x', email: 'x@example.com', name: 'X', roles };
      next();
    });
    probeApp.get('/approve', requirePermission('proposals.approve'), (_req, res) => {
      res.json({ ok: true });
    });
    probeApp.use(errorHandler());
    return request(probeApp).get('/approve');
  };

  it('lets Admin pass every permission check', async () => {
    await probe(['ADMIN']).expect(200);
  });

  it('allows roles that hold the permission and forbids the others', async () => {
    await probe(['MANAGER']).expect(200);
    await probe(['READ_ONLY', 'ACCOUNT_MANAGER']).expect(403);
  });

  it('needs a signed-in user', async () => {
    await probe(null).expect(401);
  });
});

describe('admin user management', () => {
  it('lists users with cursor pagination', async () => {
    await createTestUser();
    await createTestUser();
    const first = await request(app)
      .get('/api/v1/users?limit=2')
      .set(bearer(adminToken))
      .expect(200);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await request(app)
      .get(`/api/v1/users?limit=2&cursor=${first.body.nextCursor as string}`)
      .set(bearer(adminToken))
      .expect(200);
    const firstIds = (first.body.items as Array<{ id: string }>).map((u) => u.id);
    for (const user of second.body.items as Array<{ id: string }>)
      expect(firstIds).not.toContain(user.id);
  });

  it('creates a user and audits it without the password', async () => {
    const body = newUser();
    const response = await request(app)
      .post('/api/v1/users')
      .set(bearer(adminToken))
      .send(body)
      .expect(201);
    expect(response.body).toMatchObject({
      email: body.email,
      roles: ['PLACEMENT_EXEC'],
      active: true,
    });
    expect(JSON.stringify(response.body)).not.toContain(body.password);

    const audit = await AuditLogModel.findOne({
      action: 'USER_CREATED',
      entityId: response.body.id,
    }).lean();
    expect(audit?.userId?.toHexString()).toBe(adminId);
    expect(JSON.stringify(audit)).not.toContain(body.password);

    // The new user can sign in.
    await loginAs(app, { email: body.email, password: body.password });
  });

  it('rejects duplicate emails, weak passwords and unknown roles', async () => {
    const body = newUser();
    await request(app).post('/api/v1/users').set(bearer(adminToken)).send(body).expect(201);
    const duplicate = await request(app)
      .post('/api/v1/users')
      .set(bearer(adminToken))
      .send({ ...body, email: body.email.toUpperCase() })
      .expect(409);
    expect(duplicate.body.code).toBe('EMAIL_TAKEN');

    const weak = await request(app)
      .post('/api/v1/users')
      .set(bearer(adminToken))
      .send(newUser({ password: 'short' }))
      .expect(400);
    expect(weak.body.details).toEqual([expect.objectContaining({ path: 'password' })]);

    await request(app)
      .post('/api/v1/users')
      .set(bearer(adminToken))
      .send(newUser({ roles: ['ROOT'] }))
      .expect(400);
  });

  it('changes roles and records before and after', async () => {
    const target = await createTestUser({ roles: ['READ_ONLY'] });
    const response = await request(app)
      .patch(`/api/v1/users/${target.id}`)
      .set(bearer(adminToken))
      .send({ roles: ['MANAGER', 'ACCOUNT_MANAGER'] })
      .expect(200);
    expect(response.body.roles).toEqual(['MANAGER', 'ACCOUNT_MANAGER']);

    const audit = await AuditLogModel.findOne({
      action: 'USER_UPDATED',
      entityId: target.id,
    }).lean();
    expect(audit?.before).toMatchObject({ roles: ['READ_ONLY'] });
    expect(audit?.after).toMatchObject({ roles: ['MANAGER', 'ACCOUNT_MANAGER'] });
  });

  it('deactivates a user, which ends their session and blocks sign-in', async () => {
    const target = await createTestUser({ roles: ['MANAGER'] });
    const targetToken = await loginAs(app, target);

    await request(app)
      .patch(`/api/v1/users/${target.id}`)
      .set(bearer(adminToken))
      .send({ active: false })
      .expect(200);

    await request(app).get('/api/v1/auth/me').set(bearer(targetToken)).expect(401);
    await request(app)
      .post('/api/v1/auth/login')
      .send({ email: target.email, password: DEFAULT_PASSWORD })
      .expect(401);
  });

  it('stops admins from deactivating themselves or dropping their own Admin role', async () => {
    const deactivate = await request(app)
      .patch(`/api/v1/users/${adminId}`)
      .set(bearer(adminToken))
      .send({ active: false })
      .expect(409);
    expect(deactivate.body.code).toBe('SELF_UPDATE_NOT_ALLOWED');
    await request(app)
      .patch(`/api/v1/users/${adminId}`)
      .set(bearer(adminToken))
      .send({ roles: ['MANAGER'] })
      .expect(409);
  });

  it('validates the id and body', async () => {
    await request(app)
      .patch('/api/v1/users/not-an-id')
      .set(bearer(adminToken))
      .send({ active: false })
      .expect(400);
    await request(app)
      .patch('/api/v1/users/0123456789abcdef01234567')
      .set(bearer(adminToken))
      .send({ active: false })
      .expect(404);
    const target = await createTestUser();
    await request(app)
      .patch(`/api/v1/users/${target.id}`)
      .set(bearer(adminToken))
      .send({})
      .expect(400);
    await request(app)
      .patch(`/api/v1/users/${target.id}`)
      .set(bearer(adminToken))
      .send({ passwordHash: 'x' })
      .expect(400);
  });
});
