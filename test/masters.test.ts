import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLogModel } from '../src/modules/audit/audit.model.ts';
import { MasterVersionModel } from '../src/modules/masters/master-version.model.ts';
import { bearer, createTestApp, tokenFor, useTestDatabase } from './helpers/app.ts';
import { OCCUPANCIES, insertOccupancies, seedMasters } from './helpers/masters.ts';

useTestDatabase();
const app = createTestApp();

let token: string;
let adminToken: string;
let seeded: Awaited<ReturnType<typeof seedMasters>>;

beforeAll(async () => {
  token = (await tokenFor(app, ['READ_ONLY'])).token;
  adminToken = (await tokenFor(app, ['ADMIN'])).token;
});

describe('before any master is active', () => {
  it('explains that no master is active', async () => {
    const response = await request(app)
      .get('/api/v1/masters/occupancies')
      .set(bearer(token))
      .expect(409);
    expect(response.body.code).toBe('MASTER_NOT_ACTIVE');
  });
});

describe('master lookups', () => {
  beforeAll(async () => {
    seeded = await seedMasters();
  });

  it('requires authentication', async () => {
    await request(app).get('/api/v1/masters/occupancies').expect(401);
    await request(app).get('/api/v1/masters/pincodes/400001').expect(401);
  });

  it('searches occupancies by code prefix', async () => {
    const response = await request(app)
      .get('/api/v1/masters/occupancies?q=200')
      .set(bearer(token))
      .expect(200);
    const codes = (response.body.items as Array<{ tacCode: string }>).map((o) => o.tacCode);
    expect(codes).toEqual(['2001', '2002']);
  });

  it('searches occupancy descriptions case-insensitively and returns rates as strings', async () => {
    const response = await request(app)
      .get('/api/v1/masters/occupancies?q=ABRASIVE')
      .set(bearer(token))
      .expect(200);
    expect(response.body.items).toEqual([
      expect.objectContaining({
        tacCode: '2001',
        iibRate: '0.69',
        minStfiRate: '0.37',
        fireRiskType: 'INDUSTRIAL',
        minEqRates: { zone1: '0.5', zone2: '0.25', zone3: '0.1', zone4: '0.05' },
      }),
    ]);
  });

  it('treats search text literally', async () => {
    const response = await request(app)
      .get(`/api/v1/masters/occupancies?q=${encodeURIComponent('(.*')}`)
      .set(bearer(token))
      .expect(200);
    expect(response.body.items).toEqual([]);
  });

  it('pages through every occupancy of the ACTIVE version only', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `limit=3&cursor=${cursor}` : 'limit=3';
      const response = await request(app)
        .get(`/api/v1/masters/occupancies?${query}`)
        .set(bearer(token))
        .expect(200);
      seen.push(...(response.body.items as Array<{ tacCode: string }>).map((o) => o.tacCode));
      cursor = response.body.nextCursor as string | null;
    } while (cursor);
    expect(seen).toEqual(OCCUPANCIES.map((o) => o.tacCode));
    expect(seen).not.toContain('DRAFT_ONLY');
  });

  it('rejects bad search input', async () => {
    await request(app).get('/api/v1/masters/occupancies?limit=500').set(bearer(token)).expect(400);
    await request(app)
      .get('/api/v1/masters/occupancies?cursor=nope')
      .set(bearer(token))
      .expect(400);
    await request(app).get('/api/v1/masters/occupancies?q[$ne]=x').set(bearer(token)).expect(400);
  });

  it('gets one occupancy by TAC code', async () => {
    const response = await request(app)
      .get('/api/v1/masters/occupancies/1001_2')
      .set(bearer(token))
      .expect(200);
    expect(response.body).toMatchObject({
      tacCode: '1001_2',
      fireRiskType: 'NON_INDUSTRIAL',
      iibRate: '0.24',
    });
    const missing = await request(app)
      .get('/api/v1/masters/occupancies/9999')
      .set(bearer(token))
      .expect(404);
    expect(missing.body.code).toBe('OCCUPANCY_NOT_FOUND');
  });

  it('looks up a pincode', async () => {
    const response = await request(app)
      .get('/api/v1/masters/pincodes/400001')
      .set(bearer(token))
      .expect(200);
    expect(response.body).toMatchObject({
      pincode: '400001',
      state: 'Mumbai',
      district: 'Mumbai',
      eqZone: 3,
      eqRates: { residential: '0.05', nonIndustrial: '0.1', industrial: '0.1' },
    });
    const missing = await request(app)
      .get('/api/v1/masters/pincodes/999999')
      .set(bearer(token))
      .expect(404);
    expect(missing.body.code).toBe('PINCODE_NOT_FOUND');
    await request(app).get('/api/v1/masters/pincodes/12345').set(bearer(token)).expect(400);
  });

  it('lists versions with filters', async () => {
    const all = await request(app).get('/api/v1/masters/versions').set(bearer(token)).expect(200);
    expect(all.body.items).toHaveLength(3);
    const active = await request(app)
      .get('/api/v1/masters/versions?status=ACTIVE')
      .set(bearer(token))
      .expect(200);
    expect((active.body.items as Array<{ type: string }>).map((v) => v.type).sort()).toEqual([
      'OCCUPANCY',
      'PINCODE',
    ]);
  });
});

