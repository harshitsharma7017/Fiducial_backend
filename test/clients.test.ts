import { gstinCheckCharacter } from '../src/shared/index.ts';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLogModel } from '../src/modules/audit/audit.model.ts';
import { bearer, createTestApp, tokenFor, useTestDatabase } from './helpers/app.ts';
import { seedMasters } from './helpers/masters.ts';

useTestDatabase();
const app = createTestApp();

let managerToken: string;
let managerId: string;
let adminToken: string;

beforeAll(async () => {
  await seedMasters();
  const manager = await tokenFor(app, ['ACCOUNT_MANAGER']);
  managerToken = manager.token;
  managerId = manager.user.id;
  adminToken = (await tokenFor(app, ['ADMIN'])).token;
});

/** A valid GSTIN for Maharashtra whose PAN digits are `serial`, so each test gets its own. */
let gstinSerial = 1000;
function nextGstin(): string {
  gstinSerial += 1;
  const first14 = `27AABCF${gstinSerial}K1Z`;
  return `${first14}${gstinCheckCharacter(first14)}`;
}

const newClient = (overrides: Record<string, unknown> = {}) => ({
  name: 'Fictional Fabrics Pvt Ltd',
  gstin: nextGstin(),
  address: {
    line1: '12 Mill Compound',
    line2: '',
    city: 'Mumbai',
    state: 'Maharashtra',
    pincode: '400001',
  },
  contacts: [{ name: 'Meera Pillai', designation: 'CFO', email: 'meera@example.com', phone: '' }],
  natureOfBusiness: 'Textile weaving',
  occupancyCode: '2001',
  ...overrides,
});

const newLocation = (overrides: Record<string, unknown> = {}) => ({
  name: 'Plant 1',
  line1: 'Plot 4, MIDC',
  line2: null,
  city: 'Mumbai',
  pincode: '400001',
  occupancyCode: null,
  ...overrides,
});

async function createClient(body = newClient(), token = managerToken) {
  const response = await request(app).post('/api/v1/clients').set(bearer(token)).send(body);
  expect(response.status).toBe(201);
  return response.body as { id: string; gstin: string | null; name: string };
}

