import { RISK_DETAIL_FIELDS, XLSX_CONTENT_TYPE } from '../src/shared/index.ts';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLogModel } from '../src/modules/audit/audit.model.ts';
import { bearer, createTestApp, tokenFor, useTestDatabase } from './helpers/app.ts';
import { seedMasters } from './helpers/masters.ts';

useTestDatabase();
const app = createTestApp();

let admin: string;
let manager: string; // Relationship Manager
let placement: string;
let approver: string;
let readOnly: string;
let clientId: string;
let plant1: string;
let plant2: string;
const insurers: string[] = [];
let inactiveInsurer: string;

const risk = (values: Partial<Record<string, string>> = {}) =>
  Object.fromEntries(RISK_DETAIL_FIELDS.map((field) => [field.key, values[field.key] ?? '']));

beforeAll(async () => {
  await seedMasters();
  admin = (await tokenFor(app, ['ADMIN'])).token;
  manager = (await tokenFor(app, ['ACCOUNT_MANAGER'])).token;
  placement = (await tokenFor(app, ['PLACEMENT_EXEC'])).token;
  approver = (await tokenFor(app, ['MANAGER'])).token;
  readOnly = (await tokenFor(app, ['READ_ONLY'])).token;

  const client = await request(app)
    .post('/api/v1/clients')
    .set(bearer(admin))
    .send({
      name: 'Proposal Test Textiles',
      gstin: '27AAPFU0939F1ZV',
      address: {
        line1: '1 Mill Road',
        line2: '',
        city: 'Mumbai',
        state: 'Maharashtra',
        pincode: '400001',
      },
      contacts: [],
      natureOfBusiness: 'Weaving',
      occupancyCode: '2001',
    })
    .expect(201);
  clientId = client.body.id as string;
  for (const [name, pincode] of [
    ['Plant 1', '400001'],
    ['Plant 2', '110001'],
  ] as const) {
    const location = await request(app)
      .post(`/api/v1/clients/${clientId}/locations`)
      .set(bearer(admin))
      .send({ name, line1: 'Plot 1', line2: null, city: 'City', pincode, occupancyCode: null })
      .expect(201);
    if (name === 'Plant 1') plant1 = location.body.id as string;
    else plant2 = location.body.id as string;
  }
  for (const branch of ['Fort', 'Andheri', 'Closed']) {
    const insurer = await request(app)
      .post('/api/v1/insurers')
      .set(bearer(admin))
      .send({
        company: 'Test General',
        branch,
        contacts: [],
        rfqEmails: [`${branch.toLowerCase()}@insurer.example`],
      })
      .expect(201);
    if (branch === 'Closed') inactiveInsurer = insurer.body.id as string;
    else insurers.push(insurer.body.id as string);
  }
  await request(app)
    .patch(`/api/v1/insurers/${inactiveInsurer}`)
    .set(bearer(admin))
    .send({ active: false })
    .expect(200);
});

function create(token = manager, locationIds = [plant1, plant2]) {
  return request(app)
    .post('/api/v1/proposals')
    .set(bearer(token))
    .send({ clientId, locationIds, dueDate: '2026-11-15' });
}

const dataSheet = (overrides: Record<string, unknown> = {}) => ({
  dueDate: '2026-11-20',
  policyStart: '',
  locations: [
    {
      locationId: plant1,
      fire: [
        { key: 'BUILDING_1', sqFt: '1000', ratePerSqFt: '2000', amount: '' },
        { key: 'STOCKS', sqFt: '', ratePerSqFt: '', amount: '500000' },
        { key: 'FFF', sqFt: '', ratePerSqFt: '', amount: '' },
      ],
      hypothecation: 'Bank of Example',
      openStock: '',
      risk: risk({ fireFighting: 'Extinguishers and hydrant', buildingAge: '15 years' }),
    },
    {
      locationId: plant2,
      fire: [{ key: 'FFF', sqFt: '', ratePerSqFt: '', amount: '200000' }],
      hypothecation: '',
      openStock: '',
      risk: risk(),
    },
  ],
  fireOption2: [
    { group: 'STOCKS', amount: '1000000' },
    { group: 'FFF', amount: '' },
  ],
  sections: [
    { code: 'BURGLARY', included: true, proposed1: '700000', proposed2: '' },
    { code: 'MONEY', included: true, proposed1: '', proposed2: '' },
  ],
  claims: [
    {
      period: '2025-26',
      policyType: 'SFSP',
      sumInsured: '2500000',
      premium: '12000',
      claimedAmount: '0',
      remarks: 'Nil',
      insurer: 'Old Insurer',
    },
  ],
  notes: '',
  ...overrides,
});

