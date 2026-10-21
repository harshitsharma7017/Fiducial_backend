import { DEFAULT_FAMILY_PLANS, type FamilyPlan } from '../src/shared/index.ts';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLogModel } from '../src/modules/audit/audit.model.ts';
import { ensureDefaultFamilyPlans } from '../src/modules/family-plans/default-plans.ts';
import { FamilyPlanModel } from '../src/modules/family-plans/family-plan.model.ts';
import { GhiCaseModel } from '../src/modules/ghi/ghi-case.model.ts';
import { bearer, createTestApp, tokenFor, useTestDatabase } from './helpers/app.ts';
import { ROLE_LIST, createEbCase, createClient } from './helpers/eb.ts';
import { seedMasters } from './helpers/masters.ts';

// The Family Plan Master (N2, Requirements 12 to 14): the seven default plans created once at
// startup, versions as data with their configuration rules, and permissions.

useTestDatabase();
const app = createTestApp();
const tokens: Record<string, string> = {};
const api = '/api/v1/family-plans';

const version = (overrides: Record<string, unknown> = {}) => ({
  effectiveFrom: '2026-04-01',
  effectiveTo: null,
  parentsAndInLawsMixed: false,
  slots: [
    { name: 'Self', min: 1, max: 1, relationships: [{ relationship: 'SELF', max: 1 }] },
    { name: 'Spouse', min: 0, max: 1, relationships: [{ relationship: 'SPOUSE', max: 1 }] },
    { name: 'Children', min: 0, max: 2, relationships: [{ relationship: 'CHILD', max: 2 }] },
  ],
  ...overrides,
});

beforeAll(async () => {
  await seedMasters();
  for (const role of ROLE_LIST) tokens[role] = (await tokenFor(app, [role])).token;
});

describe('default plans (Requirement 14)', () => {
  it('creates the seven defaults once, with system audit entries, also when two starts race', async () => {
    const [first, second] = await Promise.all([
      ensureDefaultFamilyPlans(),
      ensureDefaultFamilyPlans(),
    ]);
    expect(first.created.length + second.created.length).toBe(7);
    expect(await FamilyPlanModel.countDocuments({})).toBe(7);
    const plans = await FamilyPlanModel.find({}).lean();
    for (const plan of DEFAULT_FAMILY_PLANS) {
      const stored = plans.find((item) => item.product === plan.product && item.code === plan.code);
      expect(stored).toMatchObject({ name: plan.name, active: true, isDefault: true });
      expect(stored?.versions).toHaveLength(1);
      expect(stored?.versions[0]).toMatchObject({
        number: 1,
        status: 'ACTIVE',
        effectiveFrom: '2000-01-01',
        effectiveTo: null,
        clientConfirmed: false,
      });
    }
    const audits = await AuditLogModel.find({ action: 'FAMILY_PLAN_CREATED' }).lean();
    expect(audits).toHaveLength(7);
    expect(audits.every((entry) => entry.userId === null && entry.before === null)).toBe(true);
  });

  it('leaves existing plans untouched on a second start, also a deactivated default', async () => {
    const gmc13 = await FamilyPlanModel.findOne({ product: 'GMC', code: '1+3' }).lean();
    await request(app)
      .post(`${api}/${gmc13!._id.toHexString()}/deactivate`)
      .set(bearer(tokens.ADMIN!))
      .expect(200);
    const before = await FamilyPlanModel.find({}).sort({ _id: 1 }).lean();
    const audits = await AuditLogModel.countDocuments({});
    expect((await ensureDefaultFamilyPlans()).created).toEqual([]);
    expect(await FamilyPlanModel.find({}).sort({ _id: 1 }).lean()).toEqual(before);
    expect(await AuditLogModel.countDocuments({})).toBe(audits);
    await request(app)
      .post(`${api}/${gmc13!._id.toHexString()}/activate`)
      .set(bearer(tokens.ADMIN!))
      .expect(200);
  });

  it('lists plans by product with the version in effect and the open questions', async () => {
    const list = await request(app)
      .get(`${api}?product=GPA`)
      .set(bearer(tokens.READ_ONLY!))
      .expect(200);
    expect(list.body.items.map((item: { code: string }) => item.code).sort()).toEqual([
      '1+3',
      'SELF',
    ]);
    expect(list.body.items[0]).toMatchObject({ inEffect: 1, current: { clientConfirmed: false } });
    const gtli = await request(app)
      .get(`${api}?product=GTLI`)
      .set(bearer(tokens.READ_ONLY!))
      .expect(200);
    expect(gtli.body.items[0].openQuestions).toEqual([6, 16]);
    await request(app).get(`${api}?product=HEALTH`).set(bearer(tokens.READ_ONLY!)).expect(400);
  });
});

