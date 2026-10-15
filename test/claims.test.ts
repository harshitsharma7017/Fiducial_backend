import {
  ClaimBoardSchema,
  ClaimDetailSchema,
  ClaimListResponseSchema,
  PublicClaimLinkSchema,
  emptyGhiRequirements,
} from '../src/shared/index.ts';
import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { ClaimEventModel, ClaimNotificationModel } from '../src/modules/claims/claim.model.ts';
import { ClaimLinkModel } from '../src/modules/claims/claim-settings.model.ts';
import {
  processDueClaimNotifications,
  sendClaimNotification,
} from '../src/modules/claims/claim-notifications.ts';
import { GhiCaseModel } from '../src/modules/ghi/ghi-case.model.ts';
import { GhiMemberModel } from '../src/modules/ghi/ghi-census.model.ts';
import { offTransport } from '../src/modules/mail/transport.ts';
import { ProposalModel } from '../src/modules/proposals/proposal.model.ts';
import { bearer, createTestApp, tokenFor, useTestDatabase } from './helpers/app.ts';
import { FakeTransport } from './helpers/mail.ts';
import { seedMasters } from './helpers/masters.ts';

// Group health claims end to end (C1 to C4), on synthetic data: a placed policy with a small census,
// a claim created by staff and one submitted by an employee through a link, documents, the four
// statuses with remarks, the emails to the claimant and HR with failures and retries, the
// templates, the timeline, the table and the permissions. GHI and Property stay untouched.

useTestDatabase();

const transport = new FakeTransport();
const app = createTestApp({}, undefined, transport);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

let admin: string;
let manager: string;
let managerId: string;
let exec: string;
let approver: string;
let readOnly: string;
let clientId: string;
let otherClientId: string;
let caseId: string;
let unplacedCaseId: string;
const member: Record<string, string> = {};
let claimId: string;

const c = (path = '') => `/api/v1/claims${path}`;

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

/** A GHI case with its policy recorded, and its census: two families. */
async function placedCase(forClient: string, insurerId: string, placed = true) {
  const userId = new Types.ObjectId(managerId);
  const doc = await GhiCaseModel.create({
    reference: `GHI-2026-${String(Math.floor(Math.random() * 9000) + 1000)}`,
    type: 'NEW',
    stage: 'PLACEMENT_SLIP',
    closedReason: null,
    clientId: new Types.ObjectId(forClient),
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
    policy: placed
      ? {
          policyNumber: 'GMC/2026/0042',
          issuedOn: '2026-03-30',
          policyStart: '2026-04-01',
          policyEnd: '2027-03-31',
          renewalDate: '2027-04-01',
          insurerId: new Types.ObjectId(insurerId),
          quoteId: new Types.ObjectId(),
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
        }
      : null,
    activity: [],
    createdBy: userId,
    updatedBy: userId,
  });
  const rows = [
    ['E001', 'Ravi Kumar', 'MALE', '1988-02-10', 'SELF', '500000'],
    ['E001', 'Anita Kumar', 'FEMALE', '1990-07-01', 'SPOUSE', null],
    ['E001', 'Kabir Kumar', 'MALE', '2016-09-12', 'CHILD', null],
    ['E002', 'Meena Iyer', 'FEMALE', '1985-11-23', 'SELF', '500000'],
    ['E002', 'Suresh Iyer', 'MALE', '1955-01-05', 'FATHER', null],
  ] as const;
  const members = await GhiMemberModel.insertMany(
    rows.map(([employeeId, name, gender, dateOfBirth, relationship, sumInsured]) => ({
      caseId: doc._id,
      employeeId,
      employeeKey: employeeId,
      name,
      nameKey: name.toLowerCase(),
      gender,
      dateOfBirth,
      relationship,
      dateOfJoining: null,
      sumInsured: sumInsured ? Types.Decimal128.fromString(sumInsured) : null,
      source: 'MANUAL',
      importId: null,
      createdBy: userId,
      updatedBy: userId,
    })),
  );
  return { id: doc._id.toHexString(), members: members.map((item) => item._id.toHexString()) };
}

const details = {
  hospital: { name: 'Lakeview Hospital', city: 'Pune' },
  admissionDate: '2026-06-02',
  dischargeDate: '2026-06-06',
  claimType: 'REIMBURSEMENT',
  amountClaimed: '48500.50',
  contactEmail: 'ravi.kumar@acme.example',
  contactPhone: '',
};
const createBody = (overrides: Record<string, unknown> = {}) => ({
  clientId,
  ghiCaseId: caseId,
  employeeMemberId: member.ravi,
  patientMemberId: member.anita,
  ...details,
  ...overrides,
});
const upload = (id: string, kind: string, data: Buffer, fileName: string, token = manager) =>
  request(app)
    .post(c(`/${id}/documents?kind=${kind}&fileName=${fileName}`))
    .set(bearer(token))
    .set('Content-Type', 'application/octet-stream')
    .send(data);
