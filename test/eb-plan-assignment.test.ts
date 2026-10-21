import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLogModel } from '../src/modules/audit/audit.model.ts';
import { FamilyPlanModel } from '../src/modules/family-plans/family-plan.model.ts';
import { GhiCaseModel } from '../src/modules/ghi/ghi-case.model.ts';
import { bearer, createTestApp, useTestDatabase } from './helpers/app.ts';
import {
  ROLE_LIST,
  censusWorkbook,
  createClient,
  createEbCase,
  ebPath,
  gpaSheet,
  setUpWorld,
  uploadCensus,
  type EbWorld,
} from './helpers/eb.ts';

// Plan assignment (Requirement 15): company defaults per product, the plan of a new case, a
// user's assignment checked against every family, and the copy that later versions never touch.

useTestDatabase();
const app = createTestApp();
let world: EbWorld;

const planId = async (product: 'GMC' | 'GPA' | 'GTLI', code: string) =>
  (await FamilyPlanModel.findOne({ product, code }).lean())!._id.toHexString();

beforeAll(async () => {
  world = await setUpWorld(app);
});

describe('company default plans (Requirement 15.1, 15.2)', () => {
  it('sets one default per product, only active plans of that product, for clients.manage', async () => {
    const url = (product: string) =>
      `/api/v1/eb/companies/${world.clientId}/plan-defaults/${product}`;
    const gpa13 = await planId('GPA', '1+3');
    await request(app)
      .put(url('GMC'))
      .set(bearer(world.manager))
      .send({ planId: gpa13 })
      .expect(400);
    for (const role of ROLE_LIST) {
      await request(app)
        .put(url('GPA'))
        .set(bearer(world.tokens[role]))
        .send({ planId: gpa13 })
        .expect(['ADMIN', 'ACCOUNT_MANAGER'].includes(role) ? 200 : 403);
    }
    const defaults = (
      await request(app)
        .get(`/api/v1/eb/companies/${world.clientId}/plan-defaults`)
        .set(bearer(world.readOnly))
        .expect(200)
    ).body;
    expect(
      defaults.items.find((item: { product: string }) => item.product === 'GPA'),
    ).toMatchObject({ code: '1+3', active: true });
    expect(
      await AuditLogModel.countDocuments({
        action: 'CLIENT_PLAN_DEFAULT_SET',
        entityId: world.clientId,
      }),
    ).toBeGreaterThan(0);
  });

  it('gives a new case the default in the version in effect, and none when the default is inactive', async () => {
    const created = await createEbCase(app, world.manager, 'GPA', world.clientId);
    const record = (
      await request(app).get(ebPath('GPA', created.id)).set(bearer(world.readOnly)).expect(200)
    ).body;
    expect(record.plan).toMatchObject({ code: '1+3', versionNumber: 1, source: 'COMPANY_DEFAULT' });
    const assigned = await AuditLogModel.findOne({
      action: 'EB_PLAN_ASSIGNED',
      entityId: created.id,
    }).lean();
    expect(assigned).toMatchObject({ before: null, after: { code: '1+3', versionNumber: 1 } });
    const gpa13 = await planId('GPA', '1+3');
    await request(app)
      .post(`/api/v1/family-plans/${gpa13}/deactivate`)
      .set(bearer(world.admin))
      .expect(200);
    const none = await createEbCase(app, world.manager, 'GPA', world.clientId);
    expect((await GhiCaseModel.findById(none.id).lean())?.planAssignment).toBeUndefined();
    // The earlier case keeps its copy.
    expect((await GhiCaseModel.findById(created.id).lean())?.planAssignment).toMatchObject({
      code: '1+3',
    });
    await request(app)
      .post(`/api/v1/family-plans/${gpa13}/activate`)
      .set(bearer(world.admin))
      .expect(200);
  });

  it('clears a default; GMC cases of a company with no default get no plan', async () => {
    await request(app)
      .put(`/api/v1/eb/companies/${world.clientId}/plan-defaults/GPA`)
      .set(bearer(world.admin))
      .send({ planId: null })
      .expect(200);
    const gmc = await createEbCase(app, world.manager, 'GMC', world.clientId);
    expect(
      (
        await request(app)
          .get(`/api/v1/ghi/cases/${gmc.id}`)
          .set(bearer(world.readOnly))
          .expect(200)
      ).body.plan,
    ).toBeNull();
    await request(app).get(`/api/v1/eb/companies/${world.clientId}/plan-defaults`).expect(401);
  });
});

