import type { Permission } from '../../src/shared/index.ts';
import type { Express } from 'express';
import request from 'supertest';
import { bearer, DEFAULT_PASSWORD, loginAs, uniqueEmail } from './app.ts';

let counter = 0;

/** Creates a custom role through the API (as the given administrator) and returns its key. */
export async function createRole(
  app: Express,
  adminToken: string,
  permissions: readonly Permission[],
  name?: string,
): Promise<string> {
  counter += 1;
  const response = await request(app)
    .post('/api/v1/roles')
    .set(bearer(adminToken))
    .send({ name: name ?? `Test role ${counter}`, description: 'Created by a test', permissions })
    .expect(201);
  return response.body.key as string;
}

/** Creates a user holding the roles through the API and returns their id and a bearer token. */
export async function userWithRoles(
  app: Express,
  adminToken: string,
  roles: readonly string[],
): Promise<{ id: string; token: string; email: string }> {
  const email = uniqueEmail('rbac');
  const response = await request(app)
    .post('/api/v1/users')
    .set(bearer(adminToken))
    .send({ email, name: 'RBAC Test', password: DEFAULT_PASSWORD, roles })
    .expect(201);
  return {
    id: response.body.id as string,
    email,
    token: await loginAs(app, { email, password: DEFAULT_PASSWORD }),
  };
}

/** A signed-in user whose only role grants exactly these permissions. */
export async function tokenWithPermissions(
  app: Express,
  adminToken: string,
  permissions: readonly Permission[],
): Promise<{ id: string; token: string; role: string }> {
  const role = await createRole(app, adminToken, permissions);
  const user = await userWithRoles(app, adminToken, [role]);
  return { id: user.id, token: user.token, role };
}
