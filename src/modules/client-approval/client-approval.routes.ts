import {
  CLIENT_APPROVAL_FILE_TYPES,
  ClientApprovalFileParamsSchema,
  ClientApprovalFileSchema,
  ClientApprovalFileUploadQuerySchema,
  MAX_QUOTE_ATTACHMENT_BYTES,
  ProposalClientApprovalSchema,
  ProposalIdParamsSchema,
  RecordClientApprovalRequestSchema,
} from '../../shared/index.ts';
import express, { Router, type Request } from 'express';
import { z } from 'zod';
import { documentRoute, errorResponses } from '../../lib/openapi.ts';
import { authenticate } from '../../middleware/auth.ts';
import { currentUser, requirePermission } from '../../middleware/require-permission.ts';
import { route } from '../../middleware/validate.ts';
import {
  clientApprovalFile,
  getClientApproval,
  recordClientApproval,
  uploadClientApprovalFile,
} from './client-approval.service.ts';

const UploadSchema = z.instanceof(Buffer, {
  error: 'Upload the client’s mail or signed letter as the request body',
});

function actorOf(req: Request) {
  return { id: currentUser(req).id, requestId: req.requestId };
}

/**
 * The client approval of a case, under /api/v1/proposals: reading needs proposals.view;
 * recording it and uploading its files proposals.edit.
 */
export function createClientApprovalRouter(options: {
  jwtSecret: string;
  gstRatePercent: string;
}): Router {
  const router = Router();
  router.use(authenticate(options));
  const view = requirePermission('proposals.view');
  const edit = requirePermission('proposals.edit');

  router.get(
    '/:id/client-approval',
    view,
    route({ params: ProposalIdParamsSchema }, async ({ params }, _req, res) => {
      res.json(await getClientApproval(params.id, options.gstRatePercent));
    }),
  );

  router.put(
    '/:id/client-approval',
    edit,
    route(
      { params: ProposalIdParamsSchema, body: RecordClientApprovalRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await recordClientApproval(params.id, body, actorOf(req), options.gstRatePercent));
      },
    ),
  );

  router.post(
    '/:id/client-approval/files',
    edit,
    express.raw({
      type: [...Object.keys(CLIENT_APPROVAL_FILE_TYPES), 'application/octet-stream'],
      limit: MAX_QUOTE_ATTACHMENT_BYTES,
    }),
    route(
      {
        params: ProposalIdParamsSchema,
        query: ClientApprovalFileUploadQuerySchema,
        body: UploadSchema,
      },
      async ({ params, query, body }, req, res) => {
        res
          .status(201)
          .json(await uploadClientApprovalFile(params.id, body, query.fileName, actorOf(req)));
      },
    ),
  );

  router.get(
    '/:id/client-approval/files/:fileId',
    view,
    route({ params: ClientApprovalFileParamsSchema }, async ({ params }, _req, res) => {
      const file = await clientApprovalFile(params.id, params.fileId);
      res.setHeader('Content-Type', file.contentType);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${file.fileName.replace(/[^\w.\- ]/g, '_')}"`,
      );
      res.send(file.data);
    }),
  );

  return router;
}

const json = (schema: z.ZodType) => ({ content: { 'application/json': { schema } } });
const binary = { schema: z.string().meta({ format: 'binary' }) };

documentRoute({
  method: 'get',
  path: '/api/v1/proposals/{id}/client-approval',
  tags: ['Client approval'],
  summary: 'The quote the client accepted',
  description:
    'Needs proposals.view. The approval recorded (null until then), with the premium kept and whether the quote has a newer version since; the quotes the client can accept (each insurer and option the QCR compares, totals with and without terrorism, the QCR’s recommendation and lowest marked); the files uploaded; the client’s contacts; and why it cannot be recorded now, if so.',
  request: { params: ProposalIdParamsSchema },
  responses: {
    200: { description: 'The client approval', ...json(ProposalClientApprovalSchema) },
    ...errorResponses(400, 401, 403, 404),
  },
});

documentRoute({
  method: 'put',
  path: '/api/v1/proposals/{id}/client-approval',
  tags: ['Client approval'],
  summary: 'Record (or correct) the quote the client accepted',
  description:
    'Needs proposals.edit. An insurer and option compared in the QCR; whether Fire is taken with terrorism when it was quoted both ways; the date (not in the future); who confirmed; and at least one file uploaded for the client approval (400 otherwise). 409 until the QCR has gone to the insured, and once the case is placed or closed. Moves the case to Client Approval when it is before it. Audited (CLIENT_APPROVAL_RECORDED).',
  request: { params: ProposalIdParamsSchema, body: json(RecordClientApprovalRequestSchema) },
  responses: {
    200: { description: 'The client approval', ...json(ProposalClientApprovalSchema) },
    ...errorResponses(400, 401, 403, 404, 409),
  },
});

documentRoute({
  method: 'post',
  path: '/api/v1/proposals/{id}/client-approval/files',
  tags: ['Client approval'],
  summary: 'Upload the client’s mail or signed letter',
  description: `Needs proposals.edit. The file is the request body (${Object.values(CLIENT_APPROVAL_FILE_TYPES).join(', ')}; up to ${MAX_QUOTE_ATTACHMENT_BYTES / 1024 / 1024} MB); its type is checked from its content. The approval then attaches it by id. Audited.`,
  request: {
    params: ProposalIdParamsSchema,
    query: ClientApprovalFileUploadQuerySchema,
    body: { content: { 'application/octet-stream': binary } },
  },
  responses: {
    201: { description: 'The kept file', ...json(ClientApprovalFileSchema) },
    ...errorResponses(400, 401, 403, 404, 409),
  },
});

documentRoute({
  method: 'get',
  path: '/api/v1/proposals/{id}/client-approval/files/{fileId}',
  tags: ['Client approval'],
  summary: 'Download a client approval file',
  description: 'Needs proposals.view.',
  request: { params: ClientApprovalFileParamsSchema },
  responses: {
    200: { description: 'The file', content: { 'application/octet-stream': binary } },
    ...errorResponses(400, 401, 403, 404),
  },
});
