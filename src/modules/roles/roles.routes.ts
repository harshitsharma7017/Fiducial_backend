import {
  CreateRoleRequestSchema,
  RoleKeyParamsSchema,
  RoleListResponseSchema,
  RoleRecordSchema,
  UpdateRoleRequestSchema,
} from '../../shared/index.ts';
import { Router, type Request } from 'express';
import type { z } from 'zod';
import { documentRoute, errorResponses } from '../../lib/openapi.ts';
import { authenticate } from '../../middleware/auth.ts';
import {
  assertPermission,
  currentUser,
  requireAnyPermission,
  requirePermission,
} from '../../middleware/require-permission.ts';
import { route } from '../../middleware/validate.ts';
import {
  createRole,
  getRole,
  listRoles,
  setRoleActive,
  updateRole,
  type RoleActor,
} from './roles.service.ts';

function actorOf(req: Request): RoleActor {
  const user = currentUser(req);
  return { id: user.id, permissions: user.permissions, requestId: req.requestId };
}

/**
 * Roles under /api/v1/roles. Reading needs roles.view, or users.assign_roles (the user form lists
 * the roles that can be assigned). Creating needs roles.create, plus roles.assign_permissions when
 * the role starts with permissions; renaming roles.update; changing permissions
 * roles.assign_permissions; activating and deactivating roles.deactivate.
 */
export function createRolesRouter(options: { jwtSecret: string }): Router {
  const router = Router();
  router.use(authenticate(options));
  const read = requireAnyPermission(['roles.view', 'users.assign_roles']);

  router.get(
    '/',
    read,
    route({}, async (_input, _req, res) => {
      res.json(await listRoles());
    }),
  );

  router.post(
    '/',
    requirePermission('roles.create'),
    route({ body: CreateRoleRequestSchema }, async ({ body }, req, res) => {
      if ((body.permissions ?? []).length > 0) assertPermission(req, 'roles.assign_permissions');
      res.status(201).json(await createRole(body, actorOf(req)));
    }),
  );

  router.get(
    '/:key',
    read,
    route({ params: RoleKeyParamsSchema }, async ({ params }, _req, res) => {
      res.json(await getRole(params.key));
    }),
  );

  router.patch(
    '/:key',
    requireAnyPermission(['roles.update', 'roles.assign_permissions']),
    route(
      { params: RoleKeyParamsSchema, body: UpdateRoleRequestSchema },
      async ({ params, body }, req, res) => {
        if (body.name !== undefined || body.description !== undefined) {
          assertPermission(req, 'roles.update');
        }
        if (body.permissions !== undefined) assertPermission(req, 'roles.assign_permissions');
        res.json(await updateRole(params.key, body, actorOf(req)));
      },
    ),
  );

  router.post(
    '/:key/activate',
    requirePermission('roles.deactivate'),
    route({ params: RoleKeyParamsSchema }, async ({ params }, req, res) => {
      res.json(await setRoleActive(params.key, true, actorOf(req)));
    }),
  );

  router.post(
    '/:key/deactivate',
    requirePermission('roles.deactivate'),
    route({ params: RoleKeyParamsSchema }, async ({ params }, req, res) => {
      res.json(await setRoleActive(params.key, false, actorOf(req)));
    }),
  );

  return router;
}

const json = (schema: z.ZodType) => ({ content: { 'application/json': { schema } } });
const TAGS = ['Roles'];

documentRoute({
  method: 'get',
  path: '/api/v1/roles',
  tags: TAGS,
  summary: 'List roles',
  description:
    'Needs roles.view or users.assign_roles. Every role with its permissions (the whole catalog for the Administrator role), status and number of users.',
  responses: {
    200: {
      description: 'The roles',
      content: { 'application/json': { schema: RoleListResponseSchema } },
    },
    ...errorResponses(401, 403),
  },
});

documentRoute({
  method: 'post',
  path: '/api/v1/roles',
  tags: TAGS,
  summary: 'Create a role',
  description:
    'Needs roles.create, and roles.assign_permissions when permissions are given. Permissions must come from the catalog and be held by you (403 PERMISSION_ESCALATION). Names are unique, ignoring case and spaces (409 ROLE_NAME_TAKEN). The key is derived from the name and never changes. Audited.',
  request: { body: { content: { 'application/json': { schema: CreateRoleRequestSchema } } } },
  responses: {
    201: { description: 'The created role', ...json(RoleRecordSchema) },
    ...errorResponses(400, 401, 403, 409),
  },
});

documentRoute({
  method: 'get',
  path: '/api/v1/roles/{key}',
  tags: TAGS,
  summary: 'Get a role',
  description: 'Needs roles.view or users.assign_roles.',
  request: { params: RoleKeyParamsSchema },
  responses: {
    200: { description: 'The role', ...json(RoleRecordSchema) },
    ...errorResponses(401, 403, 404),
  },
});

documentRoute({
  method: 'patch',
  path: '/api/v1/roles/{key}',
  tags: TAGS,
  summary: 'Edit a role',
  description:
    'Needs roles.update for the name and description, roles.assign_permissions for permissions. expectedVersion must match (409 ROLE_VERSION_CONFLICT). Added permissions must be held by you. System roles keep their names; the Administrator role cannot be changed (409 ROLE_LOCKED). Takes effect on the next request of every user holding the role. Audited with before and after values.',
  request: {
    params: RoleKeyParamsSchema,
    body: { content: { 'application/json': { schema: UpdateRoleRequestSchema } } },
  },
  responses: {
    200: { description: 'The updated role', ...json(RoleRecordSchema) },
    ...errorResponses(400, 401, 403, 404, 409),
  },
});

for (const [action, summary] of [
  ['activate', 'Activate a role'],
  ['deactivate', 'Deactivate a role'],
] as const) {
  documentRoute({
    method: 'post',
    path: `/api/v1/roles/{key}/${action}`,
    tags: TAGS,
    summary,
    description:
      'Needs roles.deactivate. A role assigned to any user cannot be deactivated (409 ROLE_IN_USE); an inactive role grants nothing. The Administrator role cannot be deactivated (409 ROLE_LOCKED). Audited.',
    request: { params: RoleKeyParamsSchema },
    responses: {
      200: { description: 'The role', ...json(RoleRecordSchema) },
      ...errorResponses(401, 403, 404, 409),
    },
  });
}
