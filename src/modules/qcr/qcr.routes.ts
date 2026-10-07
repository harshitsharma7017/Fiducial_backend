import {
  ApproveQcrRequestSchema,
  ProposalIdParamsSchema,
  QcrDocumentQuerySchema,
  QcrSchema,
  QcrSendResponseSchema,
  SaveQcrRequestSchema,
  SendQcrRequestSchema,
} from '../../shared/index.ts';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { documentRoute, errorResponses } from '../../lib/openapi.ts';
import { authenticate } from '../../middleware/auth.ts';
import { currentUser, requirePermission } from '../../middleware/require-permission.ts';
import { route } from '../../middleware/validate.ts';
import type { MailTransport } from '../mail/transport.ts';
import { approveQcr, getQcr, qcrDocument, saveQcr, sendQcr } from './qcr.service.ts';

function actorOf(req: Request) {
  return { id: currentUser(req).id, requestId: req.requestId };
}

/**
 * The QCR of a case (QC-1 to QC-6), under /api/v1/proposals: viewing needs proposals.view, the
 * broker's part proposals.edit, approval proposals.approve, the download proposals.export and the
 * mail to the insured proposals.send.
 */
export function createQcrRouter(options: {
  jwtSecret: string;
  gstRatePercent: string;
  mailTransport: MailTransport;
}): Router {
  const router = Router();
  router.use(authenticate(options));
  const deps = { defaultGstRatePercent: options.gstRatePercent, transport: options.mailTransport };

  router.get(
    '/:id/qcr',
    requirePermission('proposals.view'),
    route({ params: ProposalIdParamsSchema }, async ({ params }, _req, res) => {
      res.json(await getQcr(params.id, deps));
    }),
  );

  router.put(
    '/:id/qcr',
    requirePermission('proposals.edit'),
    route(
      { params: ProposalIdParamsSchema, body: SaveQcrRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await saveQcr(params.id, body, actorOf(req), deps));
      },
    ),
  );

  router.post(
    '/:id/qcr/approve',
    requirePermission('proposals.approve'),
    route(
      { params: ProposalIdParamsSchema, body: ApproveQcrRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await approveQcr(params.id, body.fingerprint, actorOf(req), deps));
      },
    ),
  );

  router.get(
    '/:id/qcr/document',
    requirePermission('proposals.export'),
    route(
      { params: ProposalIdParamsSchema, query: QcrDocumentQuerySchema },
      async ({ params, query }, req, res) => {
        const file = await qcrDocument(params.id, query.format, actorOf(req), deps);
        res.setHeader('Content-Type', file.contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
        res.setHeader('X-Qcr-Status', file.status);
        res.send(file.data);
      },
    ),
  );

  router.post(
    '/:id/qcr/email',
    requirePermission('proposals.send'),
    route(
      { params: ProposalIdParamsSchema, body: SendQcrRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await sendQcr(params.id, body, actorOf(req), deps));
      },
    ),
  );

  return router;
}

const json = (schema: z.ZodType) => ({ content: { 'application/json': { schema } } });
const binary = { schema: z.string().meta({ format: 'binary' }) };

documentRoute({
  method: 'get',
  path: '/api/v1/proposals/{id}/qcr',
  tags: ['QCR'],
  summary: 'The quote comparison of a case',
  description:
    'Needs proposals.view. Per option, the existing policy and the latest quote of up to five insurers that have not declined (Fire without terrorism where quoted so), net, GST and total, the lowest total marked, and where the insurers differ; the broker’s recommendation, remarks and payment; the approval (current only while nothing changed since); what still stops approval; and the mails to the insured.',
  request: { params: ProposalIdParamsSchema },
  responses: {
    200: { description: 'The QCR', ...json(QcrSchema) },
    ...errorResponses(400, 401, 403, 404),
  },
});

documentRoute({
  method: 'put',
  path: '/api/v1/proposals/{id}/qcr',
  tags: ['QCR'],
  summary: 'Save the broker’s recommendation, remarks and payment',
  description:
    'Needs proposals.edit. Any change voids an approval: the QCR must be approved again. Audited (QCR_SAVED).',
  request: { params: ProposalIdParamsSchema, body: json(SaveQcrRequestSchema) },
  responses: {
    200: { description: 'The QCR', ...json(QcrSchema) },
    ...errorResponses(400, 401, 403, 404, 409),
  },
});

documentRoute({
  method: 'post',
  path: '/api/v1/proposals/{id}/qcr/approve',
  tags: ['QCR'],
  summary: 'Approve the QCR',
  description:
    'Needs proposals.approve. Approves the QCR whose fingerprint the approver saw: 409 QCR_CHANGED when it changed since, 409 QCR_INCOMPLETE while something is missing (no quote, no recommendation, no payment in favour of). Audited (QCR_APPROVED).',
  request: { params: ProposalIdParamsSchema, body: json(ApproveQcrRequestSchema) },
  responses: {
    200: { description: 'The QCR', ...json(QcrSchema) },
    ...errorResponses(400, 401, 403, 404, 409),
  },
});

documentRoute({
  method: 'get',
  path: '/api/v1/proposals/{id}/qcr/document',
  tags: ['QCR'],
  summary: 'Download the QCR (Excel or PDF)',
  description:
    'Needs proposals.export. The client’s QCR template filled when uploaded, else the built-in layout; the PDF is A4 with the letterhead. A draft can be downloaded to review; X-Qcr-Status says which. Audited (QCR_DOWNLOADED).',
  request: { params: ProposalIdParamsSchema, query: QcrDocumentQuerySchema },
  responses: {
    200: { description: 'The file', content: { 'application/octet-stream': binary } },
    ...errorResponses(400, 401, 403, 404, 409),
  },
});

documentRoute({
  method: 'post',
  path: '/api/v1/proposals/{id}/qcr/email',
  tags: ['QCR'],
  summary: 'Email the approved QCR to the insured',
  description:
    'Needs proposals.send. Only an approved QCR, unchanged since approval, is sent (409 QCR_NOT_APPROVED otherwise; 409 MAIL_DISABLED when mail is off). One mail to the chosen addresses with the QCR attached, from the QCR email template; logged in the case’s mail log and audited. Repeating a sendId never mails twice.',
  request: { params: ProposalIdParamsSchema, body: json(SendQcrRequestSchema) },
  responses: {
    200: { description: 'The outcome and the QCR', ...json(QcrSendResponseSchema) },
    ...errorResponses(400, 401, 403, 404, 409, 422),
  },
});
