import { XLSX_CONTENT_TYPE } from '../src/shared/index.ts';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLogModel } from '../src/modules/audit/audit.model.ts';
import { parseIibWorkbook } from '../src/modules/masters/import/iib-workbook.ts';
import { bearer, createTestApp, tokenFor, useTestDatabase } from './helpers/app.ts';
import { seedMasters } from './helpers/masters.ts';

useTestDatabase();
const app = createTestApp();

let admin: string;

beforeAll(async () => {
  await seedMasters();
  admin = (await tokenFor(app, ['ADMIN'])).token;
});

const occupancy = (overrides: Record<string, unknown> = {}) => ({
  description: 'Abrasive Manufacturing',
  riskGrade: 'RG3',
  iibRate: '0.69',
  iibRateNote: '',
  fireRiskType: 'INDUSTRIAL',
  terrorismRiskType: 'INDUSTRIAL',
  minStfiRate: '0.37',
  minEqRates: { zone1: '0.5', zone2: '0.25', zone3: '0.1', zone4: '0.05' },
  ...overrides,
});

const pincode = (overrides: Record<string, unknown> = {}) => ({
  state: 'Maharashtra',
  district: 'Mumbai',
  eqZone: 3,
  eqRates: { residential: '0.05', nonIndustrial: '0.1', industrial: '0.1' },
  ...overrides,
});

describe('pincode list', () => {
  it('lists pincodes in order, searches and pages', async () => {
    const all = await request(app).get('/api/v1/masters/pincodes').set(bearer(admin)).expect(200);
    const codes = (all.body.items as Array<{ pincode: string }>).map((p) => p.pincode);
    expect(codes).toEqual([...codes].sort());
    expect(codes).toContain('400001');

    const prefix = await request(app)
      .get('/api/v1/masters/pincodes?q=4000')
      .set(bearer(admin))
      .expect(200);
    expect(prefix.body.items.map((p: { pincode: string }) => p.pincode)).toEqual(['400001']);
    const byText = await request(app)
      .get('/api/v1/masters/pincodes?q=central')
      .set(bearer(admin))
      .expect(200);
    expect(byText.body.items.map((p: { pincode: string }) => p.pincode)).toEqual(['110001']);

    const first = await request(app)
      .get('/api/v1/masters/pincodes?limit=1')
      .set(bearer(admin))
      .expect(200);
    expect(first.body.nextCursor).toBe(codes[0]);
    const second = await request(app)
      .get(`/api/v1/masters/pincodes?limit=1&cursor=${first.body.nextCursor as string}`)
      .set(bearer(admin))
      .expect(200);
    expect(second.body.items[0].pincode).toBe(codes[1]);
  });
});

