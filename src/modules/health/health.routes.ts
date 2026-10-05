import { HealthResponseSchema, type HealthResponse } from '../../shared/index.ts';
import { Router } from 'express';
import { API_VERSION } from '../../config/version.ts';
import { pingDatabase } from '../../lib/db.ts';
import { documentRoute } from '../../lib/openapi.ts';
import { route } from '../../middleware/validate.ts';

export function createHealthRouter(): Router {
  const router = Router();

  router.get(
    '/',
    route({}, async (_input, _req, res) => {
      const dbUp = await pingDatabase();
      const body: HealthResponse = {
        status: dbUp ? 'ok' : 'degraded',
        db: dbUp ? 'up' : 'down',
        version: API_VERSION,
        uptimeSeconds: Math.floor(process.uptime()),
        time: new Date().toISOString(),
      };
      res
        .set('Cache-Control', 'no-store')
        .status(dbUp ? 200 : 503)
        .json(body);
    }),
  );

  return router;
}

documentRoute({
  method: 'get',
  path: '/api/v1/health',
  tags: ['Health'],
  summary: 'API and database status',
  public: true,
  responses: {
    200: {
      description: 'The API and MongoDB are up',
      content: { 'application/json': { schema: HealthResponseSchema } },
    },
    503: {
      description: 'MongoDB is unreachable',
      content: { 'application/json': { schema: HealthResponseSchema } },
    },
  },
});
