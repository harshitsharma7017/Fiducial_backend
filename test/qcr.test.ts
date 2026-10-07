import { OTHER_SECTIONS, RISK_DETAIL_FIELDS, XLSX_CONTENT_TYPE } from '../src/shared/index.ts';
import ExcelJS from 'exceljs';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLogModel } from '../src/modules/audit/audit.model.ts';
import { MailLogModel } from '../src/modules/mail/mail-log.model.ts';
import type {
  ExistingPolicyResult,
  ExistingPolicySource,
} from '../src/modules/proposals/existing-policy-source.ts';
import { bearer, createTestApp, tokenFor, useTestDatabase } from './helpers/app.ts';
import { FakeTransport } from './helpers/mail.ts';
import { seedMasters } from './helpers/masters.ts';
import { approveRfq } from './helpers/rfq.ts';

// The QCR (QC-1 to QC-6): the comparison from the quote entries, the lowest total, the broker's
// part, approval, the export in the client's layout and the mail to the insured.

useTestDatabase();

const LAST_YEAR: ExistingPolicyResult = {
  status: 'FOUND',
  policy: {
    source: 'PolicyDesk',
    insurer: 'Example General Insurance, Fort',
    policyNumber: 'EGI/FIRE/2025/0042',
    product: 'BLUS',
    periodStart: '2025-12-01',
    periodEnd: '2026-11-30',
    sections: [
      { code: 'FIRE', sumInsured: '50000000', premium: '96000' },
      { code: 'MONEY', sumInsured: '400000', premium: '800' },
    ],
    fireLines: [{ group: 'STOCKS', sumInsured: '50000000' }],
    totalSumInsured: '50400000',
    netPremium: '96800',
    gst: '17424',
    totalPremium: '114224',
  },
};
const source: ExistingPolicySource = { latest: () => Promise.resolve(LAST_YEAR) };
const transport = new FakeTransport();
const app = createTestApp({}, source, transport);

const CLIENT_QCR = readFileSync(
  fileURLToPath(new URL('../data/client-formats/Fiducial_QCR format.xlsx', import.meta.url)),
);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');

let admin: string;
let manager: string;
let approver: string;
let caseId: string;
const insurers: string[] = [];
const A = () => insurers[0] ?? '';
const B = () => insurers[1] ?? '';
const C = () => insurers[2] ?? '';

const binary = (req: request.Test) =>
  req.buffer(true).parse((res, done) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('end', () => done(null, Buffer.concat(chunks)));
  });

async function quote(
  insurerId: string,
  option: string,
  fire: [string, string | null],
  money: string,
  extra = {},
) {
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
        { code: 'FIRE', sumInsured: null, premium: fire[0], premiumWithoutTerrorism: fire[1] },
        { code: 'MONEY', sumInsured: null, premium: money },
      ],
      attachmentIds: [pdf.body.id],
      ...extra,
    })
    .expect(201);
}

const qcr = async () =>
  (await request(app).get(`/api/v1/proposals/${caseId}/qcr`).set(bearer(manager)).expect(200)).body;

