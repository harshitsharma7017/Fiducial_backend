import {
  GhiCaseListResponseSchema,
  GhiCaseRecordSchema,
  GhiCensusSummarySchema,
  GhiDocumentPreviewSchema,
  GhiFileListResponseSchema,
  GhiFinalQcrStateSchema,
  GhiImportListResponseSchema,
  GhiMemberListResponseSchema,
  GhiPaymentsResponseSchema,
  GhiPlacementStateSchema,
  GhiQcrListResponseSchema,
  GhiQuoteListResponseSchema,
  GhiRfqStateSchema,
  XLSX_CONTENT_TYPE,
  emptyGhiQuoteTerms,
  type GhiRequirementsInput,
} from '../src/shared/index.ts';
import type { z } from 'zod';
import ExcelJS from 'exceljs';
import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { ProposalModel } from '../src/modules/proposals/proposal.model.ts';
import { bearer, createTestApp, tokenFor, useTestDatabase } from './helpers/app.ts';
import { FakeTransport } from './helpers/mail.ts';
import { seedMasters } from './helpers/masters.ts';

// Group health end to end (G1 to G7) on a 50-employee group: the Data Sheet, a census file with
// invalid rows corrected and imported, the summary, the RFQ approved and emailed, five insurers'
// quotes, the QCR rejected then approved, the client's choice, the final terms, payment, the
// placement slip and the policy. Property proposals are untouched throughout.

useTestDatabase();

const transport = new FakeTransport();
const app = createTestApp({}, undefined, transport);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
const REFERENCE_DATE = '2026-04-01';

let admin: string;
let manager: string;
let approver: string;
let exec: string;
let readOnly: string;
let clientId: string;
let caseId: string;
const insurers: string[] = [];

const api = (path: string) => `/api/v1/ghi${path}`;
const c = (path = '') => api(`/cases/${caseId}${path}`);
const binary = (req: request.Test) =>
  req.buffer(true).parse((res, done) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('end', () => done(null, Buffer.concat(chunks)));
  });
const getCase = async () => (await request(app).get(c()).set(bearer(manager)).expect(200)).body;
const upload = (purpose: string, data = PDF, fileName = 'proof.pdf') =>
  request(app)
    .post(c(`/files?purpose=${purpose}&fileName=${fileName}`))
    .set(bearer(manager))
    .set('Content-Type', 'application/pdf')
    .send(data);

const requirements = (): GhiRequirementsInput => ({
  company: {
    natureOfBusiness: 'Software services',
    contactName: 'Neha Kapoor',
    contactEmail: 'hr@acme-health.example',
    contactPhone: '+91 22 4000 1000',
    locations: 'Mumbai, Pune',
  },
  employeeCount: 50,
  familyDefinition: { spouse: true, maxChildren: 3, parents: 'EITHER' },
  coverageType: 'FLOATER',
  sumInsuredOptions: ['300000', '500000'],
  maternity: {
    covered: true,
    normalLimit: '50000',
    cesareanLimit: '75000',
    newbornCovered: true,
    nineMonthWaiver: true,
  },
  preExistingDiseases: { covered: true, note: 'From day one' },
  waivers: {
    initialWaitingPeriod: true,
    firstYearExclusions: true,
    twoYearExclusions: false,
    preExistingWaitingPeriod: true,
  },
  roomRent: { kind: 'PERCENT_OF_SI', normal: '1', icu: '2' },
  parentsCoPayPercent: '20',
  corporateBuffer: { amount: '1000000', perFamilyLimit: '200000', note: null },
  claims: [
    {
      policyYear: '2025-26',
      insurer: 'Old Health Co',
      livesCovered: 120,
      premium: '1000000.00',
      claimsPaid: '600000.00',
      claimsOutstanding: '150000.00',
      claimCount: 14,
    },
    {
      policyYear: '2024-25',
      insurer: 'Old Health Co',
      livesCovered: 110,
      premium: '900000.00',
      claimsPaid: '450000.00',
      claimsOutstanding: null,
      claimCount: 9,
    },
    {
      policyYear: '2023-24',
      insurer: null,
      livesCovered: null,
      premium: null,
      claimsPaid: null,
      claimsOutstanding: null,
      claimCount: null,
    },
  ],
  ageLimits: {
    employee: { min: 18, max: 65 },
    spouse: { min: 18, max: 65 },
    child: { min: 0, max: 25 },
    parent: { min: null, max: 80 },
  },
  ageReferenceDate: REFERENCE_DATE,
  otherRequirements: 'Cashless at network hospitals in Mumbai and Pune',
});

type Row = [string, string, string, string, string, string, string];
const id = (n: number) => `E${String(n).padStart(3, '0')}`;
/** Employees' birth years by band: ages on 2026-04-01 of 31, 41, 51 and 61. */
const employeeYear = (n: number) => (n <= 10 ? 1995 : n <= 25 ? 1985 : n <= 40 ? 1975 : 1965);
const sumInsured = (n: number) => (n % 2 === 0 ? '500000' : '300000');

/** The census file: 50 valid families, then rows that break each rule. */
function censusRows(): { rows: Row[]; invalid: Record<string, Row> } {
  const rows: Row[] = [];
  for (let n = 1; n <= 50; n += 1) {
    rows.push([
      id(n),
      `Employee ${n}`,
      n % 3 === 0 ? 'F' : 'M',
      `01/01/${employeeYear(n)}`,
      'Self',
      '01/06/2020',
      sumInsured(n),
    ]);
    if (n <= 30)
      rows.push([id(n), `Spouse ${n}`, n % 3 === 0 ? 'M' : 'F', '01/01/1996', 'Spouse', '', '']);
    const children = n <= 20 ? 2 : n <= 25 ? 3 : 0;
    for (let k = 1; k <= children; k += 1) {
      rows.push([
        id(n),
        `Child ${n}-${k}`,
        k % 2 ? 'M' : 'F',
        `0${k}/01/2015`,
        k % 2 ? 'Son' : 'Daughter',
        '',
        '',
      ]);
    }
    if (n >= 26 && n <= 30) {
      rows.push([id(n), `Father ${n}`, 'M', '01/01/1955', 'Father', '', '']);
      rows.push([id(n), `Mother ${n}`, 'F', '01/01/1957', 'Mother', '', '']);
    }
  }
  const invalid: Record<string, Row> = {
    fourthChild: [id(21), 'Child 21-4', 'M', '04/01/2016', 'Son', '', ''],
    secondSpouse: [id(1), 'Another Spouse', 'F', '01/01/1997', 'Wife', '', ''],
    badDate: [id(40), 'Spouse 40', 'F', '31/02/1990', 'Spouse', '', ''],
    badRelationship: [id(41), 'Cousin 41', 'M', '01/01/1990', 'Cousin', '', ''],
    father42: [id(42), 'Father 42', 'M', '01/01/1955', 'Father', '', ''],
    motherInLaw42: [id(42), 'MIL 42', 'F', '01/01/1956', 'Mother-in-law', '', ''],
    duplicateSelf: [
      id(2),
      'Employee 2',
      'M',
      `01/01/${employeeYear(2)}`,
      'Self',
      '01/06/2020',
      '500000',
    ],
    orphan: ['E099', 'Lonely Spouse', 'F', '01/01/1990', 'Spouse', '', ''],
    tooOld: ['E051', 'Senior Employee', 'M', '01/01/1955', 'Self', '01/06/2000', '300000'],
    tooOldSpouse: ['E051', 'Senior Spouse', 'F', '01/01/1965', 'Spouse', '', ''],
    floaterClash: [id(44), 'Child 44', 'F', '01/01/2018', 'Daughter', '', '300000'],
  };
  return { rows: [...rows, ...Object.values(invalid)], invalid };
}

