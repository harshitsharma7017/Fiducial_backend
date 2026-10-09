import {
  ActivateMasterVersionRequestSchema,
  CreateOccupancyRequestSchema,
  CreatePincodeRequestSchema,
  PincodeListQuerySchema,
  PincodeListResponseSchema,
  UpdateOccupancyRequestSchema,
  UpdatePincodeRequestSchema,
  MASTER_WORKBOOK_MAX_BYTES,
  MasterImportQuerySchema,
  MasterImportResultSchema,
  MasterWorkbookQuerySchema,
  XLSX_CONTENT_TYPE,
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
import express, { Router, type Request } from 'express';
import { z } from 'zod';
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
import {
  createOccupancy,
  createPincode,
  listPincodes,
  updateOccupancy,
  updatePincode,
} from './master-rows.service.ts';
import { masterWorkbook, uploadMasters } from './master-workbook.service.ts';

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

  router.get(
    '/pincodes',
    route({ query: PincodeListQuerySchema }, async ({ query }, _req, res) => {
      res.json(await listPincodes(query));
    }),
  );

  const manage = requirePermission('masters.manage');
  const actorOf = (req: Request) => ({ id: currentUser(req).id, requestId: req.requestId });

  router.post(
    '/occupancies',
    manage,
    route({ body: CreateOccupancyRequestSchema }, async ({ body }, req, res) => {
      res.status(201).json(await createOccupancy(body, actorOf(req)));
    }),
  );

  router.patch(
    '/occupancies/:tacCode',
    manage,
    route(
      { params: TacCodeParamsSchema, body: UpdateOccupancyRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await updateOccupancy(params.tacCode, body, actorOf(req)));
      },
    ),
  );

  router.post(
    '/pincodes',
    manage,
    route({ body: CreatePincodeRequestSchema }, async ({ body }, req, res) => {
      res.status(201).json(await createPincode(body, actorOf(req)));
    }),
  );

  router.patch(
    '/pincodes/:pincode',
    manage,
    route(
      { params: PincodeParamsSchema, body: UpdatePincodeRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await updatePincode(params.pincode, body, actorOf(req)));
      },
    ),
  );

  router.get(
    '/workbook',
    route({ query: MasterWorkbookQuerySchema }, async ({ query }, _req, res) => {
      const file = await masterWorkbook(query.template);
      const name = query.template
        ? 'IIB-master-template.xlsx'
        : `IIB-master-${new Date().toISOString().slice(0, 10)}.xlsx`;
      res.setHeader('Content-Type', XLSX_CONTENT_TYPE);
      res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
      res.send(file);
    }),
  );

  router.post(
    '/import',
    requirePermission('masters.manage'),
    express.raw({
      type: [XLSX_CONTENT_TYPE, 'application/octet-stream'],
      limit: MASTER_WORKBOOK_MAX_BYTES,
    }),
    route(
      { query: MasterImportQuerySchema, body: MasterUploadSchema },
      async ({ query, body }, req, res) => {
        const actor = { id: currentUser(req).id, requestId: req.requestId };
        res.json(await uploadMasters(body, query, actor));
      },
    ),
  );

  return router;
}

const MasterUploadSchema = z.instanceof(Buffer, {
  error: 'Upload the IIB workbook (.xlsx) as the request body',
});

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

documentRoute({
  method: 'get',
  path: '/api/v1/masters/workbook',
  tags: ['Masters'],
  summary: 'Download the active masters as an IIB workbook',
  description:
    'The active occupancy and pincode masters in the IIB workbook layout ("IIB Code" and ' +
    '"Pincode" sheets), to edit and upload as the next version. template=true returns the ' +
    'headers only. Needs masters.view; 409 MASTER_NOT_ACTIVE when no master is active.',
  request: { query: MasterWorkbookQuerySchema },
  responses: {
    200: {
      description: 'The workbook',
      content: { [XLSX_CONTENT_TYPE]: { schema: z.string().meta({ format: 'binary' }) } },
    },
    ...errorResponses(400, 401, 403, 409),
  },
});

