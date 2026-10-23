import {
  AssignEbPlanRequestSchema,
  CloseEbCaseRequestSchema,
  CommitEbImportRequestSchema,
  CorrectEbImportRowRequestSchema,
  CreateGpaQuoteRequestSchema,
  CreateGtliQuoteRequestSchema,
  DeclineGhiInsurerRequestSchema,
  DispatchGhiRfqRequestSchema,
  EbCaseParamsSchema,
  EbCaseRecordSchema,
  EbCensusImportSchema,
  EbCensusIssuesResponseSchema,
  EbCommitResultSchema,
  EbDispatchRfqResponseSchema,
  EbImportListResponseSchema,
  EbImportPreviewQuerySchema,
  EbMemberInputSchema,
  EbMemberListResponseSchema,
  EbMemberSchema,
  EbPaymentsResponseSchema,
  EbPlacementStateSchema,
  EbQcrDecisionRequestSchema,
  EbQcrListResponseSchema,
  EbQcrParamsSchema,
  EbQcrSchema,
  EbQcrSendResponseSchema,
  EbQuoteListResponseSchema,
  EbQuoteSchema,
  GhiCensusSummarySchema,
  GhiCensusUploadQuerySchema,
  GhiDecisionRequestSchema,
  GhiDocumentPreviewSchema,
  GhiDocumentQuerySchema,
  GhiFileListResponseSchema,
  GhiFileParamsSchema,
  GhiFileSchema,
  GhiFileUploadQuerySchema,
  GhiImportParamsSchema,
  GhiImportRowParamsSchema,
  GhiInsurerParamsSchema,
  GhiMemberListQuerySchema,
  GhiMemberParamsSchema,
  GhiPaymentParamsSchema,
  GhiQuoteParamsSchema,
  GhiRfqDocumentQuerySchema,
  GhiRfqStateSchema,
  GpaRequirementsInputSchema,
  GtliRequirementsInputSchema,
  IssueEbPlacementRequestSchema,
  MAX_GHI_CENSUS_BYTES,
  MAX_QUOTE_ATTACHMENT_BYTES,
  MarkGhiRfqSentRequestSchema,
  QUOTE_ATTACHMENT_TYPES,
  RecordEbClientDecisionRequestSchema,
  SaveEbPaymentRequestSchema,
  SaveEbQcrRequestSchema,
  SendEbQcrRequestSchema,
  SetGhiInsurersRequestSchema,
  UpdateEbCaseRequestSchema,
  UpdateGpaQuoteRequestSchema,
  UpdateGtliQuoteRequestSchema,
  XLSX_CONTENT_TYPE,
  EB_PRODUCT_SLUGS,
  type EbRoutedProduct,
  casePermission,
} from '../../shared/index.ts';
import express, { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth.ts';
import { requirePermission } from '../../middleware/require-permission.ts';
import { ebRawCensus, hiddenFields, redactEbMember } from './member-redaction.ts';
import { route } from '../../middleware/validate.ts';
import type { MailTransport } from '../mail/transport.ts';
import { getEbCase, saveEbRequirements, toEbCaseRecord } from './eb-cases.service.ts';
import {
  commitEbImport,
  correctEbImportRow,
  discardEbImport,
  ebErrorReport,
  getEbImport,
  listEbImports,
  uploadEbCensus,
} from './eb-census-import.service.ts';
import {
  addEbMember,
  deleteEbMember,
  ebCensusIssues,
  ebCensusSummary,
  listEbMembers,
  updateEbMember,
} from './eb-members.service.ts';
import { documentEbRoute } from './eb-openapi.ts';
import {
  addEbPayment,
  ebPlacementSlipFile,
  ebPlacementState,
  issueEbPlacement,
  listEbPayments,
  recordEbClientDecision,
  updateEbPayment,
} from './eb-placement.service.ts';
import { assignPlan } from './eb-plan-assignment.service.ts';
import {
  createEbQcr,
  decideEbQcr,
  ebQcrFile,
  listEbQcrs,
  sendEbQcr,
  submitEbQcr,
  updateEbQcr,
} from './eb-qcr.service.ts';
import {
  createEbQuote,
  deleteEbDraftQuote,
  listEbQuotes,
  updateEbQuote,
} from './eb-quotes.service.ts';
import { closeCaseOf, declineInsurerOf, setInsurersOf, updateCaseOf } from './ghi-cases.service.ts';
import { loadCase } from './ghi-common.ts';
import { caseFile, listFiles, uploadFile } from './ghi-files.service.ts';
import {
  decideRfq,
  dispatchRfqOf,
  generateRfq,
  markRfqSentOf,
  rfqFile,
  rfqPreview,
  rfqState,
  submitRfq,
} from './ghi-rfq.service.ts';
import { actorOf, sendFile } from './ghi.routes.ts';
import { scopeOf } from './products/profile.ts';

// The GPA and GTLI routers (N1, design D2), one per product from this factory, mounted at
// /api/v1/eb/gpa and /api/v1/eb/gtli. Every route loads cases of its own product only (a case of
// another product is not found, 2.9) and checks the product's permissions (24.1): viewing
// <product>.view, changes <product>.edit, approvals <product>.approve, mails <product>.send,
// downloads <product>.export. Raw census rows also need the employees.view_* permissions and the
// error report census.export (member-redaction.ts).

export function createEbProductRouter(
  product: EbRoutedProduct,
  options: { jwtSecret: string; mailTransport: MailTransport },
): Router {
  const scope = scopeOf(product);
  const transport = options.mailTransport;
  const router = Router();
  router.use(authenticate(options));
  const view = requirePermission(casePermission(product, 'view'));
  const edit = requirePermission(casePermission(product, 'edit'));
  const approve = requirePermission(casePermission(product, 'approve'));
  const send = requirePermission(casePermission(product, 'send'));
  const exportFile = requirePermission(casePermission(product, 'export'));
  const rawCensus = ebRawCensus();
  const censusExport = requirePermission('census.export');
  const P = EbCaseParamsSchema;
  const record = async (id: string) => toEbCaseRecord(await loadCase(id, undefined, scope));
  const requirementsSchema =
    product === 'GPA' ? GpaRequirementsInputSchema : GtliRequirementsInputSchema;
  const createQuoteSchema =
    product === 'GPA' ? CreateGpaQuoteRequestSchema : CreateGtliQuoteRequestSchema;
  const updateQuoteSchema =
    product === 'GPA' ? UpdateGpaQuoteRequestSchema : UpdateGtliQuoteRequestSchema;

  // Case (1, 2, 3, 4, 5, 15)
  router.get(
    '/cases/:id',
    view,
    route({ params: P }, async ({ params }, _req, res) => {
      res.json(await getEbCase(scope, params.id));
    }),
  );
  router.put(
    '/cases/:id',
    edit,
    route({ params: P, body: UpdateEbCaseRequestSchema }, async ({ params, body }, req, res) => {
      await updateCaseOf(params.id, body, actorOf(req), scope);
      res.json(await record(params.id));
    }),
  );
  router.post(
    '/cases/:id/close',
    edit,
    route({ params: P, body: CloseEbCaseRequestSchema }, async ({ params, body }, req, res) => {
      await closeCaseOf(params.id, body.reason, actorOf(req), scope);
      res.json(await record(params.id));
    }),
  );
  router.put(
    '/cases/:id/requirements',
    edit,
    route({ params: P, body: requirementsSchema }, async ({ params, body }, req, res) => {
      res.json(await saveEbRequirements(scope, params.id, body, actorOf(req)));
    }),
  );
  router.put(
    '/cases/:id/plan',
    edit,
    route({ params: P, body: AssignEbPlanRequestSchema }, async ({ params, body }, req, res) => {
      await assignPlan(scope, params.id, body.planId, actorOf(req));
      res.json(await record(params.id));
    }),
  );
  router.put(
    '/cases/:id/insurers',
    edit,
    route({ params: P, body: SetGhiInsurersRequestSchema }, async ({ params, body }, req, res) => {
      await setInsurersOf(params.id, body, actorOf(req), scope);
      res.json(await record(params.id));
    }),
  );
  router.post(
    '/cases/:id/insurers/:insurerId/decline',
    edit,
    route(
      { params: GhiInsurerParamsSchema, body: DeclineGhiInsurerRequestSchema },
      async ({ params, body }, req, res) => {
        await declineInsurerOf(params.id, params.insurerId, body.reason, actorOf(req), scope);
        res.json(await record(params.id));
      },
    ),
  );

  // Census (17, 18, 20 to 23)
  router.get(
    '/cases/:id/members',
    view,
    route({ params: P, query: GhiMemberListQuerySchema }, async ({ params, query }, req, res) => {
      const list = await listEbMembers(scope, params.id, query);
      const hidden = hiddenFields(req);
      res.json({ ...list, items: list.items.map((member) => redactEbMember(member, hidden)) });
    }),
  );
  router.post(
    '/cases/:id/members',
    edit,
    ...rawCensus,
    route({ params: P, body: EbMemberInputSchema }, async ({ params, body }, req, res) => {
      res.status(201).json(await addEbMember(scope, params.id, body, actorOf(req)));
    }),
  );
  router.put(
    '/cases/:id/members/:memberId',
    edit,
    ...rawCensus,
    route(
      { params: GhiMemberParamsSchema, body: EbMemberInputSchema },
      async ({ params, body }, req, res) => {
        res.json(await updateEbMember(scope, params.id, params.memberId, body, actorOf(req)));
      },
    ),
  );
  router.delete(
    '/cases/:id/members/:memberId',
    edit,
    route({ params: GhiMemberParamsSchema }, async ({ params }, req, res) => {
      await deleteEbMember(scope, params.id, params.memberId, actorOf(req));
      res.status(204).end();
    }),
  );
  router.get(
    '/cases/:id/census/summary',
    view,
    route({ params: P }, async ({ params }, _req, res) => {
      res.json(await ebCensusSummary(scope, params.id));
    }),
  );
  router.get(
    '/cases/:id/census/issues',
    view,
    route({ params: P }, async ({ params }, req, res) => {
      const result = await ebCensusIssues(await loadCase(params.id, undefined, scope));
      const hidden = hiddenFields(req);
      res.json({
        ...result,
        items: result.items.map((item) => ({
          ...item,
          member: redactEbMember(item.member, hidden),
        })),
      });
    }),
  );
  router.get(
    '/cases/:id/census/imports',
    view,
    route({ params: P }, async ({ params }, _req, res) => {
      res.json({ items: await listEbImports(scope, params.id) });
    }),
  );
  router.post(
    '/cases/:id/census/imports',
    edit,
    ...rawCensus,
    express.raw({
      type: [XLSX_CONTENT_TYPE, 'application/octet-stream'],
      limit: MAX_GHI_CENSUS_BYTES + 1024 * 1024,
    }),
    route(
      {
        params: P,
        query: GhiCensusUploadQuerySchema,
        body: z.instanceof(Buffer, { error: 'Upload the census workbook as the request body' }),
      },
      async ({ params, query, body }, req, res) => {
        res
          .status(201)
          .json(await uploadEbCensus(scope, params.id, body, query.fileName, actorOf(req)));
      },
    ),
  );
  router.get(
    '/cases/:id/census/imports/:importId',
    view,
    ...rawCensus,
    route(
      { params: GhiImportParamsSchema, query: EbImportPreviewQuerySchema },
      async ({ params, query }, _req, res) => {
        res.json(await getEbImport(scope, params.id, params.importId, query.mode));
      },
    ),
  );
  router.put(
    '/cases/:id/census/imports/:importId/rows/:row',
    edit,
    ...rawCensus,
    route(
      { params: GhiImportRowParamsSchema, body: CorrectEbImportRowRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(
          await correctEbImportRow(
            scope,
            params.id,
            params.importId,
            params.row,
            body.values,
            actorOf(req),
            body.mode,
          ),
        );
      },
    ),
  );
  router.post(
    '/cases/:id/census/imports/:importId/commit',
    edit,
    ...rawCensus,
    route(
      { params: GhiImportParamsSchema, body: CommitEbImportRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await commitEbImport(scope, params.id, params.importId, body, actorOf(req)));
      },
    ),
  );
  router.post(
    '/cases/:id/census/imports/:importId/discard',
    edit,
    route({ params: GhiImportParamsSchema }, async ({ params }, req, res) => {
      res.json(await discardEbImport(scope, params.id, params.importId, actorOf(req)));
    }),
  );
  router.get(
    '/cases/:id/census/imports/:importId/error-report',
    view,
    censusExport,
    route(
      { params: GhiImportParamsSchema, query: EbImportPreviewQuerySchema },
      async ({ params, query }, req, res) => {
        const file = await ebErrorReport(
          scope,
          params.id,
          params.importId,
          actorOf(req),
          query.mode,
        );
        res.setHeader('Cache-Control', 'no-store');
        sendFile(res, { ...file, contentType: XLSX_CONTENT_TYPE });
      },
    ),
  );

  // Files
  router.get(
    '/cases/:id/files',
    view,
    route({ params: P }, async ({ params }, _req, res) => {
      res.json(await listFiles(params.id, scope));
    }),
  );
  router.post(
    '/cases/:id/files',
    edit,
    express.raw({
      type: [...Object.keys(QUOTE_ATTACHMENT_TYPES), 'application/octet-stream'],
      limit: MAX_QUOTE_ATTACHMENT_BYTES,
    }),
    route(
      {
        params: P,
        query: GhiFileUploadQuerySchema,
        body: z.instanceof(Buffer, { error: 'Upload the file as the request body' }),
      },
      async ({ params, query, body }, req, res) => {
        res
          .status(201)
          .json(
            await uploadFile(params.id, query.purpose, query.fileName, body, actorOf(req), scope),
          );
      },
    ),
  );
  router.get(
    '/cases/:id/files/:fileId',
    view,
    route({ params: GhiFileParamsSchema }, async ({ params }, _req, res) => {
      sendFile(res, await caseFile(params.id, params.fileId, scope));
    }),
  );

  // RFQ (6)
  router.get(
    '/cases/:id/rfq',
    view,
    route({ params: P }, async ({ params }, _req, res) => {
      res.json(await rfqState(params.id, transport, scope));
    }),
  );
  router.get(
    '/cases/:id/rfq/preview',
    view,
    route({ params: P }, async ({ params }, _req, res) => {
      res.json(await rfqPreview(params.id, scope));
    }),
  );
  router.post(
    '/cases/:id/rfq/generate',
    edit,
    route({ params: P }, async ({ params }, req, res) => {
      res.status(201).json(await generateRfq(params.id, actorOf(req), transport, scope));
    }),
  );
  router.post(
    '/cases/:id/rfq/submit',
    edit,
    route({ params: P }, async ({ params }, req, res) => {
      res.json(await submitRfq(params.id, actorOf(req), transport, scope));
    }),
  );
  router.post(
    '/cases/:id/rfq/decision',
    approve,
    route({ params: P, body: GhiDecisionRequestSchema }, async ({ params, body }, req, res) => {
      res.json(await decideRfq(params.id, body, actorOf(req), transport, scope));
    }),
  );
  router.get(
    '/cases/:id/rfq/document',
    exportFile,
    // The member annexure carries dates of birth, salaries and nominees.
    ...rawCensus,
    route({ params: P, query: GhiRfqDocumentQuerySchema }, async ({ params, query }, req, res) => {
      sendFile(res, await rfqFile(params.id, query.format, actorOf(req), query.versionId, scope));
    }),
  );
  router.post(
    '/cases/:id/rfq/email',
    send,
    route({ params: P, body: DispatchGhiRfqRequestSchema }, async ({ params, body }, req, res) => {
      const results = await dispatchRfqOf(params.id, body, actorOf(req), transport, scope);
      res.json({ results, case: await record(params.id) });
    }),
  );
  router.post(
    '/cases/:id/rfq/sent',
    send,
    route({ params: P, body: MarkGhiRfqSentRequestSchema }, async ({ params, body }, req, res) => {
      await markRfqSentOf(params.id, body, actorOf(req), scope);
      res.json(await record(params.id));
    }),
  );

  // Quotes (7)
  router.get(
    '/cases/:id/quotes',
    view,
    route({ params: P }, async ({ params }, _req, res) => {
      res.json(await listEbQuotes(scope, params.id));
    }),
  );
  router.post(
    '/cases/:id/quotes',
    edit,
    route({ params: P, body: createQuoteSchema }, async ({ params, body }, req, res) => {
      res.status(201).json(await createEbQuote(scope, params.id, body, actorOf(req)));
    }),
  );
  router.put(
    '/cases/:id/quotes/:quoteId',
    edit,
    route(
      { params: GhiQuoteParamsSchema, body: updateQuoteSchema },
      async ({ params, body }, req, res) => {
        res.json(await updateEbQuote(scope, params.id, params.quoteId, body, actorOf(req)));
      },
    ),
  );
  router.delete(
    '/cases/:id/quotes/:quoteId',
    edit,
    route({ params: GhiQuoteParamsSchema }, async ({ params }, req, res) => {
      await deleteEbDraftQuote(scope, params.id, params.quoteId, actorOf(req));
      res.status(204).end();
    }),
  );

  // QCR, approval and the client's decision (8, 9)
  router.get(
    '/cases/:id/qcrs',
    view,
    route({ params: P }, async ({ params }, _req, res) => {
      res.json(await listEbQcrs(scope, params.id, transport));
    }),
  );
  router.post(
    '/cases/:id/qcrs',
    edit,
    route({ params: P, body: SaveEbQcrRequestSchema }, async ({ params, body }, req, res) => {
      res.status(201).json(await createEbQcr(scope, params.id, body, actorOf(req)));
    }),
  );
  router.put(
    '/cases/:id/qcrs/:qcrId',
    edit,
    route(
      { params: EbQcrParamsSchema, body: SaveEbQcrRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await updateEbQcr(scope, params.id, params.qcrId, body, actorOf(req)));
      },
    ),
  );
  router.post(
    '/cases/:id/qcrs/:qcrId/submit',
    edit,
    route({ params: EbQcrParamsSchema }, async ({ params }, req, res) => {
      res.json(await submitEbQcr(scope, params.id, params.qcrId, actorOf(req)));
    }),
  );
  router.post(
    '/cases/:id/qcrs/:qcrId/decision',
    approve,
    route(
      { params: EbQcrParamsSchema, body: EbQcrDecisionRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await decideEbQcr(scope, params.id, params.qcrId, body, actorOf(req)));
      },
    ),
  );
  router.get(
    '/cases/:id/qcrs/:qcrId/document',
    exportFile,
    route(
      { params: EbQcrParamsSchema, query: GhiDocumentQuerySchema },
      async ({ params, query }, req, res) => {
        sendFile(res, await ebQcrFile(scope, params.id, params.qcrId, query.format, actorOf(req)));
      },
    ),
  );
  router.post(
    '/cases/:id/qcrs/:qcrId/email',
    send,
    route(
      { params: EbQcrParamsSchema, body: SendEbQcrRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await sendEbQcr(scope, params.id, params.qcrId, body, actorOf(req), transport));
      },
    ),
  );
  router.post(
    '/cases/:id/qcrs/:qcrId/client-decision',
    edit,
    route(
      { params: EbQcrParamsSchema, body: RecordEbClientDecisionRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await recordEbClientDecision(scope, params.id, params.qcrId, body, actorOf(req)));
      },
    ),
  );

  // Payments and placement (10, 11)
  router.get(
    '/cases/:id/payments',
    view,
    route({ params: P }, async ({ params }, _req, res) => {
      res.json(await listEbPayments(scope, params.id));
    }),
  );
  router.post(
    '/cases/:id/payments',
    edit,
    route({ params: P, body: SaveEbPaymentRequestSchema }, async ({ params, body }, req, res) => {
      res.status(201).json(await addEbPayment(scope, params.id, body, actorOf(req)));
    }),
  );
  router.put(
    '/cases/:id/payments/:paymentId',
    edit,
    route(
      { params: GhiPaymentParamsSchema, body: SaveEbPaymentRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await updateEbPayment(scope, params.id, params.paymentId, body, actorOf(req)));
      },
    ),
  );
  router.get(
    '/cases/:id/placement',
    view,
    route({ params: P }, async ({ params }, _req, res) => {
      res.json(await ebPlacementState(scope, params.id));
    }),
  );
  router.get(
    '/cases/:id/placement-slip',
    exportFile,
    ...rawCensus,
    route({ params: P, query: GhiDocumentQuerySchema }, async ({ params, query }, req, res) => {
      sendFile(res, await ebPlacementSlipFile(scope, params.id, query.format, actorOf(req)));
    }),
  );
  router.post(
    '/cases/:id/placement',
    edit,
    route(
      { params: P, body: IssueEbPlacementRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await issueEbPlacement(scope, params.id, body, actorOf(req)));
      },
    ),
  );
  return router;
}

