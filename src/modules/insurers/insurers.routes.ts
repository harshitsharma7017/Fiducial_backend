import {
  CreateInsurerRequestSchema,
  InsurerIdParamsSchema,
  InsurerListQuerySchema,
  InsurerListResponseSchema,
  InsurerSchema,
  UpdateInsurerRequestSchema,
} from '../../shared/index.ts';
import { Router } from 'express';
import { documentRoute, errorResponses } from '../../lib/openapi.ts';
import { authenticate } from '../../middleware/auth.ts';
import { currentUser, requirePermission } from '../../middleware/require-permission.ts';
import { route } from '../../middleware/validate.ts';
import { createInsurer, getInsurer, listInsurers, updateInsurer } from './insurers.service.ts';

// The insurer master is master data: everyone with masters.view reads it (the RFQ screen takes
// its recipients from here) and Admins (masters.manage) maintain it.
export function createInsurersRouter(options: { jwtSecret: string }): Router {
  const router = Router();
  router.use(authenticate(options), requirePermission('masters.view'));
  const manage = requirePermission('masters.manage');

  router.get(
    '/',
    route({ query: InsurerListQuerySchema }, async ({ query }, _req, res) => {
      res.json(await listInsurers(query));
    }),
  );

  router.post(
    '/',
    manage,
    route({ body: CreateInsurerRequestSchema }, async ({ body }, req, res) => {
      const actor = { id: currentUser(req).id, requestId: req.requestId };
      res.status(201).json(await createInsurer(body, actor));
    }),
  );

  router.get(
    '/:id',
    route({ params: InsurerIdParamsSchema }, async ({ params }, _req, res) => {
      res.json(await getInsurer(params.id));
    }),
  );

  router.patch(
    '/:id',
    manage,
    route(
      { params: InsurerIdParamsSchema, body: UpdateInsurerRequestSchema },
      async ({ params, body }, req, res) => {
        const actor = { id: currentUser(req).id, requestId: req.requestId };
        res.json(await updateInsurer(params.id, body, actor));
      },
    ),
  );

  return router;
}

documentRoute({
  method: 'get',
  path: '/api/v1/insurers',
  tags: ['Insurers'],
  summary: 'List insurers',
  description:
    'Needs masters.view. By company then branch; q matches words in either, active=true lists ' +
    'only the insurers offered for new RFQs. Each insurer carries the email addresses RFQs go ' +
    'to. Cursor pagination: pass nextCursor back as cursor.',
  request: { query: InsurerListQuerySchema },
  responses: {
    200: {
      description: 'A page of insurers',
      content: { 'application/json': { schema: InsurerListResponseSchema } },
    },
    ...errorResponses(400, 401, 403),
  },
});

documentRoute({
  method: 'post',
  path: '/api/v1/insurers',
  tags: ['Insurers'],
  summary: 'Add an insurer branch',
  description:
    'Needs masters.manage (Admin). Company and branch together must be new (409 ' +
    'INSURER_EXISTS, ignoring case and extra spaces). At least one RFQ email is required. Audited.',
  request: { body: { content: { 'application/json': { schema: CreateInsurerRequestSchema } } } },
  responses: {
    201: {
      description: 'The created insurer',
      content: { 'application/json': { schema: InsurerSchema } },
    },
    ...errorResponses(400, 401, 403, 409),
  },
});

documentRoute({
  method: 'get',
  path: '/api/v1/insurers/{id}',
  tags: ['Insurers'],
  summary: 'Get an insurer',
  description: 'Needs masters.view.',
  request: { params: InsurerIdParamsSchema },
  responses: {
    200: {
      description: 'The insurer',
      content: { 'application/json': { schema: InsurerSchema } },
    },
    ...errorResponses(400, 401, 403, 404),
  },
});

documentRoute({
  method: 'patch',
  path: '/api/v1/insurers/{id}',
  tags: ['Insurers'],
  summary: 'Edit or deactivate an insurer',
  description:
    'Needs masters.manage (Admin). Only the fields sent change; contacts and RFQ emails are ' +
    'replaced as a whole. Insurers are deactivated, never deleted. Audited with before and ' +
    'after values.',
  request: {
    params: InsurerIdParamsSchema,
    body: { content: { 'application/json': { schema: UpdateInsurerRequestSchema } } },
  },
  responses: {
    200: {
      description: 'The updated insurer',
      content: { 'application/json': { schema: InsurerSchema } },
    },
    ...errorResponses(400, 401, 403, 404, 409),
  },
});
