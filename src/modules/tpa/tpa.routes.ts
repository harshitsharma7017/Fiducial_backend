import {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  ClaimImportSettingsResponseSchema,
  ClaimImportSettingsSchema,
  type AuditAction,
  CommitTpaImportRequestSchema,
  InsuredPolicyListResponseSchema,
  InsuredPolicyQuerySchema,
  LinkTpaClaimRequestSchema,
  TpaClaimHistorySchema,
  TpaClaimListQuerySchema,
  TpaClaimListResponseSchema,
  TpaClaimParamsSchema,
  TpaClaimRecordSchema,
  TpaFormatInputSchema,
  TpaFormatListResponseSchema,
  TpaFormatParamsSchema,
  TpaFormatSchema,
  TpaImportListQuerySchema,
  TpaImportListResponseSchema,
  TpaImportParamsSchema,
  TpaImportRowsQuerySchema,
  TpaImportRowsResponseSchema,
  TpaImportSchema,
  TpaInspectQuerySchema,
  TpaInspectResponseSchema,
  TpaUploadQuerySchema,
  XLSX_CONTENT_TYPE,
  can,
} from '../../shared/index.ts';
import express, { Router, type Request } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth.ts';
import { currentUser, requireClaimPermission } from '../../middleware/require-permission.ts';
import { writeAudit } from '../audit/audit.service.ts';
import type { MailTransport } from '../mail/transport.ts';
import { claimImportSettings, setClaimImportSettings } from './tpa-board.service.ts';
import { route } from '../../middleware/validate.ts';
import { documentEbRoute } from '../ghi/eb-openapi.ts';
import { actorOf, sendFile } from '../ghi/ghi.routes.ts';
import { insuredPolicies } from '../insured-policies/insured-policies.service.ts';
import {
  getTpaClaim,
  linkTpaClaim,
  listTpaClaims,
  tpaClaimHistory,
  type ClaimAccess,
} from './tpa-claims.service.ts';
import {
  createFormat,
  getFormat,
  listFormats,
  setFormatActive,
  updateFormat,
} from './tpa-formats.service.ts';
import {
  commitTpaImport,
  discardTpaImport,
  getTpaImport,
  inspectTpaFile,
  listTpaImports,
  tpaErrorReport,
  tpaImportRows,
  uploadTpaImport,
} from './tpa-import.service.ts';
import { MAX_TPA_FILE_BYTES } from './tpa-workbook.ts';

// TPA claims (N9) under /api/v1/tpa. Formats are administered with claims.admin; files are
// checked and imported with claims.process; imported claims are read with claims.view.
// Diagnosis details (diagnosis, ICD code, rejection reason) go only to claims.process.

/** Whether the signed-in user may see diagnosis details (decided on the server, every call). */
export const diagnosisVisibleTo = (req: Request) => can(currentUser(req).roles, 'claims.process');
/** What the signed-in user may see of claim data (N12): diagnosis (claims.process), bank (claims.admin). */
export const claimAccessOf = (req: Request): ClaimAccess => ({
  diagnosis: diagnosisVisibleTo(req),
  bank: can(currentUser(req).roles, 'claims.admin'),
});

const xlsxBody = express.raw({
  type: [XLSX_CONTENT_TYPE, 'application/octet-stream'],
  limit: MAX_TPA_FILE_BYTES,
});
const FileSchema = z.instanceof(Buffer, { error: 'Upload the Excel file as the request body' });

/** A view of claim data (N12): who, which policy or claim, what was shown; never the data itself. */
async function auditView(
  req: Request,
  action: AuditAction,
  entityId: string,
  context: Record<string, unknown>,
) {
  await writeAudit({
    userId: currentUser(req).id,
    action,
    entity: AUDIT_ENTITIES.INSURED_POLICY,
    entityId,
    before: null,
    after: { ...context, outcome: 'ALLOWED' },
    requestId: req.requestId ?? null,
  });
}

