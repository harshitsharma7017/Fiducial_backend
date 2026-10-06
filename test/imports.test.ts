import {
  IMPORT_SHEETS,
  XLSX_CONTENT_TYPE,
  type ImportEntity,
  type ImportReport,
} from '../src/shared/index.ts';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { Types } from 'mongoose';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLogModel } from '../src/modules/audit/audit.model.ts';
import { ClientLocationModel } from '../src/modules/clients/client-location.model.ts';
import { ClientModel } from '../src/modules/clients/client.model.ts';
import { buildTemplate } from '../src/modules/imports/workbook.ts';
import { InsurerModel } from '../src/modules/insurers/insurer.model.ts';
import { bearer, createTestApp, tokenFor, useTestDatabase } from './helpers/app.ts';
import {
  OCCUPANCIES,
  PINCODES,
  insertOccupancies,
  insertPincodes,
  seedMasters,
} from './helpers/masters.ts';

useTestDatabase();
const app = createTestApp();

let adminToken: string;
let managerToken: string;

// The sample files use real IIB codes and pincodes; the fixture master gets copies of them.
const SAMPLE_CODES = ['2189', '2044', '4007', '2148', '1017', '4001', '1007'];
const SAMPLE_PINCODES = [
  '421302',
  '400093',
  '600032',
  '641001',
  '560058',
  '560001',
  '382445',
  '395003',
  '110020',
  '411018',
];

beforeAll(async () => {
  const { occupancyVersionId, pincodeVersionId } = await seedMasters();
  const template = OCCUPANCIES.find((o) => o.tacCode === '2001')!;
  await insertOccupancies(
    new Types.ObjectId(occupancyVersionId),
    SAMPLE_CODES.map((tacCode) => ({ ...template, tacCode, description: `Fixture ${tacCode}` })),
  );
  await insertPincodes(
    new Types.ObjectId(pincodeVersionId),
    SAMPLE_PINCODES.map((pincode) => ({
      ...PINCODES[0]!,
      pincode,
      district: `District ${pincode}`,
    })),
  );
  adminToken = (await tokenFor(app, ['ADMIN'])).token;
  managerToken = (await tokenFor(app, ['ACCOUNT_MANAGER'])).token;
});

function upload(
  entity: ImportEntity,
  file: Buffer,
  {
    dryRun = true,
    rows,
    token = adminToken,
  }: { dryRun?: boolean; rows?: string; token?: string } = {},
) {
  const query = new URLSearchParams({ dryRun: String(dryRun) });
  if (rows) query.set('rows', rows);
  return request(app)
    .post(`/api/v1/imports/${entity}?${query.toString()}`)
    .set(bearer(token))
    .set('Content-Type', XLSX_CONTENT_TYPE)
    .send(file);
}

/** Every row problem in a report, flattened. */
function problems(body: ImportReport) {
  return body.rows.flatMap((row) => row.issues.map((issue) => ({ row: row.row, ...issue })));
}

async function downloadSample(entity: ImportEntity): Promise<Buffer> {
  const response = await request(app)
    .get(`/api/v1/imports/${entity}/template?sample=true`)
    .set(bearer(adminToken))
    .buffer(true)
    .parse((res, callback) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => callback(null, Buffer.concat(chunks)));
    })
    .expect(200);
  return response.body as Buffer;
}

const client = (overrides: Record<string, string> = {}) => ({
  name: 'Row Test Industries',
  gstin: '',
  line1: '1 Test Road',
  line2: '',
  city: 'Mumbai',
  state: 'maharashtra',
  pincode: '400001',
  natureOfBusiness: 'Testing',
  occupancyCode: '2001',
  ...overrides,
});

