import {
  CreateGhiQuoteRequestSchema,
  DispatchGhiRfqRequestSchema,
  DispatchGhiRfqResponseSchema,
  GhiCaseParamsSchema,
  GhiCaseRecordSchema,
  GhiDecisionRequestSchema,
  GhiDocumentPreviewSchema,
  GhiDocumentQuerySchema,
  GhiFinalQcrStateSchema,
  GhiPaymentParamsSchema,
  GhiPaymentsResponseSchema,
  GhiPlacementStateSchema,
  GhiQcrDecisionRequestSchema,
  GhiQcrListResponseSchema,
  GhiQcrParamsSchema,
  GhiQcrSchema,
  GhiQuoteListResponseSchema,
  GhiQuoteParamsSchema,
  GhiQuoteSchema,
  GhiRfqDocumentQuerySchema,
  GhiRfqStateSchema,
  GhiSendOutcomeSchema,
  MarkGhiRfqSentRequestSchema,
  RecordGhiClientDecisionRequestSchema,
  RecordGhiFinalQcrRequestSchema,
  RecordGhiPolicyRequestSchema,
  SaveGhiPaymentRequestSchema,
  SaveGhiQcrRequestSchema,
  SendGhiQcrRequestSchema,
  UpdateGhiQuoteRequestSchema,
} from '../../shared/index.ts';
import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth.ts';
import { requirePermission } from '../../middleware/require-permission.ts';
import { gmcRawCensus } from './member-redaction.ts';
import { route } from '../../middleware/validate.ts';
import type { MailTransport } from '../mail/transport.ts';
import {
  addPayment,
  finalQcrState,
  listPayments,
  placementSlipFile,
  placementState,
  recordFinalQcr,
  recordPolicy,
  updatePayment,
} from './ghi-placement.service.ts';
import {
  createQcr,
  decideQcr,
  listQcrs,
  qcrFile,
  recordClientDecision,
  sendQcr,
  submitQcr,
  updateQcr,
} from './ghi-qcr.service.ts';
import { createQuote, deleteDraftQuote, listQuotes, updateQuote } from './ghi-quotes.service.ts';
import {
  decideRfq,
  dispatchRfq,
  generateRfq,
  markRfqSent,
  rfqFile,
  rfqPreview,
  rfqState,
  submitRfq,
} from './ghi-rfq.service.ts';
import { actorOf, documentGhiRoute, sendFile } from './ghi.routes.ts';

// The GHI workflow after the census (G5 to G7) under /api/v1/ghi/cases/{id}: the RFQ, quotes,
// QCR, final QCR, payments, placement slip and policy. Approvals need gmc.approve, mails
// gmc.send, downloads gmc.export, the rest gmc.edit (viewing gmc.view).

