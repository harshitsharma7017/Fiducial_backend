import {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  type AuditAction,
  AddClaimRemarkRequestSchema,
  AssignClaimRequestSchema,
  ClaimBoardQuerySchema,
  ClaimBoardSchema,
  ClaimDetailSchema,
  ClaimDocumentSchema,
  ClaimDocumentUploadQuerySchema,
  ClaimEmailTemplateListResponseSchema,
  ClaimEmailTemplateParamsSchema,
  ClaimEmailTemplateSchema,
  ClaimEmployeeParamsSchema,
  ClaimEmployeeQuerySchema,
  ClaimFileParamsSchema,
  ClaimHrContactParamsSchema,
  ClaimHrContactSchema,
  ClaimLinkListQuerySchema,
  ClaimLinkListResponseSchema,
  ClaimLinkParamsSchema,
  ClaimLinkSchema,
  ClaimListQuerySchema,
  ClaimListResponseSchema,
  ClaimMemberListResponseSchema,
  ClaimNotificationParamsSchema,
  ClaimNotificationSchema,
  ClaimParamsSchema,
  ClaimPolicyListResponseSchema,
  ClaimPolicyParamsSchema,
  ClaimPolicyQuerySchema,
  CLAIM_DOCUMENT_TYPES,
  CreateClaimLinkRequestSchema,
  CreateClaimLinkResponseSchema,
  CreateClaimRequestSchema,
  MAX_CLAIM_DOCUMENT_BYTES,
  SetClaimHrContactRequestSchema,
  TransitionClaimRequestSchema,
  TransitionClaimResponseSchema,
  UpdateClaimEmailTemplateRequestSchema,
  UpdateClaimRequestSchema,
} from '../../shared/index.ts';
import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { Logger } from '../../lib/logger.ts';
import { documentRoute, errorResponses } from '../../lib/openapi.ts';
import { authenticate } from '../../middleware/auth.ts';
import { currentUser, requireClaimPermission } from '../../middleware/require-permission.ts';
import { writeAudit } from '../audit/audit.service.ts';
import { route } from '../../middleware/validate.ts';
import type { MailTransport } from '../mail/transport.ts';
import type { ClaimActor } from './claim-common.ts';
import { createClaimLink, listClaimLinks, revokeClaimLink } from './claim-links.service.ts';
import { retryClaimNotification } from './claim-notifications.ts';
import { listClaimTemplates, updateClaimTemplate } from './claim-templates.service.ts';
import {
  addRemark,
  assignClaim,
  claimBoard,
  claimDocument,
  claimPolicies,
  createClaim,
  employeeFamily,
  getClaim,
  hrContact,
  listClaims,
  policyEmployees,
  setHrContact,
  transitionClaim,
  updateClaim,
  uploadClaimDocument,
} from './claims.service.ts';

// Group health claims (C1 to C4) under /api/v1/claims. Viewing needs claims.view; creating,
// links, editing, documents and moves claims.process (and the service checks the claim is assigned
// to the user, unless they hold claims.admin); reassigning, templates and HR contacts claims.admin.

function actorOf(req: Request): ClaimActor {
  const user = currentUser(req);
  return { id: user.id, roles: user.roles, requestId: req.requestId, kind: 'STAFF' };
}

function sendFile(
  res: Response,
  file: { fileName: string; contentType: string; data: Buffer },
  inline: boolean,
) {
  res.setHeader('Content-Type', file.contentType);
  res.setHeader(
    'Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename="${file.fileName.replace(/[^\w.\- ]/g, '_')}"`,
  );
  // Medical documents are never cached by the browser or a proxy.
  res.setHeader('Cache-Control', 'no-store');
  res.send(file.data);
}

const DocumentQuerySchema = z.strictObject({
  disposition: z.enum(['inline', 'attachment']).default('attachment'),
});

/** A view of claim data (N12): who, what, when; no names, dates of birth or medical detail. */
async function auditView(
  req: Request,
  action: AuditAction,
  entityId: string,
  context: Record<string, unknown>,
) {
  await writeAudit({
    userId: currentUser(req).id,
    action,
    entity: AUDIT_ENTITIES.CLAIM,
    entityId,
    before: null,
    after: { ...context, outcome: 'ALLOWED' },
    requestId: req.requestId ?? null,
  });
}

