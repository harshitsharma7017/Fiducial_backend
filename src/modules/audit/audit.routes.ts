import { AuditLogListResponseSchema, AuditLogQuerySchema } from '../../shared/index.ts';
import { Router } from 'express';
import { documentRoute, errorResponses } from '../../lib/openapi.ts';
import { authenticate } from '../../middleware/auth.ts';
import { requirePermission } from '../../middleware/require-permission.ts';
import { route } from '../../middleware/validate.ts';
import { listAuditLog } from './audit.service.ts';

/** Read-only access to the audit log. There is no way to change or delete an entry. */
export function createAuditRouter(options: { jwtSecret: string }): Router {
  const router = Router();
  router.use(authenticate(options), requirePermission('audit.view'));

  router.get(
    '/',
    route({ query: AuditLogQuerySchema }, async ({ query }, _req, res) => {
      res.json(await listAuditLog(query));
    }),
  );

  return router;
}

documentRoute({
  method: 'get',
  path: '/api/v1/audit',
  tags: ['Audit'],
  summary: 'Read the audit log',
  description:
    'Needs audit.view (Admin). Newest first; cursor pagination: pass nextCursor back as cursor. ' +
    'Each entry names who acted and when. `changes` lists each field with its old and new value ' +
    '(every field for a create); sign-ins carry `details` instead. Filter by kind, by record ' +
    '(entity with entityId) or by who acted (actorId).',
  request: { query: AuditLogQuerySchema },
  responses: {
    200: {
      description: 'A page of audit entries',
      content: { 'application/json': { schema: AuditLogListResponseSchema } },
    },
    ...errorResponses(400, 401, 403),
  },
});
