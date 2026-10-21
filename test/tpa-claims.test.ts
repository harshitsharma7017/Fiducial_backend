import {
  ClaimDetailSchema,
  ClaimsAnalysisResponseSchema,
  TpaClaimHistorySchema,
  TpaClaimListResponseSchema,
  TpaImportRowsResponseSchema,
  TpaImportSchema,
  emptyGhiQuoteTerms,
  emptyGhiRequirements,
} from '../src/shared/index.ts';
import ExcelJS from 'exceljs';
import { Types } from 'mongoose';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLogModel } from '../src/modules/audit/audit.model.ts';
import {
  ClaimEventModel,
  ClaimModel,
  ClaimNotificationModel,
} from '../src/modules/claims/claim.model.ts';
import { GhiCaseModel } from '../src/modules/ghi/ghi-case.model.ts';
import { GhiMemberModel } from '../src/modules/ghi/ghi-census.model.ts';
import { GhiQuoteModel } from '../src/modules/ghi/ghi-workflow.model.ts';
import { TpaClaimEventModel, TpaImportModel } from '../src/modules/tpa/tpa.model.ts';
import { bearer, createTestApp, tokenFor, useTestDatabase } from './helpers/app.ts';
import { FakeTransport } from './helpers/mail.ts';
import { seedMasters } from './helpers/masters.ts';

// TPA claims (N9), their place on the claims board (N11), the claims analysis over them (N10) and
// the protection of their sensitive data (N12), end to end on synthetic data: no client TPA file
// is available, so the layout below is made up for the test and proves nothing about a real TPA's
// layout (that check is BLOCKED, see docs/OPEN_ITEMS.md).

useTestDatabase();

const transport = new FakeTransport();
const app = createTestApp({}, undefined, transport);
const t = (path: string) => `/api/v1/tpa${path}`;

let admin: string;
let manager: string;
let viewer: string;
let readOnly: string;
let clientId: string;
let caseId: string;
let formatId: string;
const member: Record<string, string> = {};

const DIAGNOSIS = 'Acute appendicitis with peritonitis';
const ACCOUNT = '123456789012';

const HEADERS = [
  'Claim No',
  'Main Claim No',
  'Request Type',
  'Emp Code',
  'Patient Name',
  'Relation',
  'DOA',
  'DOD',
  'Ailment',
  'ICD Code',
  'Claim Type',
  'Hospital Name',
  'Claimed Amt',
  'Sanctioned Amt',
  'Settled Amt',
  'Settlement Date',
  'Claim Status',
  'Reason',
  'Bank A/c No',
] as const;
type Header = (typeof HEADERS)[number];
type Row = Partial<Record<Header, string | number | Date>>;

const FIELDS: Array<[string, Header]> = [
  ['tpaClaimId', 'Claim No'],
  ['parentClaimId', 'Main Claim No'],
  ['requestType', 'Request Type'],
  ['employeeId', 'Emp Code'],
  ['memberName', 'Patient Name'],
  ['relationship', 'Relation'],
  ['admissionDate', 'DOA'],
  ['dischargeDate', 'DOD'],
  ['diagnosis', 'Ailment'],
  ['icdCode', 'ICD Code'],
  ['claimType', 'Claim Type'],
  ['hospital', 'Hospital Name'],
  ['claimedAmount', 'Claimed Amt'],
  ['sanctionedAmount', 'Sanctioned Amt'],
  ['settledAmount', 'Settled Amt'],
  ['settlementDate', 'Settlement Date'],
  ['status', 'Claim Status'],
  ['rejectionReason', 'Reason'],
  ['bankAccount', 'Bank A/c No'],
];

const formatBody = {
  name: 'Synthetic TPA (test layout)',
  tpaCode: 'SYNA',
  sheetName: 'Claims',
  headerRow: 2,
  mappings: FIELDS.map(([field, header]) => ({
    field,
    header,
    required: field === 'tpaClaimId' || field === 'status',
  })),
  statusMap: [
    { source: 'Settled', status: 'SETTLED' },
    { source: 'Registration', status: 'OUTSTANDING' },
    { source: 'For Investigation', status: 'OUTSTANDING' },
    { source: 'Repudiated', status: 'REJECTED' },
  ],
  requestTypeMap: [
    { source: 'Main', requestType: 'MAIN' },
    { source: 'Pre-Auth', requestType: 'PRE_AUTH' },
  ],
  claimTypeMap: [
    { source: 'Cashless', claimType: 'CASHLESS' },
    { source: 'Reimbursement', claimType: 'REIMBURSEMENT' },
  ],
  relationshipMap: [
    { source: 'Self', relationship: 'SELF' },
    { source: 'Wife', relationship: 'SPOUSE' },
    { source: 'Father', relationship: 'FATHER' },
  ],
  boardStatusMap: [
    { source: 'Registration', boardStatus: 'SUBMITTED' },
    { source: 'For Investigation', boardStatus: 'INVESTIGATION' },
    { source: 'Settled', boardStatus: 'APPROVED' },
  ],
};

