import {
  ClaimsAnalysisResponseSchema,
  TpaImportSchema,
  emptyGhiQuoteTerms,
  emptyGhiRequirements,
} from '../src/shared/index.ts';
import ExcelJS from 'exceljs';
import { Types } from 'mongoose';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { GhiCaseModel } from '../src/modules/ghi/ghi-case.model.ts';
import { GhiMemberModel } from '../src/modules/ghi/ghi-census.model.ts';
import { GhiQuoteModel } from '../src/modules/ghi/ghi-workflow.model.ts';
import { bearer, createTestApp, tokenFor, useTestDatabase } from './helpers/app.ts';
import { seedMasters } from './helpers/masters.ts';

// Client acceptance (N13), on SYNTHETIC data. The client's claims dump (61 reported, 48 settled,
// ₹27,33,627 settled, 10 outstanding, 3 rejected, ICR 84.96% prorated and 81.24% total) is not
// available, so those exact figures are BLOCKED and appear nowhere here. This test builds a file of
// the same shape from a seeded generator, works out every expected figure itself from the rows it
// generated (independently of the application's code), and checks the whole pipeline (format,
// upload, validation, import, analysis, Excel) reproduces them. Nothing below is a client figure.

useTestDatabase();
const app = createTestApp();
let admin: string;
let manager: string;
let caseId: string;
let formatId: string;

const POLICY_START = '2025-04-01';
const POLICY_END = '2026-03-31';
const BASE_PREMIUM = '3150000.00';
const ADDITION = { amount: '84000.00', effectiveDate: '2025-10-01' };
const DELETION = { amount: '21000.50', effectiveDate: '2026-01-15' };
const AS_OF = '2026-02-28';