describe('templates', () => {
  it('has an Instructions sheet and the data sheet with every column', async () => {
    const response = await request(app)
      .get('/api/v1/imports/clients/template')
      .set(bearer(adminToken))
      .expect(200);
    expect(response.headers['content-type']).toBe(XLSX_CONTENT_TYPE);
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="clients-template.xlsx"',
    );

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      (await buildTemplate('clients')) as unknown as Parameters<ExcelJS.Xlsx['load']>[0],
    );
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      'Instructions',
      'Clients',
      'Lists',
    ]);
    const headers = (workbook.getWorksheet('Clients')!.getRow(1).values as unknown[]).slice(1);
    expect(headers).toEqual(
      IMPORT_SHEETS.clients.columns.map((c) => (c.required ? `${c.header} *` : c.header)),
    );
    // No data rows: only the State drop-down reaches below the headers.
    expect(workbook.getWorksheet('Clients')!.getCell('A2').value).toBeNull();
  });

  it('needs the permission of each entity', async () => {
    const { token: readOnly } = await tokenFor(app, ['READ_ONLY']);
    await request(app).get('/api/v1/imports/clients/template').set(bearer(readOnly)).expect(403);
    await request(app)
      .get('/api/v1/imports/clients/template')
      .set(bearer(managerToken))
      .expect(200);
    // Insurers are master data: Admin only.
    await request(app)
      .get('/api/v1/imports/insurers/template')
      .set(bearer(managerToken))
      .expect(403);
    await upload('insurers', await buildTemplate('insurers'), { token: managerToken }).expect(403);
    await request(app).get('/api/v1/imports/unknown/template').set(bearer(adminToken)).expect(400);
  });
});

describe('the sample files', () => {
  it('import cleanly in order, each record audited, and cannot be imported twice', async () => {
    const expected: Record<ImportEntity, number> = {
      clients: 6,
      'client-locations': 12,
      insurers: 6,
    };
    for (const entity of ['clients', 'client-locations', 'insurers'] as const) {
      const file = await downloadSample(entity);
      const check = await upload(entity, file).expect(200);
      expect(check.body).toMatchObject({
        dryRun: true,
        rowsRead: expected[entity],
        validRows: expected[entity],
        invalidRows: 0,
        imported: false,
        createdCount: 0,
        fileErrors: [],
      });
      const saved = await upload(entity, file, { dryRun: false }).expect(200);
      expect(saved.body).toMatchObject({ imported: true, createdCount: expected[entity] });

      // Every row is now a duplicate, so nothing is left to import.
      const again = await upload(entity, file, { dryRun: false }).expect(200);
      expect(again.body).toMatchObject({
        imported: false,
        validRows: 0,
        invalidRows: expected[entity],
      });
      expect(again.body.fileErrors).toEqual([
        expect.objectContaining({ message: expect.stringContaining('No row can be imported') }),
      ]);
    }
    expect(await ClientModel.countDocuments({ name: 'Sahyadri Textiles Pvt Ltd' })).toBe(1);
    const sahyadri = await ClientModel.findOne({ name: 'Sahyadri Textiles Pvt Ltd' }).lean();
    expect(await ClientLocationModel.countDocuments({ clientId: sahyadri!._id })).toBe(4);
    // Matched by name: this client has no GSTIN.
    const ganesh = await ClientModel.findOne({ name: 'Shree Ganesh Traders' }).lean();
    expect(ganesh?.gstin).toBeNull();
    expect(await ClientLocationModel.countDocuments({ clientId: ganesh!._id })).toBe(1);
    expect(
      await InsurerModel.countDocuments({ company: 'Suraksha General Insurance Co. Ltd' }),
    ).toBe(2);
    expect(await AuditLogModel.countDocuments({ action: 'CLIENT_LOCATION_CREATED' })).toBe(12);
  });
});

