import { EbCaseListResponseSchema, type LegacyRole as Role } from '../src/shared/index.ts';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLogModel } from '../src/modules/audit/audit.model.ts';
import { GhiCaseModel } from '../src/modules/ghi/ghi-case.model.ts';
import { CounterModel, ProposalModel } from '../src/modules/proposals/proposal.model.ts';
import { bearer, createTestApp, useTestDatabase } from './helpers/app.ts';
import {
  ROLE_LIST,
  createEbCase,
  ebPath,
  gpaSheet,
  gtliSheet,
  setUpWorld,
  type EbWorld,
} from './helpers/eb.ts';

// Employee Benefits cases (Requirements 1 to 3): a product on every case, each product's own
// reference series, the cross-product list, edits, closing, the Data Sheets, and permissions.

useTestDatabase();
const app = createTestApp();
let world: EbWorld;

const can: Record<string, Role[]> = {
  view: ['ADMIN', 'MANAGER', 'ACCOUNT_MANAGER', 'PLACEMENT_EXEC', 'READ_ONLY'],
  create: ['ADMIN', 'ACCOUNT_MANAGER'],
  edit: ['ADMIN', 'ACCOUNT_MANAGER', 'PLACEMENT_EXEC'],
};

beforeAll(async () => {
  world = await setUpWorld(app);
});

describe('creating a case (Requirement 1)', () => {
  it('creates GMC, GPA and GTLI cases with their own references and sequences', async () => {
    const gmc = await createEbCase(app, world.manager, 'GMC', world.clientId);
    const gpa = await createEbCase(app, world.manager, 'GPA', world.clientId);
    const gpa2 = await createEbCase(app, world.manager, 'GPA', world.clientId);
    const gtli = await createEbCase(app, world.manager, 'GTLI', world.clientId);
    expect(gmc).toMatchObject({
      product: 'GMC',
      reference: expect.stringMatching(/^GHI-\d{4}-0001$/),
    });
    expect(gpa.reference).toMatch(/^GPA-\d{4}-0001$/);
    expect(gpa2.reference).toMatch(/^GPA-\d{4}-0002$/);
    expect(gtli.reference).toMatch(/^GTLI-\d{4}-0001$/);
    // A GMC case made here is a GHI case: /ghi opens it, /eb/gpa does not.
    const record = (
      await request(app).get(`/api/v1/ghi/cases/${gmc.id}`).set(bearer(world.readOnly)).expect(200)
    ).body;
    expect(record).toMatchObject({ product: 'GMC', plan: null });
    await request(app).get(ebPath('GPA', gmc.id)).set(bearer(world.readOnly)).expect(404);
    const audit = await AuditLogModel.findOne({
      action: 'EB_CASE_CREATED',
      entityId: gpa.id,
    }).lean();
    expect(audit?.before).toBeNull();
    expect(audit?.after).toMatchObject({ product: 'GPA', reference: gpa.reference, type: 'NEW' });
  });

  it('refuses a missing or unknown product, a bad company or a renewal without its period, using no reference', async () => {
    const counters = await CounterModel.find({}).lean();
    const audits = await AuditLogModel.countDocuments({});
    const cases = await GhiCaseModel.countDocuments({});
    const body = { type: 'NEW', clientId: world.clientId, dueDate: '2026-11-30' };
    const noProduct = await request(app)
      .post('/api/v1/eb/cases')
      .set(bearer(world.manager))
      .send(body)
      .expect(400);
    expect(noProduct.body.details.map((item: { path: string }) => item.path)).toContain('product');
    await request(app)
      .post('/api/v1/eb/cases')
      .set(bearer(world.manager))
      .send({ ...body, product: 'HEALTH' })
      .expect(400);
    await request(app)
      .post('/api/v1/eb/cases')
      .set(bearer(world.manager))
      .send({ ...body, product: 'GPA', clientId: '0123456789abcdef01234567' })
      .expect(400);
    const renewal = await request(app)
      .post('/api/v1/eb/cases')
      .set(bearer(world.manager))
      .send({ ...body, product: 'GTLI', type: 'RENEWAL' })
      .expect(400);
    expect(renewal.body.details.map((item: { path: string }) => item.path).sort()).toEqual([
      'existingInsurer',
      'policyStart',
    ]);
    expect(await CounterModel.find({}).lean()).toEqual(counters);
    expect(await AuditLogModel.countDocuments({})).toBe(audits);
    expect(await GhiCaseModel.countDocuments({})).toBe(cases);
  });

  it('is open only to proposals.create', async () => {
    const body = { product: 'GPA', type: 'NEW', clientId: world.clientId, dueDate: '2026-11-30' };
    await request(app).post('/api/v1/eb/cases').send(body).expect(401);
    for (const role of ROLE_LIST) {
      await request(app)
        .post('/api/v1/eb/cases')
        .set(bearer(world.tokens[role]))
        .send(body)
        .expect(can.create!.includes(role) ? 201 : 403);
    }
  });
});

