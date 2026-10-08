import {
  CATALOG_SHEETS,
  OTHER_SECTIONS,
  RISK_DETAIL_FIELDS,
  XLSX_CONTENT_TYPE,
} from '../src/shared/index.ts';
import ExcelJS from 'exceljs';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { MailLogModel } from '../src/modules/mail/mail-log.model.ts';
import { bearer, createTestApp, tokenFor, useTestDatabase } from './helpers/app.ts';
import { FakeTransport } from './helpers/mail.ts';
import { seedMasters } from './helpers/masters.ts';
import { approveRfq } from './helpers/rfq.ts';

// The placement slip: the quote the client accepted in the client's Placement Slip format,
// approved, mailed to the insurer (the case moves to Placement Slip), then the policy or cover
// note recorded (the case moves to Placed).

useTestDatabase();

const transport = new FakeTransport();
const app = createTestApp({}, undefined, transport);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
const SLIP_FORMAT = readFileSync(
  fileURLToPath(
    new URL('../data/client-formats/Fiducial_Placement slip format.xlsx', import.meta.url),
  ),
);

let admin: string;
let manager: string;
let approver: string;
let caseId: string;
const insurers: string[] = [];
const A = () => insurers[0] ?? '';
const B = () => insurers[1] ?? '';

const binary = (req: request.Test) =>
  req.buffer(true).parse((res, done) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('end', () => done(null, Buffer.concat(chunks)));
  });

async function quote(insurerId: string, fire: [string, string | null], money: string) {
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
      option: 'P1',
      sections: [
        { code: 'FIRE', sumInsured: null, premium: fire[0], premiumWithoutTerrorism: fire[1] },
        { code: 'MONEY', sumInsured: null, premium: money },
      ],
      deductibles: 'Fire: 5% of each claim, minimum ₹10,000',
      conditions: 'Hydrant system to be maintained in working order',
      capacityPercent: '100',
      attachmentIds: [pdf.body.id],
    })
    .expect(201);
}

const slip = async () =>
  (
    await request(app)
      .get(`/api/v1/proposals/${caseId}/placement-slip`)
      .set(bearer(manager))
      .expect(200)
  ).body;
const record = async () =>
  (await request(app).get(`/api/v1/proposals/${caseId}`).set(bearer(manager)).expect(200)).body;
const move = (stage: string) =>
  request(app).post(`/api/v1/proposals/${caseId}/stage`).set(bearer(manager)).send({ stage });
const approve = (fingerprint: string, token = approver) =>
  request(app)
    .post(`/api/v1/proposals/${caseId}/placement-slip/approve`)
    .set(bearer(token))
    .send({ fingerprint });
const send = (sendId = randomUUID()) =>
  request(app)
    .post(`/api/v1/proposals/${caseId}/placement-slip/email`)
    .set(bearer(manager))
    .send({ sendId, to: ['fort@insurer.example'], format: 'xlsx' });
const upload = (data: Buffer, fileName: string) =>
  request(app)
    .post(`/api/v1/proposals/${caseId}/placement-slip/files?fileName=${fileName}`)
    .set(bearer(manager))
    .set('Content-Type', 'application/octet-stream')
    .send(data);
const placed = (body: object) =>
  request(app)
    .put(`/api/v1/proposals/${caseId}/placement-slip/placed`)
    .set(bearer(manager))
    .send(body);
async function download(format: 'xlsx' | 'pdf' = 'xlsx') {
  return binary(
    request(app)
      .get(`/api/v1/proposals/${caseId}/placement-slip/document?format=${format}`)
      .set(bearer(manager)),
  );
}

