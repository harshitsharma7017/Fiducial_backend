import {
  ActivateMasterVersionRequestSchema,
  MasterVersionIdParamsSchema,
  MasterVersionListQuerySchema,
  MasterVersionListResponseSchema,
  MasterVersionSchema,
  OccupancyListResponseSchema,
  OccupancySchema,
  OccupancySearchQuerySchema,
  PincodeParamsSchema,
  PincodeRecordSchema,
  TacCodeParamsSchema,
} from '../../shared/index.ts';
import { Router } from 'express';
import { documentRoute, errorResponses } from '../../lib/openapi.ts';
import { authenticate } from '../../middleware/auth.ts';
import { currentUser, requirePermission } from '../../middleware/require-permission.ts';
import { route } from '../../middleware/validate.ts';
import {
  activateMasterVersion,
  getOccupancy,
  getPincode,
  listVersions,
  searchOccupancies,
} from './masters.service.ts';

export function createMastersRouter(options: { jwtSecret: string }): Router {
  const router = Router();
  router.use(authenticate(options), requirePermission('masters.view'));

  router.get(
    '/occupancies',
    route({ query: OccupancySearchQuerySchema }, async ({ query }, _req, res) => {
      res.json(await searchOccupancies(query));
    }),
  );

  router.get(
    '/occupancies/:tacCode',
    route({ params: TacCodeParamsSchema }, async ({ params }, _req, res) => {
      res.json(await getOccupancy(params.tacCode));
    }),
  );

  router.get(
    '/pincodes/:pincode',
    route({ params: PincodeParamsSchema }, async ({ params }, _req, res) => {
      res.json(await getPincode(params.pincode));
    }),
  );

  router.get(
    '/versions',
    route({ query: MasterVersionListQuerySchema }, async ({ query }, _req, res) => {
      res.json(await listVersions(query));
    }),
  );

  router.post(
    '/versions/:id/activate',
    requirePermission('masters.manage'),
    route(
      { params: MasterVersionIdParamsSchema, body: ActivateMasterVersionRequestSchema },
      async ({ params, body }, req, res) => {
        const version = await activateMasterVersion(params.id, {
          effectiveFrom: body.effectiveFrom,
          actorId: currentUser(req).id,
          requestId: req.requestId,
        });
        res.json(version);
      },
    ),
  );

  return router;
}

documentRoute({
  method: 'get',
  path: '/api/v1/masters/occupancies',
  tags: ['Masters'],
  summary: 'Search occupancies',
  description:
    'Matches the TAC code by prefix or the description by contained text, case-insensitive. ' +
    'Without q, lists every occupancy in sheet order. Rates are per mille, as strings.',
  request: { query: OccupancySearchQuerySchema },
  responses: {
    200: {
      description: 'A page of occupancies',
      content: { 'application/json': { schema: OccupancyListResponseSchema } },
    },
    ...errorResponses(400, 401, 403, 409),
  },
});

documentRoute({
  method: 'get',
  path: '/api/v1/masters/occupancies/{tacCode}',
  tags: ['Masters'],
  summary: 'Get an occupancy by TAC code',
  request: { params: TacCodeParamsSchema },
  responses: {
    200: {
      description: 'The occupancy',
      content: { 'application/json': { schema: OccupancySchema } },
    },
    ...errorResponses(400, 401, 403, 404, 409),
  },
});

documentRoute({
  method: 'get',
  path: '/api/v1/masters/pincodes/{pincode}',
  tags: ['Masters'],
  summary: 'Look up a pincode',
  description: 'State, district, AIFT earthquake zone and the EQ rates by risk type.',
  request: { params: PincodeParamsSchema },
  responses: {
    200: {
      description: 'The pincode',
      content: { 'application/json': { schema: PincodeRecordSchema } },
    },
    ...errorResponses(400, 401, 403, 404, 409),
  },
});

documentRoute({
  method: 'get',
  path: '/api/v1/masters/versions',
  tags: ['Masters'],
  summary: 'List master versions',
  description: 'Newest first. Filter by type and status, for example status=ACTIVE.',
  request: { query: MasterVersionListQuerySchema },
  responses: {
    200: {
      description: 'A page of master versions',
      content: { 'application/json': { schema: MasterVersionListResponseSchema } },
    },
    ...errorResponses(400, 401, 403),
  },
});

documentRoute({
  method: 'post',
  path: '/api/v1/masters/versions/{id}/activate',
  tags: ['Masters'],
  summary: 'Activate a DRAFT master version',
  description:
    'Needs masters.manage (Admin). The current ACTIVE version of the same type becomes ' +
    'SUPERSEDED. effectiveFrom defaults to now and cannot be in the future. Both versions are ' +
    'audited with their old and new values.',
  request: {
    params: MasterVersionIdParamsSchema,
    body: {
      required: false,
      content: { 'application/json': { schema: ActivateMasterVersionRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The activated version',
      content: { 'application/json': { schema: MasterVersionSchema } },
    },
    ...errorResponses(400, 401, 403, 404, 409),
  },
});
