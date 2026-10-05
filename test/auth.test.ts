import { INVALID_CREDENTIALS_MESSAGE } from '../src/shared/index.ts';
import { SignJWT } from 'jose';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { AuditLogModel } from '../src/modules/audit/audit.model.ts';
import { UserModel } from '../src/modules/users/user.model.ts';
import {
  bearer,
  createTestApp,
  createTestUser,
  loginAs,
  uniqueEmail,
  useTestDatabase,
} from './helpers/app.ts';

useTestDatabase();
const app = createTestApp();

const invalidCredentials = { message: INVALID_CREDENTIALS_MESSAGE, code: 'INVALID_CREDENTIALS' };

const login = (email: string, password: string) =>
  request(app).post('/api/v1/auth/login').send({ email, password });

describe('POST /api/v1/auth/login', () => {
  it('signs in and returns a token and the user without secrets', async () => {
    const user = await createTestUser({ roles: ['MANAGER'] });
    const response = await login(user.email.toUpperCase(), user.password).expect(200);

    expect(response.body).toEqual({
      accessToken: expect.any(String),
      expiresIn: 3600,
      user: expect.objectContaining({
        id: user.id,
        email: user.email,
        roles: ['MANAGER'],
        active: true,
      }),
    });
    expect(response.body.user.passwordHash).toBeUndefined();
    expect(response.body.user.lastLoginAt).toEqual(expect.any(String));
    expect(response.headers['cache-control']).toBe('no-store');

    const audit = await AuditLogModel.findOne({
      action: 'AUTH_LOGIN_SUCCEEDED',
      entityId: user.id,
    }).lean();
    expect(audit?.userId?.toHexString()).toBe(user.id);
  });

  it('rejects a wrong password and audits the failure', async () => {
    const user = await createTestUser();
    const response = await login(user.email, 'not the right password').expect(401);
    expect(response.body).toEqual(invalidCredentials);

    const audit = await AuditLogModel.findOne({
      action: 'AUTH_LOGIN_FAILED',
      entityId: user.id,
    }).lean();
    expect(audit?.after).toMatchObject({ reason: 'WRONG_PASSWORD', failedAttempts: 1 });
  });

  it('gives the same answer for unknown and inactive users', async () => {
    const unknown = await login(uniqueEmail('nobody'), 'whatever-password').expect(401);
    const inactive = await createTestUser({ active: false });
    const inactiveResponse = await login(inactive.email, inactive.password).expect(401);
    expect(unknown.body).toEqual(invalidCredentials);
    expect(inactiveResponse.body).toEqual(invalidCredentials);
  });

  it('locks the account for 15 minutes after 5 failed attempts', async () => {
    const user = await createTestUser();
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await login(user.email, `wrong password ${attempt}`).expect(401);
    }

    const locked = await UserModel.findById(user.id).lean();
    expect(locked?.lockedUntil).toBeInstanceOf(Date);
    const minutes = (locked!.lockedUntil!.getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(14);
    expect(minutes).toBeLessThanOrEqual(15);

    // Even the right password is refused while locked, with the same message.
    const whileLocked = await login(user.email, user.password).expect(401);
    expect(whileLocked.body).toEqual(invalidCredentials);
    const lockedAudit = await AuditLogModel.findOne({
      entityId: user.id,
      'after.reason': 'LOCKED',
    }).lean();
    expect(lockedAudit).not.toBeNull();

    // Once the lock has passed, the right password works and the counters reset.
    await UserModel.updateOne(
      { _id: user.id },
      { $set: { lockedUntil: new Date(Date.now() - 1000) } },
    );
    await login(user.email, user.password).expect(200);
    const unlocked = await UserModel.findById(user.id).lean();
    expect(unlocked).toMatchObject({ failedLoginCount: 0, lockedUntil: null });
  });

  it('resets the failure count after a successful sign-in', async () => {
    const user = await createTestUser();
    for (let attempt = 1; attempt <= 4; attempt += 1)
      await login(user.email, 'wrong password').expect(401);
    await login(user.email, user.password).expect(200);
    await login(user.email, 'wrong password').expect(401);
    const doc = await UserModel.findById(user.id).lean();
    expect(doc).toMatchObject({ failedLoginCount: 1, lockedUntil: null });
  });

  it('validates input strictly and rejects operator injection', async () => {
    const missing = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'a@example.com' })
      .expect(400);
    expect(missing.body.code).toBe('VALIDATION_ERROR');
    expect(missing.body.details).toEqual([
      expect.objectContaining({ location: 'body', path: 'password' }),
    ]);

    await request(app)
      .post('/api/v1/auth/login')
      .send({ email: { $gt: '' }, password: { $gt: '' } })
      .expect(400);
    await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'a@example.com', password: 'x', isAdmin: true })
      .expect(400);
  });

  it('rate limits sign-in attempts per IP', async () => {
    const limited = createTestApp({ LOGIN_RATE_LIMIT_MAX: 3 });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await request(limited)
        .post('/api/v1/auth/login')
        .send({ email: uniqueEmail(), password: 'x' })
        .expect(401);
    }
    const response = await request(limited)
      .post('/api/v1/auth/login')
      .send({ email: uniqueEmail(), password: 'x' })
      .expect(429);
    expect(response.body.code).toBe('RATE_LIMITED');
  });
});

describe('GET /api/v1/auth/me', () => {
  it('requires a bearer token', async () => {
    const response = await request(app).get('/api/v1/auth/me').expect(401);
    expect(response.body.code).toBe('UNAUTHENTICATED');
    await request(app).get('/api/v1/auth/me').set('Authorization', 'Bearer not-a-jwt').expect(401);
  });

  it('returns the current user', async () => {
    const user = await createTestUser({ roles: ['ACCOUNT_MANAGER'] });
    const token = await loginAs(app, user);
    const response = await request(app).get('/api/v1/auth/me').set(bearer(token)).expect(200);
    expect(response.body).toMatchObject({
      id: user.id,
      email: user.email,
      roles: ['ACCOUNT_MANAGER'],
    });
  });

  it('rejects tokens signed with another secret', async () => {
    const user = await createTestUser();
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(user.id)
      .setIssuer('property-erp-api')
      .setAudience('property-erp')
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('some-other-secret-that-is-32-characters-long'));
    await request(app).get('/api/v1/auth/me').set(bearer(forged)).expect(401);
  });

  it('rejects the token of a user who has since been deactivated', async () => {
    const user = await createTestUser();
    const token = await loginAs(app, user);
    await UserModel.updateOne({ _id: user.id }, { $set: { active: false } });
    await request(app).get('/api/v1/auth/me').set(bearer(token)).expect(401);
  });
});

describe('POST /api/v1/auth/logout', () => {
  it('records the sign-out', async () => {
    const user = await createTestUser();
    const token = await loginAs(app, user);
    await request(app).post('/api/v1/auth/logout').set(bearer(token)).expect(204);
    const audit = await AuditLogModel.findOne({ action: 'AUTH_LOGOUT', entityId: user.id }).lean();
    expect(audit).not.toBeNull();
  });
});

describe('audit log', () => {
  it('is append-only', async () => {
    await expect(
      AuditLogModel.updateMany({}, { $set: { action: 'USER_CREATED' } }),
    ).rejects.toThrow(/append-only/);
    await expect(AuditLogModel.deleteMany({})).rejects.toThrow(/append-only/);
  });
});
