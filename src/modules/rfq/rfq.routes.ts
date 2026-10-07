import {
  ProposalIdParamsSchema,
  RfqCommentRequestSchema,
  RfqEditsSchema,
  RfqReturnRequestSchema,
  RfqStateSchema,
  RfqVersionFileQuerySchema,
  RfqVersionParamsSchema,
  RfqVersionSchema,
} from '../../shared/index.ts';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { documentRoute, errorResponses } from '../../lib/openapi.ts';
import { authenticate } from '../../middleware/auth.ts';
import { currentUser, requirePermission } from '../../middleware/require-permission.ts';
import { route } from '../../middleware/validate.ts';
import {
  generateRfq,
  getRfqVersion,
  moveRfq,
  rfqState,
  rfqVersionFile,
  saveRfqEdits,
} from './rfq.service.ts';

function actorOf(req: Request) {
  return { id: currentUser(req).id, requestId: req.requestId };
}

/**
 * The RFQ's edits, versions and approval (R-1, R-2, R-5), under /api/v1/proposals: viewing needs
 * proposals.view; editing, generating and submitting proposals.edit; approving and returning
 * proposals.approve; a version's file proposals.export.
 */
export function createRfqRouter(options: { jwtSecret: string; gstRatePercent: string }): Router {
  const router = Router();
  router.use(authenticate(options));
  const view = requirePermission('proposals.view');
  const edit = requirePermission('proposals.edit');
  const approve = requirePermission('proposals.approve');

  router.get(
    '/:id/rfq/versions',
    view,
    route({ params: ProposalIdParamsSchema }, async ({ params }, _req, res) => {
      res.json(await rfqState(params.id));
    }),
  );
  router.put(
    '/:id/rfq/edits',
    edit,
    route(
      { params: ProposalIdParamsSchema, body: RfqEditsSchema },
      async ({ params, body }, req, res) => {
        res.json(await saveRfqEdits(params.id, body, actorOf(req)));
      },
    ),
  );
  router.post(
    '/:id/rfq/versions',
    edit,
    route({ params: ProposalIdParamsSchema }, async ({ params }, req, res) => {
      res.status(201).json(await generateRfq(params.id, actorOf(req), options.gstRatePercent));
    }),
  );
  router.get(
    '/:id/rfq/versions/:version',
    view,
    route({ params: RfqVersionParamsSchema }, async ({ params }, _req, res) => {
      res.json(await getRfqVersion(params.id, params.version));
    }),
  );
  router.get(
    '/:id/rfq/versions/:version/file',
    requirePermission('proposals.export'),
    route(
      { params: RfqVersionParamsSchema, query: RfqVersionFileQuerySchema },
      async ({ params, query }, req, res) => {
        const file = await rfqVersionFile(params.id, params.version, query.format, actorOf(req));
        res.setHeader('Content-Type', file.contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
        res.send(file.data);
      },
    ),
  );
  router.post(
    '/:id/rfq/versions/:version/submit',
    edit,
    route(
      { params: RfqVersionParamsSchema, body: RfqCommentRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await moveRfq(params.id, params.version, 'SUBMITTED', body.comment, actorOf(req)));
      },
    ),
  );
  router.post(
    '/:id/rfq/versions/:version/approve',
    approve,
    route(
      { params: RfqVersionParamsSchema, body: RfqCommentRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await moveRfq(params.id, params.version, 'APPROVED', body.comment, actorOf(req)));
      },
    ),
  );
  router.post(
    '/:id/rfq/versions/:version/return',
    approve,
    route(
      { params: RfqVersionParamsSchema, body: RfqReturnRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await moveRfq(params.id, params.version, 'RETURNED', body.comment, actorOf(req)));
      },
    ),
  );
  return router;
}

const json = (schema: z.ZodType) => ({ content: { 'application/json': { schema } } });
const state = {
  200: { description: 'The RFQ’s edits, versions and standing', ...json(RfqStateSchema) },
};

