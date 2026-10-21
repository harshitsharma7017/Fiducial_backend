import {
  RenewalAnalysisSchema,
  RenewalOptionsResponseSchema,
  SavedRenewalReportSchema,
  emptyGhiQuoteTerms,
  emptyGhiRequirements,
} from '../src/shared/index.ts';
import ExcelJS from 'exceljs';
import { Types } from 'mongoose';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLogModel } from '../src/modules/audit/audit.model.ts';
import { GhiCaseModel } from '../src/modules/ghi/ghi-case.model.ts';
import { GhiMemberModel } from '../src/modules/ghi/ghi-census.model.ts';
import { GhiQuoteModel } from '../src/modules/ghi/ghi-workflow.model.ts';
import { bearer, createTestApp, tokenFor, useTestDatabase } from './helpers/app.ts';
import { seedMasters } from './helpers/masters.ts';

// The three-year benefit and cost analysis (N8) on synthetic data: two years recorded by hand
// (before the app), the year placed in the app, and the coming year's quotes. No client renewal
// template is available: the sheet's layout is ours and its match to a client layout is BLOCKED.

useTestDatabase();

const app = createTestApp();
let admin: string;
let manager: string;
let approver: string;
let readOnly: string;
let clientId: string;
let placedCaseId: string;
let renewalCaseId: string;
const years: Record<string, string> = {};

const r = (path: string) => `/api/v1/renewal${path}`;
const binary = (req: request.Test) =>
  req.buffer(true).parse((res, done) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('end', () => done(null, Buffer.concat(chunks)));
  });

const recorded = (overrides: Record<string, unknown> = {}) => ({
  clientId,
  product: 'GMC',
  policyStart: '2023-04-01',
  policyEnd: '2024-03-31',
  insurerName: 'Old Insurer Ltd',
  policyNumber: 'OLD/23/001',
  employees: 126,
  lives: 380,
  totalSumInsured: '63000000',
  bySumInsured: [
    { amount: '300000', families: 60, lives: 180 },
    { amount: '700000', families: 66, lives: 200 },
  ],
  premiumBeforeGst: '2520000',
  gst: '453600',
  claimsPaid: '2016000',
  claimsOutstanding: '0',
  claimsCount: 40,
  claimsAsOf: '2024-06-30',
  source: 'Insurer renewal letter, 2024',
  ...overrides,
});

async function quote(
  caseId: Types.ObjectId,
  insurerId: string,
  base: string,
  userId: Types.ObjectId,
) {
  const premium = Types.Decimal128.fromString(base);
  const gst = (Number(base) * 0.18).toFixed(2);
  return GhiQuoteModel.create({
    caseId,
    insurerId: new Types.ObjectId(insurerId),
    version: 1,
    status: 'FINAL',
    kind: 'QUOTE',
    reason: null,
    basePremium: premium,
    gstRatePercent: Types.Decimal128.fromString('18'),
    gst: Types.Decimal128.fromString(gst),
    totalPremium: Types.Decimal128.fromString((Number(base) + Number(gst)).toFixed(2)),
    terms: emptyGhiQuoteTerms(),
    otherTerms: null,
    validUntil: null,
    attachmentIds: [],
    createdBy: userId,
    finalizedAt: new Date(),
    finalizedBy: userId,
  });
}