export function createGhiWorkflowRouter(options: {
  jwtSecret: string;
  mailTransport: MailTransport;
}): Router {
  const router = Router();
  router.use(authenticate(options));
  const transport = options.mailTransport;
  const view = requirePermission('gmc.view');
  const edit = requirePermission('gmc.edit');
  const approve = requirePermission('gmc.approve');
  const send = requirePermission('gmc.send');
  const exportFile = requirePermission('gmc.export');
  const rawCensus = gmcRawCensus();
  const P = GhiCaseParamsSchema;

  // RFQ (G5)
  router.get(
    '/cases/:id/rfq',
    view,
    route({ params: P }, async ({ params }, _req, res) => {
      res.json(await rfqState(params.id, transport));
    }),
  );
  router.get(
    '/cases/:id/rfq/preview',
    view,
    route({ params: P }, async ({ params }, _req, res) => {
      res.json(await rfqPreview(params.id));
    }),
  );
  router.post(
    '/cases/:id/rfq/generate',
    edit,
    route({ params: P }, async ({ params }, req, res) => {
      res.status(201).json(await generateRfq(params.id, actorOf(req), transport));
    }),
  );
  router.post(
    '/cases/:id/rfq/submit',
    edit,
    route({ params: P }, async ({ params }, req, res) => {
      res.json(await submitRfq(params.id, actorOf(req), transport));
    }),
  );
  router.post(
    '/cases/:id/rfq/decision',
    approve,
    route({ params: P, body: GhiDecisionRequestSchema }, async ({ params, body }, req, res) => {
      res.json(await decideRfq(params.id, body, actorOf(req), transport));
    }),
  );
  router.get(
    '/cases/:id/rfq/document',
    exportFile,
    // The member annexure carries dates of birth.
    ...rawCensus,
    route({ params: P, query: GhiRfqDocumentQuerySchema }, async ({ params, query }, req, res) => {
      sendFile(res, await rfqFile(params.id, query.format, actorOf(req), query.versionId));
    }),
  );
  router.post(
    '/cases/:id/rfq/email',
    send,
    route({ params: P, body: DispatchGhiRfqRequestSchema }, async ({ params, body }, req, res) => {
      res.json(await dispatchRfq(params.id, body, actorOf(req), transport));
    }),
  );
  router.post(
    '/cases/:id/rfq/sent',
    send,
    route({ params: P, body: MarkGhiRfqSentRequestSchema }, async ({ params, body }, req, res) => {
      res.json(await markRfqSent(params.id, body, actorOf(req)));
    }),
  );

  // Quotes (G6)
  router.get(
    '/cases/:id/quotes',
    view,
    route({ params: P }, async ({ params }, _req, res) => {
      res.json(await listQuotes(params.id));
    }),
  );
  router.post(
    '/cases/:id/quotes',
    edit,
    route({ params: P, body: CreateGhiQuoteRequestSchema }, async ({ params, body }, req, res) => {
      res.status(201).json(await createQuote(params.id, body, actorOf(req)));
    }),
  );
  router.put(
    '/cases/:id/quotes/:quoteId',
    edit,
    route(
      { params: GhiQuoteParamsSchema, body: UpdateGhiQuoteRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await updateQuote(params.id, params.quoteId, body, actorOf(req)));
      },
    ),
  );
  router.delete(
    '/cases/:id/quotes/:quoteId',
    edit,
    route({ params: GhiQuoteParamsSchema }, async ({ params }, req, res) => {
      await deleteDraftQuote(params.id, params.quoteId, actorOf(req));
      res.status(204).end();
    }),
  );

  // QCR (G6)
  router.get(
    '/cases/:id/qcrs',
    view,
    route({ params: P }, async ({ params }, _req, res) => {
      res.json(await listQcrs(params.id, transport));
    }),
  );
  router.post(
    '/cases/:id/qcrs',
    edit,
    route({ params: P, body: SaveGhiQcrRequestSchema }, async ({ params, body }, req, res) => {
      res.status(201).json(await createQcr(params.id, body, actorOf(req)));
    }),
  );
  router.put(
    '/cases/:id/qcrs/:qcrId',
    edit,
    route(
      { params: GhiQcrParamsSchema, body: SaveGhiQcrRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await updateQcr(params.id, params.qcrId, body, actorOf(req)));
      },
    ),
  );
  router.post(
    '/cases/:id/qcrs/:qcrId/submit',
    edit,
    route({ params: GhiQcrParamsSchema }, async ({ params }, req, res) => {
      res.json(await submitQcr(params.id, params.qcrId, actorOf(req)));
    }),
  );
  router.post(
    '/cases/:id/qcrs/:qcrId/decision',
    approve,
    route(
      { params: GhiQcrParamsSchema, body: GhiQcrDecisionRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await decideQcr(params.id, params.qcrId, body, actorOf(req)));
      },
    ),
  );
  router.get(
    '/cases/:id/qcrs/:qcrId/document',
    exportFile,
    route(
      { params: GhiQcrParamsSchema, query: GhiDocumentQuerySchema },
      async ({ params, query }, req, res) => {
        sendFile(res, await qcrFile(params.id, params.qcrId, query.format, actorOf(req)));
      },
    ),
  );
  router.post(
    '/cases/:id/qcrs/:qcrId/email',
    send,
    route(
      { params: GhiQcrParamsSchema, body: SendGhiQcrRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await sendQcr(params.id, params.qcrId, body, actorOf(req), transport));
      },
    ),
  );
  router.post(
    '/cases/:id/qcrs/:qcrId/client-decision',
    edit,
    route(
      { params: GhiQcrParamsSchema, body: RecordGhiClientDecisionRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await recordClientDecision(params.id, params.qcrId, body, actorOf(req)));
      },
    ),
  );

  // Final QCR, payments, placement slip and policy (G7)
  router.get(
    '/cases/:id/final-qcr',
    view,
    route({ params: P }, async ({ params }, _req, res) => {
      res.json(await finalQcrState(params.id));
    }),
  );
  router.post(
    '/cases/:id/final-qcr',
    edit,
    route(
      { params: P, body: RecordGhiFinalQcrRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await recordFinalQcr(params.id, body, actorOf(req)));
      },
    ),
  );
  router.get(
    '/cases/:id/payments',
    view,
    route({ params: P }, async ({ params }, _req, res) => {
      res.json(await listPayments(params.id));
    }),
  );
  router.post(
    '/cases/:id/payments',
    edit,
    route({ params: P, body: SaveGhiPaymentRequestSchema }, async ({ params, body }, req, res) => {
      res.status(201).json(await addPayment(params.id, body, actorOf(req)));
    }),
  );
  router.put(
    '/cases/:id/payments/:paymentId',
    edit,
    route(
      { params: GhiPaymentParamsSchema, body: SaveGhiPaymentRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await updatePayment(params.id, params.paymentId, body, actorOf(req)));
      },
    ),
  );
  router.get(
    '/cases/:id/placement',
    view,
    route({ params: P }, async ({ params }, _req, res) => {
      res.json(await placementState(params.id));
    }),
  );
  router.get(
    '/cases/:id/placement-slip',
    exportFile,
    ...rawCensus,
    route({ params: P, query: GhiDocumentQuerySchema }, async ({ params, query }, req, res) => {
      sendFile(res, await placementSlipFile(params.id, query.format, actorOf(req)));
    }),
  );
  router.put(
    '/cases/:id/policy',
    edit,
    route({ params: P, body: RecordGhiPolicyRequestSchema }, async ({ params, body }, req, res) => {
      res.json(await recordPolicy(params.id, body, actorOf(req)));
    }),
  );
  return router;
}

