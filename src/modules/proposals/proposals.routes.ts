import {
  CreateProposalRequestSchema,
  DataSheetInputSchema,
  DocumentFormatQuerySchema,
  PDF_CONTENT_TYPE,
  ExistingPolicyLookupSchema,
  LastPolicyQuerySchema,
  MoveProposalStageRequestSchema,
  ProposalOwnersResponseSchema,
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
  lastPolicyOf,
  listOwners,
  moveStage,
  refreshExistingPolicy,
  listProposals,
  markRfqSent,
  proposalForRfq,
  setInsurers,
  updateDataSheet,
  type Actor,
} from './proposals.service.ts';
import type { ExistingPolicySource } from './existing-policy-source.ts';
import { rfqDocument } from './rfq-document.ts';

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
  /** Where renewals get last year's policy (the policy software's public API). */
  policySource: ExistingPolicySource;
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
          policySource: options.policySource,
        }),
      );
    }),
  );

  router.get(
    '/owners',
    requirePermission('proposals.create'),
    route({}, async (_input, _req, res) => {
      res.json(await listOwners());
    }),
  );

  router.get(
    '/last-policy',
    requirePermission('proposals.create'),
    route({ query: LastPolicyQuerySchema }, async ({ query }, _req, res) => {
      res.json(await lastPolicyOf(query.clientId, options.policySource));
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

  router.post(
    '/:id/existing-policy',
    requirePermission('proposals.edit'),
    route({ params: ProposalIdParamsSchema }, async ({ params }, req, res) => {
      res.json(await refreshExistingPolicy(params.id, actorOf(req), options.policySource));
    }),
  );

  router.post(
    '/:id/stage',
    requirePermission('proposals.edit'),
    route(
      { params: ProposalIdParamsSchema, body: MoveProposalStageRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await moveStage(params.id, body, actorOf(req)));
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
    route(
      { params: ProposalIdParamsSchema, query: DocumentFormatQuerySchema },
      async ({ params, query }, req, res) => {
        const record = await proposalForRfq(params.id, actorOf(req), query.format);
        const client = await ClientModel.findById(record.client.id).lean();
        if (!client) throw notFound('The proposal’s client no longer exists');
        const [gstRatePercent, products, sections, notes, addons] = await Promise.all([
          record.gstRatePercent ??
            taxRatePercentOn('GST', istDay(new Date(record.createdAt)), options.gstRatePercent),
          catalogItems('products'),
          catalogItems('sections'),
          catalogItems('notes'),
          catalogItems('addons'),
        ]);
        const file = await rfqDocument(
          record,
          client,
          { gstRatePercent, products, sections, notes, addons },
          query.format,
        );
        res.setHeader('Content-Type', file.contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
        res.setHeader('X-Document-Layout', file.layout);
        res.send(file.data);
      },
    ),
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
    'Needs proposals.edit. Replaces the Data Sheet: locations with their Fire items, the Fire Option 2 lines, the other sections (with their lines in three options, the Burglary basis and the add-on covers asked for), the product and add-ons, a renewal’s Existing column, claims and notes. A measured item without an amount is priced as area × rate. With a basis, Burglary’s sum insured is the Fire contents. A product the Fire sum insured does not suggest needs product.reason, and add-ons must come from the product’s lists (400 otherwise). 409 PROPOSAL_LOCKED once the RFQ has been sent. Audited.',
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
  summary: 'Download the RFQ (Excel or PDF)',
  description:
    'Needs proposals.export. format=xlsx (default) fills the client’s uploaded RFQ template, keeping its sheets, merged cells, formulas and print areas (the built-in layout until one is uploaded); format=pdf draws the same workbook on A4 with the template’s letterhead. X-Document-Layout says template or built-in. 409 DATA_SHEET_INCOMPLETE until the Data Sheet is complete. Audited as an export.',
  request: { params: ProposalIdParamsSchema, query: DocumentFormatQuerySchema },
  responses: {
    200: {
      description: 'The RFQ',
      content: {
        [XLSX_CONTENT_TYPE]: { schema: z.string().meta({ format: 'binary' }) },
        [PDF_CONTENT_TYPE]: { schema: z.string().meta({ format: 'binary' }) },
      },
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

documentRoute({
  method: 'get',
  path: '/api/v1/proposals/owners',
  tags: ['Proposals'],
  summary: 'Staff a case can be assigned to',
  description: 'Needs proposals.create. Active users whose roles may edit proposals, by name.',
  responses: {
    200: { description: 'The staff', ...json(ProposalOwnersResponseSchema) },
    ...errorResponses(401, 403),
  },
});

documentRoute({
  method: 'get',
  path: '/api/v1/proposals/last-policy',
  tags: ['Proposals'],
  summary: 'Last year’s policy of a client',
  description:
    'Needs proposals.create. Asks the policy administration software (EXISTING_POLICY_API_URL) for the client’s latest policy, by GSTIN and name, to show before a renewal is created. Saves nothing. status is FOUND, NOT_FOUND, UNAVAILABLE or NOT_CONFIGURED.',
  request: { query: LastPolicyQuerySchema },
  responses: {
    200: { description: 'What the software has', ...json(ExistingPolicyLookupSchema) },
    ...errorResponses(400, 401, 403, 404),
  },
});

documentRoute({
  method: 'post',
  path: '/api/v1/proposals/{id}/existing-policy',
  tags: ['Proposals'],
  summary: 'Fetch a renewal’s existing policy again',
  description:
    'Needs proposals.edit. Renewals only, before the RFQ is sent. Replaces the Existing column with the policy software’s latest policy; sections are filled from it only if none were yet. Audited.',
  request: { params: ProposalIdParamsSchema },
  responses: {
    200: { description: 'The proposal', ...json(ProposalRecordSchema) },
    ...errorResponses(400, 401, 403, 404, 409),
  },
});

documentRoute({
  method: 'post',
  path: '/api/v1/proposals/{id}/stage',
  tags: ['Proposals'],
  summary: 'Move a case to its next stage, or close it',
  description:
    'Needs proposals.edit. Draft, Data Sheet and RFQ Sent follow from the work; from RFQ Sent the case moves one stage at a time (nextStage) up to Placed. CLOSED (with a reason) ends a case before Placed. Audited.',
  request: { params: ProposalIdParamsSchema, body: json(MoveProposalStageRequestSchema) },
  responses: {
    200: { description: 'The proposal', ...json(ProposalRecordSchema) },
    ...errorResponses(400, 401, 403, 404, 409),
  },
});
