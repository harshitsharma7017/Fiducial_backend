import {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  CasePolicyParamsSchema,
  ClaimsAnalysisDocumentQuerySchema,
  ClaimsAnalysisQuerySchema,
  ClaimsAnalysisResponseSchema,
  PDF_CONTENT_TYPE,
  PremiumAdjustmentInputSchema,
  PremiumAdjustmentListResponseSchema,
  PremiumAdjustmentParamsSchema,
  RecordedPolicyYearInputSchema,
  RecordedPolicyYearListResponseSchema,
  RecordedPolicyYearParamsSchema,
  RecordedPolicyYearQuerySchema,
  RecordedPolicyYearSchema,
  RenewalAnalysisRequestSchema,
  RenewalAnalysisSchema,
  RenewalDocumentQuerySchema,
  RenewalOptionsQuerySchema,
  RenewalOptionsResponseSchema,
  RenewalReportParamsSchema,
  SaveRenewalReportRequestSchema,
  SavedRenewalReportListResponseSchema,
  SavedRenewalReportSchema,
  XLSX_CONTENT_TYPE,
} from '../../shared/index.ts';
import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth.ts';
import { requireClaimPermission, requirePermission } from '../../middleware/require-permission.ts';
import { route } from '../../middleware/validate.ts';
import { writeAudit } from '../audit/audit.service.ts';
import { documentEbRoute } from '../ghi/eb-openapi.ts';
import { caseLetterhead } from '../ghi/ghi-rfq.service.ts';
import { toPdf, toXlsx, type DocumentModel } from '../ghi/ghi-sheet.ts';
import { actorOf, sendFile } from '../ghi/ghi.routes.ts';
import { renewalDocument } from '../renewal/renewal-document.ts';
import {
  getRenewalReport,
  listRecordedYears,
  listRenewalReports,
  recordPolicyYear,
  renewalAnalysis,
  renewalOptions,
  saveRenewalReport,
  updatePolicyYear,
} from '../renewal/renewal.service.ts';
import { diagnosisVisibleTo } from '../tpa/tpa.routes.ts';
import { claimsAnalysisDocument } from './claims-analysis-document.ts';
import {
  addPremiumAdjustment,
  claimsAnalysis,
  premiumAdjustments,
  voidPremiumAdjustment,
} from './claims-analysis.service.ts';

// The claims analysis (N10, /api/v1/claims-analysis, claims_analysis.view, downloads
// claims_analysis.export; premium additions and deletions claims_analysis.manage_premiums) and the
// renewal analysis (N8, /api/v1/renewal, renewal_analysis.view; downloads renewal_analysis.export;
// recorded years and saved analyses renewal_analysis.manage). Every download
// is audited with its format; files are generated per request and never stored publicly.

async function fileOf(model: DocumentModel, format: 'xlsx' | 'pdf') {
  return format === 'pdf'
    ? {
        fileName: `${model.fileBase}.pdf`,
        contentType: PDF_CONTENT_TYPE,
        data: await toPdf(model, await caseLetterhead()),
      }
    : {
        fileName: `${model.fileBase}.xlsx`,
        contentType: XLSX_CONTENT_TYPE,
        data: await toXlsx(model),
      };
}

