import {
  AssignEbPlanRequestSchema,
  GhiImportPreviewQuerySchema,
  CloseGhiCaseRequestSchema,
  CommitGhiImportRequestSchema,
  CorrectGhiImportRowRequestSchema,
  CreateGhiCaseRequestSchema,
  DeclineGhiInsurerRequestSchema,
  GhiCaseListQuerySchema,
  GhiCaseListResponseSchema,
  GhiCaseParamsSchema,
  GhiCaseRecordSchema,
  GhiCensusImportSchema,
  GhiCensusIssueSchema,
  GhiCensusSummarySchema,
  GhiCensusUploadQuerySchema,
  GhiCommitResultSchema,
  GhiFileListResponseSchema,
  GhiFileParamsSchema,
  GhiFileSchema,
  GhiFileUploadQuerySchema,
  GhiImportListResponseSchema,
  GhiImportParamsSchema,
  GhiImportRowParamsSchema,
  GhiInsurerParamsSchema,
  GhiMemberInputSchema,
  GhiMemberListQuerySchema,
  GhiMemberListResponseSchema,
  GhiMemberParamsSchema,
  GhiMemberSchema,
  GhiRequirementsInputSchema,
  MAX_GHI_CENSUS_BYTES,
  MAX_QUOTE_ATTACHMENT_BYTES,
  QUOTE_ATTACHMENT_TYPES,
  SetGhiInsurersRequestSchema,
  UpdateGhiCaseRequestSchema,
  XLSX_CONTENT_TYPE,
} from '../../shared/index.ts';
import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { documentRoute, errorResponses } from '../../lib/openapi.ts';
import { authenticate } from '../../middleware/auth.ts';
import { currentUser, requirePermission } from '../../middleware/require-permission.ts';
import { route } from '../../middleware/validate.ts';
import {
  addMember,
  censusIssues,
  censusSummary,
  commitImport,
  correctImportRow,
  deleteMember,
  discardImport,
  getImport,
  importErrorReport,
  listImports,
  listMembers,
  updateMember,
  uploadCensus,
} from './census.service.ts';
import { buildCensusTemplate } from './census-workbook.ts';
import {
  closeCase,
  createCase,
  declineInsurer,
  getCase,
  listCases,
  saveRequirements,
  setInsurers,
  updateCase,
} from './ghi-cases.service.ts';
import { loadCase, type Actor } from './ghi-common.ts';
import { caseFile, listFiles, uploadFile } from './ghi-files.service.ts';
import { assignPlan } from './eb-plan-assignment.service.ts';
import { GMC_SCOPE } from './products/profile.ts';

// Group health cases (G1 to G3) under /api/v1/ghi. They use the proposal permissions, as a GHI
// case is a proposal of another line of business: viewing proposals.view, creating
// proposals.create, the Data Sheet, census, insurers and files proposals.edit.

export function actorOf(req: Request): Actor {
  return { id: currentUser(req).id, requestId: req.requestId };
}

/** Sends a file with a safe download name. */
export function sendFile(
  res: Response,
  file: { fileName: string; contentType: string; data: Buffer },
) {
  res.setHeader('Content-Type', file.contentType);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${file.fileName.replace(/[^\w.\-+ ]/g, '_')}"`,
  );
  res.send(file.data);
}

