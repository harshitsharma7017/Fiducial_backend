import {
  CloudDocumentListSchema,
  CloudDocumentParamsSchema,
  CloudDocumentSchema,
  ProposalIdParamsSchema,
  SaveCloudDocumentRequestSchema,
} from '../../shared/index.ts';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { documentRoute, errorResponses } from '../../lib/openapi.ts';
import { authenticate } from '../../middleware/auth.ts';
import { currentUser, requirePermission } from '../../middleware/require-permission.ts';
import { route } from '../../middleware/validate.ts';
import {
  cloudDocumentFile,
  listCloudDocuments,
  removeCloudDocument,
  saveCloudDocument,
} from './cloud-documents.service.ts';
import type { CloudStore } from './cloud-store.ts';

function actorOf(req: Request) {
  const user = currentUser(req);
  return { id: user.id, roles: user.roles, requestId: req.requestId };
}

/**
 * A case's documents in cloud storage, under /api/v1/proposals: the list needs property.view,
 * saving and downloading property.export (as a download does), removing property.edit.
 */
export function createCloudDocumentsRouter(options: {
  jwtSecret: string;
  gstRatePercent: string;
  store: CloudStore;
}): Router {
  const router = Router();
  router.use(authenticate(options));
  const deps = { store: options.store, defaultGstRatePercent: options.gstRatePercent };

  router.get(
    '/:id/cloud-documents',
    requirePermission('property.view'),
    route({ params: ProposalIdParamsSchema }, async ({ params }, _req, res) => {
      res.json(await listCloudDocuments(params.id));
    }),
  );

  router.post(
    '/:id/cloud-documents',
    requirePermission('property.export'),
    route(
      { params: ProposalIdParamsSchema, body: SaveCloudDocumentRequestSchema },
      async ({ params, body }, req, res) => {
        res.status(201).json(await saveCloudDocument(params.id, body, actorOf(req), deps));
      },
    ),
  );

  router.get(
    '/:id/cloud-documents/:documentId/file',
    requirePermission('property.export'),
    route({ params: CloudDocumentParamsSchema }, async ({ params }, req, res) => {
      const file = await cloudDocumentFile(params.id, params.documentId, actorOf(req), deps);
      res.setHeader('Content-Type', file.contentType);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${file.fileName.replace(/[^\w.\- ]/g, '_')}"`,
      );
      res.send(file.data);
    }),
  );

  router.delete(
    '/:id/cloud-documents/:documentId',
    requirePermission('property.edit'),
    route({ params: CloudDocumentParamsSchema }, async ({ params }, req, res) => {
      await removeCloudDocument(params.id, params.documentId, actorOf(req), deps);
      res.status(204).end();
    }),
  );

  return router;
}

const json = (schema: z.ZodType) => ({ content: { 'application/json': { schema } } });

documentRoute({
  method: 'get',
  path: '/api/v1/proposals/{id}/cloud-documents',
  tags: ['Cloud storage'],
  summary: 'The case’s documents saved to cloud storage',
  description:
    'Needs property.view. The copies of the case’s documents users saved (newest first). Every uploaded file is kept in the file store (S3) anyway; the QCR and placement slip are otherwise generated on each download.',
  request: { params: ProposalIdParamsSchema },
  responses: {
    200: { description: 'The saved documents', ...json(CloudDocumentListSchema) },
    ...errorResponses(400, 401, 403, 404),
  },
});

documentRoute({
  method: 'post',
  path: '/api/v1/proposals/{id}/cloud-documents',
  tags: ['Cloud storage'],
  summary: 'Save a document of the case to cloud storage',
  description:
    'Needs property.export. Generates the document as it downloads (the latest RFQ version, the QCR, or the placement slip; PDF or Excel), puts it in the S3 bucket and records who saved it. 409 when the document cannot be produced yet; 502 CLOUD_STORAGE_FAILED when S3 refuses (nothing is recorded). Audited.',
  request: {
    params: ProposalIdParamsSchema,
    body: json(SaveCloudDocumentRequestSchema),
  },
  responses: {
    201: { description: 'Saved', ...json(CloudDocumentSchema) },
    ...errorResponses(400, 401, 403, 404, 409, 502),
  },
});

documentRoute({
  method: 'get',
  path: '/api/v1/proposals/{id}/cloud-documents/{documentId}/file',
  tags: ['Cloud storage'],
  summary: 'Download a document from cloud storage',
  description:
    'Needs property.export. The file as it was saved, read back from the bucket. Audited.',
  request: { params: CloudDocumentParamsSchema },
  responses: {
    200: {
      description: 'The file',
      content: { 'application/octet-stream': { schema: z.string().meta({ format: 'binary' }) } },
    },
    ...errorResponses(401, 403, 404, 409, 502),
  },
});

documentRoute({
  method: 'delete',
  path: '/api/v1/proposals/{id}/cloud-documents/{documentId}',
  tags: ['Cloud storage'],
  summary: 'Remove a document from cloud storage',
  description:
    'Needs property.edit. Deletes the file from the bucket; the record of who saved and removed it stays in the audit log. Audited.',
  request: { params: CloudDocumentParamsSchema },
  responses: {
    204: { description: 'Removed' },
    ...errorResponses(401, 403, 404, 409, 502),
  },
});