describe('new-business proposals', () => {
  it('creates a numbered draft for a client and its locations, and audits it', async () => {
    const response = await create().expect(201);
    expect(response.body).toMatchObject({
      type: 'NEW',
      stage: 'DRAFT',
      client: {
        id: clientId,
        name: 'Proposal Test Textiles',
        gstin: '27AAPFU0939F1ZV',
        city: 'Mumbai',
      },
      dueDate: '2026-11-15',
      locked: false,
      insurers: [],
    });
    expect(response.body.reference).toMatch(/^PRP-\d{4}-\d{4}$/);
    expect(
      response.body.locations.map((l: { location: { name: string } }) => l.location.name),
    ).toEqual(['Plant 1', 'Plant 2']);
    expect(response.body.locations[0].location.occupancy).toEqual({
      tacCode: '2001',
      description: 'Abrasive Manufacturing',
    });
    expect(response.body.missing).toEqual([
      'Enter the Fire sums insured for Plant 1.',
      'Enter the Fire sums insured for Plant 2.',
    ]);
    expect(
      await AuditLogModel.countDocuments({
        action: 'PROPOSAL_CREATED',
        entityId: response.body.id,
      }),
    ).toBe(1);

    const second = await create().expect(201);
    expect(Number(second.body.reference.slice(-4))).toBe(
      Number(response.body.reference.slice(-4)) + 1,
    );
  });

  it("refuses another client's locations", async () => {
    const other = await request(app)
      .post('/api/v1/clients')
      .set(bearer(admin))
      .send({
        name: 'Other Co',
        gstin: '',
        address: { line1: 'a', line2: '', city: 'Pune', state: 'Maharashtra', pincode: '411001' },
        contacts: [],
        natureOfBusiness: 'x',
        occupancyCode: '2001',
      })
      .expect(201);
    const response = await request(app)
      .post('/api/v1/proposals')
      .set(bearer(manager))
      .send({ clientId: other.body.id, locationIds: [plant1], dueDate: '2026-11-15' })
      .expect(400);
    expect(response.body.details[0].path).toBe('locationIds');
  });

  it('saves the Data Sheet, prices area × rate, and moves to Data Sheet once complete', async () => {
    const { body: proposal } = await create().expect(201);
    const partial = await request(app)
      .put(`/api/v1/proposals/${proposal.id}/data-sheet`)
      .set(bearer(placement))
      .send(dataSheet())
      .expect(200);
    expect(partial.body.stage).toBe('DRAFT');
    expect(partial.body.missing).toEqual([
      'Money: enter the Proposed 1 sum insured, or leave the section out.',
    ]);
    expect(partial.body.locations[0].fire).toEqual([
      { key: 'BUILDING_1', sqFt: '1000', ratePerSqFt: '2000', amount: null, sumInsured: '2000000' },
      { key: 'STOCKS', sqFt: null, ratePerSqFt: null, amount: '500000', sumInsured: '500000' },
    ]);
    expect(partial.body.locations[0]).toMatchObject({
      fireTotal: '2500000',
      hypothecation: 'Bank of Example',
    });
    expect(partial.body.locations[0].risk.fireFighting).toBe('Extinguishers and hydrant');
    expect(partial.body.fire).toMatchObject({ proposed1: '2700000', proposed2: '1000000' });
    expect(partial.body.fire.groups.find((g: { group: string }) => g.group === 'BUILDING')).toEqual(
      { group: 'BUILDING', proposed1: '2000000', proposed2: null },
    );

    const complete = await request(app)
      .put(`/api/v1/proposals/${proposal.id}/data-sheet`)
      .set(bearer(placement))
      .send(
        dataSheet({
          sections: [
            { code: 'BURGLARY', included: true, proposed1: '700000', proposed2: '' },
            { code: 'MONEY', included: false, proposed1: '', proposed2: '' },
          ],
        }),
      )
      .expect(200);
    expect(complete.body).toMatchObject({
      stage: 'DATA_SHEET',
      missing: [],
      dueDate: '2026-11-20',
    });
    expect(
      complete.body.sections.find((s: { code: string }) => s.code === 'BURGLARY'),
    ).toMatchObject({ included: true, proposed1: '700000' });
    expect(complete.body.claims).toHaveLength(1);
    const audit = await AuditLogModel.findOne({ action: 'PROPOSAL_UPDATED', entityId: proposal.id })
      .sort({ _id: -1 })
      .lean();
    expect(audit?.after).toMatchObject({ stage: 'DATA_SHEET', fireProposed1: '2700000' });

    await request(app)
      .put(`/api/v1/proposals/${proposal.id}/data-sheet`)
      .set(bearer(readOnly))
      .send(dataSheet())
      .expect(403);
  });

  it('builds the RFQ only from a complete Data Sheet, in the client layout', async () => {
    const { body: proposal } = await create().expect(201);
    const early = await request(app)
      .get(`/api/v1/proposals/${proposal.id}/rfq`)
      .set(bearer(manager))
      .expect(409);
    expect(early.body).toMatchObject({
      code: 'DATA_SHEET_INCOMPLETE',
      details: { missing: expect.any(Array) },
    });

    await request(app)
      .put(`/api/v1/proposals/${proposal.id}/data-sheet`)
      .set(bearer(manager))
      .send(
        dataSheet({
          sections: [
            { code: 'BURGLARY', included: true, proposed1: '700000', proposed2: '900000' },
          ],
        }),
      )
      .expect(200);
    const response = await request(app)
      .get(`/api/v1/proposals/${proposal.id}/rfq`)
      .set(bearer(approver))
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(response.headers['content-type']).toBe(XLSX_CONTENT_TYPE);
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename="RFQ-${proposal.reference as string}.xlsx"`,
    );
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(response.body as never);
    expect(workbook.worksheets.map((s) => s.name)).toEqual([
      'premium details',
      'schedule',
      'fire by location',
      'risk details',
      'claim details',
    ]);
    const premium = workbook.getWorksheet('premium details')!;
    const rows = premium.getSheetValues().map((row) => (Array.isArray(row) ? row.slice(1, 3) : []));
    expect(rows).toContainEqual(['Fire', 2700000]);
    expect(rows).toContainEqual(['Burglary', 700000]);
    expect(rows).toContainEqual(['Burglary', 900000]); // Option 2
    expect(rows).toContainEqual(['Money', 'Not required']);
    const schedule = JSON.stringify(workbook.getWorksheet('schedule')!.getSheetValues());
    expect(schedule).toContain('Proposal Test Textiles');
    expect(schedule).toContain('27AAPFU0939F1ZV');
    expect(schedule).toContain('Bank of Example');
    expect(JSON.stringify(workbook.getWorksheet('risk details')!.getSheetValues())).toContain(
      'Extinguishers and hydrant',
    );
    expect(
      await AuditLogModel.countDocuments({ action: 'RFQ_DOWNLOADED', entityId: proposal.id }),
    ).toBe(1);

    await request(app)
      .get(`/api/v1/proposals/${proposal.id}/rfq`)
      .set(bearer(readOnly))
      .expect(403);
  });

  it('chooses insurers, marks the RFQ sent, and locks the Data Sheet', async () => {
    const { body: proposal } = await create().expect(201);
    await request(app)
      .put(`/api/v1/proposals/${proposal.id}/insurers`)
      .set(bearer(manager))
      .send({ insurerIds: [inactiveInsurer] })
      .expect(400);
    const chosen = await request(app)
      .put(`/api/v1/proposals/${proposal.id}/insurers`)
      .set(bearer(manager))
      .send({ insurerIds: insurers })
      .expect(200);
    expect(
      chosen.body.insurers.map((i: { branch: string; status: string; rfqEmails: string[] }) => [
        i.branch,
        i.status,
        i.rfqEmails,
      ]),
    ).toEqual([
      ['Fort', 'NOT_SENT', ['fort@insurer.example']],
      ['Andheri', 'NOT_SENT', ['andheri@insurer.example']],
    ]);

    // Not before the Data Sheet is complete.
    const early = await request(app)
      .post(`/api/v1/proposals/${proposal.id}/rfq/sent`)
      .set(bearer(placement))
      .send({ insurerIds: [insurers[0]] })
      .expect(409);
    expect(early.body.code).toBe('DATA_SHEET_INCOMPLETE');

    await request(app)
      .put(`/api/v1/proposals/${proposal.id}/data-sheet`)
      .set(bearer(manager))
      .send(dataSheet({ sections: [] }))
      .expect(200);
    const sent = await request(app)
      .post(`/api/v1/proposals/${proposal.id}/rfq/sent`)
      .set(bearer(placement))
      .send({ insurerIds: [insurers[0]] })
      .expect(200);
    expect(sent.body).toMatchObject({ stage: 'RFQ_SENT', locked: true });
    expect(sent.body.insurers[0]).toMatchObject({ status: 'SENT', sentBy: 'Test User' });
    expect(sent.body.insurers[1].status).toBe('NOT_SENT');
    expect(sent.body.activity[0].message).toBe(
      'RFQ sent to Test General, Fort (fort@insurer.example)',
    );
    const audit = await AuditLogModel.findOne({ action: 'RFQ_SENT', entityId: proposal.id }).lean();
    expect(audit?.after).toMatchObject({ stage: 'RFQ_SENT' });

    const lockedSave = await request(app)
      .put(`/api/v1/proposals/${proposal.id}/data-sheet`)
      .set(bearer(manager))
      .send(dataSheet())
      .expect(409);
    expect(lockedSave.body.code).toBe('PROPOSAL_LOCKED');
    await request(app)
      .put(`/api/v1/proposals/${proposal.id}/insurers`)
      .set(bearer(manager))
      .send({ insurerIds: [insurers[1]] })
      .expect(409);
    const both = await request(app)
      .post(`/api/v1/proposals/${proposal.id}/rfq/sent`)
      .set(bearer(placement))
      .send({ insurerIds: insurers })
      .expect(200);
    expect(both.body.insurers.map((i: { status: string }) => i.status)).toEqual(['SENT', 'SENT']);

    await request(app)
      .get('/api/v1/audit?kind=SEND')
      .set(bearer(admin))
      .expect(200)
      .then((res) => {
        expect(res.body.items[0]).toMatchObject({
          action: 'RFQ_SENT',
          entityLabel: expect.stringContaining(proposal.reference as string),
        });
      });
  });

  it('lists newest first, filters by stage, and keeps roles to their permissions', async () => {
    const list = await request(app)
      .get('/api/v1/proposals?limit=100')
      .set(bearer(readOnly))
      .expect(200);
    const created = (list.body.items as Array<{ createdAt: string }>).map((p) => p.createdAt);
    expect(created).toEqual([...created].sort().reverse());
    const sent = await request(app)
      .get('/api/v1/proposals?stage=RFQ_SENT')
      .set(bearer(readOnly))
      .expect(200);
    expect(sent.body.items.every((p: { stage: string }) => p.stage === 'RFQ_SENT')).toBe(true);
    expect(sent.body.items.length).toBeGreaterThan(0);

    await create(approver).expect(403);
    await create(placement).expect(403);
    await create(readOnly).expect(403);
  });
});
