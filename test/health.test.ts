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
        'PATCH /api/v1/clients/{id}/locations/{locationId}',
        'GET /api/v1/imports/{entity}/template',
        'POST /api/v1/imports/{entity}',
        'GET /api/v1/insurers',
        'POST /api/v1/insurers',
        'GET /api/v1/insurers/{id}',
        'PATCH /api/v1/insurers/{id}',
        'POST /api/v1/rating/fire',
        'GET /api/v1/proposals',
        'POST /api/v1/proposals',
        'GET /api/v1/proposals/{id}',
        'PUT /api/v1/proposals/{id}/data-sheet',
        'PUT /api/v1/proposals/{id}/insurers',
        'GET /api/v1/proposals/{id}/rfq',
        'POST /api/v1/proposals/{id}/rfq/sent',
        'GET /api/v1/catalog/workbook',
        'POST /api/v1/catalog/import',
        'GET /api/v1/catalog/products/suggest',
        'GET /api/v1/catalog/{master}',
        'POST /api/v1/catalog/{master}',
        'PUT /api/v1/catalog/{master}/order',
        'PUT /api/v1/catalog/{master}/{id}',
        'GET /api/v1/audit',
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
