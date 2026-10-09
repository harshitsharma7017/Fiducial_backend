import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestApp, tokenFor, useTestDatabase } from './helpers/app.ts';
import { seedMasters } from './helpers/masters.ts';

// The Deleted bin: an Admin moves a case there, where it is kept but left out of every list and
// refused by every action, and can restore it as it was.

useTestDatabase();

const app = createTestApp();

let admin: string;
let manager: string;
let clientId: string;
let locationId: string;

const newCase = async () =>
  (
    await request(app)
      .post('/api/v1/proposals')
      .set(bearer(manager))
      .send({
        type: 'NEW',
        clientId,
        locationIds: [locationId],
        dueDate: '2026-11-20',
        policyStart: null,
        policyEnd: null,
      })
      .expect(201)
  ).body as { id: string; reference: string };

const listed = async (token: string, query = '') =>
  (
    (await request(app).get(`/api/v1/proposals${query}`).set(bearer(token)).expect(200)).body
      .items as { id: string; deleted: { by: string } | null }[]
  ).map((item) => item.id);

beforeAll(async () => {
  await seedMasters();
  admin = (await tokenFor(app, ['ADMIN'])).token;
  manager = (await tokenFor(app, ['ACCOUNT_MANAGER'])).token;
  const client = await request(app)
    .post('/api/v1/clients')
    .set(bearer(admin))
    .send({
      name: 'Bin Test Mills',
      gstin: null,
      address: {
        line1: '1 Mill Road',
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
  clientId = client.body.id as string;
  const location = await request(app)
    .post(`/api/v1/clients/${clientId}/locations`)
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
  locationId = location.body.id as string;
});

describe('the Deleted bin', () => {
  it('lets only Admins delete, restore and see the bin', async () => {
    const proposal = await newCase();
    await request(app).delete(`/api/v1/proposals/${proposal.id}`).set(bearer(manager)).expect(403);
    await request(app)
      .post(`/api/v1/proposals/${proposal.id}/restore`)
      .set(bearer(manager))
      .expect(403);
    await request(app).get('/api/v1/proposals?deleted=true').set(bearer(manager)).expect(403);
    expect(await listed(manager)).toContain(proposal.id);
  });

  it('hides a deleted case everywhere, keeps it in the bin, and restores it as it was', async () => {
    const proposal = await newCase();
    const deleted = await request(app)
      .delete(`/api/v1/proposals/${proposal.id}`)
      .set(bearer(admin))
      .expect(200);
    expect(deleted.body.deleted).toMatchObject({ by: expect.any(String) });

    // Gone from the list and from every case route, whichever module serves it.
    expect(await listed(admin)).not.toContain(proposal.id);
    for (const path of ['', '/quotes', '/qcr', '/mails']) {
      await request(app)
        .get(`/api/v1/proposals/${proposal.id}${path}`)
        .set(bearer(admin))
        .expect(404);
    }
    await request(app).delete(`/api/v1/proposals/${proposal.id}`).set(bearer(admin)).expect(404);

    // In the bin, with who deleted it.
    const bin = await request(app)
      .get('/api/v1/proposals?deleted=true')
      .set(bearer(admin))
      .expect(200);
    expect(bin.body.items).toEqual([
      expect.objectContaining({
        id: proposal.id,
        deleted: expect.objectContaining({ by: expect.any(String) }),
      }),
    ]);

    const restored = await request(app)
      .post(`/api/v1/proposals/${proposal.id}/restore`)
      .set(bearer(admin))
      .expect(200);
    expect(restored.body).toMatchObject({
      id: proposal.id,
      reference: proposal.reference,
      deleted: null,
    });
    expect(await listed(admin)).toContain(proposal.id);
    expect(await listed(admin, '?deleted=true')).toEqual([]);
    await request(app).get(`/api/v1/proposals/${proposal.id}`).set(bearer(admin)).expect(200);
    await request(app)
      .post(`/api/v1/proposals/${proposal.id}/restore`)
      .set(bearer(admin))
      .expect(404);

    // Both moves are in the case's activity and the audit log.
    expect(restored.body.activity.map((entry: { message: string }) => entry.message)).toEqual(
      expect.arrayContaining(['Moved to the Deleted bin', 'Restored from the Deleted bin']),
    );
    const audit = await request(app)
      .get(`/api/v1/audit?entity=proposal&entityId=${proposal.id}`)
      .set(bearer(admin))
      .expect(200);
    expect(audit.body.items.map((entry: { action: string }) => entry.action)).toEqual(
      expect.arrayContaining(['PROPOSAL_DELETED', 'PROPOSAL_RESTORED']),
    );
  });
});
