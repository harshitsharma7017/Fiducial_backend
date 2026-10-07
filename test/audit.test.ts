import type { AuditLogListResponse } from '../src/shared/index.ts';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  bearer,
  createTestApp,
  createTestUser,
  loginAs,
  tokenFor,
  uniqueEmail,
  useTestDatabase,
} from './helpers/app.ts';
import { seedMasters } from './helpers/masters.ts';

useTestDatabase();
const app = createTestApp();

let admin: { id: string; email: string; token: string };

beforeAll(async () => {
  const { user, token } = await tokenFor(app, ['ADMIN']);
  admin = { id: user.id, email: user.email, token };
});

async function auditLog(query: Record<string, string> = {}): Promise<AuditLogListResponse> {
  const response = await request(app)
    .get('/api/v1/audit')
    .query(query)
    .set(bearer(admin.token))
    .expect(200);
  return response.body as AuditLogListResponse;
}

describe('GET /api/v1/audit', () => {
  it('shows who created a user, when, and every new value, without the password', async () => {
    const email = uniqueEmail('audit');
    const password = 'a sufficiently long password';
    const created = await request(app)
      .post('/api/v1/users')
      .set(bearer(admin.token))
      .send({ email, name: 'Ravi Kumar', password, roles: ['PLACEMENT_EXEC'] })
      .expect(201);

    const { items } = await auditLog({ entity: 'user', entityId: created.body.id as string });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      action: 'USER_CREATED',
      kind: 'CREATE',
      entity: 'user',
      entityId: created.body.id,
      entityLabel: email,
      actor: { id: admin.id, email: admin.email, name: 'Test User' },
      details: null,
    });
    expect(items[0]?.changes).toEqual([
      { field: 'email', before: null, after: email },
      { field: 'name', before: null, after: 'Ravi Kumar' },
      { field: 'roles', before: null, after: ['PLACEMENT_EXEC'] },
      { field: 'active', before: null, after: true },
    ]);
    expect(Date.now() - Date.parse(items[0]?.at ?? '')).toBeLessThan(60_000);
    expect(JSON.stringify(items)).not.toContain(password);
  });

  it('shows only the fields an edit changed, with the old and new values', async () => {
    const target = await createTestUser({ roles: ['READ_ONLY'], name: 'Meera Shah' });
    await request(app)
      .patch(`/api/v1/users/${target.id}`)
      .set(bearer(admin.token))
      .send({ name: 'Meera S. Shah', roles: ['READ_ONLY', 'MANAGER'] })
      .expect(200);

    const { items } = await auditLog({ kind: 'EDIT', entity: 'user', entityId: target.id });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      action: 'USER_UPDATED',
      actor: { id: admin.id },
      entityLabel: target.email,
    });
    expect(items[0]?.changes).toEqual([
      { field: 'name', before: 'Meera Shah', after: 'Meera S. Shah' },
      { field: 'roles', before: ['READ_ONLY'], after: ['READ_ONLY', 'MANAGER'] },
    ]);
  });

  it('records sign-ins with their details, and failed ones without an actor', async () => {
    const user = await createTestUser({ roles: ['MANAGER'] });
    await request(app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: 'not the right password' })
      .expect(401);
    await loginAs(app, user);

    const { items } = await auditLog({ kind: 'SESSION', entity: 'user', entityId: user.id });
    // Newest first.
    expect(items.map((entry) => entry.action)).toEqual([
      'AUTH_LOGIN_SUCCEEDED',
      'AUTH_LOGIN_FAILED',
    ]);
    expect(items[0]).toMatchObject({
      kind: 'SESSION',
      actor: { id: user.id },
      changes: [],
      details: { email: user.email },
    });
    expect(items[1]).toMatchObject({
      actor: null,
      changes: [],
      details: { email: user.email, reason: 'WRONG_PASSWORD', failedAttempts: 1 },
    });
  });

  it('records a master activation and the version it superseded', async () => {
    const seeded = await seedMasters();
    await request(app)
      .post(`/api/v1/masters/versions/${seeded.draftOccupancyVersionId}/activate`)
      .set(bearer(admin.token))
      .send({ effectiveFrom: '2026-10-02' })
      .expect(200);

    const activated = await auditLog({
      entity: 'master_version',
      entityId: seeded.draftOccupancyVersionId,
    });
    expect(activated.items).toHaveLength(1);
    expect(activated.items[0]).toMatchObject({
      action: 'MASTER_ACTIVATED',
      kind: 'APPROVE',
      actor: { id: admin.id },
      entityLabel: 'Occupancy master · fixture-draft.xlsx',
    });
    expect(activated.items[0]?.changes).toEqual([
      { field: 'status', before: 'DRAFT', after: 'ACTIVE' },
      { field: 'effectiveFrom', before: null, after: '2026-10-01T18:30:00.000Z' },
      { field: 'supersededVersionId', before: null, after: seeded.occupancyVersionId },
    ]);

    const superseded = await auditLog({
      entity: 'master_version',
      entityId: seeded.occupancyVersionId,
    });
    expect(superseded.items[0]).toMatchObject({
      action: 'MASTER_SUPERSEDED',
      kind: 'EDIT',
      actor: { id: admin.id },
      entityLabel: 'Occupancy master · fixture-active.xlsx',
    });
    expect(superseded.items[0]?.changes).toEqual([
      { field: 'status', before: 'ACTIVE', after: 'SUPERSEDED' },
      { field: 'effectiveTo', before: null, after: '2026-10-01T18:30:00.000Z' },
      { field: 'supersededBy', before: null, after: seeded.draftOccupancyVersionId },
    ]);
  });

  it('filters by who acted', async () => {
    const { items } = await auditLog({ actorId: admin.id, limit: '100' });
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((entry) => entry.actor?.id === admin.id)).toBe(true);
  });

  it('pages newest first without repeats or gaps', async () => {
    const all = await auditLog({ limit: '100' });
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: AuditLogListResponse = await auditLog({
        limit: '2',
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...page.items.map((entry) => entry.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(all.items.map((entry) => entry.id));

    const times = all.items.map((entry) => Date.parse(entry.at));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('rejects unknown filters, a record id without its type and a foreign cursor', async () => {
    const get = (query: string) =>
      request(app).get(`/api/v1/audit?${query}`).set(bearer(admin.token));
    await get('kind=DELETE').expect(400);
    await get('entity=quote').expect(400);
    await get('entityId=0123456789abcdef01234567').expect(400);
    await get('actorId=not-an-id').expect(400);
    await get('cursor=0123456789abcdef01234567').expect(400);
    await get('sort=at').expect(400);
  });
});
