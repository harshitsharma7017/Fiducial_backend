import {
  ApprovePlacementSlipRequestSchema,
  MAX_QUOTE_ATTACHMENT_BYTES,
  PLACEMENT_FILE_TYPES,
  PlacementFileParamsSchema,
  PlacementFileSchema,
  PlacementFileUploadQuerySchema,
  PlacementSlipDocumentQuerySchema,
  PlacementSlipSchema,
  PlacementSlipSendResponseSchema,
  ProposalIdParamsSchema,
  RecordPlacedRequestSchema,
  SavePlacementSlipRequestSchema,
  SendPlacementSlipRequestSchema,
} from '../../shared/index.ts';
import express, { Router, type Request } from 'express';
import { z } from 'zod';
import { documentRoute, errorResponses } from '../../lib/openapi.ts';
import { authenticate } from '../../middleware/auth.ts';
import { currentUser, requirePermission } from '../../middleware/require-permission.ts';
import { route } from '../../middleware/validate.ts';
import type { MailTransport } from '../mail/transport.ts';
import {
  approvePlacementSlip,
  getPlacementSlip,
  placementFile,
  placementSlipDocument,
  recordPlaced,
  savePlacementSlip,
  sendPlacementSlip,
  uploadPlacementFile,
} from './placement-slip.service.ts';

const UploadSchema = z.instanceof(Buffer, {
  error: 'Upload the policy or cover note as the request body',
});

function actorOf(req: Request) {
  return { id: currentUser(req).id, requestId: req.requestId };
}

/**
 * The placement slip of a case, under /api/v1/proposals: viewing needs proposals.view, the
 * remarks, the policy or cover note and its files proposals.edit, approval proposals.approve, the
 * download proposals.export and the mail to the insurer proposals.send.
 */
export function createPlacementSlipRouter(options: {
  jwtSecret: string;
  gstRatePercent: string;
  mailTransport: MailTransport;
}): Router {
  const router = Router();
  router.use(authenticate(options));
  const deps = { defaultGstRatePercent: options.gstRatePercent, transport: options.mailTransport };
  const edit = requirePermission('proposals.edit');

  router.get(
    '/:id/placement-slip',
    requirePermission('proposals.view'),
    route({ params: ProposalIdParamsSchema }, async ({ params }, _req, res) => {
      res.json(await getPlacementSlip(params.id, deps));
    }),
  );

  router.put(
    '/:id/placement-slip',
    edit,
    route(
      { params: ProposalIdParamsSchema, body: SavePlacementSlipRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await savePlacementSlip(params.id, body, actorOf(req), deps));
      },
    ),
  );

  router.post(
    '/:id/placement-slip/approve',
    requirePermission('proposals.approve'),
    route(
      { params: ProposalIdParamsSchema, body: ApprovePlacementSlipRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await approvePlacementSlip(params.id, body.fingerprint, actorOf(req), deps));
      },
    ),
  );

  router.get(
    '/:id/placement-slip/document',
    requirePermission('proposals.export'),
    route(
      { params: ProposalIdParamsSchema, query: PlacementSlipDocumentQuerySchema },
      async ({ params, query }, req, res) => {
        const file = await placementSlipDocument(params.id, query.format, actorOf(req), deps);
        res.setHeader('Content-Type', file.contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
        res.setHeader('X-Placement-Slip-Status', file.status);
        res.send(file.data);
      },
    ),
  );

  router.post(
    '/:id/placement-slip/email',
    requirePermission('proposals.send'),
    route(
      { params: ProposalIdParamsSchema, body: SendPlacementSlipRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await sendPlacementSlip(params.id, body, actorOf(req), deps));
      },
    ),
  );

  router.post(
    '/:id/placement-slip/files',
    edit,
    express.raw({
      type: [...Object.keys(PLACEMENT_FILE_TYPES), 'application/octet-stream'],
      limit: MAX_QUOTE_ATTACHMENT_BYTES,
    }),
    route(
      { params: ProposalIdParamsSchema, query: PlacementFileUploadQuerySchema, body: UploadSchema },
      async ({ params, query, body }, req, res) => {
        res
          .status(201)
          .json(await uploadPlacementFile(params.id, body, query.fileName, actorOf(req)));
      },
    ),
  );

  router.get(
    '/:id/placement-slip/files/:fileId',
    requirePermission('proposals.view'),
    route({ params: PlacementFileParamsSchema }, async ({ params }, _req, res) => {
      const file = await placementFile(params.id, params.fileId);
      res.setHeader('Content-Type', file.contentType);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${file.fileName.replace(/[^\w.\- ]/g, '_')}"`,
      );
      res.send(file.data);
    }),
  );

  router.put(
    '/:id/placement-slip/placed',
    edit,
    route(
      { params: ProposalIdParamsSchema, body: RecordPlacedRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await recordPlaced(params.id, body, actorOf(req), deps));
      },
    ),
  );

  return router;
}

const json = (schema: z.ZodType) => ({ content: { 'application/json': { schema } } });
const binary = { schema: z.string().meta({ format: 'binary' }) };
const TAGS = ['Placement slip'];

