import { ROLES } from '../src/shared/index.ts';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLogModel } from '../src/modules/audit/audit.model.ts';
import { bearer, createTestApp, tokenFor, useTestDatabase } from './helpers/app.ts';

useTestDatabase();
const app = createTestApp();

let adminToken: string;
let adminId: string;

beforeAll(async () => {
  const admin = await tokenFor(app, ['ADMIN']);
  adminToken = admin.token;
  adminId = admin.user.id;
});

let branchSerial = 0;
const newInsurer = (overrides: Record<string, unknown> = {}) => {
  branchSerial += 1;
  return {
    company: 'Example General Insurance',
    branch: `Branch ${branchSerial}`,
    contacts: [
      { name: 'Ravi Kumar', designation: 'Underwriter', email: 'ravi@insurer.example', phone: '' },
    ],
    rfqEmails: ['Fire.UW@insurer.example', 'property@insurer.example'],
    ...overrides,
  };
};

async function createInsurer(body = newInsurer()) {
  const response = await request(app).post('/api/v1/insurers').set(bearer(adminToken)).send(body);
  expect(response.status).toBe(201);
  return response.body as { id: string; company: string; branch: string };
}

describe('insurer master (M-3)', () => {
  it('creates an insurer branch with its RFQ emails and audits it', async () => {
    const body = newInsurer();
    const insurer = await createInsurer(body);
    expect(insurer).toMatchObject({
      company: body.company,
      branch: body.branch,
      contacts: [
        {
          name: 'Ravi Kumar',
          designation: 'Underwriter',
          email: 'ravi@insurer.example',
          phone: null,
        },
      ],
      rfqEmails: ['fire.uw@insurer.example', 'property@insurer.example'],
      active: true,
    });
    const audit = await AuditLogModel.findOne({
      action: 'INSURER_CREATED',
      entityId: insurer.id,
    }).lean();
    expect(audit?.userId?.toHexString()).toBe(adminId);
    expect(audit?.after).toMatchObject({
      rfqEmails: ['fire.uw@insurer.example', 'property@insurer.example'],
    });
  });

  it('needs at least one valid, distinct RFQ email', async () => {
    for (const rfqEmails of [[], ['not-an-email'], ['a@insurer.example', 'A@insurer.example']]) {
      const response = await request(app)
        .post('/api/v1/insurers')
        .set(bearer(adminToken))
        .send(newInsurer({ rfqEmails }))
        .expect(400);
      expect(response.body.details[0].path).toMatch(/^rfqEmails/);
    }
  });

  it('blocks the same company and branch twice, ignoring case and spaces', async () => {
    const first = await createInsurer(
      newInsurer({ company: 'Sample Assurance', branch: 'Fort, Mumbai' }),
    );
    const duplicate = await request(app)
      .post('/api/v1/insurers')
      .set(bearer(adminToken))
      .send(newInsurer({ company: 'sample  assurance', branch: 'FORT, MUMBAI ' }))
      .expect(409);
    expect(duplicate.body.code).toBe('INSURER_EXISTS');

    // Another branch of the same company is fine; renaming it onto the first is not.
    const second = await createInsurer(
      newInsurer({ company: 'Sample Assurance', branch: 'Andheri' }),
    );
    const rename = await request(app)
      .patch(`/api/v1/insurers/${second.id}`)
      .set(bearer(adminToken))
      .send({ branch: 'fort, mumbai' })
      .expect(409);
    expect(rename.body.code).toBe('INSURER_EXISTS');
    expect(first.id).not.toBe(second.id);
  });

  it('edits RFQ emails, deactivates, and records before and after', async () => {
    const insurer = await createInsurer();
    const edited = await request(app)
      .patch(`/api/v1/insurers/${insurer.id}`)
      .set(bearer(adminToken))
      .send({ rfqEmails: ['new.desk@insurer.example'], active: false })
      .expect(200);
    expect(edited.body).toMatchObject({
      company: insurer.company,
      rfqEmails: ['new.desk@insurer.example'],
      active: false,
    });
    const audit = await AuditLogModel.findOne({
      action: 'INSURER_UPDATED',
      entityId: insurer.id,
    }).lean();
    expect(audit?.before).toMatchObject({ active: true });
    expect(audit?.after).toMatchObject({ active: false, rfqEmails: ['new.desk@insurer.example'] });
  });

  it('lists by company and branch, filters active ones and searches', async () => {
    const tag = `Qq${Date.now()}`;
    const b = await createInsurer(newInsurer({ company: `${tag} Beta`, branch: 'Pune' }));
    const a2 = await createInsurer(newInsurer({ company: `${tag} alpha`, branch: 'Delhi' }));
    const a1 = await createInsurer(newInsurer({ company: `${tag} Alpha`, branch: 'Chennai' }));
    await request(app)
      .patch(`/api/v1/insurers/${b.id}`)
      .set(bearer(adminToken))
      .send({ active: false })
      .expect(200);

    const all = await request(app)
      .get(`/api/v1/insurers?q=${tag}&limit=2`)
      .set(bearer(adminToken))
      .expect(200);
    expect(all.body.items.map((i: { id: string }) => i.id)).toEqual([a1.id, a2.id]);
    const rest = await request(app)
      .get(`/api/v1/insurers?q=${tag}&limit=2&cursor=${all.body.nextCursor as string}`)
      .set(bearer(adminToken))
      .expect(200);
    expect(rest.body.items.map((i: { id: string }) => i.id)).toEqual([b.id]);

    const active = await request(app)
      .get(`/api/v1/insurers?q=${tag}&active=true`)
      .set(bearer(adminToken))
      .expect(200);
    expect(active.body.items.map((i: { id: string }) => i.id)).toEqual([a1.id, a2.id]);

    const byBranch = await request(app)
      .get(`/api/v1/insurers?q=chennai&active=true`)
      .set(bearer(adminToken))
      .expect(200);
    expect(byBranch.body.items.map((i: { id: string }) => i.id)).toContain(a1.id);
  });

  it('labels insurer entries in the audit log', async () => {
    const insurer = await createInsurer(
      newInsurer({ company: 'Label Insurance', branch: 'Kochi' }),
    );
    const entries = await request(app)
      .get(`/api/v1/audit?entity=insurer&entityId=${insurer.id}`)
      .set(bearer(adminToken))
      .expect(200);
    expect(entries.body.items[0].entityLabel).toBe('Label Insurance · Kochi');
  });
});

describe('who may change insurers', () => {
  it.each(ROLES.filter((role) => role !== 'ADMIN'))(
    '%s reads the RFQ emails but cannot change them',
    async (role) => {
      const insurer = await createInsurer();
      const { token } = await tokenFor(app, [role]);
      const read = await request(app)
        .get(`/api/v1/insurers/${insurer.id}`)
        .set(bearer(token))
        .expect(200);
      expect(read.body.rfqEmails).toHaveLength(2);
      await request(app).post('/api/v1/insurers').set(bearer(token)).send(newInsurer()).expect(403);
      await request(app)
        .patch(`/api/v1/insurers/${insurer.id}`)
        .set(bearer(token))
        .send({ active: false })
        .expect(403);
    },
  );
});
