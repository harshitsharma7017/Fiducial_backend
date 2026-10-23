import {
  ClaimDocumentUploadQuerySchema,
  ClaimLinkTokenSchema,
  CLAIM_DOCUMENT_TYPES,
  ERROR_CODES,
  MAX_CLAIM_DOCUMENT_BYTES,
  PublicClaimLinkSchema,
  PublicClaimSubmitRequestSchema,
  PublicClaimSubmitResponseSchema,
} from '../../shared/index.ts';
import express, { Router, type Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { AppError } from '../../lib/errors.ts';
import { documentRoute, errorResponses } from '../../lib/openapi.ts';
import { publicAccess } from '../../middleware/require-permission.ts';
import { route } from '../../middleware/validate.ts';
import { publicClaimLink, submitThroughLink, uploadThroughLink } from './claim-links.service.ts';

// The employee's side of a submission link (C2), under /api/v1/claim-links. No sign-in: the link's
// token is the only credential, sent in the X-Claim-Link-Token header (never in the URL, so it is
// not written to server logs). It can read the link, submit claims and add documents to them, and
// nothing else: no claim status, no other employee, no other claim.

export const CLAIM_LINK_HEADER = 'x-claim-link-token';

function tokenOf(req: Request): string {
  const parsed = ClaimLinkTokenSchema.safeParse(req.get(CLAIM_LINK_HEADER));
  if (!parsed.success) {
    throw new AppError(
      403,
      ERROR_CODES.CLAIM_LINK_INVALID,
      'This link is not valid. Ask your HR team or broker for a new one.',
    );
  }
  return parsed.data;
}

const ClaimNumberParamsSchema = z.strictObject({
  claimNumber: z.string().regex(/^CLM-\d{4}-\d{4,}$/, 'Not a claim number'),
});

export function createClaimLinksRouter(
  options: { limit?: number; windowSeconds?: number } = {},
): Router {
  const router = Router();
  // Per-IP limit on the public endpoints. In memory: use a shared store with several instances.
  router.use(
    rateLimit({
      windowMs: (options.windowSeconds ?? 900) * 1000,
      limit: options.limit ?? 120,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: (_req, res) => {
        res.status(429).json({
          message: 'Too many requests. Wait a few minutes and try again.',
          code: ERROR_CODES.RATE_LIMITED,
        });
      },
    }),
    // No sign-in by design: the link token (header) is the credential, checked on every request.
    publicAccess('employee claim submission link; the link token is checked per request'),
  );
  router.get(
    '/current',
    route({}, async (_input, req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await publicClaimLink(tokenOf(req)));
    }),
  );
  router.post(
    '/current/claims',
    route({ body: PublicClaimSubmitRequestSchema }, async ({ body }, req, res) => {
      res.status(201).json(await submitThroughLink(tokenOf(req), body, req.requestId));
    }),
  );
  router.post(
    '/current/claims/:claimNumber/documents',
    express.raw({
      type: [...Object.keys(CLAIM_DOCUMENT_TYPES), 'application/octet-stream'],
      limit: MAX_CLAIM_DOCUMENT_BYTES,
    }),
    route(
      {
        params: ClaimNumberParamsSchema,
        query: ClaimDocumentUploadQuerySchema,
        body: z.instanceof(Buffer, { error: 'Upload the document as the request body' }),
      },
      async ({ params, query, body }, req, res) => {
        res
          .status(201)
          .json(
            await uploadThroughLink(
              tokenOf(req),
              params.claimNumber,
              query.kind,
              query.fileName,
              body,
              req.requestId,
            ),
          );
      },
    ),
  );
  return router;
}

const header = z.object({ 'x-claim-link-token': ClaimLinkTokenSchema });
const json = (schema: z.ZodType) => ({ content: { 'application/json': { schema } } });
documentRoute({
  method: 'get',
  path: '/api/v1/claim-links/current',
  tags: ['Claims'],
  summary: 'The employee’s link: their policy and covered family (token in X-Claim-Link-Token)',
  public: true,
  request: { headers: header },
  responses: {
    200: { description: 'OK', ...json(PublicClaimLinkSchema) },
    ...errorResponses(403, 429),
  },
});
documentRoute({
  method: 'post',
  path: '/api/v1/claim-links/current/claims',
  tags: ['Claims'],
  summary: 'Submit a claim through the link (lands in Form)',
  public: true,
  request: { headers: header, body: json(PublicClaimSubmitRequestSchema) },
  responses: {
    201: { description: 'Submitted', ...json(PublicClaimSubmitResponseSchema) },
    ...errorResponses(400, 403, 429),
  },
});
documentRoute({
  method: 'post',
  path: '/api/v1/claim-links/current/claims/{claimNumber}/documents',
  tags: ['Claims'],
  summary: 'Add a document to a claim made through the link, while it is in Form',
  public: true,
  request: {
    headers: header,
    query: ClaimDocumentUploadQuerySchema,
    body: {
      content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
    },
  },
  responses: {
    201: { description: 'Uploaded', ...json(z.object({ kind: z.string(), fileName: z.string() })) },
    ...errorResponses(400, 403, 404, 409, 429),
  },
});
