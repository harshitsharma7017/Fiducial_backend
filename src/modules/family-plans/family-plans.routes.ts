import {
  CreateFamilyPlanRequestSchema,
  FamilyPlanListQuerySchema,
  FamilyPlanListResponseSchema,
  FamilyPlanOpenCasesResponseSchema,
  FamilyPlanParamsSchema,
  FamilyPlanSchema,
  FamilyPlanVersionParamsSchema,
  PlanVersionInputSchema,
  RenameFamilyPlanRequestSchema,
  SetPlanVersionEndRequestSchema,
} from '../../shared/index.ts';
import { Router } from 'express';
import { authenticate } from '../../middleware/auth.ts';
import { requirePermission } from '../../middleware/require-permission.ts';
import { route } from '../../middleware/validate.ts';
import { documentEbRoute } from '../ghi/eb-openapi.ts';
import { actorOf } from '../ghi/ghi.routes.ts';
import {
  activateVersion,
  confirmVersion,
  createPlan,
  createVersion,
  getPlan,
  listPlans,
  openCasesUsing,
  renamePlan,
  setEffectiveTo,
  setPlanActive,
  updateDraftVersion,
} from './family-plans.service.ts';

// The Family Plan Master (N2) under /api/v1/family-plans: reading needs masters.view, every
// change masters.manage (Requirement 24.1). There is no delete route (12.10).

export function createFamilyPlansRouter(options: { jwtSecret: string }): Router {
  const router = Router();
  router.use(authenticate(options));
  const view = requirePermission('masters.view');
  const manage = requirePermission('masters.manage');

  router.get(
    '/',
    view,
    route({ query: FamilyPlanListQuerySchema }, async ({ query }, _req, res) => {
      res.json(await listPlans(query));
    }),
  );
  router.post(
    '/',
    manage,
    route({ body: CreateFamilyPlanRequestSchema }, async ({ body }, req, res) => {
      res.status(201).json(await createPlan(body, actorOf(req)));
    }),
  );
  router.get(
    '/:planId',
    view,
    route({ params: FamilyPlanParamsSchema }, async ({ params }, _req, res) => {
      res.json(await getPlan(params.planId));
    }),
  );
  router.put(
    '/:planId',
    manage,
    route(
      { params: FamilyPlanParamsSchema, body: RenameFamilyPlanRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await renamePlan(params.planId, body.name, actorOf(req)));
      },
    ),
  );
  router.post(
    '/:planId/activate',
    manage,
    route({ params: FamilyPlanParamsSchema }, async ({ params }, req, res) => {
      res.json(await setPlanActive(params.planId, true, actorOf(req)));
    }),
  );
  router.post(
    '/:planId/deactivate',
    manage,
    route({ params: FamilyPlanParamsSchema }, async ({ params }, req, res) => {
      res.json(await setPlanActive(params.planId, false, actorOf(req)));
    }),
  );
  router.get(
    '/:planId/open-cases',
    manage,
    route({ params: FamilyPlanParamsSchema }, async ({ params }, _req, res) => {
      res.json(await openCasesUsing(params.planId));
    }),
  );
  router.post(
    '/:planId/versions',
    manage,
    route(
      { params: FamilyPlanParamsSchema, body: PlanVersionInputSchema },
      async ({ params, body }, req, res) => {
        res.status(201).json(await createVersion(params.planId, body, actorOf(req)));
      },
    ),
  );
  router.put(
    '/:planId/versions/:number',
    manage,
    route(
      { params: FamilyPlanVersionParamsSchema, body: PlanVersionInputSchema },
      async ({ params, body }, req, res) => {
        res.json(await updateDraftVersion(params.planId, params.number, body, actorOf(req)));
      },
    ),
  );
  router.post(
    '/:planId/versions/:number/activate',
    manage,
    route({ params: FamilyPlanVersionParamsSchema }, async ({ params }, req, res) => {
      res.json(await activateVersion(params.planId, params.number, actorOf(req)));
    }),
  );
  router.put(
    '/:planId/versions/:number/effective-to',
    manage,
    route(
      { params: FamilyPlanVersionParamsSchema, body: SetPlanVersionEndRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(
          await setEffectiveTo(params.planId, params.number, body.effectiveTo, actorOf(req)),
        );
      },
    ),
  );
  router.post(
    '/:planId/versions/:number/confirm',
    manage,
    route({ params: FamilyPlanVersionParamsSchema }, async ({ params }, req, res) => {
      res.json(await confirmVersion(params.planId, params.number, actorOf(req)));
    }),
  );
  return router;
}

const base = '/api/v1/family-plans';
const plan = `${base}/{planId}`;
for (const item of [
  {
    method: 'get',
    path: base,
    summary: 'List family plans by product',
    permission: 'masters.view',
    query: FamilyPlanListQuerySchema,
    response: FamilyPlanListResponseSchema,
  },
  {
    method: 'post',
    path: base,
    summary: 'Create a family plan with its first (Draft) version',
    permission: 'masters.manage',
    body: CreateFamilyPlanRequestSchema,
    response: FamilyPlanSchema,
    status: 201,
  },
  {
    method: 'get',
    path: plan,
    summary: 'A family plan with every version',
    permission: 'masters.view',
    response: FamilyPlanSchema,
  },
  {
    method: 'put',
    path: plan,
    summary: 'Rename a family plan (code and product never change)',
    permission: 'masters.manage',
    body: RenameFamilyPlanRequestSchema,
    response: FamilyPlanSchema,
  },
  {
    method: 'post',
    path: `${plan}/activate`,
    summary: 'Activate a plan',
    permission: 'masters.manage',
    response: FamilyPlanSchema,
  },
  {
    method: 'post',
    path: `${plan}/deactivate`,
    summary: 'Deactivate a plan (assignments stay)',
    permission: 'masters.manage',
    response: FamilyPlanSchema,
  },
  {
    method: 'get',
    path: `${plan}/open-cases`,
    summary: 'Open cases that use the plan',
    permission: 'masters.manage',
    response: FamilyPlanOpenCasesResponseSchema,
  },
  {
    method: 'post',
    path: `${plan}/versions`,
    summary: 'Create a Draft version',
    permission: 'masters.manage',
    body: PlanVersionInputSchema,
    response: FamilyPlanSchema,
    status: 201,
  },
  {
    method: 'put',
    path: `${plan}/versions/{number}`,
    summary: 'Edit a Draft version',
    permission: 'masters.manage',
    body: PlanVersionInputSchema,
    response: FamilyPlanSchema,
  },
  {
    method: 'post',
    path: `${plan}/versions/{number}/activate`,
    summary: 'Activate a Draft version',
    permission: 'masters.manage',
    response: FamilyPlanSchema,
  },
  {
    method: 'put',
    path: `${plan}/versions/{number}/effective-to`,
    summary: 'Set an Active version’s end date (once)',
    permission: 'masters.manage',
    body: SetPlanVersionEndRequestSchema,
    response: FamilyPlanSchema,
  },
  {
    method: 'post',
    path: `${plan}/versions/{number}/confirm`,
    summary: 'Record the client’s confirmation of a version',
    permission: 'masters.manage',
    response: FamilyPlanSchema,
  },
] as const) {
  documentEbRoute(item, 'Family plans');
}
