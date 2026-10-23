import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLogModel } from '../src/modules/audit/audit.model.ts';
import { FamilyPlanModel } from '../src/modules/family-plans/family-plan.model.ts';
import { bearer, createTestApp, useTestDatabase } from './helpers/app.ts';
import { createEbCase, ebPath, gpaSheet, setUpWorld, type EbWorld } from './helpers/eb.ts';
import { tokenWithPermissions } from './helpers/roles.ts';

// Sensitive data by permission (docs/RBAC.md): census and employee personal fields are withheld by
// the API, raw census rows and their downloads need the field permissions, census error reports
// need census.export, and claim documents need claims.view_documents. The migrated legacy roles
// keep exactly the access they had.

useTestDatabase();
const app = createTestApp();

let world: EbWorld;
let caseId: string;
const ID = '0123456789abcdef01234567';

beforeAll(async () => {
  world = await setUpWorld(app);
  const gpa = await createEbCase(app, world.manager, 'GPA', world.clientId);
  caseId = gpa.id;
  const plan = (await FamilyPlanModel.findOne({ product: 'GPA', code: '1+3' }).lean())!;
  await request(app)
    .put(ebPath('GPA', caseId, '/plan'))
    .set(bearer(world.manager))
    .send({ planId: plan._id.toHexString() })
    .expect(200);
  await request(app)
    .put(ebPath('GPA', caseId, '/requirements'))
    .set(bearer(world.manager))
    .send(gpaSheet())
    .expect(200);
  await request(app)
    .post(ebPath('GPA', caseId, '/members'))
    .set(bearer(world.manager))
    .send({
      employeeId: 'PII-1',
      name: 'Private Person',
      gender: 'FEMALE',
      dateOfBirth: '1985-04-12',
      relationship: 'SELF',
      dateOfJoining: '',
      sumInsured: '500000',
      annualSalary: '1200000',
    })
    .expect(201);
});

const members = async (token: string) =>
  (
    await request(app)
      .get(ebPath('GPA', caseId, '/members'))
      .set(bearer(token))
      .expect(200)
  ).body.items[0];

describe('census personal fields', () => {
  it('still shows Read-only users every field, as before the migration', async () => {
    const member = await members(world.readOnly);
    expect(member).toMatchObject({ dateOfBirth: '1985-04-12', annualSalary: '1200000' });
    expect(member.hidden).toBeUndefined();
  });

  it('withholds date of birth, salary and nominee from a role without their permissions', async () => {
    const viewer = await tokenWithPermissions(app, world.admin, ['gpa.view']);
    const member = await members(viewer.token);
    expect(member).toMatchObject({
      name: 'Private Person',
      dateOfBirth: null,
      annualSalary: null,
      monthlySalary: null,
      nominee: null,
      hidden: ['dateOfBirth', 'salary', 'nominee'],
    });
    expect(JSON.stringify(member)).not.toContain('1985-04-12');
    expect(JSON.stringify(member)).not.toContain('1200000');
  });

  it('withholds only the fields whose permission is missing', async () => {
    const viewer = await tokenWithPermissions(app, world.admin, ['gpa.view', 'employees.view_dob']);
    const member = await members(viewer.token);
    expect(member).toMatchObject({
      dateOfBirth: '1985-04-12',
      annualSalary: null,
      hidden: ['salary', 'nominee'],
    });
  });

  it('withholds them in the census issues list too', async () => {
    const viewer = await tokenWithPermissions(app, world.admin, ['gpa.view']);
    const { body } = await request(app)
      .get(ebPath('GPA', caseId, '/census/issues'))
      .set(bearer(viewer.token))
      .expect(200);
    for (const item of body.items) expect(item.member.dateOfBirth).toBeNull();
  });

  it('refuses member edits and census uploads to an editor who cannot see the fields', async () => {
    const editor = await tokenWithPermissions(app, world.admin, ['gpa.view', 'gpa.edit']);
    await request(app)
      .post(ebPath('GPA', caseId, '/members'))
      .set(bearer(editor.token))
      .send({
        employeeId: 'PII-2',
        name: 'X',
        gender: 'MALE',
        dateOfBirth: '1990-01-01',
        relationship: 'SELF',
        dateOfJoining: '',
        sumInsured: '500000',
        annualSalary: '',
      })
      .expect(403);
    await request(app)
      .post(ebPath('GPA', caseId, '/census/imports'))
      .set(bearer(editor.token))
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('not a workbook'))
      .expect(403);
    await request(app)
      .get(ebPath('GPA', caseId, `/census/imports/${ID}`))
      .set(bearer(editor.token))
      .expect(403);
  });

  it('withholds dates of birth of company employees without employees.view_dob', async () => {
    const viewer = await tokenWithPermissions(app, world.admin, ['employees.view']);
    const { body } = await request(app)
      .get(`/api/v1/eb/companies/${world.clientId}/employees`)
      .set(bearer(viewer.token))
      .expect(200);
    expect(body.items.length).toBeGreaterThan(0);
    for (const employee of body.items) {
      expect(employee.dateOfBirth).toBeNull();
      expect(employee.hidden).toEqual(['dateOfBirth']);
    }
  });
});

