import {
  CoverageConfirmationSchema,
  CoverageConfirmationSendResponseSchema,
  ProposalIdParamsSchema,
  RecordCoverageConfirmationRequestSchema,
  SendCoverageConfirmationRequestSchema,
} from '../../shared/index.ts';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { documentRoute, errorResponses } from '../../lib/openapi.ts';
import { authenticate } from '../../middleware/auth.ts';
import { currentUser, requirePermission } from '../../middleware/require-permission.ts';
import { route } from '../../middleware/validate.ts';
import type { MailTransport } from '../mail/transport.ts';
import {
  coverageLetterDocument,
  getCoverageConfirmation,
  recordCoverageConfirmation,
  sendCoverageConfirmation,
} from './coverage-confirmation.service.ts';

function actorOf(req: Request) {
  const user = currentUser(req);
  // A1: carry the actor's roles so audit and timeline entries snapshot the role at action time.
  return { id: user.id, roles: user.roles, requestId: req.requestId };
}

/**
 * Q4: a case's coverage confirmation, under /api/v1/proposals. Viewing needs property.view,
 * recording / correcting the confirmation property.edit, the letter download property.export,
 * and the mail to the insured property.send. Same permission model as the QCR and placement slip.
 */
export function createCoverageConfirmationRouter(options: {
  jwtSecret: string;
  gstRatePercent: string;
  mailTransport: MailTransport;
}): Router {
  const router = Router();
  router.use(authenticate(options));
  const deps = { defaultGstRatePercent: options.gstRatePercent, transport: options.mailTransport };

  router.get(
    '/:id/coverage-confirmation',
    requirePermission('property.view'),
    route({ params: ProposalIdParamsSchema }, async ({ params }, _req, res) => {
      res.json(await getCoverageConfirmation(params.id, deps));
    }),
  );

  router.put(
    '/:id/coverage-confirmation',
    requirePermission('property.edit'),
    route(
      { params: ProposalIdParamsSchema, body: RecordCoverageConfirmationRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await recordCoverageConfirmation(params.id, body, actorOf(req), deps));
      },
    ),
  );

  router.get(
    '/:id/coverage-confirmation/document',
    requirePermission('property.export'),
    route({ params: ProposalIdParamsSchema }, async ({ params }, req, res) => {
      const file = await coverageLetterDocument(params.id, actorOf(req), deps);
      res.setHeader('Content-Type', file.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
      res.send(file.data);
    }),
  );

  router.post(
    '/:id/coverage-confirmation/email',
    requirePermission('property.send'),
    route(
      { params: ProposalIdParamsSchema, body: SendCoverageConfirmationRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await sendCoverageConfirmation(params.id, body, actorOf(req), deps));
      },
    ),
  );

  return router;
}

const json = (schema: z.ZodType) => ({ content: { 'application/json': { schema } } });
const binary = { schema: z.string().meta({ format: 'binary' }) };
const TAGS = ['Coverage confirmation'];

documentRoute({
  method: 'get',
  path: '/api/v1/proposals/{id}/coverage-confirmation',
  tags: TAGS,
  summary: 'The coverage confirmation of a case',
  description:
    'Needs property.view. The recorded insurer confirmation (if any); the policy details read live from the placement slip and the placed policy / cover note; the placement files available as the insurer’s proof; the insured’s contacts for the email; the emails sent; what still stops a confirmation; and why it cannot be worked on now, if so. The letter format and signatory are still to be confirmed by the client (presentationPending).',
  request: { params: ProposalIdParamsSchema },
  responses: {
    200: { description: 'The coverage confirmation', ...json(CoverageConfirmationSchema) },
    ...errorResponses(400, 401, 403, 404),
  },
});

documentRoute({
  method: 'put',
  path: '/api/v1/proposals/{id}/coverage-confirmation',
  tags: TAGS,
  summary: 'Record the insurer’s confirmation of cover',
  description:
    'Needs property.edit. Records (or corrects) the confirmation date, the insurer’s reference, the delivery channel, notes, an optional configurable signatory, and the placement files chosen as the insurer’s proof. Never sends anything. 409 until the case is placed (an insurer policy / cover note recorded) and on a closed case. Audited (COVERAGE_CONFIRMATION_RECORDED / _UPDATED).',
  request: { params: ProposalIdParamsSchema, body: json(RecordCoverageConfirmationRequestSchema) },
  responses: {
    200: { description: 'The coverage confirmation', ...json(CoverageConfirmationSchema) },
    ...errorResponses(400, 401, 403, 404, 409),
  },
});

documentRoute({
  method: 'get',
  path: '/api/v1/proposals/{id}/coverage-confirmation/document',
  tags: TAGS,
  summary: 'Download the coverage confirmation letter (PDF)',
  description:
    'Needs property.export. An A4 PDF on the Fiducial letterhead (shared document design), from the recorded confirmation and the live policy details. No signature is rendered: a configured signatory is shown as typed text, else the signatory is marked to be confirmed. 409 until a confirmation is recorded. Audited (COVERAGE_CONFIRMATION_DOWNLOADED).',
  request: { params: ProposalIdParamsSchema },
  responses: {
    200: { description: 'The PDF', content: { 'application/octet-stream': binary } },
    ...errorResponses(400, 401, 403, 404, 409),
  },
});

documentRoute({
  method: 'post',
  path: '/api/v1/proposals/{id}/coverage-confirmation/email',
  tags: TAGS,
  summary: 'Email the coverage confirmation to the insured',
  description:
    'Needs property.send. One mail to the chosen addresses (auto-filled from the client master), from the Coverage confirmation email template, optionally with the letter PDF attached; logged in the case’s mail log and audited. 409 until a confirmation is recorded; 409 MAIL_DISABLED when mail is off. Repeating a sendId never mails twice.',
  request: { params: ProposalIdParamsSchema, body: json(SendCoverageConfirmationRequestSchema) },
  responses: {
    200: {
      description: 'The outcome and the confirmation',
      ...json(CoverageConfirmationSendResponseSchema),
    },
    ...errorResponses(400, 401, 403, 404, 409, 422),
  },
});
