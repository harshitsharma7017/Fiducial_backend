import { OTHER_SECTIONS, RISK_DETAIL_FIELDS, XLSX_CONTENT_TYPE } from '../src/shared/index.ts';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLogModel } from '../src/modules/audit/audit.model.ts';
import { bearer, createTestApp, tokenFor, useTestDatabase } from './helpers/app.ts';
import { seedMasters } from './helpers/masters.ts';

useTestDatabase();
const app = createTestApp();

/** The client's RFQ format, kept in the repository as the reference for this test. */
const CLIENT_RFQ = readFileSync(
  fileURLToPath(new URL('../data/client-formats/Fiducial_RFQ format.xlsx', import.meta.url)),
);

let admin: string;
let manager: string;
let clientId: string;
const locationIds: string[] = [];

const binary = (req: request.Test) =>
  req.buffer(true).parse((res, done) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('end', () => done(null, Buffer.concat(chunks)));
  });

function upload(data: Buffer, token = admin, kind = 'RFQ') {
  return request(app)
    .post(`/api/v1/templates/${kind}?fileName=Fiducial_RFQ%20format.xlsx`)
    .set(bearer(token))
    .set('Content-Type', XLSX_CONTENT_TYPE)
    .send(data);
}

async function load(data: Buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(data as never);
  return workbook;
}

/** The structure that must match the client's file: sheets, merges, formulas, print areas. */
function structure(workbook: ExcelJS.Workbook) {
  return workbook.worksheets.map((sheet) => {
    const formulas: string[] = [];
    sheet.eachRow((row) =>
      row.eachCell((cell) => {
        const value = cell.value;
        if (value && typeof value === 'object' && 'formula' in value)
          formulas.push(`${cell.address}=${String(value.formula)}`);
      }),
    );
    return {
      name: sheet.name,
      merges: [...((sheet.model as { merges?: string[] }).merges ?? [])].sort(),
      formulas: formulas.map((formula) => formula.replace(/\*0\.18$/, '*GST')),
      printArea: sheet.pageSetup.printArea ?? null,
      widths: sheet.columns.map((column) => column.width ?? null),
      images: sheet.getImages().length,
    };
  });
}

interface SheetOptions {
  manyItems?: boolean;
  /** B5: Money is required (the default) or marked not required, keeping its figures. */
  moneyIncluded?: boolean;
  /** D1: buildings to add per location, by location index. */
  buildings?: Record<
    number,
    { name: string; sqFt?: string; ratePerSqFt?: string; amount?: string }[]
  >;
}

async function proposal(options: SheetOptions = {}) {
  const created = await request(app)
    .post('/api/v1/proposals')
    .set(bearer(manager))
    .send({
      clientId,
      locationIds: options.manyItems ? locationIds : [locationIds[0]],
      dueDate: '2026-12-01',
      policyStart: '2026-12-01',
      policyEnd: '2027-11-30',
    })
    .expect(201);
  await saveDataSheet(created.body.id as string, options);
  return created.body.id as string;
}