documentRoute({
  method: 'get',
  path: '/api/v1/proposals/{id}/rfq/versions',
  tags: ['RFQ'],
  summary: 'The RFQ’s edits, versions and whether it may be sent',
  description:
    'Needs proposals.view. Versions newest first with their history (generated, submitted, approved, returned, with comments). `sendable` is true only while the latest version is approved and the case and edits are unchanged since it was generated; `blocked` says why not.',
  request: { params: ProposalIdParamsSchema },
  responses: { ...state, ...errorResponses(400, 401, 403, 404) },
});
documentRoute({
  method: 'put',
  path: '/api/v1/proposals/{id}/rfq/edits',
  tags: ['RFQ'],
  summary: 'Save the edits made on the RFQ',
  description:
    'Needs proposals.edit. The heading, the notes for insurers, risk details and the claims table as the RFQ prints them, in place of the Data Sheet’s; they show in the next version. Audited (RFQ_EDITED).',
  request: { params: ProposalIdParamsSchema, body: json(RfqEditsSchema) },
  responses: { ...state, ...errorResponses(400, 401, 403, 404, 409) },
});
documentRoute({
  method: 'post',
  path: '/api/v1/proposals/{id}/rfq/versions',
  tags: ['RFQ'],
  summary: 'Generate the next RFQ version',
  description:
    'Needs proposals.edit. Generates v1, v2, v3… from the case and the edits, keeping the Excel and PDF made now and the case as it was. 409 DATA_SHEET_INCOMPLETE while the Data Sheet is incomplete. Audited (RFQ_GENERATED).',
  request: { params: ProposalIdParamsSchema },
  responses: {
    201: { description: 'The RFQ’s edits, versions and standing', ...json(RfqStateSchema) },
    ...errorResponses(400, 401, 403, 404, 409),
  },
});
documentRoute({
  method: 'get',
  path: '/api/v1/proposals/{id}/rfq/versions/{version}',
  tags: ['RFQ'],
  summary: 'One RFQ version, for its preview',
  description: 'Needs proposals.view. The case and edits it was generated from, and its history.',
  request: { params: RfqVersionParamsSchema },
  responses: {
    200: { description: 'The version', ...json(RfqVersionSchema) },
    ...errorResponses(400, 401, 403, 404),
  },
});
documentRoute({
  method: 'get',
  path: '/api/v1/proposals/{id}/rfq/versions/{version}/file',
  tags: ['RFQ'],
  summary: 'Download an RFQ version (Excel or PDF)',
  description:
    'Needs proposals.export. The file as generated for the version. Audited (RFQ_DOWNLOADED).',
  request: { params: RfqVersionParamsSchema, query: RfqVersionFileQuerySchema },
  responses: {
    200: {
      description: 'The file',
      content: { 'application/octet-stream': { schema: z.string().meta({ format: 'binary' }) } },
    },
    ...errorResponses(400, 401, 403, 404),
  },
});
for (const [step, permission, text] of [
  [
    'submit',
    'proposals.edit',
    'Submits the latest version, a draft, for approval; an optional comment.',
  ],
  [
    'approve',
    'proposals.approve',
    'Approves the latest version, once submitted; an optional comment. Only an approved RFQ is sent to insurers.',
  ],
  [
    'return',
    'proposals.approve',
    'Returns the latest version, once submitted, with the comment saying what to change.',
  ],
] as const) {
  documentRoute({
    method: 'post',
    path: `/api/v1/proposals/{id}/rfq/versions/{version}/${step}`,
    tags: ['RFQ'],
    summary: `${step[0]?.toUpperCase()}${step.slice(1)} an RFQ version`,
    description: `Needs ${permission}. ${text} 409 when it is not the latest version, not in the right state, or the case changed since it was generated. Audited.`,
    request: {
      params: RfqVersionParamsSchema,
      body: json(step === 'return' ? RfqReturnRequestSchema : RfqCommentRequestSchema),
    },
    responses: { ...state, ...errorResponses(400, 401, 403, 404, 409) },
  });
}
