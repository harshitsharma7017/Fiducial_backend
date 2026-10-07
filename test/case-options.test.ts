import {
  CATALOG_SHEETS,
  OTHER_SECTION_LABELS,
  OTHER_SECTIONS,
  RISK_DETAIL_FIELDS,
  XLSX_CONTENT_TYPE,
  type CatalogMaster,
} from '../src/shared/index.ts';
import ExcelJS from 'exceljs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLogModel } from '../src/modules/audit/audit.model.ts';
import type {
  ExistingPolicyResult,
  ExistingPolicySource,
} from '../src/modules/proposals/existing-policy-source.ts';
import { bearer, createTestApp, tokenFor, useTestDatabase } from './helpers/app.ts';
import { seedMasters } from './helpers/masters.ts';

// The case's product, three options, Burglary basis, add-ons and cover toggles (C-1 to C-6), and
// how they print on the RFQ.

useTestDatabase();

const GSTIN = '27AAPFU0939F1ZV';
const LAST_YEAR: ExistingPolicyResult = {
  status: 'FOUND',
  policy: {
    source: 'PolicyDesk',
    insurer: 'Example General Insurance, Fort',
    policyNumber: 'EGI/FIRE/2025/0042',
    product: 'BLUS',
    periodStart: '2025-11-01',
    periodEnd: '2026-10-31',
    sections: [
      { code: 'FIRE', sumInsured: '150000000', premium: '96000' },
      { code: 'MONEY', sumInsured: '200000', premium: '800' },
    ],
    fireLines: [
      { group: 'BUILDING', sumInsured: '100000000' },
      { group: 'STOCKS', sumInsured: '50000000' },
    ],
    totalSumInsured: '150200000',
    netPremium: '96800',
    gst: '17424',
    totalPremium: '114224',
  },
};
const source: ExistingPolicySource = { latest: () => Promise.resolve(LAST_YEAR) };
const app = createTestApp({}, source);

const CLIENT_RFQ = readFileSync(
  fileURLToPath(new URL('../data/client-formats/Fiducial_RFQ format.xlsx', import.meta.url)),
);

const CR = 10_000_000;
let admin: string;
let manager: string;
let readOnly: string;
let clientId: string;
let locationId: string;

const SHEET_ROWS: Partial<Record<CatalogMaster, (string | number)[][]>> = {
  products: [
    ['BSUS', 'Bharat Sookshma Udyam Suraksha (BSUS)', '', 5 * CR, 1, 'Yes', '', ''],
    ['BLUS', 'Bharat Laghu Udyam Suraksha (BLUS)', 5 * CR, 50 * CR, 2, 'Yes', '', ''],
    ['SFSP', 'Standard Fire & Special Perils Policy (SFSP)', 50 * CR, '', 3, 'Yes', '', ''],
    ['PAR', 'Property All Risk (PAR)', 5 * CR, '', 4, 'Yes', '', ''],
  ],
  sections: [
    [
      'FIRE',
      'Fire & Allied Perils',
      1,
      'Yes',
      '',
      'Earthquake; Storm, Tempest, Flood & Inundation; Terrorism',
    ],
    ...OTHER_SECTIONS.map((code, index) => [
      code,
      OTHER_SECTION_LABELS[code],
      index + 2,
      'Yes',
      '',
      code === 'BURGLARY'
        ? 'Theft; Riot Strike Malicious Damage; Terrorism'
        : code === 'FIRE_FLOATER'
          ? 'Earthquake; Floater clause'
          : '',
    ]),
  ],
  addons: [
    ['FIRE_ADDITIONAL', 1, 'Abandonment of Property', '', '', 'Yes'],
    ['PAR', 1, 'Debris removal', '', '', 'Yes'],
    ['PAR', 2, 'Waiver of recourse', '', '', 'Yes'],
    ['SFSP', 1, 'Spontaneous combustion', '', '', 'Yes'],
    ['BSUS & BLUS', 1, 'Earth quake', 'PAID', 'Full sum insured', 'Yes'],
  ],
};

async function importMasters() {
  const workbook = new ExcelJS.Workbook();
  for (const [master, rows] of Object.entries(SHEET_ROWS)) {
    const spec = CATALOG_SHEETS[master as CatalogMaster];
    const sheet = workbook.addWorksheet(spec.sheetName);
    sheet.addRow(spec.columns.map((column) => column.header));
    for (const row of rows) sheet.addRow(row);
  }
  const response = await request(app)
    .post('/api/v1/catalog/import?dryRun=false&fileName=masters.xlsx')
    .set(bearer(admin))
    .set('Content-Type', XLSX_CONTENT_TYPE)
    .send(Buffer.from(await workbook.xlsx.writeBuffer()));
  expect(response.body.imported).toBe(true);
}