describe('plans and versions (Requirements 12, 13)', () => {
  let planId: string;

  it('creates a plan with a Draft first version, refusing a code taken in the product', async () => {
    const created = await request(app)
      .post(api)
      .set(bearer(tokens.ADMIN!))
      .send({ product: 'GPA', code: 'FAM-2', name: 'GPA family of 4', firstVersion: version() })
      .expect(201);
    planId = created.body.id as string;
    expect(created.body.versions[0]).toMatchObject({
      number: 1,
      status: 'DRAFT',
      clientConfirmed: false,
    });
    const taken = await request(app)
      .post(api)
      .set(bearer(tokens.ADMIN!))
      .send({ product: 'GPA', code: 'FAM-2', name: 'Another', firstVersion: version() })
      .expect(409);
    expect(taken.body).toMatchObject({
      code: 'FAMILY_PLAN_CODE_TAKEN',
      message: expect.stringContaining('GPA family of 4'),
    });
    // The same code is free in another product.
    await request(app)
      .post(api)
      .set(bearer(tokens.ADMIN!))
      .send({ product: 'GTLI', code: 'FAM-2', name: 'GTLI family', firstVersion: version() })
      .expect(201);
  });

  it('refuses an invalid version with every issue at once, storing nothing', async () => {
    const count = await AuditLogModel.countDocuments({});
    const response = await request(app)
      .post(`${api}/${planId}/versions`)
      .set(bearer(tokens.ADMIN!))
      .send(
        version({
          parentsAndInLawsMixed: null,
          slots: [
            { name: 'Self', min: 1, max: 1, relationships: [{ relationship: 'SELF', max: 1 }] },
            { name: 'Spouse', min: 0, max: 2, relationships: [{ relationship: 'SPOUSE', max: 2 }] },
            { name: 'Kids', min: 0, max: 2, relationships: [{ relationship: 'SPOUSE', max: 1 }] },
          ],
        }),
      )
      .expect(400);
    const paths = response.body.details.map((item: { path: string }) => item.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'parentsAndInLawsMixed',
        'slots.1.relationships.0.max',
        'slots.2.relationships.0.relationship',
      ]),
    );
    expect(await AuditLogModel.countDocuments({})).toBe(count);
    expect((await FamilyPlanModel.findById(planId).lean())?.versions).toHaveLength(1);
  });

  it('edits a Draft, activates it once, then refuses changes to it', async () => {
    await request(app)
      .put(`${api}/${planId}/versions/1`)
      .set(bearer(tokens.ADMIN!))
      .send(version({ effectiveFrom: '2026-01-01' }))
      .expect(200);
    const active = await request(app)
      .post(`${api}/${planId}/versions/1/activate`)
      .set(bearer(tokens.ADMIN!))
      .expect(200);
    expect(active.body.versions[0]).toMatchObject({
      status: 'ACTIVE',
      effectiveFrom: '2026-01-01',
    });
    const again = await request(app)
      .post(`${api}/${planId}/versions/1/activate`)
      .set(bearer(tokens.ADMIN!))
      .expect(409);
    expect(again.body.code).toBe('FAMILY_PLAN_VERSION_LOCKED');
    const edit = await request(app)
      .put(`${api}/${planId}/versions/1`)
      .set(bearer(tokens.ADMIN!))
      .send(version())
      .expect(409);
    expect(edit.body.code).toBe('FAMILY_PLAN_VERSION_LOCKED');
  });

  it('refuses an overlapping activation, sets an end date once, confirms No to Yes only', async () => {
    await request(app)
      .post(`${api}/${planId}/versions`)
      .set(bearer(tokens.ADMIN!))
      .send(version({ effectiveFrom: '2027-01-01' }))
      .expect(201);
    const overlap = await request(app)
      .post(`${api}/${planId}/versions/2/activate`)
      .set(bearer(tokens.ADMIN!))
      .expect(409);
    expect(overlap.body).toMatchObject({
      code: 'FAMILY_PLAN_OVERLAP',
      message: expect.stringContaining('version 1'),
    });
    await request(app)
      .put(`${api}/${planId}/versions/1/effective-to`)
      .set(bearer(tokens.ADMIN!))
      .send({ effectiveTo: '2026-12-31' })
      .expect(200);
    const twice = await request(app)
      .put(`${api}/${planId}/versions/1/effective-to`)
      .set(bearer(tokens.ADMIN!))
      .send({ effectiveTo: '2026-12-30' })
      .expect(409);
    expect(twice.body.code).toBe('FAMILY_PLAN_VERSION_LOCKED');
    const activated = await request(app)
      .post(`${api}/${planId}/versions/2/activate`)
      .set(bearer(tokens.ADMIN!))
      .expect(200);
    expect(
      activated.body.versions.map((item: { number: number; status: string }) => [
        item.number,
        item.status,
      ]),
    ).toEqual([
      [2, 'ACTIVE'],
      [1, 'ACTIVE'],
    ]);
    await request(app)
      .post(`${api}/${planId}/versions/1/confirm`)
      .set(bearer(tokens.ADMIN!))
      .expect(200);
    const confirmTwice = await request(app)
      .post(`${api}/${planId}/versions/1/confirm`)
      .set(bearer(tokens.ADMIN!))
      .expect(409);
    expect(confirmTwice.body.code).toBe('FAMILY_PLAN_VERSION_LOCKED');
  });

  it('has no delete route', async () => {
    await request(app).delete(`${api}/${planId}`).set(bearer(tokens.ADMIN!)).expect(404);
    await request(app).delete(`${api}/${planId}/versions/1`).set(bearer(tokens.ADMIN!)).expect(404);
  });

  it('lists the open cases using a plan before a deactivation, and keeps their assignments', async () => {
    const clientId = await createClient(app, tokens.ADMIN!);
    const gpa13 = (await FamilyPlanModel.findOne({ product: 'GPA', code: '1+3' }).lean())!;
    const created = await createEbCase(app, tokens.ACCOUNT_MANAGER!, 'GPA', clientId);
    await request(app)
      .put(`/api/v1/eb/gpa/cases/${created.id}/plan`)
      .set(bearer(tokens.ACCOUNT_MANAGER!))
      .send({ planId: gpa13._id.toHexString() })
      .expect(200);
    const open = await request(app)
      .get(`${api}/${gpa13._id.toHexString()}/open-cases`)
      .set(bearer(tokens.ADMIN!))
      .expect(200);
    expect(open.body.items).toEqual([
      expect.objectContaining({ id: created.id, product: 'GPA', versionNumber: 1 }),
    ]);
    await request(app)
      .post(`${api}/${gpa13._id.toHexString()}/deactivate`)
      .set(bearer(tokens.ADMIN!))
      .expect(200);
    const stored = await GhiCaseModel.findById(created.id).lean();
    expect(stored?.planAssignment).toMatchObject({ code: '1+3', versionNumber: 1 });
    await request(app)
      .post(`${api}/${gpa13._id.toHexString()}/activate`)
      .set(bearer(tokens.ADMIN!))
      .expect(200);
  });

  it('keeps GMC 1+3 and GPA 1+3 independent', async () => {
    const gmc13 = (await FamilyPlanModel.findOne({ product: 'GMC', code: '1+3' }).lean())!;
    const gpaBefore = await FamilyPlanModel.findOne({ product: 'GPA', code: '1+3' }).lean();
    const casesBefore = await GhiCaseModel.find(
      { 'planAssignment.code': '1+3' },
      { planAssignment: 1 },
    ).lean();
    await request(app)
      .post(`${api}/${gmc13._id.toHexString()}/versions`)
      .set(bearer(tokens.ADMIN!))
      .send(
        version({
          effectiveFrom: '2030-01-01',
          slots: [
            { name: 'Self', min: 1, max: 1, relationships: [{ relationship: 'SELF', max: 1 }] },
            {
              name: 'Children',
              min: 0,
              max: 2,
              relationships: [{ relationship: 'CHILD', max: 2 }],
            },
          ],
        }),
      )
      .expect(201);
    expect(await FamilyPlanModel.findOne({ product: 'GPA', code: '1+3' }).lean()).toEqual(
      gpaBefore,
    );
    expect(
      await GhiCaseModel.find({ 'planAssignment.code': '1+3' }, { planAssignment: 1 }).lean(),
    ).toEqual(casesBefore);
  });
});