export function createAnalysisRouter(options: { jwtSecret: string }): Router {
  const router = Router();
  // Authentication per route: this router is mounted at the API root beside public routes.
  const auth = authenticate(options);
  // N12: a refused request for claim data is audited.
  const claimsView = requireClaimPermission('claims_analysis.view');
  const claimsExport = requireClaimPermission('claims_analysis.export');
  const premiums = requirePermission('claims_analysis.manage_premiums');
  const renewalView = requirePermission('renewal_analysis.view');
  const renewalExport = requirePermission('renewal_analysis.export');
  const renewalManage = requirePermission('renewal_analysis.manage');

  // N10
  router.get(
    '/claims-analysis',
    auth,
    claimsView,
    route({ query: ClaimsAnalysisQuerySchema }, async ({ query }, req, res) => {
      const diagnosisVisible = diagnosisVisibleTo(req);
      const { policy: _policy, ...response } = await claimsAnalysis(query, { diagnosisVisible });
      await writeAudit({
        userId: req.user!.id,
        action: AUDIT_ACTIONS.CLAIMS_ANALYSIS_VIEWED,
        entity: AUDIT_ENTITIES.INSURED_POLICY,
        entityId: query.caseId,
        before: null,
        after: {
          filters: response.header.filters,
          from: response.header.from,
          to: response.header.to,
          claims: response.details.total,
          diagnosisIncluded: diagnosisVisible,
          outcome: 'ALLOWED',
        },
        requestId: req.requestId,
      });
      res.json(response);
    }),
  );
  router.get(
    '/claims-analysis/document',
    auth,
    claimsExport,
    route({ query: ClaimsAnalysisDocumentQuerySchema }, async ({ query }, req, res) => {
      const diagnosisVisible = diagnosisVisibleTo(req);
      const { policy: _policy, ...response } = await claimsAnalysis(
        { ...query, page: 1, limit: 200 },
        { diagnosisVisible, allDetails: true },
      );
      const file = await fileOf(claimsAnalysisDocument(response), query.format);
      await writeAudit({
        userId: req.user!.id,
        action: AUDIT_ACTIONS.CLAIMS_ANALYSIS_DOWNLOADED,
        entity: AUDIT_ENTITIES.INSURED_POLICY,
        entityId: query.caseId,
        before: null,
        after: {
          format: query.format,
          filters: response.header.filters,
          from: response.header.from,
          to: response.header.to,
          claims: response.details.total,
          diagnosisIncluded: diagnosisVisible,
        },
        requestId: req.requestId,
      });
      sendFile(res, file);
    }),
  );
  router.get(
    '/claims-analysis/premium/:caseId',
    auth,
    claimsView,
    route({ params: CasePolicyParamsSchema }, async ({ params }, _req, res) => {
      res.json(await premiumAdjustments(params.caseId));
    }),
  );
  router.post(
    '/claims-analysis/premium/:caseId',
    auth,
    premiums,
    route(
      { params: CasePolicyParamsSchema, body: PremiumAdjustmentInputSchema },
      async ({ params, body }, req, res) => {
        res.status(201).json(await addPremiumAdjustment(params.caseId, body, actorOf(req)));
      },
    ),
  );
  router.post(
    '/claims-analysis/premium/:caseId/:adjustmentId/void',
    auth,
    premiums,
    route({ params: PremiumAdjustmentParamsSchema }, async ({ params }, req, res) => {
      res.json(await voidPremiumAdjustment(params.caseId, params.adjustmentId, actorOf(req)));
    }),
  );

  // N8
  router.get(
    '/renewal/options',
    auth,
    renewalView,
    route({ query: RenewalOptionsQuerySchema }, async ({ query }, _req, res) => {
      res.json(await renewalOptions(query.clientId, query.product));
    }),
  );
  router.post(
    '/renewal/analysis',
    auth,
    renewalView,
    route({ body: RenewalAnalysisRequestSchema }, async ({ body }, _req, res) => {
      res.json(await renewalAnalysis(body));
    }),
  );
  router.post(
    '/renewal/analysis/document',
    auth,
    renewalExport,
    route(
      { body: RenewalAnalysisRequestSchema, query: RenewalDocumentQuerySchema },
      async ({ body, query }, req, res) => {
        const analysis = await renewalAnalysis(body);
        const file = await fileOf(renewalDocument(analysis), query.format);
        await writeAudit({
          userId: req.user!.id,
          action: AUDIT_ACTIONS.RENEWAL_REPORT_DOWNLOADED,
          entity: AUDIT_ENTITIES.RENEWAL,
          entityId: body.clientId,
          before: null,
          after: { format: query.format, product: body.product, years: body.years, saved: false },
          requestId: req.requestId,
        });
        sendFile(res, file);
      },
    ),
  );
  router.get(
    '/renewal/years',
    auth,
    renewalView,
    route({ query: RecordedPolicyYearQuerySchema }, async ({ query }, _req, res) => {
      res.json(await listRecordedYears(query.clientId, query.product));
    }),
  );
  router.post(
    '/renewal/years',
    auth,
    renewalManage,
    route({ body: RecordedPolicyYearInputSchema }, async ({ body }, req, res) => {
      res.status(201).json(await recordPolicyYear(body, actorOf(req)));
    }),
  );
  router.put(
    '/renewal/years/:yearId',
    auth,
    renewalManage,
    route(
      { params: RecordedPolicyYearParamsSchema, body: RecordedPolicyYearInputSchema },
      async ({ params, body }, req, res) => {
        res.json(await updatePolicyYear(params.yearId, body, actorOf(req)));
      },
    ),
  );
  router.get(
    '/renewal/reports',
    auth,
    renewalView,
    route(
      { query: z.strictObject({ clientId: z.string().regex(/^[a-f0-9]{24}$/i) }) },
      async ({ query }, _req, res) => {
        res.json(await listRenewalReports(query.clientId));
      },
    ),
  );
  router.post(
    '/renewal/reports',
    auth,
    renewalManage,
    route({ body: SaveRenewalReportRequestSchema }, async ({ body }, req, res) => {
      res.status(201).json(await saveRenewalReport(body, actorOf(req)));
    }),
  );
  router.get(
    '/renewal/reports/:reportId',
    auth,
    renewalView,
    route({ params: RenewalReportParamsSchema }, async ({ params }, _req, res) => {
      res.json(await getRenewalReport(params.reportId));
    }),
  );
  router.get(
    '/renewal/reports/:reportId/document',
    auth,
    renewalExport,
    route(
      { params: RenewalReportParamsSchema, query: RenewalDocumentQuerySchema },
      async ({ params, query }, req, res) => {
        const report = await getRenewalReport(params.reportId);
        const file = await fileOf(renewalDocument(report.analysis, report.title), query.format);
        await writeAudit({
          userId: req.user!.id,
          action: AUDIT_ACTIONS.RENEWAL_REPORT_DOWNLOADED,
          entity: AUDIT_ENTITIES.RENEWAL,
          entityId: report.analysis.clientId,
          before: null,
          after: { format: query.format, reportId: params.reportId, saved: true },
          requestId: req.requestId,
        });
        sendFile(res, file);
      },
    ),
  );
  return router;
}

