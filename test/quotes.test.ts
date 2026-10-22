import { OTHER_SECTIONS, RISK_DETAIL_FIELDS } from '../src/shared/index.ts';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLogModel } from '../src/modules/audit/audit.model.ts';
import { createLogger } from '../src/lib/logger.ts';
import {
  geminiQuoteReader,
  type GeminiAnswer,
  type GeminiRequest,
} from '../src/modules/quotes/gemini-quote-reader.ts';
import { bearer, createTestApp, tokenFor, useTestDatabase } from './helpers/app.ts';
import { seedMasters } from './helpers/masters.ts';
import { SYNTHETIC_QUOTE_ROWS, textPdf } from './helpers/quote-pdf.ts';
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

describe('Q1: reading a quote PDF to pre-fill the form', () => {
  const read = (attachmentId: string, token = manager) =>
    request(app)
      .post(`/api/v1/proposals/${caseId}/quote-attachments/${attachmentId}/read`)
      .set(bearer(token));

  it('returns candidate values with their source lines, saves nothing, and audits without the text', async () => {
    const before = await request(app)
      .get(`/api/v1/proposals/${caseId}/quotes`)
      .set(bearer(manager))
      .expect(200);
    const pdf = await upload(fort(), await textPdf(SYNTHETIC_QUOTE_ROWS), 'Fort quote.pdf').expect(
      201,
    );
    const response = await read(pdf.body.id as string).expect(200);
    expect(response.body).toMatchObject({
      source: 'PDF_TEXT',
      attachmentId: pdf.body.id,
      manualEntryRequired: false,
      netPremium: { value: '102500.50', state: 'HIGH' },
      totalPremium: { value: '120950.59' },
      gstRatePercent: { value: '18' },
      validUntil: { value: '2026-12-31' },
      discrepancies: [],
    });
    const money = response.body.sections.find(
      (section: { code: string }) => section.code === 'MONEY',
    );
    // The line holds the sum insured and the premium: the last is taken, marked for a closer look.
    expect(money.premium).toMatchObject({ value: '2500.00', state: 'LOW' });
    expect(money.premium.raw).toContain('Money in Transit');

    // Reading saved no quote and changed nothing.
    const after = await request(app)
      .get(`/api/v1/proposals/${caseId}/quotes`)
      .set(bearer(manager))
      .expect(200);
    expect(after.body.insurers.map((item: { quotes: unknown }) => item.quotes)).toEqual(
      before.body.insurers.map((item: { quotes: unknown }) => item.quotes),
    );
    const entry = await AuditLogModel.findOne({
      action: 'QUOTE_PDF_READ',
      'after.attachmentId': pdf.body.id,
    }).lean();
    expect(entry?.after).toMatchObject({ source: 'PDF_TEXT', sectionsRead: 2 });
    expect(JSON.stringify(entry)).not.toContain('120950');
  });

  it('asks for manual entry for a mail, needs proposals.edit and the right case', async () => {
    const mail = await upload(fort(), EML, 'Re RFQ.eml', 'application/octet-stream').expect(201);
    const response = await read(mail.body.id as string).expect(200);
    expect(response.body).toMatchObject({ source: 'NONE', manualEntryRequired: true });
    const viewer = (await tokenFor(app, ['MANAGER'])).token;
    await read(mail.body.id as string, viewer).expect(403);
    await request(app)
      .post(`/api/v1/proposals/${caseId}/quote-attachments/${'f'.repeat(24)}/read`)
      .set(bearer(manager))
      .expect(404);
  });
});