describe('permissions (Requirement 12.13, 24.1)', () => {
  it('lets masters.view read and only masters.manage change', async () => {
    const plans = (await request(app).get(api).set(bearer(tokens.READ_ONLY!)).expect(200)).body
      .items as FamilyPlan[];
    const planId = plans[0]!.id;
    await request(app).get(api).expect(401);
    for (const role of ROLE_LIST) {
      await request(app).get(`${api}/${planId}`).set(bearer(tokens[role]!)).expect(200);
      const status = role === 'ADMIN' ? 200 : 403;
      await request(app)
        .put(`${api}/${planId}`)
        .set(bearer(tokens[role]!))
        .send({ name: plans[0]!.name })
        .expect(status);
      await request(app)
        .get(`${api}/${planId}/open-cases`)
        .set(bearer(tokens[role]!))
        .expect(status);
    }
    await request(app).post(api).set(bearer(tokens.ACCOUNT_MANAGER!)).send({}).expect(403);
    await request(app)
      .get(`${api}/0123456789abcdef01234567`)
      .set(bearer(tokens.READ_ONLY!))
      .expect(404);
    await request(app)
      .put(`${api}/${planId}`)
      .set(bearer(tokens.ADMIN!))
      .send({ name: '', extra: 1 })
      .expect(400);
  });
});