const move = (id: string, from: string, to: string, remark: string, token = manager) =>
  request(app)
    .post(c(`/${id}/transitions`))
    .set(bearer(token))
    .send({ toStatus: to, expectedStatus: from, remark });
const detail = async (id: string, token = manager) =>
  ClaimDetailSchema.parse(
    (
      await request(app)
        .get(c(`/${id}`))
        .set(bearer(token))
        .expect(200)
    ).body,
  );
const binary = (req: request.Test) =>
  req.buffer(true).parse((res, done) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('end', () => done(null, Buffer.concat(chunks)));
  });

beforeAll(async () => {
  await seedMasters();
  admin = (await tokenFor(app, ['ADMIN'])).token;
  const created = await tokenFor(app, ['ACCOUNT_MANAGER']);
  manager = created.token;
  managerId = created.user.id;
  exec = (await tokenFor(app, ['PLACEMENT_EXEC'])).token;
  approver = (await tokenFor(app, ['MANAGER'])).token;
  readOnly = (await tokenFor(app, ['READ_ONLY'])).token;
  clientId = await client('Acme Health Group Pvt Ltd', '27AAPFU0939F1ZV');
  otherClientId = await client('Other Works Ltd', '29AAGCB7383J1Z4');
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
  const placed = await placedCase(clientId, insurer.body.id as string);
  caseId = placed.id;
  [member.ravi, member.anita, member.kabir, member.meena, member.suresh] = placed.members as [
    string,
    string,
    string,
    string,
    string,
  ];
  unplacedCaseId = (await placedCase(clientId, insurer.body.id as string, false)).id;
});

describe('access', () => {
  it('needs sign-in and the claims permissions; Read-only users see no claims', async () => {
    await request(app).get(c()).expect(401);
    await request(app).get(c()).set(bearer(readOnly)).expect(403);
    await request(app).get(c('/board')).set(bearer(approver)).expect(200);
    await request(app).post(c()).set(bearer(approver)).send(createBody()).expect(403);
  });
});

describe('claim creation (C2)', () => {
  it('offers placed policies, their employees and each employee’s covered family from the census', async () => {
    const policies = (await request(app).get(c('/policies')).set(bearer(manager)).expect(200)).body
      .items;
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatchObject({
      ghiCaseId: caseId,
      policyNumber: 'GMC/2026/0042',
      clientName: 'Acme Health Group Pvt Ltd',
    });
    const employees = (
      await request(app)
        .get(c(`/policies/${caseId}/employees?q=meena`))
        .set(bearer(manager))
        .expect(200)
    ).body.items;
    expect(employees.map((item: { name: string }) => item.name)).toEqual(['Meena Iyer']);
    const family = (
      await request(app)
        .get(c(`/policies/${caseId}/employees/${member.ravi}/family`))
        .set(bearer(manager))
        .expect(200)
    ).body.items;
    expect(family.map((item: { relationship: string }) => item.relationship)).toEqual([
      'SELF',
      'SPOUSE',
      'CHILD',
    ]);
    await request(app)
      .get(c(`/policies/${unplacedCaseId}/employees`))
      .set(bearer(manager))
      .expect(400);
  });

  it('checks the company, policy, employee and patient on the server', async () => {
    const field = async (body: Record<string, unknown>) =>
      (
        (await request(app).post(c()).set(bearer(manager)).send(createBody(body)).expect(400)).body
          .details as { path: string; message: string }[]
      )[0];
    expect(await field({ patientMemberId: member.suresh })).toMatchObject({
      path: 'patientMemberId',
    });
    expect(await field({ employeeMemberId: member.anita })).toMatchObject({
      path: 'employeeMemberId',
    });
    expect(await field({ clientId: otherClientId })).toMatchObject({
      path: 'ghiCaseId',
      message: 'This policy is not the chosen company’s',
    });
    expect(await field({ ghiCaseId: unplacedCaseId })).toMatchObject({
      path: 'ghiCaseId',
      message: expect.stringMatching(/placed policy/),
    });
    expect(await field({ admissionDate: '2026-03-20', dischargeDate: '2026-03-25' })).toMatchObject(
      { path: 'admissionDate', message: expect.stringMatching(/outside the policy period/) },
    );
    expect(await field({ dischargeDate: '2026-06-01' })).toMatchObject({ path: 'dischargeDate' });
    expect(await field({ amountClaimed: '0' })).toMatchObject({ path: 'amountClaimed' });
    expect(await field({ contactEmail: 'not-an-email' })).toMatchObject({ path: 'contactEmail' });
    expect(
      await field({
        claimType: 'CASHLESS',
        admissionDate: '2099-01-01',
        dischargeDate: '2099-01-02',
      }),
    ).toMatchObject({ path: 'admissionDate' });
  });

  it('creates a claim in Form, assigned to its creator, shown on the board with its card details', async () => {
    const created = ClaimDetailSchema.parse(
      (await request(app).post(c()).set(bearer(manager)).send(createBody()).expect(201)).body,
    );
    claimId = created.id;
    expect(created).toMatchObject({
      status: 'FORM',
      source: 'STAFF',
      client: { name: 'Acme Health Group Pvt Ltd' },
      employee: { employeeId: 'E001', name: 'Ravi Kumar' },
      patient: { name: 'Anita Kumar', relationship: 'SPOUSE' },
      amountClaimed: '48500.50',
      assignedTo: { id: managerId },
      missingDocuments: ['MEDICAL_BILL', 'DISCHARGE_SUMMARY', 'ID_PROOF'],
      allowedMoves: ['SUBMITTED'],
    });
    expect(created.claimNumber).toMatch(/^CLM-\d{4}-0001$/);
    expect(created.timeline.map((event) => event.type)).toEqual(['CREATED']);
    const board = ClaimBoardSchema.parse(
      (await request(app).get(c('/board')).set(bearer(exec)).expect(200)).body,
    );
    expect(board.columns.map((column) => column.status)).toEqual([
      'FORM',
      'SUBMITTED',
      'INVESTIGATION',
      'APPROVED',
    ]);
    expect(board.columns[0]!.items[0]).toMatchObject({
      claimNumber: created.claimNumber,
      employeeName: 'Ravi Kumar',
      patientName: 'Anita Kumar',
      relationship: 'SPOUSE',
      hospital: 'Lakeview Hospital, Pune',
      amountClaimed: '48500.50',
      daysInStage: 0,
      // Not assigned to this user.
      canMove: false,
    });
  });
});