export function createTpaRouter(options: {
  jwtSecret: string;
  mailTransport?: MailTransport;
}): Router {
  const router = Router();
  router.use(authenticate(options));
  // N12: refused requests for claim data are audited.
  const view = requireClaimPermission('claims.view');
  const process = requireClaimPermission('claims.process');
  const admin = requireClaimPermission('claims.admin');

  // N11: whether TPA imports email (off until the client approves).
  router.get(
    '/settings',
    admin,
    route({}, async (_input, _req, res) => {
      res.json(await claimImportSettings());
    }),
  );
  router.put(
    '/settings',
    admin,
    route({ body: ClaimImportSettingsSchema }, async ({ body }, req, res) => {
      res.json(await setClaimImportSettings(body, actorOf(req)));
    }),
  );

  router.get(
    '/policies',
    view,
    route({ query: InsuredPolicyQuerySchema }, async ({ query }, _req, res) => {
      res.json({ items: await insuredPolicies(query) });
    }),
  );

  // Formats
  router.get(
    '/formats',
    process,
    route({}, async (_input, _req, res) => {
      res.json(await listFormats());
    }),
  );
  router.post(
    '/formats',
    admin,
    route({ body: TpaFormatInputSchema }, async ({ body }, req, res) => {
      res.status(201).json(await createFormat(body, actorOf(req)));
    }),
  );
  router.get(
    '/formats/:formatId',
    process,
    route({ params: TpaFormatParamsSchema }, async ({ params }, _req, res) => {
      res.json(await getFormat(params.formatId));
    }),
  );
  router.put(
    '/formats/:formatId',
    admin,
    route(
      { params: TpaFormatParamsSchema, body: TpaFormatInputSchema },
      async ({ params, body }, req, res) => {
        res.json(await updateFormat(params.formatId, body, actorOf(req)));
      },
    ),
  );
  for (const [path, active] of [
    ['activate', true],
    ['deactivate', false],
  ] as const) {
    router.post(
      `/formats/:formatId/${path}`,
      admin,
      route({ params: TpaFormatParamsSchema }, async ({ params }, req, res) => {
        res.json(await setFormatActive(params.formatId, active, actorOf(req)));
      }),
    );
  }
  router.post(
    '/inspect',
    process,
    xlsxBody,
    route({ query: TpaInspectQuerySchema, body: FileSchema }, async ({ query, body }, req, res) => {
      res.json(await inspectTpaFile(body, query, claimAccessOf(req)));
    }),
  );

  // Imports
  router.get(
    '/imports',
    process,
    route({ query: TpaImportListQuerySchema }, async ({ query }, _req, res) => {
      res.json(await listTpaImports(query.caseId));
    }),
  );
  router.post(
    '/imports',
    process,
    xlsxBody,
    route({ query: TpaUploadQuerySchema, body: FileSchema }, async ({ query, body }, req, res) => {
      res.status(201).json(await uploadTpaImport({ ...query, data: body }, actorOf(req)));
    }),
  );
  router.get(
    '/imports/:importId',
    process,
    route({ params: TpaImportParamsSchema }, async ({ params }, _req, res) => {
      res.json(await getTpaImport(params.importId));
    }),
  );
  router.get(
    '/imports/:importId/rows',
    process,
    route(
      { params: TpaImportParamsSchema, query: TpaImportRowsQuerySchema },
      async ({ params, query }, req, res) => {
        const access = claimAccessOf(req);
        const rows = await tpaImportRows(params.importId, query, access);
        await auditView(req, AUDIT_ACTIONS.CLAIMS_LISTED, params.importId, {
          dataset: 'TPA import preview',
          page: query.page,
          shown: rows.items.length,
          diagnosisIncluded: access.diagnosis,
          fullBankAccounts: access.bank,
        });
        res.json(rows);
      },
    ),
  );
  router.get(
    '/imports/:importId/error-report',
    process,
    route({ params: TpaImportParamsSchema }, async ({ params }, req, res) => {
      const file = await tpaErrorReport(params.importId);
      // N12: an export of claim data is audited (what was downloaded, never its contents).
      await auditView(req, AUDIT_ACTIONS.TPA_ERROR_REPORT_DOWNLOADED, params.importId, {
        dataset: 'TPA import problems',
        fileName: file.fileName,
        privateValuesIncluded: false,
      });
      sendFile(res, file);
    }),
  );
  router.post(
    '/imports/:importId/commit',
    process,
    route(
      { params: TpaImportParamsSchema, body: CommitTpaImportRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(
          await commitTpaImport(
            params.importId,
            body.policy,
            actorOf(req),
            options.mailTransport ?? null,
          ),
        );
      },
    ),
  );
  router.post(
    '/imports/:importId/discard',
    process,
    route({ params: TpaImportParamsSchema }, async ({ params }, req, res) => {
      res.json(await discardTpaImport(params.importId, actorOf(req)));
    }),
  );

  // Imported claims
  router.get(
    '/claims',
    view,
    route({ query: TpaClaimListQuerySchema }, async ({ query }, req, res) => {
      const access = claimAccessOf(req);
      const list = await listTpaClaims(query, access);
      await auditView(req, AUDIT_ACTIONS.CLAIMS_LISTED, query.caseId, {
        dataset: 'TPA claims',
        filters: {
          status: query.status ?? null,
          review: query.review ?? false,
          search: Boolean(query.q),
        },
        shown: list.items.length,
        total: list.total,
        diagnosisIncluded: access.diagnosis,
        fullBankAccounts: access.bank,
      });
      res.json(list);
    }),
  );
  router.get(
    '/claims/:claimId',
    view,
    route({ params: TpaClaimParamsSchema }, async ({ params }, req, res) => {
      const access = claimAccessOf(req);
      const claim = await getTpaClaim(params.claimId, access);
      await auditView(req, AUDIT_ACTIONS.TPA_CLAIM_VIEWED, claim.caseId, {
        claim: claim.tpaClaimId,
        diagnosisIncluded: access.diagnosis,
        fullBankAccount: access.bank,
      });
      res.json(claim);
    }),
  );
  router.get(
    '/claims/:claimId/history',
    view,
    route({ params: TpaClaimParamsSchema }, async ({ params }, _req, res) => {
      res.json(await tpaClaimHistory(params.claimId));
    }),
  );
  router.put(
    '/claims/:claimId/link',
    process,
    route(
      { params: TpaClaimParamsSchema, body: LinkTpaClaimRequestSchema },
      async ({ params, body }, req, res) => {
        await linkTpaClaim(params.claimId, body, actorOf(req));
        res.json(await getTpaClaim(params.claimId, claimAccessOf(req)));
      },
    ),
  );
  return router;
}