export function createGhiRouter(options: { jwtSecret: string; gstRatePercent: string }): Router {
  const router = Router();
  router.use(authenticate(options));
  const view = requirePermission('proposals.view');
  const edit = requirePermission('proposals.edit');

  router.get(
    '/cases',
    view,
    route({ query: GhiCaseListQuerySchema }, async ({ query }, _req, res) => {
      res.json(await listCases(query));
    }),
  );
  router.post(
    '/cases',
    requirePermission('proposals.create'),
    route({ body: CreateGhiCaseRequestSchema }, async ({ body }, req, res) => {
      res
        .status(201)
        .json(
          await createCase(body, actorOf(req), { defaultGstRatePercent: options.gstRatePercent }),
        );
    }),
  );
  router.get(
    '/cases/:id',
    view,
    route({ params: GhiCaseParamsSchema }, async ({ params }, _req, res) => {
      res.json(await getCase(params.id));
    }),
  );
  router.put(
    '/cases/:id',
    edit,
    route(
      { params: GhiCaseParamsSchema, body: UpdateGhiCaseRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await updateCase(params.id, body, actorOf(req)));
      },
    ),
  );
  router.post(
    '/cases/:id/close',
    edit,
    route(
      { params: GhiCaseParamsSchema, body: CloseGhiCaseRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await closeCase(params.id, body.reason, actorOf(req)));
      },
    ),
  );
  router.put(
    '/cases/:id/requirements',
    edit,
    route(
      { params: GhiCaseParamsSchema, body: GhiRequirementsInputSchema },
      async ({ params, body }, req, res) => {
        res.json(await saveRequirements(params.id, body, actorOf(req)));
      },
    ),
  );
  router.put(
    '/cases/:id/plan',
    edit,
    route(
      { params: GhiCaseParamsSchema, body: AssignEbPlanRequestSchema },
      async ({ params, body }, req, res) => {
        await assignPlan(GMC_SCOPE, params.id, body.planId, actorOf(req));
        res.json(await getCase(params.id));
      },
    ),
  );
  router.put(
    '/cases/:id/insurers',
    edit,
    route(
      { params: GhiCaseParamsSchema, body: SetGhiInsurersRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await setInsurers(params.id, body, actorOf(req)));
      },
    ),
  );
  router.post(
    '/cases/:id/insurers/:insurerId/decline',
    edit,
    route(
      { params: GhiInsurerParamsSchema, body: DeclineGhiInsurerRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await declineInsurer(params.id, params.insurerId, body.reason, actorOf(req)));
      },
    ),
  );

  // Census (G3, G4)
  router.get(
    '/census-template',
    view,
    route({}, async (_input, _req, res) => {
      sendFile(res, {
        fileName: 'GHI-Census-Template.xlsx',
        contentType: XLSX_CONTENT_TYPE,
        data: await buildCensusTemplate(),
      });
    }),
  );
  router.get(
    '/cases/:id/members',
    view,
    route(
      { params: GhiCaseParamsSchema, query: GhiMemberListQuerySchema },
      async ({ params, query }, _req, res) => {
        res.json(await listMembers(params.id, query));
      },
    ),
  );
  router.post(
    '/cases/:id/members',
    edit,
    route(
      { params: GhiCaseParamsSchema, body: GhiMemberInputSchema },
      async ({ params, body }, req, res) => {
        res.status(201).json(await addMember(params.id, body, actorOf(req)));
      },
    ),
  );
  router.put(
    '/cases/:id/members/:memberId',
    edit,
    route(
      { params: GhiMemberParamsSchema, body: GhiMemberInputSchema },
      async ({ params, body }, req, res) => {
        res.json(await updateMember(params.id, params.memberId, body, actorOf(req)));
      },
    ),
  );
  router.delete(
    '/cases/:id/members/:memberId',
    edit,
    route({ params: GhiMemberParamsSchema }, async ({ params }, req, res) => {
      await deleteMember(params.id, params.memberId, actorOf(req));
      res.status(204).end();
    }),
  );
  router.get(
    '/cases/:id/census/summary',
    view,
    route({ params: GhiCaseParamsSchema }, async ({ params }, _req, res) => {
      res.json(await censusSummary(params.id));
    }),
  );
  router.get(
    '/cases/:id/census/issues',
    view,
    route({ params: GhiCaseParamsSchema }, async ({ params }, _req, res) => {
      res.json({ items: await censusIssues(await loadCase(params.id)) });
    }),
  );
  router.get(
    '/cases/:id/census/imports',
    view,
    route({ params: GhiCaseParamsSchema }, async ({ params }, _req, res) => {
      res.json(await listImports(params.id));
    }),
  );
  router.post(
    '/cases/:id/census/imports',
    edit,
    express.raw({
      type: [XLSX_CONTENT_TYPE, 'application/octet-stream'],
      limit: MAX_GHI_CENSUS_BYTES,
    }),
    route(
      {
        params: GhiCaseParamsSchema,
        query: GhiCensusUploadQuerySchema,
        body: z.instanceof(Buffer, { error: 'Upload the census workbook as the request body' }),
      },
      async ({ params, query, body }, req, res) => {
        res.status(201).json(await uploadCensus(params.id, body, query.fileName, actorOf(req)));
      },
    ),
  );
  router.get(
    '/cases/:id/census/imports/:importId',
    view,
    route(
      { params: GhiImportParamsSchema, query: GhiImportPreviewQuerySchema },
      async ({ params, query }, _req, res) => {
        res.json(await getImport(params.id, params.importId, query.mode));
      },
    ),
  );
  router.get(
    '/cases/:id/census/imports/:importId/error-report',
    view,
    route(
      { params: GhiImportParamsSchema, query: GhiImportPreviewQuerySchema },
      async ({ params, query }, req, res) => {
        const file = await importErrorReport(params.id, params.importId, actorOf(req), query.mode);
        res.setHeader('Cache-Control', 'no-store');
        sendFile(res, { ...file, contentType: XLSX_CONTENT_TYPE });
      },
    ),
  );
  router.put(
    '/cases/:id/census/imports/:importId/rows/:row',
    edit,
    route(
      { params: GhiImportRowParamsSchema, body: CorrectGhiImportRowRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(
          await correctImportRow(params.id, params.importId, params.row, body.values, actorOf(req)),
        );
      },
    ),
  );
  router.post(
    '/cases/:id/census/imports/:importId/commit',
    edit,
    route(
      { params: GhiImportParamsSchema, body: CommitGhiImportRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(
          await commitImport(params.id, params.importId, body.policy, actorOf(req), body.mode),
        );
      },
    ),
  );
  router.post(
    '/cases/:id/census/imports/:importId/discard',
    edit,
    route({ params: GhiImportParamsSchema }, async ({ params }, req, res) => {
      res.json(await discardImport(params.id, params.importId, actorOf(req)));
    }),
  );

  // Files kept on the case
  router.get(
    '/cases/:id/files',
    view,
    route({ params: GhiCaseParamsSchema }, async ({ params }, _req, res) => {
      res.json(await listFiles(params.id));
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
        params: GhiCaseParamsSchema,
        query: GhiFileUploadQuerySchema,
        body: z.instanceof(Buffer, { error: 'Upload the file as the request body' }),
      },
      async ({ params, query, body }, req, res) => {
        res
          .status(201)
          .json(await uploadFile(params.id, query.purpose, query.fileName, body, actorOf(req)));
      },
    ),
  );
  router.get(
    '/cases/:id/files/:fileId',
    view,
    route({ params: GhiFileParamsSchema }, async ({ params }, _req, res) => {
      sendFile(res, await caseFile(params.id, params.fileId));
    }),
  );

  return router;
}