describe('documents', () => {
  it('keeps PDF, PNG and JPEG files of the right size, from the assigned staff only', async () => {
    await upload(claimId, 'MEDICAL_BILL', PDF, 'bills.pdf').expect(201);
    await upload(claimId, 'DISCHARGE_SUMMARY', PDF, 'discharge.pdf').expect(201);
    const notAllowed = await upload(claimId, 'ID_PROOF', Buffer.from('hello'), 'id.txt').expect(
      400,
    );
    expect(notAllowed.body.details[0].message).toBe('Upload a PDF, PNG or JPEG file');
    await upload(claimId, 'ID_PROOF', Buffer.alloc(11 * 1024 * 1024, 1), 'big.pdf').expect(413);
    await upload(claimId, 'ID_PROOF', PNG, 'id.png', exec).expect(403);
    const id = await upload(claimId, 'ID_PROOF', PNG, 'id.png').expect(201);
    expect(id.body).toMatchObject({
      kind: 'ID_PROOF',
      contentType: 'image/png',
      uploadedBy: 'Test User',
    });
  });

  it('lets only those who may view claims open a document, and logs each opening', async () => {
    const record = await detail(claimId);
    const bill = record.documents.find((doc) => doc.kind === 'MEDICAL_BILL')!;
    await request(app)
      .get(c(`/${claimId}/documents/${bill.id}`))
      .set(bearer(readOnly))
      .expect(403);
    const file = await binary(
      request(app)
        .get(c(`/${claimId}/documents/${bill.id}?disposition=inline`))
        .set(bearer(approver)),
    ).expect(200);
    expect((file.body as Buffer).equals(PDF)).toBe(true);
    expect(file.headers['content-disposition']).toMatch(/^inline/);
    expect(file.headers['cache-control']).toBe('no-store');
    const otherClaim = new Types.ObjectId().toHexString();
    await request(app)
      .get(c(`/${otherClaim}/documents/${bill.id}`))
      .set(bearer(approver))
      .expect(404);
    const audit = (
      await request(app)
        .get(`/api/v1/audit?entity=claim&entityId=${claimId}&kind=EXPORT`)
        .set(bearer(admin))
        .expect(200)
    ).body.items;
    expect(audit[0]).toMatchObject({ action: 'CLAIM_DOCUMENT_DOWNLOADED' });
  });
});