async function workbookOf(rows: Row[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Census');
  sheet.addRow([
    'Employee ID *',
    'Name *',
    'Gender *',
    'Date of Birth *',
    'Relationship *',
    'Date of Joining',
    'Sum Insured',
  ]);
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function readWorkbook(data: Buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(data as unknown as Parameters<ExcelJS.Xlsx['load']>[0]);
  return workbook;
}

const terms = (overrides: Partial<ReturnType<typeof emptyGhiQuoteTerms>> = {}) => ({
  ...emptyGhiQuoteTerms(),
  coverageType: 'FLOATER' as const,
  roomRent: { kind: 'PERCENT_OF_SI' as const, normal: '1', icu: '2' },
  maternity: {
    covered: true,
    normalLimit: '50000',
    cesareanLimit: '75000',
    newbornCovered: true,
    nineMonthWaiver: true,
  },
  preExistingCovered: true,
  parentsCoPayPercent: '20',
  waivers: {
    initialWaitingPeriod: true,
    firstYearExclusions: true,
    twoYearExclusions: false,
    preExistingWaitingPeriod: true,
  },
  waitingPeriods: {
    initialDays: 0,
    specificDiseasesMonths: 24,
    preExistingMonths: 0,
    maternityMonths: 0,
  },
  corporateBufferAmount: '1000000',
  ...overrides,
});

beforeAll(async () => {
  await seedMasters();
  admin = (await tokenFor(app, ['ADMIN'])).token;
  manager = (await tokenFor(app, ['ACCOUNT_MANAGER'])).token;
  approver = (await tokenFor(app, ['MANAGER'])).token;
  exec = (await tokenFor(app, ['PLACEMENT_EXEC'])).token;
  readOnly = (await tokenFor(app, ['READ_ONLY'])).token;
  const client = await request(app)
    .post('/api/v1/clients')
    .set(bearer(admin))
    .send({
      name: 'Acme Health Group Pvt Ltd',
      gstin: '27AAPFU0939F1ZV',
      address: {
        line1: '5 Tech Park',
        line2: '',
        city: 'Mumbai',
        state: 'Maharashtra',
        pincode: '400001',
      },
      contacts: [
        {
          name: 'Neha Kapoor',
          designation: 'HR Head',
          email: 'hr@acme-health.example',
          phone: null,
        },
      ],
      natureOfBusiness: 'Software services',
      occupancyCode: '2001',
    })
    .expect(201);
  clientId = client.body.id as string;
  for (const name of ['Arogya', 'Bima', 'Chikitsa', 'Dhanvantari', 'Ekta']) {
    const insurer = await request(app)
      .post('/api/v1/insurers')
      .set(bearer(admin))
      .send({
        company: `${name} Health Insurance`,
        branch: 'Mumbai',
        contacts: [],
        rfqEmails: [`rfq@${name.toLowerCase()}.example`],
      })
      .expect(201);
    insurers.push(insurer.body.id as string);
  }
});

describe('group health case (G1, G2)', () => {
  it('is created only by those who may create proposals, and checks renewals', async () => {
    const body = {
      type: 'NEW',
      clientId,
      dueDate: '2026-10-30',
      policyStart: '2026-11-01',
      policyEnd: '2027-10-31',
    };
    await request(app).post(api('/cases')).send(body).expect(401);
    await request(app).post(api('/cases')).set(bearer(readOnly)).send(body).expect(403);
    await request(app).post(api('/cases')).set(bearer(approver)).send(body).expect(403);
    const renewal = await request(app)
      .post(api('/cases'))
      .set(bearer(manager))
      .send({ ...body, type: 'RENEWAL', policyEnd: '' })
      .expect(400);
    expect(renewal.body.details.map((issue: { path: string }) => issue.path).sort()).toEqual([
      'existingInsurer',
      'policyEnd',
    ]);

    const created = await request(app)
      .post(api('/cases'))
      .set(bearer(manager))
      .send(body)
      .expect(201);
    caseId = created.body.id as string;
    expect(created.body).toMatchObject({
      type: 'NEW',
      stage: 'CREATED',
      placed: false,
      client: {
        name: 'Acme Health Group Pvt Ltd',
        contacts: [{ email: 'hr@acme-health.example' }],
      },
      gstRatePercent: '18',
      missing: ['Save the Data Sheet'],
    });
    expect(created.body.reference).toMatch(/^GHI-\d{4}-0001$/);
  });

  it('validates and saves the Data Sheet, moving the case to Data Sheet', async () => {
    const bad = await request(app)
      .put(c('/requirements'))
      .set(bearer(manager))
      .send({
        ...requirements(),
        roomRent: { kind: 'NO_LIMIT', normal: '1', icu: null },
        sumInsuredOptions: ['300000', '300000'],
      })
      .expect(400);
    expect(bad.body.details.map((issue: { path: string }) => issue.path).sort()).toEqual([
      'roomRent.normal',
      'sumInsuredOptions',
    ]);
    await request(app)
      .put(c('/requirements'))
      .set(bearer(readOnly))
      .send(requirements())
      .expect(403);

    const saved = await request(app)
      .put(c('/requirements'))
      .set(bearer(exec))
      .send(requirements())
      .expect(200);
    expect(saved.body.stage).toBe('DATA_SHEET');
    expect(saved.body.missing).toEqual([]);
    expect(saved.body.ageReferenceDate).toBe(REFERENCE_DATE);
    expect(
      saved.body.requirements.claims.map(
        (claim: { claimsRatioPercent: string | null }) => claim.claimsRatioPercent,
      ),
    ).toEqual(['75.00', '50.00', null]);
  });
});

describe('census (G3, G4)', () => {
  let importId: string;
  const { rows, invalid } = censusRows();
  const rowOf = (key: keyof typeof invalid) => rows.indexOf(invalid[key]!) + 2;

  it('offers the template with the census columns', async () => {
    const file = await binary(
      request(app).get(api('/census-template')).set(bearer(readOnly)),
    ).expect(200);
    const workbook = await readWorkbook(file.body as Buffer);
    const header = workbook.getWorksheet('Census')!.getRow(1).values as string[];
    expect(header.slice(1)).toEqual([
      'Employee ID *',
      'Name *',
      'Gender *',
      'Date of Birth *',
      'Relationship *',
      'Date of Joining',
      'Sum Insured',
    ]);
  });

  it('checks every row of an upload, naming the Excel row, the field and the fix', async () => {
    const preview = await request(app)
      .post(c('/census/imports?fileName=census.xlsx'))
      .set(bearer(manager))
      .set('Content-Type', XLSX_CONTENT_TYPE)
      .send(await workbookOf(rows))
      .expect(201);
    importId = preview.body.id as string;
    const byRow = new Map<number, { field: string | null; message: string }[]>(
      preview.body.rows.map((row: { row: number; issues: [] }) => [row.row, row.issues]),
    );
    const first = (key: keyof typeof invalid) => byRow.get(rowOf(key))?.[0];
    expect(first('fourthChild')).toMatchObject({
      field: 'relationship',
      message: expect.stringMatching(/already has 3 children: at most 3/),
    });
    expect(first('secondSpouse')).toMatchObject({
      field: 'relationship',
      message: expect.stringMatching(/one spouse per employee/),
    });
    expect(first('badDate')).toEqual({ field: 'dateOfBirth', message: 'This date does not exist' });
    expect(first('badRelationship')).toMatchObject({
      field: 'relationship',
      message: expect.stringMatching(/"Cousin" is not a relationship/),
    });
    expect(byRow.get(rowOf('father42'))).toEqual([]);
    expect(first('motherInLaw42')?.message).toMatch(/either parents or parents-in-law, not both/);
    const selfRow2 = rows.findIndex((row) => row[0] === 'E002' && row[4] === 'Self') + 2;
    expect(first('duplicateSelf')).toMatchObject({
      field: 'name',
      message: expect.stringMatching(
        new RegExp(`^Duplicate: Employee 2 .* is on row ${selfRow2}$`),
      ),
    });
    expect(first('orphan')).toMatchObject({
      field: 'employeeId',
      message: expect.stringMatching(/No employee \(Self\) row for employee ID E099/),
    });
    expect(first('tooOld')).toMatchObject({
      field: 'dateOfBirth',
      message: 'Age 71 is above the maximum of 65 for self (employee) members',
    });
    expect(first('tooOldSpouse')?.message).toMatch(
      new RegExp(`The employee’s own row \\(row ${rowOf('tooOld')}\\) has errors`),
    );
    expect(first('floaterClash')?.message).toMatch(
      /Family floater: dependants share the employee’s sum insured \(₹5,00,000\)/,
    );
    expect(preview.body.counts).toEqual({
      rows: rows.length,
      valid: rows.length - 10,
      invalid: 10,
      imported: 0,
    });
  });

  it('lets a row be corrected and checked again', async () => {
    const fixed = await request(app)
      .put(c(`/census/imports/${importId}/rows/${rowOf('badDate')}`))
      .set(bearer(manager))
      .send({
        values: {
          employeeId: 'E040',
          name: 'Spouse 40',
          gender: 'F',
          dateOfBirth: '28/02/1990',
          relationship: 'Spouse',
          dateOfJoining: '',
          sumInsured: '',
        },
      })
      .expect(200);
    const row = fixed.body.rows.find((item: { row: number }) => item.row === rowOf('badDate'));
    expect(row).toMatchObject({ valid: true, corrected: true, issues: [] });
    expect(fixed.body.counts.invalid).toBe(9);
  });

  it('imports by the policy chosen: never partly when every row must pass', async () => {
    const refused = await request(app)
      .post(c(`/census/imports/${importId}/commit`))
      .set(bearer(manager))
      .send({ policy: 'ALL_VALID' })
      .expect(409);
    expect(refused.body).toMatchObject({ code: 'GHI_CENSUS_INVALID', details: { invalid: 9 } });
    expect(
      (await request(app).get(c('/census/summary')).set(bearer(manager)).expect(200)).body.lives,
    ).toBe(0);

    const imported = await request(app)
      .post(c(`/census/imports/${importId}/commit`))
      .set(bearer(manager))
      .send({ policy: 'VALID_ONLY' })
      .expect(200);
    expect(imported.body).toMatchObject({ imported: rows.length - 9, skipped: 9 });
    expect(imported.body.import.status).toBe('IMPORTED');
    await request(app)
      .post(c(`/census/imports/${importId}/commit`))
      .set(bearer(manager))
      .send({ policy: 'VALID_ONLY' })
      .expect(409);
  });

  it('refuses the same census twice, even saved again, and flags rows already imported', async () => {
    // Built again, so the file's bytes differ (Excel stamps the time it was saved).
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const again = await request(app)
      .post(c('/census/imports?fileName=census-again.xlsx'))
      .set(bearer(manager))
      .set('Content-Type', XLSX_CONTENT_TYPE)
      .send(await workbookOf(rows))
      .expect(409);
    expect(again.body.code).toBe('GHI_DUPLICATE_IMPORT');

    const joiner: Row = ['E052', 'Late Joiner', 'F', '01/01/1992', 'Self', '01/09/2026', '300000'];
    const mixed = await request(app)
      .post(c('/census/imports?fileName=census-with-joiner.xlsx'))
      .set(bearer(manager))
      .set('Content-Type', XLSX_CONTENT_TYPE)
      .send(await workbookOf([rows[0]!, joiner]))
      .expect(201);
    expect(mixed.body.rows[0].issues[0].message).toMatch(
      /^Duplicate: Employee 1 .* is already in the census$/,
    );
    expect(mixed.body.rows[1]).toMatchObject({ row: 3, valid: true });
    await request(app)
      .post(c(`/census/imports/${mixed.body.id as string}/discard`))
      .set(bearer(manager))
      .expect(200);
  });

  it('summarises the census: employees, lives, relationships, age bands and floater sum insured', async () => {
    const summary = (await request(app).get(c('/census/summary')).set(bearer(readOnly)).expect(200))
      .body;
    // 50 employees; 30 spouses and E040's corrected one; 20×2 + 5×3 children; E026–E030 parents and E042's father.
    expect(summary).toMatchObject({
      employees: 50,
      lives: 50 + 31 + 55 + 11,
      byRelationship: {
        SELF: 50,
        SPOUSE: 31,
        CHILD: 55,
        FATHER: 6,
        MOTHER: 5,
        FATHER_IN_LAW: 0,
        MOTHER_IN_LAW: 0,
      },
      coverageType: 'FLOATER',
      ageReferenceDate: REFERENCE_DATE,
      declaredEmployees: 50,
      missingSumInsured: 0,
      // 25 families at ₹3,00,000 and 25 at ₹5,00,000.
      totalSumInsured: String(25 * 300000 + 25 * 500000),
    });
    const bands = Object.fromEntries(
      summary.byAgeBand.map((band: { band: string; lives: number }) => [band.band, band.lives]),
    );
    // Children are 11; spouses 30 except E040's (36); employees 31, 41, 51, 61; parents 69 to 71.
    expect(bands).toEqual({
      '0-18': 55,
      '19-35': 10 + 30,
      '36-45': 15 + 1,
      '46-55': 15,
      '56-65': 10,
      '66+': 11,
    });
    expect(
      summary.byAgeBand.reduce((total: number, band: { lives: number }) => total + band.lives, 0),
    ).toBe(summary.lives);
  });

  it('adds, edits and removes members by hand under the same rules, keeping the summary in step', async () => {
    const secondSpouse = await request(app)
      .post(c('/members'))
      .set(bearer(manager))
      .send({
        employeeId: 'E001',
        name: 'Extra Spouse',
        gender: 'FEMALE',
        dateOfBirth: '1997-01-01',
        relationship: 'SPOUSE',
        dateOfJoining: '',
        sumInsured: '',
      })
      .expect(400);
    expect(secondSpouse.body.details[0]).toMatchObject({
      path: 'relationship',
      message: expect.stringMatching(/one spouse per employee/),
    });

    const added = await request(app)
      .post(c('/members'))
      .set(bearer(manager))
      .send({
        employeeId: 'E051',
        name: 'New Joiner',
        gender: 'MALE',
        dateOfBirth: '1990-07-15',
        relationship: 'SELF',
        dateOfJoining: '2026-03-01',
        sumInsured: '300000',
      })
      .expect(201);
    expect(added.body).toMatchObject({ age: 35, source: 'MANUAL' });
    const child = await request(app)
      .post(c('/members'))
      .set(bearer(manager))
      .send({
        employeeId: 'e051',
        name: 'Joiner Kid',
        gender: 'FEMALE',
        dateOfBirth: '2020-01-01',
        relationship: 'CHILD',
        dateOfJoining: '',
        sumInsured: '',
      })
      .expect(201);
    expect((await request(app).get(c('/census/summary')).set(bearer(manager))).body.employees).toBe(
      51,
    );

    const blocked = await request(app)
      .delete(c(`/members/${added.body.id as string}`))
      .set(bearer(manager))
      .expect(409);
    expect(blocked.body.message).toMatch(/has 1 dependant\(s\). Remove them first/);
    const edited = await request(app)
      .put(c(`/members/${child.body.id as string}`))
      .set(bearer(manager))
      .send({
        employeeId: 'E051',
        name: 'Joiner Kid',
        gender: 'FEMALE',
        dateOfBirth: '2019-01-01',
        relationship: 'CHILD',
        dateOfJoining: '',
        sumInsured: '',
      })
      .expect(200);
    expect(edited.body.age).toBe(7);
    await request(app)
      .delete(c(`/members/${child.body.id as string}`))
      .set(bearer(manager))
      .expect(204);
    await request(app)
      .delete(c(`/members/${added.body.id as string}`))
      .set(bearer(manager))
      .expect(204);
    const summary = (await request(app).get(c('/census/summary')).set(bearer(manager))).body;
    expect(summary).toMatchObject({ employees: 50, lives: 147 });
  });

  it('searches and pages the census, families together', async () => {
    const family = (await request(app).get(c('/members?q=E021')).set(bearer(readOnly)).expect(200))
      .body;
    expect(family.items.map((member: { relationship: string }) => member.relationship)).toEqual([
      'SELF',
      'SPOUSE',
      'CHILD',
      'CHILD',
      'CHILD',
    ]);
    const page = (
      await request(app).get(c('/members?page=3&limit=25')).set(bearer(readOnly)).expect(200)
    ).body;
    expect(page).toMatchObject({ total: 147, page: 3, limit: 25 });
    expect(page.items).toHaveLength(25);
    const parents = (
      await request(app).get(c('/members?relationship=MOTHER')).set(bearer(readOnly))
    ).body;
    expect(parents.total).toBe(5);
  });
});

describe('RFQ (G5)', () => {
  it('is generated as a version with the data sheet, summary, claims and member annexure', async () => {
    const state = (await request(app).get(c('/rfq')).set(bearer(manager)).expect(200)).body;
    expect(state).toMatchObject({ missing: [], current: null, mailEnabled: true });
    await request(app).post(c('/rfq/generate')).set(bearer(readOnly)).expect(403);
    const generated = await request(app).post(c('/rfq/generate')).set(bearer(manager)).expect(201);
    expect(generated.body.current).toMatchObject({
      version: 1,
      status: 'DRAFT',
      stale: false,
      census: { employees: 50, lives: 147, totalSumInsured: '20000000' },
    });
    expect((await getCase()).stage).toBe('RFQ');

    const preview = (await request(app).get(c('/rfq/preview')).set(bearer(readOnly)).expect(200))
      .body;
    // N7 adds the RFQ Selection Summary Sheet after the RFQ's own sheets.
    expect(preview.sheets.map((sheet: { name: string }) => sheet.name)).toEqual([
      'GHI Data Sheet',
      'Census Summary',
      'Claims History',
      'Annexure - Members',
      'RFQ Selection Summary',
    ]);

    const xlsx = await binary(
      request(app).get(c('/rfq/document?format=xlsx')).set(bearer(manager)),
    ).expect(200);
    const workbook = await readWorkbook(xlsx.body as Buffer);
    const annexure = workbook.getWorksheet('Annexure - Members')!;
    expect(annexure.rowCount).toBe(147 + 2);
    expect(annexure.getRow(3).values).toEqual([
      undefined,
      1,
      'E001',
      'Employee 1',
      'Male',
      '01 Jan 1995',
      31,
      'Self (employee)',
      '01 Jun 2020',
      300000,
    ]);
    const sheet = workbook.getWorksheet('GHI Data Sheet')!;
    const texts: string[] = [];
    sheet.eachRow((row) => row.eachCell((cell) => texts.push(cell.text)));
    expect(texts).toContain('Acme Health Group Pvt Ltd');
    expect(texts.join(' ')).toMatch(
      /Employee, spouse, up to 3 children, parents or parents-in-law/,
    );
    const claims = workbook.getWorksheet('Claims History')!;
    expect(claims.getRow(3).getCell(8).value).toBe('75.00%');
    const pdf = await binary(
      request(app).get(c('/rfq/document?format=pdf')).set(bearer(manager)),
    ).expect(200);
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('is sent only once approved, by an Approver', async () => {
    await request(app)
      .put(c('/insurers'))
      .set(bearer(manager))
      .send({ insurerIds: insurers })
      .expect(200);
    const early = await request(app)
      .post(c('/rfq/email'))
      .set(bearer(manager))
      .send({ sendId: randomUUID(), insurerIds: insurers, dueDate: '2026-10-30', format: 'xlsx' })
      .expect(409);
    expect(early.body.code).toBe('RFQ_NOT_APPROVED');
    await request(app).post(c('/rfq/submit')).set(bearer(exec)).expect(200);
    await request(app)
      .post(c('/rfq/decision'))
      .set(bearer(exec))
      .send({ decision: 'APPROVED', comment: null })
      .expect(403);
    await request(app)
      .post(c('/rfq/decision'))
      .set(bearer(approver))
      .send({ decision: 'RETURNED', comment: '' })
      .expect(400);
    const approved = await request(app)
      .post(c('/rfq/decision'))
      .set(bearer(approver))
      .send({ decision: 'APPROVED', comment: 'OK to send' })
      .expect(200);
    expect(approved.body.current).toMatchObject({
      status: 'APPROVED',
      decision: { status: 'APPROVED', comment: 'OK to send' },
    });
  });

  it('mails each insurer its own RFQ, reports a failure as failed, and never mails twice', async () => {
    transport.reset();
    transport.failFor.add('rfq@ekta.example');
    const sendId = randomUUID();
    const body = { sendId, insurerIds: insurers, dueDate: '2026-10-30', format: 'pdf' };
    const sent = await request(app)
      .post(c('/rfq/email'))
      .set(bearer(manager))
      .send(body)
      .expect(200);
    expect(sent.body.results.map((result: { outcome: string }) => result.outcome)).toEqual([
      'SENT',
      'SENT',
      'SENT',
      'SENT',
      'FAILED',
    ]);
    expect(sent.body.results[4].reason).toMatch(/550 rfq@ekta.example unknown/);
    expect(transport.sent.map((mail) => mail.to)).toEqual([
      ['rfq@arogya.example'],
      ['rfq@bima.example'],
      ['rfq@chikitsa.example'],
      ['rfq@dhanvantari.example'],
    ]);
    expect(transport.sent[0]?.attachment?.fileName).toMatch(/^GHI-RFQ-GHI-\d{4}-0001-v1\.pdf$/);
    expect(transport.sent[0]?.subject).toMatch(/Request for quotation: Acme Health Group Pvt Ltd/);
    const statuses = sent.body.case.insurers.map((insurer: { status: string }) => insurer.status);
    expect(statuses).toEqual(['SENT', 'SENT', 'SENT', 'SENT', 'NOT_SENT']);
    expect(sent.body.case.locked).toBe(true);

    await request(app).post(c('/rfq/email')).set(bearer(manager)).send(body).expect(200);
    expect(transport.calls).toBe(5);

    transport.failFor.clear();
    const retry = await request(app)
      .post(c('/rfq/email'))
      .set(bearer(manager))
      .send({ ...body, sendId: randomUUID(), insurerIds: [insurers[4]] })
      .expect(200);
    expect(retry.body.results[0].outcome).toBe('SENT');
    const state = (await request(app).get(c('/rfq')).set(bearer(manager))).body;
    expect(state.dispatches.map((dispatch: { result: string }) => dispatch.result).sort()).toEqual([
      'DELIVERED',
      'DELIVERED',
      'DELIVERED',
      'DELIVERED',
      'DELIVERED',
      'FAILED',
    ]);
  });

  it('locks the Data Sheet and census once the RFQ is out', async () => {
    const locked = await request(app)
      .put(c('/requirements'))
      .set(bearer(manager))
      .send(requirements())
      .expect(409);
    expect(locked.body.code).toBe('GHI_LOCKED');
    await request(app)
      .post(c('/members'))
      .set(bearer(manager))
      .send({
        employeeId: 'E077',
        name: 'Late Joiner',
        gender: 'MALE',
        dateOfBirth: '1990-01-01',
        relationship: 'SELF',
        dateOfJoining: '',
        sumInsured: '300000',
      })
      .expect(409);
  });
});

describe('quotes and QCR (G6)', () => {
  const quoteIds: string[] = [];
  let qcrId: string;

  it('records draft and final quotes with GST at 18% worked out by the API', async () => {
    const file = await upload('QUOTE').expect(201);
    const draft = await request(app)
      .post(c('/quotes'))
      .set(bearer(exec))
      .send({
        insurerId: insurers[0],
        basePremium: '',
        terms: terms(),
        otherTerms: null,
        validUntil: '',
        reason: null,
        attachmentIds: [file.body.id],
        finalize: false,
      })
      .expect(201);
    expect(draft.body).toMatchObject({
      status: 'DRAFT',
      version: 1,
      basePremium: null,
      totalPremium: null,
    });
    await request(app)
      .post(c('/quotes'))
      .set(bearer(exec))
      .send({
        insurerId: insurers[0],
        basePremium: '100',
        terms: terms(),
        otherTerms: null,
        validUntil: '',
        reason: null,
        attachmentIds: [],
        finalize: true,
      })
      .expect(409);
    const noPremium = await request(app)
      .put(c(`/quotes/${draft.body.id as string}`))
      .set(bearer(exec))
      .send({
        basePremium: '',
        terms: terms(),
        otherTerms: null,
        validUntil: '',
        reason: null,
        attachmentIds: [],
        finalize: true,
      })
      .expect(400);
    expect(noPremium.body.details[0].path).toBe('basePremium');
    const final = await request(app)
      .put(c(`/quotes/${draft.body.id as string}`))
      .set(bearer(exec))
      .send({
        basePremium: '123456.78',
        terms: terms(),
        otherTerms: 'Cashless at 6,000 hospitals',
        validUntil: '2026-12-31',
        reason: null,
        attachmentIds: [file.body.id],
        finalize: true,
      })
      .expect(200);
    expect(final.body).toMatchObject({
      status: 'FINAL',
      basePremium: '123456.78',
      gst: '22222.22',
      totalPremium: '145679.00',
      deviations: [],
      latest: true,
    });
    expect((await getCase()).stage).toBe('QCR');

    const offers: Array<[string, ReturnType<typeof terms>]> = [
      ['118000', terms({ roomRent: { kind: 'PERCENT_OF_SI', normal: '1', icu: '1.5' } })],
      ['131000.50', terms({ parentsCoPayPercent: '30', corporateBufferAmount: null })],
      ['140000', terms({ roomRent: { kind: 'NO_LIMIT', normal: null, icu: null } })],
      [
        '125000',
        terms({
          maternity: {
            covered: false,
            normalLimit: null,
            cesareanLimit: null,
            newbornCovered: false,
            nineMonthWaiver: false,
          },
        }),
      ],
    ];
    for (const [index, [premium, offered]] of offers.entries()) {
      const quote = await request(app)
        .post(c('/quotes'))
        .set(bearer(exec))
        .send({
          insurerId: insurers[index + 1],
          basePremium: premium,
          terms: offered,
          otherTerms: null,
          validUntil: '',
          reason: null,
          attachmentIds: [],
          finalize: true,
        })
        .expect(201);
      quoteIds.push(quote.body.id as string);
    }
    quoteIds.unshift(final.body.id as string);
  });

  it('keeps every version: a revision needs its reason and the QCR takes only the latest', async () => {
    const noReason = await request(app)
      .post(c('/quotes'))
      .set(bearer(exec))
      .send({
        insurerId: insurers[1],
        basePremium: '110000',
        terms: terms(),
        otherTerms: null,
        validUntil: '',
        reason: null,
        attachmentIds: [],
        finalize: true,
      })
      .expect(400);
    expect(noReason.body.details[0].path).toBe('reason');
    const revised = await request(app)
      .post(c('/quotes'))
      .set(bearer(exec))
      .send({
        insurerId: insurers[1],
        basePremium: '110000',
        terms: terms(),
        otherTerms: null,
        validUntil: '',
        reason: 'Negotiated: ICU limit restored',
        attachmentIds: [],
        finalize: true,
      })
      .expect(201);
    expect(revised.body).toMatchObject({ version: 2, totalPremium: '129800.00', deviations: [] });
    const stale = await request(app)
      .post(c('/qcrs'))
      .set(bearer(manager))
      .send({ quoteIds: [quoteIds[1]], recommendedInsurerId: null, remarks: null })
      .expect(400);
    expect(stale.body.details[0].message).toBe('Use the insurer’s latest quote');
    quoteIds[1] = revised.body.id as string;
    const all = (await request(app).get(c('/quotes')).set(bearer(readOnly)).expect(200)).body.items;
    const first = all.find(
      (quote: { insurerId: string; version: number }) =>
        quote.insurerId === insurers[1] && quote.version === 1,
    );
    expect(first).toMatchObject({ totalPremium: '139240.00', latest: false });
    expect(first.deviations).toEqual([
      expect.objectContaining({ field: 'roomRent', kind: 'DEVIATION' }),
    ]);
  });

  it('compares up to five insurers side by side, marking the lowest total and every deviation', async () => {
    const created = await request(app)
      .post(c('/qcrs'))
      .set(bearer(manager))
      .send({ quoteIds, recommendedInsurerId: insurers[1], remarks: 'Best value with all waivers' })
      .expect(201);
    qcrId = created.body.id as string;
    const columns = created.body.columns;
    expect(columns.map((column: { totalPremium: string }) => column.totalPremium)).toEqual([
      '145679.00',
      '129800.00',
      '154580.59',
      '165200.00',
      '147500.00',
    ]);
    expect(columns.map((column: { lowest: boolean }) => column.lowest)).toEqual([
      false,
      true,
      false,
      false,
      false,
    ]);
    expect(columns[1].recommended).toBe(true);
    expect(
      columns.map((column: { deviations: number; missing: number }) => [
        column.deviations,
        column.missing,
      ]),
    ).toEqual([
      [0, 0],
      [0, 0],
      [1, 1],
      [0, 0],
      [5, 0],
    ]);
    const copay = created.body.rows.find(
      (row: { key: string }) => row.key === 'parentsCoPayPercent',
    );
    expect(copay).toMatchObject({ requested: '20%' });
    expect(copay.values[2]).toEqual({ text: '30%', kind: 'DEVIATION' });
    const roomRent = created.body.rows.find((row: { key: string }) => row.key === 'roomRent');
    expect(roomRent.values[3]).toEqual({ text: 'No capping', kind: 'BETTER' });
    await request(app)
      .post(c('/qcrs'))
      .set(bearer(manager))
      .send({ quoteIds: [...quoteIds, quoteIds[0]], recommendedInsurerId: null, remarks: null })
      .expect(400);
  });

  it('is approved or rejected by an Approver; a rejection goes back to QCR', async () => {
    await request(app)
      .post(c(`/qcrs/${qcrId}/submit`))
      .set(bearer(manager))
      .expect(200);
    expect((await getCase()).stage).toBe('APPROVAL');
    await request(app)
      .post(c(`/qcrs/${qcrId}/decision`))
      .set(bearer(manager))
      .send({ decision: 'APPROVED', comment: null })
      .expect(403);
    const rejected = await request(app)
      .post(c(`/qcrs/${qcrId}/decision`))
      .set(bearer(approver))
      .send({ decision: 'REJECTED', comment: 'Add the remarks on maternity' })
      .expect(200);
    expect(rejected.body).toMatchObject({
      status: 'REJECTED',
      decision: { status: 'REJECTED', comment: 'Add the remarks on maternity' },
    });
    expect((await getCase()).stage).toBe('QCR');
    await request(app)
      .put(c(`/qcrs/${qcrId}`))
      .set(bearer(manager))
      .send({
        quoteIds,
        recommendedInsurerId: insurers[1],
        remarks: 'Best value; Ekta does not cover maternity',
      })
      .expect(200);
    await request(app)
      .post(c(`/qcrs/${qcrId}/submit`))
      .set(bearer(manager))
      .expect(200);
    const approved = await request(app)
      .post(c(`/qcrs/${qcrId}/decision`))
      .set(bearer(approver))
      .send({ decision: 'APPROVED', comment: null })
      .expect(200);
    expect(approved.body.status).toBe('APPROVED');
    expect(approved.body.decision.by).toBe('Test User');
  });

  it('downloads the QCR and mails it only to the client’s contacts', async () => {
    const xlsx = await binary(
      request(app)
        .get(c(`/qcrs/${qcrId}/document?format=xlsx`))
        .set(bearer(manager)),
    ).expect(200);
    const sheet = (await readWorkbook(xlsx.body as Buffer)).getWorksheet('QCR')!;
    const texts: string[] = [];
    sheet.eachRow((row) => row.eachCell((cell) => texts.push(cell.text)));
    expect(texts.join('|')).toMatch(
      /Bima Health Insurance, Mumbai \(quote v2\) — lowest — recommended/,
    );
    expect(texts).toContain('30% (deviation)');
    const pdf = await binary(
      request(app)
        .get(c(`/qcrs/${qcrId}/document?format=pdf`))
        .set(bearer(manager)),
    ).expect(200);
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');

    transport.reset();
    const stranger = await request(app)
      .post(c(`/qcrs/${qcrId}/email`))
      .set(bearer(manager))
      .send({ sendId: randomUUID(), to: ['someone@else.example'], format: 'pdf' })
      .expect(400);
    expect(stranger.body.details[0].path).toBe('to');
    expect(transport.calls).toBe(0);
    const sent = await request(app)
      .post(c(`/qcrs/${qcrId}/email`))
      .set(bearer(manager))
      .send({ sendId: randomUUID(), to: ['HR@acme-health.example'], format: 'pdf' })
      .expect(200);
    expect(sent.body.result).toMatchObject({ outcome: 'SENT', result: 'DELIVERED' });
    expect(transport.sent[0]?.to).toEqual(['hr@acme-health.example']);
    expect(sent.body.qcr.sends).toHaveLength(1);
  });

  it('records the client’s decision and selected insurer', async () => {
    const file = await upload('CLIENT_DECISION', PDF, 'acceptance.pdf').expect(201);
    const wrongFile = await upload('QUOTE', PDF, 'not-a-decision.pdf').expect(201);
    await request(app)
      .post(c(`/qcrs/${qcrId}/client-decision`))
      .set(bearer(manager))
      .send({
        decision: 'ACCEPTED',
        insurerId: insurers[1],
        decidedOn: '2026-10-10',
        confirmedBy: 'Neha Kapoor',
        note: null,
        fileIds: [wrongFile.body.id],
      })
      .expect(400);
    const decided = await request(app)
      .post(c(`/qcrs/${qcrId}/client-decision`))
      .set(bearer(manager))
      .send({
        decision: 'ACCEPTED',
        insurerId: insurers[1],
        decidedOn: '2026-10-10',
        confirmedBy: 'Neha Kapoor',
        note: null,
        fileIds: [file.body.id],
      })
      .expect(200);
    expect(decided.body.clientDecision).toMatchObject({
      decision: 'ACCEPTED',
      insurerName: 'Bima Health Insurance, Mumbai',
      quoteId: quoteIds[1],
    });
    expect((await getCase()).stage).toBe('FINAL_QCR');
  });
});

describe('final QCR, payment, placement slip and policy (G7)', () => {
  it('records the final agreed terms as a new version without changing the quotes', async () => {
    await request(app)
      .post(c('/payments'))
      .set(bearer(manager))
      .send({
        amount: '1',
        paidOn: '2026-10-10',
        reference: 'X',
        mode: 'NEFT',
        status: 'RECEIVED',
        payer: null,
        note: null,
        fileIds: [],
      })
      .expect(409);
    const state = (await request(app).get(c('/final-qcr')).set(bearer(manager)).expect(200)).body;
    expect(state).toMatchObject({
      accepted: { quote: { totalPremium: '129800.00' } },
      current: null,
      history: [],
    });
    const final = await request(app)
      .post(c('/final-qcr'))
      .set(bearer(manager))
      .send({
        basePremium: '108000',
        terms: terms({ corporateBufferAmount: '1200000' }),
        otherTerms: 'Wellness programme included',
        note: 'Premium negotiated down after acceptance',
        attachmentIds: [],
      })
      .expect(200);
    expect(final.body.current).toMatchObject({
      kind: 'FINAL_AGREED',
      version: 3,
      basePremium: '108000.00',
      gst: '19440.00',
      totalPremium: '127440.00',
    });
    expect(final.body.accepted.quote).toMatchObject({ version: 2, totalPremium: '129800.00' });
    const quotes = (await request(app).get(c('/quotes')).set(bearer(manager))).body.items;
    expect(
      quotes
        .filter((quote: { insurerId: string }) => quote.insurerId === insurers[1])
        .map((quote: { version: number; totalPremium: string }) => [
          quote.version,
          quote.totalPremium,
        ]),
    ).toEqual([
      [3, '127440.00'],
      [2, '129800.00'],
      [1, '139240.00'],
    ]);
    const record = await getCase();
    expect(record).toMatchObject({ stage: 'PAYMENT', finalQcr: { insurerId: insurers[1] } });
  });

  it('records payments against the final premium and moves on once it is covered', async () => {
    const proof = await upload('PAYMENT', PDF, 'utr.pdf').expect(201);
    await binary(request(app).get(c('/placement-slip?format=xlsx')).set(bearer(manager))).expect(
      409,
    );
    await request(app)
      .post(c('/payments'))
      .set(bearer(manager))
      .send({
        amount: '1000',
        paidOn: '2099-01-01',
        reference: 'UTR0',
        mode: 'NEFT',
        status: 'RECEIVED',
        payer: null,
        note: null,
        fileIds: [],
      })
      .expect(400);
    const partial = await request(app)
      .post(c('/payments'))
      .set(bearer(manager))
      .send({
        amount: '100000',
        paidOn: '2026-10-11',
        reference: 'UTR123',
        mode: 'NEFT',
        status: 'RECEIVED',
        payer: 'Acme Health Group',
        note: null,
        fileIds: [proof.body.id],
      })
      .expect(201);
    expect(partial.body).toMatchObject({
      expected: '127440.00',
      received: '100000.00',
      outstanding: '27440.00',
      settled: false,
    });
    expect((await getCase()).stage).toBe('PAYMENT');
    const cheque = await request(app)
      .post(c('/payments'))
      .set(bearer(manager))
      .send({
        amount: '27440',
        paidOn: '2026-10-12',
        reference: 'CHQ 004512',
        mode: 'CHEQUE',
        status: 'PENDING',
        payer: null,
        note: 'Post-dated',
        fileIds: [],
      })
      .expect(201);
    expect(cheque.body).toMatchObject({ pending: '27440.00', settled: false });
    const chequeId = cheque.body.items[1].id as string;
    const cleared = await request(app)
      .put(c(`/payments/${chequeId}`))
      .set(bearer(manager))
      .send({
        amount: '27440',
        paidOn: '2026-10-12',
        reference: 'CHQ 004512',
        mode: 'CHEQUE',
        status: 'RECEIVED',
        payer: null,
        note: 'Cleared',
        fileIds: [],
      })
      .expect(200);
    expect(cleared.body).toMatchObject({
      received: '127440.00',
      outstanding: '0.00',
      settled: true,
    });
    expect((await getCase()).stage).toBe('PLACEMENT_SLIP');
  });

  it('generates the placement slip from the selected QCR, final terms, census summary and member annexure', async () => {
    const state = (await request(app).get(c('/placement')).set(bearer(readOnly)).expect(200)).body;
    expect(state).toMatchObject({
      ready: true,
      missing: [],
      insurerName: 'Bima Health Insurance, Mumbai',
      summary: { employees: 50, lives: 147 },
    });
    const xlsx = await binary(
      request(app).get(c('/placement-slip?format=xlsx')).set(bearer(manager)),
    ).expect(200);
    const workbook = await readWorkbook(xlsx.body as Buffer);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      'Placement Slip',
      'Census Summary',
      'Annexure - Members',
    ]);
    const slip = workbook.getWorksheet('Placement Slip')!;
    const texts: string[] = [];
    slip.eachRow((row) => row.eachCell((cell) => texts.push(cell.text)));
    expect(texts).toEqual(
      expect.arrayContaining([
        'Bima Health Insurance, Mumbai',
        'Wellness programme included',
        '127440',
        'UTR123, CHQ 004512',
        '₹12,00,000',
      ]),
    );
    expect(workbook.getWorksheet('Annexure - Members')!.rowCount).toBe(149);
    await binary(request(app).get(c('/placement-slip?format=pdf')).set(bearer(readOnly))).expect(
      403,
    );
    const pdf = await binary(
      request(app).get(c('/placement-slip?format=pdf')).set(bearer(approver)),
    ).expect(200);
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('records the policy with its copy and renewal date, linked to the insurer, QCR and census', async () => {
    const paymentFile = (await request(app).get(c('/files')).set(bearer(manager))).body.items.find(
      (file: { purpose: string }) => file.purpose === 'PAYMENT',
    );
    const body = {
      policyNumber: 'GMC/2026/778899',
      issuedOn: '2026-10-13',
      policyStart: '2026-11-01',
      policyEnd: '2027-10-31',
      renewalDate: '2027-11-01',
      fileId: paymentFile.id,
    };
    const wrong = await request(app).put(c('/policy')).set(bearer(manager)).send(body).expect(400);
    expect(wrong.body.details[0].path).toBe('fileId');
    const copy = await upload('POLICY', PDF, 'policy.pdf').expect(201);
    await request(app)
      .put(c('/policy'))
      .set(bearer(approver))
      .send({ ...body, fileId: copy.body.id })
      .expect(403);
    const placed = await request(app)
      .put(c('/policy'))
      .set(bearer(manager))
      .send({ ...body, fileId: copy.body.id })
      .expect(200);
    expect(placed.body).toMatchObject({
      placed: true,
      stage: 'PLACEMENT_SLIP',
      nextStep: null,
      policy: {
        policyNumber: 'GMC/2026/778899',
        renewalDate: '2027-11-01',
        insurerId: insurers[1],
        insurerName: 'Bima Health Insurance, Mumbai',
        file: { fileName: 'policy.pdf' },
        census: { employees: 50, lives: 147, totalSumInsured: '20000000' },
      },
    });
    const file = await binary(
      request(app)
        .get(c(`/files/${copy.body.id as string}`))
        .set(bearer(readOnly)),
    ).expect(200);
    expect((file.body as Buffer).equals(PDF)).toBe(true);
    await request(app).post(c('/close')).set(bearer(manager)).send({ reason: 'Lost' }).expect(409);
  });
});

describe('contracts', () => {
  it('answers in exactly the shapes the web app parses', async () => {
    const reads: Array<[string, z.ZodType]> = [
      [c(), GhiCaseRecordSchema],
      [api('/cases'), GhiCaseListResponseSchema],
      [c('/members?limit=200'), GhiMemberListResponseSchema],
      [c('/census/summary'), GhiCensusSummarySchema],
      [c('/census/imports'), GhiImportListResponseSchema],
      [c('/rfq'), GhiRfqStateSchema],
      [c('/rfq/preview'), GhiDocumentPreviewSchema],
      [c('/quotes'), GhiQuoteListResponseSchema],
      [c('/qcrs'), GhiQcrListResponseSchema],
      [c('/final-qcr'), GhiFinalQcrStateSchema],
      [c('/payments'), GhiPaymentsResponseSchema],
      [c('/placement'), GhiPlacementStateSchema],
      [c('/files'), GhiFileListResponseSchema],
    ];
    for (const [path, schema] of reads) {
      const response = await request(app).get(path).set(bearer(manager)).expect(200);
      const parsed = schema.safeParse(response.body);
      expect(parsed.success, `${path}: ${parsed.error?.message ?? ''}`).toBe(true);
    }
  });
});

describe('ownership, audit and Property', () => {
  it('never opens one case’s records through another case', async () => {
    const other = await request(app)
      .post(api('/cases'))
      .set(bearer(manager))
      .send({ type: 'NEW', clientId, dueDate: '2026-11-30', policyStart: '', policyEnd: '' })
      .expect(201);
    const otherId = other.body.id as string;
    const files = (await request(app).get(c('/files')).set(bearer(manager))).body.items;
    await request(app)
      .get(api(`/cases/${otherId}/files/${files[0].id as string}`))
      .set(bearer(manager))
      .expect(404);
    const member = (await request(app).get(c('/members?limit=1')).set(bearer(manager))).body
      .items[0];
    await request(app)
      .delete(api(`/cases/${otherId}/members/${member.id as string}`))
      .set(bearer(manager))
      .expect(404);
    const qcr = (await request(app).get(c('/qcrs')).set(bearer(manager))).body.items[0];
    await request(app)
      .post(api(`/cases/${otherId}/qcrs/${qcr.id as string}/submit`))
      .set(bearer(manager))
      .expect(404);
    await request(app)
      .get(api(`/cases/${new mongoose.Types.ObjectId().toHexString()}`))
      .set(bearer(manager))
      .expect(404);

    const list = (await request(app).get(api('/cases?q=acme')).set(bearer(readOnly)).expect(200))
      .body;
    expect(list).toMatchObject({ total: 2, page: 1 });
    const placed = list.items.find((item: { id: string }) => item.id === caseId);
    expect(placed).toMatchObject({ placed: true, employees: 50, lives: 147 });
  });

  it('audits every change against the case', async () => {
    const log = (
      await request(app)
        .get(`/api/v1/audit?entity=ghi_case&entityId=${caseId}&limit=100`)
        .set(bearer(admin))
        .expect(200)
    ).body;
    const actions = new Set(log.items.map((entry: { action: string }) => entry.action));
    for (const action of [
      'GHI_CASE_CREATED',
      'GHI_REQUIREMENTS_SAVED',
      'GHI_CENSUS_UPLOADED',
      'GHI_CENSUS_ROW_CORRECTED',
      'GHI_CENSUS_IMPORTED',
      'GHI_MEMBER_CREATED',
      'GHI_MEMBER_DELETED',
      'GHI_RFQ_GENERATED',
      'GHI_RFQ_APPROVED',
      'GHI_RFQ_EMAILED',
      'GHI_RFQ_EMAIL_FAILED',
      'GHI_QUOTE_FINALIZED',
      'GHI_QCR_REJECTED',
      'GHI_QCR_APPROVED',
      'GHI_QCR_EMAILED',
      'GHI_CLIENT_DECISION_RECORDED',
      'GHI_FINAL_QCR_RECORDED',
      'GHI_PAYMENT_RECORDED',
      'GHI_PAYMENT_UPDATED',
      'GHI_PLACEMENT_SLIP_DOWNLOADED',
      'GHI_POLICY_RECORDED',
    ]) {
      expect(actions).toContain(action);
    }
    expect(log.items[0].entityLabel).toMatch(/^GHI-\d{4}-0001$/);
  });

  it('leaves Property proposals untouched', async () => {
    expect(await ProposalModel.countDocuments({})).toBe(0);
    const proposals = await request(app).get('/api/v1/proposals').set(bearer(manager)).expect(200);
    expect(proposals.body).toEqual({ items: [], nextCursor: null });
  });
});
