import {
  CreateProposalRequestSchema,
  DataSheetInputSchema,
  MarkRfqSentRequestSchema,
  ProposalIdParamsSchema,
  ProposalListQuerySchema,
  ProposalListResponseSchema,
  ProposalRecordSchema,
  SetProposalInsurersRequestSchema,
  XLSX_CONTENT_TYPE,
} from '../../shared/index.ts';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { notFound } from '../../lib/errors.ts';
import { istDay } from '../../lib/ist-day.ts';
import { documentRoute, errorResponses } from '../../lib/openapi.ts';
import { authenticate } from '../../middleware/auth.ts';
import { currentUser, requirePermission } from '../../middleware/require-permission.ts';
import { route } from '../../middleware/validate.ts';
import { catalogItems, taxRatePercentOn } from '../catalog/catalog.service.ts';
import { ClientModel } from '../clients/client.model.ts';
import {
  createProposal,
  getProposal,
  listProposals,
  markRfqSent,
  proposalForRfq,
  setInsurers,
  updateDataSheet,
  type Actor,
} from './proposals.service.ts';
import { buildRfqWorkbook } from './rfq-workbook.ts';

function actorOf(req: Request): Actor {
  return { id: currentUser(req).id, requestId: req.requestId };
}

/**
 * New-business proposals up to the RFQ. Viewing needs proposals.view; creating
 * proposals.create; the Data Sheet and insurers proposals.edit; the RFQ download
 * proposals.export; marking it sent proposals.send.
 */
export function createProposalsRouter(options: {
  jwtSecret: string;
  gstRatePercent: string;
}): Router {
  const router = Router();
  router.use(authenticate(options));

  router.get(
    '/',
    requirePermission('proposals.view'),
    route({ query: ProposalListQuerySchema }, async ({ query }, _req, res) => {
      res.json(await listProposals(query));
    }),
  );

  router.post(
    '/',
    requirePermission('proposals.create'),
    route({ body: CreateProposalRequestSchema }, async ({ body }, req, res) => {
      res.status(201).json(
        await createProposal(body, actorOf(req), {
          defaultGstRatePercent: options.gstRatePercent,
        }),
      );
    }),
  );

  router.get(
    '/:id',
    requirePermission('proposals.view'),
    route({ params: ProposalIdParamsSchema }, async ({ params }, _req, res) => {
      res.json(await getProposal(params.id));
    }),
  );

  router.put(
    '/:id/data-sheet',
    requirePermission('proposals.edit'),
    route(
      { params: ProposalIdParamsSchema, body: DataSheetInputSchema },
      async ({ params, body }, req, res) => {
        res.json(await updateDataSheet(params.id, body, actorOf(req)));
      },
    ),
  );

  router.put(
    '/:id/insurers',
    requirePermission('proposals.edit'),
    route(
      { params: ProposalIdParamsSchema, body: SetProposalInsurersRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await setInsurers(params.id, body, actorOf(req)));
      },
    ),
  );

  router.get(
    '/:id/rfq',
    requirePermission('proposals.export'),
    route({ params: ProposalIdParamsSchema }, async ({ params }, req, res) => {
      const record = await proposalForRfq(params.id, actorOf(req));
      const client = await ClientModel.findById(record.client.id).lean();
      if (!client) throw notFound('The proposal’s client no longer exists');
      const [gstRatePercent, products, sections, notes] = await Promise.all([
        record.gstRatePercent ??
          taxRatePercentOn('GST', istDay(new Date(record.createdAt)), options.gstRatePercent),
        catalogItems('products'),
        catalogItems('sections'),
        catalogItems('notes'),
      ]);
      const file = await buildRfqWorkbook(record, client, {
        gstRatePercent,
        products,
        sections,
        notes,
      });
      res.setHeader('Content-Type', XLSX_CONTENT_TYPE);
      res.setHeader('Content-Disposition', `attachment; filename="RFQ-${record.reference}.xlsx"`);
      res.send(file);
    }),
  );

  router.post(
    '/:id/rfq/sent',
    requirePermission('proposals.send'),
    route(
      { params: ProposalIdParamsSchema, body: MarkRfqSentRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await markRfqSent(params.id, body, actorOf(req)));
      },
    ),
  );

  return router;
}