describe('status changes, emails and timeline (C1, C3, C4)', () => {
  it('needs a remark, an allowed move, the current status and the assignee or an Admin', async () => {
    transport.reset();
    const noRemark = await move(claimId, 'FORM', 'SUBMITTED', '   ').expect(400);
    expect(noRemark.body.details[0]).toMatchObject({ path: 'remark' });
    const skip = await move(claimId, 'FORM', 'INVESTIGATION', 'Skip ahead').expect(409);
    expect(skip.body.code).toBe('CLAIM_TRANSITION_NOT_ALLOWED');
    const stale = await move(claimId, 'SUBMITTED', 'INVESTIGATION', 'Stale board').expect(409);
    expect(stale.body.code).toBe('CLAIM_STATUS_CHANGED');
    await move(claimId, 'FORM', 'SUBMITTED', 'Not mine', exec).expect(403);
    await move(claimId, 'FORM', 'SUBMITTED', 'Viewer', approver).expect(403);
    // Nothing was saved or mailed for the refused moves.
    expect(transport.calls).toBe(0);
    expect(await ClaimNotificationModel.countDocuments({})).toBe(0);
    expect((await detail(claimId)).status).toBe('FORM');
  });

  it('refuses Submitted until the bills, discharge summary and ID proof are in', async () => {
    const second = await request(app)
      .post(c())
      .set(bearer(manager))
      .send(createBody({ patientMemberId: member.kabir }))
      .expect(201);
    const refused = await move(second.body.id as string, 'FORM', 'SUBMITTED', 'Submitting').expect(
      409,
    );
    expect(refused.body).toMatchObject({
      code: 'CLAIM_DOCUMENTS_MISSING',
      details: { missing: ['MEDICAL_BILL', 'DISCHARGE_SUMMARY', 'ID_PROOF'] },
    });
  });

  it('lets an Admin edit the templates, with checked merge fields and versions', async () => {
    await request(app).get(c('/email-templates')).set(bearer(manager)).expect(403);
    const list = (await request(app).get(c('/email-templates')).set(bearer(admin)).expect(200)).body
      .items;
    expect(
      list.map((item: { status: string; audience: string }) => `${item.status}/${item.audience}`),
    ).toEqual([
      'SUBMITTED/CLAIMANT',
      'SUBMITTED/HR',
      'INVESTIGATION/CLAIMANT',
      'INVESTIGATION/HR',
      'APPROVED/CLAIMANT',
      'APPROVED/HR',
    ]);
    const bad = await request(app)
      .put(c('/email-templates/SUBMITTED/CLAIMANT'))
      .set(bearer(admin))
      .send({ subject: 'Claim {{claimNo}}', body: 'Hello', expectedVersion: 1 })
      .expect(400);
    expect(bad.body.details[0]).toMatchObject({
      path: 'subject',
      message: expect.stringMatching(/\{\{claimNo\}\} is not a merge field/),
    });
    const saved = await request(app)
      .put(c('/email-templates/SUBMITTED/CLAIMANT'))
      .set(bearer(admin))
      .send({
        subject: '[{{claimNumber}}] now {{status}}',
        body: 'Dear {{recipientName}},\nClaim {{claimNumber}} of {{employeeName}} is {{status}} (was {{previousStatus}}) on {{date}}.\nRemark: {{remark}}',
        expectedVersion: 1,
      })
      .expect(200);
    expect(saved.body).toMatchObject({ version: 2, isDefault: false });
    await request(app)
      .put(c('/email-templates/SUBMITTED/CLAIMANT'))
      .set(bearer(admin))
      .send({ subject: 'x', body: 'y', expectedVersion: 1 })
      .expect(409);
    await request(app)
      .put(c('/email-templates/FORM/CLAIMANT'))
      .set(bearer(admin))
      .send({ subject: 'x', body: 'y', expectedVersion: 1 })
      .expect(404);
  });

  it('moves Form → Submitted and emails the claimant and HR with the number, status, date and remark', async () => {
    await request(app)
      .put(c(`/hr-contacts/${clientId}`))
      .set(bearer(manager))
      .send({ name: 'Neha HR', email: 'hr@acme.example', notify: true })
      .expect(403);
    await request(app)
      .put(c(`/hr-contacts/${clientId}`))
      .set(bearer(admin))
      .send({ name: 'Neha HR', email: '', notify: true })
      .expect(400);
    await request(app)
      .put(c(`/hr-contacts/${clientId}`))
      .set(bearer(admin))
      .send({ name: 'Neha HR', email: 'HR@acme.example', notify: true })
      .expect(200);
    transport.reset();
    const moved = await move(claimId, 'FORM', 'SUBMITTED', 'All documents received.').expect(200);
    expect(moved.body.claim.status).toBe('SUBMITTED');
    expect(
      moved.body.notifications.map(
        (item: { audience: string; recipient: string; status: string }) => [
          item.audience,
          item.recipient,
          item.status,
        ],
      ),
    ).toEqual([
      ['CLAIMANT', 'ravi.kumar@acme.example', 'ACCEPTED'],
      ['HR', 'hr@acme.example', 'ACCEPTED'],
    ]);
    const today = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    }).format(new Date());
    const [claimant, hr] = transport.sent;
    expect(claimant?.to).toEqual(['ravi.kumar@acme.example']);
    expect(claimant?.subject).toBe(`[${moved.body.claim.claimNumber as string}] now Submitted`);
    expect(claimant?.text).toBe(
      `Dear Ravi Kumar,\nClaim ${moved.body.claim.claimNumber as string} of Ravi Kumar is Submitted (was Form) on ${today}.\nRemark: All documents received.`,
    );
    expect(hr?.to).toEqual(['hr@acme.example']);
    expect(hr?.subject).toBe(`Claim ${moved.body.claim.claimNumber as string}: Submitted`);
    expect(hr?.text).toContain('Dear Neha HR,');
    expect(hr?.text).toContain('Remark: All documents received.');
    expect(hr?.html).not.toContain('<script');
  });

  it('lets an Admin move a claim not assigned to them, and escapes remarks in the HTML mail', async () => {
    transport.reset();
    await move(
      claimId,
      'SUBMITTED',
      'INVESTIGATION',
      'Insurer asked for <b>pharmacy</b> bills',
      admin,
    ).expect(200);
    expect(transport.sent).toHaveLength(2);
    expect(transport.sent[0]?.html).toContain('&lt;b&gt;pharmacy&lt;/b&gt;');
  });

  it('emails only the claimant once HR is switched off, and Approved is the last move', async () => {
    await request(app)
      .put(c(`/hr-contacts/${clientId}`))
      .set(bearer(admin))
      .send({ name: 'Neha HR', email: 'hr@acme.example', notify: false })
      .expect(200);
    transport.reset();
    const approved = await move(
      claimId,
      'INVESTIGATION',
      'APPROVED',
      'Approved by the insurer for ₹45,000.',
    ).expect(200);
    expect(approved.body.notifications).toHaveLength(1);
    expect(transport.sent.map((mail) => mail.to)).toEqual([['ravi.kumar@acme.example']]);
    expect(approved.body.claim.allowedMoves).toEqual([]);
    await move(claimId, 'APPROVED', 'SUBMITTED', 'Back', admin).expect(409);
    await request(app)
      .put(c(`/${claimId}`))
      .set(bearer(manager))
      .send(details)
      .expect(403);
  });

  it('keeps a complete, append-only timeline that survives a reload', async () => {
    const record = await detail(claimId, approver);
    const types = record.timeline.map((event) => event.type);
    expect(types).toEqual([
      'CREATED',
      'DOCUMENT_UPLOADED',
      'DOCUMENT_UPLOADED',
      'DOCUMENT_UPLOADED',
      'STATUS_CHANGED',
      'EMAIL_SENT',
      'EMAIL_SENT',
      'STATUS_CHANGED',
      'EMAIL_SENT',
      'EMAIL_SENT',
      'STATUS_CHANGED',
      'EMAIL_SENT',
    ]);
    const moves = record.timeline.filter((event) => event.type === 'STATUS_CHANGED');
    expect(
      moves.map((event) => [event.fromStatus, event.toStatus, event.remark, event.actor.name]),
    ).toEqual([
      ['FORM', 'SUBMITTED', 'All documents received.', 'Test User'],
      ['SUBMITTED', 'INVESTIGATION', 'Insurer asked for <b>pharmacy</b> bills', 'Test User'],
      ['INVESTIGATION', 'APPROVED', 'Approved by the insurer for ₹45,000.', 'Test User'],
    ]);
    const mails = record.timeline.filter((event) => event.type === 'EMAIL_SENT');
    expect(mails[0]).toMatchObject({
      actor: { kind: 'SYSTEM' },
      toStatus: 'SUBMITTED',
      email: {
        audience: 'CLAIMANT',
        recipient: 'ravi.kumar@acme.example',
        result: 'ACCEPTED',
        attempt: 1,
      },
    });
    expect(record.notifications).toHaveLength(5);
    await expect(
      ClaimEventModel.updateOne(
        { claimId: new Types.ObjectId(claimId) },
        { $set: { remark: 'changed' } },
      ),
    ).rejects.toThrow(/append-only/);
    await expect(ClaimEventModel.deleteMany({})).rejects.toThrow(/append-only/);
  });
});

