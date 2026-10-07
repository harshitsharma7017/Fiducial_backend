import { ROLES, can, type Permission, type Role } from '../src/shared/index.ts';
import request, { type Test } from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestApp, tokenFor, useTestDatabase } from './helpers/app.ts';
import { seedMasters } from './helpers/masters.ts';

useTestDatabase();
const app = createTestApp();

const tokens = new Map<Role, string>();

beforeAll(async () => {
  await seedMasters();
  for (const role of ROLES) tokens.set(role, (await tokenFor(app, [role])).token);
});

const NO_ID = '0123456789abcdef01234567';

interface Endpoint {
  name: string;
  permission: Permission;
  call: (token: string) => Test;
}

// One call per guarded route. An allowed call may still fail for other reasons (the activation
// id below does not exist), but never with 401 or 403.
const ENDPOINTS: Endpoint[] = [
  {
    name: 'GET /email-templates',
    permission: 'masters.view',
    call: (token) => request(app).get('/api/v1/email-templates').set(bearer(token)),
  },
  {
    name: 'PUT /email-templates/{kind}',
    permission: 'masters.manage',
    // A stale version: allowed roles get 409, never 401 or 403.
    call: (token) =>
      request(app)
        .put('/api/v1/email-templates/REMINDER')
        .set(bearer(token))
        .send({ subject: 'Reminder', body: 'Dear {{contactName}}', expectedVersion: 999 }),
  },
  {
    name: 'GET /mail/status',
    permission: 'settings.view',
    call: (token) => request(app).get('/api/v1/mail/status').set(bearer(token)),
  },
  {
    name: 'GET /users',
    permission: 'users.manage',
    call: (token) => request(app).get('/api/v1/users').set(bearer(token)),
  },
  {
    name: 'GET /masters/versions',
    permission: 'masters.view',
    call: (token) => request(app).get('/api/v1/masters/versions').set(bearer(token)),
  },
  {
    name: 'GET /masters/occupancies/{tacCode}',
    permission: 'masters.view',
    call: (token) => request(app).get('/api/v1/masters/occupancies/2001').set(bearer(token)),
  },
  {
    name: 'GET /masters/pincodes/{pincode}',
    permission: 'masters.view',
    call: (token) => request(app).get('/api/v1/masters/pincodes/400001').set(bearer(token)),
  },
  {
    name: 'GET /masters/workbook',
    permission: 'masters.view',
    call: (token) => request(app).get('/api/v1/masters/workbook?template=true').set(bearer(token)),
  },
  {
    name: 'POST /masters/import',
    permission: 'masters.manage',
    call: (token) =>
      request(app)
        .post('/api/v1/masters/import')
        .set(bearer(token))
        .set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .send(Buffer.from('not a workbook')),
  },
  {
    name: 'POST /masters/versions/{id}/activate',
    permission: 'masters.manage',
    call: (token) =>
      request(app)
        .post('/api/v1/masters/versions/0123456789abcdef01234567/activate')
        .set(bearer(token)),
  },
  {
    name: 'POST /rating/fire',
    permission: 'rating.use',
    call: (token) =>
      request(app)
        .post('/api/v1/rating/fire')
        .set(bearer(token))
        .send({ occupancyCode: '2001', pincode: '400001', sumInsured: '100000000' }),
  },
  {
    name: 'GET /clients',
    permission: 'clients.view',
    call: (token) => request(app).get('/api/v1/clients').set(bearer(token)),
  },
  {
    name: 'POST /clients',
    permission: 'clients.manage',
    call: (token) => request(app).post('/api/v1/clients').set(bearer(token)).send({}),
  },
  {
    name: 'GET /clients/{id}/locations',
    permission: 'clients.view',
    call: (token) =>
      request(app).get('/api/v1/clients/0123456789abcdef01234567/locations').set(bearer(token)),
  },
  {
    name: 'PATCH /clients/{id}/locations/{locationId}',
    permission: 'clients.manage',
    call: (token) =>
      request(app)
        .patch('/api/v1/clients/0123456789abcdef01234567/locations/0123456789abcdef01234567')
        .set(bearer(token))
        .send({ name: 'Plant 2' }),
  },
  {
    name: 'GET /insurers',
    permission: 'masters.view',
    call: (token) => request(app).get('/api/v1/insurers').set(bearer(token)),
  },
  {
    name: 'POST /insurers',
    permission: 'masters.manage',
    call: (token) => request(app).post('/api/v1/insurers').set(bearer(token)).send({}),
  },
  {
    name: 'GET /audit',
    permission: 'audit.view',
    call: (token) => request(app).get('/api/v1/audit').set(bearer(token)),
  },
  // RFQ mail: the case id does not exist, so an allowed call ends in 404 and mails nobody.
  {
    name: 'POST /proposals/{id}/rfq/preview',
    permission: 'proposals.send',
    call: (token) =>
      request(app)
        .post(`/api/v1/proposals/${NO_ID}/rfq/preview`)
        .set(bearer(token))
        .send({ insurers: [{ insurerId: NO_ID, to: ['a@b.example'] }], dueDate: '2099-01-01' }),
  },
  {
    name: 'POST /proposals/{id}/rfq/email',
    permission: 'proposals.send',
    call: (token) =>
      request(app)
        .post(`/api/v1/proposals/${NO_ID}/rfq/email`)
        .set(bearer(token))
        .send({
          sendId: '6f1c2a4e-8b3d-4c5e-9f7a-1b2c3d4e5f60',
          insurers: [{ insurerId: NO_ID, to: ['a@b.example'] }],
          dueDate: '2099-01-01',
          format: 'xlsx',
        }),
  },
  {
    name: 'POST /proposals/{id}/insurers/{insurerId}/reminder',
    permission: 'proposals.send',
    call: (token) =>
      request(app)
        .post(`/api/v1/proposals/${NO_ID}/insurers/${NO_ID}/reminder`)
        .set(bearer(token))
        .send({
          sendId: '6f1c2a4e-8b3d-4c5e-9f7a-1b2c3d4e5f61',
          to: ['a@b.example'],
          attachRfq: false,
        }),
  },
  {
    name: 'PUT /proposals/{id}/insurers/{insurerId}/response',
    permission: 'proposals.edit',
    call: (token) =>
      request(app)
        .put(`/api/v1/proposals/${NO_ID}/insurers/${NO_ID}/response`)
        .set(bearer(token))
        .send({ status: 'DECLINED' }),
  },
  {
    name: 'GET /proposals/{id}/quotes',
    permission: 'proposals.view',
    call: (token) => request(app).get(`/api/v1/proposals/${NO_ID}/quotes`).set(bearer(token)),
  },
  {
    name: 'POST /proposals/{id}/insurers/{insurerId}/quotes',
    permission: 'proposals.edit',
    call: (token) =>
      request(app)
        .post(`/api/v1/proposals/${NO_ID}/insurers/${NO_ID}/quotes`)
        .set(bearer(token))
        .send({ option: 'P1', sections: [], attachmentIds: [] }),
  },
  {
    name: 'POST /proposals/{id}/insurers/{insurerId}/quote-attachments',
    permission: 'proposals.edit',
    call: (token) =>
      request(app)
        .post(`/api/v1/proposals/${NO_ID}/insurers/${NO_ID}/quote-attachments?fileName=q.pdf`)
        .set(bearer(token))
        .set('Content-Type', 'application/pdf')
        .send(Buffer.from('%PDF-1.4')),
  },
  {
    name: 'GET /proposals/{id}/quote-attachments/{attachmentId}',
    permission: 'proposals.view',
    call: (token) =>
      request(app).get(`/api/v1/proposals/${NO_ID}/quote-attachments/${NO_ID}`).set(bearer(token)),
  },
  {
    name: 'GET /proposals/{id}/rfq/versions',
    permission: 'proposals.view',
    call: (token) => request(app).get(`/api/v1/proposals/${NO_ID}/rfq/versions`).set(bearer(token)),
  },
  {
    name: 'POST /proposals/{id}/rfq/versions',
    permission: 'proposals.edit',
    call: (token) =>
      request(app).post(`/api/v1/proposals/${NO_ID}/rfq/versions`).set(bearer(token)),
  },
  {
    name: 'PUT /proposals/{id}/rfq/edits',
    permission: 'proposals.edit',
    call: (token) =>
      request(app)
        .put(`/api/v1/proposals/${NO_ID}/rfq/edits`)
        .set(bearer(token))
        .send({ title: null, notes: null, risk: [], claims: null }),
  },
  {
    name: 'GET /proposals/{id}/rfq/versions/{version}',
    permission: 'proposals.view',
    call: (token) =>
      request(app).get(`/api/v1/proposals/${NO_ID}/rfq/versions/1`).set(bearer(token)),
  },
  {
    name: 'GET /proposals/{id}/rfq/versions/{version}/file',
    permission: 'proposals.export',
    call: (token) =>
      request(app)
        .get(`/api/v1/proposals/${NO_ID}/rfq/versions/1/file?format=pdf`)
        .set(bearer(token)),
  },
  {
    name: 'POST /proposals/{id}/rfq/versions/{version}/submit',
    permission: 'proposals.edit',
    call: (token) =>
      request(app)
        .post(`/api/v1/proposals/${NO_ID}/rfq/versions/1/submit`)
        .set(bearer(token))
        .send({}),
  },
  {
    name: 'POST /proposals/{id}/rfq/versions/{version}/approve',
    permission: 'proposals.approve',
    call: (token) =>
      request(app)
        .post(`/api/v1/proposals/${NO_ID}/rfq/versions/1/approve`)
        .set(bearer(token))
        .send({}),
  },
  {
    name: 'POST /proposals/{id}/rfq/versions/{version}/return',
    permission: 'proposals.approve',
    call: (token) =>
      request(app)
        .post(`/api/v1/proposals/${NO_ID}/rfq/versions/1/return`)
        .set(bearer(token))
        .send({ comment: 'Fix it' }),
  },
  {
    name: 'GET /proposals/{id}/qcr',
    permission: 'proposals.view',
    call: (token) => request(app).get(`/api/v1/proposals/${NO_ID}/qcr`).set(bearer(token)),
  },
  {
    name: 'PUT /proposals/{id}/qcr',
    permission: 'proposals.edit',
    call: (token) =>
      request(app).put(`/api/v1/proposals/${NO_ID}/qcr`).set(bearer(token)).send({
        recommendedInsurerId: null,
        recommendedOption: null,
        recommendation: null,
        remarks: null,
        paymentInFavourOf: null,
      }),
  },
  {
    name: 'POST /proposals/{id}/qcr/approve',
    permission: 'proposals.approve',
    call: (token) =>
      request(app)
        .post(`/api/v1/proposals/${NO_ID}/qcr/approve`)
        .set(bearer(token))
        .send({ fingerprint: 'x' }),
  },
  {
    name: 'GET /proposals/{id}/qcr/document',
    permission: 'proposals.export',
    call: (token) =>
      request(app).get(`/api/v1/proposals/${NO_ID}/qcr/document?format=pdf`).set(bearer(token)),
  },
  {
    name: 'POST /proposals/{id}/qcr/email',
    permission: 'proposals.send',
    call: (token) =>
      request(app)
        .post(`/api/v1/proposals/${NO_ID}/qcr/email`)
        .set(bearer(token))
        .send({
          sendId: '6f1c2a4e-8b3d-4c5e-9f7a-1b2c3d4e5f62',
          to: ['a@b.example'],
          format: 'pdf',
        }),
  },
  {
    name: 'GET /proposals/{id}/mails',
    permission: 'proposals.view',
    call: (token) => request(app).get(`/api/v1/proposals/${NO_ID}/mails`).set(bearer(token)),
  },
  {
    name: 'GET /proposals/{id}/mails/{mailId}',
    permission: 'proposals.view',
    call: (token) =>
      request(app).get(`/api/v1/proposals/${NO_ID}/mails/${NO_ID}`).set(bearer(token)),
  },
  {
    name: 'GET /proposals/{id}/mails/{mailId}/attachment',
    permission: 'proposals.export',
    call: (token) =>
      request(app).get(`/api/v1/proposals/${NO_ID}/mails/${NO_ID}/attachment`).set(bearer(token)),
  },
];

describe.each(ENDPOINTS)('$name needs $permission', ({ permission, call }) => {
  it('needs a session', async () => {
    await call('').expect(401);
  });

  it.each(ROLES)('%s', async (role) => {
    const response = await call(tokens.get(role) ?? '');
    if (can([role], permission)) {
      expect([401, 403]).not.toContain(response.status);
      expect(response.status).toBeLessThan(500);
    } else {
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('FORBIDDEN');
    }
  });
});
