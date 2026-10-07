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
  policyEnd: '',
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
      { group: 'BUILDING', existing: null, proposed1: '2000000', proposed2: null },
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

  it('D-3 and D-7: prints Fire & Burglary as the client’s Data Sheet, with exact totals', async () => {
    const { body: proposal } = await create(manager, [plant1]).expect(201);
    const saved = await request(app)
      .put(`/api/v1/proposals/${proposal.id}/data-sheet`)
      .set(bearer(manager))
      .send(
        dataSheet({
          locations: [
            {
              locationId: plant1,
              fire: [
                // 10.5 sq ft at ₹3 is ₹31.50: Excel shows 32 for each and 63 in total.
                { key: 'BUILDING_1', sqFt: '10.5', ratePerSqFt: '3', amount: '' },
                { key: 'BUILDING_2', sqFt: '10.5', ratePerSqFt: '3', amount: '' },
                { key: 'GENSET', sqFt: '', ratePerSqFt: '', amount: '1000' },
                { key: 'TRANSFORMER', sqFt: '', ratePerSqFt: '', amount: '2000' },
                { key: 'STOCKS_THIRD_PARTY', sqFt: '', ratePerSqFt: '', amount: '500' },
              ],
              hypothecation: 'State Bank of India, Pune',
              openStock: 'Steel coils in the yard',
              risk: risk(),
            },
          ],
          sections: [],
          fireOption2: [],
        }),
      )
      .expect(200);
    const location = saved.body.locations[0];
    expect(location.fire.find((i: { key: string }) => i.key === 'BUILDING_1').sumInsured).toBe(
      '31.5',
    );
    expect(location.fireTotal).toBe('3563');

    const response = await request(app)
      .get(`/api/v1/proposals/${proposal.id}/rfq`)
      .set(bearer(manager))
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(response.body as never);
    const rows = workbook
      .getWorksheet('fire by location')!
      .getSheetValues()
      .flatMap((row) => (Array.isArray(row) ? [row.slice(1, 6)] : []));
    const find = (label: string) => rows.find((row) => row[1] === label);
    expect(find('Building 1 (if applicable)')).toEqual([
      'a',
      'Building 1 (if applicable)',
      10.5,
      3,
      31.5,
    ]);
    expect(find('All types of Plant and Machinery and all its accessories')?.slice(0, 1)).toEqual([
      '5',
    ]);
    expect(find('All types of Plant and Machinery and all its accessories')?.[4]).toBe(3000);
    expect(find('Any other stocks kept at third party job work location')?.[0]).toBe('a');
    expect(find('Total sum insured')?.[4]).toBe(3563);
    expect(find('Hypothecation if any - Please specify')?.[2]).toBe('State Bank of India, Pune');
    expect(find('Stock kept at open space if any - Please Specify')?.[2]).toBe(
      'Steel coils in the yard',
    );
    // Seven items in the client's numbering, with their sub-items.
    expect(rows.map((row) => row[0]).filter((n) => typeof n === 'string' && n.length <= 2)).toEqual(
      [
        '1',
        'a',
        'b',
        'c',
        'd',
        'e',
        'f',
        '2',
        '3',
        '4',
        '5',
        'a',
        'b',
        'c',
        'd',
        '6',
        'a',
        '7',
        '1',
        '2',
      ],
    );
    const schedule = JSON.stringify(workbook.getWorksheet('schedule')!.getSheetValues());
    expect(schedule).toContain('Plant 1: State Bank of India, Pune');
    expect(schedule).toContain('Plant 1: Steel coils in the yard');
  });

  it('D-4 and D-5: saves each section’s lines and annexure, and annexure totals give the sum insured', async () => {
    const { body: proposal } = await create(manager, [plant1]).expect(201);
    const row = (description: string, sumInsured: string, extra: Record<string, string> = {}) => ({
      description,
      quantity: '',
      dimensions: '',
      makeModel: '',
      serialNo: '',
      year: '',
      sumInsured,
      ...extra,
    });
    const sheet = dataSheet({
      locations: [
        {
          locationId: plant1,
          fire: [{ key: 'STOCKS', sqFt: '', ratePerSqFt: '', amount: '1000000' }],
          hypothecation: '',
          openStock: '',
          risk: risk(),
        },
      ],
      sections: [
        {
          code: 'FIRE_LOSS_OF_PROFIT',
          included: true,
          proposed1: '',
          proposed2: '',
          lines: { annualGrossProfit: '8000000' },
        },
        {
          code: 'MONEY',
          included: true,
          proposed1: '600000',
          proposed2: '',
          lines: {
            cashInSafe: '100000',
            cashInTransitSingle: '200000',
            cashInTransitAnnual: '5000000',
          },
        },
        {
          code: 'FIDELITY_GUARANTEE',
          included: false,
          proposed1: '',
          proposed2: '',
          lines: { employees: '45', limitPerEmployee: '100000', limitPerPeriod: '1000000' },
        },
        {
          code: 'PLATE_GLASS',
          included: true,
          proposed1: '1',
          proposed2: '',
          annexure: [
            row('Showroom front glass', '150000', { quantity: '4', dimensions: '3 x 2 x 0.01 m' }),
            row('Office partition', '50000', { quantity: '10' }),
          ],
        },
        {
          code: 'EEI',
          included: true,
          proposed1: '',
          proposed2: '',
          annexure: [
            row('CNC controller', '1250000', {
              makeModel: 'Fanuc 0i-MF',
              serialNo: 'F-77',
              year: '2021',
            }),
          ],
        },
        { code: 'PUBLIC_LIABILITY', included: false, proposed1: '', proposed2: '' },
      ],
      fireOption2: [],
    });
    const saved = await request(app)
      .put(`/api/v1/proposals/${proposal.id}/data-sheet`)
      .set(bearer(manager))
      .send(sheet)
      .expect(200);
    const section = (code: string) =>
      saved.body.sections.find((s: { code: string }) => s.code === code) as {
        included: boolean;
        proposed1: string | null;
        lines: Record<string, string | null>;
        annexure: Array<Record<string, string | null>>;
      };
    // FLOP's sum insured is its annual gross profit; an annexure's is its rows' total.
    expect(section('FIRE_LOSS_OF_PROFIT').proposed1).toBe('8000000');
    expect(section('PLATE_GLASS').proposed1).toBe('200000');
    expect(section('EEI').proposed1).toBe('1250000');
    expect(section('MONEY')).toMatchObject({
      proposed1: '600000',
      lines: {
        cashInSafe: '100000',
        cashInTransitSingle: '200000',
        cashInTransitAnnual: '5000000',
      },
    });
    // Not required: kept as entered, but not on the RFQ.
    expect(section('FIDELITY_GUARANTEE')).toMatchObject({
      included: false,
      lines: { employees: '45' },
    });
    expect(section('PUBLIC_LIABILITY').lines).toEqual({
      anyOneAccident: null,
      aggregateLimit: null,
    });
    expect(section('PLATE_GLASS').annexure[0]).toMatchObject({
      description: 'Showroom front glass',
      quantity: '4',
      dimensions: '3 x 2 x 0.01 m',
      sumInsured: '150000',
    });
    expect(saved.body.missing).toEqual([]);

    // Lines a section does not have, or an annexure on a section without one, are refused.
    const wrong = await request(app)
      .put(`/api/v1/proposals/${proposal.id}/data-sheet`)
      .set(bearer(manager))
      .send({
        ...sheet,
        sections: [
          {
            code: 'MONEY',
            included: true,
            proposed1: '1',
            proposed2: '',
            lines: { employees: '3' },
          },
          {
            code: 'BURGLARY',
            included: true,
            proposed1: '1',
            proposed2: '',
            annexure: [row('x', '1')],
          },
        ],
      })
      .expect(400);
    expect(JSON.stringify(wrong.body.details)).toContain('Money has no such line');
    expect(JSON.stringify(wrong.body.details)).toContain('Burglary has no annexure');

    const file = await request(app)
      .get(`/api/v1/proposals/${proposal.id}/rfq`)
      .set(bearer(manager))
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file.body as never);
    const values = (name: string) =>
      workbook
        .getWorksheet(name)!
        .getSheetValues()
        // Empty cells come back as gaps; compare them as null.
        .flatMap((r) =>
          Array.isArray(r) ? [Array.from(r.slice(1, 7), (v: unknown) => v ?? null)] : [],
        );
    const schedule = values('schedule');
    expect(schedule).toContainEqual([1, 'Cash in safe / counter', 100000]);
    expect(schedule).toContainEqual([3, 'Cash in transit - Annual carrying limit', 5000000]);
    expect(schedule).toContainEqual([4, 'Sum insured', 600000]);
    expect(schedule).toContainEqual([1, 'Annual Gross Profit', 8000000]);
    expect(schedule).toContainEqual([1, 'As per Annexure (2 items)', 200000]);
    expect(JSON.stringify(schedule)).not.toContain('No of Employees');
    const annexure = values('Annexure');
    expect(annexure.some((r) => r[0] === 'Plate Glass')).toBe(true);
    expect(annexure).toContainEqual([
      'S No',
      'Description',
      'No of Plate Glass',
      'Dimension (L x B x H)',
      'Sum Insured',
    ]);
    expect(annexure).toContainEqual([1, 'Showroom front glass', 4, '3 x 2 x 0.01 m', 150000]);
    expect(annexure).toContainEqual([null, 'Total', null, null, 200000]);
    expect(annexure).toContainEqual([1, 'CNC controller', 'Fanuc 0i-MF', 'F-77', '2021', 1250000]);
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
