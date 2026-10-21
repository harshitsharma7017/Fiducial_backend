import {
  CreateEbCaseRequestSchema,
  EbCaseCreatedSchema,
  EbCaseListQuerySchema,
  EbCaseListResponseSchema,
  EbCensusTemplateQuerySchema,
  EbCompanyParamsSchema,
  EbEmployeeChangeResponseSchema,
  EbEmployeeListQuerySchema,
  EbEmployeeListResponseSchema,
  EbEmployeeParamsSchema,
  EbPlanDefaultParamsSchema,
  EbPlanDefaultsResponseSchema,
  ResolveEbEmployeeRequestSchema,
  SetEbPlanDefaultRequestSchema,
  UpdateEbEmployeeRequestSchema,
} from '../../shared/index.ts';
import { Router } from 'express';
import { authenticate } from '../../middleware/auth.ts';
import { requirePermission } from '../../middleware/require-permission.ts';
import { route } from '../../middleware/validate.ts';
import { listEmployees, resolveEmployee, updateEmployee } from '../employees/employees.service.ts';
import { createEbCase, listEbCases } from './eb-cases.service.ts';
import { documentEbRoute } from './eb-openapi.ts';
import { planDefaults, setPlanDefault } from './eb-plan-assignment.service.ts';
import { censusTemplateFile } from './eb-template.service.ts';
import { actorOf, sendFile } from './ghi.routes.ts';

// Employee Benefits across products under /api/v1/eb (N1, design D2): creating and listing
// cases of every product, the census templates, and a company's employees and default plans.

export function createEbRouter(options: { jwtSecret: string; gstRatePercent: string }): Router {
  const router = Router();
  router.use(authenticate(options));
  const view = requirePermission('proposals.view');
  const edit = requirePermission('proposals.edit');

  router.get(
    '/cases',
    view,
    route({ query: EbCaseListQuerySchema }, async ({ query }, _req, res) => {
      res.json(await listEbCases(query));
    }),
  );
  router.post(
    '/cases',
    requirePermission('proposals.create'),
    route({ body: CreateEbCaseRequestSchema }, async ({ body }, req, res) => {
      res
        .status(201)
        .json(
          await createEbCase(body, actorOf(req), { defaultGstRatePercent: options.gstRatePercent }),
        );
    }),
  );
  router.get(
    '/census-templates',
    view,
    route({ query: EbCensusTemplateQuerySchema }, async ({ query }, req, res) => {
      sendFile(res, await censusTemplateFile(query, actorOf(req)));
    }),
  );
  router.get(
    '/companies/:clientId/employees',
    view,
    route(
      { params: EbCompanyParamsSchema, query: EbEmployeeListQuerySchema },
      async ({ params, query }, _req, res) => {
        res.json(await listEmployees(params.clientId, query));
      },
    ),
  );
  router.post(
    '/companies/:clientId/employees/resolve',
    edit,
    route(
      { params: EbCompanyParamsSchema, body: ResolveEbEmployeeRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await resolveEmployee(params.clientId, body, actorOf(req)));
      },
    ),
  );
  router.put(
    '/companies/:clientId/employees/:employeeId',
    edit,
    route(
      { params: EbEmployeeParamsSchema, body: UpdateEbEmployeeRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await updateEmployee(params.clientId, params.employeeId, body, actorOf(req)));
      },
    ),
  );
  router.get(
    '/companies/:clientId/plan-defaults',
    requirePermission('clients.view'),
    route({ params: EbCompanyParamsSchema }, async ({ params }, _req, res) => {
      res.json(await planDefaults(params.clientId));
    }),
  );
  router.put(
    '/companies/:clientId/plan-defaults/:product',
    requirePermission('clients.manage'),
    route(
      { params: EbPlanDefaultParamsSchema, body: SetEbPlanDefaultRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await setPlanDefault(params.clientId, params.product, body.planId, actorOf(req)));
      },
    ),
  );
  return router;
}

const company = '/api/v1/eb/companies/{clientId}';
for (const item of [
  {
    method: 'get',
    path: '/api/v1/eb/cases',
    summary: 'List cases of every product',
    permission: 'proposals.view',
    query: EbCaseListQuerySchema,
    response: EbCaseListResponseSchema,
  },
  {
    method: 'post',
    path: '/api/v1/eb/cases',
    summary: 'Create a GMC, GPA or GTLI case',
    permission: 'proposals.create',
    body: CreateEbCaseRequestSchema,
    response: EbCaseCreatedSchema,
    status: 201,
  },
  {
    method: 'get',
    path: '/api/v1/eb/census-templates',
    summary: 'Download a provisional census template',
    permission: 'proposals.view',
    query: EbCensusTemplateQuerySchema,
    file: true,
  },
  {
    method: 'get',
    path: `${company}/employees`,
    summary: 'The company’s employees, unresolved first',
    permission: 'proposals.view',
    query: EbEmployeeListQuerySchema,
    response: EbEmployeeListResponseSchema,
  },
  {
    method: 'post',
    path: `${company}/employees/resolve`,
    summary: 'Resolve an unresolved employee',
    permission: 'proposals.edit',
    body: ResolveEbEmployeeRequestSchema,
    response: EbEmployeeChangeResponseSchema,
  },
  {
    method: 'put',
    path: `${company}/employees/{employeeId}`,
    summary: 'Update an employee’s details with a reason',
    permission: 'proposals.edit',
    body: UpdateEbEmployeeRequestSchema,
    response: EbEmployeeChangeResponseSchema,
  },
  {
    method: 'get',
    path: `${company}/plan-defaults`,
    summary: 'The company’s default plan per product',
    permission: 'clients.view',
    response: EbPlanDefaultsResponseSchema,
  },
  {
    method: 'put',
    path: `${company}/plan-defaults/{product}`,
    summary: 'Set or clear the company’s default plan for a product',
    permission: 'clients.manage',
    body: SetEbPlanDefaultRequestSchema,
    response: EbPlanDefaultsResponseSchema,
  },
] as const) {
  documentEbRoute(item);
}
