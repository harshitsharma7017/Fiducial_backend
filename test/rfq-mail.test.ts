import { RISK_DETAIL_FIELDS, formatDate } from '../src/shared/index.ts';
import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { istDay } from '../src/lib/ist-day.ts';
import { AuditLogModel } from '../src/modules/audit/audit.model.ts';
import { MailLogModel } from '../src/modules/mail/mail-log.model.ts';
import { fitsAttachmentLimit } from '../src/modules/mail/mail-log.service.ts';
import { ProposalModel } from '../src/modules/proposals/proposal.model.ts';
import { bearer, createTestApp, tokenFor, useTestDatabase } from './helpers/app.ts';
import { FakeTransport } from './helpers/mail.ts';
import { seedMasters } from './helpers/masters.ts';

useTestDatabase();

const transport = new FakeTransport();
const app = createTestApp({}, undefined, transport);
const outboxApp = createTestApp();
const offApp = createTestApp({ MAIL_TRANSPORT: 'off' });

let admin: string;
let manager: string;
let managerEmail: string;
let placement: string;
let clientId: string;
let plant: string;
/** Three insurers: A has two RFQ addresses and a contact; B one address and a contact; C one. */
const insurers: { id: string; rfq: string[]; contact: string | null }[] = [];

const addDays = (days: number) => {
  const date = new Date(`${istDay(new Date())}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};
const DUE = addDays(14);

const risk = () => Object.fromEntries(RISK_DETAIL_FIELDS.map((field) => [field.key, '']));

beforeAll(async () => {
  await seedMasters();
  admin = (await tokenFor(app, ['ADMIN'])).token;
  const rm = await tokenFor(app, ['ACCOUNT_MANAGER']);
  manager = rm.token;
  managerEmail = rm.user.email;
  placement = (await tokenFor(app, ['PLACEMENT_EXEC'])).token;
  const client = await request(app)
    .post('/api/v1/clients')
    .set(bearer(admin))
    .send({
      name: 'Mail Test <Textiles> & Co',
      gstin: '27AAPFU0939F1ZV',
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
      name: 'Plant',
      line1: 'Plot 1',
      line2: null,
      city: 'Mumbai',
      pincode: '400001',
      occupancyCode: null,
    })
    .expect(201);
  plant = location.body.id as string;
  const masters = [
    {
      branch: 'Pune',
      rfq: ['rfq@insurer-a.example', 'pune@insurer-a.example'],
      contact: { name: 'Asha Rao', email: 'asha@insurer-a.example' },
    },
    {
      branch: 'Fort',
      rfq: ['rfq@insurer-b.example'],
      contact: { name: 'Vikram Shah', email: 'vikram@insurer-b.example' },
    },
    { branch: 'Andheri', rfq: ['quotes@insurer-c.example'], contact: null },
  ];
  for (const master of masters) {
    const insurer = await request(app)
      .post('/api/v1/insurers')
      .set(bearer(admin))
      .send({
        company: 'Kavach General',
        branch: master.branch,
        contacts: master.contact
          ? [{ ...master.contact, designation: 'Underwriter', phone: '' }]
          : [],
        rfqEmails: master.rfq,
      })
      .expect(201);
    insurers.push({
      id: insurer.body.id as string,
      rfq: master.rfq,
      contact: master.contact?.email ?? null,
    });
  }
});

beforeEach(() => {
  transport.reset();
});

/** A case with all three insurers and a complete Data Sheet. */
async function readyCase(complete = true): Promise<string> {
  const created = await request(app)
    .post('/api/v1/proposals')
    .set(bearer(manager))
    .send({ clientId, locationIds: [plant], dueDate: DUE })
    .expect(201);
  const id = created.body.id as string;
  await request(app)
    .put(`/api/v1/proposals/${id}/insurers`)
    .set(bearer(manager))
    .send({ insurerIds: insurers.map((insurer) => insurer.id) })
    .expect(200);
  if (complete) {
    await request(app)
      .put(`/api/v1/proposals/${id}/data-sheet`)
      .set(bearer(manager))
      .send({
        dueDate: DUE,
        policyStart: '',
        policyEnd: '',
        locations: [
          {
            locationId: plant,
            fire: [{ key: 'STOCKS', sqFt: '', ratePerSqFt: '', amount: '500000' }],
            hypothecation: '',
            openStock: '',
            risk: risk(),
          },
        ],
        fireOption2: [],
        sections: [],
        claims: [],
        notes: '',
      })
      .expect(200);
  }
  return id;
}

interface Result {
  insurerId: string;
  outcome: string;
  mailId: string | null;
  reason: string | null;
}

function send(
  id: string,
  chosen: { insurerId: string; to: string[] }[],
  options: { sendId?: string; dueDate?: string; token?: string; on?: typeof app } = {},
) {
  return request(options.on ?? app)
    .post(`/api/v1/proposals/${id}/rfq/email`)
    .set(bearer(options.token ?? manager))
    .send({
      sendId: options.sendId ?? randomUUID(),
      insurers: chosen,
      dueDate: options.dueDate ?? DUE,
      format: 'xlsx',
    });
}

function insurerAt(index: number) {
  const insurer = insurers[index];
  if (!insurer) throw new Error('insurer missing');
  return insurer;
}
const A = () => insurerAt(0);
const B = () => insurerAt(1);
const C = () => insurerAt(2);

/** mulberry32: a seeded generator, so a failing case reproduces from its seed. */
function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('emailing the RFQ', () => {
  // Feature: rfq-email, Property 5: one mail per insurer
  it.each([11, 23, 37, 41])(
    'sends one mail per insurer, to its chosen addresses only (seed %i)',
    async (seed) => {
      const random = seeded(seed);
      const id = await readyCase();
      const picked = insurers.filter(() => random() < 0.7);
      const chosen = (picked.length > 0 ? picked : [A()]).map((insurer) => {
        const book = [...insurer.rfq, ...(insurer.contact ? [insurer.contact] : [])];
        const to = book.filter(() => random() < 0.6);
        return { insurerId: insurer.id, to: to.length > 0 ? to : [book[0] ?? ''] };
      });
      const response = await send(id, chosen).expect(200);

      expect(transport.sent).toHaveLength(chosen.length);
      chosen.forEach((entry, index) => {
        const mail = transport.sent[index];
        expect(mail?.to).toEqual(entry.to);
        expect(Object.keys(mail ?? {}).sort()).toEqual(
          ['attachment', 'from', 'html', 'replyTo', 'subject', 'text', 'to'].sort(),
        );
      });
      expect((response.body.results as Result[]).map((result) => result.outcome)).toEqual(
        chosen.map(() => 'SENT'),
      );
      const statuses = new Map(
        (response.body.proposal.insurers as { insurerId: string; status: string }[]).map(
          (insurer) => [insurer.insurerId, insurer.status],
        ),
      );
      for (const insurer of insurers) {
        const wasChosen = chosen.some((entry) => entry.insurerId === insurer.id);
        expect(statuses.get(insurer.id)).toBe(wasChosen ? 'SENT' : 'NOT_SENT');
      }
      expect(await MailLogModel.countDocuments({ proposalId: id })).toBe(chosen.length);
    },
  );

  it('fills the template per insurer, attaches the RFQ and records everything', async () => {
    const id = await readyCase();
    const a = A();
    const c = C();
    const response = await send(id, [
      { insurerId: a.id, to: ['pune@insurer-a.example', 'asha@insurer-a.example'] },
      { insurerId: c.id, to: ['quotes@insurer-c.example'] },
    ]).expect(200);
    const record = response.body.proposal;

    const [first, second] = transport.sent;
    expect(first?.subject).toBe(
      `Request for quotation: Mail Test <Textiles> & Co (${record.reference})`,
    );
    expect(first?.text).toContain('Dear Asha Rao,');
    expect(first?.text).toContain(`by ${formatDate(DUE)}`);
    expect(first?.html).toContain('Mail Test &lt;Textiles&gt; &amp; Co');
    expect(first?.html).not.toContain('<Textiles>');
    // No contact chosen: the contact name is empty.
    expect(second?.text).toContain('Dear ,');
    expect(first?.replyTo).toBe(managerEmail);
    expect(first?.from).toBe('rfq@broker.example');
    expect(first?.attachment?.fileName).toBe(`RFQ-${record.reference}.xlsx`);
    expect(first?.attachment?.data.subarray(0, 2).toString()).toBe('PK');

    const sentA = record.insurers.find(
      (insurer: { insurerId: string }) => insurer.insurerId === a.id,
    );
    expect(sentA).toMatchObject({
      status: 'SENT',
      sentVia: 'APP',
      dueDate: DUE,
      lastMail: { kind: 'RFQ', result: 'DELIVERED' },
    });
    expect(record.stage).toBe('RFQ_SENT');
    expect(record.locked).toBe(true);
    expect(record.activity[0].message).toBe(
      `RFQ emailed to Kavach General, Andheri (quotes@insurer-c.example); quotes due ${formatDate(DUE)}`,
    );

    const audit = await AuditLogModel.findOne({ action: 'RFQ_EMAILED', entityId: id })
      .sort({ at: 1, _id: 1 })
      .lean();
    expect(audit).toMatchObject({
      before: { insurer: 'Kavach General, Pune', status: 'Not sent' },
      after: {
        insurer: 'Kavach General, Pune',
        status: 'Sent',
        to: 'pune@insurer-a.example, asha@insurer-a.example',
        result: 'DELIVERED',
        dueDate: DUE,
      },
    });

    // The mail log: newest first, one page at a time, then a mail with its bodies and file.
    const page = await request(app)
      .get(`/api/v1/proposals/${id}/mails?limit=1`)
      .set(bearer(placement))
      .expect(200);
    expect(page.body.items).toHaveLength(1);
    expect(page.body.items[0]).toMatchObject({
      kind: 'RFQ',
      insurerName: 'Kavach General, Andheri',
      to: ['quotes@insurer-c.example'],
      sentBy: 'Test User',
      transport: 'smtp',
      result: 'DELIVERED',
      attachment: { fileName: `RFQ-${record.reference}.xlsx` },
    });
    const next = await request(app)
      .get(`/api/v1/proposals/${id}/mails?limit=1&cursor=${page.body.nextCursor as string}`)
      .set(bearer(placement))
      .expect(200);
    expect(next.body.items[0].insurerName).toBe('Kavach General, Pune');
    expect(next.body.nextCursor).toBeNull();

    const mailId = next.body.items[0].id as string;
    const detail = await request(app)
      .get(`/api/v1/proposals/${id}/mails/${mailId}`)
      .set(bearer(placement))
      .expect(200);
    expect(detail.body).toMatchObject({
      from: 'rfq@broker.example',
      replyTo: managerEmail,
      text: first?.text,
      html: first?.html,
      templateVersion: 1,
      dueDate: DUE,
    });
    const file = await request(app)
      .get(`/api/v1/proposals/${id}/mails/${mailId}/attachment`)
      .set(bearer(placement))
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(Buffer.compare(file.body as Buffer, first?.attachment?.data ?? Buffer.alloc(0))).toBe(0);
    expect(file.headers['content-disposition']).toContain(`RFQ-${record.reference}.xlsx`);
    // Both mails point at one stored file.
    const entries = await MailLogModel.find({ proposalId: id }).lean();
    expect(new Set(entries.map((entry) => entry.attachmentId?.toHexString())).size).toBe(1);

    // Another case's id does not reach this mail.
    const other = await readyCase(false);
    await request(app)
      .get(`/api/v1/proposals/${other}/mails/${mailId}`)
      .set(bearer(placement))
      .expect(404);
  });

  // Feature: rfq-email, Property 6: repeated sends mail no one twice
  it('answers a repeated sendId from the log without mailing again', async () => {
    const id = await readyCase();
    const sendId = randomUUID();
    const chosen = [
      { insurerId: A().id, to: ['rfq@insurer-a.example'] },
      { insurerId: B().id, to: ['rfq@insurer-b.example'] },
    ];
    const first = await send(id, chosen, { sendId }).expect(200);
    const again = await send(id, chosen, { sendId }).expect(200);
    expect(transport.calls).toBe(2);
    expect(again.body.results).toEqual(first.body.results);
  });

  // Feature: rfq-email, Property 7: failures stay retryable
  it('keeps a failed insurer Not sent and retryable, without stopping the others', async () => {
    const id = await readyCase();
    transport.failFor.add('rfq@insurer-b.example');
    const chosen = [
      { insurerId: A().id, to: ['rfq@insurer-a.example'] },
      { insurerId: B().id, to: ['rfq@insurer-b.example'] },
      { insurerId: C().id, to: ['quotes@insurer-c.example'] },
    ];
    const response = await send(id, chosen).expect(200);
    const results = response.body.results as Result[];
    expect(results.map((result) => result.outcome)).toEqual(['SENT', 'FAILED', 'SENT']);
    expect(results[1]?.reason).toContain('550');
    const statuses = (response.body.proposal.insurers as { status: string }[]).map((i) => i.status);
    expect(statuses).toEqual(['SENT', 'NOT_SENT', 'SENT']);
    expect(await MailLogModel.countDocuments({ proposalId: id })).toBe(3);
    const failedEntry = await MailLogModel.findOne({ proposalId: id, result: 'FAILED' }).lean();
    expect(failedEntry?.error).toContain('550');
    expect(await AuditLogModel.countDocuments({ action: 'RFQ_EMAIL_FAILED', entityId: id })).toBe(
      1,
    );
    expect(response.body.proposal.activity[1].message).toContain(
      'RFQ email to Kavach General, Fort failed',
    );

    // Try again with a new send id, for the failed insurer.
    transport.reset();
    const retry = await send(id, [chosen[1] ?? chosen[0]!]).expect(200);
    expect((retry.body.results as Result[]).map((result) => result.outcome)).toEqual(['SENT']);
    expect(transport.sent.map((mail) => mail.to)).toEqual([['rfq@insurer-b.example']]);
  });

  // Feature: rfq-email, Property 9: unknown addresses send nothing
  it('refuses an address outside the insurer master and sends nothing', async () => {
    const id = await readyCase();
    const response = await send(id, [
      { insurerId: A().id, to: ['rfq@insurer-a.example'] },
      // B's address given for C.
      { insurerId: C().id, to: ['rfq@insurer-b.example'] },
    ]).expect(400);
    expect(response.body.details).toEqual([
      expect.objectContaining({
        path: 'insurers.1.to',
        message: expect.stringContaining(
          'rfq@insurer-b.example is not an address of Kavach General, Andheri',
        ),
      }),
    ]);
    expect(transport.calls).toBe(0);
    expect(await MailLogModel.countDocuments({ proposalId: id })).toBe(0);
    // An insurer that is not on the case.
    await send(id, [{ insurerId: new Types.ObjectId().toHexString(), to: ['x@y.example'] }]).expect(
      400,
    );
  });

  it('refuses a send naming an insurer that already has the RFQ, and sends nothing', async () => {
    const id = await readyCase();
    await request(app)
      .post(`/api/v1/proposals/${id}/rfq/sent`)
      .set(bearer(manager))
      .send({ insurerIds: [A().id] })
      .expect(200);
    const response = await send(id, [
      { insurerId: A().id, to: ['rfq@insurer-a.example'] },
      { insurerId: B().id, to: ['rfq@insurer-b.example'] },
    ]).expect(409);
    expect(response.body.message).toContain('already sent to Kavach General, Pune');
    expect(transport.calls).toBe(0);
  });

  it('mails an insurer once when two sends race for it', async () => {
    const id = await readyCase();
    const chosen = [{ insurerId: A().id, to: ['rfq@insurer-a.example'] }];
    const [one, two] = await Promise.all([send(id, chosen), send(id, chosen)]);
    expect(transport.sent).toHaveLength(1);
    // The loser is SKIPPED when both passed the checks, or refused when the winner had finished.
    const outcomes = [one, two].map((response) =>
      response.status === 409 ? 'REFUSED' : (response.body.results as Result[])[0]?.outcome,
    );
    expect(outcomes).toContain('SENT');
    expect(outcomes.filter((outcome) => outcome !== 'SENT')).toHaveLength(1);
    expect(['SKIPPED', 'REFUSED']).toContain(outcomes.find((outcome) => outcome !== 'SENT'));
  });

  it('refuses when mail is off, the Data Sheet is incomplete or the due date has passed', async () => {
    const id = await readyCase();
    const chosen = [{ insurerId: A().id, to: ['rfq@insurer-a.example'] }];
    const off = await send(id, chosen, { on: offApp }).expect(409);
    expect(off.body.code).toBe('MAIL_DISABLED');

    const past = await send(id, chosen, { dueDate: addDays(-1) }).expect(400);
    expect(past.body.details).toEqual([expect.objectContaining({ path: 'dueDate' })]);

    const draft = await readyCase(false);
    const incomplete = await send(draft, chosen).expect(409);
    expect(incomplete.body.code).toBe('DATA_SHEET_INCOMPLETE');

    expect(transport.calls).toBe(0);
    expect(await MailLogModel.countDocuments({ proposalId: { $in: [id, draft] } })).toBe(0);
  });

  it('refuses an attachment over 10 MB', () => {
    expect(fitsAttachmentLimit(10 * 1024 * 1024)).toBe(true);
    expect(fitsAttachmentLimit(10 * 1024 * 1024 + 1)).toBe(false);
  });

  it('keeps outbox mails in the log without delivering them', async () => {
    const id = await readyCase();
    const response = await send(id, [{ insurerId: A().id, to: ['rfq@insurer-a.example'] }], {
      on: outboxApp,
    }).expect(200);
    expect(response.body.proposal.insurers[0]).toMatchObject({
      status: 'SENT',
      lastMail: { result: 'OUTBOX' },
    });
    expect(response.body.proposal.activity[0].message).toContain(
      'kept in the outbox, not delivered',
    );
    const entry = await MailLogModel.findOne({ proposalId: id }).lean();
    expect(entry).toMatchObject({
      transport: 'outbox',
      result: 'OUTBOX',
      from: 'rfq@outbox.invalid',
    });
    expect(transport.calls).toBe(0);
  });

  it('previews one mail per insurer without sending', async () => {
    const id = await readyCase();
    const response = await request(app)
      .post(`/api/v1/proposals/${id}/rfq/preview`)
      .set(bearer(manager))
      .send({
        insurers: [
          { insurerId: A().id, to: ['asha@insurer-a.example'] },
          { insurerId: B().id, to: ['rfq@insurer-b.example'] },
        ],
        dueDate: DUE,
        format: 'pdf',
      })
      .expect(200);
    expect(response.body.mails).toHaveLength(2);
    expect(response.body.mails[0].text).toContain('Dear Asha Rao,');
    expect(response.body.attachmentName).toMatch(/^RFQ-PRP-\d{4}-\d{4}\.pdf$/);
    expect(transport.calls).toBe(0);
    expect(await MailLogModel.countDocuments({ proposalId: id })).toBe(0);
  });

  it('keeps the mail log append-only', async () => {
    await expect(MailLogModel.updateOne({}, { $set: { subject: 'x' } })).rejects.toThrow(
      /append-only/,
    );
    await expect(MailLogModel.deleteMany({})).rejects.toThrow(/append-only/);
  });
});

describe('reminders and responses', () => {
  async function sentCase(): Promise<string> {
    const id = await readyCase();
    await send(id, [
      { insurerId: A().id, to: ['rfq@insurer-a.example'] },
      { insurerId: B().id, to: ['rfq@insurer-b.example'] },
    ]).expect(200);
    transport.reset();
    return id;
  }

  function remind(id: string, insurerId: string, body: Record<string, unknown> = {}) {
    return request(app)
      .post(`/api/v1/proposals/${id}/insurers/${insurerId}/reminder`)
      .set(bearer(placement))
      .send({ sendId: randomUUID(), to: ['rfq@insurer-a.example'], attachRfq: false, ...body });
  }

  function respond(id: string, insurerId: string, status: string, note?: string) {
    return request(app)
      .put(`/api/v1/proposals/${id}/insurers/${insurerId}/response`)
      .set(bearer(placement))
      .send({ status, ...(note === undefined ? {} : { note }) });
  }

  it('reminds an insurer waiting to answer, with the Reminder template', async () => {
    const id = await sentCase();
    const first = await remind(id, A().id).expect(200);
    expect(first.body.results[0].outcome).toBe('SENT');
    expect(transport.sent[0]?.subject).toMatch(/^Reminder: request for quotation/);
    expect(transport.sent[0]?.attachment).toBeNull();
    const second = await remind(id, A().id, { attachRfq: true }).expect(200);
    expect(transport.sent[1]?.attachment?.fileName).toMatch(/\.xlsx$/);
    expect(second.body.proposal.insurers[0]).toMatchObject({
      status: 'REMINDED',
      reminderCount: 2,
      lastMail: { kind: 'REMINDER', result: 'DELIVERED' },
    });
    expect(second.body.proposal.insurers[0].lastRemindedAt).not.toBeNull();
    expect(second.body.proposal.activity[0].message).toMatch(
      /^Reminder emailed to Kavach General, Pune/,
    );
    const audit = await AuditLogModel.findOne({ action: 'RFQ_REMINDER_EMAILED', entityId: id })
      .sort({ at: -1 })
      .lean();
    expect(audit).toMatchObject({ before: { status: 'Reminded' }, after: { status: 'Reminded' } });

    // Not to an insurer that has not been sent the RFQ, nor to an address of another insurer.
    await remind(id, C().id, { to: ['quotes@insurer-c.example'] }).expect(409);
    await remind(id, A().id, { to: ['rfq@insurer-b.example'] }).expect(400);
    expect(transport.sent).toHaveLength(2);
  });

  it('records answers as the status table allows, and refuses reminders after one', async () => {
    const id = await sentCase();
    const notSent = await respond(id, C().id, 'QUOTED').expect(409);
    expect(notSent.body.message).toContain('has not been sent the RFQ');

    const declined = await respond(id, B().id, 'DECLINED', '  Outside appetite  ').expect(200);
    expect(declined.body.insurers[1]).toMatchObject({
      status: 'DECLINED',
      response: { status: 'DECLINED', note: 'Outside appetite', by: 'Test User' },
      overdue: false,
    });
    expect(declined.body.activity[0].message).toBe(
      'Kavach General, Fort: Declined (Outside appetite)',
    );
    const audit = await AuditLogModel.findOne({
      action: 'INSURER_RESPONSE_RECORDED',
      entityId: id,
    }).lean();
    expect(JSON.stringify(audit?.before)).toContain('Kavach General, Fort (SENT)');
    expect(JSON.stringify(audit?.after)).toContain('Kavach General, Fort (DECLINED)');

    // An answer can be corrected; a reminder can no longer go.
    await respond(id, B().id, 'QUOTED', '').expect(200);
    const refused = await remind(id, B().id, { to: ['rfq@insurer-b.example'] }).expect(409);
    expect(refused.body.message).toContain('Quoted');
    expect(transport.calls).toBe(0);
    await respond(id, B().id, 'MAYBE').expect(400);
  });

  it('flags an insurer still waiting after its due date as overdue', async () => {
    const id = await sentCase();
    await ProposalModel.collection.updateOne(
      { _id: new Types.ObjectId(id) },
      { $set: { 'insurers.$[a].dueDate': addDays(-2) } },
      { arrayFilters: [{ 'a.insurerId': new Types.ObjectId(A().id) }] },
    );
    const record = await request(app)
      .get(`/api/v1/proposals/${id}`)
      .set(bearer(placement))
      .expect(200);
    expect(record.body.insurers.map((i: { overdue: boolean }) => i.overdue)).toEqual([
      true,
      false,
      false,
    ]);
    await respond(id, A().id, 'NO_RESPONSE').expect(200);
    const after = await request(app)
      .get(`/api/v1/proposals/${id}`)
      .set(bearer(placement))
      .expect(200);
    expect(after.body.insurers[0]).toMatchObject({ status: 'NO_RESPONSE', overdue: false });
  });

  it('refuses a reminder when mail is off', async () => {
    const id = await sentCase();
    const off = await request(offApp)
      .post(`/api/v1/proposals/${id}/insurers/${A().id}/reminder`)
      .set(bearer(placement))
      .send({ sendId: randomUUID(), to: ['rfq@insurer-a.example'], attachRfq: false })
      .expect(409);
    expect(off.body.code).toBe('MAIL_DISABLED');
  });
});
