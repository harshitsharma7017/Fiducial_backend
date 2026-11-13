import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger.ts';
import {
  geminiExistingReader,
  mapExistingAnswer,
} from '../src/modules/proposals/existing-ocr-reader.ts';
import type { ExistingOcrReader } from '../src/modules/proposals/existing-ocr-reader.ts';
import { bearer, createTestApp, tokenFor, useTestDatabase } from './helpers/app.ts';
import { seedMasters } from './helpers/masters.ts';

// The existing policy's sum insured read from a file for the Data Sheet's Existing column.

useTestDatabase();

const answer = {
  insurer: ' Abhay Insurance Co. Ltd ',
  policyNumber: 'P/123/456',
  fireLines: [
    { group: 'BUILDING' as const, amount: '20,00,000' },
    { group: 'FFF' as const, amount: '5,00,000' },
    { group: 'STOCKS' as const, amount: '1.5 lakh' },
  ],
  fireTotal: '30,10,000',
  sections: [
    {
      code: 'MONEY' as const,
      sumInsured: null,
      lines: [{ key: 'cashInSafe', amount: '2,00,000' }],
    },
  ],
  issues: ['Stock is printed as words'],
};

describe('mapExistingAnswer', () => {
  it('keeps clean amounts as whole rupees and warns about the rest', () => {
    const result = mapExistingAnswer(answer);
    expect(result.insurer).toBe('Abhay Insurance Co. Ltd');
    expect(result.fireLines).toEqual([
      { group: 'BUILDING', amount: '2000000' },
      { group: 'FFF', amount: '500000' },
    ]);
    expect(result.fireTotal).toBeNull();
    expect(result.sections).toEqual([
      { code: 'MONEY', existing: null, existingLines: { cashInSafe: '200000' } },
    ]);
    expect(result.warnings.join(' ')).toMatch(/1\.5 lakh/);
    expect(result.manualEntryRequired).toBe(false);
  });

  it('asks for manual entry when no figure was found', () => {
    const result = mapExistingAnswer({ ...answer, fireLines: [], fireTotal: null, sections: [] });
    expect(result.manualEntryRequired).toBe(true);
  });
});

describe('geminiExistingReader', () => {
  const reader = geminiExistingReader({
    logger: createLogger({ level: 'silent' }),
    generate: () => Promise.resolve({ text: JSON.stringify(answer), finishReason: 'STOP' }),
  });
  it('maps the answer for a PDF and refuses other types without calling Gemini', async () => {
    const read = await reader.read({ contentType: 'application/pdf', data: Buffer.from('%PDF-1') });
    expect(read.reader).toBe('GEMINI');
    expect(read.fireLines).toHaveLength(2);
    const other = await reader.read({ contentType: 'text/plain', data: Buffer.from('x') });
    expect(other.manualEntryRequired).toBe(true);
  });
});

describe('POST /proposals/:id/data-sheet/existing-ocr', () => {
  const fake: ExistingOcrReader = {
    external: true,
    read: (file) =>
      Promise.resolve(mapExistingAnswer({ ...answer, policyNumber: file.contentType })),
  };
  const app = createTestApp({}, undefined, undefined, undefined, undefined, {
    existingOcrReader: fake,
  });
  let manager: string;
  let caseId: string;

  beforeAll(async () => {
    await seedMasters();
    const admin = (await tokenFor(app, ['ADMIN'])).token;
    manager = (await tokenFor(app, ['ACCOUNT_MANAGER'])).token;
    const client = await request(app)
      .post('/api/v1/clients')
      .set(bearer(admin))
      .send({
        name: 'Ocr Test Mills',
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
    const location = await request(app)
      .post(`/api/v1/clients/${client.body.id as string}/locations`)
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
    const created = await request(app)
      .post('/api/v1/proposals')
      .set(bearer(manager))
      .send({
        clientId: client.body.id,
        type: 'NEW',
        locationIds: [location.body.id],
        dueDate: '2026-11-20',
        policyStart: '2026-12-01',
        policyEnd: '2027-11-30',
      })
      .expect(201);
    caseId = created.body.id as string;
  });

  it('returns candidate values and saves nothing', async () => {
    const response = await request(app)
      .post(`/api/v1/proposals/${caseId}/data-sheet/existing-ocr?fileName=p.pdf`)
      .set(bearer(manager))
      .set('Content-Type', 'application/pdf')
      .send(Buffer.from('%PDF-1.4 test'))
      .expect(200);
    expect(response.body.policyNumber).toBe('application/pdf');
    expect(response.body.fireLines[0]).toEqual({ group: 'BUILDING', amount: '2000000' });
  });

  it('needs property.edit', async () => {
    const viewer = (await tokenFor(app, ['READ_ONLY'])).token;
    await request(app)
      .post(`/api/v1/proposals/${caseId}/data-sheet/existing-ocr`)
      .set(bearer(viewer))
      .set('Content-Type', 'application/pdf')
      .send(Buffer.from('%PDF-1.4'))
      .expect(403);
  });
});
