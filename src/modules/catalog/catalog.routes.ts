import {
  CatalogImportQuerySchema,
  CatalogImportReportSchema,
  CatalogItemParamsSchema,
  CatalogListQuerySchema,
  CatalogListResponseSchema,
  CatalogMasterParamsSchema,
  CatalogReorderRequestSchema,
  MASTER_WORKBOOK_MAX_BYTES,
  ProductSuggestionQuerySchema,
  ProductSuggestionSchema,
  XLSX_CONTENT_TYPE,
  productRangeText,
  suggestProducts,
} from '../../shared/index.ts';
import express, { Router, type Request } from 'express';
import { z } from 'zod';
import { documentRoute, errorResponses } from '../../lib/openapi.ts';
import { authenticate } from '../../middleware/auth.ts';
import { currentUser, requirePermission } from '../../middleware/require-permission.ts';
import { route } from '../../middleware/validate.ts';
import type { Actor } from '../clients/clients.service.ts';
import { buildCatalogWorkbook } from './catalog-workbook.ts';
import {
  allCatalogItems,
  catalogItems,
  createCatalogItem,
  importCatalogWorkbook,
  listCatalog,
  reorderCatalog,
  updateCatalogItem,
} from './catalog.service.ts';

const actorOf = (req: Request): Actor => ({ id: currentUser(req).id, requestId: req.requestId });

const UploadSchema = z.instanceof(Buffer, {
  error: 'Upload the policy and cover masters workbook (.xlsx) as the request body',
});
/** A row's columns; each master's own schema checks them in the service. */
const RowBodySchema = z.record(z.string(), z.unknown());

/**
 * Product and cover masters (M-4 to M-9). Every role reads them (masters.view); Admins
 * (masters.manage) upload the workbook, add rows, edit and reorder.
 */
