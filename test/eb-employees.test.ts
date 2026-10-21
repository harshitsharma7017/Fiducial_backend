import { emptyGhiRequirements } from '../src/shared/index.ts';
import { Types } from 'mongoose';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLogModel } from '../src/modules/audit/audit.model.ts';
import { linkEmployeeIdentities } from '../src/modules/employees/employee-link.ts';
import { EmployeeIdentityModel } from '../src/modules/employees/employee.model.ts';
import { FamilyPlanModel } from '../src/modules/family-plans/family-plan.model.ts';
import { GhiCaseModel } from '../src/modules/ghi/ghi-case.model.ts';
import { GhiMemberModel } from '../src/modules/ghi/ghi-census.model.ts';
import { bearer, createTestApp, useTestDatabase } from './helpers/app.ts';
import {
  ROLE_LIST,
  createEbCase,
  ebPath,
  gpaSheet,
  setUpWorld,
  type EbWorld,
} from './helpers/eb.ts';

// Employee identity (Requirement 17): existing GHI members linked at startup without being
// rewritten, members that disagree left unresolved (and still usable by claims), and the
// company page's update and resolve actions.

useTestDatabase();
const app = createTestApp();
let world: EbWorld;

/** A GHI case and Self members stored as before N1: no product, no identity reference. */
async function legacyCase(
  clientId: string,
  reference: string,
  members: Array<{ key: string; name: string; dob: string }>,
) {
  const userId = new Types.ObjectId();
  const created = await GhiCaseModel.collection.insertOne({
    reference,
    type: 'NEW',
    stage: 'DATA_SHEET',
    closedReason: null,
    clientId: new Types.ObjectId(clientId),
    ownerId: userId,
    policyStart: null,
    policyEnd: null,
    dueDate: '2026-11-30',
    existingInsurer: null,
    existingPolicyNumber: null,
    gstRatePercent: Types.Decimal128.fromString('18'),
    requirements: emptyGhiRequirements(),
    requirementsSaved: true,
    requirementsRevision: 1,
    censusRevision: 1,
    insurers: [],
    finalQcr: null,
    policy: null,
    activity: [],
    createdBy: userId,
    updatedBy: userId,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
  });
  const stamp = new Date('2025-02-01T00:00:00Z');
  await GhiMemberModel.collection.insertMany(
    members.map((member) => ({
      caseId: created.insertedId,
      employeeId: member.key,
      employeeKey: member.key,
      name: member.name,
      nameKey: member.name.toLowerCase().replace(/\s+/g, ' ').trim(),
      gender: 'MALE',
      dateOfBirth: member.dob,
      relationship: 'SELF',
      dateOfJoining: null,
      sumInsured: Types.Decimal128.fromString('300000'),
      source: 'IMPORT',
      importId: null,
      createdBy: userId,
      updatedBy: userId,
      createdAt: stamp,
      updatedAt: stamp,
    })),
  );
  return created.insertedId.toHexString();
}

beforeAll(async () => {
  world = await setUpWorld(app);
});

