import { RISK_DETAIL_FIELDS } from '../src/shared/index.ts';
import ExcelJS from 'exceljs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLogModel } from '../src/modules/audit/audit.model.ts';
import {
  httpExistingPolicySource,
  type ExistingPolicyResult,
  type ExistingPolicySource,
} from '../src/modules/proposals/existing-policy-source.ts';
import { bearer, createTestApp, tokenFor, useTestDatabase } from './helpers/app.ts';
import { seedMasters } from './helpers/masters.ts';

useTestDatabase();

/** The policy software, faked: answers per GSTIN, and counts the questions. */
const answers = new Map<string, ExistingPolicyResult>();
const fakeSource: ExistingPolicySource = {
  latest: ({ gstin }) =>
    Promise.resolve(
      answers.get(gstin ?? '') ?? {
        status: 'NOT_FOUND',
        message: 'PolicyDesk has no policy for this client.',
      },
    ),
};
const app = createTestApp({}, fakeSource);
const unconfigured = createTestApp();

const GSTIN = '27AAPFU0939F1ZV';
const LAST_YEAR: ExistingPolicyResult = {
  status: 'FOUND',
  policy: {
    source: 'PolicyDesk',
    insurer: 'Example General Insurance, Fort',
    policyNumber: 'EGI/FIRE/2025/0042',
    product: 'BLUS',
    periodStart: '2025-11-01',
    periodEnd: '2026-10-31',
    sections: [
      { code: 'FIRE', sumInsured: '120000000', premium: '96000' },
      { code: 'BURGLARY', sumInsured: '15000000', premium: '4500' },
      { code: 'MONEY', sumInsured: '200000', premium: '800' },
    ],
    fireLines: [
      { group: 'BUILDING', sumInsured: '70000000' },
      { group: 'STOCKS', sumInsured: '50000000' },
    ],
    totalSumInsured: '135200000',
    netPremium: '101300',
    gst: '18234',
    totalPremium: '119534',
  },
};

let admin: string;
let manager: string;
let placement: string;
let placementId: string;
let readOnlyId: string;
let clientId: string;
let locationId: string;

beforeAll(async () => {
  await seedMasters();
  admin = (await tokenFor(app, ['ADMIN'])).token;
  manager = (await tokenFor(app, ['ACCOUNT_MANAGER'])).token;
  const exec = await tokenFor(app, ['PLACEMENT_EXEC']);
  placement = exec.token;
  placementId = exec.user.id;
  readOnlyId = (await tokenFor(app, ['READ_ONLY'])).user.id;
  const client = await request(app)
    .post('/api/v1/clients')
    .set(bearer(admin))
    .send({
      name: 'Renewal Test Mills',
      gstin: GSTIN,
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
      name: 'Plant 1',
      line1: 'Plot 1',
      line2: null,
      city: 'Mumbai',
      pincode: '400001',
      occupancyCode: null,
    })
    .expect(201);
  locationId = location.body.id as string;
});

function createCase(body: Record<string, unknown>, token = manager, target = app) {
  return request(target)
    .post('/api/v1/proposals')
    .set(bearer(token))
    .send({ clientId, locationIds: [locationId], dueDate: '2026-10-20', ...body });
}