describe('client master (M-1)', () => {
  it('creates a client and audits every field', async () => {
    const body = newClient();
    const client = await createClient(body);
    expect(client).toMatchObject({
      name: body.name,
      gstin: body.gstin,
      address: { ...body.address, line2: null },
      contacts: [
        { name: 'Meera Pillai', designation: 'CFO', email: 'meera@example.com', phone: null },
      ],
      natureOfBusiness: 'Textile weaving',
      occupancy: { tacCode: '2001', description: 'Abrasive Manufacturing' },
      locationCount: 0,
    });

    const audit = await AuditLogModel.findOne({
      action: 'CLIENT_CREATED',
      entityId: client.id,
    }).lean();
    expect(audit?.userId?.toHexString()).toBe(managerId);
    expect(audit?.after).toMatchObject({ name: body.name, gstin: body.gstin });

    const fetched = await request(app)
      .get(`/api/v1/clients/${client.id}`)
      .set(bearer(managerToken))
      .expect(200);
    expect(fetched.body).toEqual(client);
  });

  it('normalises the GSTIN before checking and storing it', async () => {
    const gstin = nextGstin();
    const spaced = `${gstin.slice(0, 2)} ${gstin.slice(2, 12).toLowerCase()} ${gstin.slice(12)}`;
    const client = await createClient(newClient({ gstin: spaced }));
    expect(client.gstin).toBe(gstin);
  });

  it.each([
    ['too short', '27AABCF1234K1Z', 'A GSTIN has 15 characters'],
    ['in the wrong format', '27AABCF12345KZZ', 'Enter the GSTIN as printed'],
    ['for an unknown state', '55AAPFU0939F1ZV', 'not a GST state code'],
    ['with a wrong check digit', '27AAPFU0939F1ZW', 'check digit'],
  ])('rejects a GSTIN %s', async (_label, gstin, message) => {
    const response = await request(app)
      .post('/api/v1/clients')
      .set(bearer(managerToken))
      .send(newClient({ gstin }))
      .expect(400);
    expect(response.body.details).toEqual([
      expect.objectContaining({ path: 'gstin', message: expect.stringContaining(message) }),
    ]);
  });

  it('blocks a second client with the same GSTIN, on create and on edit', async () => {
    const first = await createClient(newClient({ name: 'Original Holder Ltd' }));
    const duplicate = await request(app)
      .post('/api/v1/clients')
      .set(bearer(managerToken))
      .send(newClient({ gstin: first.gstin!.toLowerCase() }))
      .expect(409);
    expect(duplicate.body).toMatchObject({
      code: 'GSTIN_TAKEN',
      message: `GSTIN ${first.gstin} already belongs to Original Holder Ltd`,
      details: { clientId: first.id },
    });

    const second = await createClient();
    const edit = await request(app)
      .patch(`/api/v1/clients/${second.id}`)
      .set(bearer(managerToken))
      .send({ gstin: first.gstin })
      .expect(409);
    expect(edit.body.code).toBe('GSTIN_TAKEN');

    // Saving a client with its own GSTIN is not a duplicate.
    await request(app)
      .patch(`/api/v1/clients/${first.id}`)
      .set(bearer(managerToken))
      .send({ gstin: first.gstin, name: 'Original Holder Limited' })
      .expect(200);
  });

  it('allows any number of clients without a GSTIN', async () => {
    const a = await createClient(newClient({ gstin: '' }));
    const b = await createClient(newClient({ gstin: null }));
    expect([a.gstin, b.gstin]).toEqual([null, null]);
  });

  it('needs an occupancy code from the active master', async () => {
    for (const occupancyCode of ['9999', 'DRAFT_ONLY']) {
      const response = await request(app)
        .post('/api/v1/clients')
        .set(bearer(managerToken))
        .send(newClient({ occupancyCode }))
        .expect(400);
      expect(response.body.details).toEqual([expect.objectContaining({ path: 'occupancyCode' })]);
    }
  });

  it('validates the address and contacts', async () => {
    const response = await request(app)
      .post('/api/v1/clients')
      .set(bearer(managerToken))
      .send(
        newClient({
          address: { line1: '', line2: '', city: 'Pune', state: 'Bombay', pincode: '41100' },
          contacts: [{ name: 'No Way To Reach', designation: '', email: '', phone: '' }],
          natureOfBusiness: ' ',
        }),
      )
      .expect(400);
    const paths = (response.body.details as Array<{ path: string }>).map((issue) => issue.path);
    expect(paths.sort()).toEqual([
      'address.line1',
      'address.pincode',
      'address.state',
      'contacts.0.email',
      'natureOfBusiness',
    ]);
  });

  it('edits only the fields sent and records before and after', async () => {
    const client = await createClient();
    const response = await request(app)
      .patch(`/api/v1/clients/${client.id}`)
      .set(bearer(managerToken))
      .send({ natureOfBusiness: 'Textile weaving and dyeing', occupancyCode: '2002' })
      .expect(200);
    expect(response.body).toMatchObject({
      name: client.name,
      gstin: client.gstin,
      natureOfBusiness: 'Textile weaving and dyeing',
      occupancy: { tacCode: '2002', description: 'Aerated Water Factories' },
    });

    const audit = await AuditLogModel.findOne({
      action: 'CLIENT_UPDATED',
      entityId: client.id,
    }).lean();
    expect(audit?.before).toMatchObject({ natureOfBusiness: 'Textile weaving' });
    expect(audit?.after).toMatchObject({ natureOfBusiness: 'Textile weaving and dyeing' });
  });

  it('lists clients in name order, searches by name or GSTIN and pages with a cursor', async () => {
    const tag = `Zz${Date.now()}`;
    const names = [`${tag} Charlie`, `${tag} alpha`, `${tag} Bravo`];
    const created = [];
    for (const name of names) created.push(await createClient(newClient({ name })));

    const first = await request(app)
      .get(`/api/v1/clients?q=${tag}&limit=2`)
      .set(bearer(managerToken))
      .expect(200);
    expect(first.body.items.map((c: { name: string }) => c.name)).toEqual([
      `${tag} alpha`,
      `${tag} Bravo`,
    ]);
    const second = await request(app)
      .get(`/api/v1/clients?q=${tag}&limit=2&cursor=${first.body.nextCursor as string}`)
      .set(bearer(managerToken))
      .expect(200);
    expect(second.body.items.map((c: { name: string }) => c.name)).toEqual([`${tag} Charlie`]);
    expect(second.body.nextCursor).toBeNull();

    const byGstin = await request(app)
      .get(`/api/v1/clients?q=${created[0]!.gstin!.slice(0, 12).toLowerCase()}`)
      .set(bearer(managerToken))
      .expect(200);
    expect(byGstin.body.items.map((c: { id: string }) => c.id)).toEqual([created[0]!.id]);
  });

  it('treats search text literally', async () => {
    const response = await request(app)
      .get(`/api/v1/clients?q=${encodeURIComponent('.*')}`)
      .set(bearer(managerToken))
      .expect(200);
    expect(response.body.items).toEqual([]);
  });

  it('returns 404 for an unknown client', async () => {
    await request(app)
      .get('/api/v1/clients/0123456789abcdef01234567')
      .set(bearer(managerToken))
      .expect(404);
  });
});

