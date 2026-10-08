import { OTHER_SECTIONS, RISK_DETAIL_FIELDS } from '../src/shared/index.ts';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLogModel } from '../src/modules/audit/audit.model.ts';
import { bearer, createTestApp, tokenFor, useTestDatabase } from './helpers/app.ts';
import { FakeTransport } from './helpers/mail.ts';
import { seedMasters } from './helpers/masters.ts';
import { approveRfq } from './helpers/rfq.ts';

// Client approval: the quote the client accepted from the QCR it received, with the client's mail
// as proof; recording it moves the case to Client Approval.

useTestDatabase();

const transport = new FakeTransport();
const app = createTestApp({}, undefined, transport);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');

let admin: string;
let manager: string;
let approver: string;
let readOnly: string;
let caseId: string;
const insurers: string[] = [];
const A = () => insurers[0] ?? '';
const B = () => insurers[1] ?? '';
const C = () => insurers[2] ?? '';

async function quote(insurerId: string, fire: [string, string | null], money: string, extra = {}) {
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
      attachmentIds: [pdf.body.id],
      ...extra,
    })
    .expect(201);
}

const approval = async () =>
  (
    await request(app)
      .get(`/api/v1/proposals/${caseId}/client-approval`)
      .set(bearer(readOnly))
      .expect(200)
  ).body;
const record = async () =>
  (await request(app).get(`/api/v1/proposals/${caseId}`).set(bearer(manager)).expect(200)).body;
const save = (body: object, token = manager) =>
  request(app).put(`/api/v1/proposals/${caseId}/client-approval`).set(bearer(token)).send(body);
const move = (stage: string) =>
  request(app).post(`/api/v1/proposals/${caseId}/stage`).set(bearer(manager)).send({ stage });
const upload = (data: Buffer, fileName: string) =>
  request(app)
    .post(
      `/api/v1/proposals/${caseId}/client-approval/files?fileName=${encodeURIComponent(fileName)}`,
    )
    .set(bearer(manager))
    .set('Content-Type', 'application/octet-stream')
    .send(data);