describe('listing cases (Requirement 2.3, 2.10)', () => {
  it('lists every product with filters, search and pages', async () => {
    const all = EbCaseListResponseSchema.parse(
      (await request(app).get('/api/v1/eb/cases?limit=100').set(bearer(world.readOnly)).expect(200))
        .body,
    );
    expect(new Set(all.items.map((item) => item.product))).toEqual(new Set(['GMC', 'GPA', 'GTLI']));
    const gpa = (
      await request(app).get('/api/v1/eb/cases?product=GPA').set(bearer(world.readOnly)).expect(200)
    ).body;
    expect(gpa.items.every((item: { product: string }) => item.product === 'GPA')).toBe(true);
    const search = (
      await request(app)
        .get('/api/v1/eb/cases?q=%20gtli-%20')
        .set(bearer(world.readOnly))
        .expect(200)
    ).body;
    expect(search.items.length).toBeGreaterThan(0);
    expect(
      search.items.every((item: { reference: string }) => item.reference.startsWith('GTLI-')),
    ).toBe(true);
    const blank = (
      await request(app).get('/api/v1/eb/cases?q=%20%20').set(bearer(world.readOnly)).expect(200)
    ).body;
    expect(blank.total).toBe(all.total);
    const page = (
      await request(app)
        .get('/api/v1/eb/cases?limit=2&page=2')
        .set(bearer(world.readOnly))
        .expect(200)
    ).body;
    expect(page).toMatchObject({ page: 2, limit: 2, total: all.total });
    const byCompany = (
      await request(app)
        .get(`/api/v1/eb/cases?clientId=${world.otherClientId}`)
        .set(bearer(world.readOnly))
        .expect(200)
    ).body;
    expect(byCompany.total).toBe(0);
    for (const query of [
      'product=X',
      'stage=FOO',
      'type=OLD',
      `q=${'x'.repeat(101)}`,
      'limit=0',
      'limit=101',
      'page=10001',
      'sort=1',
    ]) {
      await request(app).get(`/api/v1/eb/cases?${query}`).set(bearer(world.readOnly)).expect(400);
    }
    await request(app).get('/api/v1/eb/cases').expect(401);
  });

  it('keeps /ghi listing GMC cases only, with their product', async () => {
    const ghi = (
      await request(app).get('/api/v1/ghi/cases?limit=100').set(bearer(world.readOnly)).expect(200)
    ).body;
    expect(ghi.items.length).toBeGreaterThan(0);
    expect(ghi.items.every((item: { product: string }) => item.product === 'GMC')).toBe(true);
  });
});

