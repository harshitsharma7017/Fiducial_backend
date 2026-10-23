import { RISK_DETAIL_FIELDS, XLSX_CONTENT_TYPE, formatDate } from '../src/shared/index.ts';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLogModel } from '../src/modules/audit/audit.model.ts';
import { bearer, createTestApp, tokenFor, useTestDatabase } from './helpers/app.ts';
import { seedMasters } from './helpers/masters.ts';
import { approveRfq } from './helpers/rfq.ts';

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
  return request(app).post('/api/v1/proposals').set(bearer(token)).send({
    clientId,
    locationIds,
    dueDate: '2026-11-15',
    policyStart: '2026-12-01',
    policyEnd: '2027-11-30',
  });
}

const dataSheet = (overrides: Record<string, unknown> = {}) => ({
  dueDate: '2026-11-20',
  policyStart: '2026-12-01',
  policyEnd: '2027-11-30',
  locations: [
    {
      locationId: plant1,
      // D1: the building is a dynamic entry, priced area × rate.
      buildings: [{ name: 'Building 1', sqFt: '1000', ratePerSqFt: '2000', amount: '' }],
      fire: [
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

  it('requires the policy period on the Data Sheet', async () => {
    const { body: proposal } = await create().expect(201);
    const blank = await request(app)
      .put(`/api/v1/proposals/${proposal.id}/data-sheet`)
      .set(bearer(manager))
      .send(dataSheet({ policyStart: '', policyEnd: '' }))
      .expect(400);
    expect(JSON.stringify(blank.body.details)).toContain('Enter the start of the policy period');
    expect(JSON.stringify(blank.body.details)).toContain('Enter the end of the policy period');
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
      .send({
        clientId: other.body.id,
        locationIds: [plant1],
        dueDate: '2026-11-15',
        policyStart: '2026-12-01',
        policyEnd: '2027-11-30',
      })
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
      'Money: enter Cash in safe / counter or Cash in transit - Single carrying limit, or leave the section out.',
    ]);
    expect(partial.body.locations[0].fire).toEqual([
      { key: 'STOCKS', sqFt: null, ratePerSqFt: null, amount: '500000', sumInsured: '500000' },
    ]);
    // D1: the building is in its own list, priced area × rate.
    expect(partial.body.locations[0].buildings).toEqual([
      {
        name: 'Building 1',
        sqFt: '1000',
        ratePerSqFt: '2000',
        amount: null,
        sumInsured: '2000000',
      },
    ]);
    expect(partial.body.locations[0]).toMatchObject({
      buildingsTotal: '2000000',
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
    // B5: a section marked not required (Money here) is omitted entirely, not shown as "Not required".
    expect(rows).not.toContainEqual(['Money', 'Not required']);
    expect(rows.some((row) => row[0] === 'Money')).toBe(false);
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

  it('B1: Proposed Option 2 is saved, reloaded and rendered, including a valid zero', async () => {
    const { body: proposal } = await create(manager, [plant1]).expect(201);
    const save = (body: object) =>
      request(app)
        .put(`/api/v1/proposals/${proposal.id}/data-sheet`)
        .set(bearer(manager))
        .send(body);
    // Fire STOCKS: Option 1 60,00,000, Option 2 a valid zero. Money: Option 1 5,00,000, Option 2
    // 8,00,000. FLOP included with a non-zero Option 2 via its single sum-insured line.
    const body = {
      dueDate: '2026-11-20',
      policyStart: '2026-12-01',
      policyEnd: '2027-11-30',
      locations: [
        {
          locationId: plant1,
          fire: [{ key: 'STOCKS', sqFt: '', ratePerSqFt: '', amount: '6000000' }],
          hypothecation: '',
          openStock: '',
          risk: risk(),
        },
      ],
      fireOption2: [{ group: 'STOCKS', amount: '0' }],
      sections: [
        { code: 'MONEY', included: true, proposed1: '500000', proposed2: '800000' },
        { code: 'BURGLARY', included: false, proposed1: '', proposed2: '' },
      ],
      claims: [],
      notes: null,
    };
    const saved = await save(body).expect(200);
    // Option 2 on the API record: Fire line keeps the valid zero; Money keeps 8,00,000.
    const stocks = saved.body.fire.groups.find((g: { group: string }) => g.group === 'STOCKS');
    expect(stocks).toMatchObject({ proposed1: '6000000', proposed2: '0' });
    expect(saved.body.fire.proposed2).toBe('0');
    const money = saved.body.sections.find((s: { code: string }) => s.code === 'MONEY');
    expect(money).toMatchObject({ proposed1: '500000', proposed2: '800000' });

    // Reload: Option 2 survives the round trip, zero included.
    const reloaded = await request(app)
      .get(`/api/v1/proposals/${proposal.id}`)
      .set(bearer(manager))
      .expect(200);
    const stocks2 = reloaded.body.fire.groups.find((g: { group: string }) => g.group === 'STOCKS');
    expect(stocks2.proposed2).toBe('0');
    expect(reloaded.body.sections.find((s: { code: string }) => s.code === 'MONEY').proposed2).toBe(
      '800000',
    );

    // The built-in RFQ schedule renders Option 2 (column 5): the Money sum insured's Option 2.
    await approveRfq(app, proposal.id, manager, approver);
    const file = await request(app)
      .get(`/api/v1/proposals/${proposal.id}/rfq?format=xlsx`)
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
    const schedule = workbook.getWorksheet('schedule')!;
    const rows = schedule
      .getSheetValues()
      .flatMap((row) => (Array.isArray(row) ? [row.slice(1, 6)] : []));
    // Fire STOCKS line: Option 1 (col 3) 60,00,000; Option 2 (col 4) the valid zero shows as 0.
    const stockRow = rows.find((r) => typeof r[1] === 'string' && r[1].includes('stock'));
    expect(stockRow?.[2]).toBe(6000000);
    // Money's sum insured line carries Option 2 8,00,000 (built-in columns 3 and 4).
    expect(rows.some((r) => r[2] === 500000 && r[3] === 800000)).toBe(true);
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
              // D1: two buildings, each 10.5 sq ft at ₹3 (₹31.50): Excel shows 32 each, 63 total.
              buildings: [
                { name: 'Building 1', sqFt: '10.5', ratePerSqFt: '3', amount: '' },
                { name: 'Building 2', sqFt: '10.5', ratePerSqFt: '3', amount: '' },
              ],
              fire: [
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
    // D1: the building's exact sum insured is 31.5; the two buildings total 63.
    expect(location.buildings[0].sumInsured).toBe('31.5');
    expect(location.buildingsTotal).toBe('63');
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
    // D1: each building is a row under the Building heading (no S No), priced area × rate.
    expect(find('Building 1')).toEqual([undefined, 'Building 1', 10.5, 3, 31.5]);
    expect(find('Building 2')).toEqual([undefined, 'Building 2', 10.5, 3, 31.5]);
    // The Building heading's subtotal is both buildings: 63.
    expect(
      find(
        'All Building & all type of civil structures Including Plinth & Foundation, Compound wall, False Ceiling and all Allied Building',
      )?.[4],
    ).toBe(63);
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
    // Only what was filled is printed, with its Data Sheet number: the Building heading over its
    // two buildings (no S No), Plant and Machinery (5) over Genset (a) and Transformer (c), Stock
    // (6, its own line empty) over third-party stock (a), then hypothecation and open stock.
    expect(rows.map((row) => row[0]).filter((n) => typeof n === 'string' && n.length <= 2)).toEqual(
      ['1', '5', 'a', 'c', '6', 'a', '1', '2'],
    );
    expect(find('Compressor and all its accessories')).toBeUndefined();
    expect(find('Compound wall')).toBeUndefined();
    expect(find('All types of stock pertaining to insured business')?.[4]).toBeUndefined();
    // Sub-items are indented, letter and description; the headings are not.
    const sheet = workbook.getWorksheet('fire by location')!;
    const rowNumber = (label: string) =>
      sheet.getSheetValues().findIndex((row) => Array.isArray(row) && row[2] === label);
    const transformer = sheet.getRow(rowNumber('Transformer and all its accessories'));
    expect(transformer.getCell(1).alignment?.indent).toBe(1);
    expect(transformer.getCell(2).alignment?.indent).toBe(2);
    expect(
      sheet.getRow(rowNumber('All types of Plant and Machinery and all its accessories')).getCell(2)
        .alignment?.indent ?? 0,
    ).toBe(0);
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
    // Money's sum insured is the cash in safe + single carrying limit, not the 600000 typed.
    expect(section('MONEY')).toMatchObject({
      proposed1: '300000',
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
    expect(schedule).toContainEqual([4, 'Sum insured', 300000]);
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

  it('C-2: new business takes the client’s current policy as the Existing column', async () => {
    const { body: proposal } = await create(manager, [plant1]).expect(201);
    const sheet = (existing: Record<string, unknown>) =>
      dataSheet({
        locations: [
          {
            locationId: plant1,
            fire: [{ key: 'STOCKS', sqFt: '', ratePerSqFt: '', amount: '1000000' }],
            hypothecation: '',
            openStock: '',
            risk: risk(),
          },
        ],
        sections: [],
        fireOption2: [],
        existing,
      });
    const figures = {
      policyNumber: 'CUR/2025/7',
      fireLines: [{ group: 'STOCKS', amount: '900000' }],
      fireTotal: null,
    };
    // Typed figures need the policy they come from.
    const missing = await request(app)
      .put(`/api/v1/proposals/${proposal.id}/data-sheet`)
      .set(bearer(manager))
      .send(sheet({ ...figures, insurer: null }))
      .expect(400);
    expect(JSON.stringify(missing.body.details)).toContain('Enter the existing policy’s insurer');
    const saved = await request(app)
      .put(`/api/v1/proposals/${proposal.id}/data-sheet`)
      .set(bearer(manager))
      .send(sheet({ ...figures, insurer: 'Current General, Fort' }))
      .expect(200);
    expect(saved.body.existing).toMatchObject({
      insurer: 'Current General, Fort',
      policyNumber: 'CUR/2025/7',
      source: 'DATA_SHEET',
    });
    expect(
      saved.body.fire.groups.find((g: { group: string }) => g.group === 'STOCKS').existing,
    ).toBe('900000');
    // The RFQ's schedule has the Existing column, with the policy in force.
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
    const rows = workbook
      .getWorksheet('schedule')!
      .getSheetValues()
      .flatMap((row) => (Array.isArray(row) ? [row.slice(1, 6)] : []));
    expect(rows.find((row) => row[0] === 'S No')).toEqual([
      'S No',
      'Description',
      'Existing Sum Insured',
      'Proposed Sum Insured - Option 1',
      'Proposed Sum Insured - Option 2',
    ]);
    expect(
      rows.find((row) => row[1] === 'All types of stock pertaining to insured business'),
    ).toEqual([6, 'All types of stock pertaining to insured business', 900000, 1000000]);
  });

  it('leaves out of the RFQ whatever is empty or not required', async () => {
    const { body: proposal } = await create(manager, [plant1]).expect(201);
    await request(app)
      .put(`/api/v1/proposals/${proposal.id}/data-sheet`)
      .set(bearer(manager))
      .send(
        dataSheet({
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
              code: 'MONEY',
              included: true,
              proposed1: '',
              proposed2: '',
              lines: { cashInSafe: '200000' },
              covers: [
                { name: 'Riot Strike Malicious Damage', required: true },
                { name: 'Terrorism', required: false },
              ],
            },
          ],
          fireOption2: [],
          claims: [],
        }),
      )
      .expect(200);
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
    // No claims and no risk answers: those sheets are left out.
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      'premium details',
      'schedule',
      'fire by location',
    ]);
    const text = (name: string) => JSON.stringify(workbook.getWorksheet(name)!.getSheetValues());
    const schedule = text('schedule');
    // Money: the one line filled and the cover asked for; the blank lines and the cover not
    // required are left out.
    expect(schedule).toContain('Cash in safe / counter');
    expect(schedule).not.toContain('Cash in transit');
    expect(schedule).toContain('Riot Strike Malicious Damage');
    expect(schedule).not.toContain('Not required');
    // Fire: only the stock line; no empty lines, no unanswered covers.
    expect(schedule).toContain('All types of stock pertaining to insured business');
    expect(schedule).not.toContain('Office equipments');
    expect(schedule).not.toContain('Earthquake');
    // No hypothecation or open stock given: no "Nil" rows.
    const location = text('fire by location');
    expect(location).not.toContain('Nil');
    expect(location).not.toContain('Hypothecation');
  });

  it('D-4: Money, Fidelity and Public Liability take their sum insured from their lines', async () => {
    const { body: proposal } = await create(manager, [plant1]).expect(201);
    const saved = await request(app)
      .put(`/api/v1/proposals/${proposal.id}/data-sheet`)
      .set(bearer(manager))
      .send(
        dataSheet({
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
              code: 'MONEY',
              included: true,
              proposed1: '',
              proposed2: '',
              lines: {
                cashInSafe: '200000',
                cashInTransitSingle: '500000',
                cashInTransitAnnual: '12000000',
              },
              lines2: { cashInSafe: '300000' },
            },
            {
              code: 'FIDELITY_GUARANTEE',
              included: true,
              proposed1: '',
              proposed2: '9',
              lines: { employees: '450', limitPerEmployee: '500000', limitPerPeriod: '5000000' },
            },
            {
              code: 'PUBLIC_LIABILITY',
              included: true,
              proposed1: '',
              proposed2: '',
              lines: { anyOneAccident: '10000000', aggregateLimit: '20000000' },
            },
          ],
          fireOption2: [],
        }),
      )
      .expect(200);
    const section = (code: string) =>
      saved.body.sections.find((s: { code: string }) => s.code === code) as {
        proposed1: string | null;
        proposed2: string | null;
      };
    // Money: cash in safe + single carrying limit, in both options; Option 2's lines add up too.
    expect(section('MONEY')).toMatchObject({ proposed1: '700000', proposed2: '300000' });
    // One line is the sum insured on its own; its Option 2 is the section's.
    expect(section('FIDELITY_GUARANTEE')).toMatchObject({ proposed1: '5000000', proposed2: '9' });
    expect(section('PUBLIC_LIABILITY').proposed1).toBe('20000000');
    expect(saved.body.missing).toEqual([]);
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
    // R-5: not before the RFQ is approved.
    const unapproved = await request(app)
      .post(`/api/v1/proposals/${proposal.id}/rfq/sent`)
      .set(bearer(placement))
      .send({ insurerIds: [insurers[0]] })
      .expect(409);
    expect(unapproved.body.code).toBe('RFQ_NOT_APPROVED');
    await approveRfq(app, proposal.id as string, manager, approver);
    const sent = await request(app)
      .post(`/api/v1/proposals/${proposal.id}/rfq/sent`)
      .set(bearer(placement))
      .send({ insurerIds: [insurers[0]] })
      .expect(200);
    expect(sent.body).toMatchObject({ stage: 'RFQ_SENT', locked: true });
    // Marked by hand: sent outside the app, quotes due on the case's due date.
    expect(sent.body.insurers[0]).toMatchObject({
      status: 'SENT',
      sentVia: 'OUTSIDE',
      sentBy: 'Test User',
      // The Data Sheet's due date, saved above.
      dueDate: sent.body.dueDate,
      overdue: false,
      reminderCount: 0,
      response: null,
      lastMail: null,
    });
    expect(sent.body.insurers[1]).toMatchObject({
      status: 'NOT_SENT',
      sentVia: null,
      dueDate: null,
    });
    expect(sent.body.activity[0].message).toBe(
      `RFQ sent outside the app to Test General, Fort (fort@insurer.example), quotes due ${formatDate(sent.body.dueDate as string)}`,
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

// D1 (multiple buildings) and D2 (Interiors one item with Furniture, Fixtures and Fittings).
describe('D1 and D2: dynamic buildings and Interior under Furniture', () => {
  it('D1: any number of buildings, priced amount or area × rate, in the Building line', async () => {
    const { body: proposal } = await create(manager, [plant1]).expect(201);
    const saved = await request(app)
      .put(`/api/v1/proposals/${proposal.id}/data-sheet`)
      .set(bearer(manager))
      .send(
        dataSheet({
          locations: [
            {
              locationId: plant1,
              buildings: [
                // Three buildings: a typed amount, an area × rate, and a named shed.
                { name: 'Main block', sqFt: '', ratePerSqFt: '', amount: '5000000' },
                { name: 'Warehouse', sqFt: '2000', ratePerSqFt: '1500', amount: '' },
                { name: 'Shed A', sqFt: '', ratePerSqFt: '', amount: '250000' },
              ],
              fire: [
                { key: 'COMPOUND_WALL', sqFt: '', ratePerSqFt: '', amount: '100000' },
                { key: 'STOCKS', sqFt: '', ratePerSqFt: '', amount: '1000000' },
              ],
              hypothecation: '',
              openStock: '',
              risk: risk(),
            },
          ],
          sections: [
            { code: 'BURGLARY', included: true, proposed1: '', proposed2: '', basis: 'FULL' },
          ],
          fireOption2: [],
        }),
      )
      .expect(200);
    const location = saved.body.locations[0];
    // Each building keeps its own sum insured; the warehouse is 2000 × 1500 = 3,000,000.
    expect(
      location.buildings.map((b: { name: string; sumInsured: string }) => [b.name, b.sumInsured]),
    ).toEqual([
      ['Main block', '5000000'],
      ['Warehouse', '3000000'],
      ['Shed A', '250000'],
    ]);
    // Buildings total 8,250,000; with the compound wall the Building line is 8,350,000.
    expect(location.buildingsTotal).toBe('8250000');
    const building = saved.body.fire.groups.find((g: { group: string }) => g.group === 'BUILDING');
    expect(building.proposed1).toBe('8350000');
    // D3 (Option A): Burglary = Total Fire − buildings. Only the dynamic buildings are deducted;
    // the Building line's civil-structure item (the compound wall) stays in the Burglary base.
    // So contents = STOCKS 1,000,000 + Compound wall 100,000 = 1,100,000 (buildings 8,250,000 out).
    const burglary = saved.body.sections.find((s: { code: string }) => s.code === 'BURGLARY');
    expect(burglary.proposed1).toBe('1100000');
    // The location's Fire total includes buildings.
    expect(location.fireTotal).toBe('9350000');
  });

  it('D2: Furniture, Fixtures and Fittings & Interiors is one item, and counts as contents', async () => {
    const { body: proposal } = await create(manager, [plant1]).expect(201);
    const location = (fire: { key: string; amount: string }[]) => ({
      locationId: plant1,
      buildings: [{ name: 'Building 1', sqFt: '', ratePerSqFt: '', amount: '4000000' }],
      fire: fire.map((item) => ({ ...item, sqFt: '', ratePerSqFt: '' })),
      hypothecation: '',
      openStock: '',
      risk: risk(),
    });
    const sheet = (fire: { key: string; amount: string }[]) =>
      dataSheet({
        locations: [location(fire)],
        sections: [
          { code: 'BURGLARY', included: true, proposed1: '', proposed2: '', basis: 'FULL' },
        ],
        fireOption2: [],
      });
    // A separate Interiors item is no longer accepted.
    await request(app)
      .put(`/api/v1/proposals/${proposal.id}/data-sheet`)
      .set(bearer(manager))
      .send(sheet([{ key: 'INTERIOR', amount: '600000' }]))
      .expect(400);
    const saved = await request(app)
      .put(`/api/v1/proposals/${proposal.id}/data-sheet`)
      .set(bearer(manager))
      .send(
        sheet([
          { key: 'FFF', amount: '1000000' },
          { key: 'STOCKS', amount: '1000000' },
        ]),
      )
      .expect(200);
    const line = (group: string) =>
      saved.body.fire.groups.find((g: { group: string }) => g.group === group);
    expect(line('FFF').proposed1).toBe('1000000');
    expect(line('BUILDING').proposed1).toBe('4000000');
    // Furniture & Interiors count as Burglary contents (all but buildings): 1,000,000 + 1,000,000.
    const burglary = saved.body.sections.find((s: { code: string }) => s.code === 'BURGLARY');
    expect(burglary.proposed1).toBe('2000000');
    expect(saved.body.fire.proposed1).toBe('6000000');

    // The RFQ's Fire by location: item 2 is one row with its sum insured, no sub-items.
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
    const rows = workbook
      .getWorksheet('fire by location')!
      .getSheetValues()
      .flatMap((row) => (Array.isArray(row) ? [row.slice(1, 6)] : []));
    const at = rows.findIndex((row) => row[1] === 'Furniture, Fixtures and Fittings & Interiors');
    expect(rows[at]).toEqual([
      '2',
      'Furniture, Fixtures and Fittings & Interiors',
      undefined,
      undefined,
      1000000,
    ]);
    expect(rows[at + 1]?.[0]).toBe('6');
    expect(rows.some((row) => row[1] === 'Interiors')).toBe(false);
  });

  it('D2: a case saved with a separate Interiors item loads with it added to Furniture', async () => {
    const { Types } = await import('mongoose');
    const { ProposalModel } = await import('../src/modules/proposals/proposal.model.ts');
    const d = (value: string) => Types.Decimal128.fromString(value);
    const now = new Date();
    const inserted = await ProposalModel.collection.insertOne({
      reference: `LEGACY-${randomSuffix()}`,
      type: 'NEW',
      stage: 'DATA_SHEET',
      stageOverride: null,
      clientId: new Types.ObjectId(clientId),
      ownerId: new Types.ObjectId((await tokenFor(app, ['ACCOUNT_MANAGER'])).user.id),
      dueDate: '2026-11-20',
      policyStart: '2026-12-01',
      policyEnd: '2027-11-30',
      locations: [
        {
          locationId: new Types.ObjectId(plant1),
          fire: [
            // Interiors priced as area × rate: 1,000.5 sq ft × ₹450 = ₹4,50,225.
            { key: 'INTERIOR', sqFt: d('1000.5'), ratePerSqFt: d('450'), amount: null },
            { key: 'FFF', sqFt: null, ratePerSqFt: null, amount: d('200000') },
            { key: 'STOCKS', sqFt: null, ratePerSqFt: null, amount: d('300000') },
          ],
          buildings: [],
          hypothecation: null,
          openStock: null,
          risk: {},
        },
      ],
      fireOption2: [],
      sections: [],
      claims: [],
      notes: null,
      insurers: [],
      activity: [],
      createdBy: new Types.ObjectId((await tokenFor(app, ['ADMIN'])).user.id),
      updatedBy: new Types.ObjectId((await tokenFor(app, ['ADMIN'])).user.id),
      createdAt: now,
      updatedAt: now,
    });
    const id = inserted.insertedId.toString();
    const read = await request(app).get(`/api/v1/proposals/${id}`).set(bearer(manager)).expect(200);
    const location = read.body.locations[0];
    // Interiors (4,50,225) is added to Furniture (2,00,000); nothing is lost or counted twice.
    expect(
      location.fire.map((item: { key: string; amount: string | null }) => [item.key, item.amount]),
    ).toEqual([
      ['FFF', '650225'],
      ['STOCKS', '300000'],
    ]);
    expect(read.body.fire.groups.find((g: { group: string }) => g.group === 'FFF').proposed1).toBe(
      '650225',
    );
    expect(location.fireTotal).toBe('950225');
  });

  it('D1: legacy BUILDING_1/BUILDING_2 cases load as buildings and migrate on the next save', async () => {
    // A case stored before D1, with the old fixed building fire items. Inserted raw to keep the
    // legacy keys the current schema no longer allows.
    const { Types } = await import('mongoose');
    const { ProposalModel } = await import('../src/modules/proposals/proposal.model.ts');
    const d = (value: string) => Types.Decimal128.fromString(value);
    const now = new Date();
    const inserted = await ProposalModel.collection.insertOne({
      reference: `LEGACY-${randomSuffix()}`,
      type: 'NEW',
      stage: 'DATA_SHEET',
      stageOverride: null,
      clientId: new Types.ObjectId(clientId),
      ownerId: new Types.ObjectId((await tokenFor(app, ['ACCOUNT_MANAGER'])).user.id),
      dueDate: '2026-11-20',
      policyStart: '2026-12-01',
      policyEnd: '2027-11-30',
      locations: [
        {
          locationId: new Types.ObjectId(plant1),
          fire: [
            { key: 'BUILDING_1', sqFt: d('1000'), ratePerSqFt: d('2000'), amount: null },
            { key: 'BUILDING_2', sqFt: null, ratePerSqFt: null, amount: d('500000') },
            { key: 'STOCKS', sqFt: null, ratePerSqFt: null, amount: d('300000') },
          ],
          hypothecation: null,
          openStock: null,
          risk: {},
        },
      ],
      fireOption2: [],
      sections: [],
      claims: [],
      notes: null,
      insurers: [],
      activity: [],
      createdBy: new Types.ObjectId((await tokenFor(app, ['ADMIN'])).user.id),
      updatedBy: new Types.ObjectId((await tokenFor(app, ['ADMIN'])).user.id),
      createdAt: now,
      updatedAt: now,
    });
    const id = inserted.insertedId.toString();

    // The legacy case loads: the two building fire items appear as buildings, nothing lost.
    const read = await request(app).get(`/api/v1/proposals/${id}`).set(bearer(manager)).expect(200);
    const location = read.body.locations[0];
    expect(
      location.buildings.map((b: { name: string; sumInsured: string }) => [b.name, b.sumInsured]),
    ).toEqual([
      ['Building 1', '2000000'],
      ['Building 2', '500000'],
    ]);
    // The legacy building keys are not left among the Fire items.
    expect(location.fire.map((item: { key: string }) => item.key)).toEqual(['STOCKS']);
    expect(location.buildingsTotal).toBe('2500000');
    expect(
      read.body.fire.groups.find((g: { group: string }) => g.group === 'BUILDING').proposed1,
    ).toBe('2500000');

    // Saving the Data Sheet rewrites the buildings list and drops the legacy keys from storage.
    await request(app)
      .put(`/api/v1/proposals/${id}/data-sheet`)
      .set(bearer(manager))
      .send(
        dataSheet({
          locations: [
            {
              locationId: plant1,
              buildings: location.buildings.map((b: { name: string }) => ({
                name: b.name,
                sqFt: null,
                ratePerSqFt: null,
                amount: b.name === 'Building 1' ? '2000000' : '500000',
              })),
              fire: [{ key: 'STOCKS', sqFt: '', ratePerSqFt: '', amount: '300000' }],
              hypothecation: '',
              openStock: '',
              risk: risk(),
            },
          ],
          sections: [],
          fireOption2: [],
        }),
      )
      .expect(200);
    const stored = await ProposalModel.collection.findOne({ _id: inserted.insertedId });
    const firstLocation = (stored as unknown as { locations: { fire: { key: string }[] }[] })
      .locations[0];
    expect(firstLocation?.fire.map((item) => item.key)).toEqual(['STOCKS']);
    const readAgain = await request(app)
      .get(`/api/v1/proposals/${id}`)
      .set(bearer(manager))
      .expect(200);
    expect(readAgain.body.locations[0].buildingsTotal).toBe('2500000');
  });
});

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10).toUpperCase();
}