for (const item of [
  {
    method: 'get',
    path: '/api/v1/claims-analysis',
    summary: 'Claims analysis of a placed policy',
    permission: 'claims_analysis.view',
    query: ClaimsAnalysisQuerySchema,
    response: ClaimsAnalysisResponseSchema,
  },
  {
    method: 'get',
    path: '/api/v1/claims-analysis/document',
    summary: 'Claims analysis as Excel or PDF (the same filters)',
    permission: 'claims_analysis.export',
    query: ClaimsAnalysisDocumentQuerySchema,
    file: true,
  },
  {
    method: 'get',
    path: '/api/v1/claims-analysis/premium/{caseId}',
    summary: 'A policy’s premium and its additions and deletions',
    permission: 'claims_analysis.view',
    response: PremiumAdjustmentListResponseSchema,
  },
  {
    method: 'post',
    path: '/api/v1/claims-analysis/premium/{caseId}',
    summary: 'Record a premium addition or deletion',
    permission: 'claims_analysis.manage_premiums',
    body: PremiumAdjustmentInputSchema,
    response: PremiumAdjustmentListResponseSchema,
    status: 201,
  },
  {
    method: 'post',
    path: '/api/v1/claims-analysis/premium/{caseId}/{adjustmentId}/void',
    summary: 'Void a premium addition or deletion',
    permission: 'claims_analysis.manage_premiums',
    response: PremiumAdjustmentListResponseSchema,
  },
  {
    method: 'get',
    path: '/api/v1/renewal/options',
    summary: 'A company’s policy years and open cases for a product',
    permission: 'renewal_analysis.view',
    query: RenewalOptionsQuerySchema,
    response: RenewalOptionsResponseSchema,
  },
  {
    method: 'post',
    path: '/api/v1/renewal/analysis',
    summary: 'Benefit and cost analysis of up to three policy years',
    permission: 'renewal_analysis.view',
    body: RenewalAnalysisRequestSchema,
    response: RenewalAnalysisSchema,
  },
  {
    method: 'post',
    path: '/api/v1/renewal/analysis/document',
    summary: 'Benefit and cost analysis as Excel or PDF',
    permission: 'renewal_analysis.export',
    body: RenewalAnalysisRequestSchema,
    query: RenewalDocumentQuerySchema,
    file: true,
  },
  {
    method: 'get',
    path: '/api/v1/renewal/years',
    summary: 'Policy years recorded by hand',
    permission: 'renewal_analysis.view',
    query: RecordedPolicyYearQuerySchema,
    response: RecordedPolicyYearListResponseSchema,
  },
  {
    method: 'post',
    path: '/api/v1/renewal/years',
    summary: 'Record a policy year by hand',
    permission: 'renewal_analysis.manage',
    body: RecordedPolicyYearInputSchema,
    response: RecordedPolicyYearSchema,
    status: 201,
  },
  {
    method: 'put',
    path: '/api/v1/renewal/years/{yearId}',
    summary: 'Edit a recorded policy year',
    permission: 'renewal_analysis.manage',
    body: RecordedPolicyYearInputSchema,
    response: RecordedPolicyYearSchema,
  },
  {
    method: 'get',
    path: '/api/v1/renewal/reports',
    summary: 'Saved benefit and cost analyses',
    permission: 'renewal_analysis.view',
    response: SavedRenewalReportListResponseSchema,
  },
  {
    method: 'post',
    path: '/api/v1/renewal/reports',
    summary: 'Save a benefit and cost analysis (kept as generated)',
    permission: 'renewal_analysis.manage',
    body: SaveRenewalReportRequestSchema,
    response: SavedRenewalReportSchema,
    status: 201,
  },
  {
    method: 'get',
    path: '/api/v1/renewal/reports/{reportId}',
    summary: 'A saved analysis',
    permission: 'renewal_analysis.view',
    response: SavedRenewalReportSchema,
  },
  {
    method: 'get',
    path: '/api/v1/renewal/reports/{reportId}/document',
    summary: 'A saved analysis as Excel or PDF',
    permission: 'renewal_analysis.export',
    query: RenewalDocumentQuerySchema,
    file: true,
  },
] as const) {
  documentEbRoute(item, item.path.includes('renewal') ? 'Renewal analysis' : 'Claims analysis');
}