/** Documents both product routers in the OpenAPI document. */
function documentProductRoutes(product: EbRoutedProduct): void {
  const base = `/api/v1/eb/${EB_PRODUCT_SLUGS[product]}/cases/{id}`;
  const v = casePermission(product, 'view');
  const e = casePermission(product, 'edit');
  const items = [
    {
      method: 'get',
      path: base,
      summary: `Get a ${product} case`,
      permission: v,
      response: EbCaseRecordSchema,
    },
    {
      method: 'put',
      path: base,
      summary: 'Change dates, staff and expiring policy',
      permission: e,
      body: UpdateEbCaseRequestSchema,
      response: EbCaseRecordSchema,
    },
    {
      method: 'post',
      path: `${base}/close`,
      summary: 'Close the case with a reason',
      permission: e,
      body: CloseEbCaseRequestSchema,
      response: EbCaseRecordSchema,
    },
    {
      method: 'put',
      path: `${base}/requirements`,
      summary: `Save the ${product} Data Sheet`,
      permission: e,
      body: product === 'GPA' ? GpaRequirementsInputSchema : GtliRequirementsInputSchema,
      response: EbCaseRecordSchema,
    },
    {
      method: 'put',
      path: `${base}/plan`,
      summary: 'Assign or change the family plan',
      permission: e,
      body: AssignEbPlanRequestSchema,
      response: EbCaseRecordSchema,
    },
    {
      method: 'put',
      path: `${base}/insurers`,
      summary: 'Choose up to five insurers',
      permission: e,
      body: SetGhiInsurersRequestSchema,
      response: EbCaseRecordSchema,
    },
    {
      method: 'post',
      path: `${base}/insurers/{insurerId}/decline`,
      summary: 'Record that an insurer declined',
      permission: e,
      body: DeclineGhiInsurerRequestSchema,
      response: EbCaseRecordSchema,
    },
    {
      method: 'get',
      path: `${base}/members`,
      summary: 'Census members',
      permission: v,
      query: GhiMemberListQuerySchema,
      response: EbMemberListResponseSchema,
    },
    {
      method: 'post',
      path: `${base}/members`,
      summary: 'Add a census member (Census_Validator)',
      permission: e,
      body: EbMemberInputSchema,
      response: EbMemberSchema,
      status: 201,
    },
    {
      method: 'put',
      path: `${base}/members/{memberId}`,
      summary: 'Edit a census member',
      permission: e,
      body: EbMemberInputSchema,
      response: EbMemberSchema,
    },
    {
      method: 'delete',
      path: `${base}/members/{memberId}`,
      summary: 'Remove a census member',
      permission: e,
      status: 204,
    },
    {
      method: 'get',
      path: `${base}/census/summary`,
      summary: 'Census summary (GTLI: members above the free cover limit)',
      permission: v,
      response: GhiCensusSummarySchema,
    },
    {
      method: 'get',
      path: `${base}/census/issues`,
      summary: 'Whole-census issues and family shortfalls',
      permission: v,
      response: EbCensusIssuesResponseSchema,
    },
    {
      method: 'get',
      path: `${base}/census/imports`,
      summary: 'Census files of the case',
      permission: v,
      response: EbImportListResponseSchema,
    },
    {
      method: 'post',
      path: `${base}/census/imports`,
      summary: 'Upload and check a census file',
      permission: e,
      query: GhiCensusUploadQuerySchema,
      response: EbCensusImportSchema,
      status: 201,
      upload: XLSX_CONTENT_TYPE,
    },
    {
      method: 'get',
      path: `${base}/census/imports/{importId}`,
      summary: 'Preview under an import mode',
      permission: v,
      query: EbImportPreviewQuerySchema,
      response: EbCensusImportSchema,
    },
    {
      method: 'put',
      path: `${base}/census/imports/{importId}/rows/{row}`,
      summary: 'Correct a preview row',
      permission: e,
      body: CorrectEbImportRowRequestSchema,
      response: EbCensusImportSchema,
    },
    {
      method: 'post',
      path: `${base}/census/imports/{importId}/commit`,
      summary: 'Import by policy and mode (one transaction)',
      permission: e,
      body: CommitEbImportRequestSchema,
      response: EbCommitResultSchema,
    },
    {
      method: 'post',
      path: `${base}/census/imports/{importId}/discard`,
      summary: 'Set a preview aside',
      permission: e,
      response: EbCensusImportSchema,
    },
    {
      method: 'get',
      path: `${base}/census/imports/{importId}/error-report`,
      summary: 'The preview’s Excel error report',
      permission: v,
      query: EbImportPreviewQuerySchema,
      file: true,
    },
    {
      method: 'get',
      path: `${base}/files`,
      summary: 'Files kept on the case',
      permission: v,
      response: GhiFileListResponseSchema,
    },
    {
      method: 'post',
      path: `${base}/files`,
      summary: 'Upload a quote, client decision or payment file',
      permission: e,
      query: GhiFileUploadQuerySchema,
      response: GhiFileSchema,
      status: 201,
      upload: 'application/pdf',
    },
    {
      method: 'get',
      path: `${base}/files/{fileId}`,
      summary: 'Download a file of the case',
      permission: v,
      file: true,
    },
    {
      method: 'get',
      path: `${base}/rfq`,
      summary: 'RFQ versions and what blocks a new one',
      permission: v,
      response: GhiRfqStateSchema,
    },
    {
      method: 'get',
      path: `${base}/rfq/preview`,
      summary: 'The RFQ as it would be generated now',
      permission: v,
      response: GhiDocumentPreviewSchema,
    },
    {
      method: 'post',
      path: `${base}/rfq/generate`,
      summary: 'Generate a new RFQ version',
      permission: e,
      response: GhiRfqStateSchema,
      status: 201,
    },
    {
      method: 'post',
      path: `${base}/rfq/submit`,
      summary: 'Submit the latest RFQ for approval',
      permission: e,
      response: GhiRfqStateSchema,
    },
    {
      method: 'post',
      path: `${base}/rfq/decision`,
      summary: 'Approve or return the RFQ',
      permission: casePermission(product, 'approve'),
      body: GhiDecisionRequestSchema,
      response: GhiRfqStateSchema,
    },
    {
      method: 'get',
      path: `${base}/rfq/document`,
      summary: 'Download an RFQ version',
      permission: casePermission(product, 'export'),
      query: GhiRfqDocumentQuerySchema,
      file: true,
    },
    {
      method: 'post',
      path: `${base}/rfq/email`,
      summary: 'Email the approved RFQ to insurers',
      permission: casePermission(product, 'send'),
      body: DispatchGhiRfqRequestSchema,
      response: EbDispatchRfqResponseSchema,
    },
    {
      method: 'post',
      path: `${base}/rfq/sent`,
      summary: 'Mark the RFQ as sent outside the app',
      permission: casePermission(product, 'send'),
      body: MarkGhiRfqSentRequestSchema,
      response: EbCaseRecordSchema,
    },
    {
      method: 'get',
      path: `${base}/quotes`,
      summary: 'Quotes, every version',
      permission: v,
      response: EbQuoteListResponseSchema,
    },
    {
      method: 'post',
      path: `${base}/quotes`,
      summary: 'Save or record a quote',
      permission: e,
      body: product === 'GPA' ? CreateGpaQuoteRequestSchema : CreateGtliQuoteRequestSchema,
      response: EbQuoteSchema,
      status: 201,
    },
    {
      method: 'put',
      path: `${base}/quotes/{quoteId}`,
      summary: 'Edit or record a draft quote',
      permission: e,
      body: product === 'GPA' ? UpdateGpaQuoteRequestSchema : UpdateGtliQuoteRequestSchema,
      response: EbQuoteSchema,
    },
    {
      method: 'delete',
      path: `${base}/quotes/{quoteId}`,
      summary: 'Delete a draft quote',
      permission: e,
      status: 204,
    },
    {
      method: 'get',
      path: `${base}/qcrs`,
      summary: 'QCR versions and the current candidates',
      permission: v,
      response: EbQcrListResponseSchema,
    },
    {
      method: 'post',
      path: `${base}/qcrs`,
      summary: 'Prepare a QCR version',
      permission: e,
      body: SaveEbQcrRequestSchema,
      response: EbQcrSchema,
      status: 201,
    },
    {
      method: 'put',
      path: `${base}/qcrs/{qcrId}`,
      summary: 'Edit a draft or rejected QCR',
      permission: e,
      body: SaveEbQcrRequestSchema,
      response: EbQcrSchema,
    },
    {
      method: 'post',
      path: `${base}/qcrs/{qcrId}/submit`,
      summary: 'Submit the QCR for approval',
      permission: e,
      response: EbQcrSchema,
    },
    {
      method: 'post',
      path: `${base}/qcrs/{qcrId}/decision`,
      summary: 'Approve or reject the content shown',
      permission: casePermission(product, 'approve'),
      body: EbQcrDecisionRequestSchema,
      response: EbQcrSchema,
    },
    {
      method: 'get',
      path: `${base}/qcrs/{qcrId}/document`,
      summary: 'Download the QCR',
      permission: casePermission(product, 'export'),
      query: GhiDocumentQuerySchema,
      file: true,
    },
    {
      method: 'post',
      path: `${base}/qcrs/{qcrId}/email`,
      summary: 'Mail the approved QCR to the company’s contacts',
      permission: casePermission(product, 'send'),
      body: SendEbQcrRequestSchema,
      response: EbQcrSendResponseSchema,
    },
    {
      method: 'post',
      path: `${base}/qcrs/{qcrId}/client-decision`,
      summary: 'Record the client’s decision (agreed premium)',
      permission: e,
      body: RecordEbClientDecisionRequestSchema,
      response: EbQcrSchema,
    },
    {
      method: 'get',
      path: `${base}/payments`,
      summary: 'Payments against the agreed premium',
      permission: v,
      response: EbPaymentsResponseSchema,
    },
    {
      method: 'post',
      path: `${base}/payments`,
      summary: 'Record a payment',
      permission: e,
      body: SaveEbPaymentRequestSchema,
      response: EbPaymentsResponseSchema,
      status: 201,
    },
    {
      method: 'put',
      path: `${base}/payments/{paymentId}`,
      summary: 'Change a payment',
      permission: e,
      body: SaveEbPaymentRequestSchema,
      response: EbPaymentsResponseSchema,
    },
    {
      method: 'get',
      path: `${base}/placement`,
      summary: 'What the placement slip needs, or the placement',
      permission: v,
      response: EbPlacementStateSchema,
    },
    {
      method: 'get',
      path: `${base}/placement-slip`,
      summary: 'Download the placement slip',
      permission: casePermission(product, 'export'),
      query: GhiDocumentQuerySchema,
      file: true,
    },
    {
      method: 'post',
      path: `${base}/placement`,
      summary: 'Issue the placement slip: placed, with the policy snapshot',
      permission: e,
      body: IssueEbPlacementRequestSchema,
      response: EbCaseRecordSchema,
    },
  ] as const;
  for (const item of items) documentEbRoute(item);
}

documentProductRoutes('GPA');
documentProductRoutes('GTLI');
