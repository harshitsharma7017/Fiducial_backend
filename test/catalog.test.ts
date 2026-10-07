import {
  CATALOG_SHEETS,
  OTHER_SECTION_LABELS,
  OTHER_SECTIONS,
  RISK_DETAIL_FIELDS,
  XLSX_CONTENT_TYPE,
  type CatalogMaster,
} from '../src/shared/index.ts';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLogModel } from '../src/modules/audit/audit.model.ts';
import { bearer, createTestApp, tokenFor, useTestDatabase } from './helpers/app.ts';
import { seedMasters } from './helpers/masters.ts';

useTestDatabase();
const app = createTestApp();

let admin: string;
let manager: string;
let readOnly: string;
let clientId: string;
let locationId: string;

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

const SHEET_ROWS: Partial<Record<CatalogMaster, (string | number)[][]>> = {
  products: [
    ['BSUS', 'Bharat Sookshma Udyam Suraksha (BSUS)', '', 50000000, 1, 'Yes', ''],
    ['BLUS', 'Bharat Laghu Udyam Suraksha (BLUS)', 50000000, 500000000, 2, 'Yes', ''],
    ['SFSP', 'Standard Fire & Special Perils Policy (SFSP)', 500000000, '', 3, 'Yes', ''],
    ['PAR', 'Property All Risk (PAR)', 50000000, '', 4, 'Yes', ''],
  ],
  sections: [
    ['FIRE', 'Fire & Allied Perils', 1, 'Yes', 'All Building', 'Earthquake; Terrorism'],
    ...OTHER_SECTIONS.map((code, index) => [
      code,
      code === 'MONEY' ? 'Money Insurance' : OTHER_SECTION_LABELS[code],
      index + 2,
      'Yes',
      '',
      code === 'BURGLARY' ? 'Theft; Riot Strike Malicious Damage' : '',
    ]),
  ],
  addons: [
    ['FIRE_ADDITIONAL', 1, 'Abandonment of Property', '', '', 'Yes'],
    ['PAR', 125, 'Waiver of recourse', '', '', 'Yes'],
    ['SFSP', 1, 'Abandonment of Property', '', '', 'Yes'],
    ['BSUS & BLUS', 1, 'Earth quake', 'PAID', 'Full sum insured', 'Yes'],
    [
      'BSUS & BLUS',
      4,
      'Additions,alterations or extensions',
      'INBUILT',
      '15% of the sum insured',
      'Yes',
    ],
  ],
  'addon-rules': [
    [
      1,
      'Expenses for loss minimisation',
      '5% of claim; max 25 L',
      '5% of claim; max 1 Cr',
      'PCT_OF_SI_BASE',
      1,
      5,
      '',
      2500000,
      10000000,
      'No',
      'Yes',
    ],
    [
      6,
      'Escalation',
      'Selected %, max 25%',
      'Selected %, max 25%',
      'ESCALATION',
      50,
      '',
      25,
      '',
      '',
      'No',
      'Yes',
    ],
  ],
  'tax-rates': [['GST', 18, '2017-07-01', 'Standard rate']],
  notes: [
    [
      'REPLACEMENT_VALUE',
      'Replacement value',
      'Please note that all the assets to be insured to their current replacement values',
      'Yes',
      'Yes',
      'Yes',
      'No',
      1,
      'Yes',
    ],
  ],
};