beforeAll(async () => {
  await seedMasters();
  admin = (await tokenFor(app, ['ADMIN'])).token;
  const created = await tokenFor(app, ['ACCOUNT_MANAGER']);
  manager = created.token;
  approver = (await tokenFor(app, ['MANAGER'])).token;
  readOnly = (await tokenFor(app, ['READ_ONLY'])).token;
  const userId = new Types.ObjectId(created.user.id);
  clientId = (
    await request(app)
      .post('/api/v1/clients')
      .set(bearer(admin))
      .send({
        name: 'Renewal Works Pvt Ltd',
        gstin: '27AAPFU0939F1ZV',
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
      .expect(201)
  ).body.id as string;
  const insurer = async (company: string) =>
    (
      await request(app)
        .post('/api/v1/insurers')
        .set(bearer(admin))
        .send({
          company,
          branch: 'Pune',
          contacts: [],
          rfqEmails: [`rfq@${company.split(' ')[0]!.toLowerCase()}.example`],
        })
        .expect(201)
    ).body.id as string;
  const current = await insurer('Arogya Health');
  const challenger = await insurer('Bharat Cover');
  // The year placed in the app: 2025-26, premium ₹10,00,000 before GST, two families.
  const placed = new Types.ObjectId();
  const agreed = await quote(placed, current, '1000000', userId);
  const caseBase = {
    type: 'NEW' as const,
    closedReason: null,
    clientId: new Types.ObjectId(clientId),
    ownerId: userId,
    dueDate: '2025-03-15',
    existingInsurer: null,
    existingPolicyNumber: null,
    gstRatePercent: Types.Decimal128.fromString('18'),
    requirements: emptyGhiRequirements(),
    requirementsSaved: true,
    requirementsRevision: 1,
    censusRevision: 1,
    insurers: [],
    finalQcr: null,
    activity: [],
    createdBy: userId,
    updatedBy: userId,
  };
  await GhiCaseModel.create({
    ...caseBase,
    _id: placed,
    reference: 'GHI-2025-0101',
    stage: 'PLACEMENT_SLIP',
    policyStart: '2025-04-01',
    policyEnd: '2026-03-31',
    policy: {
      policyNumber: 'GMC/2025/0101',
      issuedOn: '2025-03-30',
      policyStart: '2025-04-01',
      policyEnd: '2026-03-31',
      renewalDate: '2026-04-01',
      insurerId: new Types.ObjectId(current),
      quoteId: agreed._id,
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
  });
  placedCaseId = placed.toHexString();
  await GhiMemberModel.insertMany(
    [
      ['E001', 'Ravi Kumar', 'MALE', '1988-02-10', 'SELF', '500000'],
      ['E001', 'Anita Kumar', 'FEMALE', '1990-07-01', 'SPOUSE', '500000'],
      ['E001', 'Kabir Kumar', 'MALE', '2016-09-12', 'CHILD', '500000'],
      ['E002', 'Meena Iyer', 'FEMALE', '1985-11-23', 'SELF', '500000'],
      ['E002', 'Suresh Iyer', 'MALE', '1955-01-05', 'FATHER', '500000'],
    ].map(([employeeId, name, gender, dateOfBirth, relationship, sumInsured]) => ({
      caseId: placed,
      employeeId,
      employeeKey: employeeId,
      name,
      nameKey: name!.toLowerCase(),
      gender,
      dateOfBirth,
      relationship,
      dateOfJoining: null,
      sumInsured: Types.Decimal128.fromString(sumInsured!),
      source: 'MANUAL',
      importId: null,
      createdBy: userId,
      updatedBy: userId,
    })),
  );
  // The coming year: an open renewal case with two insurers' final quotes.
  const renewal = new Types.ObjectId();
  await GhiCaseModel.create({
    ...caseBase,
    _id: renewal,
    type: 'RENEWAL',
    reference: 'GHI-2026-0202',
    stage: 'QCR',
    policyStart: '2026-04-01',
    policyEnd: '2027-03-31',
    policy: null,
  });
  await quote(renewal, current, '1100000', userId);
  await quote(renewal, challenger, '950000', userId);
  renewalCaseId = renewal.toHexString();
});

describe('policy years recorded by hand (N8)', () => {
  it('lets staff who edit proposals record a year, checks its figures, and audits it', async () => {
    await request(app).post(r('/years')).set(bearer(readOnly)).send(recorded()).expect(403);
    await request(app).post(r('/years')).set(bearer(approver)).send(recorded()).expect(403);
    const badLives = await request(app)
      .post(r('/years'))
      .set(bearer(manager))
      .send(recorded({ lives: 100 }))
      .expect(400);
    expect(JSON.stringify(badLives.body)).toContain('Insured lives include the employees');
    await request(app)
      .post(r('/years'))
      .set(bearer(manager))
      .send(recorded({ claimsAsOf: null }))
      .expect(400);
    years.first = (
      await request(app).post(r('/years')).set(bearer(manager)).send(recorded()).expect(201)
    ).body.id as string;
    years.second = (
      await request(app)
        .post(r('/years'))
        .set(bearer(manager))
        .send(
          recorded({
            policyStart: '2024-04-01',
            policyEnd: '2025-03-31',
            policyNumber: 'OLD/24/001',
            employees: 145,
            lives: 420,
            totalSumInsured: '72500000',
            bySumInsured: null,
            premiumBeforeGst: '2900000',
            gst: '522000',
            claimsPaid: '2000000',
            claimsOutstanding: '30000',
            claimsCount: 50,
            claimsAsOf: '2025-06-30',
          }),
        )
        .expect(201)
    ).body.id as string;
    expect(await AuditLogModel.countDocuments({ action: 'POLICY_YEAR_RECORDED' })).toBe(2);
  });

  it('offers the recorded years, the placed year and the open renewal with its quotes', async () => {
    const options = RenewalOptionsResponseSchema.parse(
      (
        await request(app)
          .get(r(`/options?clientId=${clientId}&product=GMC`))
          .set(bearer(readOnly))
          .expect(200)
      ).body,
    );
    expect(options.years.map((year) => [year.source, year.policyStart])).toEqual([
      ['POLICY', '2025-04-01'],
      ['RECORDED', '2024-04-01'],
      ['RECORDED', '2023-04-01'],
    ]);
    expect(options.upcoming).toEqual([
      expect.objectContaining({ caseId: renewalCaseId, quotes: 2 }),
    ]);
  });
});

describe('the analysis (N8)', () => {
  const body = () => ({
    clientId,
    product: 'GMC',
    years: [
      { source: 'RECORDED', id: years.first },
      { source: 'RECORDED', id: years.second },
      { source: 'POLICY', id: placedCaseId },
    ],
    upcomingCaseId: renewalCaseId,
    asOf: '2026-09-30',
  });

  it('works out every year’s figures and the changes, with reasons where data is missing', async () => {
    const analysis = RenewalAnalysisSchema.parse(
      (await request(app).post(r('/analysis')).set(bearer(readOnly)).send(body()).expect(200)).body,
    );
    const [first, second, third] = analysis.years;
    expect(first).toMatchObject({
      employees: { value: '126' },
      dependants: { value: '254' },
      premiumWithGst: { value: '2973600.00' },
      premiumPerFamily: { value: '20000.00' },
      premiumPerLife: { value: '6631.58' },
      premiumPerLakh: { value: '4000.00' },
      claimsRatio: { value: '80.00' },
    });
    expect(first!.bySumInsured).toEqual([
      { amount: '300000', families: 60, lives: 180 },
      { amount: '700000', families: 66, lives: 200 },
    ]);
    // (20,00,000 + 30,000) ÷ 29,00,000 = 70.00%.
    expect(second).toMatchObject({
      claimsToDate: { value: '2030000.00' },
      claimsRatio: { value: '70.00' },
    });
    // The placed year: its census and agreed premium; no TPA file imported, so no claims figure.
    expect(third).toMatchObject({
      source: 'POLICY',
      employees: { value: '2' },
      lives: { value: '5' },
      premiumBeforeGst: { value: '1000000.00' },
      gst: { value: '180000.00' },
      premiumPerFamily: { value: '500000.00' },
      claimsToDate: { value: null },
    });
    expect(third!.claimsRatio.reason).toBeTruthy();
    const employees = analysis.changes[0]!.find((change) => change.metric === 'employees')!;
    expect(employees).toMatchObject({ absolute: '19', percent: '15.08' });
    const ratio = analysis.changes[0]!.find((change) => change.metric === 'claimsRatio')!;
    expect(ratio).toMatchObject({ absolute: '-10.00', percent: null });
    expect(
      analysis.changes[1]!.find((change) => change.metric === 'claimsRatio')!.absolute,
    ).toBeNull();
    // Quotes for the coming year against ₹10,00,000.
    expect(
      analysis.upcoming!.quotes.map((item) => [item.insurerName, item.changePercent, item.lowest]),
    ).toEqual(
      expect.arrayContaining([
        [expect.stringContaining('Arogya'), '10.00', false],
        [expect.stringContaining('Bharat'), '-5.00', true],
      ]),
    );
    expect(analysis.parameters.length).toBeGreaterThan(0);
  });

  it('refuses more than three years, the same year twice, and another company’s year', async () => {
    await request(app)
      .post(r('/analysis'))
      .set(bearer(manager))
      .send({ ...body(), years: [...body().years, { source: 'RECORDED', id: years.first }] })
      .expect(400);
    await request(app)
      .post(r('/analysis'))
      .set(bearer(manager))
      .send({ ...body(), years: [body().years[0], body().years[0]] })
      .expect(400);
    const other = await request(app)
      .post(r('/analysis'))
      .set(bearer(manager))
      .send({ ...body(), clientId: new Types.ObjectId().toHexString() });
    expect([400, 404, 409]).toContain(other.status);
  });

  it('downloads Excel and PDF, audited, and keeps a saved report as it was when saved', async () => {
    // Exports need proposals.export: Read-only users may look but not download.
    await request(app).post(r('/analysis/document')).set(bearer(approver)).send(body()).expect(200);
    const sheet = await binary(
      request(app).post(r('/analysis/document?format=xlsx')).set(bearer(manager)).send(body()),
    ).expect(200);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(sheet.body as ArrayBuffer);
    const text = book.worksheets
      .map((ws) => ws.getSheetValues().flat().map(String).join('|'))
      .join('\n');
    expect(text).toContain('Renewal Works Pvt Ltd');
    expect(text).toContain('2973600');
    const pdf = await binary(
      request(app).post(r('/analysis/document?format=pdf')).set(bearer(manager)).send(body()),
    ).expect(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    await request(app).post(r('/analysis/document')).set(bearer(readOnly)).send(body()).expect(403);
    expect(await AuditLogModel.countDocuments({ action: 'RENEWAL_REPORT_DOWNLOADED' })).toBe(3);

    await request(app)
      .post(r('/reports'))
      .set(bearer(readOnly))
      .send({ ...body(), title: 'Renewal 2026' })
      .expect(403);
    const saved = SavedRenewalReportSchema.parse(
      (
        await request(app)
          .post(r('/reports'))
          .set(bearer(manager))
          .send({ ...body(), title: 'Renewal 2026' })
          .expect(201)
      ).body,
    );
    // The recorded year is corrected afterwards: the live analysis changes, the saved report does not.
    await request(app)
      .put(r(`/years/${years.first}`))
      .set(bearer(manager))
      .send(recorded({ premiumBeforeGst: '2600000' }))
      .expect(200);
    const live = RenewalAnalysisSchema.parse(
      (await request(app).post(r('/analysis')).set(bearer(manager)).send(body()).expect(200)).body,
    );
    expect(live.years[0]!.premiumBeforeGst.value).toBe('2600000.00');
    const reread = SavedRenewalReportSchema.parse(
      (
        await request(app)
          .get(r(`/reports/${saved.id}`))
          .set(bearer(readOnly))
          .expect(200)
      ).body,
    );
    expect(reread.analysis.years[0]!.premiumBeforeGst.value).toBe('2520000.00');
    expect(reread.analysis).toEqual(saved.analysis);
    const list = (
      await request(app)
        .get(r(`/reports?clientId=${clientId}`))
        .set(bearer(readOnly))
        .expect(200)
    ).body;
    expect(list.items).toHaveLength(1);
    await binary(
      request(app)
        .get(r(`/reports/${saved.id}/document?format=xlsx`))
        .set(bearer(manager)),
    ).expect(200);
    expect(await AuditLogModel.countDocuments({ action: 'RENEWAL_REPORT_SAVED' })).toBe(1);
    expect(await AuditLogModel.countDocuments({ action: 'POLICY_YEAR_UPDATED' })).toBe(1);
    expect(await AuditLogModel.countDocuments({ action: 'RENEWAL_REPORT_DOWNLOADED' })).toBe(4);
  });
});
