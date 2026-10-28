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
import mongoose from 'mongoose';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLogModel } from '../src/modules/audit/audit.model.ts';
import { MemoryCloudStore } from '../src/modules/cloud-storage/cloud-store.ts';
import { NOTE_FILL_ARGB } from '../src/modules/documents/document-theme.ts';
import { cellText } from '../src/modules/documents/excel-template.ts';
import { UserModel } from '../src/modules/users/user.model.ts';
import { bearer, createTestApp, tokenFor, useTestDatabase } from './helpers/app.ts';
import { seedMasters } from './helpers/masters.ts';
import { approveRfq } from './helpers/rfq.ts';

// The client's review of 27 Oct 2026: a third proposed Fire option, add-on covers added on the
// case, the RFQ's totals with and without terrorism and no note section, ticks for the covers
// asked for, and the QCR's policy name, highlighted notes under the recommendation and its
// "Prepared By".

useTestDatabase();
const store = new MemoryCloudStore();
const app = createTestApp({}, undefined, undefined, undefined, store);

const CLIENT_RFQ = readFileSync(
  fileURLToPath(new URL('../data/client-formats/Fiducial_RFQ format.xlsx', import.meta.url)),
);
const CLIENT_QCR = readFileSync(
  fileURLToPath(new URL('../data/client-formats/Fiducial_QCR format.xlsx', import.meta.url)),
);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
const CR = 10_000_000;
const NOTE = 'Insure all assets at their current replacement value.';

let admin: string;
let manager: string;
let managerName: string;
let approver: string;
let readOnly: string;
let caseId: string;
let locationId: string;
const insurers: string[] = [];

const SHEET_ROWS: Partial<Record<CatalogMaster, (string | number)[][]>> = {
  products: [
    ['BSUS', 'Bharat Sookshma Udyam Suraksha (BSUS)', '', 5 * CR, 1, 'Yes', '', ''],
    ['BLUS', 'Bharat Laghu Udyam Suraksha (BLUS)', 5 * CR, 50 * CR, 2, 'Yes', '', ''],
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
    ]),
  ],
  notes: [['N1', 'Values', NOTE, 'No', 'Yes', 'Yes', 'Yes', 1, 'Yes']],
};

const binary = (req: request.Test) =>
  req.buffer(true).parse((res, done) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('end', () => done(null, Buffer.concat(chunks)));
  });

async function workbookOf(path: string): Promise<ExcelJS.Workbook> {
  const file = await binary(request(app).get(path).set(bearer(manager))).expect(200);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(file.body as ArrayBuffer);
  return workbook;
}

function rowsOf(sheet: ExcelJS.Worksheet, column = 1): { row: number; text: string }[] {
  // cellText: a hidden row left as an empty merged range has no text (exceljs's .text throws).
  return Array.from({ length: sheet.rowCount }, (_, index) => ({
    row: index + 1,
    text: cellText(sheet.getCell(index + 1, column)).trim(),
  }));
}

function rowOf(sheet: ExcelJS.Worksheet, text: string, column = 1): number {
  const found = rowsOf(sheet, column).find((line) => line.text === text);
  if (!found) throw new Error(`No "${text}" row`);
  return found.row;
}

async function upload(kind: 'RFQ' | 'QCR', data: Buffer) {
  await request(app)
    .post(`/api/v1/templates/${kind}?fileName=${kind}.xlsx`)
    .set(bearer(admin))
    .set('Content-Type', XLSX_CONTENT_TYPE)
    .send(data)
    .expect(200);
}