/** The first policy-year file: a settled, an outstanding (with its pre-auth), a rejected, an unknown employee, a bad status and a duplicate. */
const firstFile: Row[] = [
  {
    'Claim No': 'CL-1001',
    'Request Type': 'Main',
    'Emp Code': 'E001',
    'Patient Name': 'Ravi Kumar',
    Relation: 'Self',
    DOA: '10/05/2026',
    DOD: '14/05/2026',
    Ailment: DIAGNOSIS,
    'ICD Code': 'K35.8',
    'Claim Type': 'Cashless',
    'Hospital Name': 'Lakeview Hospital',
    'Claimed Amt': '1,00,000',
    'Sanctioned Amt': 90000,
    'Settled Amt': '85,000.00',
    'Settlement Date': '30/05/2026',
    'Claim Status': 'Settled',
    'Bank A/c No': ACCOUNT,
  },
  {
    'Claim No': 'CL-1002',
    'Request Type': 'Main',
    'Emp Code': 'E001',
    'Patient Name': 'Anita Kumar',
    Relation: 'Wife',
    DOA: new Date(Date.UTC(2026, 5, 2)),
    DOD: '06/06/2026',
    Ailment: 'Myocardial infarction',
    'ICD Code': 'I21.0',
    'Claim Type': 'Reimbursement',
    'Hospital Name': 'Lakeview Hospital',
    'Claimed Amt': 48500.5,
    'Claim Status': 'For Investigation',
  },
  {
    'Claim No': 'PA-1002',
    'Main Claim No': 'CL-1002',
    'Request Type': 'Pre-Auth',
    'Emp Code': 'E001',
    'Patient Name': 'Anita Kumar',
    Relation: 'Wife',
    DOA: '02/06/2026',
    'Claim Type': 'Cashless',
    'Hospital Name': 'Lakeview Hospital',
    'Claimed Amt': 40000,
    'Claim Status': 'Registration',
  },
  {
    'Claim No': 'CL-1003',
    'Request Type': 'Main',
    'Emp Code': 'E002',
    'Patient Name': 'Suresh Iyer',
    Relation: 'Father',
    DOA: '15/07/2026',
    DOD: '18/07/2026',
    'Claim Type': 'Reimbursement',
    'Hospital Name': 'City Care',
    'Claimed Amt': 20000,
    'Claim Status': 'Repudiated',
    Reason: 'Pre-existing condition not disclosed',
  },
  {
    'Claim No': 'CL-1004',
    'Request Type': 'Main',
    'Emp Code': 'E999',
    'Patient Name': 'Unknown Person',
    Relation: 'Self',
    DOA: '20/07/2026',
    'ICD Code': 'J18.9',
    'Claim Type': 'Cashless',
    'Hospital Name': 'City Care',
    'Claimed Amt': 30000,
    'Sanctioned Amt': 25000,
    'Claim Status': 'Registration',
  },
  { 'Claim No': 'CL-1005', 'Emp Code': 'E002', Relation: 'Self', 'Claim Status': 'Closed - Paid' },
  { 'Claim No': 'cl-1001', 'Emp Code': 'E001', Relation: 'Self', 'Claim Status': 'Settled' },
];

async function workbook(rows: Row[], headers: readonly string[] = HEADERS): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  book.addWorksheet('Summary').addRow(['Synthetic report: not a client file']);
  const sheet = book.addWorksheet('Claims');
  sheet.addRow(['Claims MIS as on 30/09/2026']);
  sheet.addRow([...headers]);
  for (const row of rows) sheet.addRow(headers.map((header) => row[header as Header] ?? null));
  return Buffer.from(await book.xlsx.writeBuffer());
}

const upload = (data: Buffer, token = manager, fileName = 'claims.xlsx') =>
  request(app)
    .post(t(`/imports?caseId=${caseId}&formatId=${formatId}&fileName=${fileName}`))
    .set(bearer(token))
    .set('Content-Type', 'application/octet-stream')
    .send(data);
const commit = (id: string, policy: 'ALL_VALID' | 'VALID_ONLY', token = manager) =>
  request(app)
    .post(t(`/imports/${id}/commit`))
    .set(bearer(token))
    .send({ policy });
const claims = async (token: string, query = '') =>
  TpaClaimListResponseSchema.parse(
    (
      await request(app)
        .get(t(`/claims?caseId=${caseId}${query}`))
        .set(bearer(token))
        .expect(200)
    ).body,
  ).items;
const byId = async (token = admin) =>
  new Map((await claims(token)).map((item) => [item.tpaClaimId, item]));
const binary = (req: request.Test) =>
  req.buffer(true).parse((res, done) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('end', () => done(null, Buffer.concat(chunks)));
  });