describe('assigning a plan (Requirement 15.3 to 15.9)', () => {
  it('refuses a plan that every family does not fit, listing employee IDs without names', async () => {
    const clientId = await createClient(app, world.admin);
    const created = await createEbCase(app, world.manager, 'GPA', clientId);
    const path = ebPath('GPA', created.id);
    await request(app)
      .put(`${path}/plan`)
      .set(bearer(world.manager))
      .send({ planId: await planId('GPA', '1+3') })
      .expect(200);
    await request(app)
      .put(`${path}/requirements`)
      .set(bearer(world.manager))
      .send(gpaSheet())
      .expect(200);
    const headers = [
      'Employee ID',
      'Name',
      'Gender',
      'Date of Birth',
      'Relationship',
      'Date of Joining',
      'Sum Insured',
    ];
    const preview = (
      await uploadCensus(
        app,
        world.manager,
        path,
        await censusWorkbook(headers, [
          ['P1', 'Secret Name', 'M', '01/01/1980', 'Self', null, 500000],
          ['P1', 'Hidden Spouse', 'F', '01/01/1982', 'Spouse', null, null],
        ]),
      ).expect(201)
    ).body;
    await request(app)
      .post(`${path}/census/imports/${preview.id as string}/commit`)
      .set(bearer(world.manager))
      .send({ policy: 'ALL_VALID' })
      .expect(200);
    const revision = (await GhiCaseModel.findById(created.id).lean())!.requirementsRevision;
    const conflict = await request(app)
      .put(`${path}/plan`)
      .set(bearer(world.manager))
      .send({ planId: await planId('GPA', 'SELF') })
      .expect(409);
    expect(conflict.body.code).toBe('EB_PLAN_CONFLICT');
    expect(conflict.body.details.families[0].employeeId).toBe('P1');
    expect(JSON.stringify(conflict.body)).not.toContain('Hidden Spouse');
    expect((await GhiCaseModel.findById(created.id).lean())?.planAssignment).toMatchObject({
      code: '1+3',
    });
    // Same plan again: the requirements revision goes up so an earlier RFQ goes out of date.
    await request(app)
      .put(`${path}/plan`)
      .set(bearer(world.manager))
      .send({ planId: await planId('GPA', '1+3') })
      .expect(200);
    expect((await GhiCaseModel.findById(created.id).lean())!.requirementsRevision).toBe(
      revision + 1,
    );
    await request(app)
      .put(`${path}/plan`)
      .set(bearer(world.readOnly))
      .send({ planId: await planId('GPA', '1+3') })
      .expect(403);
    await request(app)
      .put(`${path}/plan`)
      .set(bearer(world.manager))
      .send({ planId: 'nope' })
      .expect(400);
  });

  it('assigns a plan to a GMC case through /ghi, which then checks families by the plan', async () => {
    const gmc = await createEbCase(app, world.manager, 'GMC', world.clientId);
    const assigned = await request(app)
      .put(`/api/v1/ghi/cases/${gmc.id}/plan`)
      .set(bearer(world.manager))
      .send({ planId: await planId('GMC', '1+7') })
      .expect(200);
    expect(assigned.body.plan).toMatchObject({ code: '1+7', product: 'GMC' });
    const member = (body: Record<string, unknown>) => ({
      employeeId: 'G7',
      name: 'Plan Self',
      gender: 'MALE',
      dateOfBirth: '1980-01-01',
      relationship: 'SELF',
      dateOfJoining: '',
      sumInsured: '500000',
      ...body,
    });
    await request(app)
      .post(`/api/v1/ghi/cases/${gmc.id}/members`)
      .set(bearer(world.manager))
      .send(member({}))
      .expect(201);
    // The Data Sheet's family definition (employee only) no longer applies: the plan does.
    for (const [relationship, gender, name] of [
      ['FATHER', 'MALE', 'Dad'],
      ['MOTHER', 'FEMALE', 'Mum'],
      ['FATHER_IN_LAW', 'MALE', 'Dad in law'],
      ['MOTHER_IN_LAW', 'FEMALE', 'Mum in law'],
    ] as const) {
      await request(app)
        .post(`/api/v1/ghi/cases/${gmc.id}/members`)
        .set(bearer(world.manager))
        .send(member({ relationship, gender, name, dateOfBirth: '1950-01-01', sumInsured: '' }))
        .expect(201);
    }
    await request(app)
      .put(`/api/v1/ghi/cases/${gmc.id}/plan`)
      .set(bearer(world.manager))
      .send({ planId: await planId('GPA', '1+3') })
      .expect(400);
  });
});
