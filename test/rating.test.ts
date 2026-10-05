import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestApp, tokenFor, useTestDatabase } from './helpers/app.ts';
import { seedMasters } from './helpers/masters.ts';

useTestDatabase();
const app = createTestApp();

let token: string;
let seeded: Awaited<ReturnType<typeof seedMasters>>;

beforeAll(async () => {
  seeded = await seedMasters();
  token = (await tokenFor(app, ['READ_ONLY'])).token;
});

const rate = (body: Record<string, unknown>) =>
  request(app).post('/api/v1/rating/fire').set(bearer(token)).send(body);

describe('POST /api/v1/rating/fire', () => {
  it('requires authentication', async () => {
    await request(app)
      .post('/api/v1/rating/fire')
      .send({ occupancyCode: '2001', pincode: '400001', sumInsured: '100000000' })
      .expect(401);
  });

  it('prices the worked example from the active masters', async () => {
    const response = await rate({
      occupancyCode: '2001',
      pincode: '400001',
      sumInsured: '100000000',
    }).expect(200);
    expect(response.body.premium).toEqual({
      sumInsured: '100000000.00',
      rates: { fire: '0.69', stfi: '0.37', earthquake: '0.1', terrorism: null },
      premiums: { fire: '69000.00', stfi: '37000.00', earthquake: '10000.00', terrorism: null },
      basePremium: '116000.00',
      policyRate: '1.16',
      totalBeforeTax: '116000.00',
      gstRatePercent: '18',
      gst: '20880.00',
      total: '136880.00',
    });
    expect(response.body.warnings).toEqual([]);
    expect(response.body.input).toEqual({
      occupancyCode: '2001',
      pincode: '400001',
      sumInsured: '100000000',
      terrorismRate: null,
    });
    // The snapshot records exactly which versions and values were used.
    expect(response.body.snapshot).toMatchObject({
      occupancyVersion: { id: seeded.occupancyVersionId, type: 'OCCUPANCY' },
      pincodeVersion: { id: seeded.pincodeVersionId, type: 'PINCODE' },
      occupancy: { tacCode: '2001', iibRate: '0.69', minStfiRate: '0.37' },
      pincode: { pincode: '400001', eqZone: 3, eqRates: { industrial: '0.1' } },
      eqRiskType: 'INDUSTRIAL',
    });
  });

  it('adds terrorism when a rate is supplied', async () => {
    const response = await rate({
      occupancyCode: '2001',
      pincode: '400001',
      sumInsured: '100000000',
      terrorismRate: '0.05',
    }).expect(200);
    expect(response.body.premium).toMatchObject({
      premiums: { terrorism: '5000.00' },
      basePremium: '121000.00',
      policyRate: '1.21',
      gst: '21780.00',
      total: '142780.00',
    });
  });

  it('uses the EQ rate for the occupancy Fire risk type', async () => {
    const response = await rate({
      occupancyCode: '1001_2',
      pincode: '110001',
      sumInsured: '5000000',
    }).expect(200);
    // 1001_2 is non-industrial; 110001 (zone 2) non-industrial rate is 0.15.
    expect(response.body.premium.rates.earthquake).toBe('0.15');
    expect(response.body.snapshot.eqRiskType).toBe('NON_INDUSTRIAL');
  });

  it('returns a 422 data error when the Fire risk type is blank', async () => {
    const response = await rate({
      occupancyCode: 'TEST_NO_FIRE_TYPE',
      pincode: '400001',
      sumInsured: '1000000',
    }).expect(422);
    expect(response.body.code).toBe('MASTER_DATA_ERROR');
    expect(response.body.details).toMatchObject({
      field: 'fireRiskType',
      tacCode: 'TEST_NO_FIRE_TYPE',
    });
  });

  it('returns a 422 data error when the IIB rate is text', async () => {
    const response = await rate({
      occupancyCode: '2191',
      pincode: '400001',
      sumInsured: '1000000',
    }).expect(422);
    expect(response.body.code).toBe('MASTER_DATA_ERROR');
    expect(response.body.message).toContain('As per existing rate built in SME Pre UW Product');
  });

  it('rejects unknown occupancy codes and pincodes', async () => {
    const occupancy = await rate({
      occupancyCode: '9999',
      pincode: '400001',
      sumInsured: '1000000',
    }).expect(422);
    expect(occupancy.body.code).toBe('OCCUPANCY_NOT_FOUND');
    const pincode = await rate({
      occupancyCode: '2001',
      pincode: '999999',
      sumInsured: '1000000',
    }).expect(422);
    expect(pincode.body.code).toBe('PINCODE_NOT_FOUND');
  });

  it('never rates from a draft version', async () => {
    const response = await rate({
      occupancyCode: 'DRAFT_ONLY',
      pincode: '400001',
      sumInsured: '1000000',
    }).expect(422);
    expect(response.body.code).toBe('OCCUPANCY_NOT_FOUND');
  });

  it('warns when the pincode EQ rate is below the occupancy minimum for the zone', async () => {
    // 3006 needs at least 0.225 in Zone III; 400001 (zone 3) industrial is 0.1.
    const industrial = await rate({
      occupancyCode: '3006',
      pincode: '400001',
      sumInsured: '1000000',
    }).expect(200);
    expect(industrial.body.warnings).toEqual([
      expect.objectContaining({
        code: 'EQ_RATE_BELOW_OCCUPANCY_MINIMUM',
        details: { zone: 3, pincodeRate: '0.1', occupancyMinimum: '0.225' },
      }),
    ]);
    // The pincode rate is still the one used.
    expect(industrial.body.premium.rates.earthquake).toBe('0.1');

    // 768201 is zone 3 but carries 0.05 for non-industrial risks; the minimum is 0.1.
    const nonIndustrial = await rate({
      occupancyCode: '1001_2',
      pincode: '768201',
      sumInsured: '1000000',
    }).expect(200);
    expect(nonIndustrial.body.warnings[0].code).toBe('EQ_RATE_BELOW_OCCUPANCY_MINIMUM');
  });

  it('warns when terrorism is priced for an occupancy without a Terrorism risk type', async () => {
    const response = await rate({
      occupancyCode: '2075',
      pincode: '400001',
      sumInsured: '1000000',
      terrorismRate: '0.05',
    }).expect(200);
    expect(response.body.warnings).toEqual([
      expect.objectContaining({ code: 'TERRORISM_RISK_TYPE_MISSING' }),
    ]);
  });

  it('validates input strictly; money must be a string', async () => {
    const asNumber = await rate({
      occupancyCode: '2001',
      pincode: '400001',
      sumInsured: 100000000,
    }).expect(400);
    expect(asNumber.body.details).toEqual([expect.objectContaining({ path: 'sumInsured' })]);
    await rate({ occupancyCode: '2001', pincode: '400001', sumInsured: '0' }).expect(400);
    await rate({ occupancyCode: '2001', pincode: '4000', sumInsured: '1000' }).expect(400);
    await rate({
      occupancyCode: '2001',
      pincode: '400001',
      sumInsured: '1000',
      discount: '10',
    }).expect(400);
  });
});
