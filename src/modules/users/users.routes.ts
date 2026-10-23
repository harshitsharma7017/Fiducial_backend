import {
  CreateUserRequestSchema,
  UpdateUserRequestSchema,
  UserIdParamsSchema,
  UserListQuerySchema,
  UserListResponseSchema,
  UserSchema,
} from '../../shared/index.ts';
import { Router, type Request } from 'express';
import { documentRoute, errorResponses } from '../../lib/openapi.ts';
import { authenticate } from '../../middleware/auth.ts';
import {
  assertPermission,
  currentUser,
  requireAnyPermission,
  requirePermission,
} from '../../middleware/require-permission.ts';
import { route } from '../../middleware/validate.ts';
import { createUser, listUsers, updateUser, type UserActor } from './users.service.ts';

function actorOf(req: Request): UserActor {
  const user = currentUser(req);
  return { id: user.id, permissions: user.permissions, requestId: req.requestId };
}

export function createUsersRouter(options: { jwtSecret: string }): Router {
  const router = Router();
  router.use(authenticate(options));

  router.get(
    '/',
    requirePermission('users.view'),
    route({ query: UserListQuerySchema }, async ({ query }, _req, res) => {
      res.json(await listUsers(query));
    }),
  );

  // A new user always gets roles, so creating also needs users.assign_roles.
  router.post(
    '/',
    requirePermission('users.create'),
    requirePermission('users.assign_roles'),
    route({ body: CreateUserRequestSchema }, async ({ body }, req, res) => {
      res.status(201).json(await createUser(body, actorOf(req)));
    }),
  );

  // Each field needs its own permission: name users.update, roles users.assign_roles, active
  // users.deactivate.
  router.patch(
    '/:id',
    requireAnyPermission(['users.update', 'users.assign_roles', 'users.deactivate']),
    route(
      { params: UserIdParamsSchema, body: UpdateUserRequestSchema },
      async ({ params, body }, req, res) => {
        if (body.name !== undefined) assertPermission(req, 'users.update');
        if (body.roles !== undefined) assertPermission(req, 'users.assign_roles');
        if (body.active !== undefined) assertPermission(req, 'users.deactivate');
        res.json(await updateUser(params.id, body, actorOf(req)));
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
  description:
    'Needs users.view. Cursor pagination: pass nextCursor back as cursor. Each user lists role keys and names.',
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
    'Needs users.create and users.assign_roles. Roles are role keys; each must exist and be active, and together they may grant only permissions you hold (403 PERMISSION_ESCALATION). Passwords need at least 12 characters. Audited with every new value.',
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
    'Needs users.update for the name, users.assign_roles for roles, users.deactivate for active. You cannot deactivate yourself or remove your own Administrator role; you can only manage users whose access is within yours; at least one active user keeps the Administrator role (409 LAST_ADMIN). Changes take effect on the user’s next request. Audited with before and after values.',
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