async function client(name: string, gstin: string) {
  const response = await request(app)
    .post('/api/v1/clients')
    .set(bearer(admin))
    .send({
      name,
      gstin,
      address: {
        line1: '1 Park Road',
        line2: '',
        city: 'Pune',
        state: 'Maharashtra',
        pincode: '411001',
      },
      contacts: [],
      natureOfBusiness: 'Software',
      occupancyCode: '2001',
    })
    .expect(201);
  return response.body.id as string;
}

let staffClaimId: string;

beforeAll(async () => {
  await seedMasters();
  const created = await tokenFor(app, ['ADMIN']);
  admin = created.token;
  const managerUser = await tokenFor(app, ['ACCOUNT_MANAGER']);
  manager = managerUser.token;
  viewer = (await tokenFor(app, ['MANAGER'])).token;
  readOnly = (await tokenFor(app, ['READ_ONLY'])).token;
  clientId = await client('Acme Health Group Pvt Ltd', '27AAPFU0939F1ZV');
  const insurer = await request(app)
    .post('/api/v1/insurers')
    .set(bearer(admin))
    .send({
      company: 'Arogya Health',
      branch: 'Pune',
      contacts: [],
      rfqEmails: ['rfq@arogya.example'],
    })
    .expect(201);
  const userId = new Types.ObjectId(managerUser.user.id);
  const insurerId = new Types.ObjectId(insurer.body.id as string);
  const caseObjectId = new Types.ObjectId();
  // The agreed final quote: premium ₹10,00,000 before GST.
  const quote = await GhiQuoteModel.create({
    caseId: caseObjectId,
    insurerId,
    version: 1,
    status: 'FINAL',
    kind: 'FINAL_AGREED',
    reason: null,
    basePremium: Types.Decimal128.fromString('1000000'),
    gstRatePercent: Types.Decimal128.fromString('18'),
    gst: Types.Decimal128.fromString('180000'),
    totalPremium: Types.Decimal128.fromString('1180000'),
    terms: emptyGhiQuoteTerms(),
    otherTerms: null,
    validUntil: null,
    attachmentIds: [],
    createdBy: userId,
    finalizedAt: new Date(),
    finalizedBy: userId,
  });
  await GhiCaseModel.create({
    _id: caseObjectId,
    reference: 'GHI-2026-7001',
    type: 'NEW',
    stage: 'PLACEMENT_SLIP',
    closedReason: null,
    clientId: new Types.ObjectId(clientId),
    ownerId: userId,
    policyStart: '2026-04-01',
    policyEnd: '2027-03-31',
    dueDate: '2026-03-15',
    existingInsurer: null,
    existingPolicyNumber: null,
    gstRatePercent: Types.Decimal128.fromString('18'),
    requirements: emptyGhiRequirements(),
    requirementsSaved: true,
    requirementsRevision: 1,
    censusRevision: 1,
    insurers: [],
    finalQcr: null,
    policy: {
      policyNumber: 'GMC/2026/0099',
      issuedOn: '2026-03-30',
      policyStart: '2026-04-01',
      policyEnd: '2027-03-31',
      renewalDate: '2027-04-01',
      insurerId,
      quoteId: quote._id,
      qcrId: new Types.ObjectId(),
      fileId: new Types.ObjectId(),
      census: {
        employees: 2,
        lives: 5,
        totalSumInsured: Types.Decimal128.fromString('1000000'),
        revision: 1,
      },
      recordedAt: new Date(),
      recordedBy: userId,
    },
    activity: [],
    createdBy: userId,
    updatedBy: userId,
  });
  caseId = caseObjectId.toHexString();
  const rows = [
    ['E001', 'Ravi Kumar', 'MALE', '1988-02-10', 'SELF'],
    ['E001', 'Anita Kumar', 'FEMALE', '1990-07-01', 'SPOUSE'],
    ['E001', 'Kabir Kumar', 'MALE', '2016-09-12', 'CHILD'],
    ['E002', 'Meena Iyer', 'FEMALE', '1985-11-23', 'SELF'],
    ['E002', 'Suresh Iyer', 'MALE', '1955-01-05', 'FATHER'],
  ] as const;
  const members = await GhiMemberModel.insertMany(
    rows.map(([employeeId, name, gender, dateOfBirth, relationship]) => ({
      caseId: caseObjectId,
      employeeId,
      employeeKey: employeeId,
      name,
      nameKey: name.toLowerCase(),
      gender,
      dateOfBirth,
      relationship,
      dateOfJoining: null,
      sumInsured: relationship === 'SELF' ? Types.Decimal128.fromString('500000') : null,
      source: 'MANUAL',
      importId: null,
      createdBy: userId,
      updatedBy: userId,
    })),
  );
  [member.ravi, member.anita, member.kabir, member.meena, member.suresh] = members.map((item) =>
    item._id.toHexString(),
  ) as [string, string, string, string, string];
  // A claim staff put on the board before any TPA file: Anita, admitted 2 June.
  const staffClaim = await request(app)
    .post('/api/v1/claims')
    .set(bearer(manager))
    .send({
      clientId,
      ghiCaseId: caseId,
      employeeMemberId: member.ravi,
      patientMemberId: member.anita,
      hospital: { name: 'Lakeview Hospital', city: 'Pune' },
      admissionDate: '2026-06-02',
      dischargeDate: '2026-06-06',
      claimType: 'REIMBURSEMENT',
      amountClaimed: '48500.50',
      contactEmail: 'ravi.kumar@acme.example',
      contactPhone: '+91 98765 43210',
    })
    .expect(201);
  staffClaimId = staffClaim.body.id as string;
});

