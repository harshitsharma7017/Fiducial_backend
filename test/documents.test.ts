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

async function proposal(options: { manyItems?: boolean } = {}) {
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
  const item = (n: number) => ({
    description: `Item ${n}`,
    quantity: '',
    dimensions: '',
    makeModel: 'Make',
    serialNo: `S${n}`,
    year: '2021',
    sumInsured: String(n * 100000),
  });
  await request(app)
    .put(`/api/v1/proposals/${created.body.id as string}/data-sheet`)
    .set(bearer(manager))
    .send({
      dueDate: '2026-12-01',
      policyStart: '2026-12-01',
      policyEnd: '2027-11-30',
      locations: (options.manyItems ? locationIds : [locationIds[0]]).map((locationId) => ({
        locationId,
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
        included: code === 'MONEY' || (options.manyItems === true && code === 'EEI'),
        proposed1: code === 'MONEY' ? '600000' : null,
        proposed2: null,
        lines: code === 'MONEY' ? { cashInSafe: '100000' } : {},
        annexure: options.manyItems && code === 'EEI' ? [1, 2, 3, 4, 5].map(item) : [],
      })),
      claims: [],
      notes: null,
    })
    .expect(200);
  return created.body.id as string;
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
    expect(schedule.getCell('D28').value).toBe('Not required');
    // The client's working notes beside the print area are not sent to insurers.
    expect(schedule.getCell('F6').value).toBeNull();
    const premium = filled.getWorksheet('premium details')!;
    expect(premium.getCell('A1').value).toBe('RFQ FOR NEW BUSINESS 2026-27');
    expect(premium.getCell('D14').value).toBe(600000);
    expect(premium.getCell('C24').value).toMatchObject({ formula: 'C23*0.18' });
    const risk = filled.getWorksheet('risk details')!;
    expect(risk.getCell('D2').value).toBe('Plant 1');
    expect(risk.getCell('D3').value).toBe('Fire fighting arrangement answer');
    expect(risk.getCell('E3').value).toBeNull();
    expect(risk.getCell('C1').value).toBeNull();
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
    expect(schedule.getCell('B84').value).toBe('Not required');
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
});