beforeAll(async () => {
  await seedMasters();
  admin = (await tokenFor(app, ['ADMIN'])).token;
  manager = (await tokenFor(app, ['ACCOUNT_MANAGER'])).token;
  readOnly = (await tokenFor(app, ['READ_ONLY'])).token;
  await importMasters();
  const client = await request(app)
    .post('/api/v1/clients')
    .set(bearer(admin))
    .send({
      name: 'Options Test Mills',
      gstin: GSTIN,
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
  const location = await request(app)
    .post(`/api/v1/clients/${clientId}/locations`)
    .set(bearer(admin))
    .send({
      name: 'Plant 1',
      line1: 'Plot 1',
      line2: null,
      city: 'Mumbai',
      pincode: '400001',
      occupancyCode: null,
    })
    .expect(201);
  locationId = location.body.id as string;
});

async function newCase(type: 'NEW' | 'EXISTING' = 'NEW') {
  const response = await request(app)
    .post('/api/v1/proposals')
    .set(bearer(manager))
    .send({
      type,
      clientId,
      locationIds: [locationId],
      dueDate: '2026-10-20',
      policyStart: '2026-11-01',
      policyEnd: '2027-10-31',
    })
    .expect(201);
  return response.body.id as string;
}

type Section = Record<string, unknown> & { code: string };

/** A Data Sheet: Fire items by key, the sections given (others left out), and any extra fields. */
function sheet(
  fire: Record<string, string>,
  sections: Section[] = [],
  extra: Record<string, unknown> = {},
) {
  const given = new Map(sections.map((section) => [section.code, section]));
  return {
    dueDate: '2026-10-20',
    policyStart: '2026-11-01',
    policyEnd: '2027-10-31',
    locations: [
      {
        locationId,
        fire: Object.entries(fire).map(([key, amount]) => ({
          key,
          sqFt: null,
          ratePerSqFt: null,
          amount,
        })),
        hypothecation: null,
        openStock: null,
        risk: Object.fromEntries(RISK_DETAIL_FIELDS.map((field) => [field.key, 'Yes'])),
      },
    ],
    fireOption2: [],
    claims: [],
    notes: null,
    ...extra,
    sections: OTHER_SECTIONS.map((code) => ({
      code,
      included: false,
      proposed1: null,
      proposed2: null,
      ...given.get(code),
    })),
  };
}

function save(id: string, body: object, token = manager) {
  return request(app).put(`/api/v1/proposals/${id}/data-sheet`).set(bearer(token)).send(body);
}

const section = (body: { sections: Section[] }, code: string) =>
  body.sections.find((item) => item.code === code) as Record<string, unknown>;

describe('C-1: the product follows the Fire sum insured, with an override and its reason', () => {
  it('suggests BSUS at 4 Cr, BLUS at 20 Cr and SFSP at 80 Cr, PAR offered above 5 Cr', async () => {
    const id = await newCase();
    const expectations: [number, string, string[]][] = [
      [4, 'BSUS', ['BSUS']],
      [20, 'BLUS', ['BLUS', 'PAR']],
      [80, 'SFSP', ['SFSP', 'PAR']],
    ];
    for (const [crore, product, suggested] of expectations) {
      const saved = await save(id, sheet({ STOCKS: String(crore * CR) })).expect(200);
      expect(saved.body.product).toMatchObject({ code: product, source: 'SUGGESTED' });
      expect(saved.body.suggestedProducts.map((item: { code: string }) => item.code)).toEqual(
        suggested,
      );
    }
  });

  it('takes PAR at 20 Cr as offered; a product outside the range needs the reason', async () => {
    const id = await newCase();
    const twenty = { STOCKS: String(20 * CR) };
    const par = await save(id, sheet(twenty, [], { product: { code: 'PAR', reason: null } }));
    expect(par.status).toBe(200);
    expect(par.body.product).toMatchObject({ code: 'PAR', source: 'CHOSEN', reason: null });
    expect(par.body.addonLists).toEqual(['PAR']);

    const bare = await save(id, sheet(twenty, [], { product: { code: 'BSUS', reason: null } }));
    expect(bare.status).toBe(400);
    expect(bare.body.details).toContainEqual(
      expect.objectContaining({
        path: 'product.reason',
        message: expect.stringContaining('suggests BLUS or PAR') as string,
      }),
    );
    await save(id, sheet(twenty, [], { product: { code: 'GOLD', reason: null } })).expect(400);

    const reason = 'Client renews under BSUS by board decision';
    const override = await save(id, sheet(twenty, [], { product: { code: 'BSUS', reason } }));
    expect(override.status).toBe(200);
    expect(override.body.product).toEqual({
      code: 'BSUS',
      name: 'Bharat Sookshma Udyam Suraksha (BSUS)',
      source: 'OVERRIDE',
      reason,
    });
    expect(override.body.missing).toEqual([]);
    const audit = await AuditLogModel.findOne({ entityId: id, action: 'PROPOSAL_UPDATED' })
      .sort({ _id: -1 })
      .lean();
    expect(audit?.after).toMatchObject({ product: `BSUS (override): ${reason}` });
  });
});

describe('C-4: add-ons from the product’s lists, with favourites per client', () => {
  it('offers only PAR add-ons on a PAR case', async () => {
    const id = await newCase();
    const body = (addons: object[]) =>
      sheet({ STOCKS: String(20 * CR) }, [], { product: { code: 'PAR', reason: null }, addons });
    const wrong = await save(id, body([{ list: 'SFSP', name: 'Spontaneous combustion' }]));
    expect(wrong.status).toBe(400);
    expect(wrong.body.details[0].message).toMatch(/SFSP list, which PAR does not use/);
    await save(id, body([{ list: 'PAR', name: 'Made up cover' }])).expect(400);
    const saved = await save(id, body([{ list: 'PAR', name: 'Debris removal' }])).expect(200);
    expect(saved.body.addons).toEqual([{ list: 'PAR', name: 'Debris removal' }]);
  });

  it('keeps favourites per client, for the team that works the cases', async () => {
    const path = `/api/v1/clients/${clientId}/addon-favourites`;
    expect((await request(app).get(path).set(bearer(manager)).expect(200)).body).toEqual({
      items: [],
      updatedAt: null,
    });
    const items = [
      { list: 'PAR', name: 'Debris removal' },
      { list: 'BSUS_BLUS', name: 'Earth quake' },
    ];
    await request(app).put(path).set(bearer(readOnly)).send({ items }).expect(403);
    await request(app)
      .put(path)
      .set(bearer(manager))
      .send({ items: [...items, items[0]] })
      .expect(400);
    const saved = await request(app).put(path).set(bearer(manager)).send({ items }).expect(200);
    expect(saved.body.items).toEqual(items);
    expect((await request(app).get(path).set(bearer(readOnly)).expect(200)).body.items).toEqual(
      items,
    );
    const audit = await AuditLogModel.findOne({ action: 'ADDON_FAVOURITES_UPDATED' }).lean();
    expect(audit).toMatchObject({ entity: 'client', entityId: clientId });
  });
});

describe('C-3: Burglary on 100% or first loss, from the Fire contents', () => {
  it('takes the contents, and recalculates when they change', async () => {
    const id = await newCase();
    const burglary = { code: 'BURGLARY', included: true, basis: 'FIRST_LOSS_25' };
    const fire = { BUILDING_1: String(10 * CR), FFF: '1000000', STOCKS: '50000000' };
    const first = await save(id, sheet(fire, [burglary])).expect(200);
    expect(section(first.body, 'BURGLARY')).toMatchObject({
      proposed1: '51000000',
      proposed2: null,
      basis: 'FIRST_LOSS_25',
      basisAmounts: { proposed1: '12750000', proposed2: null },
    });
    // Option 2 adds the contents lines given a second figure, as the Fire Option 2 total does.
    const changed = await save(
      id,
      sheet({ ...fire, STOCKS: '70000000' }, [{ ...burglary, basis: 'FIRST_LOSS_50' }], {
        fireOption2: [{ group: 'STOCKS', amount: '90000000' }],
      }),
    ).expect(200);
    expect(section(changed.body, 'BURGLARY')).toMatchObject({
      proposed1: '71000000',
      proposed2: '90000000',
      basisAmounts: { proposed1: '35500000', proposed2: '45000000' },
    });
    // A basis belongs to Burglary and Burglary Floater only.
    await save(id, sheet(fire, [{ code: 'MONEY', included: true, basis: 'FULL' }])).expect(400);
  });

  it('leaves a typed Burglary amount without a basis as it was', async () => {
    const id = await newCase();
    const saved = await save(
      id,
      sheet({ STOCKS: '50000000' }, [{ code: 'BURGLARY', included: true, proposed1: '4000000' }]),
    ).expect(200);
    expect(section(saved.body, 'BURGLARY')).toMatchObject({
      proposed1: '4000000',
      basis: null,
      basisAmounts: null,
    });
  });
});

describe('C-6: the add-on covers of each section, asked for or not', () => {
  it('lists the master’s covers per section and keeps the answers', async () => {
    const id = await newCase();
    const before = await request(app)
      .get(`/api/v1/proposals/${id}`)
      .set(bearer(manager))
      .expect(200);
    expect(before.body.fire.covers).toEqual([
      { name: 'Earthquake', required: null },
      { name: 'Storm, Tempest, Flood & Inundation', required: null },
      { name: 'Terrorism', required: null },
    ]);
    expect(section(before.body, 'FIRE_FLOATER').covers).toEqual([
      { name: 'Earthquake', required: null },
      { name: 'Floater clause', required: null },
    ]);
    const saved = await save(
      id,
      sheet(
        { STOCKS: '50000000' },
        [
          {
            code: 'FIRE_FLOATER',
            included: true,
            proposed1: '1000000',
            covers: [{ name: 'Floater clause', required: true }],
          },
        ],
        {
          fireCovers: [
            { name: 'Earthquake', required: true },
            { name: 'Storm, Tempest, Flood & Inundation', required: true },
            { name: 'Terrorism', required: false },
          ],
        },
      ),
    ).expect(200);
    expect(saved.body.fire.covers.map((cover: { required: boolean }) => cover.required)).toEqual([
      true,
      true,
      false,
    ]);
    expect(section(saved.body, 'FIRE_FLOATER').covers).toEqual([
      { name: 'Earthquake', required: null },
      { name: 'Floater clause', required: true },
    ]);
  });
});

describe('C-2: Existing, Option 1 and Option 2 for every schedule line', () => {
  it('starts a renewal from the policy software’s copy and keeps what is typed', async () => {
    const id = await newCase('EXISTING');
    const created = await request(app)
      .get(`/api/v1/proposals/${id}`)
      .set(bearer(manager))
      .expect(200);
    expect(created.body.existing).toEqual({
      insurer: 'Example General Insurance, Fort',
      policyNumber: 'EGI/FIRE/2025/0042',
      source: 'POLICY_SOFTWARE',
    });
    expect(created.body.fire.existing).toBe('150000000');

    const copy = {
      insurer: 'Example General Insurance, Fort',
      policyNumber: 'EGI/FIRE/2025/0042',
      fireLines: [
        { group: 'BUILDING', amount: '100000000' },
        { group: 'STOCKS', amount: '50000000' },
      ],
      fireTotal: null,
    };
    const money = {
      code: 'MONEY',
      included: true,
      proposed1: '300000',
      existing: '200000',
      lines: { cashInSafe: '100000' },
      lines2: { cashInSafe: '150000' },
    };
    // Saving the copy unchanged still follows the policy software.
    const unchanged = await save(
      id,
      sheet({ STOCKS: '60000000' }, [money], { existing: copy }),
    ).expect(200);
    expect(unchanged.body.existing.source).toBe('POLICY_SOFTWARE');
    expect(section(unchanged.body, 'MONEY')).toMatchObject({
      existing: '200000',
      lines: { cashInSafe: '100000' },
      lines2: { cashInSafe: '150000' },
      existingLines: { cashInSafe: null },
    });

    const typed = await save(
      id,
      sheet(
        { STOCKS: '60000000' },
        [{ ...money, existing: '250000', existingLines: { cashInSafe: '80000' } }],
        {
          existing: {
            ...copy,
            fireLines: [...copy.fireLines, { group: 'FFF', amount: '2500000' }],
          },
        },
      ),
    ).expect(200);
    expect(typed.body.existing.source).toBe('DATA_SHEET');
    expect(typed.body.fire.existing).toBe('152500000');
    expect(typed.body.fire.groups.find((g: { group: string }) => g.group === 'FFF').existing).toBe(
      '2500000',
    );
    expect(section(typed.body, 'MONEY')).toMatchObject({
      existing: '250000',
      existingLines: { cashInSafe: '80000' },
    });
    // The policy software's copy itself is kept as fetched.
    expect(typed.body.existingPolicy.totalSumInsured).toBe('150200000');

    // Figures need the policy they come from.
    const nameless = await save(
      id,
      sheet({ STOCKS: '60000000' }, [money], { existing: { ...copy, insurer: null } }),
    );
    expect(nameless.status).toBe(400);

    // Fetching the copy again replaces what was typed.
    const refreshed = await request(app)
      .post(`/api/v1/proposals/${id}/existing-policy`)
      .set(bearer(manager))
      .expect(200);
    expect(refreshed.body.existing.source).toBe('POLICY_SOFTWARE');
    expect(refreshed.body.fire.existing).toBe('150000000');
  });
});

describe('The RFQ carries the options, basis, covers, product and add-ons', () => {
  it('fills them into the client’s template', async () => {
    await request(app)
      .post('/api/v1/templates/RFQ?fileName=Fiducial_RFQ%20format.xlsx')
      .set(bearer(admin))
      .set('Content-Type', XLSX_CONTENT_TYPE)
      .send(CLIENT_RFQ)
      .expect(200);
    const id = await newCase('EXISTING');
    await save(
      id,
      sheet(
        { BUILDING_1: String(10 * CR), FFF: '1000000', STOCKS: '50000000' },
        [
          { code: 'BURGLARY', included: true, basis: 'FIRST_LOSS_75' },
          {
            code: 'MONEY',
            included: true,
            proposed1: '300000',
            lines: { cashInSafe: '100000' },
            lines2: { cashInSafe: '150000' },
            existingLines: { cashInSafe: '80000' },
          },
        ],
        {
          product: { code: 'PAR', reason: null },
          addons: [{ list: 'PAR', name: 'Waiver of recourse' }],
          fireCovers: [
            { name: 'Earthquake', required: true },
            { name: 'Terrorism', required: false },
          ],
          existing: {
            insurer: 'Example General Insurance, Fort',
            policyNumber: 'EGI/FIRE/2025/0042',
            fireLines: [],
            fireTotal: '150000000',
          },
        },
      ),
    ).expect(200);
    const file = await request(app)
      .get(`/api/v1/proposals/${id}/rfq?format=xlsx`)
      .set(bearer(manager))
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file.body as ArrayBuffer);
    const schedule = workbook.getWorksheet('schedule')!;
    const rowOf = (text: string, column = 2) => {
      for (let row = 1; row <= schedule.rowCount; row += 1) {
        if (schedule.getCell(row, column).text.trim() === text) return row;
      }
      throw new Error(`No "${text}" row`);
    };

    // C-6: Fire's covers marked in the Option 1 column; Storm left unanswered stays blank.
    expect(schedule.getCell(rowOf('Earthquake'), 4).value).toBe('Required');
    expect(schedule.getCell(rowOf('Terrorism'), 4).value).toBe('Not required');
    expect(schedule.getCell(rowOf('Storm, Tempest, Flood & Inundation'), 4).value).toBeNull();

    // C-1: only the chosen product is shown.
    const product = rowOf('Product to be choosen', 1);
    expect(schedule.getCell(product, 2).value).toBe(
      'Above ₹5 Cr sum insured: Property All Risk (PAR)',
    );
    expect(schedule.getRow(product + 1).hidden).toBe(true);

    // C-3: Burglary is the contents; a 75% first-loss row is added and the others hidden.
    const contents = rowOf('All the contents as per Fire section except building');
    expect(schedule.getCell(contents, 4).value).toBe(51000000);
    const basis = rowOf('Total Sum Insured - Burglary on 1st loss basis 75% of sum insured');
    expect(schedule.getCell(basis, 4).value).toBe(38250000);
    expect(
      schedule.getRow(rowOf('Total Sum Insured - Burglary on 1st loss basis 50% of sum insured'))
        .hidden,
    ).toBe(true);

    // C-2: the Money line in all three columns.
    const cash = rowOf('Cash in safe / counter');
    expect([3, 4, 5].map((column) => schedule.getCell(cash, column).value)).toEqual([
      80000, 100000, 150000,
    ]);

    // C-4: the PAR list holds the chosen add-on only; the other products' lists are hidden.
    const par = workbook.getWorksheet('PAR-Addon')!;
    expect(par.getCell('B2').value).toBe('Waiver of recourse');
    expect(par.getCell('B3').value).toBeNull();
    expect(par.getRow(3).hidden).toBe(true);
    expect(workbook.getWorksheet('SFSP-Addon')!.state).toBe('hidden');
    expect(workbook.getWorksheet('BSUS & BLUS-Addon')!.state).toBe('hidden');
    expect(workbook.worksheets.map((sheet) => sheet.name)).toContain('Fire-Additional Addon');
  });
});