function saveDataSheet(id: string, options: SheetOptions = {}) {
  const item = (n: number) => ({
    description: `Item ${n}`,
    quantity: '',
    dimensions: '',
    makeModel: 'Make',
    serialNo: `S${n}`,
    year: '2021',
    sumInsured: String(n * 100000),
  });
  return request(app)
    .put(`/api/v1/proposals/${id}/data-sheet`)
    .set(bearer(manager))
    .send({
      dueDate: '2026-12-01',
      policyStart: '2026-12-01',
      policyEnd: '2027-11-30',
      locations: (options.manyItems ? locationIds : [locationIds[0]]).map((locationId, index) => ({
        locationId,
        // D1: buildings per location when the test provides them.
        buildings: (options.buildings?.[index] ?? []).map((building) => ({
          name: building.name,
          sqFt: building.sqFt ?? '',
          ratePerSqFt: building.ratePerSqFt ?? '',
          amount: building.amount ?? '',
        })),
        fire: [
          { key: 'STOCKS', sqFt: null, ratePerSqFt: null, amount: '50000000' },
          ...(options.manyItems
            ? [{ key: 'OTHER', sqFt: null, ratePerSqFt: null, amount: '750000' }]
            : []),
        ],
        hypothecation: null,
        openStock: null,
        risk: Object.fromEntries(RISK_DETAIL_FIELDS.map((f) => [f.key, `${f.label} answer`])),
      })),
      fireOption2: [],
      sections: OTHER_SECTIONS.map((code) => ({
        code,
        included:
          (code === 'MONEY' && options.moneyIncluded !== false) ||
          (options.manyItems === true && code === 'EEI'),
        proposed1: code === 'MONEY' ? '600000' : null,
        proposed2: null,
        lines: code === 'MONEY' ? { cashInSafe: '100000' } : {},
        annexure: options.manyItems && code === 'EEI' ? [1, 2, 3, 4, 5].map(item) : [],
      })),
      claims: [],
      notes: null,
    })
    .expect(200);
}

function rfq(id: string, format: 'xlsx' | 'pdf') {
  return binary(
    request(app).get(`/api/v1/proposals/${id}/rfq?format=${format}`).set(bearer(manager)),
  );
}