export function createClaimsRouter(options: {
  jwtSecret: string;
  mailTransport: MailTransport;
  logger?: Logger;
}): Router {
  const router = Router();
  router.use(authenticate(options));
  // N12: a refused claim request is audited.
  const view = requireClaimPermission('claims.view');
  const processing = requireClaimPermission('claims.process');
  const admin = requireClaimPermission('claims.admin');
  const deps = { transport: options.mailTransport, logger: options.logger };

  router.get(
    '/',
    view,
    route({ query: ClaimListQuerySchema }, async ({ query }, req, res) => {
      const list = await listClaims(query, actorOf(req));
      await auditView(req, AUDIT_ACTIONS.CLAIMS_LISTED, 'list', {
        filters: query,
        shown: list.items.length,
        total: list.total,
      });
      res.json(list);
    }),
  );
  router.get(
    '/board',
    view,
    route({ query: ClaimBoardQuerySchema }, async ({ query }, req, res) => {
      const board = await claimBoard(query, actorOf(req));
      await auditView(req, AUDIT_ACTIONS.CLAIMS_LISTED, 'board', {
        filters: query,
        shown: board.columns.reduce((sum, column) => sum + column.items.length, 0),
      });
      res.json(board);
    }),
  );
  router.post(
    '/',
    processing,
    route({ body: CreateClaimRequestSchema }, async ({ body }, req, res) => {
      res.status(201).json(await createClaim(body, actorOf(req)));
    }),
  );

  // Pickers and settings (before /:id so their paths are not taken for ids).
  router.get(
    '/policies',
    processing,
    route({ query: ClaimPolicyQuerySchema }, async ({ query }, _req, res) => {
      res.json(await claimPolicies(query.clientId));
    }),
  );
  router.get(
    '/policies/:caseId/employees',
    processing,
    route(
      { params: ClaimPolicyParamsSchema, query: ClaimEmployeeQuerySchema },
      async ({ params, query }, _req, res) => {
        res.json(await policyEmployees(params.caseId, query.q));
      },
    ),
  );
  router.get(
    '/policies/:caseId/employees/:memberId/family',
    processing,
    route({ params: ClaimEmployeeParamsSchema }, async ({ params }, _req, res) => {
      res.json(await employeeFamily(params.caseId, params.memberId));
    }),
  );
  router.get(
    '/links',
    processing,
    route({ query: ClaimLinkListQuerySchema }, async ({ query }, _req, res) => {
      res.json(await listClaimLinks(query.ghiCaseId));
    }),
  );
  router.post(
    '/links',
    processing,
    route({ body: CreateClaimLinkRequestSchema }, async ({ body }, req, res) => {
      res.status(201).json(await createClaimLink(body, actorOf(req)));
    }),
  );
  router.post(
    '/links/:linkId/revoke',
    processing,
    route({ params: ClaimLinkParamsSchema }, async ({ params }, req, res) => {
      res.json(await revokeClaimLink(params.linkId, actorOf(req)));
    }),
  );
  router.get(
    '/email-templates',
    admin,
    route({}, async (_input, _req, res) => {
      res.json(await listClaimTemplates());
    }),
  );
  router.put(
    '/email-templates/:status/:audience',
    admin,
    route(
      { params: ClaimEmailTemplateParamsSchema, body: UpdateClaimEmailTemplateRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await updateClaimTemplate(params.status, params.audience, body, actorOf(req)));
      },
    ),
  );
  router.get(
    '/hr-contacts/:clientId',
    view,
    route({ params: ClaimHrContactParamsSchema }, async ({ params }, _req, res) => {
      res.json(await hrContact(params.clientId));
    }),
  );
  router.put(
    '/hr-contacts/:clientId',
    admin,
    route(
      { params: ClaimHrContactParamsSchema, body: SetClaimHrContactRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await setHrContact(params.clientId, body, actorOf(req)));
      },
    ),
  );

  router.get(
    '/:id',
    view,
    route({ params: ClaimParamsSchema }, async ({ params }, req, res) => {
      const claim = await getClaim(params.id, actorOf(req));
      await auditView(req, AUDIT_ACTIONS.CLAIM_VIEWED, params.id, {
        claimNumber: claim.claimNumber,
        personalDetailsShown: claim.patient.dateOfBirth !== null,
      });
      res.json(claim);
    }),
  );
  router.put(
    '/:id',
    processing,
    route(
      { params: ClaimParamsSchema, body: UpdateClaimRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await updateClaim(params.id, body, actorOf(req)));
      },
    ),
  );
  router.post(
    '/:id/transitions',
    processing,
    route(
      { params: ClaimParamsSchema, body: TransitionClaimRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await transitionClaim(params.id, body, actorOf(req), deps));
      },
    ),
  );
  router.post(
    '/:id/remarks',
    processing,
    route(
      { params: ClaimParamsSchema, body: AddClaimRemarkRequestSchema },
      async ({ params, body }, req, res) => {
        res.status(201).json(await addRemark(params.id, body.remark, actorOf(req)));
      },
    ),
  );
  router.put(
    '/:id/assignee',
    admin,
    route(
      { params: ClaimParamsSchema, body: AssignClaimRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await assignClaim(params.id, body.assignedTo, actorOf(req)));
      },
    ),
  );
  router.post(
    '/:id/documents',
    processing,
    express.raw({
      type: [...Object.keys(CLAIM_DOCUMENT_TYPES), 'application/octet-stream'],
      limit: MAX_CLAIM_DOCUMENT_BYTES,
    }),
    route(
      {
        params: ClaimParamsSchema,
        query: ClaimDocumentUploadQuerySchema,
        body: z.instanceof(Buffer, { error: 'Upload the document as the request body' }),
      },
      async ({ params, query, body }, req, res) => {
        res
          .status(201)
          .json(
            await uploadClaimDocument(params.id, query.kind, query.fileName, body, actorOf(req)),
          );
      },
    ),
  );
  router.get(
    '/:id/documents/:fileId',
    view,
    route(
      { params: ClaimFileParamsSchema, query: DocumentQuerySchema },
      async ({ params, query }, req, res) => {
        sendFile(
          res,
          await claimDocument(params.id, params.fileId, actorOf(req)),
          query.disposition === 'inline',
        );
      },
    ),
  );
  router.post(
    '/:id/notifications/:notificationId/retry',
    processing,
    route({ params: ClaimNotificationParamsSchema }, async ({ params }, req, res) => {
      res.json(
        await retryClaimNotification(
          params.id,
          params.notificationId,
          actorOf(req),
          options.mailTransport,
        ),
      );
    }),
  );
  return router;
}

