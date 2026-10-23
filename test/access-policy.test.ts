import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { errorHandler } from '../src/middleware/error-handler.ts';
import {
  accessPolicyOf,
  publicAccess,
  type AccessPolicy,
} from '../src/middleware/require-permission.ts';
import { ROUTE_HANDLER, route } from '../src/middleware/validate.ts';
import { createTestApp } from './helpers/app.ts';

// Deny by default (docs/RBAC.md 2.4): every route declares an access policy, its handler enforces
// it at runtime, and the only public routes are the ones designed to be.

interface Layer {
  handle: ((...args: unknown[]) => unknown) & { stack?: Layer[] };
  route?: { path: string; methods: Record<string, boolean>; stack: Layer[] };
}

interface RouteInfo {
  route: string;
  /** Policies on the route itself or on a router-level middleware before it. */
  policies: AccessPolicy[];
  enforcedByHandler: boolean;
}

/** Every route of the app with the access policies that apply to it, in Express's own order. */
function routesOf(stack: Layer[], inherited: AccessPolicy[] = [], out: RouteInfo[] = []) {
  let policies = inherited;
  for (const layer of stack) {
    if (layer.route) {
      const handlers = layer.route.stack.map((item) => item.handle);
      const own = handlers.map(accessPolicyOf).filter((p): p is AccessPolicy => Boolean(p));
      const last = handlers.at(-1) as unknown as Record<symbol, unknown>;
      out.push({
        route: `${Object.keys(layer.route.methods).join(',').toUpperCase()} ${layer.route.path}`,
        policies: [...policies, ...own],
        enforcedByHandler: last[ROUTE_HANDLER] === true,
      });
    } else if (layer.handle.stack) {
      routesOf(layer.handle.stack, policies, out);
    } else {
      const policy = accessPolicyOf(layer.handle);
      if (policy) policies = [...policies, policy];
    }
  }
  return out;
}

const app = createTestApp();
const routes = routesOf((app as unknown as { router: { stack: Layer[] } }).router.stack);

describe('access policies', () => {
  it('covers every route of the API', () => {
    // 306 endpoints in the audit, plus the six role routes and the OpenAPI document.
    expect(routes.length).toBeGreaterThan(350);
  });

  it('declares a policy on every route', () => {
    expect(routes.filter((r) => r.policies.length === 0).map((r) => r.route)).toEqual([]);
  });

  it('builds every handler with route(), which refuses a request no policy granted', () => {
    expect(routes.filter((r) => !r.enforcedByHandler).map((r) => r.route)).toEqual([]);
  });

  it('opens to the public only the routes designed to be public', () => {
    const publicRoutes = routes
      .filter((r) => r.policies.length > 0 && r.policies.every((p) => p.kind === 'public'))
      .map((r) => `${r.route} — ${r.policies.map((p) => p.detail).join('; ')}`)
      .sort();
    expect(publicRoutes).toEqual(
      [
        'GET / — health check for monitoring: status, database, version, uptime',
        'GET /api/openapi.json — OpenAPI description of the API',
        'GET /current — employee claim submission link; the link token is checked per request',
        'POST /current/claims — employee claim submission link; the link token is checked per request',
        'POST /current/claims/:claimNumber/documents — employee claim submission link; the link token is checked per request',
        'POST /login — sign-in',
      ].sort(),
    );
  });

  it('keeps routes open to every signed-in user to the documented self-scoped ones', () => {
    const selfScoped = routes
      .filter((r) => r.policies.length > 0 && r.policies.every((p) => p.kind === 'authenticated'))
      .map((r) => r.route)
      .sort();
    expect(selfScoped).toEqual(
      [
        'GET /',
        'GET /me',
        'GET /unread-count',
        'POST /:id/read',
        'POST /logout',
        'POST /read-all',
      ].sort(),
    );
  });
});

describe('route()', () => {
  function probe(withPolicy: boolean) {
    let ran = false;
    const probeApp = express();
    probeApp.use((req, _res, next) => {
      (req as unknown as { log: { error: () => void } }).log = { error: () => {} };
      next();
    });
    const handler = route({}, (_input, _req, res) => {
      ran = true;
      res.json({ ok: true });
    });
    if (withPolicy) probeApp.get('/x', publicAccess('test'), handler);
    else probeApp.get('/x', handler);
    probeApp.use(errorHandler());
    return { response: request(probeApp).get('/x'), ran: () => ran };
  }

  it('refuses (403) and never runs a handler whose route forgot its policy', async () => {
    const forgotten = probe(false);
    await forgotten.response.expect(403);
    expect(forgotten.ran()).toBe(false);
  });

  it('runs the handler once a policy granted the request', async () => {
    const declared = probe(true);
    await declared.response.expect(200);
    expect(declared.ran()).toBe(true);
  });
});
