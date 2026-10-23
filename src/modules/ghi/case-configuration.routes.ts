import {
  CaseRfqVersionParamsSchema,
  EbCaseRecordSchema,
  GhiCaseRecordSchema,
  GhiCaseParamsSchema,
  RfqSelectionSummaryResponseSchema,
  SelectAgeBandsRequestSchema,
  SelectionSummaryDocumentQuerySchema,
  casePermission,
} from '../../shared/index.ts';
import { Router } from 'express';
import type { z } from 'zod';
import { authenticate } from '../../middleware/auth.ts';
import { requirePermission } from '../../middleware/require-permission.ts';
import { route } from '../../middleware/validate.ts';
import { selectCaseAgeBands } from '../age-bands/age-bands.service.ts';
import { documentEbRoute } from './eb-openapi.ts';
import { caseLetterhead } from './ghi-rfq.service.ts';
import { actorOf, sendFile } from './ghi.routes.ts';
import type { CaseScope } from './products/profile.ts';
import {
  caseSelectionSummary,
  rfqVersionSelectionSummary,
  selectionSummaryFile,
} from './selection-summary.service.ts';

// A case's age bands (N4) and its RFQ Selection Summary Sheet (N7), the same for GMC
// (/api/v1/ghi) and for GPA and GTLI (/api/v1/eb/{gpa,gtli}). Choosing the bands needs
// <product>.edit, reading the summary <product>.view, downloading it <product>.export. Every
// call loads the case through its product scope, so an id of another product answers 404.

export function createCaseConfigurationRouter(options: {
  jwtSecret: string;
  scope: CaseScope;
  /** The case record the PUT answers with. */
  record: (id: string) => Promise<unknown>;
}): Router {
  const router = Router();
  router.use(authenticate(options));
  const { scope } = options;
  const P = GhiCaseParamsSchema;
  router.put(
    '/cases/:id/age-bands',
    requirePermission(casePermission(scope.product, 'edit')),
    route({ params: P, body: SelectAgeBandsRequestSchema }, async ({ params, body }, req, res) => {
      await selectCaseAgeBands(scope, params.id, body.setId, actorOf(req));
      res.json(await options.record(params.id));
    }),
  );
  router.get(
    '/cases/:id/rfq/selection-summary',
    requirePermission(casePermission(scope.product, 'view')),
    route({ params: P }, async ({ params }, _req, res) => {
      res.json(await caseSelectionSummary(scope, params.id));
    }),
  );
  router.get(
    '/cases/:id/rfq/selection-summary/document',
    requirePermission(casePermission(scope.product, 'export')),
    route(
      { params: P, query: SelectionSummaryDocumentQuerySchema },
      async ({ params, query }, req, res) => {
        sendFile(
          res,
          await selectionSummaryFile(
            scope,
            params.id,
            query.format,
            actorOf(req),
            await caseLetterhead(),
          ),
        );
      },
    ),
  );
  router.get(
    '/cases/:id/rfq/versions/:rfqId/selection-summary',
    requirePermission(casePermission(scope.product, 'view')),
    route({ params: CaseRfqVersionParamsSchema }, async ({ params }, _req, res) => {
      res.json(await rfqVersionSelectionSummary(scope, params.id, params.rfqId));
    }),
  );
  return router;
}

/** OpenAPI entries for one product's base path, for example /api/v1/eb/gpa/cases/{id}. */
export function documentCaseConfigurationRoutes(base: string, caseRecord: z.ZodType): void {
  for (const item of [
    {
      method: 'put',
      path: `${base}/age-bands`,
      summary:
        'Choose the case’s age band set (a copy of its current revision), or null for the standard bands',
      permission: '<product>.edit',
      body: SelectAgeBandsRequestSchema,
      response: caseRecord,
    },
    {
      method: 'get',
      path: `${base}/rfq/selection-summary`,
      summary: 'The RFQ selection summary from the census as it is now',
      permission: '<product>.view',
      response: RfqSelectionSummaryResponseSchema,
    },
    {
      method: 'get',
      path: `${base}/rfq/selection-summary/document`,
      summary: 'The RFQ selection summary as Excel or PDF (refused while it is incomplete)',
      permission: '<product>.export',
      query: SelectionSummaryDocumentQuerySchema,
      file: true,
    },
    {
      method: 'get',
      path: `${base}/rfq/versions/{rfqId}/selection-summary`,
      summary: 'The selection summary an RFQ version was generated with',
      permission: '<product>.view',
      response: RfqSelectionSummaryResponseSchema,
    },
  ] as const) {
    documentEbRoute(item, 'RFQ selection summary');
  }
}

documentCaseConfigurationRoutes('/api/v1/ghi/cases/{id}', GhiCaseRecordSchema);
documentCaseConfigurationRoutes('/api/v1/eb/gpa/cases/{id}', EbCaseRecordSchema);
documentCaseConfigurationRoutes('/api/v1/eb/gtli/cases/{id}', EbCaseRecordSchema);