describe('a GPA or GTLI case (Requirements 2, 3)', () => {
  let id: string;
  beforeAll(async () => {
    id = (await createEbCase(app, world.manager, 'GPA', world.clientId)).id;
  });

  it('answers 404 the same way for an unknown id and a case of another product', async () => {
    const gtli = await createEbCase(app, world.manager, 'GTLI', world.clientId);
    const wrong = await request(app)
      .get(ebPath('GPA', gtli.id))
      .set(bearer(world.readOnly))
      .expect(404);
    const unknown = await request(app)
      .get(ebPath('GPA', '0123456789abcdef01234567'))
      .set(bearer(world.readOnly))
      .expect(404);
    expect(wrong.body).toEqual(unknown.body);
    expect(JSON.stringify(wrong.body)).not.toContain('GTLI');
    await request(app)
      .put(ebPath('GPA', gtli.id, '/requirements'))
      .set(bearer(world.manager))
      .send(gpaSheet())
      .expect(404);
  });

  it('edits only dates, staff and the expiring policy; product, type or company are refused', async () => {
    const record = (
      await request(app).get(ebPath('GPA', id)).set(bearer(world.readOnly)).expect(200)
    ).body;
    const edit = {
      ownerId: record.owner.id,
      policyStart: '2027-01-01',
      policyEnd: '2027-12-31',
      dueDate: '2026-12-15',
      existingInsurer: null,
      existingPolicyNumber: null,
    };
    for (const extra of [
      { product: 'GTLI' },
      { type: 'RENEWAL' },
      { clientId: world.otherClientId },
    ]) {
      await request(app)
        .put(ebPath('GPA', id))
        .set(bearer(world.manager))
        .send({ ...edit, ...extra })
        .expect(400);
    }
    for (const role of ROLE_LIST) {
      await request(app)
        .put(ebPath('GPA', id))
        .set(bearer(world.tokens[role]))
        .send(edit)
        .expect(can.edit!.includes(role) ? 200 : 403);
    }
    const audit = await AuditLogModel.findOne({ action: 'EB_CASE_UPDATED', entityId: id }).lean();
    expect(audit?.after).toMatchObject({ policyStart: '2027-01-01', product: 'GPA' });
  });

  it('saves a GPA Data Sheet as a draft, reaching Data Sheet on the first save only', async () => {
    const draft = await request(app)
      .put(ebPath('GPA', id, '/requirements'))
      .set(bearer(world.manager))
      .send(gpaSheet({ sumInsuredBasis: null }))
      .expect(200);
    expect(draft.body).toMatchObject({ stage: 'DATA_SHEET' });
    expect(draft.body.missingItems.map((item: { field: string }) => item.field)).toContain(
      'sumInsuredBasis',
    );
    // A JSON number for an amount and a GTLI field are refused, and the sheet stays as saved.
    await request(app)
      .put(ebPath('GPA', id, '/requirements'))
      .set(bearer(world.manager))
      .send(gpaSheet({ sumInsuredBasis: { kind: 'FLAT', amount: 500000 } }))
      .expect(400);
    await request(app)
      .put(ebPath('GPA', id, '/requirements'))
      .set(bearer(world.manager))
      .send({ ...gpaSheet(), freeCoverLimit: '1000' })
      .expect(400);
    const stored = (
      await request(app).get(ebPath('GPA', id)).set(bearer(world.readOnly)).expect(200)
    ).body;
    expect(stored.requirements.sumInsuredBasis).toBeNull();
  });

  it('saves a GTLI Data Sheet and lists the renewal’s missing claims', async () => {
    const renewal = await createEbCase(app, world.manager, 'GTLI', world.clientId, {
      type: 'RENEWAL',
      existingInsurer: 'Old Life Co',
    });
    const saved = await request(app)
      .put(ebPath('GTLI', renewal.id, '/requirements'))
      .set(bearer(world.manager))
      .send(gtliSheet())
      .expect(200);
    expect(saved.body.missingItems).toEqual([
      { field: 'claims', label: 'Previous years’ premium and claims (renewal)' },
    ]);
    expect(saved.body.stage).toBe('DATA_SHEET');
    await request(app)
      .put(ebPath('GTLI', renewal.id, '/requirements'))
      .set(bearer(world.manager))
      .send({ ...gtliSheet(), covers: {} })
      .expect(400);
  });

  it('closes with a reason, then refuses every change and stays readable', async () => {
    await request(app)
      .post(ebPath('GPA', id, '/close'))
      .set(bearer(world.manager))
      .send({ reason: '   ' })
      .expect(400);
    await request(app)
      .post(ebPath('GPA', id, '/close'))
      .set(bearer(world.manager))
      .send({ reason: 'x'.repeat(301) })
      .expect(400);
    await request(app)
      .post(ebPath('GPA', id, '/close'))
      .set(bearer(world.readOnly))
      .send({ reason: 'Lost' })
      .expect(403);
    const closed = await request(app)
      .post(ebPath('GPA', id, '/close'))
      .set(bearer(world.manager))
      .send({ reason: 'Lost to another broker' })
      .expect(200);
    expect(closed.body).toMatchObject({
      stage: 'CLOSED',
      closedReason: 'Lost to another broker',
      nextStep: null,
    });
    await request(app)
      .post(ebPath('GPA', id, '/close'))
      .set(bearer(world.manager))
      .send({ reason: 'Again' })
      .expect(409);
    await request(app)
      .put(ebPath('GPA', id, '/requirements'))
      .set(bearer(world.manager))
      .send(gpaSheet())
      .expect(409);
    await request(app)
      .put(ebPath('GPA', id, '/insurers'))
      .set(bearer(world.manager))
      .send({ insurerIds: [] })
      .expect(409);
    await request(app).get(ebPath('GPA', id)).set(bearer(world.readOnly)).expect(200);
    const audit = await AuditLogModel.findOne({ action: 'EB_CASE_CLOSED', entityId: id }).lean();
    expect(audit).toMatchObject({
      before: { stage: 'DATA_SHEET' },
      after: { stage: 'CLOSED', reason: 'Lost to another broker' },
    });
  });

  it('checks permissions on reads and the Data Sheet', async () => {
    const other = await createEbCase(app, world.manager, 'GTLI', world.clientId);
    await request(app).get(ebPath('GTLI', other.id)).expect(401);
    for (const role of ROLE_LIST) {
      await request(app).get(ebPath('GTLI', other.id)).set(bearer(world.tokens[role])).expect(200);
      await request(app)
        .put(ebPath('GTLI', other.id, '/requirements'))
        .set(bearer(world.tokens[role]))
        .send(gtliSheet())
        .expect(can.edit!.includes(role) ? 200 : 403);
    }
  });
});

describe('Property is untouched', () => {
  it('creates no proposal', async () => {
    expect(await ProposalModel.countDocuments({})).toBe(0);
    await request(app).get('/api/v1/proposals').set(bearer(world.manager)).expect(200);
  });
});