describe('POST /api/v1/masters/versions/:id/activate', () => {
  it('is admin only', async () => {
    const response = await request(app)
      .post(`/api/v1/masters/versions/${seeded.draftOccupancyVersionId}/activate`)
      .set(bearer(token))
      .expect(403);
    expect(response.body.code).toBe('FORBIDDEN');
  });

  it('rejects a future effective date', async () => {
    await request(app)
      .post(`/api/v1/masters/versions/${seeded.draftOccupancyVersionId}/activate`)
      .set(bearer(adminToken))
      .send({ effectiveFrom: '2999-01-01' })
      .expect(400);
  });

  it('activates a draft, supersedes the previous version and audits the change', async () => {
    const response = await request(app)
      .post(`/api/v1/masters/versions/${seeded.draftOccupancyVersionId}/activate`)
      .set(bearer(adminToken))
      .send({ effectiveFrom: '2026-10-02' })
      .expect(200);
    expect(response.body).toMatchObject({
      id: seeded.draftOccupancyVersionId,
      status: 'ACTIVE',
      effectiveFrom: '2026-10-01T18:30:00.000Z',
    });

    const previous = await MasterVersionModel.findById(seeded.occupancyVersionId).lean();
    expect(previous).toMatchObject({ status: 'SUPERSEDED' });
    expect(previous?.effectiveTo?.toISOString()).toBe('2026-10-01T18:30:00.000Z');

    // Lookups now read the newly active version.
    const lookup = await request(app)
      .get('/api/v1/masters/occupancies/2001')
      .set(bearer(token))
      .expect(200);
    expect(lookup.body.iibRate).toBe('9.99');

    const audit = await AuditLogModel.findOne({
      action: 'MASTER_ACTIVATED',
      entityId: seeded.draftOccupancyVersionId,
    }).lean();
    expect(audit?.after).toMatchObject({
      status: 'ACTIVE',
      supersededVersionId: seeded.occupancyVersionId,
    });
  });

  it('only activates drafts', async () => {
    const response = await request(app)
      .post(`/api/v1/masters/versions/${seeded.occupancyVersionId}/activate`)
      .set(bearer(adminToken))
      .expect(409);
    expect(response.body.code).toBe('MASTER_VERSION_NOT_DRAFT');
    await request(app)
      .post('/api/v1/masters/versions/0123456789abcdef01234567/activate')
      .set(bearer(adminToken))
      .expect(404);
  });

  it('refuses an effective date earlier than the current version', async () => {
    const draft = await MasterVersionModel.create({
      type: 'OCCUPANCY',
      status: 'DRAFT',
      sourceFileName: 'older.xlsx',
      sourceSha256: 'older',
      importedAt: new Date(),
      stats: { rowsRead: 1, recordsImported: 1, rowsSkipped: 0, warningCount: 0, errorCount: 0 },
    });
    await insertOccupancies(draft._id, OCCUPANCIES.slice(0, 1));
    const response = await request(app)
      .post(`/api/v1/masters/versions/${draft._id.toHexString()}/activate`)
      .set(bearer(adminToken))
      .send({ effectiveFrom: '2026-09-01' })
      .expect(409);
    expect(response.body.message).toContain('on or after');
  });
});