const base = '/api/v1/ghi/cases/{id}';
for (const item of [
  {
    method: 'get',
    path: `${base}/rfq`,
    summary: 'RFQ versions, what is missing, and the mails sent',
    permission: 'gmc.view',
    response: GhiRfqStateSchema,
  },
  {
    method: 'get',
    path: `${base}/rfq/preview`,
    summary: 'Preview of the RFQ as it would be generated now',
    permission: 'gmc.view',
    response: GhiDocumentPreviewSchema,
  },
  {
    method: 'post',
    path: `${base}/rfq/generate`,
    summary: 'Generate a new RFQ version (Excel and PDF)',
    permission: 'gmc.edit',
    response: GhiRfqStateSchema,
    status: 201,
  },
  {
    method: 'post',
    path: `${base}/rfq/submit`,
    summary: 'Submit the latest RFQ for approval',
    permission: 'gmc.edit',
    response: GhiRfqStateSchema,
  },
  {
    method: 'post',
    path: `${base}/rfq/decision`,
    summary: 'Approve or return the RFQ',
    permission: 'gmc.approve',
    body: GhiDecisionRequestSchema,
    response: GhiRfqStateSchema,
  },
  {
    method: 'get',
    path: `${base}/rfq/document`,
    summary: 'Download an RFQ version as generated',
    permission: 'gmc.export',
    query: GhiRfqDocumentQuerySchema,
    file: true,
  },
  {
    method: 'post',
    path: `${base}/rfq/email`,
    summary: 'Email the approved RFQ to insurers (one mail each)',
    permission: 'gmc.send',
    body: DispatchGhiRfqRequestSchema,
    response: DispatchGhiRfqResponseSchema,
  },
  {
    method: 'post',
    path: `${base}/rfq/sent`,
    summary: 'Mark the approved RFQ as sent outside the app',
    permission: 'gmc.send',
    body: MarkGhiRfqSentRequestSchema,
    response: GhiCaseRecordSchema,
  },
  {
    method: 'get',
    path: `${base}/quotes`,
    summary: 'Every quote version, with deviations from the RFQ',
    permission: 'gmc.view',
    response: GhiQuoteListResponseSchema,
  },
  {
    method: 'post',
    path: `${base}/quotes`,
    summary: 'Record an insurer’s quote (draft or final); GST and total by the API',
    permission: 'gmc.edit',
    body: CreateGhiQuoteRequestSchema,
    response: GhiQuoteSchema,
    status: 201,
  },
  {
    method: 'put',
    path: `${base}/quotes/{quoteId}`,
    summary: 'Change a draft quote, or record it',
    permission: 'gmc.edit',
    body: UpdateGhiQuoteRequestSchema,
    response: GhiQuoteSchema,
  },
  {
    method: 'delete',
    path: `${base}/quotes/{quoteId}`,
    summary: 'Delete a draft quote',
    permission: 'gmc.edit',
    status: 204,
  },
  {
    method: 'get',
    path: `${base}/qcrs`,
    summary: 'QCR versions with the side-by-side comparison',
    permission: 'gmc.view',
    response: GhiQcrListResponseSchema,
  },
  {
    method: 'post',
    path: `${base}/qcrs`,
    summary: 'Prepare a QCR version from up to five final quotes',
    permission: 'gmc.edit',
    body: SaveGhiQcrRequestSchema,
    response: GhiQcrSchema,
    status: 201,
  },
  {
    method: 'put',
    path: `${base}/qcrs/{qcrId}`,
    summary: 'Edit a draft or rejected QCR',
    permission: 'gmc.edit',
    body: SaveGhiQcrRequestSchema,
    response: GhiQcrSchema,
  },
  {
    method: 'post',
    path: `${base}/qcrs/{qcrId}/submit`,
    summary: 'Submit the QCR for approval',
    permission: 'gmc.edit',
    response: GhiQcrSchema,
  },
  {
    method: 'post',
    path: `${base}/qcrs/{qcrId}/decision`,
    summary: 'Approve or reject the QCR',
    permission: 'gmc.approve',
    body: GhiQcrDecisionRequestSchema,
    response: GhiQcrSchema,
  },
  {
    method: 'get',
    path: `${base}/qcrs/{qcrId}/document`,
    summary: 'Download the QCR (Excel or PDF)',
    permission: 'gmc.export',
    query: GhiDocumentQuerySchema,
    file: true,
  },
  {
    method: 'post',
    path: `${base}/qcrs/{qcrId}/email`,
    summary: 'Email the approved QCR to the client’s contacts',
    permission: 'gmc.send',
    body: SendGhiQcrRequestSchema,
    response: z.object({ result: GhiSendOutcomeSchema, qcr: GhiQcrSchema }),
  },
  {
    method: 'post',
    path: `${base}/qcrs/{qcrId}/client-decision`,
    summary: 'Record the client’s decision and selected insurer',
    permission: 'gmc.edit',
    body: RecordGhiClientDecisionRequestSchema,
    response: GhiQcrSchema,
  },
  {
    method: 'get',
    path: `${base}/final-qcr`,
    summary: 'The accepted quote and the final agreed terms',
    permission: 'gmc.view',
    response: GhiFinalQcrStateSchema,
  },
  {
    method: 'post',
    path: `${base}/final-qcr`,
    summary: 'Record the final agreed terms (a new version; history kept)',
    permission: 'gmc.edit',
    body: RecordGhiFinalQcrRequestSchema,
    response: GhiFinalQcrStateSchema,
  },
  {
    method: 'get',
    path: `${base}/payments`,
    summary: 'Payments against the final premium',
    permission: 'gmc.view',
    response: GhiPaymentsResponseSchema,
  },
  {
    method: 'post',
    path: `${base}/payments`,
    summary: 'Record a payment',
    permission: 'gmc.edit',
    body: SaveGhiPaymentRequestSchema,
    response: GhiPaymentsResponseSchema,
    status: 201,
  },
  {
    method: 'put',
    path: `${base}/payments/{paymentId}`,
    summary: 'Change a payment (for example its status)',
    permission: 'gmc.edit',
    body: SaveGhiPaymentRequestSchema,
    response: GhiPaymentsResponseSchema,
  },
  {
    method: 'get',
    path: `${base}/placement`,
    summary: 'Whether the placement slip can be issued',
    permission: 'gmc.view',
    response: GhiPlacementStateSchema,
  },
  {
    method: 'get',
    path: `${base}/placement-slip`,
    summary: 'Download the placement slip (Excel or PDF)',
    permission: 'gmc.export',
    query: GhiDocumentQuerySchema,
    file: true,
  },
  {
    method: 'put',
    path: `${base}/policy`,
    summary: 'Record the policy number, copy and renewal date',
    permission: 'gmc.edit',
    body: RecordGhiPolicyRequestSchema,
    response: GhiCaseRecordSchema,
  },
] as const) {
  documentGhiRoute(item);
}
