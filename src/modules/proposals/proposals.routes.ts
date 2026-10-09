import {
  CreateProposalRequestSchema,
  DataSheetImportQuerySchema,
  DataSheetImportSchema,
  DataSheetInputSchema,
  MAX_DATA_SHEET_BYTES,
  DocumentFormatQuerySchema,
  PDF_CONTENT_TYPE,
  ExistingPolicyLookupSchema,
  LastPolicyQuerySchema,
  MoveProposalStageRequestSchema,
  ProposalOwnersResponseSchema,
  MarkRfqSentRequestSchema,
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  MailDetailSchema,
  MailListQuerySchema,
  MailListResponseSchema,
  MailPreviewResponseSchema,
  PreviewMailRequestSchema,
  ProposalInsurerParamsSchema,
  ProposalMailParamsSchema,
  RecordInsurerResponseRequestSchema,
  SendMailResponseSchema,
  SendReminderRequestSchema,
  SendRfqRequestSchema,
  ProposalIdParamsSchema,
  ProposalListQuerySchema,
  ProposalListResponseSchema,
  ProposalRecordSchema,
  SetProposalInsurersRequestSchema,
  XLSX_CONTENT_TYPE,
  can,
} from '../../shared/index.ts';
import express, { Router, type Request, type RequestHandler } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { forbidden, notFound } from '../../lib/errors.ts';
import { documentRoute, errorResponses } from '../../lib/openapi.ts';
import { authenticate } from '../../middleware/auth.ts';
import { currentUser, requirePermission } from '../../middleware/require-permission.ts';
import { route } from '../../middleware/validate.ts';
import {
  createProposal,
  deleteProposal,
  getProposal,
  lastPolicyOf,
  listOwners,
  moveStage,
  refreshExistingPolicy,
  listProposals,
  markRfqSent,
  proposalForRfq,
  restoreProposal,
  setInsurers,
  readDataSheetImport,
  updateDataSheet,
  type Actor,
} from './proposals.service.ts';
import type { ExistingPolicySource } from './existing-policy-source.ts';
import { rfqFileFor } from './rfq-document.ts';
import { writeAudit } from '../audit/audit.service.ts';
import { caseMailAttachment, getCaseMail, listCaseMails } from '../mail/mail-log.service.ts';
import type { MailTransport } from '../mail/transport.ts';
import { recordResponse } from './insurer-status.ts';
import { ProposalModel } from './proposal.model.ts';
import { previewMails, sendReminder, sendRfq, type MailDeps } from './rfq-mail.service.ts';

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
  /** How RFQ mails leave (smtp, outbox or off). */
  mailTransport: MailTransport;
}): Router {
  const router = Router();
  router.use(authenticate(options));
  const mail: MailDeps = {
    transport: options.mailTransport,
    defaultGstRatePercent: options.gstRatePercent,
  };

  router.get(
    '/',
    requirePermission('proposals.view'),
    route({ query: ProposalListQuerySchema }, async ({ query }, req, res) => {
      // The Deleted bin is for those who may delete.
      if (query.deleted && !can(currentUser(req).roles, 'proposals.delete')) throw forbidden();
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
    '/:id/data-sheet/import',
    requirePermission('proposals.edit'),
    express.raw({
      type: [XLSX_CONTENT_TYPE, 'application/octet-stream'],
      limit: MAX_DATA_SHEET_BYTES,
    }),
    route(
      {
        params: ProposalIdParamsSchema,
        query: DataSheetImportQuerySchema,
        body: z.instanceof(Buffer, { error: 'Upload the Data Sheet workbook as the request body' }),
      },
      async ({ params, body }, _req, res) => {
        res.json(await readDataSheetImport(params.id, body));
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

  router.delete(
    '/:id',
    requirePermission('proposals.delete'),
    route({ params: ProposalIdParamsSchema }, async ({ params }, req, res) => {
      res.json(await deleteProposal(params.id, actorOf(req)));
    }),
  );

  router.post(
    '/:id/restore',
    requirePermission('proposals.delete'),
    route({ params: ProposalIdParamsSchema }, async ({ params }, req, res) => {
      res.json(await restoreProposal(params.id, actorOf(req)));
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
        const file = await rfqFileFor(record, query.format, options.gstRatePercent);
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

  router.post(
    '/:id/rfq/preview',
    requirePermission('proposals.send'),
    route(
      { params: ProposalIdParamsSchema, body: PreviewMailRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await previewMails(params.id, body, actorOf(req)));
      },
    ),
  );

  router.post(
    '/:id/rfq/email',
    requirePermission('proposals.send'),
    route(
      { params: ProposalIdParamsSchema, body: SendRfqRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await sendRfq(params.id, body, actorOf(req), mail));
      },
    ),
  );

  router.post(
    '/:id/insurers/:insurerId/reminder',
    requirePermission('proposals.send'),
    route(
      { params: ProposalInsurerParamsSchema, body: SendReminderRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await sendReminder(params.id, params.insurerId, body, actorOf(req), mail));
      },
    ),
  );

  router.put(
    '/:id/insurers/:insurerId/response',
    requirePermission('proposals.edit'),
    route(
      { params: ProposalInsurerParamsSchema, body: RecordInsurerResponseRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await recordResponse(params.id, params.insurerId, body, actorOf(req)));
      },
    ),
  );

  router.get(
    '/:id/mails',
    requirePermission('proposals.view'),
    route(
      { params: ProposalIdParamsSchema, query: MailListQuerySchema },
      async ({ params, query }, _req, res) => {
        await getProposal(params.id);
        res.json(await listCaseMails(params.id, query));
      },
    ),
  );

  router.get(
    '/:id/mails/:mailId',
    requirePermission('proposals.view'),
    route({ params: ProposalMailParamsSchema }, async ({ params }, _req, res) => {
      res.json(await getCaseMail(params.id, params.mailId));
    }),
  );

  router.get(
    '/:id/mails/:mailId/attachment',
    requirePermission('proposals.export'),
    route({ params: ProposalMailParamsSchema }, async ({ params }, req, res) => {
      const file = await caseMailAttachment(params.id, params.mailId);
      await writeAudit({
        userId: currentUser(req).id,
        action: AUDIT_ACTIONS.RFQ_DOWNLOADED,
        entity: AUDIT_ENTITIES.PROPOSAL,
        entityId: params.id,
        after: { fileName: file.fileName, mailId: params.mailId },
        requestId: req.requestId,
      });
      res.setHeader('Content-Type', file.contentType);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${file.fileName.replace(/["\r\n]/g, '')}"`,
      );
      res.send(file.data);
    }),
  );

  return router;
}

/**
 * A case in the Deleted bin answers "not found" on every /proposals/{id}/… route, whichever module
 * serves it (quotes, QCR, approval, slip, mail), except its restore. Mounted before those routers.
 */
export function liveCaseOnly(): RequestHandler {
  return (req, _res, next) => {
    const id = req.params.id;
    if (typeof id !== 'string' || !/^[0-9a-f]{24}$/i.test(id) || req.path === '/restore') {
      next();
      return;
    }
    ProposalModel.exists({ _id: new Types.ObjectId(id), deleted: { $ne: null } })
      .then((deleted) => next(deleted ? notFound('Proposal not found') : undefined))
      .catch(next);
  };
}

const json = (schema: z.ZodType) => ({ content: { 'application/json': { schema } } });

documentRoute({
  method: 'get',
  path: '/api/v1/proposals',
  tags: ['Proposals'],
  summary: 'List new-business proposals',
  description:
    'Needs proposals.view. Newest first; cursor pagination. deleted=true lists the Deleted bin instead (needs proposals.delete).',
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
  method: 'post',
  path: '/api/v1/proposals/{id}/data-sheet/import',
  tags: ['Proposals'],
  summary: 'Read the client’s Data Sheet workbook',
  description: `Needs proposals.edit. The workbook (.xlsx, up to ${MAX_DATA_SHEET_BYTES / 1024 / 1024} MB) is the request body, in the client’s Data Sheet format: each "DATA SHEET FOR PROPERTY INSURANCE" sheet is one location (Fire lines with sq ft × rate, hypothecation, stock in the open, risk features), with the other sections and the Annexure for the case. Answers what it read, the location each sheet most likely is, and warnings; nothing is saved (the web app fills the Data Sheet form, to be saved there). 400 for a file that is not such a workbook; 409 PROPOSAL_LOCKED once the RFQ has been sent.`,
  request: {
    params: ProposalIdParamsSchema,
    query: DataSheetImportQuerySchema,
    body: {
      content: { 'application/octet-stream': { schema: z.string().meta({ format: 'binary' }) } },
    },
  },
  responses: {
    200: { description: 'What the workbook holds', ...json(DataSheetImportSchema) },
    ...errorResponses(400, 401, 403, 404, 409, 413),
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
  summary: 'Mark the RFQ as sent outside the app',
  description:
    'Needs proposals.send. Records that the RFQ was sent to these insurers (already on the proposal) another way: who, when and the quote due date (dueDate, else the case’s). The proposal moves to RFQ Sent and its Data Sheet locks. Audited as a send.',
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
  method: 'delete',
  path: '/api/v1/proposals/{id}',
  tags: ['Proposals'],
  summary: 'Move a case to the Deleted bin',
  description:
    'Needs proposals.delete (Admins). The case is kept with all its work but left out of every list, worklist and action until restored. Audited.',
  request: { params: ProposalIdParamsSchema },
  responses: {
    200: { description: 'The case, now deleted', ...json(ProposalRecordSchema) },
    ...errorResponses(400, 401, 403, 404),
  },
});

documentRoute({
  method: 'post',
  path: '/api/v1/proposals/{id}/restore',
  tags: ['Proposals'],
  summary: 'Restore a case from the Deleted bin',
  description: 'Needs proposals.delete (Admins). The case comes back as it was. Audited.',
  request: { params: ProposalIdParamsSchema },
  responses: {
    200: { description: 'The case, restored', ...json(ProposalRecordSchema) },
    ...errorResponses(400, 401, 403, 404),
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

documentRoute({
  method: 'post',
  path: '/api/v1/proposals/{id}/rfq/preview',
  tags: ['RFQ mail'],
  summary: 'Preview the RFQ or reminder mails',
  description:
    'Needs proposals.send. The mails a send would make, one per insurer, from the saved template (kind RFQ or REMINDER). Addresses must be the insurer’s own in the insurer master. Sends and stores nothing.',
  request: { params: ProposalIdParamsSchema, body: json(PreviewMailRequestSchema) },
  responses: {
    200: { description: 'The mails', ...json(MailPreviewResponseSchema) },
    ...errorResponses(400, 401, 403, 404, 409),
  },
});

documentRoute({
  method: 'post',
  path: '/api/v1/proposals/{id}/rfq/email',
  tags: ['RFQ mail'],
  summary: 'Email the RFQ to insurers',
  description:
    'Needs proposals.send. One mail per insurer, To its chosen addresses only (never Cc or Bcc), with the RFQ attached (xlsx or pdf, at most 10 MB) and the quote due date. Each insurer gets SENT, FAILED (with the reason; it stays Not sent) or SKIPPED (already sent, or another send is in progress). Repeating a sendId mails nobody again. 409 MAIL_DISABLED when mail is off, DATA_SHEET_INCOMPLETE before the Data Sheet is complete; 422 RFQ_ATTACHMENT_TOO_LARGE. Every mail is logged against the case and audited.',
  request: { params: ProposalIdParamsSchema, body: json(SendRfqRequestSchema) },
  responses: {
    200: { description: 'Per-insurer results and the case', ...json(SendMailResponseSchema) },
    ...errorResponses(400, 401, 403, 404, 409, 422),
  },
});

documentRoute({
  method: 'post',
  path: '/api/v1/proposals/{id}/insurers/{insurerId}/reminder',
  tags: ['RFQ mail'],
  summary: 'Remind an insurer',
  description:
    'Needs proposals.send. For an insurer that is Sent or Reminded: one mail from the Reminder template to its chosen addresses, the RFQ attached when attachRfq. On success the insurer becomes Reminded and its reminder count goes up. 409 when it has answered or mail is off. Logged and audited.',
  request: { params: ProposalInsurerParamsSchema, body: json(SendReminderRequestSchema) },
  responses: {
    200: { description: 'The result and the case', ...json(SendMailResponseSchema) },
    ...errorResponses(400, 401, 403, 404, 409, 422),
  },
});

documentRoute({
  method: 'put',
  path: '/api/v1/proposals/{id}/insurers/{insurerId}/response',
  tags: ['RFQ mail'],
  summary: 'Record an insurer’s answer',
  description:
    'Needs proposals.edit. Quoted, Declined or No response, with an optional note, for an insurer that has the RFQ; an answer can be corrected to another answer. 409 for a change the status table does not allow. Audited.',
  request: {
    params: ProposalInsurerParamsSchema,
    body: json(RecordInsurerResponseRequestSchema),
  },
  responses: {
    200: { description: 'The case', ...json(ProposalRecordSchema) },
    ...errorResponses(400, 401, 403, 404, 409),
  },
});

documentRoute({
  method: 'get',
  path: '/api/v1/proposals/{id}/mails',
  tags: ['RFQ mail'],
  summary: 'The case’s mail log',
  description:
    'Needs proposals.view. Every RFQ and reminder mail of the case, delivered, kept in the outbox or failed: who sent it to whom and when. Newest first; cursor pagination.',
  request: { params: ProposalIdParamsSchema, query: MailListQuerySchema },
  responses: {
    200: { description: 'A page of mails', ...json(MailListResponseSchema) },
    ...errorResponses(400, 401, 403, 404),
  },
});

documentRoute({
  method: 'get',
  path: '/api/v1/proposals/{id}/mails/{mailId}',
  tags: ['RFQ mail'],
  summary: 'One mail with its text',
  description: 'Needs proposals.view. The mail as sent: From, To, subject, text and HTML bodies.',
  request: { params: ProposalMailParamsSchema },
  responses: {
    200: { description: 'The mail', ...json(MailDetailSchema) },
    ...errorResponses(400, 401, 403, 404),
  },
});

documentRoute({
  method: 'get',
  path: '/api/v1/proposals/{id}/mails/{mailId}/attachment',
  tags: ['RFQ mail'],
  summary: 'Download a mail’s attachment',
  description:
    'Needs proposals.export. The RFQ file exactly as the mail carried it. 404 when the mail had none. Audited as an export.',
  request: { params: ProposalMailParamsSchema },
  responses: {
    200: {
      description: 'The file',
      content: {
        [XLSX_CONTENT_TYPE]: { schema: z.string().meta({ format: 'binary' }) },
        [PDF_CONTENT_TYPE]: { schema: z.string().meta({ format: 'binary' }) },
      },
    },
    ...errorResponses(400, 401, 403, 404),
  },
});