describe('email failures and retries (C3)', () => {
  let failingId: string;

  it('keeps the move when the mail fails, retries automatically, then waits for a person', async () => {
    const created = await request(app)
      .post(c())
      .set(bearer(manager))
      .send(createBody({ patientMemberId: member.ravi, contactEmail: 'bounce@acme.example' }))
      .expect(201);
    failingId = created.body.id as string;
    for (const [kind, file] of [
      ['MEDICAL_BILL', PDF],
      ['DISCHARGE_SUMMARY', PDF],
      ['ID_PROOF', PNG],
    ] as const) {
      await upload(failingId, kind, file, `${kind}.pdf`).expect(201);
    }
    transport.reset();
    transport.failFor.add('bounce@acme.example');
    const moved = await move(
      failingId,
      'FORM',
      'SUBMITTED',
      'Submitting despite mail trouble',
    ).expect(200);
    expect(moved.body.claim.status).toBe('SUBMITTED');
    expect(moved.body.notifications[0]).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      error: expect.stringMatching(/550 bounce@acme.example/),
    });

    const notification = await ClaimNotificationModel.findOne({
      claimId: new Types.ObjectId(failingId),
    }).lean();
    // Not due yet: nothing is sent early.
    expect(await processDueClaimNotifications(transport)).toBe(0);
    for (const attempt of [2, 3]) {
      await ClaimNotificationModel.updateOne(
        { _id: notification!._id },
        { $set: { nextAttemptAt: new Date(Date.now() - 1000) } },
      );
      expect(await processDueClaimNotifications(transport)).toBe(1);
      const now = await ClaimNotificationModel.findById(notification!._id).lean();
      expect(now).toMatchObject({ attempts: attempt, status: attempt < 3 ? 'PENDING' : 'FAILED' });
    }
    expect(transport.calls).toBe(3);
    expect(await processDueClaimNotifications(transport)).toBe(0);
    expect((await detail(failingId)).status).toBe('SUBMITTED');
  });

  it('retries a failed email on request, recording the request and the outcome', async () => {
    transport.failFor.clear();
    const notification = (await detail(failingId)).notifications[0]!;
    await request(app)
      .post(c(`/${failingId}/notifications/${notification.id}/retry`))
      .set(bearer(approver))
      .expect(403);
    const retried = await request(app)
      .post(c(`/${failingId}/notifications/${notification.id}/retry`))
      .set(bearer(manager))
      .expect(200);
    expect(retried.body).toMatchObject({ status: 'ACCEPTED', attempts: 4, error: null });
    await request(app)
      .post(c(`/${failingId}/notifications/${notification.id}/retry`))
      .set(bearer(manager))
      .expect(409);
    const timeline = (await detail(failingId)).timeline.filter((event) =>
      event.type.startsWith('EMAIL'),
    );
    expect(
      timeline.map((event) => [
        event.type,
        event.email?.attempt ?? null,
        event.email?.result ?? null,
      ]),
    ).toEqual([
      ['EMAIL_FAILED', 1, 'FAILED'],
      ['EMAIL_FAILED', 2, 'FAILED'],
      ['EMAIL_FAILED', 3, 'FAILED'],
      ['EMAIL_RETRY_REQUESTED', null, null],
      ['EMAIL_SENT', 4, 'ACCEPTED'],
    ]);
  });

  it('never sends the same email twice, even when two senders race', async () => {
    const notification = await ClaimNotificationModel.findOne({
      claimId: new Types.ObjectId(claimId),
    }).lean();
    await ClaimNotificationModel.updateOne(
      { _id: notification!._id },
      { $set: { status: 'PENDING', nextAttemptAt: new Date() } },
    );
    transport.reset();
    const results = await Promise.all([
      sendClaimNotification(notification!._id, transport),
      sendClaimNotification(notification!._id, transport),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(transport.calls).toBe(1);
  });

  it('records the email as failed, without sending, when mail is turned off', async () => {
    const offApp = createTestApp({}, undefined, offTransport());
    const created = await request(offApp)
      .post(c())
      .set(bearer(manager))
      .send(createBody({ patientMemberId: member.kabir, contactEmail: 'kabir@acme.example' }))
      .expect(201);
    for (const kind of ['MEDICAL_BILL', 'DISCHARGE_SUMMARY', 'ID_PROOF']) {
      await request(offApp)
        .post(c(`/${created.body.id as string}/documents?kind=${kind}&fileName=f.pdf`))
        .set(bearer(manager))
        .set('Content-Type', 'application/pdf')
        .send(PDF)
        .expect(201);
    }
    const moved = await request(offApp)
      .post(c(`/${created.body.id as string}/transitions`))
      .set(bearer(manager))
      .send({ toStatus: 'SUBMITTED', expectedStatus: 'FORM', remark: 'Mail is off' })
      .expect(200);
    expect(moved.body.claim.status).toBe('SUBMITTED');
    expect(moved.body.notifications[0]).toMatchObject({
      status: 'FAILED',
      error: 'Sending mail is turned off on this server',
    });
  });
});

