import { ROLES, can, type Permission, type Role } from '../src/shared/index.ts';
import request, { type Test } from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestApp, tokenFor, useTestDatabase } from './helpers/app.ts';
import { seedMasters } from './helpers/masters.ts';

useTestDatabase();
const app = createTestApp();

const tokens = new Map<Role, string>();

beforeAll(async () => {
  await seedMasters();
  for (const role of ROLES) tokens.set(role, (await tokenFor(app, [role])).token);
});

interface Endpoint {
  name: string;
  permission: Permission;
  call: (token: string) => Test;
}

// One call per guarded route. An allowed call may still fail for other reasons (the activation
// id below does not exist), but never with 401 or 403.
const ENDPOINTS: Endpoint[] = [
  {
    name: 'GET /users',
    permission: 'users.manage',
    call: (token) => request(app).get('/api/v1/users').set(bearer(token)),
  },
  {
    name: 'GET /masters/versions',
    permission: 'masters.view',
    call: (token) => request(app).get('/api/v1/masters/versions').set(bearer(token)),
  },
  {
    name: 'GET /masters/occupancies/{tacCode}',
    permission: 'masters.view',
    call: (token) => request(app).get('/api/v1/masters/occupancies/2001').set(bearer(token)),
  },
  {
    name: 'GET /masters/pincodes/{pincode}',
    permission: 'masters.view',
    call: (token) => request(app).get('/api/v1/masters/pincodes/400001').set(bearer(token)),
  },
  {
    name: 'POST /masters/versions/{id}/activate',
    permission: 'masters.manage',
    call: (token) =>
      request(app)
        .post('/api/v1/masters/versions/0123456789abcdef01234567/activate')
        .set(bearer(token)),
  },
  {
    name: 'POST /rating/fire',
    permission: 'rating.use',
    call: (token) =>
      request(app)
        .post('/api/v1/rating/fire')
        .set(bearer(token))
        .send({ occupancyCode: '2001', pincode: '400001', sumInsured: '100000000' }),
  },
  {
    name: 'GET /audit',
    permission: 'audit.view',
    call: (token) => request(app).get('/api/v1/audit').set(bearer(token)),
  },
];

describe.each(ENDPOINTS)('$name needs $permission', ({ permission, call }) => {
  it('needs a session', async () => {
    await call('').expect(401);
  });

  it.each(ROLES)('%s', async (role) => {
    const response = await call(tokens.get(role) ?? '');
    if (can([role], permission)) {
      expect([401, 403]).not.toContain(response.status);
      expect(response.status).toBeLessThan(500);
    } else {
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('FORBIDDEN');
    }
  });
});
