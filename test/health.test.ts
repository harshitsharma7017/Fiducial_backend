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
        'GET /api/v1/masters/pincodes/{pincode}',
        'GET /api/v1/masters/versions',
        'POST /api/v1/masters/versions/{id}/activate',
        'POST /api/v1/rating/fire',
      ].sort(),
    );
    expect(response.body.components.securitySchemes.bearerAuth).toMatchObject({ scheme: 'bearer' });
  });

  it('serves Swagger UI at /api/docs', async () => {
    const response = await request(app).get('/api/docs/').expect(200);
    expect(response.text).toContain('swagger-ui');
  });
});