describe('Q1 with OCR_PROVIDER=gemini (a fake Gemini: nothing leaves the machine)', () => {
  // Gemini's answer for the synthetic quote, each value with its line as the excerpt.
  const fact = (value: string | null, evidence: string | null = value) => ({
    status: value === null ? 'NOT_FOUND' : 'FOUND',
    value,
    page: value === null ? null : 1,
    evidence,
  });
  const ANSWER = {
    insurerName: fact('Fiducial Test Insurance Co. Ltd.'),
    insuredName: fact(null),
    quoteReference: fact('FTI/2026/0457', 'Quotation No: FTI/2026/0457'),
    validUntil: fact('31/12/2026', 'This quotation is valid till 31/12/2026'),
    sections: [
      {
        section: 'FIRE',
        premium: fact(
          '1,00,000.50',
          'Fire and Special Perils (with terrorism) 6,00,00,000 1,00,000.50',
        ),
        premiumWithoutTerrorism: fact(
          '90,000.00',
          'Fire and Special Perils (without terrorism) 6,00,00,000 90,000.00',
        ),
      },
      {
        section: 'MONEY',
        premium: fact('2,500.00', 'Money in Transit 5,00,000 2,500.00'),
        premiumWithoutTerrorism: fact(null),
      },
    ],
    netPremium: fact('1,02,500.50', 'Net Premium (before GST) 1,02,500.50'),
    gstRatePercent: fact('18%', 'GST @ 18% 18,450.09'),
    gstAmount: fact('18,450.09', 'GST @ 18% 18,450.09'),
    gstParts: [],
    totalPremium: fact('1,20,950.59', 'Total Premium payable 1,20,950.59'),
    issues: [],
  };
  const requests: GeminiRequest[] = [];
  let next: () => Promise<GeminiAnswer> = () =>
    Promise.resolve({ text: JSON.stringify(ANSWER), finishReason: 'STOP' });
  const geminiApp = createTestApp({}, undefined, undefined, {
    ...geminiQuoteReader({
      model: 'gemini-test-model',
      logger: createLogger({ level: 'silent' }),
      retryDelaysMs: [0, 0],
      generate: (request) => {
        requests.push(request);
        return next();
      },
    }),
  });
  const read = (attachmentId: string, token = manager, target = caseId) =>
    request(geminiApp)
      .post(`/api/v1/proposals/${target}/quote-attachments/${attachmentId}/read`)
      .set(bearer(token));
  const snapshot = async () => ({
    quotes: (await request(app).get(`/api/v1/proposals/${caseId}/quotes`).set(bearer(manager)))
      .body as {
      insurers: Array<{ status: string; quotes: Array<{ option: string; versions: unknown[] }> }>;
    },
    stage: (await request(app).get(`/api/v1/proposals/${caseId}`).set(bearer(manager))).body
      .stage as string,
  });

  it('returns Gemini’s candidates for review, saves and approves nothing, and audits the external read', async () => {
    const pdf = await upload(fort(), await textPdf(SYNTHETIC_QUOTE_ROWS), 'Fort gemini.pdf').expect(
      201,
    );
    const before = await snapshot();
    requests.length = 0;
    const response = await read(pdf.body.id as string).expect(200);
    expect(requests).toHaveLength(1);
    expect(response.body).toMatchObject({
      reader: 'GEMINI',
      source: 'PDF_TEXT',
      attachmentId: pdf.body.id,
      manualEntryRequired: false,
      insurerName: { value: 'Fiducial Test Insurance Co. Ltd.', state: 'HIGH' },
      netPremium: { value: '102500.50', state: 'HIGH' },
      totalPremium: { value: '120950.59', state: 'HIGH' },
      validUntil: { value: '2026-12-31' },
      discrepancies: [],
    });
    // Nothing recorded, no insurer moved, no stage changed: the staff still review and save.
    expect(await snapshot()).toEqual(before);
    const entry = await AuditLogModel.findOne({
      action: 'QUOTE_PDF_READ',
      'after.attachmentId': pdf.body.id,
    }).lean();
    expect(entry?.after).toMatchObject({
      reader: 'GEMINI',
      outcome: 'READ',
      source: 'PDF_TEXT',
      sentExternally: true,
      sectionsRead: 2,
    });
    expect(JSON.stringify(entry)).not.toMatch(/120950|1,20,950|Fiducial Test Insurance/);
  });

  it('sends nothing to Gemini without proposals.edit, sign-in, or for another case’s file', async () => {
    const pdf = await upload(fort(), await textPdf(SYNTHETIC_QUOTE_ROWS), 'Fort auth.pdf').expect(
      201,
    );
    requests.length = 0;
    const viewer = (await tokenFor(app, ['MANAGER'])).token;
    await read(pdf.body.id as string, viewer).expect(403);
    await request(geminiApp)
      .post(`/api/v1/proposals/${caseId}/quote-attachments/${pdf.body.id as string}/read`)
      .expect(401);
    await read('f'.repeat(24)).expect(404);
    await read(pdf.body.id as string, manager, 'e'.repeat(24)).expect(404);
    expect(requests).toHaveLength(0);
  });

  it('does not send a mail to Gemini', async () => {
    const mail = await upload(fort(), EML, 'Gemini RFQ.eml', 'application/octet-stream').expect(
      201,
    );
    requests.length = 0;
    const response = await read(mail.body.id as string).expect(200);
    expect(response.body).toMatchObject({
      reader: 'GEMINI',
      source: 'NONE',
      manualEntryRequired: true,
    });
    expect(requests).toHaveLength(0);
    const entry = await AuditLogModel.findOne({
      action: 'QUOTE_PDF_READ',
      'after.attachmentId': mail.body.id,
    }).lean();
    expect(entry?.after).toMatchObject({ reader: 'GEMINI', sentExternally: false });
  });

  it('on failure keeps the file, says why, audits it, and lets the staff retry; a quote is still recorded once', async () => {
    const pdf = await upload(fort(), await textPdf(SYNTHETIC_QUOTE_ROWS), 'Fort retry.pdf').expect(
      201,
    );
    const attachmentId = pdf.body.id as string;
    const before = await snapshot();
    next = () => Promise.resolve({ text: '{"broken": ', finishReason: 'STOP' });
    const failed = await read(attachmentId).expect(503);
    expect(failed.body).toEqual({
      code: 'UPSTREAM_UNAVAILABLE',
      message:
        'The reading service (Gemini) gave an answer that could not be used. Try again, or enter the figures by hand.',
      details: { reader: 'GEMINI', reason: 'MALFORMED' },
    });
    const audit = await AuditLogModel.findOne({
      action: 'QUOTE_PDF_READ',
      'after.attachmentId': attachmentId,
      'after.outcome': 'FAILED',
    }).lean();
    expect(audit?.after).toMatchObject({
      reader: 'GEMINI',
      reason: 'MALFORMED',
      sentExternally: true,
    });
    // The file is kept, unchanged.
    const download = await request(app)
      .get(`/api/v1/proposals/${caseId}/quote-attachments/${attachmentId}`)
      .set(bearer(manager))
      .expect(200);
    expect(download.headers['content-type']).toBe('application/pdf');

    // The retry works, and reading twice records nothing.
    next = () => Promise.resolve({ text: JSON.stringify(ANSWER), finishReason: 'STOP' });
    const extraction = (await read(attachmentId).expect(200)).body as {
      netPremium: { value: string };
      sections: Array<{ code: string; premium: { value: string } }>;
    };
    await read(attachmentId).expect(200);
    expect(await snapshot()).toEqual(before);

    // The staff save through the usual quote route: exactly one new version.
    const versions = (body: Awaited<ReturnType<typeof snapshot>>) =>
      body.quotes.insurers[0]!.quotes.find((item) => item.option === 'P1')?.versions.length ?? 0;
    await quote(fort(), {
      option: 'P1',
      reason: 'Insurer’s revised PDF, read by Gemini and checked',
      sections: [
        {
          code: 'FIRE',
          sumInsured: null,
          premium: '100000.50',
          premiumWithoutTerrorism: '90000.00',
        },
        {
          code: 'MONEY',
          sumInsured: null,
          premium: extraction.sections.find((item) => item.code === 'MONEY')!.premium.value,
        },
      ],
      attachmentIds: [attachmentId],
    }).expect(201);
    expect(versions(await snapshot())).toBe(versions(before) + 1);
  });

  it('keeps the built-in reader (nothing sent anywhere) when OCR_PROVIDER is unset', async () => {
    const pdf = await upload(
      fort(),
      await textPdf(SYNTHETIC_QUOTE_ROWS),
      'Fort builtin.pdf',
    ).expect(201);
    requests.length = 0;
    const response = await request(app)
      .post(`/api/v1/proposals/${caseId}/quote-attachments/${pdf.body.id as string}/read`)
      .set(bearer(manager))
      .expect(200);
    expect(response.body).toMatchObject({ reader: 'BUILT_IN', source: 'PDF_TEXT' });
    expect(requests).toHaveLength(0);
    const entry = await AuditLogModel.findOne({
      action: 'QUOTE_PDF_READ',
      'after.attachmentId': pdf.body.id,
    }).lean();
    expect(entry?.after).toMatchObject({ reader: 'BUILT_IN', sentExternally: false });
  });
});
