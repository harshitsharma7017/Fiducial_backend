import { PlacementSlipSummaryListSchema, QcrSummaryListSchema } from '../../shared/index.ts';
import { Router } from 'express';
import type { z } from 'zod';
import { documentRoute, errorResponses } from '../../lib/openapi.ts';
import { authenticate } from '../../middleware/auth.ts';
import { requirePermission } from '../../middleware/require-permission.ts';
import { route } from '../../middleware/validate.ts';
import { placementSlipSummaries, qcrSummaries } from './worklists.service.ts';

/**
 * The lists across cases for the Quotes and QCR and Placement Slips pages, under /api/v1: reading
 * needs proposals.view.
 */
export function createWorklistsRouter(options: {
  jwtSecret: string;
  gstRatePercent: string;
}): Router {
  const router = Router();
  // Authenticated per route: the router sits at /api/v1, where other paths must still reach the
  // not-found answer.
  const view = [authenticate(options), requirePermission('proposals.view')];

  router.get(
    '/qcrs',
    ...view,
    route({}, async (_input, _req, res) => {
      res.json({ items: await qcrSummaries(options.gstRatePercent) });
    }),
  );

  router.get(
    '/placement-slips',
    ...view,
    route({}, async (_input, _req, res) => {
      res.json({ items: await placementSlipSummaries(options.gstRatePercent) });
    }),
  );

  return router;
}

const json = (schema: z.ZodType) => ({ content: { 'application/json': { schema } } });

documentRoute({
  method: 'get',
  path: '/api/v1/qcrs',
  tags: ['QCR'],
  summary: 'Quotes and QCRs across cases',
  description:
    'Needs proposals.view. Every open case whose RFQ has gone to an insurer, newest first: the insurers asked, quoted, declined, awaiting and overdue; the lowest total of Option 1 (else the first option quoted); the QCR’s status, recommendation, approval and last mail to the insured.',
  responses: {
    200: { description: 'The cases', ...json(QcrSummaryListSchema) },
    ...errorResponses(401, 403),
  },
});

documentRoute({
  method: 'get',
  path: '/api/v1/placement-slips',
  tags: ['Placement slip'],
  summary: 'Placement slips across cases',
  description:
    'Needs proposals.view. Every open case with a client approval, last approved first: the quote accepted, the slip’s status, approval and last mail to the insurer, and the policy or cover note recorded.',
  responses: {
    200: { description: 'The cases', ...json(PlacementSlipSummaryListSchema) },
    ...errorResponses(401, 403),
  },
});
