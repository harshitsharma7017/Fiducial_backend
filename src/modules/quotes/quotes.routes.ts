import {
  MAX_QUOTE_ATTACHMENT_BYTES,
  ProposalIdParamsSchema,
  ProposalInsurerParamsSchema,
  ProposalQuotesSchema,
  QUOTE_ATTACHMENT_TYPES,
  QuoteAttachmentParamsSchema,
  QuoteAttachmentSchema,
  QuoteAttachmentUploadQuerySchema,
  RecordQuoteRequestSchema,
} from '../../shared/index.ts';
import express, { Router, type Request } from 'express';
import { z } from 'zod';
import { documentRoute, errorResponses } from '../../lib/openapi.ts';
import { authenticate } from '../../middleware/auth.ts';
import { currentUser, requirePermission } from '../../middleware/require-permission.ts';
import { route } from '../../middleware/validate.ts';
import {
  proposalQuotes,
  quoteAttachmentFile,
  recordQuote,
  uploadQuoteAttachment,
} from './quotes.service.ts';

const UploadSchema = z.instanceof(Buffer, {
  error: 'Upload the insurer’s mail or PDF as the request body',
});

function actorOf(req: Request) {
  return { id: currentUser(req).id, requestId: req.requestId };
}

/**
 * Insurers' quotes on a case (Q-1 to Q-5), under /api/v1/proposals: reading needs
 * proposals.view; recording quotes and their attachments proposals.edit.
 */
export function createQuotesRouter(options: { jwtSecret: string; gstRatePercent: string }): Router {
  const router = Router();
  router.use(authenticate(options));
  const view = requirePermission('proposals.view');
  const edit = requirePermission('proposals.edit');

  router.get(
    '/:id/quotes',
    view,
    route({ params: ProposalIdParamsSchema }, async ({ params }, _req, res) => {
      res.json(await proposalQuotes(params.id, options.gstRatePercent));
    }),
  );

  router.post(
    '/:id/insurers/:insurerId/quotes',
    edit,
    route(
      { params: ProposalInsurerParamsSchema, body: RecordQuoteRequestSchema },
      async ({ params, body }, req, res) => {
        res
          .status(201)
          .json(
            await recordQuote(
              params.id,
              params.insurerId,
              body,
              actorOf(req),
              options.gstRatePercent,
            ),
          );
      },
    ),
  );

  router.post(
    '/:id/insurers/:insurerId/quote-attachments',
    edit,
    express.raw({
      type: [...Object.keys(QUOTE_ATTACHMENT_TYPES), 'application/octet-stream'],
      limit: MAX_QUOTE_ATTACHMENT_BYTES,
    }),
    route(
      {
        params: ProposalInsurerParamsSchema,
        query: QuoteAttachmentUploadQuerySchema,
        body: UploadSchema,
      },
      async ({ params, query, body }, req, res) => {
        res
          .status(201)
          .json(
            await uploadQuoteAttachment(
              params.id,
              params.insurerId,
              body,
              query.fileName,
              actorOf(req),
            ),
          );
      },
    ),
  );

  router.get(
    '/:id/quote-attachments/:attachmentId',
    view,
    route({ params: QuoteAttachmentParamsSchema }, async ({ params }, _req, res) => {
      const file = await quoteAttachmentFile(params.id, params.attachmentId);
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
  path: '/api/v1/proposals/{id}/quotes',
  tags: ['Quotes'],
  summary: 'List the insurers’ quotes on a case',
  description:
    'Needs proposals.view. Per insurer and option, every version newest first, with net, GST and total (with and without terrorism) and the deviations from the RFQ. `qcr` lists what the QCR compares: the latest version of each option from insurers that have not declined.',
  request: { params: ProposalIdParamsSchema },
  responses: {
    200: { description: 'The quotes', ...json(ProposalQuotesSchema) },
    ...errorResponses(400, 401, 403, 404),
  },
});

documentRoute({
  method: 'post',
  path: '/api/v1/proposals/{id}/insurers/{insurerId}/quotes',
  tags: ['Quotes'],
  summary: 'Record an insurer’s quote for one option',
  description:
    'Needs proposals.edit. Saves the next version: the premium of each section the RFQ asked for (Fire with and without terrorism), the insurer’s terms, and at least one attachment uploaded for this insurer (400 otherwise). From the second version on a reason is needed. The insurer moves to Quoted. 409 when the RFQ has not gone to the insurer or the case is closed. Audited (QUOTE_RECORDED).',
  request: { params: ProposalInsurerParamsSchema, body: json(RecordQuoteRequestSchema) },
  responses: {
    201: { description: 'The case’s quotes', ...json(ProposalQuotesSchema) },
    ...errorResponses(400, 401, 403, 404, 409),
  },
});

documentRoute({
  method: 'post',
  path: '/api/v1/proposals/{id}/insurers/{insurerId}/quote-attachments',
  tags: ['Quotes'],
  summary: 'Upload the insurer’s mail or PDF',
  description: `Needs proposals.edit. The file is the request body (${Object.values(QUOTE_ATTACHMENT_TYPES).join(', ')}; up to ${MAX_QUOTE_ATTACHMENT_BYTES / 1024 / 1024} MB); its type is checked from its content. Quotes of this insurer then attach it by id. Audited.`,
  request: {
    params: ProposalInsurerParamsSchema,
    query: QuoteAttachmentUploadQuerySchema,
    body: { content: { 'application/octet-stream': binary } },
  },
  responses: {
    201: { description: 'The kept attachment', ...json(QuoteAttachmentSchema) },
    ...errorResponses(400, 401, 403, 404, 409),
  },
});

documentRoute({
  method: 'get',
  path: '/api/v1/proposals/{id}/quote-attachments/{attachmentId}',
  tags: ['Quotes'],
  summary: 'Download a quote attachment',
  description: 'Needs proposals.view.',
  request: { params: QuoteAttachmentParamsSchema },
  responses: {
    200: { description: 'The file', content: { 'application/octet-stream': binary } },
    ...errorResponses(400, 401, 403, 404),
  },
});