documentRoute({
  method: 'get',
  path: '/api/v1/proposals/{id}/placement-slip',
  tags: TAGS,
  summary: 'The placement slip of a case',
  description:
    'Needs proposals.view. From the quote the client accepted (the version and premium the client approval kept): the sections placed with the sum insured of the option accepted and the insurer’s premium, net, GST and total, capacity, deductibles and conditions; the broker’s remarks; the approval (current only while nothing changed since); what still stops approval; the mails to the insurer; the policy or cover note recorded; and why it cannot be worked on now, if so.',
  request: { params: ProposalIdParamsSchema },
  responses: {
    200: { description: 'The placement slip', ...json(PlacementSlipSchema) },
    ...errorResponses(400, 401, 403, 404),
  },
});

documentRoute({
  method: 'put',
  path: '/api/v1/proposals/{id}/placement-slip',
  tags: TAGS,
  summary: 'Save the remarks printed on the placement slip',
  description:
    'Needs proposals.edit. Any change voids an approval. 409 until the client approval is recorded, and on a closed case. Audited (PLACEMENT_SLIP_SAVED).',
  request: { params: ProposalIdParamsSchema, body: json(SavePlacementSlipRequestSchema) },
  responses: {
    200: { description: 'The placement slip', ...json(PlacementSlipSchema) },
    ...errorResponses(400, 401, 403, 404, 409),
  },
});

documentRoute({
  method: 'post',
  path: '/api/v1/proposals/{id}/placement-slip/approve',
  tags: TAGS,
  summary: 'Approve the placement slip',
  description:
    'Needs proposals.approve. Approves the fingerprint the approver saw: 409 PLACEMENT_SLIP_CHANGED when it changed since, 409 PLACEMENT_SLIP_INCOMPLETE while the client approval or the client’s Placement Slip format is missing. Audited (PLACEMENT_SLIP_APPROVED).',
  request: { params: ProposalIdParamsSchema, body: json(ApprovePlacementSlipRequestSchema) },
  responses: {
    200: { description: 'The placement slip', ...json(PlacementSlipSchema) },
    ...errorResponses(400, 401, 403, 404, 409),
  },
});

documentRoute({
  method: 'get',
  path: '/api/v1/proposals/{id}/placement-slip/document',
  tags: TAGS,
  summary: 'Download the placement slip (Excel or PDF)',
  description:
    'Needs proposals.export. The client’s Placement Slip format filled (409 PLACEMENT_SLIP_INCOMPLETE until it is uploaded or the client approval recorded); the PDF is A4 with the letterhead. A draft can be downloaded to review; X-Placement-Slip-Status says which. Audited (PLACEMENT_SLIP_DOWNLOADED).',
  request: { params: ProposalIdParamsSchema, query: PlacementSlipDocumentQuerySchema },
  responses: {
    200: { description: 'The file', content: { 'application/octet-stream': binary } },
    ...errorResponses(400, 401, 403, 404, 409),
  },
});

documentRoute({
  method: 'post',
  path: '/api/v1/proposals/{id}/placement-slip/email',
  tags: TAGS,
  summary: 'Email the approved placement slip to the insurer',
  description:
    'Needs proposals.send. Only an approved slip, unchanged since approval (409 PLACEMENT_SLIP_NOT_APPROVED; 409 MAIL_DISABLED when mail is off). One mail to the chosen addresses of the insurer the client accepted, from the Placement slip email template, with the slip attached; logged in the case’s mail log and audited. Moves the case to Placement Slip when it is before it. Repeating a sendId never mails twice.',
  request: { params: ProposalIdParamsSchema, body: json(SendPlacementSlipRequestSchema) },
  responses: {
    200: { description: 'The outcome and the slip', ...json(PlacementSlipSendResponseSchema) },
    ...errorResponses(400, 401, 403, 404, 409, 422),
  },
});

documentRoute({
  method: 'post',
  path: '/api/v1/proposals/{id}/placement-slip/files',
  tags: TAGS,
  summary: 'Upload the insurer’s policy or cover note',
  description: `Needs proposals.edit. The file is the request body (${Object.values(PLACEMENT_FILE_TYPES).join(', ')}; up to ${MAX_QUOTE_ATTACHMENT_BYTES / 1024 / 1024} MB); its type is checked from its content. The placement then attaches it by id. Audited.`,
  request: {
    params: ProposalIdParamsSchema,
    query: PlacementFileUploadQuerySchema,
    body: { content: { 'application/octet-stream': binary } },
  },
  responses: {
    201: { description: 'The kept file', ...json(PlacementFileSchema) },
    ...errorResponses(400, 401, 403, 404, 409),
  },
});

documentRoute({
  method: 'get',
  path: '/api/v1/proposals/{id}/placement-slip/files/{fileId}',
  tags: TAGS,
  summary: 'Download a policy or cover note file',
  description: 'Needs proposals.view.',
  request: { params: PlacementFileParamsSchema },
  responses: {
    200: { description: 'The file', content: { 'application/octet-stream': binary } },
    ...errorResponses(400, 401, 403, 404),
  },
});

documentRoute({
  method: 'put',
  path: '/api/v1/proposals/{id}/placement-slip/placed',
  tags: TAGS,
  summary: 'Record the policy or cover note the insurer issued',
  description:
    'Needs proposals.edit. Its kind, number, date (not in the future) and at least one file uploaded for the placement (400 otherwise). 409 until the slip has gone to the insurer, and on a closed case. Moves the case to Placed; can be corrected afterwards. Audited (PLACEMENT_RECORDED).',
  request: { params: ProposalIdParamsSchema, body: json(RecordPlacedRequestSchema) },
  responses: {
    200: { description: 'The placement slip', ...json(PlacementSlipSchema) },
    ...errorResponses(400, 401, 403, 404, 409),
  },
});
