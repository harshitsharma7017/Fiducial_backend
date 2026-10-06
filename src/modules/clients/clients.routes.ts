import {
  ClientIdParamsSchema,
  ClientListQuerySchema,
  ClientListResponseSchema,
  ClientLocationListQuerySchema,
  ClientLocationListResponseSchema,
  ClientLocationParamsSchema,
  ClientLocationSchema,
  ClientSchema,
  CreateClientLocationRequestSchema,
  CreateClientRequestSchema,
  UpdateClientLocationRequestSchema,
  UpdateClientRequestSchema,
} from '../../shared/index.ts';
import { Router, type Request } from 'express';
import { documentRoute, errorResponses } from '../../lib/openapi.ts';
import { authenticate } from '../../middleware/auth.ts';
import { currentUser, requirePermission } from '../../middleware/require-permission.ts';
import { route } from '../../middleware/validate.ts';
import {
  createClient,
  createClientLocation,
  getClient,
  listClientLocations,
  listClients,
  updateClient,
  updateClientLocation,
  type Actor,
} from './clients.service.ts';

function actorOf(req: Request): Actor {
  return { id: currentUser(req).id, requestId: req.requestId };
}

export function createClientsRouter(options: { jwtSecret: string }): Router {
  const router = Router();
  router.use(authenticate(options));
  const view = requirePermission('clients.view');
  const manage = requirePermission('clients.manage');

  router.get(
    '/',
    view,
    route({ query: ClientListQuerySchema }, async ({ query }, _req, res) => {
      res.json(await listClients(query));
    }),
  );

  router.post(
    '/',
    manage,
    route({ body: CreateClientRequestSchema }, async ({ body }, req, res) => {
      res.status(201).json(await createClient(body, actorOf(req)));
    }),
  );

  router.get(
    '/:id',
    view,
    route({ params: ClientIdParamsSchema }, async ({ params }, _req, res) => {
      res.json(await getClient(params.id));
    }),
  );

  router.patch(
    '/:id',
    manage,
    route(
      { params: ClientIdParamsSchema, body: UpdateClientRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await updateClient(params.id, body, actorOf(req)));
      },
    ),
  );

  router.get(
    '/:id/locations',
    view,
    route(
      { params: ClientIdParamsSchema, query: ClientLocationListQuerySchema },
      async ({ params, query }, _req, res) => {
        res.json(await listClientLocations(params.id, query));
      },
    ),
  );

  router.post(
    '/:id/locations',
    manage,
    route(
      { params: ClientIdParamsSchema, body: CreateClientLocationRequestSchema },
      async ({ params, body }, req, res) => {
        res.status(201).json(await createClientLocation(params.id, body, actorOf(req)));
      },
    ),
  );

  router.patch(
    '/:id/locations/:locationId',
    manage,
    route(
      { params: ClientLocationParamsSchema, body: UpdateClientLocationRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await updateClientLocation(params.id, params.locationId, body, actorOf(req)));
      },
    ),
  );

  return router;
}

documentRoute({
  method: 'get',
  path: '/api/v1/clients',
  tags: ['Clients'],
  summary: 'List clients',
  description:
    'Needs clients.view. In name order; q matches words in the name or the start of the GSTIN. ' +
    'Cursor pagination: pass nextCursor back as cursor.',
  request: { query: ClientListQuerySchema },
  responses: {
    200: {
      description: 'A page of clients',
      content: { 'application/json': { schema: ClientListResponseSchema } },
    },
    ...errorResponses(400, 401, 403),
  },
});

documentRoute({
  method: 'post',
  path: '/api/v1/clients',
  tags: ['Clients'],
  summary: 'Create a client',
  description:
    'Needs clients.manage. The GSTIN is checked for format, state code and check digit, and ' +
    'must not belong to another client (409 GSTIN_TAKEN). The occupancy code must be in the ' +
    'active occupancy master. Audited with every new value.',
  request: { body: { content: { 'application/json': { schema: CreateClientRequestSchema } } } },
  responses: {
    201: {
      description: 'The created client',
      content: { 'application/json': { schema: ClientSchema } },
    },
    ...errorResponses(400, 401, 403, 409),
  },
});

documentRoute({
  method: 'get',
  path: '/api/v1/clients/{id}',
  tags: ['Clients'],
  summary: 'Get a client',
  description: 'Needs clients.view.',
  request: { params: ClientIdParamsSchema },
  responses: {
    200: {
      description: 'The client',
      content: { 'application/json': { schema: ClientSchema } },
    },
    ...errorResponses(400, 401, 403, 404),
  },
});

documentRoute({
  method: 'patch',
  path: '/api/v1/clients/{id}',
  tags: ['Clients'],
  summary: 'Edit a client',
  description:
    'Needs clients.manage. Only the fields sent change; contacts are replaced as a whole. ' +
    'Audited with before and after values.',
  request: {
    params: ClientIdParamsSchema,
    body: { content: { 'application/json': { schema: UpdateClientRequestSchema } } },
  },
  responses: {
    200: {
      description: 'The updated client',
      content: { 'application/json': { schema: ClientSchema } },
    },
    ...errorResponses(400, 401, 403, 404, 409),
  },
});

documentRoute({
  method: 'get',
  path: '/api/v1/clients/{id}/locations',
  tags: ['Clients'],
  summary: "List a client's risk locations",
  description: 'Needs clients.view. In the order they were added; cursor pagination.',
  request: { params: ClientIdParamsSchema, query: ClientLocationListQuerySchema },
  responses: {
    200: {
      description: 'A page of risk locations',
      content: { 'application/json': { schema: ClientLocationListResponseSchema } },
    },
    ...errorResponses(400, 401, 403, 404),
  },
});

documentRoute({
  method: 'post',
  path: '/api/v1/clients/{id}/locations',
  tags: ['Clients'],
  summary: 'Add a risk location',
  description:
    'Needs clients.manage. A client can have any number of locations. The pincode must be in ' +
    'the active pincode master, which supplies the state, district and EQ zone. Leave ' +
    "occupancyCode null when the location has the client's occupancy. Audited.",
  request: {
    params: ClientIdParamsSchema,
    body: { content: { 'application/json': { schema: CreateClientLocationRequestSchema } } },
  },
  responses: {
    201: {
      description: 'The added location',
      content: { 'application/json': { schema: ClientLocationSchema } },
    },
    ...errorResponses(400, 401, 403, 404, 409),
  },
});

documentRoute({
  method: 'patch',
  path: '/api/v1/clients/{id}/locations/{locationId}',
  tags: ['Clients'],
  summary: 'Edit a risk location',
  description:
    'Needs clients.manage. Only the fields sent change; a new pincode is looked up again. ' +
    'Audited with before and after values.',
  request: {
    params: ClientLocationParamsSchema,
    body: { content: { 'application/json': { schema: UpdateClientLocationRequestSchema } } },
  },
  responses: {
    200: {
      description: 'The updated location',
      content: { 'application/json': { schema: ClientLocationSchema } },
    },
    ...errorResponses(400, 401, 403, 404, 409),
  },
});