describe('TPA formats (N9 1)', () => {
  it('lets only Admins configure formats, refuses a format without claim ID and status, and audits refusals', async () => {
    await request(app).get(t('/formats')).expect(401);
    await request(app).get(t('/formats')).set(bearer(readOnly)).expect(403);
    await request(app).post(t('/formats')).set(bearer(manager)).send(formatBody).expect(403);
    await request(app)
      .post(t('/formats'))
      .set(bearer(admin))
      .send({
        ...formatBody,
        mappings: formatBody.mappings.filter((item) => item.field !== 'status'),
      })
      .expect(400);
    const created = await request(app)
      .post(t('/formats'))
      .set(bearer(admin))
      .send(formatBody)
      .expect(201);
    formatId = created.body.id as string;
    await request(app)
      .post(t('/formats'))
      .set(bearer(admin))
      .send({ ...formatBody, name: ' synthetic TPA (TEST LAYOUT) ' })
      .expect(409);
    // Another layout of the same TPA is another format under the same code (its claims stay one set).
    await request(app)
      .post(t('/formats'))
      .set(bearer(admin))
      .send({ ...formatBody, name: 'Synthetic TPA, older layout', headerRow: 1 })
      .expect(201);
    const denied = await AuditLogModel.find({ action: 'CLAIM_ACCESS_DENIED' }).lean();
    expect(denied.length).toBeGreaterThanOrEqual(2);
    expect(denied.map((entry) => entry.after)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ permission: 'claims.process', outcome: 'DENIED' }),
        expect.objectContaining({ permission: 'claims.admin', outcome: 'DENIED' }),
      ]),
    );
  });

  it('reads the headers of a file in another layout and suggests columns, without importing anything', async () => {
    const other = new ExcelJS.Workbook();
    other.addWorksheet('Report').addRows([
      ['Claim Number', 'Employee Code', 'Claim Status', 'Date of Admission'],
      ['X1', 'E001', 'Settled', '01/05/2026'],
      ['X2', 'E002', 'Query Raised', '02/05/2026'],
      ['X3', 'E003', 'Settled', '03/05/2026'],
    ]);
    const response = await request(app)
      .post(t('/inspect?fileName=other.xlsx&headerRow=1'))
      .set(bearer(manager))
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from(await other.xlsx.writeBuffer()))
      .expect(200);
    expect(response.body.sheets).toEqual(['Report']);
    expect(response.body.headers).toEqual([
      'Claim Number',
      'Employee Code',
      'Claim Status',
      'Date of Admission',
    ]);
    expect(response.body.suggestions).toEqual(
      expect.arrayContaining([
        { field: 'tpaClaimId', header: 'Claim Number' },
        { field: 'status', header: 'Claim Status' },
      ]),
    );
    // The statuses in the file, to map each one (from every row, not only the sample).
    expect(response.body.statusValues).toEqual([
      { value: 'Settled', rows: 2 },
      { value: 'Query Raised', rows: 1 },
    ]);
    expect(await TpaImportModel.countDocuments()).toBe(0);
  });
});