beforeAll(async () => {
  await seedMasters();
  admin = (await tokenFor(app, ['ADMIN'])).token;
  manager = (await tokenFor(app, ['ACCOUNT_MANAGER'])).token;
  const client = await request(app)
    .post('/api/v1/clients')
    .set(bearer(admin))
    .send({
      name: 'Template Test Mills',
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
  for (const name of ['Plant 1', 'Plant 2', 'Plant 3']) {
    const location = await request(app)
      .post(`/api/v1/clients/${clientId}/locations`)
      .set(bearer(admin))
      .send({
        name,
        line1: 'Plot 1',
        line2: null,
        city: 'Mumbai',
        pincode: '400001',
        occupancyCode: null,
      })
      .expect(201);
    locationIds.push(location.body.id as string);
  }
});

describe('document templates and the RFQ (R-3, R-4)', () => {
  it('uses the built-in layout until the client’s RFQ template is uploaded', async () => {
    const id = await proposal();
    const xlsx = await rfq(id, 'xlsx').expect(200);
    expect(xlsx.headers['x-document-layout']).toBe('built-in');
    const pdf = await rfq(id, 'pdf').expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['x-document-layout']).toBe('built-in');
  });

  it('checks an upload before keeping it, and only Admins upload', async () => {
    const notExcel = await upload(Buffer.from('not a workbook')).expect(200);
    expect(notExcel.body).toMatchObject({ saved: false, check: { ok: false } });
    const blank = new ExcelJS.Workbook();
    blank.addWorksheet('Sheet1');
    const wrong = await upload(Buffer.from(await blank.xlsx.writeBuffer())).expect(200);
    expect(wrong.body.saved).toBe(false);
    expect(wrong.body.check.problems).toContain('The "schedule" sheet is missing.');
    await upload(CLIENT_RFQ, manager).expect(403);

    const saved = await upload(CLIENT_RFQ).expect(200);
    expect(saved.body).toMatchObject({
      saved: true,
      check: { ok: true, problems: [], letterhead: { logo: true } },
      template: { kind: 'RFQ', fileName: 'Fiducial_RFQ format.xlsx' },
    });
    expect(saved.body.check.letterhead.address).toMatch(
      /^Fiducial Insurance Brokers India Pvt Ltd/,
    );
    expect(
      await AuditLogModel.countDocuments({ action: 'TEMPLATE_UPLOADED', entityId: 'RFQ' }),
    ).toBe(1);
    const list = await request(app).get('/api/v1/templates').set(bearer(manager)).expect(200);
    expect(
      list.body.items.map((i: { kind: string; filled: boolean }) => [i.kind, i.filled]),
    ).toEqual([
      ['RFQ', true],
      ['QCR', true],
      ['PLACEMENT_SLIP', true],
    ]);
    const file = await binary(
      request(app).get('/api/v1/templates/RFQ/file').set(bearer(manager)),
    ).expect(200);
    expect(Buffer.compare(file.body as Buffer, CLIENT_RFQ)).toBe(0);
  });

  it('R-3: fills the template with the client’s sheets, merges, formulas, print areas and logo', async () => {
    const id = await proposal();
    const response = await rfq(id, 'xlsx').expect(200);
    expect(response.headers['x-document-layout']).toBe('template');
    const filled = await load(response.body as Buffer);
    const original = await load(CLIENT_RFQ);
    // Side by side with the client's file, the structure is identical.
    expect(structure(filled)).toEqual(structure(original));
    const zip = await JSZip.loadAsync(response.body as Buffer);
    expect(
      Object.keys(zip.files).filter((name) => name.startsWith('xl/media/') && !name.endsWith('/')),
    ).toHaveLength(1);

    const schedule = filled.getWorksheet('schedule')!;
    expect(schedule.getCell('B3').value).toBe('Template Test Mills');
    expect(schedule.getCell('B4').value).toBe('27AAPFU0939F1ZV');
    expect(schedule.getCell('B7').value).toBe('01 Dec 2026 to 30 Nov 2027');
    expect(schedule.getCell('D17').value).toBe(50000000);
    expect(schedule.getCell('D18').value).toBe(50000000);
    expect(schedule.getCell('D56').value).toBe(100000);
    // B5: a section marked not required (Burglary here) is omitted — its row is hidden, never
    // shown as "Not required".
    expect(schedule.getCell('D28').value).not.toBe('Not required');
    expect(schedule.getRow(28).hidden).toBe(true);
    // The client's working notes beside the print area are not sent to insurers.
    expect(schedule.getCell('F6').value).toBeNull();
    const premium = filled.getWorksheet('premium details')!;
    expect(premium.getCell('A1').value).toBe('RFQ FOR NEW BUSINESS 2026-27');
    // Money's sum insured is its cash in safe + single carrying limit (here the safe alone).
    expect(premium.getCell('D14').value).toBe(100000);
    expect(premium.getCell('C24').value).toMatchObject({ formula: 'C23*0.18' });
    // B5: in the premium table only Fire and the required Money are shown; every other section's
    // row is hidden, never written as "Not required". The GST and Total formulas stay as they were.
    const premiumRows = Array.from({ length: 14 }, (_, index) => 9 + index);
    expect(premiumRows.filter((row) => !premium.getRow(row).hidden)).toEqual([9, 14]);
    expect(premium.getCell('A9').text.trim()).toBe('Fire');
    expect(premium.getCell('D9').value).toBe(50000000);
    for (const row of premiumRows) expect(premium.getCell(row, 4).value).not.toBe('Not required');
    expect(JSON.stringify(premium.getSheetValues())).not.toContain('Not required');
    expect(premium.getCell('C25').value).toMatchObject({ formula: 'SUM(C23:C24)' });
    const risk = filled.getWorksheet('risk details')!;
    expect(risk.getCell('D2').value).toBe('Plant 1');
    expect(risk.getCell('D3').value).toBe('Fire fighting arrangement answer');
    expect(risk.getCell('E3').value).toBeNull();
    expect(risk.getCell('C1').value).toBeNull();
  });

  it('B5: marking a section not required hides its premium row and keeps its figures; marking it required again shows it', async () => {
    const id = await proposal();
    const premiumOf = async () =>
      (await load((await rfq(id, 'xlsx').expect(200)).body as Buffer)).getWorksheet(
        'premium details',
      )!;
    expect((await premiumOf()).getRow(14).hidden).toBeFalsy();

    await saveDataSheet(id, { moneyIncluded: false });
    const hidden = await premiumOf();
    expect(hidden.getRow(14).hidden).toBe(true);
    expect(hidden.getCell('D14').value).not.toBe('Not required');
    expect(hidden.getRow(9).hidden).toBeFalsy();
    // Nothing is deleted: Money keeps its figures while it is not required.
    const record = await request(app)
      .get(`/api/v1/proposals/${id}`)
      .set(bearer(manager))
      .expect(200);
    const money = (
      record.body.sections as Array<{ code: string; included: boolean; proposed1: string | null }>
    ).find((section) => section.code === 'MONEY');
    expect(money).toMatchObject({ included: false, proposed1: '100000' });

    await saveDataSheet(id, { moneyIncluded: true });
    const shown = await premiumOf();
    expect(shown.getRow(14).hidden).toBeFalsy();
    expect(shown.getCell('D14').value).toBe(100000);
    // The PDF is drawn from the same workbook: the hidden row is not printed.
    const pdf = await rfq(id, 'pdf').expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
  });

  it('adds rows only where the case needs them, moving merges and the print area with them', async () => {
    const id = await proposal({ manyItems: true });
    const filled = await load((await rfq(id, 'xlsx').expect(200)).body as Buffer);
    const schedule = filled.getWorksheet('schedule')!;
    // A seventh Fire line for "Any other items", and the notes stay above the broker's footer.
    expect(schedule.getCell('A18').value).toBe('7');
    expect(schedule.getCell('D18').value).toBe(2250000);
    expect(schedule.getCell('D19').value).toBe(152250000);
    expect(schedule.pageSetup.printArea).toBe('A1:E139');
    expect(schedule.getCell('A139').text).toMatch(/^Fiducial Insurance Brokers/);
    expect((schedule.model as { merges: string[] }).merges).toContain('A139:E139');
    // EEI's "As per Annexure" spans the figure columns: the total joins it, the merge stays.
    expect(schedule.getCell('B79').value).toBe('As per Annexure — Option 1 ₹15,00,000');
    expect((schedule.model as { merges: string[] }).merges).toContain('B79:D79');
    // B5: a section marked not required is omitted — its row is hidden, never "Not required".
    expect(schedule.getCell('B84').value).not.toBe('Not required');
    expect(schedule.getRow(84).hidden).toBe(true);
    // EEI: five items in a grid of three rows.
    const annexure = filled.getWorksheet('Annexure')!;
    const eei = [19, 20, 21, 22, 23].map((row) => [
      annexure.getCell(row, 1).value,
      annexure.getCell(row, 2).value,
      annexure.getCell(row, 7).value,
    ]);
    expect(eei).toEqual([1, 2, 3, 4, 5].map((n) => [n, `Item ${n}`, n * 100000]));
    expect(annexure.getCell('A24').value).toBe(
      'Mechanical Breakdown (MBD) (for electrical / mechanical based equipments)',
    );
    // Three locations: a third column on the risk details.
    expect(filled.getWorksheet('risk details')!.getCell('F2').value).toBe('Plant 3');
  });

  it('R-4: the PDF is A4 on every page, with the template’s layout', async () => {
    const id = await proposal({ manyItems: true });
    const response = await rfq(id, 'pdf').expect(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.headers['content-disposition']).toMatch(/filename="RFQ-PRP-\d{4}-\d{4}\.pdf"/);
    const pdf = (response.body as Buffer).toString('latin1');
    expect(pdf.startsWith('%PDF-')).toBe(true);
    const boxes = [...pdf.matchAll(/\/MediaBox \[([^\]]+)\]/g)].map((match) => match[1]);
    expect(boxes.length).toBeGreaterThan(3);
    expect(new Set(boxes)).toEqual(new Set(['0 0 595.28 841.89']));
    expect(pdf).toMatch(/\/Subtype \/Image/);
    const audit = await AuditLogModel.findOne({ action: 'RFQ_DOWNLOADED', entityId: id })
      .sort({ at: -1 })
      .lean();
    expect(audit?.after).toMatchObject({ format: 'pdf' });
  });

  it('D1: itemises each building under the Building line of the client RFQ template', async () => {
    await upload(CLIENT_RFQ).expect(200);
    // Two locations: Plant 1 has a typed building and an area × rate building plus a compound
    // wall; Plant 2 has one building and a zero-valued building (kept, as the Data Sheet does).
    const id = await proposal({
      manyItems: true,
      buildings: {
        0: [
          { name: 'Main block', amount: '5000000' },
          { name: 'Warehouse', sqFt: '2000', ratePerSqFt: '1500' },
        ],
        1: [
          { name: 'Shed A', amount: '250000' },
          { name: 'Empty shed', amount: '0' },
        ],
      },
    });
    const filled = await load((await rfq(id, 'xlsx').expect(200)).body as Buffer);
    const schedule = filled.getWorksheet('schedule')!;
    const rows: [unknown, unknown, unknown][] = [];
    schedule.eachRow((row) =>
      rows.push([row.getCell(2).value, row.getCell(4).value, row.getCell(5).value]),
    );
    const descriptions = rows.map((row) => (typeof row[0] === 'string' ? row[0] : ''));
    const buildingLine = descriptions.findIndex((text) => text.startsWith('All Building'));
    expect(buildingLine).toBeGreaterThanOrEqual(0);
    // The Building line keeps the group total (buildings 82.5 L + 50,000 stocks? no: + nothing
    // else here; the group is 3 buildings 8,250,000). Plant 1 buildings 8,000,000, Plant 2 250,000.
    expect(rows[buildingLine]?.[1]).toBe(8250000);
    // Immediately beneath it, each building is an indented sub-row with its location and own SI.
    expect(rows[buildingLine + 1]).toEqual(['Plant 1: Main block', 5000000, null]);
    expect(rows[buildingLine + 2]).toEqual(['Plant 1: Warehouse', 3000000, null]);
    expect(rows[buildingLine + 3]).toEqual(['Plant 2: Shed A', 250000, null]);
    // A zero-valued building is still listed (0 shows as null/0 in the figure cell, name kept).
    expect(rows[buildingLine + 4]?.[0]).toBe('Plant 2: Empty shed');
    // The next real Fire line (Furniture) follows the building sub-rows — nothing is dropped.
    expect(descriptions[buildingLine + 5]?.startsWith('Furniture')).toBe(true);
    // The Fire total is unchanged and authoritative (from the record), not a sum of the sub-rows
    // — so itemising buildings never double-counts. manyItems = 3 locations: STOCKS 50,000,000 × 3
    // + OTHER 750,000 × 3 + buildings 8,250,000.
    const record = (
      await request(app).get(`/api/v1/proposals/${id}`).set(bearer(manager)).expect(200)
    ).body;
    // STOCKS 50,000,000 × 3 + OTHER 750,000 × 3 + buildings 8,250,000 = 160,500,000.
    expect(record.fire.proposed1).toBe('160500000');
    const totalLine = descriptions.findIndex((text) => text.startsWith('Total Sum Insured - Fire'));
    expect(rows[totalLine]?.[1]).toBe(160500000);
  });

  it('D1: one building at one location is itemised with no location prefix', async () => {
    await upload(CLIENT_RFQ).expect(200);
    const id = await proposal({ buildings: { 0: [{ name: 'Main block', amount: '4000000' }] } });
    const filled = await load((await rfq(id, 'xlsx').expect(200)).body as Buffer);
    const schedule = filled.getWorksheet('schedule')!;
    const rows: [unknown, unknown][] = [];
    schedule.eachRow((row) => rows.push([row.getCell(2).value, row.getCell(4).value]));
    const buildingLine = rows.findIndex(
      (row) => typeof row[0] === 'string' && row[0].startsWith('All Building'),
    );
    // Single location: the building name has no location prefix.
    expect(rows[buildingLine + 1]).toEqual(['Main block', 4000000]);
    expect(rows[buildingLine]?.[1]).toBe(4000000);
  });
});
