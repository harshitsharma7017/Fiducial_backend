import {
  CreateWcCaseRequestSchema,
  ERROR_CODES,
  PDF_CONTENT_TYPE,
  WcCaseIdParamsSchema,
  WcCaseListSchema,
  WcCaseSchema,
  WcDataSheetInputSchema,
  WcDocumentParamsSchema,
  WcDocumentQuerySchema,
  WcPlacementInputSchema,
  WcQuotesInputSchema,
  WcRfqInputSchema,
  XLSX_CONTENT_TYPE,
} from '../../shared/index.ts';
import { Router } from 'express';
import type { z } from 'zod';
import { conflict } from '../../lib/errors.ts';
import { documentRoute, errorResponses } from '../../lib/openapi.ts';
import { authenticate } from '../../middleware/auth.ts';
import { currentUser, requirePermission } from '../../middleware/require-permission.ts';
import { route } from '../../middleware/validate.ts';
import { withBrokerLetterhead } from '../documents/broker-letterhead.ts';
import { toPdf, toXlsx } from '../ghi/ghi-sheet.ts';
import { wcDocument } from './wc-documents.ts';
import {
  auditWcDownload,
  createWcCase,
  getWcCase,
  listWcCases,
  saveWcDataSheet,
  saveWcPlacement,
  saveWcQuotes,
  saveWcRfq,
} from './wc.service.ts';

/**
 * Workmen compensation cases: listed and read with wc.view, created with wc.create, edited with
 * wc.edit and their documents downloaded with wc.export.
 */
export function createWcRouter(options: { jwtSecret: string; gstRatePercent: string }): Router {
  const router = Router();
  router.use(authenticate(options));
  router.use(requirePermission('wc.view'));
  const actorOf = (req: Parameters<typeof currentUser>[0]) => ({
    id: currentUser(req).id,
    requestId: req.requestId,
  });

  router.get(
    '/cases',
    route({}, async (_input, _req, res) => {
      res.json(await listWcCases());
    }),
  );

  router.post(
    '/cases',
    requirePermission('wc.create'),
    route({ body: CreateWcCaseRequestSchema }, async ({ body }, req, res) => {
      res
        .status(201)
        .json(
          await createWcCase(body, actorOf(req), { defaultGstRatePercent: options.gstRatePercent }),
        );
    }),
  );

  router.get(
    '/cases/:id',
    route({ params: WcCaseIdParamsSchema }, async ({ params }, _req, res) => {
      res.json(await getWcCase(params.id));
    }),
  );

  router.put(
    '/cases/:id/data-sheet',
    requirePermission('wc.edit'),
    route(
      { params: WcCaseIdParamsSchema, body: WcDataSheetInputSchema },
      async ({ params, body }, req, res) => {
        res.json(await saveWcDataSheet(params.id, body, actorOf(req)));
      },
    ),
  );

  router.put(
    '/cases/:id/quotes',
    requirePermission('wc.edit'),
    route(
      { params: WcCaseIdParamsSchema, body: WcQuotesInputSchema },
      async ({ params, body }, req, res) => {
        res.json(await saveWcQuotes(params.id, body, actorOf(req)));
      },
    ),
  );

  router.put(
    '/cases/:id/rfq',
    requirePermission('wc.edit'),
    route(
      { params: WcCaseIdParamsSchema, body: WcRfqInputSchema },
      async ({ params, body }, req, res) => {
        res.json(await saveWcRfq(params.id, body, actorOf(req)));
      },
    ),
  );

  router.put(
    '/cases/:id/placement',
    requirePermission('wc.edit'),
    route(
      { params: WcCaseIdParamsSchema, body: WcPlacementInputSchema },
      async ({ params, body }, req, res) => {
        res.json(await saveWcPlacement(params.id, body, actorOf(req)));
      },
    ),
  );

  router.get(
    '/cases/:id/documents/:kind',
    requirePermission('wc.export'),
    route(
      { params: WcDocumentParamsSchema, query: WcDocumentQuerySchema },
      async ({ params, query }, req, res) => {
        const record = await getWcCase(params.id);
        if (params.kind === 'placement-slip' && !record.placement) {
          throw conflict(
            ERROR_CODES.CONFLICT,
            'Choose the insurer and coverage accepted before the placement slip.',
          );
        }
        const model = wcDocument(record, params.kind);
        const pdf = query.format === 'pdf';
        const data = pdf
          ? await toPdf(model, await withBrokerLetterhead({ logo: null, address: null }))
          : await toXlsx(model);
        await auditWcDownload(params.id, params.kind, query.format, actorOf(req));
        res.setHeader('Content-Type', pdf ? PDF_CONTENT_TYPE : XLSX_CONTENT_TYPE);
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${model.fileBase}.${pdf ? 'pdf' : 'xlsx'}"`,
        );
        res.send(data);
      },
    ),
  );

  return router;
}

