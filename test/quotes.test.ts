import { OTHER_SECTIONS, RISK_DETAIL_FIELDS } from '../src/shared/index.ts';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLogModel } from '../src/modules/audit/audit.model.ts';
import { bearer, createTestApp, tokenFor, useTestDatabase } from './helpers/app.ts';
import { seedMasters } from './helpers/masters.ts';
import { approveRfq } from './helpers/rfq.ts';

// Insurers' quotes (Q-1 to Q-5): entry per insurer and option, terms and deviations, the
// insurer's mail as proof, revised versions, and declines left out of the QCR.

useTestDatabase();
const app = createTestApp();

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
const EML = Buffer.from(
  'From: uw@insurer.example\r\nTo: rfq@fiducial.example\r\nSubject: Quote PRP-2026-0001\r\n\r\nPlease find our quote.\r\n',
);

let admin: string;
let manager: string;
let caseId: string;
let notSentId: string;
const insurers: string[] = [];

beforeAll(async () => {
  await seedMasters();
  admin = (await tokenFor(app, ['ADMIN'])).token;
  manager = (await tokenFor(app, ['ACCOUNT_MANAGER'])).token;
  const client = await request(app)
    .post('/api/v1/clients')
    .set(bearer(admin))
    .send({
      name: 'Quote Test Mills',
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
  const clientId = client.body.id as string;
  const location = await request(app)
    .post(`/api/v1/clients/${clientId}/locations`)
    .set(bearer(admin))
    .send({
      name: 'Plant 1',
      line1: 'Plot 1',
      line2: null,
      city: 'Mumbai',
      pincode: '400001',
      occupancyCode: null,
    })
    .expect(201);
  for (const branch of ['Fort', 'Andheri', 'Thane']) {
    const insurer = await request(app)
      .post('/api/v1/insurers')
      .set(bearer(admin))
      .send({
        company: 'Test General',
        branch,
        contacts: [],
        rfqEmails: [`${branch.toLowerCase()}@insurer.example`],
      })
      .expect(201);
    insurers.push(insurer.body.id as string);
  }
  const created = await request(app)
    .post('/api/v1/proposals')
    .set(bearer(manager))
    .send({
      clientId,
      locationIds: [location.body.id],
      dueDate: '2026-12-01',
      policyStart: '2026-12-01',
      policyEnd: '2027-11-30',
    })
    .expect(201);
  caseId = created.body.id as string;
  await request(app)
    .put(`/api/v1/proposals/${caseId}/data-sheet`)
    .set(bearer(manager))
    .send({
      dueDate: '2026-12-01',
      policyStart: '2026-12-01',
      policyEnd: '2027-11-30',
      locations: [
        {
          locationId: location.body.id,
          fire: [{ key: 'STOCKS', sqFt: null, ratePerSqFt: null, amount: '50000000' }],
          hypothecation: null,
          openStock: null,
          risk: Object.fromEntries(RISK_DETAIL_FIELDS.map((field) => [field.key, 'Yes'])),
        },
      ],
      fireOption2: [{ group: 'STOCKS', amount: '60000000' }],
      fireCovers: [{ name: 'Earthquake', required: true }],
      sections: OTHER_SECTIONS.map((code) => ({
        code,
        included: code === 'MONEY',
        proposed1: code === 'MONEY' ? '500000' : null,
        proposed2: null,
      })),
      claims: [],
      notes: null,
    })
    .expect(200);
  await request(app)
    .put(`/api/v1/proposals/${caseId}/insurers`)
    .set(bearer(manager))
    .send({ insurerIds: insurers })
    .expect(200);
  // Fort and Andheri have the RFQ; Thane not yet.
  await approveRfq(app, caseId, manager, admin);
  await request(app)
    .post(`/api/v1/proposals/${caseId}/rfq/sent`)
    .set(bearer(manager))
    .send({ insurerIds: insurers.slice(0, 2) })
    .expect(200);
  notSentId = insurers[2] ?? '';
});

function upload(insurerId: string, file: Buffer, fileName: string, type = 'application/pdf') {
  return request(app)
    .post(
      `/api/v1/proposals/${caseId}/insurers/${insurerId}/quote-attachments?fileName=${encodeURIComponent(fileName)}`,
    )
    .set(bearer(manager))
    .set('Content-Type', type)
    .send(file);
}

function quote(insurerId: string, body: Record<string, unknown>) {
  return request(app)
    .post(`/api/v1/proposals/${caseId}/insurers/${insurerId}/quotes`)
    .set(bearer(manager))
    .send(body);
}

const fort = () => insurers[0] ?? '';
const andheri = () => insurers[1] ?? '';

const SECTIONS = [
  { code: 'FIRE', sumInsured: null, premium: '100000.50', premiumWithoutTerrorism: '90000' },
  { code: 'MONEY', sumInsured: null, premium: '2500' },
];

describe('Q-3: the insurer’s mail or PDF is kept as proof', () => {
  it('takes PDFs and mails only, and a quote needs one of its own insurer', async () => {
    const fake = await upload(fort(), Buffer.from('not a pdf'), 'quote.pdf');
    expect(fake.status).toBe(400);
    const pdf = await upload(fort(), PDF, 'Fort quote.pdf').expect(201);
    expect(pdf.body).toMatchObject({ fileName: 'Fort quote.pdf', contentType: 'application/pdf' });
    const mail = await upload(fort(), EML, 'Re RFQ.eml', 'application/octet-stream').expect(201);
    expect(mail.body.contentType).toBe('message/rfc822');

    const none = await quote(fort(), { option: 'P1', sections: SECTIONS, attachmentIds: [] });
    expect(none.status).toBe(400);
    expect(JSON.stringify(none.body.details)).toContain('Attach the insurer’s email or PDF');
    const otherInsurer = await quote(andheri(), {
      option: 'P1',
      sections: SECTIONS,
      attachmentIds: [pdf.body.id],
    });
    expect(otherInsurer.status).toBe(400);

    const download = await request(app)
      .get(`/api/v1/proposals/${caseId}/quote-attachments/${pdf.body.id as string}`)
      .set(bearer(manager))
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(Buffer.compare(download.body as Buffer, PDF)).toBe(0);
  });
});

describe('Q-1, Q-2: a quote per insurer per option, its totals and deviations', () => {
  it('works out net, 18% GST and total, with and without terrorism', async () => {
    const pdf = await upload(fort(), PDF, 'Fort quote.pdf').expect(201);
    const saved = await quote(fort(), {
      option: 'P1',
      sections: SECTIONS,
      terms: [{ name: 'Fire: Earthquake', accepted: true }],
      deductibles: '5% of claim, minimum ₹25,000',
      capacityPercent: '100',
      conditions: 'Warranted: fire extinguishers maintained',
      validUntil: '2026-12-31',
      attachmentIds: [pdf.body.id],
    }).expect(201);
    expect(saved.body.options).toEqual(['P1', 'P2']);
    const fortQuotes = saved.body.insurers[0];
    expect(fortQuotes.status).toBe('QUOTED');
    const latest = fortQuotes.quotes[0].versions[0];
    expect(latest).toMatchObject({
      option: 'P1',
      version: 1,
      gstRatePercent: '18',
      totals: {
        withTerrorism: { net: '102500.50', gst: '18450.09', total: '120950.59' },
        withoutTerrorism: { net: '92500.00', gst: '16650.00', total: '109150.00' },
      },
      deviations: [],
      attachments: [{ fileName: 'Fort quote.pdf' }],
    });
    const audit = await AuditLogModel.findOne({ action: 'QUOTE_RECORDED' }).lean();
    expect(audit?.after).toMatchObject({ version: 1, net: '102500.50', total: '120950.59' });
  });

  it('flags where the insurer departs from the RFQ', async () => {
    const pdf = await upload(andheri(), PDF, 'Andheri.pdf').expect(201);
    const saved = await quote(andheri(), {
      option: 'P2',
      sections: [{ code: 'FIRE', sumInsured: '55000000', premium: '110000' }],
      terms: [{ name: 'Fire: Earthquake', accepted: false }],
      capacityPercent: '60',
      validUntil: '2026-11-15',
      attachmentIds: [pdf.body.id],
    }).expect(201);
    expect(saved.body.insurers[1].quotes[1].versions[0].deviations).toEqual([
      'Fire: quoted on ₹5,50,00,000, the RFQ asked ₹6,00,00,000',
      'Money: not quoted',
      'Declined: Fire: Earthquake',
      'Capacity 60%: not the whole risk',
      'Valid until 15 Nov 2026, before the policy starts on 01 Dec 2026',
    ]);
  });

  it('takes only the options and sections the RFQ asked for, from insurers that have it', async () => {
    const pdf = await upload(fort(), PDF, 'q.pdf').expect(201);
    const body = { sections: SECTIONS, attachmentIds: [pdf.body.id] };
    await quote(fort(), { ...body, option: 'EXISTING' }).expect(400);
    await quote(fort(), {
      ...body,
      option: 'P1',
      reason: 'x',
      sections: [{ code: 'EEI', sumInsured: null, premium: '100' }],
    }).expect(400);
    const notSent = await quote(notSentId, { ...body, option: 'P1' });
    expect(notSent.status).toBe(409);
  });
});

describe('Q-4: revised versions keep history; the QCR takes the latest', () => {
  it('needs the reason, and the QCR moves to the new version', async () => {
    const pdf = await upload(fort(), PDF, 'Fort revised.pdf').expect(201);
    const body = { option: 'P1', sections: SECTIONS, attachmentIds: [pdf.body.id] };
    const bare = await quote(fort(), body);
    expect(bare.status).toBe(400);
    expect(JSON.stringify(bare.body.details)).toContain('Say why the quote was revised');
    const revised = await quote(fort(), { ...body, reason: 'Discount on renewal' }).expect(201);
    const versions = revised.body.insurers[0].quotes[0].versions;
    expect(versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect(versions[0].reason).toBe('Discount on renewal');
    expect(revised.body.qcr).toContainEqual(
      expect.objectContaining({ insurerId: fort(), option: 'P1', version: 2 }),
    );
  });
});

describe('Q-5: a declined insurer, with its reason, is left out of the QCR', () => {
  it('needs the reason', async () => {
    const path = `/api/v1/proposals/${caseId}/insurers/${andheri()}/response`;
    const before = await request(app)
      .get(`/api/v1/proposals/${caseId}/quotes`)
      .set(bearer(manager))
      .expect(200);
    expect(before.body.qcr.map((q: { insurerId: string }) => q.insurerId)).toContain(andheri());

    const bare = await request(app).put(path).set(bearer(manager)).send({ status: 'DECLINED' });
    expect(bare.status).toBe(400);
    await request(app)
      .put(path)
      .set(bearer(manager))
      .send({ status: 'DECLINED', note: 'Outside appetite for textiles' })
      .expect(200);
    const after = await request(app)
      .get(`/api/v1/proposals/${caseId}/quotes`)
      .set(bearer(manager))
      .expect(200);
    expect(after.body.qcr.map((q: { insurerId: string }) => q.insurerId)).not.toContain(andheri());
    expect(after.body.insurers[1].declined).toMatchObject({
      reason: 'Outside appetite for textiles',
    });
    // Its quotes stay on record.
    expect(after.body.insurers[1].quotes[1].versions).toHaveLength(1);
  });
});