describe('D-1: creating a case', () => {
  it('numbers it, assigns staff and the policy period, and starts at stage 1 (Draft)', async () => {
    const created = await createCase({
      type: 'NEW',
      ownerId: placementId,
      policyStart: '2026-11-01',
      policyEnd: '2027-10-31',
    }).expect(201);
    expect(created.body).toMatchObject({
      type: 'NEW',
      stage: 'DRAFT',
      nextStage: null,
      owner: { id: placementId },
      policyStart: '2026-11-01',
      policyEnd: '2027-10-31',
      existingPolicy: null,
    });
    expect(created.body.reference).toMatch(/^PRP-\d{4}-\d{4}$/);
    const list = await request(app)
      .get('/api/v1/proposals?type=NEW&stage=DRAFT')
      .set(bearer(manager))
      .expect(200);
    expect(list.body.items.map((p: { id: string }) => p.id)).toContain(created.body.id);
  });

  it('only assigns active staff who can edit proposals, and checks the period', async () => {
    await createCase({ ownerId: readOnlyId }).expect(400);
    const backwards = await createCase({
      policyStart: '2026-11-01',
      policyEnd: '2026-10-01',
    }).expect(400);
    expect(JSON.stringify(backwards.body.details)).toContain(
      'The policy period must end after it starts',
    );
    await createCase({ type: 'EXISTING', policyStart: '2026-11-01' }).expect(400);
    const owners = await request(app)
      .get('/api/v1/proposals/owners')
      .set(bearer(manager))
      .expect(200);
    const ids = owners.body.items.map((o: { id: string }) => o.id);
    expect(ids).toContain(placementId);
    expect(ids).not.toContain(readOnlyId);
  });
});

describe('D-2: renewals', () => {
  it('opens pre-filled with last year’s policy from the policy software', async () => {
    answers.set(GSTIN, LAST_YEAR);
    const preview = await request(app)
      .get(`/api/v1/proposals/last-policy?clientId=${clientId}`)
      .set(bearer(manager))
      .expect(200);
    expect(preview.body).toMatchObject({
      status: 'FOUND',
      policy: { policyNumber: 'EGI/FIRE/2025/0042' },
    });

    const renewal = await createCase({
      type: 'EXISTING',
      policyStart: '2026-11-01',
      policyEnd: '2027-10-31',
    }).expect(201);
    expect(renewal.body.existingPolicy).toMatchObject({
      source: 'PolicyDesk',
      insurer: 'Example General Insurance, Fort',
      policyNumber: 'EGI/FIRE/2025/0042',
      totalPremium: '119534',
      sections: [
        { code: 'FIRE', sumInsured: '120000000', premium: '96000' },
        { code: 'BURGLARY', sumInsured: '15000000', premium: '4500' },
        { code: 'MONEY', sumInsured: '200000', premium: '800' },
      ],
    });
    expect(renewal.body.existingPolicyLookup.status).toBe('FOUND');
    // Last year's sections start the renewal: included, with last year's sum insured.
    const included = renewal.body.sections.filter((s: { included: boolean }) => s.included);
    expect(included.map((s: { code: string; proposed1: string }) => [s.code, s.proposed1])).toEqual(
      [
        ['BURGLARY', '15000000'],
        ['MONEY', '200000'],
      ],
    );
    expect(renewal.body.activity[0].message).toContain('EGI/FIRE/2025/0042');

    // The RFQ shows the Existing column.
    await request(app)
      .put(`/api/v1/proposals/${renewal.body.id as string}/data-sheet`)
      .set(bearer(manager))
      .send({
        dueDate: '2026-10-20',
        policyStart: '2026-11-01',
        policyEnd: '2027-10-31',
        locations: [
          {
            locationId,
            fire: [{ key: 'STOCKS', sqFt: null, ratePerSqFt: null, amount: '130000000' }],
            hypothecation: null,
            openStock: null,
            risk: Object.fromEntries(RISK_DETAIL_FIELDS.map((f) => [f.key, null])),
          },
        ],
        fireOption2: [],
        sections: [
          { code: 'BURGLARY', included: true, proposed1: '16000000', proposed2: null },
          { code: 'MONEY', included: true, proposed1: '200000', proposed2: null },
        ],
        claims: [],
        notes: null,
      })
      .expect(200);
    const file = await request(app)
      .get(`/api/v1/proposals/${renewal.body.id as string}/rfq`)
      .set(bearer(manager))
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file.body as never);
    const rows = workbook
      .getWorksheet('schedule')!
      .getSheetValues()
      .flatMap((row) => (Array.isArray(row) ? [row.slice(1, 6)] : []));
    expect(rows[0]).toEqual(['Policy No: EGI/FIRE/2025/0042']);
    expect(rows).toContainEqual([
      'S No',
      'Description',
      'Existing Sum Insured',
      'Proposed Sum Insured - Option 1',
      'Proposed Sum Insured - Option 2',
    ]);
    expect(
      rows.find((row) => row[1] === 'Total Sum Insured - Fire & Allied Perils')?.slice(2, 4),
    ).toEqual([120000000, 130000000]);
    expect(rows.find((row) => row[0] === 6)?.slice(2, 4)).toEqual([50000000, 130000000]);
    expect(workbook.getWorksheet('premium details')!.getRow(1).getCell(1).value).toBe(
      'RFQ FOR RENEWAL — PROPERTY INSURANCE',
    );
  });

  it('is still created when the software has no policy, and fetches it again later', async () => {
    answers.delete(GSTIN);
    const renewal = await createCase({
      type: 'EXISTING',
      policyStart: '2026-11-01',
      policyEnd: '2027-10-31',
    }).expect(201);
    expect(renewal.body.existingPolicy).toBeNull();
    expect(renewal.body.existingPolicyLookup).toMatchObject({
      status: 'NOT_FOUND',
      message: 'PolicyDesk has no policy for this client.',
    });
    answers.set(GSTIN, LAST_YEAR);
    const again = await request(app)
      .post(`/api/v1/proposals/${renewal.body.id as string}/existing-policy`)
      .set(bearer(placement))
      .expect(200);
    expect(again.body.existingPolicy.policyNumber).toBe('EGI/FIRE/2025/0042');
    expect(again.body.sections.filter((s: { included: boolean }) => s.included)).toHaveLength(2);
  });

  it('says when the link to the policy software is not set up', async () => {
    const adminHere = (await tokenFor(unconfigured, ['ADMIN'])).token;
    const preview = await request(unconfigured)
      .get(`/api/v1/proposals/last-policy?clientId=${clientId}`)
      .set(bearer(adminHere))
      .expect(200);
    expect(preview.body.status).toBe('NOT_CONFIGURED');
    const renewal = await createCase(
      { type: 'EXISTING', policyStart: '2026-11-01', policyEnd: '2027-10-31' },
      adminHere,
      unconfigured,
    ).expect(201);
    expect(renewal.body.existingPolicyLookup.status).toBe('NOT_CONFIGURED');
  });
});