describe('employee submission link (C2)', () => {
  let token: string;
  let linkClaim: string;
  const pub = (path = '', withToken = true) => {
    const req = request(app);
    return {
      get: () =>
        withToken
          ? req.get(`/api/v1/claim-links/current${path}`).set('X-Claim-Link-Token', token)
          : req.get(`/api/v1/claim-links/current${path}`),
      post: () => req.post(`/api/v1/claim-links/current${path}`).set('X-Claim-Link-Token', token),
    };
  };

  it('is issued for one employee, shown once and kept only as a hash', async () => {
    await request(app)
      .post(c('/links'))
      .set(bearer(approver))
      .send({ ghiCaseId: caseId, employeeMemberId: member.ravi })
      .expect(403);
    await request(app)
      .post(c('/links'))
      .set(bearer(exec))
      .send({ ghiCaseId: caseId, employeeMemberId: member.anita })
      .expect(400);
    const created = await request(app)
      .post(c('/links'))
      .set(bearer(exec))
      .send({ ghiCaseId: caseId, employeeMemberId: member.ravi, expiresInDays: 7, maxClaims: 1 })
      .expect(201);
    token = created.body.token as string;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.body.link).toMatchObject({
      status: 'ACTIVE',
      maxClaims: 1,
      usedClaims: 0,
      employee: { employeeId: 'E001' },
    });
    expect(await ClaimLinkModel.countDocuments({ tokenHash: token })).toBe(0);
    const audit = JSON.stringify(
      (await request(app).get('/api/v1/audit?entity=claim&limit=100').set(bearer(admin))).body,
    );
    expect(audit).not.toContain(token);
  });

  it('shows the employee their policy and only their own covered family', async () => {
    await pub('', false).get().expect(403);
    const view = PublicClaimLinkSchema.parse((await pub().get().expect(200)).body);
    expect(view).toMatchObject({
      clientName: 'Acme Health Group Pvt Ltd',
      policyNumber: 'GMC/2026/0042',
      employee: { name: 'Ravi Kumar' },
      remainingClaims: 1,
    });
    expect(view.members.map((item) => item.name)).toEqual([
      'Ravi Kumar',
      'Anita Kumar',
      'Kabir Kumar',
    ]);
  });

  it('accepts a claim for the family into Form, never for someone else, and no statuses', async () => {
    const body = {
      patientMemberId: member.kabir,
      ...details,
      contactEmail: 'ravi.home@example.com',
    };
    const other = await pub('/claims')
      .post()
      .send({ ...body, patientMemberId: member.suresh })
      .expect(400);
    expect(other.body.details[0].path).toBe('patientMemberId');
    await pub('/claims')
      .post()
      .send({ ...body, status: 'APPROVED' })
      .expect(400);
    const submitted = await pub('/claims').post().send(body).expect(201);
    expect(submitted.body).toMatchObject({
      missingDocuments: ['MEDICAL_BILL', 'DISCHARGE_SUMMARY', 'ID_PROOF'],
    });
    const list = ClaimListResponseSchema.parse(
      (
        await request(app)
          .get(c(`?q=${submitted.body.claimNumber as string}`))
          .set(bearer(manager))
      ).body,
    );
    linkClaim = list.items[0]!.id;
    const record = await detail(linkClaim);
    expect(record).toMatchObject({
      status: 'FORM',
      source: 'EMPLOYEE_LINK',
      patient: { name: 'Kabir Kumar', relationship: 'CHILD' },
      createdBy: 'Employee (submission link)',
    });
    expect(record.timeline[0]).toMatchObject({ type: 'CREATED', actor: { kind: 'EMPLOYEE' } });
    const used = await pub('/claims').post().send(body).expect(403);
    expect(used.body).toMatchObject({
      code: 'CLAIM_LINK_INVALID',
      message: expect.stringMatching(/used for all the claims/),
    });
  });

  it('takes the employee’s documents while the claim is in Form only', async () => {
    const view = PublicClaimLinkSchema.parse((await pub().get().expect(200)).body);
    const number = view.claims[0]!.claimNumber;
    await pub(`/claims/${number}/documents?kind=MEDICAL_BILL&fileName=bill.pdf`)
      .post()
      .set('Content-Type', 'application/pdf')
      .send(PDF)
      .expect(201);
    await pub(`/claims/CLM-2026-9999/documents?kind=MEDICAL_BILL&fileName=bill.pdf`)
      .post()
      .set('Content-Type', 'application/pdf')
      .send(PDF)
      .expect(404);
    const docs = (await detail(linkClaim)).documents;
    expect(docs[0]).toMatchObject({
      kind: 'MEDICAL_BILL',
      uploadedBy: 'Employee (submission link)',
    });
    // The link's issuer (the executive) is assigned and moves it on.
    await upload(linkClaim, 'DISCHARGE_SUMMARY', PDF, 'd.pdf', exec).expect(201);
    await upload(linkClaim, 'ID_PROOF', PNG, 'id.png', exec).expect(201);
    await move(linkClaim, 'FORM', 'SUBMITTED', 'Received from the employee', exec).expect(200);
    const late = await pub(`/claims/${number}/documents?kind=OTHER&fileName=late.pdf`)
      .post()
      .set('Content-Type', 'application/pdf')
      .send(PDF)
      .expect(409);
    expect(late.body.message).toMatch(/being processed/);
  });

  it('stops working once revoked or expired, and never opens staff routes', async () => {
    await request(app).get(c()).set('X-Claim-Link-Token', token).expect(401);
    const links = (
      await request(app)
        .get(c(`/links?ghiCaseId=${caseId}`))
        .set(bearer(exec))
        .expect(200)
    ).body.items;
    await request(app)
      .post(c(`/links/${links[0].id as string}/revoke`))
      .set(bearer(exec))
      .expect(200);
    expect((await pub().get().expect(403)).body.message).toMatch(/withdrawn/);
    const second = await request(app)
      .post(c('/links'))
      .set(bearer(exec))
      .send({ ghiCaseId: caseId, employeeMemberId: member.meena })
      .expect(201);
    token = second.body.token as string;
    await pub().get().expect(200);
    await ClaimLinkModel.updateOne(
      { _id: new Types.ObjectId(second.body.link.id as string) },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    expect((await pub().get().expect(403)).body.message).toMatch(/expired/);
  });
});