describe('upload, preview and validation (N9 2 to 5)', () => {
  it('refuses a file missing a required column or not an Excel file, keeping nothing', async () => {
    const noStatus = await upload(
      await workbook(
        firstFile,
        HEADERS.filter((header) => header !== 'Claim Status'),
      ),
    ).expect(422);
    expect(JSON.stringify(noStatus.body)).toContain('Claim Status');
    await upload(Buffer.from('not a workbook')).expect(422);
    expect(await TpaImportModel.countDocuments()).toBe(0);
  });

  let importId: string;
  it('checks every row, flags bad statuses, duplicates and unknown employees, and keeps the diagnosis and bank account out of messages', async () => {
    const created = TpaImportSchema.parse(
      (await upload(await workbook(firstFile)).expect(201)).body,
    );
    importId = created.id;
    expect(created).toMatchObject({
      status: 'VALIDATED',
      counts: { rows: 7, valid: 5, invalid: 2, warnings: 1, create: 5, update: 0, unchanged: 0 },
    });
    const errors = TpaImportRowsResponseSchema.parse(
      (
        await request(app)
          .get(t(`/imports/${importId}/rows?only=ERRORS`))
          .set(bearer(manager))
          .expect(200)
      ).body,
    ).items;
    expect(errors.map((row) => [row.row, row.issues.map((issue) => issue.code)])).toEqual([
      [8, ['UNSUPPORTED_STATUS']],
      [9, ['DUPLICATE_IN_FILE']],
    ]);
    const warnings = TpaImportRowsResponseSchema.parse(
      (
        await request(app)
          .get(t(`/imports/${importId}/rows?only=WARNINGS`))
          .set(bearer(manager))
          .expect(200)
      ).body,
    ).items;
    expect(warnings.map((row) => row.tpaClaimId)).toEqual(['CL-1004']);
    expect(warnings[0]!.issues[0]!.code).toBe('MEMBER_NOT_FOUND');
  });

  it('shows the preview with the bank account masked for processors and in full only to Admins; viewers get no preview', async () => {
    const preview = async (token: string) =>
      TpaImportRowsResponseSchema.parse(
        (
          await request(app)
            .get(t(`/imports/${importId}/rows`))
            .set(bearer(token))
            .expect(200)
        ).body,
      ).items[0]!.values;
    expect(await preview(manager)).toMatchObject({
      diagnosis: DIAGNOSIS,
      bankAccount: 'XXXXXXXX9012',
    });
    expect((await preview(admin)).bankAccount).toBe(ACCOUNT);
    await request(app)
      .get(t(`/imports/${importId}/rows`))
      .set(bearer(viewer))
      .expect(403);
  });

  it('downloads the problems as Excel without private values, and audits the download', async () => {
    const response = await binary(
      request(app)
        .get(t(`/imports/${importId}/error-report`))
        .set(bearer(manager)),
    ).expect(200);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(response.body as ArrayBuffer);
    const values = book.getWorksheet('Problems')!.getSheetValues().flat().map(String).join('|');
    expect(values).toContain('CL-1005');
    expect(values).not.toContain(ACCOUNT);
    expect(values).not.toContain(DIAGNOSIS);
    expect(
      await AuditLogModel.countDocuments({
        action: 'TPA_ERROR_REPORT_DOWNLOADED',
        entityId: importId,
      }),
    ).toBe(1);
  });

  it('refuses to import all rows while some are invalid, and refuses a second import while one is running', async () => {
    await commit(importId, 'ALL_VALID').expect(409);
    // Another import for the same policy and TPA, caught mid-run.
    const running = TpaImportSchema.parse(
      (await upload(await workbook(firstFile.slice(0, 1)), manager, 'other.xlsx').expect(201)).body,
    );
    await TpaImportModel.updateOne({ _id: running.id }, { $set: { status: 'IMPORTING' } });
    const blocked = await commit(importId, 'VALID_ONLY').expect(409);
    expect(blocked.body.message).toContain('Another import');
    await TpaImportModel.updateOne({ _id: running.id }, { $set: { status: 'DISCARDED' } });
    expect((await TpaImportModel.findById(importId).lean())!.status).toBe('VALIDATED');
  });

  it('imports the valid rows: links the pre-auth to its main claim and the board claim staff made, adds a settled claim to the board, and sends no email by default', async () => {
    const result = TpaImportSchema.parse((await commit(importId, 'VALID_ONLY').expect(200)).body);
    expect(result.status).toBe('IMPORTED');
    expect(result.result).toMatchObject({
      created: 5,
      updated: 0,
      unchanged: 0,
      skipped: 2,
      failed: 0,
    });
    // Board: CL-1001 added (Settled → Approved); CL-1002 moves the staff claim Form → Investigation;
    // PA-1002 follows CL-1002; CL-1003 "Repudiated" has no column; CL-1004 is not in the census.
    expect(result.result!.board).toMatchObject({
      created: 1,
      moved: 1,
      unchanged: 1,
      notMapped: 1,
      review: 1,
      failed: 0,
      emailsQueued: 0,
    });
    expect(result.result!.unmappedBoardStatuses).toEqual([{ source: 'Repudiated', rows: 1 }]);
    await commit(importId, 'VALID_ONLY').expect(409);

    const records = await byId();
    expect(records.get('PA-1002')).toMatchObject({
      requestType: 'PRE_AUTH',
      parent: { state: 'LINKED', id: records.get('CL-1002')!.id },
      board: { state: 'NONE' },
    });
    expect(records.get('CL-1002')!.board).toMatchObject({ state: 'LINKED', claimId: staffClaimId });
    expect(records.get('CL-1003')!.boardNote).toContain('"Repudiated" has no board column');
    expect(records.get('CL-1004')).toMatchObject({
      member: { match: 'NOT_FOUND' },
      board: { state: 'NONE' },
    });
    expect(records.get('CL-1004')!.boardNote).toContain('not matched');

    const staff = ClaimDetailSchema.parse(
      (await request(app).get(`/api/v1/claims/${staffClaimId}`).set(bearer(manager)).expect(200))
        .body,
    );
    expect(staff).toMatchObject({
      status: 'INVESTIGATION',
      source: 'STAFF',
      settlement: { state: 'NOT_SETTLED' },
      tpa: { tpaClaimId: 'CL-1002', sourceStatus: 'For Investigation' },
    });
    const created = await ClaimModel.findOne({ 'tpa.tpaClaimId': 'CL-1001' }).lean();
    expect(created).toMatchObject({
      status: 'APPROVED',
      source: 'TPA_IMPORT',
      contactEmail: null,
      assignedTo: null,
    });
    expect(created!.settlement).toMatchObject({ state: 'SETTLED', date: '2026-05-30' });
    expect(created!.settlement!.amount!.toString()).toBe('85000.00');
    expect(await ClaimModel.countDocuments({ ghiCaseId: new Types.ObjectId(caseId) })).toBe(2);
    expect(await ClaimNotificationModel.countDocuments()).toBe(0);
    expect(transport.calls).toBe(0);
    const event = await ClaimEventModel.findOne({
      claimId: new Types.ObjectId(staffClaimId),
      type: 'TPA_IMPORT',
    }).lean();
    expect(event!.detail).toContain(
      'no email: import status-change email is off (open question N11-2)',
    );
  });

  it('re-imports: updates only what changed, keeps staff notes, never moves a board claim back, and emails once when enabled', async () => {
    const records = await byId();
    await request(app)
      .put(t(`/claims/${records.get('CL-1004')!.id}/link`))
      .set(bearer(manager))
      .send({ reviewNote: 'Employee joined mid-year: HR to confirm' })
      .expect(200);
    await request(app)
      .put(t('/settings'))
      .set(bearer(manager))
      .send({ notifyOnImportStatusChange: true, notifyOnImportCreate: false })
      .expect(403);
    await request(app)
      .put(t('/settings'))
      .set(bearer(admin))
      .send({ notifyOnImportStatusChange: true, notifyOnImportCreate: false })
      .expect(200);
    const second = firstFile.slice(0, 5).map((row) =>
      row['Claim No'] === 'CL-1002'
        ? {
            ...row,
            'Claim Status': 'Settled',
            'Settled Amt': '45,000',
            'Settlement Date': '25/09/2026',
          }
        : row['Claim No'] === 'CL-1004'
          ? { ...row, 'Claimed Amt': 32000 }
          : row,
    );
    const uploaded = TpaImportSchema.parse(
      (await upload(await workbook(second), manager, 'claims-sep.xlsx').expect(201)).body,
    );
    expect(uploaded.counts).toMatchObject({
      rows: 5,
      create: 0,
      update: 2,
      unchanged: 3,
      invalid: 0,
    });
    const eventsBefore = await TpaClaimEventModel.countDocuments();
    const result = TpaImportSchema.parse((await commit(uploaded.id, 'ALL_VALID').expect(200)).body);
    expect(result.result).toMatchObject({ created: 0, updated: 2, unchanged: 3 });
    expect(result.result!.board).toMatchObject({ moved: 1, emailsQueued: 1 });
    expect(await TpaClaimEventModel.countDocuments()).toBe(eventsBefore + 2);
    const after = await byId();
    expect(after.get('CL-1004')).toMatchObject({
      claimedAmount: '32000.00',
      reviewNote: 'Employee joined mid-year: HR to confirm',
    });
    expect(after.get('CL-1002')!.id).toBe(records.get('CL-1002')!.id);
    const history = TpaClaimHistorySchema.parse(
      (
        await request(app)
          .get(t(`/claims/${after.get('CL-1002')!.id}/history`))
          .set(bearer(manager))
          .expect(200)
      ).body,
    );
    expect(history.items.map((item) => item.type)).toEqual(['CREATED', 'UPDATED']);
    expect(history.items[1]).toMatchObject({ fromStatus: 'OUTSTANDING', toStatus: 'SETTLED' });

    const staff = await ClaimModel.findById(staffClaimId).lean();
    expect(staff).toMatchObject({
      status: 'APPROVED',
      settlement: { state: 'SETTLED', date: '2026-09-25' },
    });
    // One email set for the one move; no diagnosis anywhere in what was sent.
    expect(
      await ClaimNotificationModel.countDocuments({ claimId: new Types.ObjectId(staffClaimId) }),
    ).toBeGreaterThan(0);
    const sent = JSON.stringify(transport.sent);
    expect(transport.sent.length).toBeGreaterThan(0);
    expect(sent).not.toContain('appendicitis');
    expect(sent).not.toContain('Myocardial');
    expect(sent).not.toContain('I21');
    expect(sent).not.toContain(ACCOUNT);

    // The same file again: nothing changes, no event, no email.
    const notified = transport.sent.length;
    const again = TpaImportSchema.parse(
      (await upload(await workbook(second), manager, 'claims-sep-again.xlsx').expect(201)).body,
    );
    expect(again.counts).toMatchObject({ update: 0, unchanged: 5 });
    const eventsNow = await TpaClaimEventModel.countDocuments();
    const boardEvents = await ClaimEventModel.countDocuments();
    await commit(again.id, 'ALL_VALID').expect(200);
    expect(await TpaClaimEventModel.countDocuments()).toBe(eventsNow);
    expect(await ClaimEventModel.countDocuments()).toBe(boardEvents);
    expect(transport.sent.length).toBe(notified);

    // The TPA reopens CL-1002 ("Registration"): the record follows, the board claim stays Approved.
    const reopened = second.map((row) =>
      row['Claim No'] === 'CL-1002' ? { ...row, 'Claim Status': 'Registration' } : row,
    );
    const third = TpaImportSchema.parse(
      (await upload(await workbook(reopened), manager, 'claims-oct.xlsx').expect(201)).body,
    );
    const thirdResult = TpaImportSchema.parse(
      (await commit(third.id, 'ALL_VALID').expect(200)).body,
    );
    expect(thirdResult.result!.board).toMatchObject({ moved: 0, emailsQueued: 0 });
    expect((await ClaimModel.findById(staffClaimId).lean())!.status).toBe('APPROVED');
    expect((await byId()).get('CL-1002')!.status).toBe('OUTSTANDING');
    expect(transport.sent.length).toBe(notified);
    // Put CL-1002 back to settled for the analysis below.
    const fourth = TpaImportSchema.parse(
      (await upload(await workbook(second), manager, 'claims-oct-2.xlsx').expect(201)).body,
    );
    await commit(fourth.id, 'ALL_VALID').expect(200);
    await request(app)
      .put(t('/settings'))
      .set(bearer(admin))
      .send({ notifyOnImportStatusChange: false, notifyOnImportCreate: false })
      .expect(200);
  });
});