describe('the 9 stages', () => {
  it('follows the work to RFQ Sent, then moves one stage at a time, and can close', async () => {
    const created = await createCase({}).expect(201);
    const id = created.body.id as string;
    // Stages before the RFQ follow the work: they cannot be set by hand.
    await request(app)
      .post(`/api/v1/proposals/${id}/stage`)
      .set(bearer(manager))
      .send({ stage: 'QUOTES_RECEIVED' })
      .expect(409);
    // Simulate the RFQ having gone out.
    const { ProposalModel } = await import('../src/modules/proposals/proposal.model.ts');
    await ProposalModel.updateOne(
      { _id: id },
      {
        $set: {
          insurers: [{ insurerId: locationId, status: 'SENT', sentAt: new Date(), sentBy: null }],
        },
      },
    );
    let record = (
      await request(app).get(`/api/v1/proposals/${id}`).set(bearer(manager)).expect(200)
    ).body;
    expect([record.stage, record.nextStage]).toEqual(['RFQ_SENT', 'QUOTES_RECEIVED']);
    for (const stage of ['QUOTES_RECEIVED', 'QCR', 'CLIENT_APPROVAL', 'PLACEMENT_SLIP', 'PLACED']) {
      await request(app)
        .post(`/api/v1/proposals/${id}/stage`)
        .set(bearer(placement))
        .send({ stage })
        .expect(200);
    }
    record = (await request(app).get(`/api/v1/proposals/${id}`).set(bearer(manager)).expect(200))
      .body;
    expect([record.stage, record.nextStage]).toEqual(['PLACED', null]);
    await request(app)
      .post(`/api/v1/proposals/${id}/stage`)
      .set(bearer(manager))
      .send({ stage: 'CLOSED', reason: 'Too late' })
      .expect(409);
    expect(
      await AuditLogModel.countDocuments({ action: 'PROPOSAL_STAGE_CHANGED', entityId: id }),
    ).toBe(5);

    const other = await createCase({}).expect(201);
    await request(app)
      .post(`/api/v1/proposals/${other.body.id as string}/stage`)
      .set(bearer(manager))
      .send({ stage: 'CLOSED' })
      .expect(400);
    const closed = await request(app)
      .post(`/api/v1/proposals/${other.body.id as string}/stage`)
      .set(bearer(manager))
      .send({ stage: 'CLOSED', reason: 'Client went with another broker' })
      .expect(200);
    expect(closed.body).toMatchObject({
      stage: 'CLOSED',
      locked: true,
      closedReason: 'Client went with another broker',
    });
    const sheet = await request(app)
      .put(`/api/v1/proposals/${other.body.id as string}/data-sheet`)
      .set(bearer(manager))
      .send({
        dueDate: '2026-10-20',
        policyStart: null,
        policyEnd: null,
        locations: [],
        fireOption2: [],
        sections: [],
        claims: [],
        notes: null,
      })
      .expect(409);
    expect(sheet.body.message).toBe('This case is closed.');
  });
});