beforeAll(async () => {
  await seedMasters();
  admin = (await tokenFor(app, ['ADMIN'])).token;
  manager = (await tokenFor(app, ['ACCOUNT_MANAGER'])).token;
  approver = (await tokenFor(app, ['MANAGER'])).token;
  // The product master, for the product the slip names.
  const products = new ExcelJS.Workbook();
  const sheet = products.addWorksheet(CATALOG_SHEETS.products.sheetName);
  sheet.addRow(CATALOG_SHEETS.products.columns.map((column) => column.header));
  const CR = 10_000_000;
  sheet.addRow(['BSUS', 'Bharat Sookshma Udyam Suraksha (BSUS)', '', 5 * CR, 1, 'Yes', '', '']);
  sheet.addRow(['BLUS', 'Bharat Laghu Udyam Suraksha (BLUS)', 5 * CR, 50 * CR, 2, 'Yes', '', '']);
  // The clause library: printed on the slip for the sections the case quotes.
  const clauses = products.addWorksheet(CATALOG_SHEETS.clauses.sheetName);
  clauses.addRow(CATALOG_SHEETS.clauses.columns.map((column) => column.header));
  for (const row of [
    [
      'REINSTATEMENT',
      'Fire & Burglary',
      'Reinstatement value Clause (Other than stock)',
      'Fire',
      'Yes',
      'Yes',
      'Yes',
      1,
      'Yes',
    ],
    [
      'AGREED_BANK',
      'Fire & Burglary',
      'Agreed Bank Clause: TBA',
      'Fire',
      'Yes',
      'Yes',
      'Yes',
      2,
      'Yes',
    ],
    [
      'FLOP_INDEMNITY',
      'Fire Loss of Profit (FLOP)',
      'Indemnity Period: 12 Months',
      'Fire Loss of Profit',
      'Yes',
      'Yes',
      'Yes',
      3,
      'Yes',
    ],
    [
      'CASH_IN_TRANSIT',
      'Money',
      'Cash in transit: From insured premises to bank',
      'Money',
      'Yes',
      'Yes',
      'Yes',
      4,
      'Yes',
    ],
    ['RFQ_ONLY', 'Money', 'Printed on the RFQ only', 'Money', 'Yes', 'No', 'No', 5, 'Yes'],
  ])
    clauses.addRow(row);
  const imported = await request(app)
    .post('/api/v1/catalog/import?dryRun=false&fileName=products.xlsx')
    .set(bearer(admin))
    .set('Content-Type', XLSX_CONTENT_TYPE)
    .send(Buffer.from(await products.xlsx.writeBuffer()))
    .expect(200);
  expect(imported.body.imported).toBe(true);
  const client = await request(app)
    .post('/api/v1/clients')
    .set(bearer(admin))
    .send({
      name: 'Slip Test Mills',
      gstin: '27AAPFU0939F1ZV',
      address: {
        line1: '1 Mill Road',
        line2: '',
        city: 'Mumbai',
        state: 'Maharashtra',
        pincode: '400001',
      },
      contacts: [
        { name: 'Ravi Mehta', designation: 'CFO', email: 'ravi@mills.example', phone: null },
      ],
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
  for (const branch of ['Fort', 'Andheri']) {
    const insurer = await request(app)
      .post('/api/v1/insurers')
      .set(bearer(admin))
      .send({
        company: 'Test General',
        branch,
        contacts: [
          {
            name: `${branch} Underwriter`,
            designation: null,
            email: `uw.${branch.toLowerCase()}@insurer.example`,
            phone: null,
          },
        ],
        rfqEmails: [`${branch.toLowerCase()}@insurer.example`],
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
      locationIds: [location.body.id],
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
          locationId: location.body.id,
          fire: [{ key: 'STOCKS', sqFt: null, ratePerSqFt: null, amount: '60000000' }],
          hypothecation: 'State Bank of India, Fort branch',
          openStock: null,
          risk: Object.fromEntries(RISK_DETAIL_FIELDS.map((field) => [field.key, 'Yes'])),
        },
      ],
      fireOption2: [],
      sections: OTHER_SECTIONS.map((code) => ({
        code,
        included: code === 'MONEY',
        proposed1: code === 'MONEY' ? '500000' : null,
        proposed2: null,
      })),
      claims: [],
      notes: null,
    })
    .expect(200);
  await request(app)
    .put(`/api/v1/proposals/${caseId}/insurers`)
    .set(bearer(manager))
    .send({ insurerIds: insurers })
    .expect(200);
  await approveRfq(app, caseId, manager, approver);
  await request(app)
    .post(`/api/v1/proposals/${caseId}/rfq/sent`)
    .set(bearer(manager))
    .send({ insurerIds: insurers })
    .expect(200);
  await quote(A(), ['120000', '100000'], '1500');
  await quote(B(), ['115000', null], '1000');
  const qcr = await request(app)
    .put(`/api/v1/proposals/${caseId}/qcr`)
    .set(bearer(manager))
    .send({
      recommendedInsurerId: A(),
      recommendedOption: 'P1',
      recommendation: null,
      remarks: null,
      paymentInFavourOf: 'Test General Insurance Co Ltd',
    })
    .expect(200);
  await request(app)
    .post(`/api/v1/proposals/${caseId}/qcr/approve`)
    .set(bearer(approver))
    .send({ fingerprint: qcr.body.fingerprint })
    .expect(200);
  await request(app)
    .post(`/api/v1/proposals/${caseId}/qcr/email`)
    .set(bearer(manager))
    .send({ sendId: randomUUID(), to: ['ravi@mills.example'], format: 'pdf' })
    .expect(200);
});

describe('Placement slip', () => {
  it('waits for the client approval', async () => {
    const before = await slip();
    expect(before).toMatchObject({
      status: 'DRAFT',
      accepted: null,
      sections: [],
      blocked: 'Record the quote the client accepted on the Client approval tab first.',
    });
    await request(app)
      .put(`/api/v1/proposals/${caseId}/placement-slip`)
      .set(bearer(manager))
      .send({ remarks: 'Too early' })
      .expect(409);
  });

  it('is built from the quote accepted, approved as seen, and mailed to that insurer', async () => {
    const file = await request(app)
      .post(`/api/v1/proposals/${caseId}/client-approval/files?fileName=reply.pdf`)
      .set(bearer(manager))
      .set('Content-Type', 'application/pdf')
      .send(PDF)
      .expect(201);
    await request(app)
      .put(`/api/v1/proposals/${caseId}/client-approval`)
      .set(bearer(manager))
      .send({
        insurerId: A(),
        option: 'P1',
        withTerrorism: false,
        acceptedOn: '2026-10-07',
        confirmedBy: 'Ravi Mehta',
        note: null,
        attachmentIds: [file.body.id],
      })
      .expect(200);

    const built = await slip();
    expect(built).toMatchObject({
      status: 'DRAFT',
      accepted: { insurerId: A(), option: 'P1', withTerrorism: false },
      sections: [
        { code: 'FIRE', name: 'Fire', sumInsured: '60000000', premium: '100000' },
        { code: 'MONEY', sumInsured: '500000', premium: '1500' },
      ],
      premium: { net: '101500.00', gst: '18270.00', total: '119770.00' },
      capacityPercent: '100',
      deductibles: 'Fire: 5% of each claim, minimum ₹10,000',
      missing: ['Upload the client’s Placement Slip format (Masters → Document templates).'],
      templateUploaded: false,
      recipients: [
        { name: 'Test General, Fort', email: 'fort@insurer.example' },
        { name: 'Fort Underwriter', email: 'uw.fort@insurer.example' },
      ],
      blocked: null,
    });
    expect((await download()).status).toBe(409);
    const incomplete = await approve(built.fingerprint as string).expect(409);
    expect(incomplete.body.code).toBe('PLACEMENT_SLIP_INCOMPLETE');

    const template = await request(app)
      .post('/api/v1/templates/PLACEMENT_SLIP?fileName=Fiducial_Placement%20slip%20format.xlsx')
      .set(bearer(admin))
      .set('Content-Type', XLSX_CONTENT_TYPE)
      .send(SLIP_FORMAT)
      .expect(200);
    expect(template.body).toMatchObject({ saved: true, check: { ok: true, problems: [] } });

    const saved = await request(app)
      .put(`/api/v1/proposals/${caseId}/placement-slip`)
      .set(bearer(manager))
      .send({ remarks: 'Premium to be paid by cheque before inception.' })
      .expect(200);
    expect(saved.body.missing).toEqual([]);
    // The stage follows the slip sent and the policy recorded, not a button.
    await move('PLACEMENT_SLIP').expect(409);
    await placed({
      documentKind: 'POLICY',
      number: 'X',
      issuedOn: '2026-10-08',
      note: null,
      attachmentIds: [file.body.id],
    }).expect(409);
    const unapproved = await send().expect(409);
    expect(unapproved.body.code).toBe('PLACEMENT_SLIP_NOT_APPROVED');
    await approve(saved.body.fingerprint as string, manager).expect(403);
    const stale = await approve(built.fingerprint as string).expect(409);
    expect(stale.body.code).toBe('PLACEMENT_SLIP_CHANGED');
    await approve(saved.body.fingerprint as string).expect(200);

    const sendId = randomUUID();
    const sent = await send(sendId).expect(200);
    expect(sent.body).toMatchObject({ outcome: 'SENT', slip: { status: 'SENT' } });
    expect(transport.sent.at(-1)).toMatchObject({
      to: ['fort@insurer.example'],
      subject: `Placement slip: Slip Test Mills (${(await record()).reference as string})`,
      attachment: {
        fileName: expect.stringMatching(/^Placement-Slip-PRP-\d{4}-\d{4}\.xlsx$/) as string,
      },
    });
    const count = transport.sent.length;
    await send(sendId).expect(200);
    expect(transport.sent).toHaveLength(count);
    expect(
      await MailLogModel.findOne({ proposalId: caseId, kind: 'PLACEMENT_SLIP' }).lean(),
    ).toMatchObject({
      result: 'DELIVERED',
    });
    const after = await record();
    expect([after.stage, after.nextStage]).toEqual(['PLACEMENT_SLIP', 'PLACED']);
  });

  it('fills the client’s format: the insurer, its premium, the option’s sums and the terms', async () => {
    const response = await download();
    expect(response.status).toBe(200);
    expect(response.headers['x-placement-slip-status']).toBe('SENT');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(response.body as ArrayBuffer);
    const premium = workbook.getWorksheet('premium details')!;
    const text = (sheet: ExcelJS.Worksheet, row: number, column: number) => {
      const value = sheet.getCell(row, column).value;
      return value && typeof value === 'object' && 'result' in value ? value.result : value;
    };
    const rowOf = (sheet: ExcelJS.Worksheet, label: string, column = 1) => {
      for (let row = 1; row <= sheet.rowCount; row += 1) {
        const value = sheet.getCell(row, column).value;
        if (typeof value === 'string' && value.trim().startsWith(label)) return row;
      }
      return 0;
    };
    expect(text(premium, 1, 1)).toBe('FINAL PLACEMENT SLIP FOR NEW BUSINESS 2026-27');
    expect(text(premium, 6, 3)).toBe('Test General, Fort');
    expect(text(premium, 7, 3)).toBe('Capacity: 100%');
    expect(text(premium, 9, 3)).toBe('Fire section without terrorism (accepted)');
    expect(premium.getRow(10).hidden).toBe(true);
    const fire = rowOf(premium, 'Fire');
    expect([text(premium, fire, 2), text(premium, fire, 3)]).toEqual([60000000, 100000]);
    expect(premium.getRow(rowOf(premium, 'Burglary')).hidden).toBe(true);
    // Money is not in the format's table: a row is added for it.
    const money = rowOf(premium, 'Money');
    expect([text(premium, money, 2), text(premium, money, 3)]).toEqual([500000, 1500]);
    expect(text(premium, rowOf(premium, 'Net Premium'), 3)).toBe(101500);
    expect(text(premium, rowOf(premium, 'Total Premium'), 3)).toBe(119770);
    expect(text(premium, rowOf(premium, 'Remarks if any'), 1)).toBe(
      'Remarks if any: Premium to be paid by cheque before inception.',
    );

    const schedule = workbook.getWorksheet('schedule')!;
    expect(text(schedule, 1, 1)).toBe('Policy No: To be issued by the insurer');
    expect(text(schedule, rowOf(schedule, 'Total Sum Insured - Fire', 2), 3)).toBe(60000000);
    expect(text(schedule, rowOf(schedule, 'Agreed Bank Clause', 2), 2)).toBe(
      'Agreed Bank Clause: State Bank of India, Fort branch',
    );
    const conditions = rowOf(schedule, 'Warranties / Conditions');
    expect(text(schedule, conditions + 1, 1)).toBe(
      'Hydrant system to be maintained in working order',
    );
    expect(text(schedule, rowOf(schedule, 'Excess') + 1, 1)).toBe(
      'Deductibles: Fire: 5% of each claim, minimum ₹10,000',
    );
    expect(schedule.pageSetup.printArea).toBe(`A1:C${schedule.rowCount}`);
    expect(premium.pageSetup.printArea).toBe(`A1:D${rowOf(premium, 'Remarks if any')}`);
    // The clause library for the sections placed: Fire (and its bank) and Money, not FLOP.
    const clauses = rowOf(schedule, 'Clauses to be attached');
    const warranties = rowOf(schedule, 'Warranties / Conditions');
    const shown: unknown[][] = [];
    for (let row = clauses + 1; row < warranties; row += 1) {
      if (!schedule.getRow(row).hidden)
        shown.push([text(schedule, row, 1), text(schedule, row, 2)]);
    }
    expect(shown).toEqual([
      ['Fire & Burglary', 'Reinstatement value Clause (Other than stock)'],
      ['Fire & Burglary', 'Agreed Bank Clause: State Bank of India, Fort branch'],
      ['Money', 'Cash in transit: From insured premises to bank'],
    ]);
    // The notes (here the hypothecation) come after the conditions, above the broker's footer.
    expect(rowOf(schedule, 'NOTE:')).toBeGreaterThan(rowOf(schedule, 'Excess'));
    // Fire was accepted without terrorism.
    const fireTerrorism = rowOf(schedule, 'Terrorism', 2);
    expect(text(schedule, fireTerrorism, 3)).toBe('Not required');
    // The product placed, not the range offered on the RFQ.
    const product = rowOf(schedule, 'Product to be');
    expect(text(schedule, product, 2)).toBe(
      'Above ₹5 Cr and up to ₹50 Cr sum insured: Bharat Laghu Udyam Suraksha (BLUS)',
    );
    expect(schedule.getRow(product + 1).hidden).toBe(true);

    const pdf = await download('pdf');
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('records the policy or cover note, which places the case', async () => {
    const text = await upload(Buffer.from('not a pdf'), 'policy.pdf').expect(400);
    expect(text.body.details[0].message).toMatch(/^Attach the policy or cover note/);
    const file = await upload(PDF, 'Policy.pdf').expect(201);
    const base = {
      documentKind: 'POLICY',
      number: 'TGI/FIRE/2026/1234',
      issuedOn: '2026-10-08',
      note: 'Policy received by mail',
      attachmentIds: [file.body.id],
    };
    expect(
      (await placed({ ...base, issuedOn: '2099-01-01' }).expect(400)).body.details[0].message,
    ).toBe('The date cannot be in the future');
    expect((await placed({ ...base, attachmentIds: [] }).expect(400)).body.details[0].message).toBe(
      'Attach the policy or cover note',
    );
    const done = await placed(base).expect(200);
    expect(done.body.placed).toMatchObject({
      documentKind: 'POLICY',
      number: 'TGI/FIRE/2026/1234',
      files: [{ fileName: 'Policy.pdf' }],
    });
    const after = await record();
    expect([after.stage, after.nextStage]).toEqual(['PLACED', null]);
    expect(after.activity.map((entry: { message: string }) => entry.message)).toContain(
      'Placed: Policy TGI/FIRE/2026/1234 issued on 08 Oct 2026 by Test General',
    );
    // The slip now carries the policy number.
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await download()).body as ArrayBuffer);
    expect(workbook.getWorksheet('schedule')!.getCell(1, 1).value).toBe(
      'Policy No: TGI/FIRE/2026/1234',
    );
    // The lists behind the Quotes and QCR and Placement Slips pages.
    const slips = await request(app)
      .get('/api/v1/placement-slips')
      .set(bearer(manager))
      .expect(200);
    expect(slips.body.items).toEqual([
      expect.objectContaining({
        proposalId: caseId,
        stage: 'PLACED',
        accepted: expect.objectContaining({
          company: 'Test General',
          branch: 'Fort',
          total: '119770.00',
        }) as unknown,
        slip: expect.objectContaining({ status: 'SENT' }) as unknown,
        placed: { documentKind: 'POLICY', number: 'TGI/FIRE/2026/1234', issuedOn: '2026-10-08' },
      }),
    ]);
    const qcrs = await request(app).get('/api/v1/qcrs').set(bearer(manager)).expect(200);
    expect(qcrs.body.items).toEqual([
      expect.objectContaining({
        proposalId: caseId,
        insurers: { asked: 2, quoted: 2, declined: 0, awaiting: 0, overdue: 0 },
        lowest: { company: 'Test General', branch: 'Fort', option: 'P1', total: '119770.00' },
        qcr: expect.objectContaining({
          status: 'SENT',
          recommended: 'Test General, Fort',
        }) as unknown,
      }),
    ]);
    await request(app).get('/api/v1/qcrs').expect(401);
    // Other paths still answer not found.
    await request(app).get('/api/v1/nope').expect(404);
    // A correction keeps the case placed.
    await placed({ ...base, documentKind: 'COVER_NOTE', number: 'CN-77' }).expect(200);
    expect((await record()).stage).toBe('PLACED');
  });
});
