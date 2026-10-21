import { OTHER_SECTIONS, RISK_DETAIL_FIELDS } from '../src/shared/index.ts';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLogModel } from '../src/modules/audit/audit.model.ts';
import { UserModel } from '../src/modules/users/user.model.ts';
import { bearer, createTestApp, tokenFor, useTestDatabase } from './helpers/app.ts';
import { seedMasters } from './helpers/masters.ts';

const binary = (req: request.Test) =>
  req.buffer(true).parse((res, done) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('end', () => done(null, Buffer.concat(chunks)));
  });

async function rfqAttributionText(caseId: string, token: string): Promise<string> {
  const file = await binary(
    request(app)
      .get(`/api/v1/proposals/${caseId}/rfq/versions/1/file?format=xlsx`)
      .set(bearer(token)),
  ).expect(200);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(file.body as ArrayBuffer);
  const text: string[] = [];
  workbook
    .getWorksheet('premium details')!
    .eachRow((row) => row.eachCell((cell) => text.push(cell.text)));
  return text.join('\n');
}

// A1 / CHECK 1: the role shown on a timeline is the one held when the action occurred. A role
// snapshot is written on the event; a later role change must not rewrite history.

useTestDatabase();
const app = createTestApp();

let admin: string;
let manager: string;
let approver: { id: string; token: string };
let caseId: string;

beforeAll(async () => {
  await seedMasters();
  admin = (await tokenFor(app, ['ADMIN'])).token;
  manager = (await tokenFor(app, ['ACCOUNT_MANAGER'])).token;
  const a = await tokenFor(app, ['MANAGER']);
  approver = { id: a.user.id, token: a.token };

  const client = await request(app)
    .post('/api/v1/clients')
    .set(bearer(admin))
    .send({
      name: 'Snapshot Mills',
      gstin: '27AAPFU0939F1ZV',
      address: {
        line1: '1 Rd',
        line2: '',
        city: 'Mumbai',
        state: 'Maharashtra',
        pincode: '400001',
      },
      contacts: [],
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
        included: false,
        proposed1: null,
        proposed2: null,
      })),
      claims: [],
      notes: null,
    })
    .expect(200);
  await request(app)
    .post(`/api/v1/proposals/${caseId}/rfq/versions`)
    .set(bearer(manager))
    .expect(201);
  await request(app)
    .post(`/api/v1/proposals/${caseId}/rfq/versions/1/submit`)
    .set(bearer(manager))
    .send({ comment: 'Ready' })
    .expect(200);
  // The approver (role MANAGER → "Approver") approves v1.
  await request(app)
    .post(`/api/v1/proposals/${caseId}/rfq/versions/1/approve`)
    .set(bearer(approver.token))
    .send({ comment: 'OK' })
    .expect(200);
});

const record = async () =>
  (await request(app).get(`/api/v1/proposals/${caseId}`).set(bearer(manager)).expect(200)).body as {
    activity: { message: string; actor: string; actorRole: string | null }[];
  };

describe('A1: actor role snapshot', () => {
  it('records the role snapshot on the audit entry and the timeline', async () => {
    const audit = await AuditLogModel.findOne({ action: 'RFQ_APPROVED', entityId: caseId }).lean();
    expect(audit?.actorRoles).toEqual(['MANAGER']);
    const entry = (await record()).activity.find((e) => e.message === 'RFQ v1 approved: OK');
    expect(entry?.actorRole).toBe('Approver');
  });

  it('A2: the RFQ export shows the approver’s role as held at approval', async () => {
    const text = await rfqAttributionText(caseId, manager);
    // The built-in layout puts the label and the value in separate cells (joined by a newline).
    expect(text).toMatch(/Approved by:[\s\S]*Approver/);
  });

  it('keeps the historical role after the actor’s roles change later', async () => {
    // Promote the approver to Admin + Placement; their current roles now differ from the snapshot.
    await request(app)
      .patch(`/api/v1/users/${approver.id}`)
      .set(bearer(admin))
      .send({ roles: ['ADMIN', 'PLACEMENT_EXEC'] })
      .expect(200);

    // The timeline still shows the role held when the RFQ was approved, not the new roles.
    const entry = (await record()).activity.find((e) => e.message === 'RFQ v1 approved: OK');
    expect(entry?.actorRole).toBe('Approver');
    // The audit snapshot is likewise unchanged.
    const audit = await AuditLogModel.findOne({ action: 'RFQ_APPROVED', entityId: caseId }).lean();
    expect(audit?.actorRoles).toEqual(['MANAGER']);
    // A2: the RFQ export likewise still shows "Approver", not the approver's new roles.
    expect(await rfqAttributionText(caseId, manager)).toMatch(/Approved by:[\s\S]*Approver/);
  });

  it('falls back to current roles for a historical entry with no snapshot', async () => {
    // Simulate a pre-snapshot entry: remove actorRoles from one activity entry directly.
    await UserModel.updateOne({ _id: approver.id }, { $set: { roles: ['MANAGER'] } });
    // Insert a legacy-style activity entry (no actorRoles) by writing straight to the collection.
    const { ProposalModel } = await import('../src/modules/proposals/proposal.model.ts');
    const proposalDoc = (await ProposalModel.findById(caseId).lean())!;
    const approverDoc = (await UserModel.findById(approver.id).lean())!;
    await ProposalModel.collection.updateOne({ _id: proposalDoc._id }, {
      $push: {
        activity: {
          at: new Date(),
          actorId: approverDoc._id,
          message: 'Legacy event without a snapshot',
        },
      },
    } as Record<string, unknown>);
    const entry = (await record()).activity.find(
      (e) => e.message === 'Legacy event without a snapshot',
    );
    // No snapshot → falls back to the actor's current role (Approver), never "Unknown".
    expect(entry?.actorRole).toBe('Approver');
  });
});
