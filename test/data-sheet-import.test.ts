import { XLSX_CONTENT_TYPE } from '../src/shared/index.ts';
import ExcelJS from 'exceljs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { openTemplate } from '../src/modules/documents/excel-template.ts';
import { bearer, createTestApp, tokenFor, useTestDatabase } from './helpers/app.ts';
import { seedMasters } from './helpers/masters.ts';

// DS-08: the client's Data Sheet workbook read into the values of a case's Data Sheet form.

useTestDatabase();

const app = createTestApp();
const FORMAT = readFileSync(
  fileURLToPath(
    new URL('../data/client-formats/Fiducial_Property_data sheet.xlsx', import.meta.url),
  ),
);

let manager: string;
let caseId: string;
let locationId: string;

/** The first row whose cell in the column starts with the words. */
function rowOf(sheet: ExcelJS.Worksheet, words: string, column = 2, from = 1): number {
  for (let row = from; row <= sheet.rowCount; row += 1) {
    const value = sheet.getCell(row, column).value;
    if (typeof value === 'string' && value.trim().toLowerCase().startsWith(words.toLowerCase())) {
      return row;
    }
  }
  throw new Error(`No row starting "${words}"`);
}

/** The client's format, filled as a client would. */
async function filledWorkbook(): Promise<Buffer> {
  const workbook = await openTemplate(FORMAT);
  const sheet = workbook.getWorksheet('data sheet')!;
  sheet.getCell(rowOf(sheet, 'Name of the Insured', 1), 2).value = 'Import Test Mills';
  sheet.getCell(rowOf(sheet, 'GST No', 1), 2).value = '27AAPFU0939F1ZV';
  sheet.getCell(rowOf(sheet, 'Risk Location', 1), 2).value = 'Plant 1, Plot 1, Mumbai 400001';
  const fire = rowOf(sheet, 'Fire & Burglary', 1);
  sheet.getCell(rowOf(sheet, 'Building 1', 2, fire), 3).value = 40000;
  sheet.getCell(rowOf(sheet, 'Building 1', 2, fire), 4).value = 2500;
  sheet.getCell(rowOf(sheet, 'Furniture', 2, fire), 5).value = 500000;
  sheet.getCell(rowOf(sheet, 'All other machineries', 2, fire), 5).value = 150000000;
  sheet.getCell(rowOf(sheet, 'All types of stock', 2, fire), 5).value = 60000000.5;
  sheet.getCell(rowOf(sheet, 'Hypothecation', 2), 5).value = 'State Bank of India, Fort';
  sheet.getCell(rowOf(sheet, 'Annual Gross Profit', 2), 5).value = 80000000;
  sheet.getCell(rowOf(sheet, 'Cash in safe', 2), 5).value = '2,00,000';
  sheet.getCell(rowOf(sheet, 'No of Employees', 2), 5).value = 25;
  sheet.getCell(rowOf(sheet, 'Any One Accident', 2), 5).value = 1000000;
  const features = rowOf(sheet, 'Details of risk features', 2);
  sheet.getCell(rowOf(sheet, 'Fire Fighting', 2, features), 3).value = 'Hydrants and extinguishers';
  sheet.getCell(rowOf(sheet, 'Type of Construction', 2, features), 3).value = 'RCC';
  sheet.getCell(rowOf(sheet, 'No of Floors', 2, features), 3).value = 3;
  sheet.getCell(rowOf(sheet, 'CC Tv', 2, features), 3).value = 'Yes, 16 cameras';
  sheet.getCell(rowOf(sheet, 'Details of Stock - raw', 2, features), 3).value = 'Cotton';
  sheet.getCell(rowOf(sheet, 'Details of Stock - finished', 2, features), 3).value = 'Yarn';
  const annexure = workbook.getWorksheet('Annexure')!;
  const glass = rowOf(annexure, 'Plate Glass', 1) + 2;
  annexure.getCell(glass, 2).value = 'Showroom front';
  annexure.getCell(glass, 4).value = 4;
  annexure.getCell(glass, 5).value = '2 x 3 m';
  annexure.getCell(glass, 7).value = 150000;
  const eei = rowOf(annexure, 'Electronic Equipment', 1) + 2;
  annexure.getCell(eei, 2).value = 'Server';
  annexure.getCell(eei, 3).value = 'Dell R740';
  annexure.getCell(eei, 4).value = 'SN-1';
  annexure.getCell(eei, 5).value = 2021;
  annexure.getCell(eei, 7).value = 300000;
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

const upload = (data: Buffer) =>
  request(app)
    .post(`/api/v1/proposals/${caseId}/data-sheet/import?fileName=sheet.xlsx`)
    .set(bearer(manager))
    .set('Content-Type', XLSX_CONTENT_TYPE)
    .send(data);

beforeAll(async () => {
  await seedMasters();
  const admin = (await tokenFor(app, ['ADMIN'])).token;
  manager = (await tokenFor(app, ['ACCOUNT_MANAGER'])).token;
  const client = await request(app)
    .post('/api/v1/clients')
    .set(bearer(admin))
    .send({
      name: 'Import Test Mills',
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
  const created = await request(app)
    .post('/api/v1/proposals')
    .set(bearer(manager))
    .send({
      type: 'NEW',
      clientId: client.body.id,
      locationIds: [locationId],
      dueDate: '2026-11-20',
      policyStart: null,
      policyEnd: null,
    })
    .expect(201);
  caseId = created.body.id as string;
});

describe('DS-08: reading the client’s Data Sheet workbook', () => {
  it('reads the Fire lines, sections, risk features and annexure of the client’s format', async () => {
    const read = await upload(await filledWorkbook()).expect(200);
    expect(read.body.insured).toMatchObject({
      name: 'Import Test Mills',
      gstin: '27AAPFU0939F1ZV',
      policyPeriod: 'For 1 Year from date of payment',
    });
    expect(read.body.locations).toHaveLength(1);
    const [location] = read.body.locations;
    expect(location).toMatchObject({
      sheetName: 'data sheet',
      riskLocation: 'Plant 1, Plot 1, Mumbai 400001',
      suggestedLocationId: locationId,
      hypothecation: 'State Bank of India, Fort',
      openStock: null,
    });
    expect(location.fire).toEqual([
      { key: 'BUILDING_1', sqFt: '40000', ratePerSqFt: '2500', amount: null },
      { key: 'FFF', sqFt: null, ratePerSqFt: null, amount: '500000' },
      { key: 'OTHER_MACHINERY', sqFt: null, ratePerSqFt: null, amount: '150000000' },
      { key: 'STOCKS', sqFt: null, ratePerSqFt: null, amount: '60000001' },
    ]);
    expect(location.risk).toEqual({
      fireFighting: 'Hydrants and extinguishers',
      construction: 'RCC; No of floors: 3',
      watchAndWard: 'CCTV: Yes, 16 cameras',
      stockComposition: 'Raw materials: Cotton; Finished goods: Yarn',
    });
    expect(read.body.sections).toEqual([
      {
        code: 'FIRE_LOSS_OF_PROFIT',
        lines: { annualGrossProfit: '80000000' },
        proposed1: null,
        annexure: [],
      },
      { code: 'MONEY', lines: { cashInSafe: '200000' }, proposed1: null, annexure: [] },
      { code: 'FIDELITY_GUARANTEE', lines: { employees: '25' }, proposed1: null, annexure: [] },
      {
        code: 'PUBLIC_LIABILITY',
        lines: { anyOneAccident: '1000000' },
        proposed1: null,
        annexure: [],
      },
      {
        code: 'PLATE_GLASS',
        lines: {},
        proposed1: null,
        annexure: [
          {
            description: 'Showroom front',
            quantity: '4',
            dimensions: '2 x 3 m',
            makeModel: null,
            serialNo: null,
            year: null,
            sumInsured: '150000',
          },
        ],
      },
      {
        code: 'EEI',
        lines: {},
        proposed1: null,
        annexure: [
          {
            description: 'Server',
            quantity: null,
            dimensions: null,
            makeModel: 'Dell R740',
            serialNo: 'SN-1',
            year: '2021',
            sumInsured: '300000',
          },
        ],
      },
    ]);
    expect(read.body.warnings).toEqual([
      'Data Sheet, 6 All types of stock pertaining to insured business: 60000000.5 rounded to whole rupees.',
    ]);
  });

  it('warns when the sheet is another insured’s, and refuses other files', async () => {
    const workbook = await openTemplate(await filledWorkbook());
    const sheet = workbook.getWorksheet('data sheet')!;
    sheet.getCell(rowOf(sheet, 'Name of the Insured', 1), 2).value = 'Someone Else Ltd';
    const read = await upload(Buffer.from(await workbook.xlsx.writeBuffer())).expect(200);
    expect(read.body.warnings).toContain(
      'The sheet is for "Someone Else Ltd"; this case\'s client is Import Test Mills.',
    );

    const plain = new ExcelJS.Workbook();
    plain.addWorksheet('Sheet1').addRow(['Nothing here']);
    const none = await upload(Buffer.from(await plain.xlsx.writeBuffer())).expect(400);
    expect(none.body.details[0].message).toMatch(/^No Data Sheet found/);
    const text = await upload(Buffer.from('not a workbook')).expect(400);
    expect(text.body.details[0].message).toMatch(/^This is not an Excel workbook/);
  });
});