describe('the policy software over HTTP', () => {
  let server: Server;
  let baseUrl: string;
  let seen: { url: string; auth: string | undefined }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push({ url: req.url ?? '', auth: req.headers.authorization });
      const url = new URL(req.url ?? '', 'http://x');
      if (url.searchParams.get('gstin') === 'BROKEN') {
        res.writeHead(500).end();
        return;
      }
      if (url.searchParams.get('gstin') !== GSTIN) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          insurer: 'Example General',
          policyNumber: 'P-1',
          periodStart: '2025-11-01T00:00:00Z',
          periodEnd: '2026-10-31',
          sections: [
            { section: 'Fire & Allied Perils', sumInsured: 1000000, premium: '1,200.50' },
            { section: 'Burglary', sumInsured: '250000' },
          ],
          fireLines: [
            { line: 'All types of stock pertaining to insured business', sumInsured: 400000 },
          ],
          totalPremium: 1500,
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('asks by GSTIN and name with the key, and maps the answer', async () => {
    seen = [];
    const source = httpExistingPolicySource({
      baseUrl,
      apiKey: 'secret',
      timeoutMs: 2000,
      sourceName: 'PolicyDesk',
    });
    const result = await source.latest({ gstin: GSTIN, clientName: 'Renewal Test Mills' });
    expect(seen[0]).toEqual({
      url: `/api/policies/latest?gstin=${GSTIN}&name=Renewal+Test+Mills`,
      auth: 'Bearer secret',
    });
    expect(result).toEqual({
      status: 'FOUND',
      policy: {
        source: 'PolicyDesk',
        insurer: 'Example General',
        policyNumber: 'P-1',
        product: null,
        periodStart: '2025-11-01',
        periodEnd: '2026-10-31',
        sections: [
          { code: 'FIRE', sumInsured: '1000000', premium: '1200.5' },
          { code: 'BURGLARY', sumInsured: '250000', premium: null },
        ],
        fireLines: [{ group: 'STOCKS', sumInsured: '400000' }],
        totalSumInsured: '1250000',
        netPremium: null,
        gst: null,
        totalPremium: '1500',
      },
    });
    expect((await source.latest({ gstin: 'NONE', clientName: 'X' })).status).toBe('NOT_FOUND');
    expect((await source.latest({ gstin: 'BROKEN', clientName: 'X' })).status).toBe('UNAVAILABLE');
    const down = httpExistingPolicySource({
      baseUrl: 'http://127.0.0.1:1/api',
      apiKey: null,
      timeoutMs: 1000,
      sourceName: 'PolicyDesk',
    });
    expect(await down.latest({ gstin: GSTIN, clientName: 'X' })).toMatchObject({
      status: 'UNAVAILABLE',
      message: 'The policy software (PolicyDesk) did not answer. Try again later.',
    });
  });
});