describe('editing the active masters', () => {
  it('corrects an occupancy, which rating uses at once, and audits each change', async () => {
    const response = await request(app)
      .patch('/api/v1/masters/occupancies/2001')
      .set(bearer(admin))
      .send(
        occupancy({
          iibRate: '0.75',
          minEqRates: { zone1: '0.5', zone2: '0.25', zone3: '', zone4: '0.05' },
        }),
      )
      .expect(200);
    expect(response.body).toMatchObject({
      tacCode: '2001',
      iibRate: '0.75',
      minEqRates: { zone3: null },
    });

    const rating = await request(app)
      .post('/api/v1/rating/fire')
      .set(bearer(admin))
      .send({ occupancyCode: '2001', pincode: '110001', sumInsured: '100000000' })
      .expect(200);
    expect(JSON.stringify(rating.body)).toContain('0.75');

    const audit = await AuditLogModel.findOne({ action: 'OCCUPANCY_UPDATED' }).lean();
    expect(audit?.before).toMatchObject({ tacCode: '2001', iibRate: '0.69' });
    expect(audit?.after).toMatchObject({ tacCode: '2001', iibRate: '0.75' });
    const log = await request(app)
      .get(`/api/v1/audit?entity=occupancy&entityId=${response.body.id as string}`)
      .set(bearer(admin))
      .expect(200);
    expect(log.body.items[0]).toMatchObject({
      entityLabel: '2001 · Abrasive Manufacturing',
      kind: 'EDIT',
    });
    expect(log.body.items[0].changes).toContainEqual({
      field: 'iibRate',
      before: '0.69',
      after: '0.75',
    });

    // The Excel download carries the correction.
    const workbook = await request(app)
      .get('/api/v1/masters/workbook')
      .set(bearer(admin))
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(workbook.headers['content-type']).toBe(XLSX_CONTENT_TYPE);
    const parsed = await parseIibWorkbook(workbook.body as Buffer, {
      sourceFileName: 'x',
      sourceSha256: 'x',
    });
    expect(parsed.occupancies.find((o) => o.tacCode === '2001')?.iibRate).toBe('0.75');
  });

  it('adds an occupancy and a pincode, and refuses duplicates', async () => {
    const created = await request(app)
      .post('/api/v1/masters/occupancies')
      .set(bearer(admin))
      .send({ ...occupancy({ description: 'Test Workshop' }), tacCode: '9001' })
      .expect(201);
    expect(created.body).toMatchObject({ tacCode: '9001', description: 'Test Workshop' });
    await request(app).get('/api/v1/masters/occupancies/9001').set(bearer(admin)).expect(200);
    const again = await request(app)
      .post('/api/v1/masters/occupancies')
      .set(bearer(admin))
      .send({ ...occupancy(), tacCode: '9001' })
      .expect(409);
    expect(again.body.message).toContain('already in the active master');

    await request(app)
      .post('/api/v1/masters/pincodes')
      .set(bearer(admin))
      .send({ ...pincode({ state: 'Goa', district: 'North Goa', eqZone: '3' }), pincode: '403001' })
      .expect(201);
    const found = await request(app)
      .get('/api/v1/masters/pincodes/403001')
      .set(bearer(admin))
      .expect(200);
    expect(found.body).toMatchObject({ district: 'North Goa', eqZone: 3 });
    await request(app)
      .post('/api/v1/masters/pincodes')
      .set(bearer(admin))
      .send({ ...pincode(), pincode: '403001' })
      .expect(409);
    expect(
      await AuditLogModel.countDocuments({
        action: { $in: ['OCCUPANCY_CREATED', 'PINCODE_CREATED'] },
      }),
    ).toBe(2);
  });

  it('corrects a pincode and checks the values', async () => {
    const updated = await request(app)
      .patch('/api/v1/masters/pincodes/400001')
      .set(bearer(admin))
      .send(
        pincode({
          state: 'Maharashtra',
          eqZone: 2,
          eqRates: { residential: '0.05', nonIndustrial: '0.15', industrial: '0.25' },
        }),
      )
      .expect(200);
    expect(updated.body).toMatchObject({
      state: 'Maharashtra',
      eqZone: 2,
      eqRates: { industrial: '0.25' },
    });
    const audit = await AuditLogModel.findOne({ action: 'PINCODE_UPDATED' }).lean();
    expect(audit?.before).toMatchObject({ state: 'Mumbai', eqZone: 3 });

    const invalid = await request(app)
      .patch('/api/v1/masters/pincodes/400001')
      .set(bearer(admin))
      .send(
        pincode({ eqZone: 5, eqRates: { residential: '-1', nonIndustrial: '', industrial: '' } }),
      )
      .expect(400);
    expect(invalid.body.details.map((d: { path: string }) => d.path).sort()).toEqual([
      'eqRates.residential',
      'eqZone',
    ]);
    await request(app)
      .patch('/api/v1/masters/pincodes/999999')
      .set(bearer(admin))
      .send(pincode())
      .expect(404);
  });

  it('lets every role read and only Admins edit', async () => {
    const { token: manager } = await tokenFor(app, ['ACCOUNT_MANAGER']);
    const { token: readOnly } = await tokenFor(app, ['READ_ONLY']);
    await request(app).get('/api/v1/masters/pincodes').set(bearer(readOnly)).expect(200);
    await request(app)
      .patch('/api/v1/masters/occupancies/2001')
      .set(bearer(manager))
      .send(occupancy())
      .expect(403);
    await request(app)
      .post('/api/v1/masters/pincodes')
      .set(bearer(manager))
      .send({ ...pincode(), pincode: '403002' })
      .expect(403);
  });
});