describe('risk locations (M-2)', () => {
  it('creates and edits five locations for one client', async () => {
    const client = await createClient();
    const ids: string[] = [];
    for (let index = 1; index <= 5; index += 1) {
      const response = await request(app)
        .post(`/api/v1/clients/${client.id}/locations`)
        .set(bearer(managerToken))
        .send(newLocation({ name: `Plant ${index}`, pincode: index % 2 ? '400001' : '110001' }))
        .expect(201);
      ids.push(response.body.id as string);
    }

    const fetched = await request(app)
      .get(`/api/v1/clients/${client.id}`)
      .set(bearer(managerToken))
      .expect(200);
    expect(fetched.body.locationCount).toBe(5);

    for (const [index, id] of ids.entries()) {
      await request(app)
        .patch(`/api/v1/clients/${client.id}/locations/${id}`)
        .set(bearer(managerToken))
        .send({ name: `Plant ${index + 1} (renamed)` })
        .expect(200);
    }

    const list = await request(app)
      .get(`/api/v1/clients/${client.id}/locations`)
      .set(bearer(managerToken))
      .expect(200);
    expect(list.body.items.map((l: { name: string }) => l.name)).toEqual([
      'Plant 1 (renamed)',
      'Plant 2 (renamed)',
      'Plant 3 (renamed)',
      'Plant 4 (renamed)',
      'Plant 5 (renamed)',
    ]);
    expect(
      await AuditLogModel.countDocuments({
        action: 'CLIENT_LOCATION_UPDATED',
        entityId: { $in: ids },
      }),
    ).toBe(5);
  });

  it('fills the state, district and EQ zone from the pincode master', async () => {
    const client = await createClient();
    const created = await request(app)
      .post(`/api/v1/clients/${client.id}/locations`)
      .set(bearer(managerToken))
      .send(newLocation({ pincode: '110001' }))
      .expect(201);
    expect(created.body).toMatchObject({
      clientId: client.id,
      address: { pincode: '110001', state: 'Delhi', city: 'Mumbai', line2: null },
      district: 'Central Delhi',
      eqZone: 2,
      occupancy: null,
    });

    // A new pincode is looked up again; other fields stay as they were.
    const moved = await request(app)
      .patch(`/api/v1/clients/${client.id}/locations/${created.body.id as string}`)
      .set(bearer(managerToken))
      .send({ pincode: '768201', city: 'Sambalpur' })
      .expect(200);
    expect(moved.body).toMatchObject({
      name: 'Plant 1',
      address: { pincode: '768201', state: 'Orissa', city: 'Sambalpur', line1: 'Plot 4, MIDC' },
      district: 'Sambalpur',
      eqZone: 3,
    });
  });

  it('rejects a pincode or occupancy that is not in the active master', async () => {
    const client = await createClient();
    const badPincode = await request(app)
      .post(`/api/v1/clients/${client.id}/locations`)
      .set(bearer(managerToken))
      .send(newLocation({ pincode: '999999' }))
      .expect(400);
    expect(badPincode.body.details).toEqual([expect.objectContaining({ path: 'pincode' })]);

    const badOccupancy = await request(app)
      .post(`/api/v1/clients/${client.id}/locations`)
      .set(bearer(managerToken))
      .send(newLocation({ occupancyCode: 'DRAFT_ONLY' }))
      .expect(400);
    expect(badOccupancy.body.details).toEqual([expect.objectContaining({ path: 'occupancyCode' })]);
  });

  it("sets a location's own occupancy and returns it to the client's", async () => {
    const client = await createClient();
    const created = await request(app)
      .post(`/api/v1/clients/${client.id}/locations`)
      .set(bearer(managerToken))
      .send(newLocation({ occupancyCode: '1001' }))
      .expect(201);
    expect(created.body.occupancy).toEqual({ tacCode: '1001', description: 'Dwellings' });

    const reset = await request(app)
      .patch(`/api/v1/clients/${client.id}/locations/${created.body.id as string}`)
      .set(bearer(managerToken))
      .send({ occupancyCode: '' })
      .expect(200);
    expect(reset.body.occupancy).toBeNull();
  });

  it('does not reach a location through another client', async () => {
    const owner = await createClient();
    const other = await createClient();
    const location = await request(app)
      .post(`/api/v1/clients/${owner.id}/locations`)
      .set(bearer(managerToken))
      .send(newLocation())
      .expect(201);
    await request(app)
      .patch(`/api/v1/clients/${other.id}/locations/${location.body.id as string}`)
      .set(bearer(managerToken))
      .send({ name: 'Hijacked' })
      .expect(404);
    await request(app)
      .post('/api/v1/clients/0123456789abcdef01234567/locations')
      .set(bearer(managerToken))
      .send(newLocation())
      .expect(404);
  });

  it('labels client and location entries in the audit log', async () => {
    const client = await createClient(newClient({ name: 'Audit Label Traders' }));
    const location = await request(app)
      .post(`/api/v1/clients/${client.id}/locations`)
      .set(bearer(managerToken))
      .send(newLocation({ name: 'Godown' }))
      .expect(201);

    const entries = await request(app)
      .get(`/api/v1/audit?entity=client_location&entityId=${location.body.id as string}`)
      .set(bearer(adminToken))
      .expect(200);
    expect(entries.body.items[0]).toMatchObject({
      action: 'CLIENT_LOCATION_CREATED',
      kind: 'CREATE',
      entityLabel: 'Audit Label Traders · Godown',
    });
    const clientEntries = await request(app)
      .get(`/api/v1/audit?entity=client&entityId=${client.id}`)
      .set(bearer(adminToken))
      .expect(200);
    expect(clientEntries.body.items[0].entityLabel).toBe('Audit Label Traders');
  });
});

describe('who may change clients', () => {
  it('lets every role read and only clients.manage change', async () => {
    const client = await createClient();
    for (const role of ['MANAGER', 'PLACEMENT_EXEC', 'READ_ONLY'] as const) {
      const { token } = await tokenFor(app, [role]);
      await request(app).get('/api/v1/clients').set(bearer(token)).expect(200);
      await request(app)
        .get(`/api/v1/clients/${client.id}/locations`)
        .set(bearer(token))
        .expect(200);
      await request(app).post('/api/v1/clients').set(bearer(token)).send(newClient()).expect(403);
      await request(app)
        .patch(`/api/v1/clients/${client.id}`)
        .set(bearer(token))
        .send({ name: 'Nope' })
        .expect(403);
      await request(app)
        .post(`/api/v1/clients/${client.id}/locations`)
        .set(bearer(token))
        .send(newLocation())
        .expect(403);
    }
    await createClient(newClient(), adminToken);
  });
});