describe('the startup link (Requirements 17.10, 17.11)', () => {
  it('links groups that agree, adding only the reference; leaves disagreeing ones unresolved', async () => {
    await legacyCase(world.clientId, 'GHI-2025-0101', [
      { key: 'L1', name: 'Agree Person', dob: '1980-01-01' },
      { key: 'L2', name: 'Split Person', dob: '1981-01-01' },
    ]);
    await legacyCase(world.clientId, 'GHI-2025-0102', [
      { key: 'L1', name: 'AGREE  person', dob: '1980-01-01' },
      { key: 'L2', name: 'Split Person', dob: '1981-12-31' },
    ]);
    const before = await GhiMemberModel.collection
      .find({ employeeKey: { $in: ['L1', 'L2'] } })
      .toArray();
    const outcome = await linkEmployeeIdentities();
    expect(outcome).toMatchObject({ linkedMembers: 2, identitiesCreated: 1, unresolved: 1 });
    const after = await GhiMemberModel.collection
      .find({ employeeKey: { $in: ['L1', 'L2'] } })
      .toArray();
    for (const member of after) {
      const old = before.find((item) => item._id.equals(member._id))!;
      const { employeeIdentityId, ...rest } = member;
      expect(rest).toEqual(old);
      if (member.employeeKey === 'L1') expect(employeeIdentityId).toBeInstanceOf(Types.ObjectId);
      else expect(employeeIdentityId).toBeUndefined();
    }
    expect(await EmployeeIdentityModel.countDocuments({ employeeKey: 'L1' })).toBe(1);
    expect(await AuditLogModel.countDocuments({ action: 'EB_EMPLOYEE_LINKED' })).toBe(1);
    // A second run finds nothing to do.
    expect(await linkEmployeeIdentities()).toEqual({
      linkedMembers: 0,
      identitiesCreated: 0,
      unresolved: 1,
    });
  });

  it('lists the unresolved employee first and refuses a new Self row for it', async () => {
    const list = (
      await request(app)
        .get(`/api/v1/eb/companies/${world.clientId}/employees`)
        .set(bearer(world.readOnly))
        .expect(200)
    ).body;
    expect(list.items[0]).toMatchObject({ employeeKey: 'L2', unresolved: true, id: null });
    expect(
      list.items[0].variants.map((variant: { dateOfBirth: string }) => variant.dateOfBirth).sort(),
    ).toEqual(['1981-01-01', '1981-12-31']);
    expect(list).toMatchObject({ unresolved: 1, limit: 50 });
    const gpa = await createEbCase(app, world.manager, 'GPA', world.clientId);
    const plan = (await FamilyPlanModel.findOne({ product: 'GPA', code: '1+3' }).lean())!;
    await request(app)
      .put(ebPath('GPA', gpa.id, '/plan'))
      .set(bearer(world.manager))
      .send({ planId: plan._id.toHexString() })
      .expect(200);
    await request(app)
      .put(ebPath('GPA', gpa.id, '/requirements'))
      .set(bearer(world.manager))
      .send(gpaSheet())
      .expect(200);
    const refused = await request(app)
      .post(ebPath('GPA', gpa.id, '/members'))
      .set(bearer(world.manager))
      .send({
        employeeId: 'L2',
        name: 'Split Person',
        gender: 'MALE',
        dateOfBirth: '1981-01-01',
        relationship: 'SELF',
        dateOfJoining: '',
        sumInsured: '500000',
        annualSalary: '',
      })
      .expect(409);
    expect(refused.body).toMatchObject({
      code: 'EB_EMPLOYEE_UNRESOLVED',
      message: expect.stringContaining('GHI-2025-0101'),
    });
  });

  it('resolves the employee with chosen details and a reason; the open cases follow', async () => {
    const resolved = await request(app)
      .post(`/api/v1/eb/companies/${world.clientId}/employees/resolve`)
      .set(bearer(world.manager))
      .send({
        employeeKey: 'L2',
        name: 'Split Person',
        gender: 'MALE',
        dateOfBirth: '1981-01-01',
        reason: 'HR confirmed the date of birth',
      })
      .expect(200);
    expect(resolved.body.employee).toMatchObject({ unresolved: false, dateOfBirth: '1981-01-01' });
    expect(
      resolved.body.casesChanged.map((item: { reference: string }) => item.reference).sort(),
    ).toEqual(['GHI-2025-0101', 'GHI-2025-0102']);
    const members = await GhiMemberModel.find({ employeeKey: 'L2' }).lean();
    expect(
      members.every((member) => member.dateOfBirth === '1981-01-01' && member.employeeIdentityId),
    ).toBe(true);
    const audit = await AuditLogModel.findOne({ action: 'EB_EMPLOYEE_RESOLVED' }).lean();
    expect(audit?.after).toMatchObject({ reason: 'HR confirmed the date of birth' });
  });

  it('updates an identity with a reason, refusing a change that breaks an open case', async () => {
    const identity = (await EmployeeIdentityModel.findOne({
      clientId: world.clientId,
      employeeKey: 'L1',
    }).lean())!;
    const url = `/api/v1/eb/companies/${world.clientId}/employees/${identity._id.toHexString()}`;
    await request(app)
      .put(url)
      .set(bearer(world.manager))
      .send({ name: 'Agree Person', gender: 'MALE', dateOfBirth: '1980-01-01' })
      .expect(400);
    await request(app)
      .put(url)
      .set(bearer(world.readOnly))
      .send({ name: 'Agree Person', gender: 'MALE', dateOfBirth: '1980-01-01', reason: 'x' })
      .expect(403);
    // An age limit on one of the company's open cases: a date of birth that breaks it is refused.
    const caseId = (await GhiMemberModel.findOne({ employeeKey: 'L1' }).lean())!.caseId;
    await GhiCaseModel.collection.updateOne(
      { _id: caseId },
      { $set: { 'requirements.ageLimits.employee': { min: null, max: 50 } } },
    );
    const breaks = await request(app)
      .put(url)
      .set(bearer(world.manager))
      .send({
        name: 'Agree Person',
        gender: 'MALE',
        dateOfBirth: '1960-01-01',
        reason: 'Correction',
      })
      .expect(409);
    expect(breaks.body).toMatchObject({ code: 'EB_IDENTITY_CONFLICT' });
    expect((await EmployeeIdentityModel.findById(identity._id).lean())?.dateOfBirth).toBe(
      '1980-01-01',
    );
    const updated = await request(app)
      .put(url)
      .set(bearer(world.manager))
      .send({
        name: 'Agree K Person',
        gender: 'MALE',
        dateOfBirth: '1980-01-01',
        reason: 'Middle name added',
      })
      .expect(200);
    expect(updated.body.employee.name).toBe('Agree K Person');
    expect(
      (await GhiMemberModel.find({ employeeKey: 'L1' }).lean()).every(
        (member) => member.name === 'Agree K Person',
      ),
    ).toBe(true);
    await request(app)
      .put(`/api/v1/eb/companies/${world.otherClientId}/employees/${identity._id.toHexString()}`)
      .set(bearer(world.manager))
      .send({ name: 'X', gender: 'MALE', dateOfBirth: '1980-01-01', reason: 'x' })
      .expect(404);
  });

  it('checks permissions and paging of the employee list', async () => {
    await request(app).get(`/api/v1/eb/companies/${world.clientId}/employees`).expect(401);
    for (const role of ROLE_LIST) {
      await request(app)
        .get(`/api/v1/eb/companies/${world.clientId}/employees?q=agree`)
        .set(bearer(world.tokens[role]))
        .expect(200);
    }
    await request(app)
      .get(`/api/v1/eb/companies/${world.clientId}/employees?page=0`)
      .set(bearer(world.readOnly))
      .expect(400);
    await request(app)
      .get('/api/v1/eb/companies/0123456789abcdef01234567/employees')
      .set(bearer(world.readOnly))
      .expect(404);
  });
});
