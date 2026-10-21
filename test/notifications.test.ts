import { OTHER_SECTIONS, RISK_DETAIL_FIELDS } from '../src/shared/index.ts';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { NotificationModel } from '../src/modules/notifications/notification.model.ts';
import { scanRenewalsDue } from '../src/modules/notifications/renewal-reminders.ts';
import { ProposalModel } from '../src/modules/proposals/proposal.model.ts';
import { bearer, createTestApp, tokenFor, useTestDatabase } from './helpers/app.ts';
import { seedMasters } from './helpers/masters.ts';

// A4: in-app notifications are generated from real business events, delivered to the right
// recipients, scoped per user, idempotent, and never created for a failed operation.

useTestDatabase();
const app = createTestApp();

let admin: string;
// The relationship manager owns and prepares the case; the approver approves it.
let manager: { id: string; token: string };
let approver: { id: string; token: string };
let other: { id: string; token: string };
// A placement exec records the quote, so the case owner (not the actor) is notified.
let placement: { id: string; token: string };
let caseId: string;
const insurers: string[] = [];
const A = () => insurers[0] ?? '';

const notificationsOf = async (token: string, query = '') =>
  (await request(app).get(`/api/v1/notifications${query}`).set(bearer(token)).expect(200)).body as {
    items: { id: string; event: string; proposalId: string | null; read: boolean }[];
    unreadCount: number;
    nextCursor: string | null;
  };

