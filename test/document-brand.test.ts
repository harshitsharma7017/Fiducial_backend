import { DEFAULT_DOCUMENT_BRAND } from '../src/shared/index.ts';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLogModel } from '../src/modules/audit/audit.model.ts';
import { documentFooter, documentHeader } from '../src/modules/documents/sheet-pdf.ts';
import { bearer, createTestApp, tokenFor, useTestDatabase } from './helpers/app.ts';

useTestDatabase();
const app = createTestApp();
const PATH = '/api/v1/templates/document-brand';

const brand = {
  companyName: 'Example Brokers Pvt Ltd',
  addressLines: ['12 Market Road', 'Chennai - 600 001.'],
  telephone: '+91 44 1234 5678',
  email: '',
  website: 'www.example.in',
  footerNote: 'IRDAI licence no. 123',
};

describe('the documents’ header and footer (Settings)', () => {
  let admin: string;
  let manager: string;

  beforeAll(async () => {
    admin = (await tokenFor(app, ['ADMIN'])).token;
    manager = (await tokenFor(app, ['ACCOUNT_MANAGER'])).token;
  });

  it('prints Fiducial’s letterhead until one is saved', async () => {
    const response = await request(app).get(PATH).set(bearer(manager)).expect(200);
    expect(response.body).toEqual({
      ...DEFAULT_DOCUMENT_BRAND,
      isDefault: true,
      updatedAt: null,
      updatedBy: null,
    });
  });

  it('is saved by those who manage the document templates, and audited', async () => {
    await request(app).put(PATH).set(bearer(manager)).send(brand).expect(403);
    const bad = await request(app)
      .put(PATH)
      .set(bearer(admin))
      .send({ ...brand, companyName: ' ', addressLines: ['1', '2', '3', '4', '5', '6'] })
      .expect(400);
    expect(JSON.stringify(bad.body.details)).toContain('Enter the company name');
    expect(JSON.stringify(bad.body.details)).toContain('Use at most 5 address lines');

    const saved = await request(app).put(PATH).set(bearer(admin)).send(brand).expect(200);
    expect(saved.body).toMatchObject({ ...brand, isDefault: false });
    expect(saved.body.updatedAt).not.toBeNull();
    expect((await request(app).get(PATH).set(bearer(manager)).expect(200)).body).toMatchObject(
      brand,
    );
    const audit = await AuditLogModel.findOne({ action: 'DOCUMENT_BRAND_UPDATED' }).lean();
    expect(audit).toMatchObject({ entityId: 'HEADER_FOOTER', after: brand });
  });

  it('draws the header and footer from it, leaving out blank contact parts', () => {
    const header = JSON.stringify(documentHeader(null, brand));
    expect(header).toContain('Example Brokers Pvt Ltd');
    expect(header).toContain('Chennai - 600 001.');
    expect(header).not.toContain('Fiducial Insurance Brokers');
    const footer = JSON.stringify(documentFooter('RFQ PRP-1', 1, 2, brand));
    expect(footer).toContain('Tel : +91 44 1234 5678');
    expect(footer).toContain('www.example.in');
    expect(footer).not.toContain('E-mail');
    expect(footer).toContain('IRDAI licence no. 123');
    // Without a saved one: Fiducial's.
    expect(JSON.stringify(documentFooter('RFQ PRP-1', 1, 2))).toContain('info@fiducial.in');
  });
});