async function quote(insurerId: string, option: string, fire: string, money: string) {
  const pdf = await request(app)
    .post(`/api/v1/proposals/${caseId}/insurers/${insurerId}/quote-attachments?fileName=q.pdf`)
    .set(bearer(manager))
    .set('Content-Type', 'application/pdf')
    .send(PDF)
    .expect(201);
  await request(app)
    .post(`/api/v1/proposals/${caseId}/insurers/${insurerId}/quotes`)
    .set(bearer(manager))
    .send({
      option,
      sections: [
        { code: 'FIRE', sumInsured: null, premium: fire, premiumWithoutTerrorism: null },
        { code: 'MONEY', sumInsured: null, premium: money },
      ],
      attachmentIds: [pdf.body.id],
    })
    .expect(201);
}

beforeAll(async () => {
  await seedMasters();
  admin = (await tokenFor(app, ['ADMIN'])).token;
  const staff = await tokenFor(app, ['ACCOUNT_MANAGER']);
  manager = staff.token;
  managerName = (await UserModel.findById(staff.user.id, { name: 1 }).lean())?.name ?? '';
  approver = (await tokenFor(app, ['MANAGER'])).token;
  readOnly = (await tokenFor(app, ['READ_ONLY'])).token;

  const catalog = new ExcelJS.Workbook();
  for (const [master, rows] of Object.entries(SHEET_ROWS)) {
    const spec = CATALOG_SHEETS[master as CatalogMaster];
    const sheet = catalog.addWorksheet(spec.sheetName);
    sheet.addRow(spec.columns.map((column) => column.header));
    for (const row of rows) sheet.addRow(row);
  }
  const imported = await request(app)
    .post('/api/v1/catalog/import?dryRun=false&fileName=masters.xlsx')
    .set(bearer(admin))
    .set('Content-Type', XLSX_CONTENT_TYPE)
    .send(Buffer.from(await catalog.xlsx.writeBuffer()));
  expect(imported.body.imported).toBe(true);

  const client = await request(app)
    .post('/api/v1/clients')
    .set(bearer(admin))
    .send({
      name: 'Review Test Mills',
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
  const location = await request(app)
    .post(`/api/v1/clients/${client.body.id as string}/locations`)
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
  for (const branch of ['Fort', 'Andheri']) {
    const insurer = await request(app)
      .post('/api/v1/insurers')
      .set(bearer(admin))
      .send({
        company: 'Test General',
        branch,
        contacts: [],
        rfqEmails: [`${branch}@insurer.example`],
      })
      .expect(201);
    insurers.push(insurer.body.id as string);
  }
  const created = await request(app)
    .post('/api/v1/proposals')
    .set(bearer(manager))
    .send({
      type: 'NEW',
      clientId: client.body.id,
      locationIds: [locationId],
      dueDate: '2026-11-20',
      policyStart: '2026-12-01',
      policyEnd: '2027-11-30',
    })
    .expect(201);
  caseId = created.body.id as string;
  await request(app)
    .put(`/api/v1/proposals/${caseId}/data-sheet`)
    .set(bearer(manager))
    .send({
      dueDate: '2026-11-20',
      policyStart: '2026-12-01',
      policyEnd: '2027-11-30',
      locations: [
        {
          locationId,
          fire: [
            { key: 'STOCKS', sqFt: null, ratePerSqFt: null, amount: '60000000' },
            { key: 'FFF', sqFt: null, ratePerSqFt: null, amount: '1000000' },
          ],
          hypothecation: null,
          openStock: null,
          risk: Object.fromEntries(RISK_DETAIL_FIELDS.map((field) => [field.key, null])),
        },
      ],
      fireOption2: [{ group: 'STOCKS', amount: '70000000' }],
      fireOption3: [
        { group: 'STOCKS', amount: '80000000' },
        { group: 'FFF', amount: '1500000' },
      ],
      // Earthquake from the master, and a cover the master does not list, added on the case.
      fireCovers: [
        { name: 'Earthquake', required: true },
        { name: 'Terrorism', required: false },
        { name: 'Loss of rent', required: true },
      ],
      product: { code: 'BLUS', reason: null },
      sections: OTHER_SECTIONS.map((code) => ({
        code,
        included: code === 'MONEY',
        proposed1: code === 'MONEY' ? '500000' : null,
        proposed2: null,
      })),
      claims: [],
      notes: 'Please quote with and without terrorism.',
    })
    .expect(200);
  await request(app)
    .put(`/api/v1/proposals/${caseId}/insurers`)
    .set(bearer(manager))
    .send({ insurerIds: insurers })
    .expect(200);
});

describe('a third proposed Fire option and covers added on the case', () => {
  it('keeps Option 3 by Fire line and asks insurers to quote it', async () => {
    const record = await request(app)
      .get(`/api/v1/proposals/${caseId}`)
      .set(bearer(manager))
      .expect(200);
    expect(record.body.fire).toMatchObject({
      proposed1: '61000000',
      proposed2: '70000000',
      proposed3: '81500000',
    });
    const stocks = (record.body.fire.groups as { group: string; proposed3: string | null }[]).find(
      (line) => line.group === 'STOCKS',
    );
    expect(stocks?.proposed3).toBe('80000000');
    // The cover added on the case is kept after the master's.
    expect(record.body.fire.covers).toEqual([
      { name: 'Earthquake', required: true },
      { name: 'Storm, Tempest, Flood & Inundation', required: null },
      { name: 'Terrorism', required: false },
      { name: 'Loss of rent', required: true },
    ]);
  });

  it('prints Option 3 on the RFQ, ticks the covers, totals with and without terrorism, no notes', async () => {
    await upload('RFQ', CLIENT_RFQ);
    const workbook = await workbookOf(`/api/v1/proposals/${caseId}/rfq?format=xlsx`);

    const premium = workbook.getWorksheet('premium details')!;
    const caption = rowsOf(premium, 4).find((line) =>
      line.text.startsWith('Quote Option 3: For Proposed Sum Insured Option 3'),
    );
    expect(caption).toBeDefined();
    expect(premium.getRow(caption!.row).hidden).toBeFalsy();
    const fire3 = rowsOf(premium).find((line) => line.row > caption!.row && line.text === 'Fire');
    expect(premium.getCell(fire3!.row, 4).value).toBe(81500000);
    // Money is quoted at its Option 1 figure in Option 3.
    const money3 = rowsOf(premium).find((line) => line.row > caption!.row && line.text === 'Money');
    expect(premium.getCell(money3!.row, 4).value).toBe(500000);
    // Every block quoted ends with the totals with terrorism, then without.
    const labels = rowsOf(premium)
      .filter((line) => !premium.getRow(line.row).hidden)
      .map((line) => line.text);
    expect(labels.filter((text) => text === 'With Terrorism')).toHaveLength(3);
    expect(labels.filter((text) => text === 'Without Terrorism')).toHaveLength(3);
    // The template's print area stopped above its third block: it reaches it now.
    const area = /:[A-Z]+(\d+)$/.exec(premium.pageSetup.printArea ?? '');
    expect(Number(area?.[1])).toBeGreaterThan(caption!.row + 20);

    const schedule = workbook.getWorksheet('schedule')!;
    const header = rowOf(schedule, 'S No');
    // Every line of the RFQ is bold (client review, 28 Oct 2026).
    expect(schedule.getCell(rowOf(schedule, 'Insured Name'), 2).font.bold).toBe(true);
    expect(schedule.getCell(header, 6).value).toBe('Proposed Sum Insured - Option 3');
    expect(schedule.pageSetup.printArea).toMatch(/^A1:F\d+$/);
    const stocks = rowsOf(schedule, 2).find((line) => line.text.startsWith('All types of stock'));
    expect([4, 5, 6].map((column) => schedule.getCell(stocks!.row, column).value)).toEqual([
      60000000, 70000000, 80000000,
    ]);
    // Fire's covers asked for: a green tick in each option column, including the case's own.
    for (const cover of ['Earthquake', 'Loss of rent']) {
      const row = rowOf(schedule, cover, 2);
      expect(schedule.getRow(row).hidden).toBeFalsy();
      expect([4, 5, 6].map((column) => schedule.getCell(row, column).value)).toEqual([
        '✓',
        '✓',
        '✓',
      ]);
    }
    expect(JSON.stringify(schedule.getSheetValues())).not.toContain('Required');
    // No note section on the RFQ.
    expect(rowsOf(schedule).map((line) => line.text)).not.toContain('NOTE:');
    expect(JSON.stringify(schedule.getSheetValues())).not.toContain(NOTE);
    // The Fire lines shown are numbered 1, 2… in order, centred.
    const fireLines = rowsOf(schedule).filter(
      (line) => line.row > header + 1 && line.row < stocks!.row + 1 && /^\d+$/.test(line.text),
    );
    const shown = fireLines.filter((line) => !schedule.getRow(line.row).hidden);
    expect(shown.map((line) => line.text)).toEqual(shown.map((_, index) => String(index + 1)));
    expect(schedule.getCell(shown[0]!.row, 1).alignment.horizontal).toBe('center');

    const pdf = await binary(
      request(app).get(`/api/v1/proposals/${caseId}/rfq?format=pdf`).set(bearer(manager)),
    ).expect(200);
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
  });
});

describe('the QCR (client review, 27 Oct 2026)', () => {
  beforeAll(async () => {
    await approveRfq(app, caseId, manager, approver);
    await request(app)
      .post(`/api/v1/proposals/${caseId}/rfq/sent`)
      .set(bearer(manager))
      .send({ insurerIds: insurers })
      .expect(200);
    await quote(insurers[0]!, 'P1', '100000', '1500');
    await quote(insurers[0]!, 'P3', '130000', '1500');
    await quote(insurers[1]!, 'P3', '125000', '1200');
    await request(app)
      .put(`/api/v1/proposals/${caseId}/qcr`)
      .set(bearer(manager))
      .send({
        recommendedInsurerId: insurers[1],
        recommendedOption: 'P3',
        recommendation: 'Lowest premium for the higher stock value',
        remarks: null,
        paymentInFavourOf: 'Test General Insurance Co Ltd',
      })
      .expect(200);
  });

  it('compares Option 3', async () => {
    const qcr = await request(app)
      .get(`/api/v1/proposals/${caseId}/qcr`)
      .set(bearer(manager))
      .expect(200);
    const option3 = (qcr.body.options as { option: string; quotes: unknown[] }[]).find(
      (option) => option.option === 'P3',
    );
    expect(option3?.quotes).toHaveLength(2);
  });

  it('built-in layout: the policy name, the notes highlighted under the recommendation, Prepared By', async () => {
    const workbook = await workbookOf(`/api/v1/proposals/${caseId}/qcr/document?format=xlsx`);
    const premium = workbook.getWorksheet('premium details')!;
    const policy = rowOf(premium, 'Policy Name:');
    expect(premium.getCell(policy, 2).value).toBe('Bharat Laghu Udyam Suraksha (BLUS)');
    // Client review, 28 Oct 2026: boxed like the client's formats, every line bold, headings in
    // white on navy.
    expect(premium.getCell(policy, 1).border.top?.style).toBe('thin');
    expect(premium.getCell(policy, 2).font.bold).toBe(true);
    expect(premium.getCell(1, 1).fill).toMatchObject({ fgColor: { argb: 'FF12285E' } });
    expect(premium.getCell(1, 1).font.color?.argb).toBe('FFFFFFFF');
    const recommendation = rowOf(premium, 'Our recommendation:');
    const note = rowOf(premium, 'NOTE:');
    expect(note).toBe(recommendation + 1);
    expect(premium.getCell(note, 1).fill).toMatchObject({ fgColor: { argb: NOTE_FILL_ARGB } });
    const notes = [note + 1, note + 2, note + 3].map((row) => premium.getCell(row, 1).text);
    expect(notes).toEqual([
      'Notes for the insurers: Please quote with and without terrorism.',
      NOTE,
      '',
    ]);
    expect(rowsOf(workbook.getWorksheet('schedule')!).map((line) => line.text)).not.toContain(
      'NOTE:',
    );
    const last = workbook.worksheets.at(-1)!;
    expect(rowsOf(last).map((line) => line.text)).toContain(`Prepared By: ${managerName}`);
  });

  it('client’s template: policy name on page 1, highlighted notes below the payment and recommendation, Option 3 block, Prepared By', async () => {
    await upload('QCR', CLIENT_QCR);
    const workbook = await workbookOf(`/api/v1/proposals/${caseId}/qcr/document?format=xlsx`);
    const premium = workbook.getWorksheet('premium details')!;
    expect(premium.getCell('A4').value).toBe('Policy Name: Bharat Laghu Udyam Suraksha (BLUS)');
    const caption = rowsOf(premium, 4).find((line) =>
      line.text.startsWith('Quote Option 3: For Proposed Sum Insured Option 3'),
    );
    expect(premium.getRow(caption!.row).hidden).toBeFalsy();

    const payment = rowsOf(premium).find((line) => line.text.startsWith('Cheque / payment'))!;
    expect(premium.getCell(payment.row + 1, 1).text).toMatch(/^Our recommendation: /);
    const note = payment.row + 2;
    expect(premium.getCell(note, 1).value).toBe('NOTE:');
    expect(premium.getCell(note, 1).fill).toMatchObject({ fgColor: { argb: NOTE_FILL_ARGB } });
    const lines = [1, 2, 3].map((offset) => premium.getCell(note + offset, 1).text);
    expect(lines[0]).toMatch(/^\*New \/ Renewal Quote is given as per recommended coverage/);
    expect(lines.slice(1)).toEqual([
      'Notes for the insurers: Please quote with and without terrorism.',
      NOTE,
    ]);
    // The template's own note rows further down are left out; the notes are printed.
    const shownNotes = rowsOf(premium).filter(
      (line) => line.text === 'NOTE:' && !premium.getRow(line.row).hidden,
    );
    expect(shownNotes.map((line) => line.row)).toEqual([note]);
    const area = /:[A-Z]+(\d+)$/.exec(premium.pageSetup.printArea ?? '');
    expect(Number(area?.[1])).toBeGreaterThanOrEqual(note + 3);

    const schedule = workbook.getWorksheet('schedule')!;
    expect(rowsOf(schedule).map((line) => line.text)).not.toContain('NOTE:');

    const sheets = workbook.worksheets.filter((sheet) => sheet.state !== 'hidden');
    const signed = sheets.filter((sheet) =>
      rowsOf(sheet).some((line) => line.text === `Prepared By: ${managerName}`),
    );
    expect(signed).toHaveLength(1);

    const pdf = await binary(
      request(app).get(`/api/v1/proposals/${caseId}/qcr/document?format=pdf`).set(bearer(manager)),
    ).expect(200);
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
  });
});

describe('every file in the file store (S3), and saved copies of documents', () => {
  const base = () => `/api/v1/proposals/${caseId}/cloud-documents`;

  it('keeps uploads, templates and RFQ versions in the store, only their keys in the database', async () => {
    // By now quotes were uploaded, both templates uploaded and the RFQ generated and sent.
    const raw = (name: string) =>
      mongoose.connection.collection(name).find({}).toArray() as Promise<Record<string, unknown>[]>;
    for (const name of ['quote_attachments', 'document_templates']) {
      const docs = await raw(name);
      expect(docs.length).toBeGreaterThan(0);
      for (const doc of docs) {
        expect(doc.data).toBeUndefined();
        expect(store.objects.has(String(doc.storageKey))).toBe(true);
      }
    }
    const versions = await raw('rfq_versions');
    expect(versions.length).toBeGreaterThan(0);
    for (const version of versions) {
      expect([version.xlsx, version.pdf]).toEqual([undefined, undefined]);
      expect(store.objects.has(String(version.xlsxKey))).toBe(true);
      expect(store.objects.get(String(version.pdfKey))?.contentType).toBe('application/pdf');
    }
    const list = await request(app).get(base()).set(bearer(readOnly)).expect(200);
    expect(list.body).toEqual({ enabled: true, items: [] });
  });

  it('saves, lists, downloads and removes a document, audited', async () => {
    const before = store.objects.size;
    const qcr = await request(app)
      .post(base())
      .set(bearer(manager))
      .send({ document: 'QCR', format: 'pdf' })
      .expect(201);
    expect(qcr.body).toMatchObject({
      document: 'QCR',
      format: 'pdf',
      fileName: expect.stringMatching(/^QCR-PRP-\d{4}-\d{4}\.pdf$/) as string,
      detail: 'draft',
      savedBy: managerName,
    });
    const rfq = await request(app)
      .post(base())
      .set(bearer(manager))
      .send({ document: 'RFQ', format: 'xlsx' })
      .expect(201);
    expect(rfq.body).toMatchObject({ document: 'RFQ', detail: 'v1' });
    expect(store.objects.size).toBe(before + 2);
    const object = [...store.objects.values()].find(
      (item) => item.key.includes(`/proposals/${caseId}/`) && item.metadata.document === 'QCR',
    );
    expect(object).toBeDefined();

    const list = await request(app).get(base()).set(bearer(manager)).expect(200);
    expect((list.body.items as { id: string }[]).map((item) => item.id)).toEqual([
      rfq.body.id,
      qcr.body.id,
    ]);

    const file = await binary(
      request(app)
        .get(`${base()}/${qcr.body.id as string}/file`)
        .set(bearer(manager)),
    ).expect(200);
    expect(Buffer.compare(file.body as Buffer, object!.data)).toBe(0);
    expect(file.headers['content-type']).toBe('application/pdf');

    await request(app)
      .delete(`${base()}/${qcr.body.id as string}`)
      .set(bearer(manager))
      .expect(204);
    expect(store.objects.size).toBe(before + 1);
    const after = await request(app).get(base()).set(bearer(manager)).expect(200);
    expect((after.body.items as { id: string }[]).map((item) => item.id)).toEqual([rfq.body.id]);
    await request(app)
      .get(`${base()}/${qcr.body.id as string}/file`)
      .set(bearer(manager))
      .expect(404);

    const actions = await AuditLogModel.find({
      entityId: caseId,
      action: {
        $in: ['CLOUD_DOCUMENT_SAVED', 'CLOUD_DOCUMENT_DOWNLOADED', 'CLOUD_DOCUMENT_REMOVED'],
      },
    })
      .sort({ at: 1 })
      .lean();
    expect(actions.map((entry) => entry.action)).toEqual([
      'CLOUD_DOCUMENT_SAVED',
      'CLOUD_DOCUMENT_SAVED',
      'CLOUD_DOCUMENT_DOWNLOADED',
      'CLOUD_DOCUMENT_REMOVED',
    ]);
    const record = await request(app).get(`/api/v1/proposals/${caseId}`).set(bearer(manager));
    expect(
      (record.body.activity as { message: string }[]).some((entry) =>
        entry.message.startsWith('QCR (PDF) saved to cloud storage'),
      ),
    ).toBe(true);
  });

  it('needs property.export to save, and a document that can be produced', async () => {
    await request(app)
      .post(base())
      .set(bearer(readOnly))
      .send({ document: 'QCR', format: 'pdf' })
      .expect(403);
    // No client acceptance yet: the placement slip cannot be produced, nothing is stored.
    const before = store.objects.size;
    await request(app)
      .post(base())
      .set(bearer(manager))
      .send({ document: 'PLACEMENT_SLIP', format: 'pdf' })
      .expect(409);
    expect(store.objects.size).toBe(before);
  });
});
