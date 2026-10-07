import { OTHER_SECTIONS, RISK_DETAIL_FIELDS, XLSX_CONTENT_TYPE } from '../src/shared/index.ts';
import ExcelJS from 'exceljs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLogModel } from '../src/modules/audit/audit.model.ts';
import { bearer, createTestApp, tokenFor, useTestDatabase } from './helpers/app.ts';
import { seedMasters } from './helpers/masters.ts';

// The RFQ as a document (R-1, R-2, R-5): generated from the case, previewed and edited, saved as
// v1, v2, v3, and approved before it can be sent.

useTestDatabase();
const app = createTestApp();

const CLIENT_RFQ = readFileSync(
  fileURLToPath(new URL('../data/client-formats/Fiducial_RFQ format.xlsx', import.meta.url)),
);

let admin: string;
let manager: string;
let approver: string;
let caseId: string;
let insurerId: string;
const locations: string[] = [];

const binary = (req: request.Test) =>
  req.buffer(true).parse((res, done) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('end', () => done(null, Buffer.concat(chunks)));
  });

const path = (suffix = '') => `/api/v1/proposals/${caseId}/rfq${suffix}`;
const state = async () =>
  (await request(app).get(path('/versions')).set(bearer(manager)).expect(200)).body;
const step = (version: number, action: string, token: string, body: object = {}) =>
  request(app)
    .post(path(`/versions/${version}/${action}`))
    .set(bearer(token))
    .send(body);

function dataSheet(complete: boolean) {
  return {
    dueDate: '2026-12-01',
    policyStart: '2026-12-01',
    policyEnd: '2027-11-30',
    locations: locations.map((locationId, index) => ({
      locationId,
      fire: complete
        ? [{ key: 'STOCKS', sqFt: null, ratePerSqFt: null, amount: String((index + 1) * 10000000) }]
        : [],
      hypothecation: index === 0 ? 'State Bank of India, Fort branch' : null,
      openStock: index === 1 ? 'Bales in the yard, up to 20 L' : null,
      risk: Object.fromEntries(
        RISK_DETAIL_FIELDS.map((field) => [field.key, `${field.label} answer`]),
      ),
    })),
    fireOption2: [],
    sections: OTHER_SECTIONS.map((code) => ({
      code,
      included: false,
      proposed1: null,
      proposed2: null,
    })),
    claims: [
      {
        period: '2024-25',
        policyType: 'SFSP',
        sumInsured: '30000000',
        premium: '24000',
        claimedAmount: '0',
        remarks: 'No claim',
        insurer: 'Example General',
      },
    ],
    notes: 'Please quote with and without terrorism.',
  };
}