/** The downloaded workbook with rows filled in on the given sheets (others removed). */
async function workbookWith(rows: Partial<Record<CatalogMaster, (string | number)[][]>>) {
  const response = await request(app)
    .get('/api/v1/catalog/workbook')
    .set(bearer(admin))
    .buffer(true)
    .parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => done(null, Buffer.concat(chunks)));
    })
    .expect(200);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(response.body as ArrayBuffer);
  for (const [master, spec] of Object.entries(CATALOG_SHEETS)) {
    const sheet = workbook.getWorksheet(spec.sheetName);
    if (!sheet) throw new Error(`No ${spec.sheetName} sheet`);
    const values = rows[master as CatalogMaster];
    workbook.removeWorksheet(sheet.id);
    if (!values) continue;
    // A fresh sheet with the downloaded headers, and the test's rows from row 2.
    const fresh = workbook.addWorksheet(spec.sheetName);
    fresh.addRow(spec.columns.map((column) => column.header));
    for (const row of values) fresh.addRow(row);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function upload(file: Buffer, dryRun: boolean, token = admin) {
  return request(app)
    .post(`/api/v1/catalog/import?dryRun=${dryRun}&fileName=masters.xlsx`)
    .set(bearer(token))
    .set('Content-Type', XLSX_CONTENT_TYPE)
    .send(file);
}

async function list(master: CatalogMaster, q = '') {
  const response = await request(app)
    .get(`/api/v1/catalog/${master}${q ? `?q=${encodeURIComponent(q)}` : ''}`)
    .set(bearer(readOnly))
    .expect(200);
  return response.body.items as Array<Record<string, unknown> & { id: string }>;
}

async function newProposal() {
  const response = await request(app)
    .post('/api/v1/proposals')
    .set(bearer(manager))
    .send({ clientId, locationIds: [locationId], dueDate: '2026-12-01' })
    .expect(201);
  return response.body as { id: string; gstRatePercent: string | null };
}

async function rfqSchedule(proposalId: string): Promise<string[]> {
  await request(app)
    .put(`/api/v1/proposals/${proposalId}/data-sheet`)
    .set(bearer(manager))
    .send({
      dueDate: '2026-12-01',
      policyStart: null,
      policyEnd: null,
      locations: [
        {
          locationId,
          fire: [{ key: 'STOCKS', sqFt: null, ratePerSqFt: null, amount: '100000000' }],
          hypothecation: null,
          openStock: null,
          risk: Object.fromEntries(RISK_DETAIL_FIELDS.map((field) => [field.key, null])),
        },
      ],
      fireOption2: [],
      sections: [
        { code: 'BURGLARY', included: true, proposed1: '5000000', proposed2: null },
        { code: 'MONEY', included: false, proposed1: null, proposed2: null },
      ],
      claims: [],
      notes: null,
    })
    .expect(200);
  const file = await request(app)
    .get(`/api/v1/proposals/${proposalId}/rfq`)
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
  const lines: string[] = [];
  for (const sheetName of ['premium details', 'schedule']) {
    workbook.getWorksheet(sheetName)?.eachRow((row) => {
      const cells = (row.values as unknown[]).filter((v) => v !== null && v !== undefined);
      lines.push(
        cells
          .map((v) =>
            typeof v === 'string' || typeof v === 'number' ? String(v) : JSON.stringify(v),
          )
          .join(' | '),
      );
    });
  }
  return lines;
}

beforeAll(async () => {
  await seedMasters();
  admin = (await tokenFor(app, ['ADMIN'])).token;
  manager = (await tokenFor(app, ['ACCOUNT_MANAGER'])).token;
  readOnly = (await tokenFor(app, ['READ_ONLY'])).token;
  const client = await request(app)
    .post('/api/v1/clients')
    .set(bearer(admin))
    .send({
      name: 'Catalog Test Mills',
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

describe('product and cover masters', () => {
  it('checks the workbook first, then replaces each master in the file', async () => {
    const file = await workbookWith(SHEET_ROWS);
    const preview = await upload(file, true).expect(200);
    expect(preview.body).toMatchObject({ dryRun: true, imported: false, fileErrors: [] });
    expect(
      preview.body.sheets.map((s: { master: string; rows: number; issues: unknown[] }) => [
        s.master,
        s.rows,
        s.issues.length,
      ]),
    ).toEqual([
      ['products', 4, 0],
      ['sections', 14, 0],
      ['addons', 5, 0],
      ['addon-rules', 2, 0],
      ['tax-rates', 1, 0],
      ['notes', 1, 0],
    ]);
    expect(await list('products')).toEqual([]);

    const saved = await upload(file, false).expect(200);
    expect(saved.body.imported).toBe(true);
    expect((await list('sections')).map((s) => s.code)).toEqual(['FIRE', ...OTHER_SECTIONS]);
    expect(await AuditLogModel.countDocuments({ action: 'CATALOG_IMPORTED' })).toBe(6);

    // Uploading again replaces, it does not add.
    expect((await upload(file, false).expect(200)).body.imported).toBe(true);
    expect(await list('addons')).toHaveLength(5);

    // The download is the saved masters: uploaded unchanged, it gives the same rows back.
    const strip = (items: Array<Record<string, unknown>>) =>
      items.map(({ id: _id, updatedAt: _at, ...row }) => row);
    const before = await Promise.all(
      (['products', 'sections', 'addons', 'addon-rules', 'tax-rates', 'notes'] as const).map(
        async (master) => strip(await list(master)),
      ),
    );
    const download = await request(app)
      .get('/api/v1/catalog/workbook')
      .set(bearer(admin))
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect((await upload(download.body as Buffer, false).expect(200)).body.imported).toBe(true);
    const after = await Promise.all(
      (['products', 'sections', 'addons', 'addon-rules', 'tax-rates', 'notes'] as const).map(
        async (master) => strip(await list(master)),
      ),
    );
    expect(after).toEqual(before);
  });

  it('saves nothing while any sheet has a problem', async () => {
    const file = await workbookWith({
      sections: [['FIRE', 'Fire', 1, 'No', '', '']],
      addons: [
        ['PAR', 1, 'Waiver of recourse', '', '', 'Yes'],
        ['PAR', 2, 'waiver of  recourse', '', '', 'Yes'],
      ],
      'tax-rates': [['GST', '18%', '01/07/2017', '']],
    });
    const report = await upload(file, false).expect(200);
    expect(report.body.imported).toBe(false);
    const issues = Object.fromEntries(
      report.body.sheets.map((s: { master: string; issues: { message: string }[] }) => [
        s.master,
        s.issues.map((issue) => issue.message),
      ]),
    );
    expect(issues.sections).toContain('Fire cannot be switched off');
    expect(issues.sections).toContain('Add a row for the BURGLARY section');
    expect(issues.addons).toEqual(['Same List and Add-on cover as row 2']);
    expect(issues['tax-rates']).toEqual(['Enter the date as YYYY-MM-DD']);
    expect(await list('addons')).toHaveLength(5);
  });

  it('M-4: a changed range changes the product suggestion', async () => {
    const suggest = async (si: string) =>
      (
        await request(app)
          .get(`/api/v1/catalog/products/suggest?sumInsured=${si}`)
          .set(bearer(readOnly))
          .expect(200)
      ).body.products.map((p: { code: string }) => p.code);
    expect(await suggest('100000000')).toEqual(['BLUS', 'PAR']);

    const bsus = (await list('products')).find((p) => p.code === 'BSUS')!;
    const { id, updatedAt: _updated, ...row } = bsus;
    await request(app)
      .put(`/api/v1/catalog/products/${id}`)
      .set(bearer(admin))
      .send({ ...row, upToSi: '150000000' })
      .expect(200);
    expect(await suggest('100000000')).toEqual(['BSUS', 'BLUS', 'PAR']);
    const proposal = await request(app)
      .post('/api/v1/proposals')
      .set(bearer(manager))
      .send({ clientId, locationIds: [locationId], dueDate: '2026-12-01' })
      .expect(201);
    // Nothing is insured yet, so nothing is suggested.
    expect(proposal.body.suggestedProducts).toEqual([]);
    await request(app)
      .put(`/api/v1/catalog/products/${id}`)
      .set(bearer(admin))
      .send({ ...row })
      .expect(200);
  });

  it('M-5: sections are reordered and switched off, and proposals follow', async () => {
    const sections = await list('sections');
    const ids = sections.map((s) => s.id);
    const money = sections.find((s) => s.code === 'MONEY')!;
    // Money to the top: Fire stays first.
    await request(app)
      .put('/api/v1/catalog/sections/order')
      .set(bearer(admin))
      .send({ ids: [money.id, ...ids.filter((id) => id !== money.id)] })
      .expect(200);
    expect((await list('sections')).slice(0, 3).map((s) => s.code)).toEqual([
      'FIRE',
      'MONEY',
      'BURGLARY',
    ]);
    const plateGlass = sections.find((s) => s.code === 'PLATE_GLASS')!;
    const { id, updatedAt: _u, ...row } = plateGlass;
    await request(app)
      .put(`/api/v1/catalog/sections/${id}`)
      .set(bearer(admin))
      .send({ ...row, active: false })
      .expect(200);

    const proposal = await request(app)
      .post('/api/v1/proposals')
      .set(bearer(manager))
      .send({ clientId, locationIds: [locationId], dueDate: '2026-12-01' })
      .expect(201);
    const codes = proposal.body.sections.map((s: { code: string }) => s.code);
    expect(codes.slice(0, 2)).toEqual(['MONEY', 'BURGLARY']);
    expect(codes).not.toContain('PLATE_GLASS');
    expect(proposal.body.sections[0].name).toBe('Money Insurance');

    // Sections are fixed: none added, codes unchanged.
    await request(app)
      .post('/api/v1/catalog/sections')
      .set(bearer(admin))
      .send({ ...row, code: 'MONEY' })
      .expect(400);
    await request(app)
      .put(`/api/v1/catalog/sections/${id}`)
      .set(bearer(admin))
      .send({ ...row, code: 'EEI' })
      .expect(400);
  });

  it('M-6: add-ons are searchable', async () => {
    expect((await list('addons', 'waiver')).map((a) => a.name)).toEqual(['Waiver of recourse']);
    expect((await list('addons', 'abandonment')).map((a) => a.list)).toEqual([
      'FIRE_ADDITIONAL',
      'SFSP',
    ]);
  });

  it('M-7: the add-on rates keep limits, caps and the formula', async () => {
    const rules = await list('addon-rules');
    expect(rules[0]).toMatchObject({
      seq: 1,
      calcType: 'PCT_OF_SI_BASE',
      rateFactorPct: '1',
      basePct: '5',
      sookshmaCap: '2500000',
      laghuCap: '10000000',
    });
  });

  it('M-8: a proposal keeps the GST rate it was created with', async () => {
    const before = await newProposal();
    expect(before.gstRatePercent).toBe('18');
    await request(app)
      .post('/api/v1/catalog/tax-rates')
      .set(bearer(admin))
      .send({ tax: 'GST', ratePercent: '28', effectiveFrom: today, note: null })
      .expect(201);
    await request(app)
      .post('/api/v1/catalog/tax-rates')
      .set(bearer(admin))
      .send({ tax: 'GST', ratePercent: '28', effectiveFrom: today, note: null })
      .expect(409);
    const after = await newProposal();
    expect(after.gstRatePercent).toBe('28');
    const old = await request(app).get(`/api/v1/proposals/${before.id}`).set(bearer(manager));
    expect(old.body.gstRatePercent).toBe('18');
    expect((await rfqSchedule(before.id)).some((line) => line.startsWith('Add: GST 18%'))).toBe(
      true,
    );
  });

  it('M-9: an edited note is printed on the RFQ, with the masters’ names and add-ons', async () => {
    const note = (await list('notes'))[0]!;
    const { id, updatedAt: _u, ...row } = note;
    await request(app)
      .put(`/api/v1/catalog/notes/${id}`)
      .set(bearer(admin))
      .send({ ...row, text: 'Insure all assets at current replacement value.' })
      .expect(200);
    const proposal = await newProposal();
    const lines = await rfqSchedule(proposal.id);
    expect(lines).toContain('NOTE:');
    expect(
      lines.some((line) => line.startsWith('Insure all assets at current replacement value.')),
    ).toBe(true);
    expect(lines).toContain('Addon coverages | Theft');
    expect(lines).toContain('Riot Strike Malicious Damage');
    expect(lines).toContain('Money Insurance | Not required');
    expect(
      lines.some((line) =>
        line.startsWith('Product to be chosen | Up to ₹5 Cr sum insured: Bharat Sookshma'),
      ),
    ).toBe(true);
  });

  it('lets every role read and only Admins change', async () => {
    await request(app).get('/api/v1/catalog/addons').set(bearer(manager)).expect(200);
    await request(app).post('/api/v1/catalog/notes').set(bearer(manager)).send({}).expect(403);
    await upload(
      await workbookWith({ 'tax-rates': [['GST', 18, '2017-07-01', '']] }),
      true,
      manager,
    ).expect(403);
    const audit = await AuditLogModel.findOne({ action: 'CATALOG_ITEM_UPDATED' }).lean();
    expect(audit?.entity).toBe('catalog_item');
  });
});