beforeAll(async () => {
  await seedMasters();
  admin = (await tokenFor(app, ['ADMIN'])).token;
  const m = await tokenFor(app, ['ACCOUNT_MANAGER']);
  manager = { id: m.user.id, token: m.token };
  const a = await tokenFor(app, ['MANAGER']);
  approver = { id: a.user.id, token: a.token };
  const o = await tokenFor(app, ['ACCOUNT_MANAGER']);
  other = { id: o.user.id, token: o.token };
  const p = await tokenFor(app, ['PLACEMENT_EXEC']);
  placement = { id: p.user.id, token: p.token };

  const client = await request(app)
    .post('/api/v1/clients')
    .set(bearer(admin))
    .send({
      name: 'Notify Test Mills',
      gstin: '27AAPFU0939F1ZV',
      address: {
        line1: '1 Rd',
        line2: '',
        city: 'Mumbai',
        state: 'Maharashtra',
        pincode: '400001',
      },
      contacts: [{ name: 'Ravi', designation: null, email: 'ravi@mills.example', phone: null }],
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
  // The manager creates (and so owns) the case.
  const created = await request(app)
    .post('/api/v1/proposals')
    .set(bearer(manager.token))
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
    .set(bearer(manager.token))
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
    .put(`/api/v1/proposals/${caseId}/insurers`)
    .set(bearer(manager.token))
    .send({ insurerIds: insurers })
    .expect(200);
});

describe('A4: notifications from business events', () => {
  it('APPROVAL_NEEDED goes to the approver, not the submitter', async () => {
    // Generate v1 and submit it for approval (the manager acts).
    await request(app)
      .post(`/api/v1/proposals/${caseId}/rfq/versions`)
      .set(bearer(manager.token))
      .expect(201);
    await request(app)
      .post(`/api/v1/proposals/${caseId}/rfq/versions/1/submit`)
      .set(bearer(manager.token))
      .send({ comment: 'Ready' })
      .expect(200);

    const toApprover = await notificationsOf(approver.token);
    expect(
      toApprover.items.some((n) => n.event === 'APPROVAL_NEEDED' && n.proposalId === caseId),
    ).toBe(true);
    // The submitter (manager) is not notified of their own submission.
    const toManager = await notificationsOf(manager.token);
    expect(toManager.items.some((n) => n.event === 'APPROVAL_NEEDED')).toBe(false);
    // An unrelated account manager is not an approver and gets nothing.
    const toOther = await notificationsOf(other.token);
    expect(toOther.items).toHaveLength(0);
  });

  it('APPROVED (RFQ) goes to the case owner', async () => {
    await request(app)
      .post(`/api/v1/proposals/${caseId}/rfq/versions/1/approve`)
      .set(bearer(approver.token))
      .send({ comment: 'OK' })
      .expect(200);
    const toManager = await notificationsOf(manager.token);
    expect(toManager.items.some((n) => n.event === 'APPROVED' && n.proposalId === caseId)).toBe(
      true,
    );
  });

  it('a failed operation creates no notification; a retry does not duplicate', async () => {
    const before = (await notificationsOf(approver.token)).items.filter(
      (n) => n.event === 'APPROVAL_NEEDED',
    ).length;
    // Submitting v1 again fails (already approved) — no new APPROVAL_NEEDED.
    await request(app)
      .post(`/api/v1/proposals/${caseId}/rfq/versions/1/submit`)
      .set(bearer(manager.token))
      .expect(409);
    const after = (await notificationsOf(approver.token)).items.filter(
      (n) => n.event === 'APPROVAL_NEEDED',
    ).length;
    expect(after).toBe(before);
    // The idempotency key keeps one APPROVAL_NEEDED for v1 even if the event fired twice.
    expect(
      await NotificationModel.countDocuments({
        recipientId: approver.id,
        event: 'APPROVAL_NEEDED',
        dedupeKey: `${approver.id}:rfq-submitted:${caseId}:v1`,
      }),
    ).toBe(1);
  });

  it('QUOTE_RECEIVED reaches the case owner after a quote is recorded', async () => {
    await request(app)
      .post(`/api/v1/proposals/${caseId}/rfq/sent`)
      .set(bearer(manager.token))
      .send({ insurerIds: insurers })
      .expect(200);
    // A placement exec (not the owner) records the quote, so the owner is the notified recipient.
    const pdf = await request(app)
      .post(`/api/v1/proposals/${caseId}/insurers/${A()}/quote-attachments?fileName=q.pdf`)
      .set(bearer(placement.token))
      .set('Content-Type', 'application/pdf')
      .send(Buffer.from('%PDF-1.4\n%%EOF\n'))
      .expect(201);
    await request(app)
      .post(`/api/v1/proposals/${caseId}/insurers/${A()}/quotes`)
      .set(bearer(placement.token))
      .send({
        option: 'P1',
        sections: [
          { code: 'FIRE', sumInsured: null, premium: '100000', premiumWithoutTerrorism: '90000' },
        ],
        attachmentIds: [pdf.body.id],
      })
      .expect(201);
    const toManager = await notificationsOf(manager.token);
    expect(
      toManager.items.some((n) => n.event === 'QUOTE_RECEIVED' && n.proposalId === caseId),
    ).toBe(true);
  });

  it('scopes reads to the recipient and supports unread count and mark-as-read', async () => {
    const mine = await notificationsOf(manager.token);
    expect(mine.unreadCount).toBe(mine.items.filter((n) => !n.read).length);
    expect(mine.items.length).toBeGreaterThan(0);

    // A user cannot read or mark another user's notification.
    const approverItem = (await notificationsOf(approver.token)).items[0]!;
    await request(app)
      .post(`/api/v1/notifications/${approverItem.id}/read`)
      .set(bearer(manager.token))
      .expect(404);

    // Mark one read (idempotent).
    const first = mine.items.find((n) => !n.read)!;
    const marked = await request(app)
      .post(`/api/v1/notifications/${first.id}/read`)
      .set(bearer(manager.token))
      .expect(200);
    expect(marked.body.unreadCount).toBe(mine.unreadCount - 1);
    await request(app)
      .post(`/api/v1/notifications/${first.id}/read`)
      .set(bearer(manager.token))
      .expect(200);
    expect((await notificationsOf(manager.token)).unreadCount).toBe(mine.unreadCount - 1);

    // Mark all read.
    await request(app)
      .post('/api/v1/notifications/read-all')
      .set(bearer(manager.token))
      .expect(200);
    const after = await notificationsOf(manager.token);
    expect(after.unreadCount).toBe(0);
    expect(after.items.every((n) => n.read)).toBe(true);

    // Unread-count endpoint is scoped to the caller.
    const count = await request(app)
      .get('/api/v1/notifications/unread-count')
      .set(bearer(manager.token))
      .expect(200);
    expect(count.body.unreadCount).toBe(0);
  });

  it('every notification endpoint needs a session', async () => {
    await request(app).get('/api/v1/notifications').expect(401);
    await request(app).get('/api/v1/notifications/unread-count').expect(401);
    await request(app).post('/api/v1/notifications/read-all').expect(401);
    await request(app)
      .post(`/api/v1/notifications/${'0'.repeat(24)}/read`)
      .expect(401);
  });

  it('RENEWAL_DUE uses the real policy end date and fires once per expiry', async () => {
    // Place the case and set its end date inside the reminder window.
    const soon = new Date();
    soon.setUTCDate(soon.getUTCDate() + 10);
    const policyEnd = soon.toISOString().slice(0, 10);
    await ProposalModel.updateOne({ _id: caseId }, { $set: { stage: 'PLACED', policyEnd } });

    const created = await scanRenewalsDue(30);
    expect(created).toBeGreaterThanOrEqual(1);
    // The owner (manager) gets it, linked to the case.
    const toManager = await notificationsOf(manager.token);
    expect(toManager.items.some((n) => n.event === 'RENEWAL_DUE' && n.proposalId === caseId)).toBe(
      true,
    );
    // Running the scan again does not duplicate (same expiry milestone).
    const before = await NotificationModel.countDocuments({ event: 'RENEWAL_DUE' });
    await scanRenewalsDue(30);
    expect(await NotificationModel.countDocuments({ event: 'RENEWAL_DUE' })).toBe(before);
  });
});