beforeAll(async () => {
  await seedMasters();
  admin = (await tokenFor(app, ['ADMIN'])).token;
  manager = (await tokenFor(app, ['ACCOUNT_MANAGER'])).token;
  approver = (await tokenFor(app, ['MANAGER'])).token;
  const client = await request(app)
    .post('/api/v1/clients')
    .set(bearer(admin))
    .send({
      name: 'Versions Test Mills',
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
  for (const name of ['Plant 1', 'Plant 2']) {
    const location = await request(app)
      .post(`/api/v1/clients/${client.body.id as string}/locations`)
      .set(bearer(admin))
      .send({
        name,
        line1: 'Plot 1',
        line2: null,
        city: 'Mumbai',
        pincode: '400001',
        occupancyCode: null,
      })
      .expect(201);
    locations.push(location.body.id as string);
  }
  const insurer = await request(app)
    .post('/api/v1/insurers')
    .set(bearer(admin))
    .send({
      company: 'Test General',
      branch: 'Fort',
      contacts: [],
      rfqEmails: ['fort@insurer.example'],
    })
    .expect(201);
  insurerId = insurer.body.id as string;
  const created = await request(app)
    .post('/api/v1/proposals')
    .set(bearer(manager))
    .send({
      clientId: client.body.id,
      locationIds: locations,
      dueDate: '2026-12-01',
      policyStart: '2026-12-01',
      policyEnd: '2027-11-30',
    })
    .expect(201);
  caseId = created.body.id as string;
  await request(app)
    .put(`/api/v1/proposals/${caseId}/insurers`)
    .set(bearer(manager))
    .send({ insurerIds: [insurerId] })
    .expect(200);
  await request(app)
    .post('/api/v1/templates/RFQ?fileName=Fiducial_RFQ%20format.xlsx')
    .set(bearer(admin))
    .set('Content-Type', XLSX_CONTENT_TYPE)
    .send(CLIENT_RFQ)
    .expect(200);
});

async function workbookOf(version: number) {
  const file = await binary(
    request(app)
      .get(path(`/versions/${version}/file?format=xlsx`))
      .set(bearer(manager)),
  ).expect(200);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(file.body as ArrayBuffer);
  return workbook;
}

describe('R-1: the RFQ is generated from the case', () => {
  it('needs a complete Data Sheet, and prints every Data Sheet field without retyping', async () => {
    await request(app)
      .put(`/api/v1/proposals/${caseId}/data-sheet`)
      .set(bearer(manager))
      .send(dataSheet(false))
      .expect(200);
    const incomplete = await request(app).post(path('/versions')).set(bearer(manager)).expect(409);
    expect(incomplete.body.code).toBe('DATA_SHEET_INCOMPLETE');

    await request(app)
      .put(`/api/v1/proposals/${caseId}/data-sheet`)
      .set(bearer(manager))
      .send(dataSheet(true))
      .expect(200);
    const generated = await request(app).post(path('/versions')).set(bearer(manager)).expect(201);
    expect(generated.body).toMatchObject({
      current: { version: 1, status: 'DRAFT', stale: false },
      sendable: false,
      blocked: 'RFQ v1 is draft: it must be approved before it is sent.',
    });
    expect(generated.body.versions[0]).toMatchObject({
      version: 1,
      layout: 'template',
      fileName: expect.stringMatching(/^RFQ-PRP-\d{4}-\d{4}-v1$/) as string,
      events: [{ action: 'GENERATED', comment: null }],
    });

    const workbook = await workbookOf(1);
    const schedule = workbook.getWorksheet('schedule')!;
    const texts: string[] = [];
    schedule.eachRow((row) => row.eachCell((cell) => texts.push(cell.text)));
    // Each location's sum insured, hypothecation, stock in the open and the notes for insurers.
    expect(texts.join('\n')).toContain(
      'Plant 1: Plot 1, Mumbai, Mumbai 400001 — Fire sum insured ₹1,00,00,000',
    );
    expect(texts).toContain('Hypothecation (Plant 1): State Bank of India, Fort branch');
    expect(texts).toContain('Stock kept at open space (Plant 2): Bales in the yard, up to 20 L');
    expect(texts).toContain('Notes for the insurers: Please quote with and without terrorism.');
    expect(workbook.getWorksheet('risk details')!.getCell('D3').value).toBe(
      'Fire fighting arrangement answer',
    );
    expect(workbook.getWorksheet('claim details')!.getCell('A3').value).toBe('2024-25');

    const pdf = await binary(
      request(app).get(path('/versions/1/file?format=pdf')).set(bearer(manager)),
    ).expect(200);
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
  });
});

describe('R-2: preview with edits, and a version per generation', () => {
  it('keeps the edits on the RFQ only, and each generation as the next version', async () => {
    const edits = {
      title: 'RFQ FOR NEW BUSINESS 2026-27 (REVISED)',
      notes: 'Quote by 1 December, please.',
      risk: [
        { locationId: locations[0], key: 'fireFighting', value: 'Hydrant system and sprinklers' },
      ],
      claims: [],
    };
    const saved = await request(app)
      .put(path('/edits'))
      .set(bearer(manager))
      .send(edits)
      .expect(200);
    expect(saved.body.edits).toEqual(edits);
    // v1 no longer matches what the RFQ would print.
    expect(saved.body.current).toEqual({ version: 1, status: 'DRAFT', stale: true });

    const v2 = await request(app).post(path('/versions')).set(bearer(manager)).expect(201);
    expect(v2.body.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    const workbook = await workbookOf(2);
    expect(workbook.getWorksheet('premium details')!.getCell('A1').value).toBe(edits.title);
    expect(workbook.getWorksheet('risk details')!.getCell('D3').value).toBe(
      'Hydrant system and sprinklers',
    );
    expect(workbook.getWorksheet('risk details')!.getCell('E3').value).toBe(
      'Fire fighting arrangement answer',
    );
    expect(workbook.getWorksheet('claim details')!.getCell('A3').value).toBe('No claims reported');

    // v1 is kept as it was generated: its case and edits, for its preview.
    const v1 = await request(app).get(path('/versions/1')).set(bearer(manager)).expect(200);
    expect(v1.body.edits.title).toBeNull();
    expect(v1.body.record.notes).toBe('Please quote with and without terrorism.');
    expect((await workbookOf(1)).getWorksheet('premium details')!.getCell('A1').value).toBe(
      'RFQ FOR NEW BUSINESS 2026-27',
    );
    // The Data Sheet itself is untouched.
    const record = await request(app)
      .get(`/api/v1/proposals/${caseId}`)
      .set(bearer(manager))
      .expect(200);
    expect(record.body.notes).toBe('Please quote with and without terrorism.');
  });
});

describe('R-5: submit, approve or return; only an approved RFQ is sent', () => {
  it('moves the latest version through approval, and gates sending on it', async () => {
    const markSent = () =>
      request(app)
        .post(`/api/v1/proposals/${caseId}/rfq/sent`)
        .set(bearer(manager))
        .send({ insurerIds: [insurerId] });
    expect((await markSent().expect(409)).body.code).toBe('RFQ_NOT_APPROVED');

    // Only the latest version moves on; an approver approves or returns.
    await step(1, 'submit', manager).expect(409);
    await step(2, 'approve', approver).expect(409);
    await step(2, 'submit', manager, { comment: 'Ready for review' }).expect(200);
    await step(2, 'approve', manager).expect(403);
    await step(2, 'return', approver).expect(400);
    const returned = await step(2, 'return', approver, {
      comment: 'Add the hydrant details',
    }).expect(200);
    expect(returned.body.current.status).toBe('RETURNED');
    expect(
      returned.body.versions[0].events.map((e: { action: string; comment: string | null }) => [
        e.action,
        e.comment,
      ]),
    ).toEqual([
      ['GENERATED', null],
      ['SUBMITTED', 'Ready for review'],
      ['RETURNED', 'Add the hydrant details'],
    ]);
    await step(2, 'submit', manager).expect(409);
    expect((await markSent().expect(409)).body.message).toMatch(/v2 is returned/);

    await request(app).post(path('/versions')).set(bearer(manager)).expect(201);
    await step(3, 'submit', manager).expect(200);
    const approved = await step(3, 'approve', approver, { comment: 'OK to send' }).expect(200);
    expect(approved.body).toMatchObject({
      current: { version: 3, status: 'APPROVED' },
      sendable: true,
      blocked: null,
    });
    expect(await AuditLogModel.countDocuments({ action: 'RFQ_APPROVED', entityId: caseId })).toBe(
      1,
    );

    // A change after approval needs a new version before anything more is sent.
    await request(app)
      .put(path('/edits'))
      .set(bearer(manager))
      .send({ title: 'Changed', notes: null, risk: [], claims: null })
      .expect(200);
    const changed = await state();
    expect(changed).toMatchObject({ current: { version: 3, stale: true }, sendable: false });
    expect((await markSent().expect(409)).body.message).toMatch(/changed since v3 was generated/);
    await request(app)
      .put(path('/edits'))
      .set(bearer(manager))
      .send({
        title: 'RFQ FOR NEW BUSINESS 2026-27 (REVISED)',
        notes: 'Quote by 1 December, please.',
        risk: [
          { locationId: locations[0], key: 'fireFighting', value: 'Hydrant system and sprinklers' },
        ],
        claims: [],
      })
      .expect(200);
    expect((await state()).sendable).toBe(true);
    const sent = await markSent().expect(200);
    expect(sent.body.insurers[0].status).toBe('SENT');
  });
});