const json = (schema: z.ZodType) => ({ content: { 'application/json': { schema } } });

documentRoute({
  method: 'get',
  path: '/api/v1/proposals',
  tags: ['Proposals'],
  summary: 'List new-business proposals',
  description: 'Needs proposals.view. Newest first; cursor pagination.',
  request: { query: ProposalListQuerySchema },
  responses: {
    200: { description: 'A page of proposals', ...json(ProposalListResponseSchema) },
    ...errorResponses(400, 401, 403),
  },
});

documentRoute({
  method: 'post',
  path: '/api/v1/proposals',
  tags: ['Proposals'],
  summary: 'Create a new-business proposal',
  description:
    'Needs proposals.create. For a client and some of its risk locations; numbered PRP-<year>-<n>. Starts as a draft. Audited.',
  request: { body: json(CreateProposalRequestSchema) },
  responses: {
    201: { description: 'The proposal', ...json(ProposalRecordSchema) },
    ...errorResponses(400, 401, 403),
  },
});

documentRoute({
  method: 'get',
  path: '/api/v1/proposals/{id}',
  tags: ['Proposals'],
  summary: 'Get a proposal',
  description:
    'Needs proposals.view. With live client, location and insurer details, the Fire totals and what the Data Sheet still needs (missing).',
  request: { params: ProposalIdParamsSchema },
  responses: {
    200: { description: 'The proposal', ...json(ProposalRecordSchema) },
    ...errorResponses(400, 401, 403, 404),
  },
});

documentRoute({
  method: 'put',
  path: '/api/v1/proposals/{id}/data-sheet',
  tags: ['Proposals'],
  summary: 'Save the Data Sheet',
  description:
    'Needs proposals.edit. Replaces the Data Sheet: locations with their Fire items, the Fire Option 2 lines, the other sections, claims and notes. A measured item without an amount is priced as area × rate. 409 PROPOSAL_LOCKED once the RFQ has been sent. Audited.',
  request: { params: ProposalIdParamsSchema, body: json(DataSheetInputSchema) },
  responses: {
    200: { description: 'The proposal', ...json(ProposalRecordSchema) },
    ...errorResponses(400, 401, 403, 404, 409),
  },
});

documentRoute({
  method: 'put',
  path: '/api/v1/proposals/{id}/insurers',
  tags: ['Proposals'],
  summary: 'Choose the insurers',
  description:
    'Needs proposals.edit. Up to five active insurers from the insurer master; an insurer the RFQ was sent to cannot be taken off. Audited.',
  request: { params: ProposalIdParamsSchema, body: json(SetProposalInsurersRequestSchema) },
  responses: {
    200: { description: 'The proposal', ...json(ProposalRecordSchema) },
    ...errorResponses(400, 401, 403, 404, 409),
  },
});

documentRoute({
  method: 'get',
  path: '/api/v1/proposals/{id}/rfq',
  tags: ['Proposals'],
  summary: 'Download the RFQ workbook',
  description:
    'Needs proposals.export. The RFQ in the client’s layout. 409 DATA_SHEET_INCOMPLETE until the Data Sheet is complete. Audited as an export.',
  request: { params: ProposalIdParamsSchema },
  responses: {
    200: {
      description: 'The RFQ workbook',
      content: { [XLSX_CONTENT_TYPE]: { schema: z.string().meta({ format: 'binary' }) } },
    },
    ...errorResponses(400, 401, 403, 404, 409),
  },
});

documentRoute({
  method: 'post',
  path: '/api/v1/proposals/{id}/rfq/sent',
  tags: ['Proposals'],
  summary: 'Mark the RFQ as sent',
  description:
    'Needs proposals.send. Records that the RFQ was emailed to these insurers (already on the proposal): who and when. The proposal moves to RFQ Sent and its Data Sheet locks. Audited as a send.',
  request: { params: ProposalIdParamsSchema, body: json(MarkRfqSentRequestSchema) },
  responses: {
    200: { description: 'The proposal', ...json(ProposalRecordSchema) },
    ...errorResponses(400, 401, 403, 404, 409),
  },
});
