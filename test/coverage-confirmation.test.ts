import { OTHER_SECTIONS, RISK_DETAIL_FIELDS, XLSX_CONTENT_TYPE } from '../src/shared/index.ts';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLogModel } from '../src/modules/audit/audit.model.ts';
import { MailLogModel } from '../src/modules/mail/mail-log.model.ts';
import { bearer, createTestApp, tokenFor, useTestDatabase } from './helpers/app.ts';
import { FakeTransport } from './helpers/mail.ts';
import { seedMasters } from './helpers/masters.ts';
import { approveRfq } from './helpers/rfq.ts';

// Q4: the coverage confirmation. A case is built through to Placed (an insurer policy recorded),
// then the insurer's confirmation of cover is recorded, the letter is generated, and the
// confirmation is emailed to the insured. Nothing is sent by recording; a letter / email is a
// separate explicit step. Policy details come from the placement slip; nothing is fabricated.

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
let readOnly: string;
let caseId: string;
let policyFileId: string;
const insurers: string[] = [];
const A = () => insurers[0] ?? '';

const binary = (req: request.Test) =>
  req.buffer(true).parse((res, done) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('end', () => done(null, Buffer.concat(chunks)));
  });

const coverage = async (token = manager) =>
  (
    await request(app)
      .get(`/api/v1/proposals/${caseId}/coverage-confirmation`)
      .set(bearer(token))
      .expect(200)
  ).body;

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
      capacityPercent: '100',
      attachmentIds: [pdf.body.id],
    })
    .expect(201);
}

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
      name: 'Cover Test Mills',
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
        { name: 'Priya Shah', designation: 'MD', email: 'priya@mills.example', phone: null },
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
  // Client approval.
  const approvalFile = await request(app)
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
      attachmentIds: [approvalFile.body.id],
    })
    .expect(200);
  // Placement slip: upload the template, approve, send, record the policy (moves to Placed).
  await request(app)
    .post('/api/v1/templates/PLACEMENT_SLIP?fileName=Fiducial_Placement%20slip%20format.xlsx')
    .set(bearer(admin))
    .set('Content-Type', XLSX_CONTENT_TYPE)
    .send(SLIP_FORMAT)
    .expect(200);
  const slip = await request(app)
    .put(`/api/v1/proposals/${caseId}/placement-slip`)
    .set(bearer(manager))
    .send({ remarks: 'Premium by cheque.' })
    .expect(200);
  await request(app)
    .post(`/api/v1/proposals/${caseId}/placement-slip/approve`)
    .set(bearer(approver))
    .send({ fingerprint: slip.body.fingerprint })
    .expect(200);
  await request(app)
    .post(`/api/v1/proposals/${caseId}/placement-slip/email`)
    .set(bearer(manager))
    .send({ sendId: randomUUID(), to: ['fort@insurer.example'], format: 'xlsx' })
    .expect(200);
  const policyFile = await request(app)
    .post(`/api/v1/proposals/${caseId}/placement-slip/files?fileName=Policy.pdf`)
    .set(bearer(manager))
    .set('Content-Type', 'application/pdf')
    .send(PDF)
    .expect(201);
  policyFileId = policyFile.body.id as string;
  await request(app)
    .put(`/api/v1/proposals/${caseId}/placement-slip/placed`)
    .set(bearer(manager))
    .send({
      documentKind: 'POLICY',
      number: 'TGI/FIRE/2026/1234',
      issuedOn: '2026-10-08',
      note: null,
      attachmentIds: [policyFile.body.id],
    })
    .expect(200);
});

