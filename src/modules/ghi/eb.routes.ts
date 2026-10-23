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
  EB_PRODUCTS,
  casePermission,
} from '../../shared/index.ts';
import { Router } from 'express';
import { authenticate } from '../../middleware/auth.ts';
import {
  assertPermission,
  requireAnyPermission,
  requirePermission,
  userCan,
} from '../../middleware/require-permission.ts';
import { route } from '../../middleware/validate.ts';
import { listEmployees, resolveEmployee, updateEmployee } from '../employees/employees.service.ts';
import { createEbCase, listEbCases } from './eb-cases.service.ts';
import { documentEbRoute } from './eb-openapi.ts';
import { planDefaults, setPlanDefault } from './eb-plan-assignment.service.ts';
import { censusTemplateFile } from './eb-template.service.ts';
import { hiddenFields, redactEmployee } from './member-redaction.ts';
import { actorOf, sendFile } from './ghi.routes.ts';

// Employee Benefits across products under /api/v1/eb (N1, design D2): creating and listing
// cases of every product, the census templates, and a company's employees and default plans.
// Product routes need that product's permission (checked once the product is known); a list
// without a product covers the products the user may view.

export function createEbRouter(options: { jwtSecret: string; gstRatePercent: string }): Router {
  const router = Router();
  router.use(authenticate(options));
  const anyView = requireAnyPermission(
    EB_PRODUCTS.map((product) => casePermission(product, 'view')),
  );

  router.get(
    '/cases',
    anyView,
    route({ query: EbCaseListQuerySchema }, async ({ query }, req, res) => {
      if (query.product) assertPermission(req, casePermission(query.product, 'view'));
      const products = EB_PRODUCTS.filter((product) =>
        userCan(req, casePermission(product, 'view')),
      );
      res.json(await listEbCases(query, products));
    }),
  );
  router.post(
    '/cases',
    requireAnyPermission(EB_PRODUCTS.map((product) => casePermission(product, 'create'))),
    route({ body: CreateEbCaseRequestSchema }, async ({ body }, req, res) => {
      assertPermission(req, casePermission(body.product, 'create'));
      res
        .status(201)
        .json(
          await createEbCase(body, actorOf(req), { defaultGstRatePercent: options.gstRatePercent }),
        );
    }),
  );
  router.get(
    '/census-templates',
    anyView,
    route({ query: EbCensusTemplateQuerySchema }, async ({ query }, req, res) => {
      assertPermission(req, casePermission(query.product, 'view'));
      sendFile(res, await censusTemplateFile(query, actorOf(req)));
    }),
  );
  router.get(
    '/companies/:clientId/employees',
    requirePermission('employees.view'),
    route(
      { params: EbCompanyParamsSchema, query: EbEmployeeListQuerySchema },
      async ({ params, query }, req, res) => {
        const list = await listEmployees(params.clientId, query);
        const hidden = hiddenFields(req);
        res.json({
          ...list,
          items: list.items.map((employee) => redactEmployee(employee, hidden)),
        });
      },
    ),
  );
  router.post(
    '/companies/:clientId/employees/resolve',
    requirePermission('employees.update'),
    requirePermission('employees.view_dob'),
    route(
      { params: EbCompanyParamsSchema, body: ResolveEbEmployeeRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await resolveEmployee(params.clientId, body, actorOf(req)));
      },
    ),
  );
  router.put(
    '/companies/:clientId/employees/:employeeId',
    requirePermission('employees.update'),
    requirePermission('employees.view_dob'),
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
    requirePermission('clients.update'),
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
    permission: 'gmc.view | gpa.view | gtli.view (the products listed)',
    query: EbCaseListQuerySchema,
    response: EbCaseListResponseSchema,
  },
  {
    method: 'post',
    path: '/api/v1/eb/cases',
    summary: 'Create a GMC, GPA or GTLI case',
    permission: '<product>.create',
    body: CreateEbCaseRequestSchema,
    response: EbCaseCreatedSchema,
    status: 201,
  },
  {
    method: 'get',
    path: '/api/v1/eb/census-templates',
    summary: 'Download a provisional census template',
    permission: '<product>.view',
    query: EbCensusTemplateQuerySchema,
    file: true,
  },
  {
    method: 'get',
    path: `${company}/employees`,
    summary: 'The company’s employees, unresolved first',
    permission: 'employees.view (dates of birth need employees.view_dob)',
    query: EbEmployeeListQuerySchema,
    response: EbEmployeeListResponseSchema,
  },
  {
    method: 'post',
    path: `${company}/employees/resolve`,
    summary: 'Resolve an unresolved employee',
    permission: 'employees.update and employees.view_dob',
    body: ResolveEbEmployeeRequestSchema,
    response: EbEmployeeChangeResponseSchema,
  },
  {
    method: 'put',
    path: `${company}/employees/{employeeId}`,
    summary: 'Update an employee’s details with a reason',
    permission: 'employees.update and employees.view_dob',
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
    permission: 'clients.update',
    body: SetEbPlanDefaultRequestSchema,
    response: EbPlanDefaultsResponseSchema,
  },
] as const) {
  documentEbRoute(item);
}