/** A small seeded generator, so the file is the same on every run. */
function generator(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

// Independent arithmetic for the expected figures (BigInt paise, half up).
const paise = (rupees: string) => {
  const [whole, fraction = ''] = rupees.split('.');
  return BigInt(whole!) * 100n + BigInt((fraction + '00').slice(0, 2));
};
const rupees = (value: bigint) => `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
const divideHalfUp = (numerator: bigint, denominator: bigint) =>
  (2n * numerator + denominator) / (2n * denominator);
const days = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
const earned = (amount: string, from: string) =>
  from > AS_OF
    ? 0n
    : divideHalfUp(paise(amount) * BigInt(days(from, AS_OF)), BigInt(days(from, POLICY_END)));
const percent = (incurred: bigint, premium: bigint) => {
  const hundredths = divideHalfUp(incurred * 10_000n, premium);
  return `${hundredths / 100n}.${String(hundredths % 100n).padStart(2, '0')}`;
};

interface Generated {
  cells: Record<string, string | number>;
  counted: boolean;
  status: 'SETTLED' | 'OUTSTANDING' | 'REJECTED' | null;
  settled: bigint;
  reserve: bigint;
}

function generate(): Generated[] {
  const random = generator(20_250_401);
  const amount = (low: number, high: number) => (low + random() * (high - low)).toFixed(2);
  const rows: Generated[] = [];
  const plan = [
    ...Array.from({ length: 48 }, () => 'Settled'),
    ...Array.from({ length: 6 }, () => 'For Investigation'),
    ...Array.from({ length: 4 }, () => 'Registration'),
    ...Array.from({ length: 3 }, () => 'Repudiated'),
  ];
  plan.forEach((source, index) => {
    const employee = `E${String((index % 30) + 1).padStart(3, '0')}`;
    const dependant = index % 3 === 0;
    const claimed = amount(8_000, 1_20_000);
    const disallowed = source === 'Settled' ? amount(0, Number(claimed) * 0.15) : '0.00';
    const sanctioned = rupees(paise(claimed) - paise(disallowed));
    const withSanction = source === 'For Investigation';
    const month = 4 + (index % 10);
    const admission = `${String(5 + (index % 20)).padStart(2, '0')}/${String(month > 12 ? month - 12 : month).padStart(2, '0')}/${month > 12 ? 2026 : 2025}`;
    const cells: Record<string, string | number> = {
      'Claim No': `AC-${String(index + 1).padStart(4, '0')}`,
      'Request Type': 'Main',
      'Emp Code': employee,
      Relation: dependant ? 'Spouse' : 'Self',
      DOA: admission,
      'Claim Type': index % 2 === 0 ? 'Cashless' : 'Reimbursement',
      'Hospital Name': `Hospital ${index % 7}`,
      'Claimed Amt': claimed,
      'Claim Status': source,
    };
    if (source === 'Settled')
      Object.assign(cells, {
        'Sanctioned Amt': sanctioned,
        'Settled Amt': sanctioned,
        'Disallowed Amt': disallowed,
      });
    if (withSanction) cells['Sanctioned Amt'] = sanctioned;
    const status =
      source === 'Settled' ? 'SETTLED' : source === 'Repudiated' ? 'REJECTED' : 'OUTSTANDING';
    rows.push({
      cells,
      counted: true,
      status,
      settled: status === 'SETTLED' ? paise(sanctioned) : 0n,
      // Outstanding reserved at the sanctioned amount, else the claimed amount (the default basis).
      reserve: status === 'OUTSTANDING' ? paise(withSanction ? sanctioned : claimed) : 0n,
    });
  });
  // Five pre-authorisations of main claims (part of their main claim, never counted again).
  for (const index of [0, 5, 50, 52, 55]) {
    const main = rows[index]!.cells;
    rows.push({
      cells: {
        ...main,
        'Claim No': `PA-${index}`,
        'Main Claim No': main['Claim No']!,
        'Request Type': 'Pre-Auth',
        'Claim Status': 'Registration',
        'Settled Amt': '',
        'Sanctioned Amt': '',
      },
      counted: false,
      status: null,
      settled: 0n,
      reserve: 0n,
    });
  }
  // A row the format cannot read and a repeated claim: refused, so not counted.
  rows.push({
    cells: {
      'Claim No': 'AC-9999',
      'Emp Code': 'E001',
      Relation: 'Self',
      'Claim Status': 'Pending at insurer',
    },
    counted: false,
    status: null,
    settled: 0n,
    reserve: 0n,
  });
  rows.push({
    cells: { ...rows[1]!.cells },
    counted: false,
    status: null,
    settled: 0n,
    reserve: 0n,
  });
  return rows;
}

const HEADERS = [
  'Claim No',
  'Main Claim No',
  'Request Type',
  'Emp Code',
  'Relation',
  'DOA',
  'Claim Type',
  'Hospital Name',
  'Claimed Amt',
  'Sanctioned Amt',
  'Settled Amt',
  'Disallowed Amt',
  'Claim Status',
];
const FIELD_OF: Record<string, string> = {
  'Claim No': 'tpaClaimId',
  'Main Claim No': 'parentClaimId',
  'Request Type': 'requestType',
  'Emp Code': 'employeeId',
  Relation: 'relationship',
  DOA: 'admissionDate',
  'Claim Type': 'claimType',
  'Hospital Name': 'hospital',
  'Claimed Amt': 'claimedAmount',
  'Sanctioned Amt': 'sanctionedAmount',
  'Settled Amt': 'settledAmount',
  'Disallowed Amt': 'disallowedAmount',
  'Claim Status': 'status',
};

beforeAll(async () => {
  await seedMasters();
  admin = (await tokenFor(app, ['ADMIN'])).token;
  const created = await tokenFor(app, ['ACCOUNT_MANAGER']);
  manager = created.token;
  const userId = new Types.ObjectId(created.user.id);
  const clientId = (
    await request(app)
      .post('/api/v1/clients')
      .set(bearer(admin))
      .send({
        name: 'Acceptance Test Company',
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
  const insurerId = new Types.ObjectId(
    (
      await request(app)
        .post('/api/v1/insurers')
        .set(bearer(admin))
        .send({
          company: 'Arogya Health',
          branch: 'Pune',
          contacts: [],
          rfqEmails: ['rfq@arogya.example'],
        })
        .expect(201)
    ).body.id as string,
  );
  const id = new Types.ObjectId();
  const quote = await GhiQuoteModel.create({
    caseId: id,
    insurerId,
    version: 1,
    status: 'FINAL',
    kind: 'FINAL_AGREED',
    reason: null,
    basePremium: Types.Decimal128.fromString(BASE_PREMIUM),
    gstRatePercent: Types.Decimal128.fromString('18'),
    gst: Types.Decimal128.fromString('567000'),
    totalPremium: Types.Decimal128.fromString('3717000'),
    terms: emptyGhiQuoteTerms(),
    otherTerms: null,
    validUntil: null,
    attachmentIds: [],
    createdBy: userId,
    finalizedAt: new Date(),
    finalizedBy: userId,
  });
  await GhiCaseModel.create({
    _id: id,
    reference: 'GHI-2025-0061',
    type: 'NEW',
    stage: 'PLACEMENT_SLIP',
    closedReason: null,
    clientId: new Types.ObjectId(clientId),
    ownerId: userId,
    policyStart: POLICY_START,
    policyEnd: POLICY_END,
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
    policy: {
      policyNumber: 'GMC/2025/0061',
      issuedOn: '2025-03-30',
      policyStart: POLICY_START,
      policyEnd: POLICY_END,
      renewalDate: '2026-04-01',
      insurerId,
      quoteId: quote._id,
      qcrId: new Types.ObjectId(),
      fileId: new Types.ObjectId(),
      census: {
        employees: 30,
        lives: 60,
        totalSumInsured: Types.Decimal128.fromString('15000000'),
        revision: 1,
      },
      recordedAt: new Date(),
      recordedBy: userId,
    },
    activity: [],
    createdBy: userId,
    updatedBy: userId,
  });
  caseId = id.toHexString();
  await GhiMemberModel.insertMany(
    Array.from({ length: 30 }, (_, index) => {
      const employeeId = `E${String(index + 1).padStart(3, '0')}`;
      return [
        {
          employeeId,
          relationship: 'SELF',
          gender: 'MALE',
          dateOfBirth: `19${70 + (index % 25)}-03-15`,
        },
        {
          employeeId,
          relationship: 'SPOUSE',
          gender: 'FEMALE',
          dateOfBirth: `19${72 + (index % 25)}-08-20`,
        },
      ];
    })
      .flat()
      .map((member, index) => ({
        caseId: id,
        ...member,
        employeeKey: member.employeeId,
        name: `Member ${index + 1}`,
        nameKey: `member ${index + 1}`,
        dateOfJoining: null,
        sumInsured: member.relationship === 'SELF' ? Types.Decimal128.fromString('500000') : null,
        source: 'MANUAL',
        importId: null,
        createdBy: userId,
        updatedBy: userId,
      })),
  );
  formatId = (
    await request(app)
      .post('/api/v1/tpa/formats')
      .set(bearer(admin))
      .send({
        name: 'Acceptance layout (synthetic)',
        tpaCode: 'ACPT',
        mappings: HEADERS.map((header) => ({
          field: FIELD_OF[header],
          header,
          required: header === 'Claim No' || header === 'Claim Status',
        })),
        statusMap: [
          { source: 'Settled', status: 'SETTLED' },
          { source: 'For Investigation', status: 'OUTSTANDING' },
          { source: 'Registration', status: 'OUTSTANDING' },
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
          { source: 'Spouse', relationship: 'SPOUSE' },
        ],
        createBoardClaims: false,
      })
      .expect(201)
  ).body.id as string;
  for (const adjustment of [
    { kind: 'ADDITION', ...ADDITION, reference: 'END-ADD-1' },
    { kind: 'DELETION', ...DELETION, reference: 'END-DEL-1' },
  ]) {
    await request(app)
      .post(`/api/v1/claims-analysis/premium/${caseId}`)
      .set(bearer(manager))
      .send(adjustment)
      .expect(201);
  }
});

describe('client acceptance on synthetic data of the client’s shape (N13)', () => {
  const rows = generate();
  const counted = rows.filter((row) => row.counted);
  const settled = counted.filter((row) => row.status === 'SETTLED');
  const outstanding = counted.filter((row) => row.status === 'OUTSTANDING');
  const rejected = counted.filter((row) => row.status === 'REJECTED');
  const paid = settled.reduce((sum, row) => sum + row.settled, 0n);
  const reserve = outstanding.reduce((sum, row) => sum + row.reserve, 0n);
  const totalPremium = paise(BASE_PREMIUM) + paise(ADDITION.amount) - paise(DELETION.amount);
  const proratedPremium =
    earned(BASE_PREMIUM, POLICY_START) +
    earned(ADDITION.amount, ADDITION.effectiveDate) -
    earned(DELETION.amount, DELETION.effectiveDate);

  it('the generated file has the client’s shape', () => {
    expect([counted.length, settled.length, outstanding.length, rejected.length]).toEqual([
      61, 48, 10, 3,
    ]);
  });

  it('imports it and reproduces every count, amount and both ICRs worked out from the rows', async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('Claims');
    sheet.addRow(HEADERS);
    for (const row of rows) sheet.addRow(HEADERS.map((header) => row.cells[header] ?? null));
    const uploaded = TpaImportSchema.parse(
      (
        await request(app)
          .post(
            `/api/v1/tpa/imports?caseId=${caseId}&formatId=${formatId}&fileName=acceptance.xlsx`,
          )
          .set(bearer(manager))
          .set('Content-Type', 'application/octet-stream')
          .send(Buffer.from(await book.xlsx.writeBuffer()))
          .expect(201)
      ).body,
    );
    expect(uploaded.counts).toMatchObject({
      rows: rows.length,
      invalid: 2,
      valid: rows.length - 2,
    });
    const imported = TpaImportSchema.parse(
      (
        await request(app)
          .post(`/api/v1/tpa/imports/${uploaded.id}/commit`)
          .set(bearer(manager))
          .send({ policy: 'VALID_ONLY' })
          .expect(200)
      ).body,
    );
    expect(imported.result).toMatchObject({ created: rows.length - 2, failed: 0, skipped: 2 });

    const { analysis } = ClaimsAnalysisResponseSchema.parse(
      (
        await request(app)
          .get(`/api/v1/claims-analysis?caseId=${caseId}&asOf=${AS_OF}`)
          .set(bearer(manager))
          .expect(200)
      ).body,
    );
    const status = Object.fromEntries(analysis.status.map((row) => [row.key, row]));
    const actual = {
      reported: analysis.reported.count,
      settled: status.SETTLED!.count,
      settledAmount: status.SETTLED!.paid,
      outstanding: status.OUTSTANDING!.count,
      outstandingAmount: status.OUTSTANDING!.outstanding,
      rejected: status.REJECTED!.count,
      notCounted: analysis.notCounted,
      totalPremium: analysis.premium.total,
      proratedPremium: analysis.premium.prorated,
      icrTotal: analysis.icr.total.percent,
      icrProrated: analysis.icr.prorated.percent,
    };
    const expected = {
      reported: 61,
      settled: 48,
      settledAmount: rupees(paid),
      outstanding: 10,
      outstandingAmount: rupees(reserve),
      rejected: 3,
      notCounted: 5,
      totalPremium: rupees(totalPremium),
      proratedPremium: rupees(proratedPremium),
      icrTotal: percent(paid + reserve, totalPremium),
      icrProrated: percent(paid + reserve, proratedPremium),
    };
    expect(actual).toEqual(expected);
    expect(analysis.icr.incurred).toBe(rupees(paid + reserve));

    // The downloaded workbook carries the same figures.
    const response = await request(app)
      .get(`/api/v1/claims-analysis/document?caseId=${caseId}&asOf=${AS_OF}`)
      .set(bearer(manager))
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    const document = new ExcelJS.Workbook();
    await document.xlsx.load(response.body as ArrayBuffer);
    const text = document
      .getWorksheet('Claims Analysis')!
      .getSheetValues()
      .flat()
      .map(String)
      .join('|');
    expect(text).toContain(`${expected.icrProrated}%`);
    expect(text).toContain(`${expected.icrTotal}%`);
    expect(text).toContain(String(Number(expected.settledAmount)));
  });
});