describe('Q4: coverage confirmation', () => {
  it('reads policy details from the placement slip and blocks recording until placed', async () => {
    const before = await coverage();
    // The case is placed, so the policy details are available and nothing blocks recording.
    expect(before.confirmation).toBeNull();
    expect(before.blocked).toBeNull();
    expect(before.missing).toEqual([]);
    expect(before.presentationPending).toBe(true);
    expect(before.policy).toMatchObject({
      insuredName: 'Cover Test Mills',
      insurerName: 'Test General',
      insurerBranch: 'Fort',
      documentKind: 'POLICY',
      policyNumber: 'TGI/FIRE/2026/1234',
      issuedOn: '2026-10-08',
      policyStart: '2026-12-01',
      policyEnd: '2027-11-30',
      option: 'P1',
      premium: { net: '101500.00', gst: '18270.00', total: '119770.00' },
      reference: before.policy.reference,
    });
    // Both client contacts are offered as recipients (reused from Q3).
    expect(before.recipients).toEqual([
      { name: 'Ravi Mehta', email: 'ravi@mills.example' },
      { name: 'Priya Shah', email: 'priya@mills.example' },
    ]);
    // The placement file is available as the insurer's proof.
    expect(before.files.map((file: { id: string }) => file.id)).toContain(policyFileId);
  });

  it('records the insurer confirmation without sending, and audits it', async () => {
    const recorded = await request(app)
      .put(`/api/v1/proposals/${caseId}/coverage-confirmation`)
      .set(bearer(manager))
      .send({
        confirmedOn: '2026-10-09',
        insurerReference: 'CONF/2026/88',
        channel: 'BOTH',
        notes: 'Cover confirmed by the insurer by email.',
        signatoryName: null,
        signatoryTitle: null,
        attachmentIds: [policyFileId],
      })
      .expect(200);
    expect(recorded.body.confirmation).toMatchObject({
      confirmedOn: '2026-10-09',
      insurerReference: 'CONF/2026/88',
      channel: 'BOTH',
      recordedBy: expect.any(String) as unknown,
    });
    // Recording never sends.
    expect(recorded.body.sends).toEqual([]);
    expect(
      await MailLogModel.countDocuments({ proposalId: caseId, kind: 'COVERAGE_CONFIRMATION' }),
    ).toBe(0);
    expect(await AuditLogModel.countDocuments({ action: 'COVERAGE_CONFIRMATION_RECORDED' })).toBe(
      1,
    );
    // Editing records an UPDATED audit entry.
    await request(app)
      .put(`/api/v1/proposals/${caseId}/coverage-confirmation`)
      .set(bearer(manager))
      .send({ confirmedOn: '2026-10-09', channel: 'LETTER', signatoryName: 'A. Broker' })
      .expect(200);
    expect(await AuditLogModel.countDocuments({ action: 'COVERAGE_CONFIRMATION_UPDATED' })).toBe(1);
  });

  it('rejects an attachment not uploaded for this case', async () => {
    const bad = await request(app)
      .put(`/api/v1/proposals/${caseId}/coverage-confirmation`)
      .set(bearer(manager))
      .send({ confirmedOn: '2026-10-09', attachmentIds: ['0'.repeat(24)] })
      .expect(400);
    expect(bad.body.details[0].message).toMatch(/uploaded for this case/);
  });

  it('generates a branded PDF letter from the live policy details', async () => {
    const pdf = await binary(
      request(app)
        .get(`/api/v1/proposals/${caseId}/coverage-confirmation/document`)
        .set(bearer(manager)),
    ).expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    expect(await AuditLogModel.countDocuments({ action: 'COVERAGE_CONFIRMATION_DOWNLOADED' })).toBe(
      1,
    );
  });

  it('emails the confirmation to the insured, idempotent per sendId, and logs it', async () => {
    const sendId = randomUUID();
    const before = transport.sent.length;
    const sent = await request(app)
      .post(`/api/v1/proposals/${caseId}/coverage-confirmation/email`)
      .set(bearer(manager))
      .send({ sendId, to: ['ravi@mills.example', 'priya@mills.example'], attachLetter: true })
      .expect(200);
    expect(sent.body).toMatchObject({ outcome: 'SENT' });
    expect(sent.body.coverage.sends).toHaveLength(1);
    expect(transport.sent.at(-1)).toMatchObject({
      to: ['ravi@mills.example', 'priya@mills.example'],
      attachment: {
        fileName: expect.stringMatching(/^Coverage-Confirmation-PRP-\d{4}-\d{4}\.pdf$/) as string,
      },
    });
    // The same send again never mails twice.
    await request(app)
      .post(`/api/v1/proposals/${caseId}/coverage-confirmation/email`)
      .set(bearer(manager))
      .send({ sendId, to: ['ravi@mills.example', 'priya@mills.example'], attachLetter: true })
      .expect(200);
    expect(transport.sent).toHaveLength(before + 1);
    expect(
      await MailLogModel.countDocuments({ proposalId: caseId, kind: 'COVERAGE_CONFIRMATION' }),
    ).toBe(1);
    expect(await AuditLogModel.countDocuments({ action: 'COVERAGE_CONFIRMATION_EMAILED' })).toBe(1);
  });

  it('refuses the letter and email until a confirmation is recorded (fresh case path)', async () => {
    // A read-only user cannot record or send (authorization on the backend).
    await request(app)
      .put(`/api/v1/proposals/${caseId}/coverage-confirmation`)
      .set(bearer(readOnly))
      .send({ confirmedOn: '2026-10-09' })
      .expect(403);
    await request(app)
      .get(`/api/v1/proposals/${caseId}/coverage-confirmation/document`)
      .set(bearer(readOnly))
      .expect(403);
  });
});