beforeAll(async () => {
  await seedMasters();
  admin = (await tokenFor(app, ['ADMIN'])).token;
  manager = (await tokenFor(app, ['ACCOUNT_MANAGER'])).token;
  approver = (await tokenFor(app, ['MANAGER'])).token;
  const client = await request(app)
    .post('/api/v1/clients')
    .set(bearer(admin))
    .send({
      name: 'QCR Test Mills',
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
  for (const branch of ['Fort', 'Andheri', 'Thane']) {
    const insurer = await request(app)
      .post('/api/v1/insurers')
      .set(bearer(admin))
      .send({
        company: 'Test General',
        branch,
        contacts: [],
        rfqEmails: [`${branch.toLowerCase()}@insurer.example`],
      })
      .expect(201);
    insurers.push(insurer.body.id as string);
  }
  const created = await request(app)
    .post('/api/v1/proposals')
    .set(bearer(manager))
    .send({
      type: 'EXISTING',
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
          hypothecation: null,
          openStock: null,
          risk: Object.fromEntries(RISK_DETAIL_FIELDS.map((field) => [field.key, 'Yes'])),
        },
      ],
      fireOption2: [{ group: 'STOCKS', amount: '70000000' }],
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
  await quote(A(), 'P1', ['120000', '100000'], '1500');
  await quote(A(), 'EXISTING', ['98000', '90000'], '800');
  await quote(B(), 'P1', ['115000', '110000'], '1000', { capacityPercent: '80' });
  await quote(C(), 'P1', ['80000', null], '500');
  await request(app)
    .put(`/api/v1/proposals/${caseId}/insurers/${C()}/response`)
    .set(bearer(manager))
    .send({ status: 'DECLINED', note: 'Outside appetite' })
    .expect(200);
});

describe('QC-1, QC-2: the comparison', () => {
  it('compares the existing policy and the insurers that quoted, from the quote entries', async () => {
    const body = await qcr();
    expect(body.status).toBe('DRAFT');
    expect(body.insurers.map((i: { insurerId: string }) => i.insurerId)).toEqual([A(), B()]);
    expect(body.options.map((o: { option: string }) => o.option)).toEqual(['EXISTING', 'P1', 'P2']);
    const p1 = body.options[1];
    expect(
      p1.sections.map((s: { code: string; sumInsured: string }) => [s.code, s.sumInsured]),
    ).toEqual([
      ['FIRE', '60000000'],
      ['MONEY', '500000'],
    ]);
    expect(p1.existing).toEqual({ net: '96800.00', gst: '17424.00', total: '114224.00' });
    const [a, b] = p1.quotes;
    // Fire without terrorism, as the client's QCR compares.
    expect(a).toMatchObject({
      insurerId: A(),
      premiums: [
        { code: 'FIRE', premium: '100000' },
        { code: 'MONEY', premium: '1500' },
      ],
      totals: { net: '101500.00', gst: '18270.00', total: '119770.00' },
      terrorismExtra: '20000.00',
      lowest: true,
    });
    expect(b).toMatchObject({ totals: { net: '111000.00', total: '130980.00' }, lowest: false });
    expect(p1.differences).toContainEqual({
      topic: 'Capacity',
      values: [
        { insurerId: A(), value: 'Not stated' },
        { insurerId: B(), value: '80%' },
      ],
    });
    // Option 2 has no quotes; the declined insurer is not compared.
    expect(body.options[2].quotes).toEqual([]);
  });
});

describe('QC-3, QC-6: the broker’s part, approval and the mail to the insured', () => {
  it('approves only a complete QCR, as seen, by an approver; sends only an approved one', async () => {
    const before = await qcr();
    expect(before.missing).toEqual([
      'Choose the insurer and the option recommended.',
      'Enter who the cheque / payment is in favour of.',
    ]);
    const approve = (token: string, fingerprint: string) =>
      request(app)
        .post(`/api/v1/proposals/${caseId}/qcr/approve`)
        .set(bearer(token))
        .send({ fingerprint });
    const incomplete = await approve(approver, before.fingerprint as string).expect(409);
    expect(incomplete.body.code).toBe('QCR_INCOMPLETE');

    const saved = await request(app)
      .put(`/api/v1/proposals/${caseId}/qcr`)
      .set(bearer(manager))
      .send({
        recommendedInsurerId: A(),
        recommendedOption: 'P1',
        recommendation: 'Lowest premium with full capacity',
        remarks: 'Terrorism cover available at extra premium',
        paymentInFavourOf: 'Test General Insurance Co Ltd',
      })
      .expect(200);
    expect(saved.body.missing).toEqual([]);

    const send = (sendId = randomUUID()) =>
      request(app)
        .post(`/api/v1/proposals/${caseId}/qcr/email`)
        .set(bearer(manager))
        .send({ sendId, to: ['ravi@mills.example'], format: 'pdf' });
    const unapproved = await send().expect(409);
    expect(unapproved.body.code).toBe('QCR_NOT_APPROVED');

    await approve(manager, saved.body.fingerprint as string).expect(403);
    const stale = await approve(approver, before.fingerprint as string).expect(409);
    expect(stale.body.code).toBe('QCR_CHANGED');
    const approved = await approve(approver, saved.body.fingerprint as string).expect(200);
    expect(approved.body).toMatchObject({ status: 'APPROVED', approval: { current: true } });

    const sendId = randomUUID();
    const sent = await send(sendId).expect(200);
    expect(sent.body).toMatchObject({ outcome: 'SENT', qcr: { status: 'SENT' } });
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toMatchObject({
      to: ['ravi@mills.example'],
      attachment: { fileName: expect.stringMatching(/^QCR-PRP-\d{4}-\d{4}\.pdf$/) as string },
    });
    expect(transport.sent[0]?.text).toContain('Dear Ravi Mehta');
    // The same send again does not mail twice.
    await send(sendId).expect(200);
    expect(transport.sent).toHaveLength(1);
    const logged = await MailLogModel.findOne({ proposalId: caseId, kind: 'QCR' }).lean();
    expect(logged).toMatchObject({ insurerId: null, result: 'DELIVERED' });
    const mails = await request(app)
      .get(`/api/v1/proposals/${caseId}/mails`)
      .set(bearer(manager))
      .expect(200);
    expect(mails.body.items[0]).toMatchObject({
      kind: 'QCR',
      insurerId: null,
      insurerName: 'The insured',
    });
    expect(await AuditLogModel.countDocuments({ action: 'QCR_APPROVED' })).toBe(1);

    // A change after approval voids it: the QCR must be approved again before it is sent.
    const edited = await request(app)
      .put(`/api/v1/proposals/${caseId}/qcr`)
      .set(bearer(manager))
      .send({
        recommendedInsurerId: A(),
        recommendedOption: 'P1',
        recommendation: 'Lowest premium with full capacity',
        remarks: 'Changed',
        paymentInFavourOf: 'Test General Insurance Co Ltd',
      })
      .expect(200);
    expect(edited.body).toMatchObject({ status: 'DRAFT', approval: { current: false } });
    await send().expect(409);
  });
});

describe('QC-4, QC-5: the export', () => {
  it('builds the built-in layout until the client’s QCR is uploaded', async () => {
    const file = await binary(
      request(app).get(`/api/v1/proposals/${caseId}/qcr/document?format=xlsx`).set(bearer(manager)),
    ).expect(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file.body as ArrayBuffer);
    expect(workbook.worksheets.map((sheet) => sheet.name).slice(0, 2)).toEqual([
      'premium details',
      'schedule',
    ]);
  });

  it('fills the client’s QCR template in its layout, with the figures as formulas', async () => {
    await request(app)
      .post('/api/v1/templates/QCR?fileName=Fiducial_QCR%20format.xlsx')
      .set(bearer(admin))
      .set('Content-Type', XLSX_CONTENT_TYPE)
      .send(CLIENT_QCR)
      .expect(200);
    const file = await binary(
      request(app).get(`/api/v1/proposals/${caseId}/qcr/document?format=xlsx`).set(bearer(manager)),
    ).expect(200);
    const original = new ExcelJS.Workbook();
    await original.xlsx.load(CLIENT_QCR as never);
    const filled = new ExcelJS.Workbook();
    await filled.xlsx.load(file.body as ArrayBuffer);
    expect(filled.worksheets.map((sheet) => sheet.name)).toEqual(
      original.worksheets.map((sheet) => sheet.name),
    );

    const premium = filled.getWorksheet('premium details')!;
    expect(premium.getCell('A1').value).toBe('PREMIUM COMPARISON FOR THE RENEWAL OF 2026-27');
    // Option 2 block (Proposed Option 1): A lowest, B second.
    expect(premium.getCell('E28').value).toBe('Test General, Fort\n(lowest total)');
    expect(premium.getCell('F28').value).toBe('Test General, Andheri');
    expect(premium.getCell('D31').value).toBe(60000000);
    expect([premium.getCell('E31').value, premium.getCell('F31').value]).toEqual([100000, 110000]);
    expect(premium.getCell('E45').value).toMatchObject({ formula: 'SUM(E31:E44)', result: 101500 });
    expect(premium.getCell('E46').value).toMatchObject({
      formula: 'ROUND(E45*0.18,2)',
      result: 18270,
    });
    expect(premium.getCell('E47').value).toMatchObject({ result: 119770 });
    expect(premium.getCell('C31').value).toBe(96000);
    // The existing insurer in place of "Insurer Name".
    expect(premium.getCell('B28').value).toBe('Example General Insurance, Fort');
    // Option 3 has no quotes: its block is hidden.
    expect(premium.getRow(53).hidden).toBe(true);
    expect(premium.getCell('A71').value).toBe(
      'Cheque / payment in favour of: Test General Insurance Co Ltd',
    );
    expect(premium.getCell('A72').text).toMatch(
      /^Our recommendation: Test General, Fort, Proposed Option 1\. Lowest premium/,
    );
    expect(premium.getCell('A73').text).toBe('Remarks: Changed');

    const schedule = filled.getWorksheet('schedule')!;
    expect(schedule.getCell('D17').value).toBe(60000000);
    expect(schedule.getCell('E17').value).toBe(70000000);
    expect(schedule.getCell('C17').value).toBe(50000000);

    const pdf = await binary(
      request(app).get(`/api/v1/proposals/${caseId}/qcr/document?format=pdf`).set(bearer(manager)),
    ).expect(200);
    const text = (pdf.body as Buffer).toString('latin1');
    expect(text.startsWith('%PDF')).toBe(true);
    expect(text.match(/\/MediaBox \[0 0 595\.28 841\.89\]/g)?.length).toBeGreaterThan(0);
  });
});