const base = '/api/v1/tpa';
for (const item of [
  {
    method: 'get',
    path: `${base}/settings`,
    summary: 'Whether TPA imports email (N11)',
    permission: 'claims.admin',
    response: ClaimImportSettingsResponseSchema,
  },
  {
    method: 'put',
    path: `${base}/settings`,
    summary: 'Set whether TPA imports email (N11)',
    permission: 'claims.admin',
    body: ClaimImportSettingsSchema,
    response: ClaimImportSettingsResponseSchema,
  },
  {
    method: 'get',
    path: `${base}/policies`,
    summary: 'Placed policies (for TPA imports and analyses)',
    permission: 'claims.view',
    query: InsuredPolicyQuerySchema,
    response: InsuredPolicyListResponseSchema,
  },
  {
    method: 'get',
    path: `${base}/formats`,
    summary: 'TPA formats',
    permission: 'claims.process',
    response: TpaFormatListResponseSchema,
  },
  {
    method: 'post',
    path: `${base}/formats`,
    summary: 'Create a TPA format',
    permission: 'claims.admin',
    body: TpaFormatInputSchema,
    response: TpaFormatSchema,
    status: 201,
  },
  {
    method: 'get',
    path: `${base}/formats/{formatId}`,
    summary: 'A TPA format',
    permission: 'claims.process',
    response: TpaFormatSchema,
  },
  {
    method: 'put',
    path: `${base}/formats/{formatId}`,
    summary: 'Edit a TPA format (its revision rises)',
    permission: 'claims.admin',
    body: TpaFormatInputSchema,
    response: TpaFormatSchema,
  },
  {
    method: 'post',
    path: `${base}/formats/{formatId}/activate`,
    summary: 'Activate a TPA format',
    permission: 'claims.admin',
    response: TpaFormatSchema,
  },
  {
    method: 'post',
    path: `${base}/formats/{formatId}/deactivate`,
    summary: 'Deactivate a TPA format',
    permission: 'claims.admin',
    response: TpaFormatSchema,
  },
  {
    method: 'post',
    path: `${base}/inspect`,
    summary: 'Headers and sample rows of a file against a format',
    permission: 'claims.process',
    query: TpaInspectQuerySchema,
    upload: XLSX_CONTENT_TYPE,
    response: TpaInspectResponseSchema,
  },
  {
    method: 'get',
    path: `${base}/imports`,
    summary: 'A policy’s TPA imports',
    permission: 'claims.process',
    query: TpaImportListQuerySchema,
    response: TpaImportListResponseSchema,
  },
  {
    method: 'post',
    path: `${base}/imports`,
    summary: 'Upload a TPA export and check every row',
    permission: 'claims.process',
    query: TpaUploadQuerySchema,
    upload: XLSX_CONTENT_TYPE,
    response: TpaImportSchema,
    status: 201,
  },
  {
    method: 'get',
    path: `${base}/imports/{importId}`,
    summary: 'A TPA import',
    permission: 'claims.process',
    response: TpaImportSchema,
  },
  {
    method: 'get',
    path: `${base}/imports/{importId}/rows`,
    summary: 'An import’s rows with their problems',
    permission: 'claims.process',
    query: TpaImportRowsQuerySchema,
    response: TpaImportRowsResponseSchema,
  },
  {
    method: 'get',
    path: `${base}/imports/{importId}/error-report`,
    summary: 'The rows with problems as Excel',
    permission: 'claims.process',
    file: true,
  },
  {
    method: 'post',
    path: `${base}/imports/{importId}/commit`,
    summary: 'Import the checked rows by a policy',
    permission: 'claims.process',
    body: CommitTpaImportRequestSchema,
    response: TpaImportSchema,
  },
  {
    method: 'post',
    path: `${base}/imports/{importId}/discard`,
    summary: 'Discard a checked file',
    permission: 'claims.process',
    response: TpaImportSchema,
  },
  {
    method: 'get',
    path: `${base}/claims`,
    summary: 'A policy’s imported TPA claims',
    permission: 'claims.view',
    query: TpaClaimListQuerySchema,
    response: TpaClaimListResponseSchema,
  },
  {
    method: 'get',
    path: `${base}/claims/{claimId}`,
    summary: 'An imported TPA claim',
    permission: 'claims.view',
    response: TpaClaimRecordSchema,
  },
  {
    method: 'get',
    path: `${base}/claims/{claimId}/history`,
    summary: 'An imported TPA claim’s history',
    permission: 'claims.view',
    response: TpaClaimHistorySchema,
  },
  {
    method: 'put',
    path: `${base}/claims/{claimId}/link`,
    summary: 'Link a TPA claim by hand, or set its review note',
    permission: 'claims.process',
    body: LinkTpaClaimRequestSchema,
    response: TpaClaimRecordSchema,
  },
] as const) {
  documentEbRoute(item, 'TPA claims');
}
