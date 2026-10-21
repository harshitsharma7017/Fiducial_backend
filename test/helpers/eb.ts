import {
  emptyGpaQuoteTerms,
  emptyGpaRequirements,
  emptyGtliRequirements,
  type Role,
} from '../../src/shared/index.ts';
import ExcelJS from 'exceljs';
import type { Express } from 'express';
import request from 'supertest';
import { ensureDefaultFamilyPlans } from '../../src/modules/family-plans/default-plans.ts';
import { bearer, tokenFor } from './app.ts';
import { seedMasters } from './masters.ts';

// Fixtures for the Employee Benefits suites: a token per role, companies, insurers, Data Sheets,
// census workbooks and the steps that take a case through its workflow.

export const ROLE_LIST: Role[] = [
  'ADMIN',
  'MANAGER',
  'ACCOUNT_MANAGER',
  'PLACEMENT_EXEC',
  'READ_ONLY',
];
export const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
export const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export interface EbWorld {
  tokens: Record<Role, string>;
  admin: string;
  manager: string;
  approver: string;
  exec: string;
  readOnly: string;
  clientId: string;
  otherClientId: string;
  insurers: string[];
}

let clientCounter = 0;

export async function createClient(app: Express, token: string, name?: string): Promise<string> {
  clientCounter += 1;
  const response = await request(app)
    .post('/api/v1/clients')
    .set(bearer(token))
    .send({
      name: name ?? `EB Company ${clientCounter} Pvt Ltd`,
      gstin: null,
      address: {
        line1: '1 Main Road',
        line2: '',
        city: 'Pune',
        state: 'Maharashtra',
        pincode: '411001',
      },
      contacts: [
        {
          name: 'Ravi HR',
          designation: 'HR',
          email: `hr${clientCounter}@company.example`,
          phone: null,
        },
      ],
      natureOfBusiness: 'Manufacturing',
      occupancyCode: '2001',
    })
    .expect(201);
  return response.body.id as string;
}

/** Users of every role, two companies, five insurers and the default family plans. */
export async function setUpWorld(app: Express): Promise<EbWorld> {
  await seedMasters();
  await ensureDefaultFamilyPlans();
  const tokens = {} as Record<Role, string>;
  for (const role of ROLE_LIST) tokens[role] = (await tokenFor(app, [role])).token;
  const clientId = await createClient(app, tokens.ADMIN);
  const otherClientId = await createClient(app, tokens.ADMIN);
  const insurers: string[] = [];
  for (const name of ['Alpha', 'Beta', 'Gamma']) {
    const insurer = await request(app)
      .post('/api/v1/insurers')
      .set(bearer(tokens.ADMIN))
      .send({
        company: `${name} General Insurance ${clientCounter}`,
        branch: 'Pune',
        contacts: [],
        rfqEmails: [`rfq@${name.toLowerCase()}${clientCounter}.example`],
      })
      .expect(201);
    insurers.push(insurer.body.id as string);
  }
  return {
    tokens,
    admin: tokens.ADMIN,
    manager: tokens.ACCOUNT_MANAGER,
    approver: tokens.MANAGER,
    exec: tokens.PLACEMENT_EXEC,
    readOnly: tokens.READ_ONLY,
    clientId,
    otherClientId,
    insurers,
  };
}

export const slug = (product: 'GPA' | 'GTLI') => (product === 'GPA' ? 'gpa' : 'gtli');
export const ebPath = (product: 'GPA' | 'GTLI', id: string, rest = '') =>
  `/api/v1/eb/${slug(product)}/cases/${id}${rest}`;

export async function createEbCase(
  app: Express,
  token: string,
  product: 'GMC' | 'GPA' | 'GTLI',
  clientId: string,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; reference: string; product: string }> {
  const response = await request(app)
    .post('/api/v1/eb/cases')
    .set(bearer(token))
    .send({
      product,
      type: 'NEW',
      clientId,
      dueDate: '2026-11-30',
      policyStart: '2026-12-01',
      policyEnd: '2027-11-30',
      ...overrides,
    })
    .expect(201);
  return response.body as { id: string; reference: string; product: string };
}

export const gpaSheet = (overrides: Record<string, unknown> = {}) => ({
  ...emptyGpaRequirements(),
  employeeCount: 3,
  sumInsuredBasis: { kind: 'FLAT', amount: '500000' },
  covers: {
    accidentalDeath: 'REQUIRED',
    permanentTotal: 'REQUIRED',
    permanentPartial: 'NOT_REQUIRED',
    temporaryTotal: 'NOT_REQUIRED',
  },
  ...overrides,
});

export const gtliSheet = (overrides: Record<string, unknown> = {}) => ({
  ...emptyGtliRequirements(),
  employeeCount: 3,
  sumInsuredBasis: { kind: 'SALARY_MULTIPLE', multiplier: '3', maximum: '3000000' },
  freeCoverLimit: '1500000',
  ...overrides,
});

export const gpaTerms = (overrides: Record<string, unknown> = {}) => {
  const terms = emptyGpaQuoteTerms();
  terms.covers.accidentalDeath = { offer: 'OFFERED', limitAmount: '500000', limitText: null };
  terms.covers.permanentTotal = { offer: 'OFFERED', limitAmount: null, limitText: '100% of SI' };
  return { ...terms, ...overrides };
};

export type CensusCell = string | number | Date | null;

/** A census workbook with the given headers and rows (and no marker sheet). */
export async function censusWorkbook(
  headers: string[],
  rows: CensusCell[][],
  sheetName = 'Census',
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  sheet.addRow(headers);
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** Fills a downloaded template's Census sheet with rows (keeping its other sheets). */
export async function fillTemplate(template: Buffer, rows: CensusCell[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(template as unknown as Parameters<ExcelJS.Xlsx['load']>[0]);
  const sheet = workbook.getWorksheet('Census')!;
  rows.forEach((row, index) => {
    const target = sheet.getRow(index + 2);
    row.forEach((value, column) => {
      target.getCell(column + 1).value = value;
    });
    target.commit();
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export const binary = (req: request.Test) =>
  req.buffer(true).parse((res, done) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('end', () => done(null, Buffer.concat(chunks)));
  });

export async function readWorkbook(data: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(data as unknown as Parameters<ExcelJS.Xlsx['load']>[0]);
  return workbook;
}

/** Uploads a census file to a case. */
export function uploadCensus(
  app: Express,
  token: string,
  base: string,
  data: Buffer,
  fileName = 'census.xlsx',
) {
  return request(app)
    .post(`${base}/census/imports?fileName=${fileName}`)
    .set(bearer(token))
    .set('Content-Type', XLSX)
    .send(data);
}

/** Uploads a file kept on the case (quote, client decision, payment proof). */
export async function uploadCaseFile(
  app: Express,
  token: string,
  base: string,
  purpose: string,
): Promise<string> {
  const response = await request(app)
    .post(`${base}/files?purpose=${purpose}&fileName=proof.pdf`)
    .set(bearer(token))
    .set('Content-Type', 'application/pdf')
    .send(PDF)
    .expect(201);
  return response.body.id as string;
}
