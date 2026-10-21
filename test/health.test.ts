import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createTestApp, useTestDatabase } from './helpers/app.ts';

useTestDatabase();
const app = createTestApp();

describe('GET /api/v1/health', () => {
  it('is public and reports the database status', async () => {
    const response = await request(app).get('/api/v1/health').expect(200);
    expect(response.body).toMatchObject({ status: 'ok', db: 'up', version: expect.any(String) });
    expect(response.headers['x-request-id']).toEqual(expect.any(String));
  });

  it('keeps a well-formed incoming request id', async () => {
    const response = await request(app).get('/api/v1/health').set('X-Request-Id', 'web-1234-abcd');
    expect(response.headers['x-request-id']).toBe('web-1234-abcd');
  });

  it('rejects unknown query parameters', async () => {
    const response = await request(app).get('/api/v1/health?foo=bar').expect(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
  });
});

describe('error handling and security headers', () => {
  it('returns the JSON error shape for unknown routes', async () => {
    const response = await request(app).get('/api/v1/nope').expect(404);
    expect(response.body).toEqual({ message: 'No route for GET /api/v1/nope', code: 'NOT_FOUND' });
  });

  it('rejects malformed JSON', async () => {
    const response = await request(app)
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": ')
      .expect(400);
    expect(response.body.code).toBe('INVALID_JSON');
  });

  it('rejects bodies over 1 MB', async () => {
    const response = await request(app)
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ email: 'a@example.com', password: 'x'.repeat(1_100_000) }))
      .expect(413);
    expect(response.body.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('sets helmet headers and hides the framework', async () => {
    const response = await request(app).get('/api/v1/health');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('only allows the configured CORS origin', async () => {
    const allowed = await request(app)
      .options('/api/v1/health')
      .set('Origin', 'http://localhost:3000');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    const blocked = await request(app)
      .options('/api/v1/health')
      .set('Origin', 'https://evil.example');
    expect(blocked.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('API documentation', () => {
  it('documents every endpoint in the OpenAPI document', async () => {
    const response = await request(app).get('/api/openapi.json').expect(200);
    const operations = Object.entries(response.body.paths as Record<string, object>).flatMap(
      ([path, methods]) => Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`),
    );
    expect(operations.sort()).toEqual(
      [
        'GET /api/v1/health',
        'POST /api/v1/auth/login',
        'GET /api/v1/auth/me',
        'POST /api/v1/auth/logout',
        'GET /api/v1/users',
        'POST /api/v1/users',
        'PATCH /api/v1/users/{id}',
        'GET /api/v1/masters/occupancies',
        'GET /api/v1/masters/occupancies/{tacCode}',
        'POST /api/v1/masters/occupancies',
        'PATCH /api/v1/masters/occupancies/{tacCode}',
        'GET /api/v1/masters/pincodes',
        'POST /api/v1/masters/pincodes',
        'PATCH /api/v1/masters/pincodes/{pincode}',
        'GET /api/v1/masters/pincodes/{pincode}',
        'GET /api/v1/masters/versions',
        'GET /api/v1/masters/workbook',
        'POST /api/v1/masters/import',
        'POST /api/v1/masters/versions/{id}/activate',
        'GET /api/v1/clients',
        'POST /api/v1/clients',
        'GET /api/v1/clients/{id}',
        'PATCH /api/v1/clients/{id}',
        'GET /api/v1/clients/{id}/locations',
        'POST /api/v1/clients/{id}/locations',
        'GET /api/v1/clients/{id}/addon-favourites',
        'PUT /api/v1/clients/{id}/addon-favourites',
        'PATCH /api/v1/clients/{id}/locations/{locationId}',
        'GET /api/v1/imports/{entity}/template',
        'POST /api/v1/imports/{entity}',
        'GET /api/v1/insurers',
        'POST /api/v1/insurers',
        'GET /api/v1/insurers/{id}',
        'PATCH /api/v1/insurers/{id}',
        'GET /api/v1/proposals',
        'POST /api/v1/proposals',
        'GET /api/v1/proposals/{id}',
        'PUT /api/v1/proposals/{id}/data-sheet',
        'POST /api/v1/proposals/{id}/data-sheet/import',
        'PUT /api/v1/proposals/{id}/insurers',
        'GET /api/v1/proposals/{id}/rfq',
        'POST /api/v1/proposals/{id}/rfq/sent',
        'GET /api/v1/proposals/owners',
        'GET /api/v1/proposals/last-policy',
        'POST /api/v1/proposals/{id}/existing-policy',
        'POST /api/v1/proposals/{id}/stage',
        'DELETE /api/v1/proposals/{id}',
        'POST /api/v1/proposals/{id}/restore',
        'GET /api/v1/templates',
        'GET /api/v1/templates/{kind}/file',
        'POST /api/v1/templates/{kind}',
        'GET /api/v1/catalog/workbook',
        'POST /api/v1/catalog/import',
        'GET /api/v1/catalog/products/suggest',
        'GET /api/v1/catalog/{master}',
        'POST /api/v1/catalog/{master}',
        'PUT /api/v1/catalog/{master}/order',
        'PUT /api/v1/catalog/{master}/{id}',
        'GET /api/v1/audit',
        'GET /api/v1/email-templates',
        'PUT /api/v1/email-templates/{kind}',
        'GET /api/v1/mail/status',
        'POST /api/v1/proposals/{id}/rfq/preview',
        'POST /api/v1/proposals/{id}/rfq/email',
        'POST /api/v1/proposals/{id}/insurers/{insurerId}/reminder',
        'PUT /api/v1/proposals/{id}/insurers/{insurerId}/response',
        'GET /api/v1/proposals/{id}/quotes',
        'POST /api/v1/proposals/{id}/insurers/{insurerId}/quotes',
        'POST /api/v1/proposals/{id}/insurers/{insurerId}/quote-attachments',
        'GET /api/v1/proposals/{id}/quote-attachments/{attachmentId}',
        'GET /api/v1/proposals/{id}/rfq/versions',
        'POST /api/v1/proposals/{id}/rfq/versions',
        'PUT /api/v1/proposals/{id}/rfq/edits',
        'GET /api/v1/proposals/{id}/rfq/versions/{version}',
        'GET /api/v1/proposals/{id}/rfq/versions/{version}/file',
        'POST /api/v1/proposals/{id}/rfq/versions/{version}/submit',
        'POST /api/v1/proposals/{id}/rfq/versions/{version}/approve',
        'POST /api/v1/proposals/{id}/rfq/versions/{version}/return',
        'GET /api/v1/proposals/{id}/qcr',
        'PUT /api/v1/proposals/{id}/qcr',
        'POST /api/v1/proposals/{id}/qcr/approve',
        'GET /api/v1/proposals/{id}/qcr/document',
        'POST /api/v1/proposals/{id}/qcr/email',
        'GET /api/v1/proposals/{id}/mails',
        'GET /api/v1/proposals/{id}/mails/{mailId}',
        'GET /api/v1/proposals/{id}/mails/{mailId}/attachment',
        'GET /api/v1/proposals/{id}/client-approval',
        'PUT /api/v1/proposals/{id}/client-approval',
        'POST /api/v1/proposals/{id}/client-approval/files',
        'GET /api/v1/proposals/{id}/client-approval/files/{fileId}',
        'GET /api/v1/proposals/{id}/placement-slip',
        'PUT /api/v1/proposals/{id}/placement-slip',
        'POST /api/v1/proposals/{id}/placement-slip/approve',
        'GET /api/v1/proposals/{id}/placement-slip/document',
        'POST /api/v1/proposals/{id}/placement-slip/email',
        'POST /api/v1/proposals/{id}/placement-slip/files',
        'GET /api/v1/proposals/{id}/placement-slip/files/{fileId}',
        'PUT /api/v1/proposals/{id}/placement-slip/placed',
        'GET /api/v1/proposals/{id}/coverage-confirmation',
        'PUT /api/v1/proposals/{id}/coverage-confirmation',
        'GET /api/v1/proposals/{id}/coverage-confirmation/document',
        'POST /api/v1/proposals/{id}/coverage-confirmation/email',
        'GET /api/v1/qcrs',
        'GET /api/v1/placement-slips',
        // Group health (GHI)
        'GET /api/v1/ghi/cases',
        'POST /api/v1/ghi/cases',
        'GET /api/v1/ghi/cases/{id}',
        'PUT /api/v1/ghi/cases/{id}',
        'POST /api/v1/ghi/cases/{id}/close',
        'PUT /api/v1/ghi/cases/{id}/requirements',
        'PUT /api/v1/ghi/cases/{id}/insurers',
        'POST /api/v1/ghi/cases/{id}/insurers/{insurerId}/decline',
        'GET /api/v1/ghi/census-template',
        'GET /api/v1/ghi/cases/{id}/members',
        'POST /api/v1/ghi/cases/{id}/members',
        'PUT /api/v1/ghi/cases/{id}/members/{memberId}',
        'DELETE /api/v1/ghi/cases/{id}/members/{memberId}',
        'GET /api/v1/ghi/cases/{id}/census/summary',
        'GET /api/v1/ghi/cases/{id}/census/issues',
        'GET /api/v1/ghi/cases/{id}/census/imports',
        'POST /api/v1/ghi/cases/{id}/census/imports',
        'GET /api/v1/ghi/cases/{id}/census/imports/{importId}',
        'PUT /api/v1/ghi/cases/{id}/census/imports/{importId}/rows/{row}',
        'POST /api/v1/ghi/cases/{id}/census/imports/{importId}/commit',
        'POST /api/v1/ghi/cases/{id}/census/imports/{importId}/discard',
        'GET /api/v1/ghi/cases/{id}/files',
        'POST /api/v1/ghi/cases/{id}/files',
        'GET /api/v1/ghi/cases/{id}/files/{fileId}',
        'GET /api/v1/ghi/cases/{id}/rfq',
        'GET /api/v1/ghi/cases/{id}/rfq/preview',
        'POST /api/v1/ghi/cases/{id}/rfq/generate',
        'POST /api/v1/ghi/cases/{id}/rfq/submit',
        'POST /api/v1/ghi/cases/{id}/rfq/decision',
        'GET /api/v1/ghi/cases/{id}/rfq/document',
        'POST /api/v1/ghi/cases/{id}/rfq/email',
        'POST /api/v1/ghi/cases/{id}/rfq/sent',
        'GET /api/v1/ghi/cases/{id}/quotes',
        'POST /api/v1/ghi/cases/{id}/quotes',
        'PUT /api/v1/ghi/cases/{id}/quotes/{quoteId}',
        'DELETE /api/v1/ghi/cases/{id}/quotes/{quoteId}',
        'GET /api/v1/ghi/cases/{id}/qcrs',
        'POST /api/v1/ghi/cases/{id}/qcrs',
        'PUT /api/v1/ghi/cases/{id}/qcrs/{qcrId}',
        'POST /api/v1/ghi/cases/{id}/qcrs/{qcrId}/submit',
        'POST /api/v1/ghi/cases/{id}/qcrs/{qcrId}/decision',
        'GET /api/v1/ghi/cases/{id}/qcrs/{qcrId}/document',
        'POST /api/v1/ghi/cases/{id}/qcrs/{qcrId}/email',
        'POST /api/v1/ghi/cases/{id}/qcrs/{qcrId}/client-decision',
        'GET /api/v1/ghi/cases/{id}/final-qcr',
        'POST /api/v1/ghi/cases/{id}/final-qcr',
        'GET /api/v1/ghi/cases/{id}/payments',
        'POST /api/v1/ghi/cases/{id}/payments',
        'PUT /api/v1/ghi/cases/{id}/payments/{paymentId}',
        'GET /api/v1/ghi/cases/{id}/placement',
        'GET /api/v1/ghi/cases/{id}/placement-slip',
        'PUT /api/v1/ghi/cases/{id}/policy',
        // Group health claims
        'GET /api/v1/claims',
        'POST /api/v1/claims',
        'GET /api/v1/claims/board',
        'GET /api/v1/claims/policies',
        'GET /api/v1/claims/policies/{caseId}/employees',
        'GET /api/v1/claims/policies/{caseId}/employees/{memberId}/family',
        'GET /api/v1/claims/links',
        'POST /api/v1/claims/links',
        'POST /api/v1/claims/links/{linkId}/revoke',
        'GET /api/v1/claims/email-templates',
        'PUT /api/v1/claims/email-templates/{status}/{audience}',
        'GET /api/v1/claims/hr-contacts/{clientId}',
        'PUT /api/v1/claims/hr-contacts/{clientId}',
        'GET /api/v1/claims/{id}',
        'PUT /api/v1/claims/{id}',
        'POST /api/v1/claims/{id}/transitions',
        'POST /api/v1/claims/{id}/remarks',
        'PUT /api/v1/claims/{id}/assignee',
        'POST /api/v1/claims/{id}/documents',
        'GET /api/v1/claims/{id}/documents/{fileId}',
        'POST /api/v1/claims/{id}/notifications/{notificationId}/retry',
        'GET /api/v1/claim-links/current',
        'POST /api/v1/claim-links/current/claims',
        'POST /api/v1/claim-links/current/claims/{claimNumber}/documents',
        // Employee Benefits (N1 to N3): GPA, GTLI, family plans, employees, templates
        'PUT /api/v1/ghi/cases/{id}/plan',
        'GET /api/v1/ghi/cases/{id}/census/imports/{importId}/error-report',
        'GET /api/v1/eb/gpa/cases/{id}',
        'PUT /api/v1/eb/gpa/cases/{id}',
        'POST /api/v1/eb/gpa/cases/{id}/close',
        'PUT /api/v1/eb/gpa/cases/{id}/requirements',
        'PUT /api/v1/eb/gpa/cases/{id}/plan',
        'PUT /api/v1/eb/gpa/cases/{id}/insurers',
        'POST /api/v1/eb/gpa/cases/{id}/insurers/{insurerId}/decline',
        'GET /api/v1/eb/gpa/cases/{id}/members',
        'POST /api/v1/eb/gpa/cases/{id}/members',
        'PUT /api/v1/eb/gpa/cases/{id}/members/{memberId}',
        'DELETE /api/v1/eb/gpa/cases/{id}/members/{memberId}',
        'GET /api/v1/eb/gpa/cases/{id}/census/summary',
        'GET /api/v1/eb/gpa/cases/{id}/census/issues',
        'GET /api/v1/eb/gpa/cases/{id}/census/imports',
        'POST /api/v1/eb/gpa/cases/{id}/census/imports',
        'GET /api/v1/eb/gpa/cases/{id}/census/imports/{importId}',
        'PUT /api/v1/eb/gpa/cases/{id}/census/imports/{importId}/rows/{row}',
        'POST /api/v1/eb/gpa/cases/{id}/census/imports/{importId}/commit',
        'POST /api/v1/eb/gpa/cases/{id}/census/imports/{importId}/discard',
        'GET /api/v1/eb/gpa/cases/{id}/census/imports/{importId}/error-report',
        'GET /api/v1/eb/gpa/cases/{id}/files',
        'POST /api/v1/eb/gpa/cases/{id}/files',
        'GET /api/v1/eb/gpa/cases/{id}/files/{fileId}',
        'GET /api/v1/eb/gpa/cases/{id}/rfq',
        'GET /api/v1/eb/gpa/cases/{id}/rfq/preview',
        'POST /api/v1/eb/gpa/cases/{id}/rfq/generate',
        'POST /api/v1/eb/gpa/cases/{id}/rfq/submit',
        'POST /api/v1/eb/gpa/cases/{id}/rfq/decision',
        'GET /api/v1/eb/gpa/cases/{id}/rfq/document',
        'POST /api/v1/eb/gpa/cases/{id}/rfq/email',
        'POST /api/v1/eb/gpa/cases/{id}/rfq/sent',
        'GET /api/v1/eb/gpa/cases/{id}/quotes',
        'POST /api/v1/eb/gpa/cases/{id}/quotes',
        'PUT /api/v1/eb/gpa/cases/{id}/quotes/{quoteId}',
        'DELETE /api/v1/eb/gpa/cases/{id}/quotes/{quoteId}',
        'GET /api/v1/eb/gpa/cases/{id}/qcrs',
        'POST /api/v1/eb/gpa/cases/{id}/qcrs',
        'PUT /api/v1/eb/gpa/cases/{id}/qcrs/{qcrId}',
        'POST /api/v1/eb/gpa/cases/{id}/qcrs/{qcrId}/submit',
        'POST /api/v1/eb/gpa/cases/{id}/qcrs/{qcrId}/decision',
        'GET /api/v1/eb/gpa/cases/{id}/qcrs/{qcrId}/document',
        'POST /api/v1/eb/gpa/cases/{id}/qcrs/{qcrId}/email',
        'POST /api/v1/eb/gpa/cases/{id}/qcrs/{qcrId}/client-decision',
        'GET /api/v1/eb/gpa/cases/{id}/payments',
        'POST /api/v1/eb/gpa/cases/{id}/payments',
        'PUT /api/v1/eb/gpa/cases/{id}/payments/{paymentId}',
        'GET /api/v1/eb/gpa/cases/{id}/placement',
        'POST /api/v1/eb/gpa/cases/{id}/placement',
        'GET /api/v1/eb/gpa/cases/{id}/placement-slip',
        'GET /api/v1/eb/gtli/cases/{id}',
        'PUT /api/v1/eb/gtli/cases/{id}',
        'POST /api/v1/eb/gtli/cases/{id}/close',
        'PUT /api/v1/eb/gtli/cases/{id}/requirements',
        'PUT /api/v1/eb/gtli/cases/{id}/plan',
        'PUT /api/v1/eb/gtli/cases/{id}/insurers',
        'POST /api/v1/eb/gtli/cases/{id}/insurers/{insurerId}/decline',
        'GET /api/v1/eb/gtli/cases/{id}/members',
        'POST /api/v1/eb/gtli/cases/{id}/members',
        'PUT /api/v1/eb/gtli/cases/{id}/members/{memberId}',
        'DELETE /api/v1/eb/gtli/cases/{id}/members/{memberId}',
        'GET /api/v1/eb/gtli/cases/{id}/census/summary',
        'GET /api/v1/eb/gtli/cases/{id}/census/issues',
        'GET /api/v1/eb/gtli/cases/{id}/census/imports',
        'POST /api/v1/eb/gtli/cases/{id}/census/imports',
        'GET /api/v1/eb/gtli/cases/{id}/census/imports/{importId}',
        'PUT /api/v1/eb/gtli/cases/{id}/census/imports/{importId}/rows/{row}',
        'POST /api/v1/eb/gtli/cases/{id}/census/imports/{importId}/commit',
        'POST /api/v1/eb/gtli/cases/{id}/census/imports/{importId}/discard',
        'GET /api/v1/eb/gtli/cases/{id}/census/imports/{importId}/error-report',
        'GET /api/v1/eb/gtli/cases/{id}/files',
        'POST /api/v1/eb/gtli/cases/{id}/files',
        'GET /api/v1/eb/gtli/cases/{id}/files/{fileId}',
        'GET /api/v1/eb/gtli/cases/{id}/rfq',
        'GET /api/v1/eb/gtli/cases/{id}/rfq/preview',
        'POST /api/v1/eb/gtli/cases/{id}/rfq/generate',
        'POST /api/v1/eb/gtli/cases/{id}/rfq/submit',
        'POST /api/v1/eb/gtli/cases/{id}/rfq/decision',
        'GET /api/v1/eb/gtli/cases/{id}/rfq/document',
        'POST /api/v1/eb/gtli/cases/{id}/rfq/email',
        'POST /api/v1/eb/gtli/cases/{id}/rfq/sent',
        'GET /api/v1/eb/gtli/cases/{id}/quotes',
        'POST /api/v1/eb/gtli/cases/{id}/quotes',
        'PUT /api/v1/eb/gtli/cases/{id}/quotes/{quoteId}',
        'DELETE /api/v1/eb/gtli/cases/{id}/quotes/{quoteId}',
        'GET /api/v1/eb/gtli/cases/{id}/qcrs',
        'POST /api/v1/eb/gtli/cases/{id}/qcrs',
        'PUT /api/v1/eb/gtli/cases/{id}/qcrs/{qcrId}',
        'POST /api/v1/eb/gtli/cases/{id}/qcrs/{qcrId}/submit',
        'POST /api/v1/eb/gtli/cases/{id}/qcrs/{qcrId}/decision',
        'GET /api/v1/eb/gtli/cases/{id}/qcrs/{qcrId}/document',
        'POST /api/v1/eb/gtli/cases/{id}/qcrs/{qcrId}/email',
        'POST /api/v1/eb/gtli/cases/{id}/qcrs/{qcrId}/client-decision',
        'GET /api/v1/eb/gtli/cases/{id}/payments',
        'POST /api/v1/eb/gtli/cases/{id}/payments',
        'PUT /api/v1/eb/gtli/cases/{id}/payments/{paymentId}',
        'GET /api/v1/eb/gtli/cases/{id}/placement',
        'POST /api/v1/eb/gtli/cases/{id}/placement',
        'GET /api/v1/eb/gtli/cases/{id}/placement-slip',
        'GET /api/v1/eb/cases',
        'POST /api/v1/eb/cases',
        'GET /api/v1/eb/census-templates',
        'GET /api/v1/eb/companies/{clientId}/employees',
        'POST /api/v1/eb/companies/{clientId}/employees/resolve',
        'PUT /api/v1/eb/companies/{clientId}/employees/{employeeId}',
        'GET /api/v1/eb/companies/{clientId}/plan-defaults',
        'PUT /api/v1/eb/companies/{clientId}/plan-defaults/{product}',
        'GET /api/v1/family-plans',
        'POST /api/v1/family-plans',
        'GET /api/v1/family-plans/{planId}',
        'PUT /api/v1/family-plans/{planId}',
        'POST /api/v1/family-plans/{planId}/activate',
        'POST /api/v1/family-plans/{planId}/deactivate',
        'GET /api/v1/family-plans/{planId}/open-cases',
        'POST /api/v1/family-plans/{planId}/versions',
        'PUT /api/v1/family-plans/{planId}/versions/{number}',
        'POST /api/v1/family-plans/{planId}/versions/{number}/activate',
        'PUT /api/v1/family-plans/{planId}/versions/{number}/effective-to',
        'POST /api/v1/family-plans/{planId}/versions/{number}/confirm',
        // N4: the Age Band Master and each case's age bands; N7: the RFQ selection summary.
        'GET /api/v1/age-bands',
        'POST /api/v1/age-bands',
        'GET /api/v1/age-bands/{setId}',
        'PUT /api/v1/age-bands/{setId}',
        'POST /api/v1/age-bands/{setId}/activate',
        'POST /api/v1/age-bands/{setId}/deactivate',
        'GET /api/v1/age-bands/{setId}/cases',
        'PUT /api/v1/ghi/cases/{id}/age-bands',
        'GET /api/v1/ghi/cases/{id}/rfq/selection-summary',
        'GET /api/v1/ghi/cases/{id}/rfq/selection-summary/document',
        'GET /api/v1/ghi/cases/{id}/rfq/versions/{rfqId}/selection-summary',
        'PUT /api/v1/eb/gpa/cases/{id}/age-bands',
        'GET /api/v1/eb/gpa/cases/{id}/rfq/selection-summary',
        'GET /api/v1/eb/gpa/cases/{id}/rfq/selection-summary/document',
        'GET /api/v1/eb/gpa/cases/{id}/rfq/versions/{rfqId}/selection-summary',
        'PUT /api/v1/eb/gtli/cases/{id}/age-bands',
        'GET /api/v1/eb/gtli/cases/{id}/rfq/selection-summary',
        'GET /api/v1/eb/gtli/cases/{id}/rfq/selection-summary/document',
        'GET /api/v1/eb/gtli/cases/{id}/rfq/versions/{rfqId}/selection-summary',
        // N8 to N11: TPA claims and import settings, claims analysis and premium, renewal analysis.
        'GET /api/v1/claims-analysis',
        'GET /api/v1/claims-analysis/document',
        'GET /api/v1/claims-analysis/premium/{caseId}',
        'GET /api/v1/renewal/options',
        'GET /api/v1/renewal/reports',
        'GET /api/v1/renewal/reports/{reportId}',
        'GET /api/v1/renewal/reports/{reportId}/document',
        'GET /api/v1/renewal/years',
        'GET /api/v1/tpa/claims',
        'GET /api/v1/tpa/claims/{claimId}',
        'GET /api/v1/tpa/claims/{claimId}/history',
        'GET /api/v1/tpa/formats',
        'GET /api/v1/tpa/formats/{formatId}',
        'GET /api/v1/tpa/imports',
        'GET /api/v1/tpa/imports/{importId}',
        'GET /api/v1/tpa/imports/{importId}/error-report',
        'GET /api/v1/tpa/imports/{importId}/rows',
        'GET /api/v1/tpa/policies',
        'GET /api/v1/tpa/settings',
        'POST /api/v1/claims-analysis/premium/{caseId}',
        'POST /api/v1/claims-analysis/premium/{caseId}/{adjustmentId}/void',
        'POST /api/v1/renewal/analysis',
        'POST /api/v1/renewal/analysis/document',
        'POST /api/v1/renewal/reports',
        'POST /api/v1/renewal/years',
        'POST /api/v1/tpa/formats',
        'POST /api/v1/tpa/formats/{formatId}/activate',
        'POST /api/v1/tpa/formats/{formatId}/deactivate',
        'POST /api/v1/tpa/imports',
        'POST /api/v1/tpa/imports/{importId}/commit',
        'POST /api/v1/tpa/imports/{importId}/discard',
        'POST /api/v1/tpa/inspect',
        'PUT /api/v1/renewal/years/{yearId}',
        'PUT /api/v1/tpa/claims/{claimId}/link',
        'PUT /api/v1/tpa/formats/{formatId}',
        'PUT /api/v1/tpa/settings',
      ].sort(),
    );
    // The audit query's filters are documented as query parameters.
    const auditParameters = (
      response.body.paths['/api/v1/audit'].get.parameters as Array<{ name: string; in: string }>
    ).map((parameter) => `${parameter.in}:${parameter.name}`);
    expect(auditParameters.sort()).toEqual(
      [
        'query:kind',
        'query:entity',
        'query:entityId',
        'query:actorId',
        'query:limit',
        'query:cursor',
      ].sort(),
    );
    expect(response.body.components.securitySchemes.bearerAuth).toMatchObject({ scheme: 'bearer' });
  });

  it('serves Swagger UI at /api/docs', async () => {
    const response = await request(app).get('/api/docs/').expect(200);
    expect(response.text).toContain('swagger-ui');
  });
});
