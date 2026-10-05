import { randomUUID } from 'node:crypto';
import type { Role } from '../../src/shared/index.ts';
import type { Express } from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, inject } from 'vitest';
import { createApp } from '../../src/app.ts';
import { loadEnv, type Env } from '../../src/config/env.ts';
import { createLogger } from '../../src/lib/logger.ts';
import { ensureIndexes } from '../../src/models.ts';
import { hashPassword } from '../../src/modules/auth/password.ts';
import { UserModel } from '../../src/modules/users/user.model.ts';

export const TEST_ENV: Env = loadEnv({
  NODE_ENV: 'test',
  MONGODB_URI: 'mongodb://127.0.0.1:1/unused-in-tests',
  JWT_SECRET: 'test-only-secret-with-at-least-32-characters',
  JWT_EXPIRES_IN_SECONDS: '3600',
  CORS_ORIGIN: 'http://localhost:3000',
  LOG_LEVEL: 'silent',
  LOGIN_RATE_LIMIT_MAX: '1000',
});

export const DEFAULT_PASSWORD = 'correct horse battery staple';

/** Connects Mongoose to a fresh database on the shared replica set for this test file. */
export function useTestDatabase(): void {
  beforeAll(async () => {
    mongoose.set('strictQuery', true);
    await mongoose.connect(inject('mongoUri'), { dbName: `test_${randomUUID().slice(0, 8)}` });
    await ensureIndexes();
  });
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
}

export function createTestApp(overrides: Partial<Env> = {}): Express {
  return createApp({
    config: { ...TEST_ENV, ...overrides },
    logger: createLogger({ level: 'silent' }),
  });
}

let counter = 0;
export function uniqueEmail(prefix = 'user'): string {
  counter += 1;
  return `${prefix}.${counter}.${randomUUID().slice(0, 6)}@example.com`;
}

export interface TestUser {
  id: string;
  email: string;
  password: string;
  roles: Role[];
}

/** Creates a user directly in the database (no API call, no audit entry). */
export async function createTestUser(
  options: {
    roles?: Role[];
    email?: string;
    password?: string;
    active?: boolean;
    name?: string;
  } = {},
): Promise<TestUser> {
  const email = options.email ?? uniqueEmail();
  const password = options.password ?? DEFAULT_PASSWORD;
  const roles = options.roles ?? ['READ_ONLY'];
  const user = await UserModel.create({
    email,
    name: options.name ?? 'Test User',
    passwordHash: await hashPassword(password),
    roles,
    active: options.active ?? true,
  });
  return { id: user._id.toHexString(), email, password, roles };
}

export async function loginAs(
  app: Express,
  user: Pick<TestUser, 'email' | 'password'>,
): Promise<string> {
  const response = await request(app)
    .post('/api/v1/auth/login')
    .send({ email: user.email, password: user.password })
    .expect(200);
  return response.body.accessToken as string;
}

/** Creates a user with the given roles and returns a bearer token for them. */
export async function tokenFor(
  app: Express,
  roles: Role[],
): Promise<{ user: TestUser; token: string }> {
  const user = await createTestUser({ roles });
  return { user, token: await loginAs(app, user) };
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