describe('table, assignment and the rest of the app', () => {
  it('searches and filters by company, status and date, with pages', async () => {
    const list = async (query: string) =>
      ClaimListResponseSchema.parse(
        (
          await request(app)
            .get(c(`?${query}`))
            .set(bearer(approver))
            .expect(200)
        ).body,
      );
    expect((await list('')).total).toBe(5);
    expect((await list('q=kabir')).items.every((item) => item.patientName === 'Kabir Kumar')).toBe(
      true,
    );
    expect((await list('status=APPROVED')).items.map((item) => item.id)).toEqual([claimId]);
    expect((await list(`clientId=${otherClientId}`)).total).toBe(0);
    expect((await list('dateField=ADMISSION&from=2026-06-01&to=2026-06-30')).total).toBe(5);
    expect((await list('dateField=ADMISSION&from=2026-07-01')).total).toBe(0);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    expect((await list(`from=${today}&to=${today}`)).total).toBe(5);
    const page = await list('page=2&limit=2');
    expect(page).toMatchObject({ total: 5, page: 2, limit: 2 });
    expect(page.items).toHaveLength(2);
    await request(app).get(c('?status=SETTLED')).set(bearer(approver)).expect(400);
  });

  it('lets only an Admin reassign, to claims staff, and the new assignee can then move it', async () => {
    const second = (await request(app).get(c('?q=Kabir&status=FORM')).set(bearer(manager))).body
      .items[0];
    await request(app)
      .put(c(`/${second.id as string}/assignee`))
      .set(bearer(manager))
      .send({ assignedTo: null })
      .expect(403);
    const users = await request(app).get('/api/v1/users').set(bearer(admin)).expect(200);
    const viewer = (users.body.items as { id: string; roles: string[] }[]).find((user) =>
      user.roles.includes('MANAGER'),
    )!;
    await request(app)
      .put(c(`/${second.id as string}/assignee`))
      .set(bearer(admin))
      .send({ assignedTo: viewer.id })
      .expect(400);
    const execUser = (users.body.items as { id: string; roles: string[] }[]).find((user) =>
      user.roles.includes('PLACEMENT_EXEC'),
    )!;
    const assigned = await request(app)
      .put(c(`/${second.id as string}/assignee`))
      .set(bearer(admin))
      .send({ assignedTo: execUser.id })
      .expect(200);
    expect(assigned.body.timeline.at(-1)).toMatchObject({
      type: 'ASSIGNED',
      description: 'Assigned to Test User',
    });
    await request(app)
      .post(c(`/${second.id as string}/remarks`))
      .set(bearer(exec))
      .send({ remark: 'Called the hospital' })
      .expect(201);
    await request(app)
      .post(c(`/${second.id as string}/remarks`))
      .set(bearer(manager))
      .send({ remark: 'Not mine any more' })
      .expect(403);
  });

  it('records edits as old and new values without rewriting history', async () => {
    const created = await request(app)
      .post(c())
      .set(bearer(manager))
      .send(createBody({ patientMemberId: member.ravi }))
      .expect(201);
    const id = created.body.id as string;
    const edited = await request(app)
      .put(c(`/${id}`))
      .set(bearer(manager))
      .send({
        ...details,
        amountClaimed: '50000',
        hospital: { name: 'Lakeview Hospital', city: 'Pune' },
      })
      .expect(200);
    expect(edited.body.amountClaimed).toBe('50000.00');
    expect(edited.body.timeline.at(-1)).toMatchObject({
      type: 'UPDATED',
      changes: [{ field: 'Amount claimed', before: '48500.50', after: '50000.00' }],
    });
    expect(edited.body.timeline[0].type).toBe('CREATED');
  });

  it('audits claims against the claim, without names in the snapshots', async () => {
    const log = (
      await request(app)
        .get(`/api/v1/audit?entity=claim&entityId=${claimId}&limit=100`)
        .set(bearer(admin))
        .expect(200)
    ).body.items;
    const actions = new Set(log.map((entry: { action: string }) => entry.action));
    for (const action of [
      'CLAIM_CREATED',
      'CLAIM_DOCUMENT_UPLOADED',
      'CLAIM_STATUS_CHANGED',
      'CLAIM_EMAIL_SENT',
      'CLAIM_DOCUMENT_DOWNLOADED',
    ]) {
      expect(actions).toContain(action);
    }
    const created = log.find((entry: { action: string }) => entry.action === 'CLAIM_CREATED');
    expect(JSON.stringify(created)).not.toContain('Anita');
  });

  it('leaves GHI cases and Property proposals as they were', async () => {
    const ghi = await request(app)
      .get(`/api/v1/ghi/cases/${caseId}`)
      .set(bearer(manager))
      .expect(200);
    expect(ghi.body).toMatchObject({ placed: true, policy: { policyNumber: 'GMC/2026/0042' } });
    expect(await ProposalModel.countDocuments({})).toBe(0);
    await request(app).get('/api/v1/proposals').set(bearer(manager)).expect(200);
    await request(app)
      .get(c(`/${randomUUID().replace(/-/g, '').slice(0, 24)}`))
      .set(bearer(manager))
      .expect(404);
  });
});
