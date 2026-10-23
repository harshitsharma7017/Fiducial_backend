import {
  AgeBandSetInputSchema,
  AgeBandSetListResponseSchema,
  AgeBandSetParamsSchema,
  AgeBandSetSchema,
} from '../../shared/index.ts';
import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth.ts';
import { requirePermission } from '../../middleware/require-permission.ts';
import { route } from '../../middleware/validate.ts';
import { documentEbRoute } from '../ghi/eb-openapi.ts';
import { actorOf } from '../ghi/ghi.routes.ts';
import {
  casesUsingSet,
  createAgeBandSet,
  getAgeBandSet,
  listAgeBandSets,
  setAgeBandSetActive,
  updateAgeBandSet,
} from './age-bands.service.ts';

// The Age Band Master (N4) under /api/v1/age-bands: reading needs age_bands.view, every change
// age_bands.manage. There is no delete: a set can be deactivated, and cases keep their copies.

const ListQuerySchema = z.strictObject({
  active: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});
const CasesResponseSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      product: z.enum(['GMC', 'GPA', 'GTLI']),
      reference: z.string(),
      stage: z.string(),
      revision: z.number().int(),
      outdated: z.boolean(),
    }),
  ),
});

export function createAgeBandsRouter(options: { jwtSecret: string }): Router {
  const router = Router();
  router.use(authenticate(options));
  const view = requirePermission('age_bands.view');
  const manage = requirePermission('age_bands.manage');
  router.get(
    '/',
    view,
    route({ query: ListQuerySchema }, async ({ query }, _req, res) => {
      res.json(await listAgeBandSets(query));
    }),
  );
  router.post(
    '/',
    manage,
    route({ body: AgeBandSetInputSchema }, async ({ body }, req, res) => {
      res.status(201).json(await createAgeBandSet(body, actorOf(req)));
    }),
  );
  router.get(
    '/:setId',
    view,
    route({ params: AgeBandSetParamsSchema }, async ({ params }, _req, res) => {
      res.json(await getAgeBandSet(params.setId));
    }),
  );
  router.put(
    '/:setId',
    manage,
    route(
      { params: AgeBandSetParamsSchema, body: AgeBandSetInputSchema },
      async ({ params, body }, req, res) => {
        res.json(await updateAgeBandSet(params.setId, body, actorOf(req)));
      },
    ),
  );
  router.post(
    '/:setId/activate',
    manage,
    route({ params: AgeBandSetParamsSchema }, async ({ params }, req, res) => {
      res.json(await setAgeBandSetActive(params.setId, true, actorOf(req)));
    }),
  );
  router.post(
    '/:setId/deactivate',
    manage,
    route({ params: AgeBandSetParamsSchema }, async ({ params }, req, res) => {
      res.json(await setAgeBandSetActive(params.setId, false, actorOf(req)));
    }),
  );
  router.get(
    '/:setId/cases',
    view,
    route({ params: AgeBandSetParamsSchema }, async ({ params }, _req, res) => {
      res.json(await casesUsingSet(params.setId));
    }),
  );
  return router;
}

const base = '/api/v1/age-bands';
const one = `${base}/{setId}`;
for (const item of [
  {
    method: 'get',
    path: base,
    summary: 'List age band sets',
    permission: 'age_bands.view',
    query: ListQuerySchema,
    response: AgeBandSetListResponseSchema,
  },
  {
    method: 'post',
    path: base,
    summary: 'Create an age band set',
    permission: 'age_bands.manage',
    body: AgeBandSetInputSchema,
    response: AgeBandSetSchema,
    status: 201,
  },
  {
    method: 'get',
    path: one,
    summary: 'An age band set',
    permission: 'age_bands.view',
    response: AgeBandSetSchema,
  },
  {
    method: 'put',
    path: one,
    summary: 'Edit an age band set (its revision rises; cases keep their copies)',
    permission: 'age_bands.manage',
    body: AgeBandSetInputSchema,
    response: AgeBandSetSchema,
  },
  {
    method: 'post',
    path: `${one}/activate`,
    summary: 'Activate an age band set',
    permission: 'age_bands.manage',
    response: AgeBandSetSchema,
  },
  {
    method: 'post',
    path: `${one}/deactivate`,
    summary: 'Deactivate an age band set',
    permission: 'age_bands.manage',
    response: AgeBandSetSchema,
  },
  {
    method: 'get',
    path: `${one}/cases`,
    summary: 'Open cases holding a copy of the set',
    permission: 'age_bands.view',
    response: CasesResponseSchema,
  },
] as const) {
  documentEbRoute(item, 'Age bands');
}