const json = (schema: z.ZodType) => ({ content: { 'application/json': { schema } } });
const binary = {
  content: {
    'application/octet-stream': { schema: { type: 'string' as const, format: 'binary' } },
  },
};
for (const item of [
  {
    method: 'get',
    path: '/api/v1/claims',
    summary: 'Claims table: search, company, status and date filters, pages',
    permission: 'claims.view',
    query: ClaimListQuerySchema,
    response: ClaimListResponseSchema,
  },
  {
    method: 'get',
    path: '/api/v1/claims/board',
    summary: 'Claims board: a column per status',
    permission: 'claims.view',
    query: ClaimBoardQuerySchema,
    response: ClaimBoardSchema,
  },
  {
    method: 'post',
    path: '/api/v1/claims',
    summary: 'Create a claim (lands in Form)',
    permission: 'claims.process',
    body: CreateClaimRequestSchema,
    response: ClaimDetailSchema,
    status: 201,
  },
  {
    method: 'get',
    path: '/api/v1/claims/policies',
    summary: 'Placed group health policies claims can be made on',
    permission: 'claims.process',
    query: ClaimPolicyQuerySchema,
    response: ClaimPolicyListResponseSchema,
  },
  {
    method: 'get',
    path: '/api/v1/claims/policies/{caseId}/employees',
    summary: 'Employees insured under a policy',
    permission: 'claims.process',
    query: ClaimEmployeeQuerySchema,
    response: ClaimMemberListResponseSchema,
  },
  {
    method: 'get',
    path: '/api/v1/claims/policies/{caseId}/employees/{memberId}/family',
    summary: 'An employee and their covered family: the possible patients',
    permission: 'claims.process',
    response: ClaimMemberListResponseSchema,
  },
  {
    method: 'get',
    path: '/api/v1/claims/links',
    summary: 'Employee submission links',
    permission: 'claims.process',
    query: ClaimLinkListQuerySchema,
    response: ClaimLinkListResponseSchema,
  },
  {
    method: 'post',
    path: '/api/v1/claims/links',
    summary: 'Create an employee submission link (its token is shown once)',
    permission: 'claims.process',
    body: CreateClaimLinkRequestSchema,
    response: CreateClaimLinkResponseSchema,
    status: 201,
  },
  {
    method: 'post',
    path: '/api/v1/claims/links/{linkId}/revoke',
    summary: 'Revoke a submission link',
    permission: 'claims.process',
    response: ClaimLinkSchema,
  },
  {
    method: 'get',
    path: '/api/v1/claims/email-templates',
    summary: 'Claim email templates',
    permission: 'claims.admin',
    response: ClaimEmailTemplateListResponseSchema,
  },
  {
    method: 'put',
    path: '/api/v1/claims/email-templates/{status}/{audience}',
    summary: 'Edit a claim email template',
    permission: 'claims.admin',
    body: UpdateClaimEmailTemplateRequestSchema,
    response: ClaimEmailTemplateSchema,
  },
  {
    method: 'get',
    path: '/api/v1/claims/hr-contacts/{clientId}',
    summary: 'A company’s HR contact for claim emails',
    permission: 'claims.view',
    response: ClaimHrContactSchema,
  },
  {
    method: 'put',
    path: '/api/v1/claims/hr-contacts/{clientId}',
    summary: 'Set a company’s HR contact for claim emails',
    permission: 'claims.admin',
    body: SetClaimHrContactRequestSchema,
    response: ClaimHrContactSchema,
  },
  {
    method: 'get',
    path: '/api/v1/claims/{id}',
    summary: 'A claim with its documents, timeline and emails',
    permission: 'claims.view',
    response: ClaimDetailSchema,
  },
  {
    method: 'put',
    path: '/api/v1/claims/{id}',
    summary: 'Correct a claim’s details (assigned staff or Admin)',
    permission: 'claims.process',
    body: UpdateClaimRequestSchema,
    response: ClaimDetailSchema,
  },
  {
    method: 'post',
    path: '/api/v1/claims/{id}/transitions',
    summary: 'Move a claim with a remark; emails the claimant and HR',
    permission: 'claims.process',
    body: TransitionClaimRequestSchema,
    response: TransitionClaimResponseSchema,
  },
  {
    method: 'post',
    path: '/api/v1/claims/{id}/remarks',
    summary: 'Add a remark',
    permission: 'claims.process',
    body: AddClaimRemarkRequestSchema,
    response: ClaimDetailSchema,
    status: 201,
  },
  {
    method: 'put',
    path: '/api/v1/claims/{id}/assignee',
    summary: 'Assign a claim to claims staff',
    permission: 'claims.admin',
    body: AssignClaimRequestSchema,
    response: ClaimDetailSchema,
  },
  {
    method: 'post',
    path: '/api/v1/claims/{id}/documents',
    summary: 'Upload a supporting document (PDF, PNG or JPEG)',
    permission: 'claims.process',
    query: ClaimDocumentUploadQuerySchema,
    response: ClaimDocumentSchema,
    status: 201,
    upload: true,
  },
  {
    method: 'get',
    path: '/api/v1/claims/{id}/documents/{fileId}',
    summary: 'View or download a document',
    permission: 'claims.view',
    query: DocumentQuerySchema,
    file: true,
  },
  {
    method: 'post',
    path: '/api/v1/claims/{id}/notifications/{notificationId}/retry',
    summary: 'Retry a failed claim email',
    permission: 'claims.process',
    response: ClaimNotificationSchema,
  },
] as const) {
  const item2 = item;
  documentRoute({
    method: item.method,
    path: item.path,
    tags: ['Claims'],
    summary: item.summary,
    description: `Needs ${item.permission}.`,
    request: {
      ...(item2.query ? { query: item2.query } : {}),
      ...(item2.body ? { body: json(item2.body) } : {}),
      ...(item2.upload ? { body: binary } : {}),
    },
    responses: {
      [item2.status ?? 200]: item2.file
        ? { description: 'The file', ...binary }
        : item2.response
          ? { description: 'OK', ...json(item2.response) }
          : { description: 'Done' },
      ...errorResponses(400, 401, 403, 404, 409),
    },
  });
}