describe('row problems', () => {
  it('shows each row with its problems, and imports only valid rows', async () => {
    const before = await ClientModel.countDocuments();
    const file = await buildTemplate('clients', [
      client({ name: 'Good Row Ltd', gstin: '27AAPFU0939F1ZV' }),
      client({ name: '', gstin: '27AAPFU0939F1ZW' }),
      client({ name: 'Copy Of Row 2', gstin: '27aapfu0939f1zv' }),
      client({ name: 'Unknown Occupancy', occupancyCode: '9999' }),
      client({ name: 'Lonely Contact', contact1Name: 'No Way To Reach' }),
      client({ name: 'Nameless Contact', contact2Email: 'x@example.com' }),
    ]);
    const preview = await upload('clients', file).expect(200);
    expect(preview.body).toMatchObject({ rowsRead: 6, validRows: 1, invalidRows: 5 });
    expect(preview.body.rows[0]).toMatchObject({
      row: 2,
      valid: true,
      label: 'Good Row Ltd',
      issues: [],
      values: expect.objectContaining({ name: 'Good Row Ltd', city: 'Mumbai' }),
    });
    expect(preview.body.rows[1]).toMatchObject({ row: 3, valid: false, label: null });
    expect(problems(preview.body)).toEqual([
      { row: 3, column: 'Insured name', message: 'Enter the insured name' },
      {
        row: 3,
        column: 'GSTIN',
        message: 'This GSTIN fails its check digit. Check it for a typing mistake.',
      },
      { row: 4, column: 'GSTIN', message: 'GSTIN 27AAPFU0939F1ZV is also on row 2' },
      {
        row: 5,
        column: 'Occupancy code',
        message: 'Occupancy code 9999 is not in the active master',
      },
      { row: 6, column: 'Contact 1 email', message: 'Enter an email or a phone number' },
      { row: 7, column: 'Contact 2 name', message: 'Enter the contact name' },
    ]);

    // Choosing an invalid row stops the import.
    const refused = await upload('clients', file, { dryRun: false, rows: '2,3,5' }).expect(200);
    expect(refused.body).toMatchObject({ imported: false, createdCount: 0 });
    expect(refused.body.fileErrors).toEqual([
      {
        row: null,
        column: null,
        message:
          'Rows 3 and 5 cannot be imported: they have problems or are not in the file. Leave them out and import again.',
      },
    ]);
    expect(await ClientModel.countDocuments()).toBe(before);

    // The valid row alone is imported; the others are left out.
    const saved = await upload('clients', file, { dryRun: false, rows: '2' }).expect(200);
    expect(saved.body).toMatchObject({ imported: true, createdCount: 1 });
    expect(await ClientModel.countDocuments()).toBe(before + 1);
    expect(await ClientModel.exists({ name: 'Good Row Ltd' })).toBeTruthy();
  });

  it('lists every problem of a row at once, master lookups included', async () => {
    const clients = await buildTemplate('clients', [
      client({ name: 'Many Problems Ltd', occupancyCode: '9999', contact1Name: 'Unreachable' }),
    ]);
    const clientReport = await upload('clients', clients).expect(200);
    expect(problems(clientReport.body).map((p) => p.column)).toEqual([
      'Contact 1 email',
      'Occupancy code',
    ]);

    const locations = await buildTemplate('client-locations', [
      { name: '', line1: '1 Road', city: 'Pune', pincode: '999999', occupancyCode: '9999' },
    ]);
    const locationReport = await upload('client-locations', locations).expect(200);
    expect(problems(locationReport.body).map((p) => p.column)).toEqual([
      'Client GSTIN',
      'Location name',
      'Occupancy code',
      'Pincode',
    ]);
  });

  it('imports every valid row when none are chosen, and checks the row list', async () => {
    const file = await buildTemplate('clients', [
      client({ name: 'Batch One Ltd' }),
      client({ name: 'Batch Two Ltd' }),
      client({ name: 'Batch Bad Ltd', occupancyCode: '9999' }),
    ]);
    const saved = await upload('clients', file, { dryRun: false }).expect(200);
    expect(saved.body).toMatchObject({ imported: true, createdCount: 2, invalidRows: 1 });
    await upload('clients', file, { dryRun: false, rows: '2;3' }).expect(400);
  });

  it('reads a template whose notes another tool saved its own way', async () => {
    // openpyxl (and some other tools) keep notes in xl/comments/ under an absolute path, which
    // exceljs cannot load. Rebuild our template that way and import it.
    const zip = await JSZip.loadAsync(
      await buildTemplate('clients', [client({ name: 'Saved Elsewhere Ltd' })]),
    );
    const comments = await zip.file('xl/comments2.xml')!.async('string');
    zip.remove('xl/comments2.xml');
    zip.file('xl/comments/comment1.xml', comments);
    const rels = 'xl/worksheets/_rels/sheet2.xml.rels';
    zip.file(
      rels,
      (await zip.file(rels)!.async('string')).replace(
        'Target="../comments2.xml"',
        'Target="/xl/comments/comment1.xml"',
      ),
    );
    const types = '[Content_Types].xml';
    zip.file(
      types,
      (await zip.file(types)!.async('string')).replace(
        '/xl/comments2.xml',
        '/xl/comments/comment1.xml',
      ),
    );
    const file = await zip.generateAsync({ type: 'nodebuffer' });

    const plain = new ExcelJS.Workbook();
    await expect(
      plain.xlsx.load(file as unknown as Parameters<ExcelJS.Xlsx['load']>[0]),
    ).rejects.toThrow();
    const response = await upload('clients', file).expect(200);
    expect(response.body).toMatchObject({ invalidRows: 0, validRows: 1 });
    expect(response.body.rows[0]).toMatchObject({ row: 2, label: 'Saved Elsewhere Ltd' });
  });

  it('reports missing columns and files that are not workbooks', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Clients').addRow(['Insured name', 'City']);
    const missing = await upload('clients', Buffer.from(await workbook.xlsx.writeBuffer()));
    expect(missing.body.rows).toEqual([]);
    expect(missing.body.fileErrors.map((e: { column: string }) => e.column)).toEqual([
      'Address line 1',
      'State',
      'Pincode',
      'Nature of business',
      'Occupancy code',
    ]);
    expect(missing.body.fileErrors[0]).toMatchObject({
      row: 1,
      message: expect.stringContaining('missing'),
    });

    const text = await upload('clients', Buffer.from('name,city\nA,B')).expect(200);
    expect(text.body.fileErrors).toEqual([
      expect.objectContaining({ row: null, message: expect.stringContaining('not an Excel') }),
    ]);

    await request(app)
      .post('/api/v1/imports/clients')
      .set(bearer(adminToken))
      .send({ rows: [] })
      .expect(400);
  });

  it('finds the client of each location and names the ones it cannot', async () => {
    await ClientModel.create([
      {
        name: 'Twin Name Co',
        nameKey: 'twin name co',
        gstin: null,
        address: { line1: 'a', line2: null, city: 'c', state: 'Goa', pincode: '403001' },
        contacts: [],
        natureOfBusiness: 'x',
        occupancy: { tacCode: '2001', description: 'd' },
      },
      {
        name: 'Twin Name Co',
        nameKey: 'twin name co',
        gstin: null,
        address: { line1: 'a', line2: null, city: 'c', state: 'Goa', pincode: '403001' },
        contacts: [],
        natureOfBusiness: 'x',
        occupancy: { tacCode: '2001', description: 'd' },
      },
    ]);
    const location = { name: 'Plant', line1: '1 Road', city: 'Mumbai', pincode: '400001' };
    const file = await buildTemplate('client-locations', [
      { ...location, clientGstin: '29AAGCB7383J1Z4' },
      { ...location, clientName: 'Twin Name Co' },
      { ...location, clientName: 'Nobody Ltd' },
      { ...location, clientName: 'Shree Ganesh Traders', pincode: '999999' },
      { ...location, clientName: '' },
    ]);
    const response = await upload('client-locations', file).expect(200);
    expect(problems(response.body).map((e) => [e.row, e.message])).toEqual([
      [2, 'No client has GSTIN 29AAGCB7383J1Z4. Import the client first.'],
      [3, '2 clients are named Twin Name Co. Use the client GSTIN.'],
      [4, 'No client is named Nobody Ltd. Import the client first.'],
      [5, 'Pincode 999999 is not in the active master'],
      [6, 'Enter the client GSTIN, or the client name for a client without one'],
    ]);
  });

  it('names the RFQ email that is wrong', async () => {
    const file = await buildTemplate('insurers', [
      {
        company: 'Test Insurance',
        branch: 'Pune',
        rfqEmails: 'good@insurer.example; not-an-email',
      },
    ]);
    const response = await upload('insurers', file).expect(200);
    expect(problems(response.body)).toEqual([
      { row: 2, column: 'RFQ emails', message: 'not-an-email: Enter a valid email address' },
    ]);
  });
});
