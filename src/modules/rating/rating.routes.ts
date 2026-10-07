import { FireRatingRequestSchema, FireRatingResponseSchema } from '../../shared/index.ts';
import { Router } from 'express';
import { documentRoute, errorResponses } from '../../lib/openapi.ts';
import { authenticate } from '../../middleware/auth.ts';
import { requirePermission } from '../../middleware/require-permission.ts';
import { route } from '../../middleware/validate.ts';
import { taxRatePercentOn } from '../catalog/catalog.service.ts';
import { istDay } from '../../lib/ist-day.ts';
import { rateFire } from './rating.service.ts';

export function createRatingRouter(options: { jwtSecret: string; gstRatePercent: string }): Router {
  const router = Router();
  router.use(authenticate(options), requirePermission('rating.use'));

  router.post(
    '/fire',
    route({ body: FireRatingRequestSchema }, async ({ body }, _req, res) => {
      // Today's GST from the tax master, else the configured default.
      const gstRatePercent = await taxRatePercentOn(
        'GST',
        istDay(new Date()),
        options.gstRatePercent,
      );
      res.json(await rateFire(body, { gstRatePercent }));
    }),
  );

  return router;
}

documentRoute({
  method: 'post',
  path: '/api/v1/rating/fire',
  tags: ['Rating'],
  summary: 'Indicative Fire premium',
  description:
    'Needs rating.use (every role except Read-only). ' +
    'Prices fire (IIB rate), STFI (occupancy minimum), earthquake (pincode rate for the ' +
    "occupancy's Fire risk type) and, when a rate is supplied, terrorism. Amounts are rupees " +
    'to 2 decimals (ROUND_HALF_UP); rates are per mille. Add-on premiums are not priced yet. ' +
    'Returns 422 when the master data cannot support the calculation (for example a blank Fire ' +
    'risk type), and a warning when the pincode EQ rate is below the occupancy minimum.',
  request: { body: { content: { 'application/json': { schema: FireRatingRequestSchema } } } },
  responses: {
    200: {
      description: 'Premium breakdown, warnings and the master snapshot used',
      content: { 'application/json': { schema: FireRatingResponseSchema } },
    },
    ...errorResponses(400, 401, 403, 409, 422),
  },
});