const json = <T extends z.ZodType>(schema: T) => ({
  content: { 'application/json': { schema } },
});

documentRoute({
  method: 'get',
  path: '/api/v1/wc/cases',
  tags: ['Workmen compensation'],
  summary: 'List the workmen compensation cases',
  description: 'Needs wc.view. Most recently changed first.',
  responses: {
    200: { description: 'The cases', ...json(WcCaseListSchema) },
    ...errorResponses(401, 403),
  },
});

documentRoute({
  method: 'post',
  path: '/api/v1/wc/cases',
  tags: ['Workmen compensation'],
  summary: 'Create a workmen compensation case',
  description:
    'Needs wc.create. The Data Sheet starts from the client’s format: worker categories, coverage options, clauses and conditions. Audited.',
  request: { body: json(CreateWcCaseRequestSchema) },
  responses: {
    201: { description: 'The case', ...json(WcCaseSchema) },
    ...errorResponses(400, 401, 403),
  },
});

documentRoute({
  method: 'get',
  path: '/api/v1/wc/cases/{id}',
  tags: ['Workmen compensation'],
  summary: 'A workmen compensation case',
  description: 'Needs wc.view.',
  request: { params: WcCaseIdParamsSchema },
  responses: {
    200: { description: 'The case', ...json(WcCaseSchema) },
    ...errorResponses(401, 403, 404),
  },
});

documentRoute({
  method: 'put',
  path: '/api/v1/wc/cases/{id}/data-sheet',
  tags: ['Workmen compensation'],
  summary: 'Save the Data Sheet',
  description:
    'Needs wc.edit. Any number of worker categories, coverage options, clauses and conditions. Removing a coverage option removes its quoted premiums. Audited.',
  request: { params: WcCaseIdParamsSchema, body: json(WcDataSheetInputSchema) },
  responses: {
    200: { description: 'The case', ...json(WcCaseSchema) },
    ...errorResponses(400, 401, 403, 404),
  },
});

documentRoute({
  method: 'put',
  path: '/api/v1/wc/cases/{id}/quotes',
  tags: ['Workmen compensation'],
  summary: 'Save the insurers’ quotes',
  description:
    'Needs wc.edit. A premium including GST for each coverage option, the payee, the insurer recommended and remarks. Audited.',
  request: { params: WcCaseIdParamsSchema, body: json(WcQuotesInputSchema) },
  responses: {
    200: { description: 'The case', ...json(WcCaseSchema) },
    ...errorResponses(400, 401, 403, 404),
  },
});

documentRoute({
  method: 'get',
  path: '/api/v1/wc/cases/{id}/documents/{kind}',
  tags: ['Workmen compensation'],
  summary: 'Download the Data Sheet, RFQ, quote comparison or placement slip',
  description:
    'Needs wc.export. format=pdf (default) or xlsx. The placement slip needs the placement chosen (409). Audited.',
  request: { params: WcDocumentParamsSchema, query: WcDocumentQuerySchema },
  responses: { 200: { description: 'The document' }, ...errorResponses(401, 403, 404, 409) },
});

documentRoute({
  method: 'put',
  path: '/api/v1/wc/cases/{id}/rfq',
  tags: ['Workmen compensation'],
  summary: 'Record the RFQ’s insurers',
  description:
    'Needs wc.edit. The insurers the RFQ goes to and the day it was sent to each (null: not sent yet). Audited.',
  request: { params: WcCaseIdParamsSchema, body: json(WcRfqInputSchema) },
  responses: {
    200: { description: 'The case', ...json(WcCaseSchema) },
    ...errorResponses(400, 401, 403, 404),
  },
});

documentRoute({
  method: 'put',
  path: '/api/v1/wc/cases/{id}/placement',
  tags: ['Workmen compensation'],
  summary: 'Record the placement',
  description:
    'Needs wc.edit. The insurer and coverage option accepted (it must have a premium quoted), and the policy number once issued, which places the case. Audited.',
  request: { params: WcCaseIdParamsSchema, body: json(WcPlacementInputSchema) },
  responses: {
    200: { description: 'The case', ...json(WcCaseSchema) },
    ...errorResponses(400, 401, 403, 404),
  },
});