const json = (schema: z.ZodType) => ({ content: { 'application/json': { schema } } });
const tags = ['Group health'];
const base = '/api/v1/ghi/cases/{id}';

for (const item of [
  {
    method: 'get',
    path: '/api/v1/ghi/cases',
    summary: 'List group health cases',
    permission: 'proposals.view',
    query: GhiCaseListQuerySchema,
    response: GhiCaseListResponseSchema,
  },
  {
    method: 'post',
    path: '/api/v1/ghi/cases',
    summary: 'Create a group health case (new business or renewal)',
    permission: 'proposals.create',
    body: CreateGhiCaseRequestSchema,
    response: GhiCaseRecordSchema,
    status: 201,
  },
  {
    method: 'get',
    path: base,
    summary: 'Get a group health case',
    permission: 'proposals.view',
    response: GhiCaseRecordSchema,
  },
  {
    method: 'put',
    path: base,
    summary: 'Change the case’s dates, staff and expiring policy',
    permission: 'proposals.edit',
    body: UpdateGhiCaseRequestSchema,
    response: GhiCaseRecordSchema,
  },
  {
    method: 'post',
    path: `${base}/close`,
    summary: 'Close the case (lost or not renewed)',
    permission: 'proposals.edit',
    body: CloseGhiCaseRequestSchema,
    response: GhiCaseRecordSchema,
  },
  {
    method: 'put',
    path: `${base}/requirements`,
    summary: 'Save the GHI Data Sheet (G2)',
    permission: 'proposals.edit',
    body: GhiRequirementsInputSchema,
    response: GhiCaseRecordSchema,
  },
  {
    method: 'put',
    path: `${base}/plan`,
    summary: 'Assign or change the family plan (N2; optional on GMC cases)',
    permission: 'proposals.edit',
    body: AssignEbPlanRequestSchema,
    response: GhiCaseRecordSchema,
  },
  {
    method: 'put',
    path: `${base}/insurers`,
    summary: 'Choose up to five insurers for the RFQ',
    permission: 'proposals.edit',
    body: SetGhiInsurersRequestSchema,
    response: GhiCaseRecordSchema,
  },
  {
    method: 'post',
    path: `${base}/insurers/{insurerId}/decline`,
    summary: 'Record that an insurer declined',
    permission: 'proposals.edit',
    body: DeclineGhiInsurerRequestSchema,
    response: GhiCaseRecordSchema,
  },
  {
    method: 'get',
    path: '/api/v1/ghi/census-template',
    summary: 'Download the census Excel template',
    permission: 'proposals.view',
    file: true,
  },
  {
    method: 'get',
    path: `${base}/members`,
    summary: 'Census members, searchable, with page numbers',
    permission: 'proposals.view',
    query: GhiMemberListQuerySchema,
    response: GhiMemberListResponseSchema,
  },
  {
    method: 'post',
    path: `${base}/members`,
    summary: 'Add a census member (checked against the family rules)',
    permission: 'proposals.edit',
    body: GhiMemberInputSchema,
    response: GhiMemberSchema,
    status: 201,
  },
  {
    method: 'put',
    path: `${base}/members/{memberId}`,
    summary: 'Edit a census member',
    permission: 'proposals.edit',
    body: GhiMemberInputSchema,
    response: GhiMemberSchema,
  },
  {
    method: 'delete',
    path: `${base}/members/{memberId}`,
    summary: 'Remove a census member',
    permission: 'proposals.edit',
    status: 204,
  },
  {
    method: 'get',
    path: `${base}/census/summary`,
    summary: 'Census summary (G4)',
    permission: 'proposals.view',
    response: GhiCensusSummarySchema,
  },
  {
    method: 'get',
    path: `${base}/census/issues`,
    summary: 'Members that no longer fit the Data Sheet',
    permission: 'proposals.view',
    response: z.object({
      items: z.array(z.object({ member: GhiMemberSchema, issues: z.array(GhiCensusIssueSchema) })),
    }),
  },
  {
    method: 'get',
    path: `${base}/census/imports`,
    summary: 'Census files uploaded to the case',
    permission: 'proposals.view',
    response: GhiImportListResponseSchema,
  },
  {
    method: 'post',
    path: `${base}/census/imports`,
    summary: 'Upload and check a census file (nothing is imported yet)',
    permission: 'proposals.edit',
    query: GhiCensusUploadQuerySchema,
    response: GhiCensusImportSchema,
    status: 201,
    upload: XLSX_CONTENT_TYPE,
  },
  {
    method: 'get',
    path: `${base}/census/imports/{importId}`,
    summary: 'A checked census file with each row’s problems (optionally under an import mode)',
    permission: 'proposals.view',
    query: GhiImportPreviewQuerySchema,
    response: GhiCensusImportSchema,
  },
  {
    method: 'get',
    path: `${base}/census/imports/{importId}/error-report`,
    summary: 'The census file’s rows with issues as an Excel error report',
    permission: 'proposals.view',
    query: GhiImportPreviewQuerySchema,
    file: true,
  },
  {
    method: 'put',
    path: `${base}/census/imports/{importId}/rows/{row}`,
    summary: 'Correct a row of a checked file',
    permission: 'proposals.edit',
    body: CorrectGhiImportRowRequestSchema,
    response: GhiCensusImportSchema,
  },
  {
    method: 'post',
    path: `${base}/census/imports/{importId}/commit`,
    summary: 'Import the checked file by the policy chosen (one transaction)',
    permission: 'proposals.edit',
    body: CommitGhiImportRequestSchema,
    response: GhiCommitResultSchema,
  },
  {
    method: 'post',
    path: `${base}/census/imports/{importId}/discard`,
    summary: 'Set a checked file aside',
    permission: 'proposals.edit',
    response: GhiCensusImportSchema,
  },
  {
    method: 'get',
    path: `${base}/files`,
    summary: 'Files kept on the case',
    permission: 'proposals.view',
    response: GhiFileListResponseSchema,
  },
  {
    method: 'post',
    path: `${base}/files`,
    summary: 'Upload a quote, client decision, payment proof or policy copy',
    permission: 'proposals.edit',
    query: GhiFileUploadQuerySchema,
    response: GhiFileSchema,
    status: 201,
    upload: 'application/pdf',
  },
  {
    method: 'get',
    path: `${base}/files/{fileId}`,
    summary: 'Download a file of the case',
    permission: 'proposals.view',
    file: true,
  },
] as const) {
  documentGhiRoute(item);
}

/** Documents one GHI route in the OpenAPI document. */
export function documentGhiRoute(item: {
  method: 'get' | 'post' | 'put' | 'delete';
  path: string;
  summary: string;
  permission: string;
  query?: z.ZodType;
  body?: z.ZodType;
  response?: z.ZodType;
  status?: number;
  file?: boolean;
  upload?: string;
}) {
  const ok = item.status ?? 200;
  documentRoute({
    method: item.method,
    path: item.path,
    tags,
    summary: item.summary,
    description: `Needs ${item.permission}.`,
    request: {
      ...(item.query ? { query: item.query as z.ZodObject } : {}),
      ...(item.body ? { body: json(item.body) } : {}),
      ...(item.upload
        ? { body: { content: { [item.upload]: { schema: { type: 'string', format: 'binary' } } } } }
        : {}),
    },
    responses: {
      [ok]: item.file
        ? {
            description: 'The file',
            content: {
              'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
            },
          }
        : item.response
          ? { description: 'OK', ...json(item.response) }
          : { description: 'Done' },
      ...errorResponses(400, 401, 403, 404, 409),
    },
  });
}