export function createCatalogRouter(options: { jwtSecret: string }): Router {
  const router = Router();
  router.use(authenticate(options));
  router.use(requirePermission('masters.view'));

  router.get('/workbook', async (_req, res) => {
    const file = await buildCatalogWorkbook(await allCatalogItems());
    res.setHeader('Content-Type', XLSX_CONTENT_TYPE);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="Policy-and-cover-masters-${new Date().toISOString().slice(0, 10)}.xlsx"`,
    );
    res.send(file);
  });

  router.post(
    '/import',
    requirePermission('masters.manage'),
    express.raw({
      type: [XLSX_CONTENT_TYPE, 'application/octet-stream'],
      limit: MASTER_WORKBOOK_MAX_BYTES,
    }),
    route(
      { query: CatalogImportQuerySchema, body: UploadSchema },
      async ({ query, body }, req, res) => {
        res.json(
          await importCatalogWorkbook(
            body,
            { dryRun: query.dryRun, sourceFileName: query.fileName ?? null },
            actorOf(req),
            req.log,
          ),
        );
      },
    ),
  );

  router.get(
    '/products/suggest',
    route({ query: ProductSuggestionQuerySchema }, async ({ query }, _req, res) => {
      const products = suggestProducts(await catalogItems('products'), query.sumInsured);
      res.json({
        sumInsured: query.sumInsured,
        products: products.map((product) => ({
          code: product.code,
          name: product.name,
          range: productRangeText(product),
        })),
      });
    }),
  );

  router.get(
    '/:master',
    route(
      { params: CatalogMasterParamsSchema, query: CatalogListQuerySchema },
      async ({ params, query }, _req, res) => {
        res.json(await listCatalog(params.master, query.q));
      },
    ),
  );

  router.post(
    '/:master',
    requirePermission('masters.manage'),
    route(
      { params: CatalogMasterParamsSchema, body: RowBodySchema },
      async ({ params, body }, req, res) => {
        res.status(201).json(await createCatalogItem(params.master, body, actorOf(req)));
      },
    ),
  );

  router.put(
    '/:master/order',
    requirePermission('masters.manage'),
    route(
      { params: CatalogMasterParamsSchema, body: CatalogReorderRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await reorderCatalog(params.master, body.ids, actorOf(req)));
      },
    ),
  );

  router.put(
    '/:master/:id',
    requirePermission('masters.manage'),
    route(
      { params: CatalogItemParamsSchema, body: RowBodySchema },
      async ({ params, body }, req, res) => {
        res.json(await updateCatalogItem(params.master, params.id, body, actorOf(req)));
      },
    ),
  );

  return router;
}

const json = (schema: z.ZodType) => ({ content: { 'application/json': { schema } } });
const xlsx = {
  content: { [XLSX_CONTENT_TYPE]: { schema: z.string().meta({ format: 'binary' }) } },
};

documentRoute({
  method: 'get',
  path: '/api/v1/catalog/workbook',
  tags: ['Policy and cover masters'],
  summary: 'Download the policy and cover masters workbook',
  description:
    'Needs masters.view. An Instructions sheet and one sheet per master (Policies, Coverage sections, Add-on covers, BSUS BLUS add-on rates, Tax rates, Standard notes) with the saved rows, to edit and upload back. Empty masters have their headers only.',
  responses: { 200: { description: 'The workbook', ...xlsx }, ...errorResponses(401, 403) },
});

documentRoute({
  method: 'post',
  path: '/api/v1/catalog/import',
  tags: ['Policy and cover masters'],
  summary: 'Preview or import the policy and cover masters workbook',
  description:
    'Needs masters.manage. The .xlsx as the request body. Each master sheet in the file replaces that master as a whole; masters without a sheet stay as they are. dryRun=true (default) only checks. With dryRun=false the sheets are saved in one transaction when every sheet passes, with one audit entry per master.',
  request: { query: CatalogImportQuerySchema, body: xlsx },
  responses: {
    200: { description: 'The report per sheet', ...json(CatalogImportReportSchema) },
    ...errorResponses(400, 401, 403, 413),
  },
});

documentRoute({
  method: 'get',
  path: '/api/v1/catalog/products/suggest',
  tags: ['Policy and cover masters'],
  summary: 'Suggest policies for a sum insured',
  description:
    'Needs masters.view. The active policies whose range holds the sum insured (above the lower limit, up to and including the upper), in their order.',
  request: { query: ProductSuggestionQuerySchema },
  responses: {
    200: { description: 'The policies', ...json(ProductSuggestionSchema) },
    ...errorResponses(400, 401, 403),
  },
});

documentRoute({
  method: 'get',
  path: '/api/v1/catalog/{master}',
  tags: ['Policy and cover masters'],
  summary: 'List a master',
  description:
    'Needs masters.view. Every row in display order. master is products, sections, addons, addon-rules, tax-rates or notes. q keeps the rows whose text holds every word.',
  request: { params: CatalogMasterParamsSchema, query: CatalogListQuerySchema },
  responses: {
    200: { description: 'The rows', ...json(CatalogListResponseSchema) },
    ...errorResponses(400, 401, 403),
  },
});

documentRoute({
  method: 'post',
  path: '/api/v1/catalog/{master}',
  tags: ['Policy and cover masters'],
  summary: 'Add a row to a master',
  description:
    'Needs masters.manage. The row’s columns as in src/shared/catalog.ts. Sections cannot be added (the 14 are fixed). 409 CATALOG_ITEM_EXISTS for a duplicate. Audited.',
  request: { params: CatalogMasterParamsSchema, body: json(RowBodySchema) },
  responses: {
    201: { description: 'The row', ...json(RowBodySchema) },
    ...errorResponses(400, 401, 403, 409),
  },
});

documentRoute({
  method: 'put',
  path: '/api/v1/catalog/{master}/order',
  tags: ['Policy and cover masters'],
  summary: 'Reorder a master',
  description:
    'Needs masters.manage. Policies, sections and notes: every row id in the new order. Fire stays the first section. Audited.',
  request: { params: CatalogMasterParamsSchema, body: json(CatalogReorderRequestSchema) },
  responses: {
    200: { description: 'The rows', ...json(CatalogListResponseSchema) },
    ...errorResponses(400, 401, 403),
  },
});

documentRoute({
  method: 'put',
  path: '/api/v1/catalog/{master}/{id}',
  tags: ['Policy and cover masters'],
  summary: 'Edit a master row',
  description:
    'Needs masters.manage. Replaces the row’s columns. A section keeps its code. Audited with old and new values.',
  request: { params: CatalogItemParamsSchema, body: json(RowBodySchema) },
  responses: {
    200: { description: 'The row', ...json(RowBodySchema) },
    ...errorResponses(400, 401, 403, 404, 409),
  },
});