describe('sensitive data (N12)', () => {
  it('shows the diagnosis only to processors and the full bank account only to Admins, on list and detail', async () => {
    const forViewer = (await byId(viewer)).get('CL-1001')!;
    expect(forViewer).toMatchObject({
      diagnosis: null,
      icdCode: null,
      rejectionReason: null,
      bankAccount: 'XXXXXXXX9012',
      icdChapter: 'XI',
    });
    expect((await byId(viewer)).get('CL-1003')!.rejectionReason).toBeNull();
    const forManager = (await byId(manager)).get('CL-1001')!;
    expect(forManager).toMatchObject({
      diagnosis: DIAGNOSIS,
      icdCode: 'K35.8',
      bankAccount: 'XXXXXXXX9012',
    });
    const detail = await request(app)
      .get(t(`/claims/${forManager.id}`))
      .set(bearer(admin))
      .expect(200);
    expect(detail.body.bankAccount).toBe(ACCOUNT);
    const viewerDetail = await request(app)
      .get(t(`/claims/${forManager.id}`))
      .set(bearer(viewer))
      .expect(200);
    expect(JSON.stringify(viewerDetail.body)).not.toContain(ACCOUNT);
    expect(JSON.stringify(viewerDetail.body)).not.toContain('appendicitis');
    await request(app)
      .get(t(`/claims?caseId=${caseId}`))
      .set(bearer(readOnly))
      .expect(403);
  });

  it('masks the patient’s date of birth and phone on board claims for users who do not process claims', async () => {
    const forViewer = ClaimDetailSchema.parse(
      (await request(app).get(`/api/v1/claims/${staffClaimId}`).set(bearer(viewer)).expect(200))
        .body,
    );
    expect(forViewer.patient.dateOfBirth).toBeNull();
    expect(forViewer.contactPhone).toBe('XXXXXXXX3210');
    const forManager = ClaimDetailSchema.parse(
      (await request(app).get(`/api/v1/claims/${staffClaimId}`).set(bearer(manager)).expect(200))
        .body,
    );
    expect(forManager.patient.dateOfBirth).toBe('1990-07-01');
  });

  it('audits every view and refusal, and never puts a diagnosis or a full bank account in the audit trail', async () => {
    expect(
      await AuditLogModel.countDocuments({ action: 'TPA_CLAIM_VIEWED', 'after.part': 'history' }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      await AuditLogModel.countDocuments({ action: 'TPA_CLAIM_VIEWED' }),
    ).toBeGreaterThanOrEqual(2);
    expect(await AuditLogModel.countDocuments({ action: 'CLAIMS_LISTED' })).toBeGreaterThan(0);
    expect(
      await AuditLogModel.countDocuments({ action: 'CLAIM_VIEWED', entityId: staffClaimId }),
    ).toBeGreaterThanOrEqual(2);
    const refused = await AuditLogModel.find({ action: 'CLAIM_ACCESS_DENIED' }).lean();
    expect(
      refused.some((entry) => JSON.stringify(entry.after).includes('/api/v1/tpa/claims')),
    ).toBe(true);
    const all = JSON.stringify(await AuditLogModel.find().lean());
    for (const secret of [
      ACCOUNT,
      DIAGNOSIS,
      'Myocardial',
      'K35.8',
      'Pre-existing condition not disclosed',
      '98765 43210',
    ]) {
      expect(all).not.toContain(secret);
    }
  });
});

describe('claims analysis over the imported claims (N10)', () => {
  it('counts each claim once, earns the premium by days and works out both ICRs from the stored figures', async () => {
    await request(app)
      .post(`/api/v1/claims-analysis/premium/${caseId}`)
      .set(bearer(viewer))
      .send({ kind: 'ADDITION', amount: '36500', effectiveDate: '2026-07-01', reference: 'END-01' })
      .expect(403);
    await request(app)
      .post(`/api/v1/claims-analysis/premium/${caseId}`)
      .set(bearer(manager))
      .send({ kind: 'ADDITION', amount: '36500', effectiveDate: '2027-05-01', reference: 'END-00' })
      .expect(400);
    await request(app)
      .post(`/api/v1/claims-analysis/premium/${caseId}`)
      .set(bearer(manager))
      .send({ kind: 'ADDITION', amount: '36500', effectiveDate: '2026-07-01', reference: 'END-01' })
      .expect(201);
    const response = ClaimsAnalysisResponseSchema.parse(
      (
        await request(app)
          .get(`/api/v1/claims-analysis?caseId=${caseId}&asOf=2026-09-30`)
          .set(bearer(viewer))
          .expect(200)
      ).body,
    );
    const { analysis } = response;
    const status = Object.fromEntries(analysis.status.map((row) => [row.key, row.count]));
    // Counted: CL-1001 and CL-1002 settled, CL-1003 rejected, CL-1004 outstanding; PA-1002 is part of CL-1002.
    expect(analysis.reported.count).toBe(4);
    expect(analysis.notCounted).toBe(1);
    expect(status).toMatchObject({ SETTLED: 2, OUTSTANDING: 1, REJECTED: 1 });
    // Paid 85,000 + 45,000; outstanding CL-1004 sanctioned 25,000.
    expect(analysis.icr).toMatchObject({
      paid: '130000.00',
      outstanding: '25000.00',
      incurred: '155000.00',
    });
    // Premium: 10,00,000 + 36,500 = 10,36,500. Earned to 30/09/2026: 10,00,000 × 183/365 = 5,01,369.86
    // and 36,500 × 92/274 = 12,255.47, together 5,13,625.33.
    expect(analysis.premium).toMatchObject({
      base: '1000000.00',
      total: '1036500.00',
      prorated: '513625.33',
      daysElapsed: 183,
      policyDays: 365,
    });
    // 1,55,000 ÷ 10,36,500 = 14.954…% and 1,55,000 ÷ 5,13,625.33 = 30.177…%.
    expect(analysis.icr.total.percent).toBe('14.95');
    expect(analysis.icr.prorated.percent).toBe('30.18');
    const band = (label: string) =>
      analysis.ageBands.find((row) => row.label === label)?.count ?? 0;
    expect([band('31–40'), band('Above 70'), band('Age not known')]).toEqual([2, 1, 1]);
    expect(analysis.disease.find((row) => row.key === 'UNCLASSIFIED')?.count).toBe(1);
    expect(response.header.diagnosisVisible).toBe(false);
    expect(
      response.details.items.every((item) => item.diagnosis === null && item.icdCode === null),
    ).toBe(true);
    expect(response.header.unreportedBoardClaims).toBe(0);
    const filtered = ClaimsAnalysisResponseSchema.parse(
      (
        await request(app)
          .get(`/api/v1/claims-analysis?caseId=${caseId}&asOf=2026-09-30&member=DEPENDANT`)
          .set(bearer(manager))
          .expect(200)
      ).body,
    );
    expect(filtered.analysis.reported.count).toBe(2);
    expect(filtered.details.items.find((item) => item.tpaClaimId === 'CL-1002')!.icdCode).toBe(
      'I21.0',
    );
  });

  it('downloads the analysis with diagnosis columns only for processors, and audits it', async () => {
    const download = async (token: string) => {
      const response = await binary(
        request(app)
          .get(`/api/v1/claims-analysis/document?caseId=${caseId}&asOf=2026-09-30`)
          .set(bearer(token)),
      ).expect(200);
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(response.body as ArrayBuffer);
      return book.worksheets
        .map((sheet) => sheet.getSheetValues().flat().map(String).join('|'))
        .join('\n');
    };
    const forViewer = await download(viewer);
    expect(forViewer).toContain('CL-1001');
    expect(forViewer).not.toContain(DIAGNOSIS);
    expect(forViewer).not.toContain('K35.8');
    expect(forViewer).not.toContain(ACCOUNT);
    expect(await download(manager)).toContain(DIAGNOSIS);
    const pdf = await binary(
      request(app)
        .get(`/api/v1/claims-analysis/document?caseId=${caseId}&asOf=2026-09-30&format=pdf`)
        .set(bearer(viewer)),
    ).expect(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    expect(await AuditLogModel.countDocuments({ action: 'CLAIMS_ANALYSIS_DOWNLOADED' })).toBe(3);
    await request(app)
      .get(`/api/v1/claims-analysis/document?caseId=${caseId}`)
      .set(bearer(readOnly))
      .expect(403);
  });
});