documentRoute({
  method: 'post',
  path: '/api/v1/masters/import',
  tags: ['Masters'],
  summary: 'Preview or import an IIB workbook',
  description:
    'Needs masters.manage (Admin). Send the .xlsx as the request body (up to 20 MB). With ' +
    'dryRun=true (the default) nothing is saved and the validation report is returned. With ' +
    'dryRun=false the occupancy and pincode masters are saved as new DRAFT versions (audited); ' +
    'activate them with POST /api/v1/masters/versions/{id}/activate. The same file uploaded ' +
    'again creates nothing. A wrong layout comes back as fileError, not an HTTP error.',
  request: {
    query: MasterImportQuerySchema,
    body: { content: { [XLSX_CONTENT_TYPE]: { schema: z.string().meta({ format: 'binary' }) } } },
  },
  responses: {
    200: {
      description: 'The validation report, and the versions created',
      content: { 'application/json': { schema: MasterImportResultSchema } },
    },
    ...errorResponses(400, 401, 403, 413),
  },
});

documentRoute({
  method: 'get',
  path: '/api/v1/masters/pincodes',
  tags: ['Masters'],
  summary: 'List pincodes',
  description:
    'Pincodes of the active master in pincode order. q is the start of a pincode (400) or words ' +
    'in the district or state. Cursor pagination: pass nextCursor (a pincode) back as cursor.',
  request: { query: PincodeListQuerySchema },
  responses: {
    200: {
      description: 'A page of pincodes',
      content: { 'application/json': { schema: PincodeListResponseSchema } },
    },
    ...errorResponses(400, 401, 403, 409),
  },
});

documentRoute({
  method: 'post',
  path: '/api/v1/masters/occupancies',
  tags: ['Masters'],
  summary: 'Add an occupancy to the active master',
  description:
    'Needs masters.manage (Admin). The TAC code must be new in the active version. Audited ' +
    'with every value. Bulk changes are uploaded as a new version instead.',
  request: {
    body: { content: { 'application/json': { schema: CreateOccupancyRequestSchema } } },
  },
  responses: {
    201: {
      description: 'The added occupancy',
      content: { 'application/json': { schema: OccupancySchema } },
    },
    ...errorResponses(400, 401, 403, 409),
  },
});

documentRoute({
  method: 'patch',
  path: '/api/v1/masters/occupancies/{tacCode}',
  tags: ['Masters'],
  summary: 'Correct an occupancy in the active master',
  description:
    'Needs masters.manage (Admin). Send every editable field (blank values as null). The ' +
    'change applies at once to lookups and the forms, and is audited with each ' +
    "field's old and new value.",
  request: {
    params: TacCodeParamsSchema,
    body: { content: { 'application/json': { schema: UpdateOccupancyRequestSchema } } },
  },
  responses: {
    200: {
      description: 'The corrected occupancy',
      content: { 'application/json': { schema: OccupancySchema } },
    },
    ...errorResponses(400, 401, 403, 404, 409),
  },
});

documentRoute({
  method: 'post',
  path: '/api/v1/masters/pincodes',
  tags: ['Masters'],
  summary: 'Add a pincode to the active master',
  description:
    'Needs masters.manage (Admin). The pincode must be new in the active version. Audited with ' +
    'every value.',
  request: {
    body: { content: { 'application/json': { schema: CreatePincodeRequestSchema } } },
  },
  responses: {
    201: {
      description: 'The added pincode',
      content: { 'application/json': { schema: PincodeRecordSchema } },
    },
    ...errorResponses(400, 401, 403, 409),
  },
});

documentRoute({
  method: 'patch',
  path: '/api/v1/masters/pincodes/{pincode}',
  tags: ['Masters'],
  summary: 'Correct a pincode in the active master',
  description:
    'Needs masters.manage (Admin). Send every editable field (blank values as null). Audited ' +
    "with each field's old and new value. Locations already saved keep the state, district and " +
    'zone they were given.',
  request: {
    params: PincodeParamsSchema,
    body: { content: { 'application/json': { schema: UpdatePincodeRequestSchema } } },
  },
  responses: {
    200: {
      description: 'The corrected pincode',
      content: { 'application/json': { schema: PincodeRecordSchema } },
    },
    ...errorResponses(400, 401, 403, 404, 409),
  },
});