describe('census and case downloads', () => {
  it('needs census.export for the census error report', async () => {
    const viewer = await tokenWithPermissions(app, world.admin, ['gpa.view']);
    await request(app)
      .get(ebPath('GPA', caseId, `/census/imports/${ID}/error-report`))
      .set(bearer(viewer.token))
      .expect(403);
    const exporter = await tokenWithPermissions(app, world.admin, ['gpa.view', 'census.export']);
    // Allowed past the guard: the import does not exist.
    await request(app)
      .get(ebPath('GPA', caseId, `/census/imports/${ID}/error-report`))
      .set(bearer(exporter.token))
      .expect(404);
  });

  it('needs the field permissions to download documents with the member annexure', async () => {
    const exporter = await tokenWithPermissions(app, world.admin, ['gpa.view', 'gpa.export']);
    await request(app)
      .get(ebPath('GPA', caseId, '/rfq/document?format=xlsx'))
      .set(bearer(exporter.token))
      .expect(403);
    await request(app)
      .get(ebPath('GPA', caseId, '/placement-slip?format=xlsx'))
      .set(bearer(exporter.token))
      .expect(403);
  });

  it('keeps product permissions apart: GPA access does not open GTLI or GMC cases', async () => {
    const viewer = await tokenWithPermissions(app, world.admin, ['gpa.view']);
    await request(app).get(ebPath('GPA', caseId)).set(bearer(viewer.token)).expect(200);
    await request(app)
      .get('/api/v1/eb/gtli/cases/' + caseId)
      .set(bearer(viewer.token))
      .expect(403);
    await request(app).get('/api/v1/ghi/cases').set(bearer(viewer.token)).expect(403);
    const list = await request(app).get('/api/v1/eb/cases').set(bearer(viewer.token)).expect(200);
    for (const item of list.body.items) expect(item.product).toBe('GPA');
    await request(app).get('/api/v1/eb/cases?product=GTLI').set(bearer(viewer.token)).expect(403);
    await request(app)
      .post('/api/v1/eb/cases')
      .set(bearer(viewer.token))
      .send({
        product: 'GPA',
        type: 'NEW',
        clientId: world.clientId,
        dueDate: '2026-11-30',
        policyStart: '2026-12-01',
        policyEnd: '2027-11-30',
      })
      .expect(403);
  });
});

describe('claim documents', () => {
  it('needs claims.view_documents, and audits the refusal', async () => {
    const viewer = await tokenWithPermissions(app, world.admin, ['claims.view']);
    await request(app)
      .get(`/api/v1/claims/${ID}/documents/${ID}`)
      .set(bearer(viewer.token))
      .expect(403);
    expect(
      await AuditLogModel.exists({
        action: 'CLAIM_ACCESS_DENIED',
        userId: viewer.id,
        'after.permission': 'claims.view_documents',
      }),
    ).not.toBeNull();
    const reader = await tokenWithPermissions(app, world.admin, [
      'claims.view',
      'claims.view_documents',
    ]);
    await request(app)
      .get(`/api/v1/claims/${ID}/documents/${ID}`)
      .set(bearer(reader.token))
      .expect(404);
  });

  it('still lets Approvers open claim documents, as before the migration', async () => {
    await request(app)
      .get(`/api/v1/claims/${ID}/documents/${ID}`)
      .set(bearer(world.approver))
      .expect(404);
  });
});