beforeAll(async () => {
  await seedMasters();
  admin = (await tokenFor(app, ['ADMIN'])).token;
  manager = (await tokenFor(app, ['ACCOUNT_MANAGER'])).token;
  approver = (await tokenFor(app, ['MANAGER'])).token;
  readOnly = (await tokenFor(app, ['READ_ONLY'])).token;
  const client = await request(app)
    .post('/api/v1/clients')
    .set(bearer(admin))
    .send({
      name: 'Approval Test Mills',
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
          hypothecation: null,
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
  await request(app)
    .put(`/api/v1/proposals/${caseId}/insurers/${C()}/response`)
    .set(bearer(manager))
    .send({ status: 'DECLINED', note: 'Outside appetite' })
    .expect(200);
  // The quotes moved the case to Quotes Received; the QCR's approval moves it to QCR.
  expect((await record()).stage).toBe('QUOTES_RECEIVED');
});

describe('Client approval', () => {
  it('waits for the QCR to reach the insured; the stage cannot be set by hand', async () => {
    const before = await approval();
    expect(before.approval).toBeNull();
    expect(before.blocked).toBe(
      'Send the QCR to the insured first (QCR tab): the client accepts a quote from the QCR it received.',
    );
    expect(before.contacts).toEqual(['Ravi Mehta']);
    expect(
      before.choices.map((choice: { insurerId: string; withoutTerrorism: unknown }) => [
        choice.insurerId,
        choice.withoutTerrorism,
      ]),
    ).toEqual([
      [A(), { net: '101500.00', gst: '18270.00', total: '119770.00' }],
      [B(), null],
    ]);
    // No stage after RFQ Sent is set by hand: the QCR, then the client approval, move it.
    expect((await move('QCR').expect(409)).body.message).toBe(
      'Get the QCR approved on the QCR tab; that moves the case to QCR.',
    );
    expect((await move('CLIENT_APPROVAL').expect(409)).body.message).toBe('The next stage is QCR.');
  });

  it('records the quote accepted with the client’s mail, and moves the case', async () => {
    const saved = await request(app)
      .put(`/api/v1/proposals/${caseId}/qcr`)
      .set(bearer(manager))
      .send({
        recommendedInsurerId: B(),
        recommendedOption: 'P1',
        recommendation: null,
        remarks: null,
        paymentInFavourOf: 'Test General Insurance Co Ltd',
      })
      .expect(200);
    await request(app)
      .post(`/api/v1/proposals/${caseId}/qcr/approve`)
      .set(bearer(approver))
      .send({ fingerprint: saved.body.fingerprint })
      .expect(200);
    expect((await record()).stage).toBe('QCR');
    await request(app)
      .post(`/api/v1/proposals/${caseId}/qcr/email`)
      .set(bearer(manager))
      .send({ sendId: randomUUID(), to: ['ravi@mills.example'], format: 'pdf' })
      .expect(200);
    const ready = await approval();
    expect(ready.blocked).toBeNull();
    expect(
      ready.choices.map((choice: { recommended: boolean; lowest: boolean }) => [
        choice.recommended,
        choice.lowest,
      ]),
    ).toEqual([
      [false, true],
      [true, false],
    ]);

    // Only the client's mail, a PDF or a picture of it is kept.
    const text = await upload(Buffer.from('not a pdf'), 'reply.pdf').expect(400);
    expect(text.body.details[0].message).toMatch(/^Attach the client’s mail/);
    const file = await upload(PDF, 'Client reply.pdf').expect(201);
    const fileId = file.body.id as string;

    const base = {
      insurerId: A(),
      option: 'P1',
      withTerrorism: false,
      acceptedOn: '2026-10-07',
      confirmedBy: 'Ravi Mehta',
      note: 'Accepted by mail',
      attachmentIds: [fileId],
    };
    const issues = async (body: object) =>
      (await save(body).expect(400)).body.details.map((d: { message: string }) => d.message);
    expect(await issues({ ...base, withTerrorism: null })).toEqual([
      'Say whether the client takes Fire with or without terrorism',
    ]);
    expect(await issues({ ...base, acceptedOn: '2099-01-01' })).toEqual([
      'The date cannot be in the future',
    ]);
    expect(await issues({ ...base, insurerId: C() })).toEqual([
      'Choose an insurer and option compared in the QCR',
    ]);
    expect(await issues({ ...base, attachmentIds: [] })).toEqual([
      'Attach the client’s email or signed letter',
    ]);
    await save(base, readOnly).expect(403);

    const recorded = await save(base).expect(200);
    expect(recorded.body.approval).toMatchObject({
      insurerId: A(),
      company: 'Test General',
      branch: 'Fort',
      option: 'P1',
      withTerrorism: false,
      premium: { net: '101500.00', gst: '18270.00', total: '119770.00' },
      acceptedOn: '2026-10-07',
      confirmedBy: 'Ravi Mehta',
      note: 'Accepted by mail',
      files: [{ id: fileId, fileName: 'Client reply.pdf' }],
      quoteCurrent: true,
    });
    const after = await record();
    expect([after.stage, after.nextStage]).toEqual(['CLIENT_APPROVAL', 'PLACEMENT_SLIP']);
    expect(after.activity.map((entry: { message: string }) => entry.message)).toContain(
      'Client approval recorded: Test General, Fort, Proposed Option 1, Fire without terrorism, total ₹1,19,770.00; confirmed by Ravi Mehta on 07 Oct 2026',
    );
    const download = await request(app)
      .get(`/api/v1/proposals/${caseId}/client-approval/files/${fileId}`)
      .set(bearer(readOnly))
      .expect(200);
    expect(download.headers['content-type']).toBe('application/pdf');
  });

  it('can be corrected until the case is placed; a newer quote is flagged', async () => {
    const fileId = (await approval()).files[0].id as string;
    const corrected = await save({
      insurerId: B(),
      option: 'P1',
      // B quoted Fire one way only: the choice is not kept.
      withTerrorism: true,
      acceptedOn: '2026-10-08',
      confirmedBy: 'Ravi Mehta',
      note: null,
      attachmentIds: [fileId],
    }).expect(200);
    expect(corrected.body.approval).toMatchObject({
      insurerId: B(),
      branch: 'Andheri',
      withTerrorism: null,
      premium: { net: '116000.00', gst: '20880.00', total: '136880.00' },
    });
    expect((await record()).stage).toBe('CLIENT_APPROVAL');
    expect(await AuditLogModel.countDocuments({ action: 'CLIENT_APPROVAL_RECORDED' })).toBe(2);

    await quote(B(), ['110000', null], '1000', { reason: 'Discount' });
    expect((await approval()).approval).toMatchObject({
      version: 1,
      premium: { total: '136880.00' },
      quoteCurrent: false,
    });

    // Placed through the placement slip (placement-slip.test.ts); here it is set directly.
    const { PlacementSlipModel } =
      await import('../src/modules/placement-slip/placement-slip.model.ts');
    const { Types } = await import('mongoose');
    await PlacementSlipModel.collection.insertOne({
      proposalId: new Types.ObjectId(caseId),
      sends: [{ result: 'OUTBOX' }],
      placed: { number: 'P-1' },
    });
    await move('PLACEMENT_SLIP').expect(200);
    await move('PLACED').expect(200);
    const placed = await approval();
    expect(placed.blocked).toBe('The case is placed: the client approval can no longer change.');
    await save({
      insurerId: A(),
      option: 'P1',
      withTerrorism: true,
      acceptedOn: '2026-10-08',
      confirmedBy: 'Ravi Mehta',
      note: null,
      attachmentIds: [fileId],
    }).expect(409);
  });
});
