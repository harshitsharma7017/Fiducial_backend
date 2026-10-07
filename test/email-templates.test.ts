import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLogModel } from '../src/modules/audit/audit.model.ts';
import { DEFAULT_EMAIL_TEMPLATES } from '../src/modules/email-templates/default-templates.ts';
import { EmailTemplateModel } from '../src/modules/email-templates/email-template.model.ts';
import {
  ensureEmailTemplates,
  getEmailTemplate,
} from '../src/modules/email-templates/email-templates.service.ts';
import { bearer, createTestApp, tokenFor, useTestDatabase } from './helpers/app.ts';

useTestDatabase();

const app = createTestApp();
let adminToken = '';
let adminId = '';
let readOnlyToken = '';

beforeAll(async () => {
  const admin = await tokenFor(app, ['ADMIN']);
  adminToken = admin.token;
  adminId = admin.user.id;
  readOnlyToken = (await tokenFor(app, ['READ_ONLY'])).token;
});

interface TemplateBody {
  kind: string;
  subject: string;
  body: string;
  version: number;
  isDefault: boolean;
  updatedBy: string | null;
}

async function listTemplates(token = adminToken): Promise<TemplateBody[]> {
  const response = await request(app).get('/api/v1/email-templates').set(bearer(token)).expect(200);
  return (response.body as { items: TemplateBody[] }).items;
}

function save(kind: string, body: Record<string, unknown>) {
  return request(app).put(`/api/v1/email-templates/${kind}`).set(bearer(adminToken)).send(body);
}

describe('email templates', () => {
  it('seeds both kinds with the default wording, once', async () => {
    await ensureEmailTemplates();
    await ensureEmailTemplates();
    expect(await EmailTemplateModel.countDocuments()).toBe(2);

    const items = await listTemplates(readOnlyToken);
    expect(items.map((item) => item.kind)).toEqual(['RFQ', 'REMINDER']);
    expect(items[0]).toMatchObject({
      ...DEFAULT_EMAIL_TEMPLATES.RFQ,
      version: 1,
      isDefault: true,
      updatedBy: null,
    });
  });

  it('saves an edit with the next version, audited with the old and new wording', async () => {
    const response = await save('RFQ', {
      subject: '  RFQ for {{ insuredName }}  ',
      body: 'Dear {{contactName}},\nPlease quote by {{dueDate}}.\n{{senderName}}',
      expectedVersion: 1,
    }).expect(200);
    expect(response.body).toMatchObject({
      kind: 'RFQ',
      subject: 'RFQ for {{ insuredName }}',
      version: 2,
      isDefault: false,
      updatedBy: 'Test User',
    });

    const audit = await AuditLogModel.findOne({
      action: 'EMAIL_TEMPLATE_UPDATED',
      entityId: 'RFQ',
    }).lean();
    expect(audit).toMatchObject({
      entity: 'email_template',
      before: { subject: DEFAULT_EMAIL_TEMPLATES.RFQ.subject, version: 1 },
      after: { subject: 'RFQ for {{ insuredName }}', version: 2 },
    });
    expect(audit?.userId?.toHexString()).toBe(adminId);

    // Seeding again never puts the default back.
    await ensureEmailTemplates();
    const rfq = await getEmailTemplate('RFQ');
    expect(rfq).toMatchObject({ version: 2, subject: 'RFQ for {{ insuredName }}' });
  });

  it('refuses a save over a newer version with the current version', async () => {
    const response = await save('RFQ', {
      subject: 'Stale edit',
      body: 'Dear {{contactName}}',
      expectedVersion: 1,
    }).expect(409);
    expect(response.body).toMatchObject({
      code: 'TEMPLATE_VERSION_CONFLICT',
      details: { currentVersion: 2 },
    });
    expect((await getEmailTemplate('RFQ')).subject).toBe('RFQ for {{ insuredName }}');
  });

  it.each([
    ['an unknown field in the subject', { subject: 'Hi {{clientName}}' }, 'subject', 'clientName'],
    ['an unclosed field in the body', { body: 'Due {{dueDate' }, 'body', '{{dueDate'],
    ['a stray closing brace in the body', { body: 'Due dueDate}}' }, 'body', '}}'],
  ])('rejects %s, naming it', async (_label, change, path, named) => {
    const response = await save('REMINDER', {
      subject: 'Reminder',
      body: 'Dear {{contactName}}',
      expectedVersion: 1,
      ...change,
    }).expect(400);
    expect(response.body.details).toEqual([
      expect.objectContaining({ path, message: expect.stringContaining(named) }),
    ]);
  });

  it('rejects an unknown kind and an empty body', async () => {
    await save('QCR', { subject: 'x', body: 'y', expectedVersion: 1 }).expect(400);
    const empty = await save('REMINDER', { subject: 'x', body: '   ', expectedVersion: 1 });
    expect(empty.status).toBe(400);
    expect(empty.body.details).toEqual([expect.objectContaining({ path: 'body' })]);
  });

  it('lets only masters.manage save', async () => {
    await request(app)
      .put('/api/v1/email-templates/REMINDER')
      .set(bearer(readOnlyToken))
      .send({ subject: 'x', body: 'y', expectedVersion: 1 })
      .expect(403);
    expect((await getEmailTemplate('REMINDER')).version).toBe(1);
  });
});

describe('GET /mail/status', () => {
  it('shows the transport and From, never the SMTP password', async () => {
    const smtpApp = createTestApp({
      MAIL_TRANSPORT: 'smtp',
      MAIL_FROM: 'rfq@broker.example',
      SMTP_HOST: 'smtp.broker.example',
      SMTP_PORT: 587,
      SMTP_USER: 'mailer',
      SMTP_PASSWORD: 'smtp-secret-password',
    });
    const response = await request(smtpApp)
      .get('/api/v1/mail/status')
      .set(bearer(adminToken))
      .expect(200);
    expect(response.body).toEqual({
      transport: 'smtp',
      from: 'rfq@broker.example',
      host: 'smtp.broker.example',
    });
    expect(JSON.stringify(response.body)).not.toContain('smtp-secret-password');
    expect(JSON.stringify(response.body)).not.toContain('mailer');
  });

  it('is outbox in tests by default', async () => {
    const response = await request(app)
      .get('/api/v1/mail/status')
      .set(bearer(adminToken))
      .expect(200);
    expect(response.body).toEqual({ transport: 'outbox', from: 'rfq@outbox.invalid', host: null });
  });
});
