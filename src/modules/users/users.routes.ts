import {
  CreateUserRequestSchema,
  UpdateUserRequestSchema,
  UserIdParamsSchema,
  UserListQuerySchema,
  UserListResponseSchema,
  UserSchema,
} from '../../shared/index.ts';
import { Router } from 'express';
import { documentRoute, errorResponses } from '../../lib/openapi.ts';
import { authenticate } from '../../middleware/auth.ts';
import { currentUser, requirePermission } from '../../middleware/require-permission.ts';
import { route } from '../../middleware/validate.ts';
import { createUser, listUsers, updateUser } from './users.service.ts';

export function createUsersRouter(options: { jwtSecret: string }): Router {
  const router = Router();
  router.use(authenticate(options), requirePermission('users.manage'));

  router.get(
    '/',
    route({ query: UserListQuerySchema }, async ({ query }, _req, res) => {
      res.json(await listUsers(query));
    }),
  );

  router.post(
    '/',
    route({ body: CreateUserRequestSchema }, async ({ body }, req, res) => {
      const user = await createUser(body, { id: currentUser(req).id, requestId: req.requestId });
      res.status(201).json(user);
    }),
  );

  router.patch(
    '/:id',
    route(
      { params: UserIdParamsSchema, body: UpdateUserRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await updateUser(params.id, body, currentUser(req), req.requestId));
      },
    ),
  );

  return router;
}

documentRoute({
  method: 'get',
  path: '/api/v1/users',
  tags: ['Users'],
  summary: 'List users',
  description: 'Needs users.manage (Admin). Cursor pagination: pass nextCursor back as cursor.',
  request: { query: UserListQuerySchema },
  responses: {
    200: {
      description: 'A page of users',
      content: { 'application/json': { schema: UserListResponseSchema } },
    },
    ...errorResponses(400, 401, 403),
  },
});

documentRoute({
  method: 'post',
  path: '/api/v1/users',
  tags: ['Users'],
  summary: 'Create a user',
  description:
    'Needs users.manage (Admin). Passwords need at least 12 characters. Audited with every new value.',
  request: { body: { content: { 'application/json': { schema: CreateUserRequestSchema } } } },
  responses: {
    201: {
      description: 'The created user',
      content: { 'application/json': { schema: UserSchema } },
    },
    ...errorResponses(400, 401, 403, 409),
  },
});

documentRoute({
  method: 'patch',
  path: '/api/v1/users/{id}',
  tags: ['Users'],
  summary: "Change a user's name or roles, or deactivate them",
  description:
    'Needs users.manage (Admin). You cannot deactivate yourself or remove your own Admin role. ' +
    "Deactivation and role changes take effect on the user's next request. Audited with before " +
    'and after values.',
  request: {
    params: UserIdParamsSchema,
    body: { content: { 'application/json': { schema: UpdateUserRequestSchema } } },
  },
  responses: {
    200: {
      description: 'The updated user',
      content: { 'application/json': { schema: UserSchema } },
    },
    ...errorResponses(400, 401, 403, 404, 409),
  },
});
