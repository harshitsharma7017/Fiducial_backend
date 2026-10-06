import {
  ERROR_CODES,
  LoginRequestSchema,
  LoginResponseSchema,
  UserSchema,
} from '../../shared/index.ts';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { Env } from '../../config/env.ts';
import { documentRoute, errorResponses } from '../../lib/openapi.ts';
import { authenticate } from '../../middleware/auth.ts';
import { currentUser } from '../../middleware/require-permission.ts';
import { route } from '../../middleware/validate.ts';
import { getUser } from '../users/users.service.ts';
import { login, recordLogout } from './auth.service.ts';

type AuthConfig = Pick<
  Env,
  | 'JWT_SECRET'
  | 'JWT_EXPIRES_IN_SECONDS'
  | 'LOGIN_RATE_LIMIT_MAX'
  | 'LOGIN_RATE_LIMIT_WINDOW_SECONDS'
>;

export function createAuthRouter(config: AuthConfig): Router {
  const router = Router();

  // Per-IP limit on sign-in attempts, on top of the per-account lockout.
  // The store is in memory: use a shared store if the API runs as several instances.
  const loginLimiter = rateLimit({
    windowMs: config.LOGIN_RATE_LIMIT_WINDOW_SECONDS * 1000,
    limit: config.LOGIN_RATE_LIMIT_MAX,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({
        message: 'Too many sign-in attempts. Wait a few minutes and try again.',
        code: ERROR_CODES.RATE_LIMITED,
      });
    },
  });

  router.post(
    '/login',
    loginLimiter,
    route({ body: LoginRequestSchema }, async ({ body }, req, res) => {
      const result = await login(
        body,
        { requestId: req.requestId, ip: req.ip },
        { jwtSecret: config.JWT_SECRET, expiresInSeconds: config.JWT_EXPIRES_IN_SECONDS },
      );
      res.set('Cache-Control', 'no-store').json(result);
    }),
  );

  const requireSession = authenticate({ jwtSecret: config.JWT_SECRET });

  router.get(
    '/me',
    requireSession,
    route({}, async (_input, req, res) => {
      res.set('Cache-Control', 'no-store').json(await getUser(currentUser(req).id));
    }),
  );

  router.post(
    '/logout',
    requireSession,
    route({}, async (_input, req, res) => {
      await recordLogout(currentUser(req), req.requestId);
      res.status(204).end();
    }),
  );

  return router;
}

documentRoute({
  method: 'post',
  path: '/api/v1/auth/login',
  tags: ['Auth'],
  summary: 'Sign in with email and password',
  description:
    'Returns a JWT access token for the Authorization: Bearer header. The same 401 is returned ' +
    'for an unknown email, an inactive user, a locked account and a wrong password. Five ' +
    'consecutive failures lock the account for 15 minutes. Rate limited per IP.',
  public: true,
  request: { body: { content: { 'application/json': { schema: LoginRequestSchema } } } },
  responses: {
    200: {
      description: 'Signed in',
      content: { 'application/json': { schema: LoginResponseSchema } },
    },
    ...errorResponses(400, 401, 429),
  },
});

documentRoute({
  method: 'get',
  path: '/api/v1/auth/me',
  tags: ['Auth'],
  summary: 'The signed-in user',
  responses: {
    200: { description: 'Current user', content: { 'application/json': { schema: UserSchema } } },
    ...errorResponses(401),
  },
});

documentRoute({
  method: 'post',
  path: '/api/v1/auth/logout',
  tags: ['Auth'],
  summary: 'Record a sign-out',
  description: 'Tokens are stateless: the client discards its token. The event is audited.',
  responses: { 204: { description: 'Signed out' }, ...errorResponses(401) },
});
