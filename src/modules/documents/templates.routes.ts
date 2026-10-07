import {
  DocumentKindParamsSchema,
  DocumentTemplateListSchema,
  MAX_TEMPLATE_BYTES,
  TemplateUploadQuerySchema,
  TemplateUploadResultSchema,
  XLSX_CONTENT_TYPE,
} from '../../shared/index.ts';
import express, { Router } from 'express';
import { z } from 'zod';
import { notFound } from '../../lib/errors.ts';
import { documentRoute, errorResponses } from '../../lib/openapi.ts';
import { authenticate } from '../../middleware/auth.ts';
import { currentUser, requirePermission } from '../../middleware/require-permission.ts';
import { route } from '../../middleware/validate.ts';
import { listTemplates, templateFile, uploadTemplate } from './templates.service.ts';

const UploadSchema = z.instanceof(Buffer, {
  error: 'Upload the template (.xlsx) as the request body',
});

/**
 * The client's document formats (R-3): every role sees which are uploaded (masters.view); Admins
 * upload them (masters.manage). The RFQ is filled from its template; QCR and Placement Slip
 * templates are kept for when those documents are built.
 */
export function createTemplatesRouter(options: { jwtSecret: string }): Router {
  const router = Router();
  router.use(authenticate(options));
  router.use(requirePermission('masters.view'));

  router.get('/', async (_req, res) => {
    res.json(await listTemplates());
  });

  router.get(
    '/:kind/file',
    route({ params: DocumentKindParamsSchema }, async ({ params }, _req, res) => {
      const file = await templateFile(params.kind);
      if (!file) throw notFound('No template has been uploaded for this document');
      res.setHeader('Content-Type', XLSX_CONTENT_TYPE);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${file.fileName.replace(/"/g, '')}"`,
      );
      res.send(file.data);
    }),
  );

  router.post(
    '/:kind',
    requirePermission('masters.manage'),
    express.raw({
      type: [XLSX_CONTENT_TYPE, 'application/octet-stream'],
      limit: MAX_TEMPLATE_BYTES,
    }),
    route(
      { params: DocumentKindParamsSchema, query: TemplateUploadQuerySchema, body: UploadSchema },
      async ({ params, query, body }, req, res) => {
        res.json(
          await uploadTemplate(
            params.kind,
            body,
            query.fileName,
            { id: currentUser(req).id, requestId: req.requestId },
            req.log,
          ),
        );
      },
    ),
  );

  return router;
}

const xlsx = {
  content: { [XLSX_CONTENT_TYPE]: { schema: z.string().meta({ format: 'binary' }) } },
};

documentRoute({
  method: 'get',
  path: '/api/v1/templates',
  tags: ['Document templates'],
  summary: 'List the document templates',
  description:
    'Needs masters.view. RFQ, QCR and Placement Slip, each with its uploaded template and what the engine found in it.',
  responses: {
    200: {
      description: 'The templates',
      content: { 'application/json': { schema: DocumentTemplateListSchema } },
    },
    ...errorResponses(401, 403),
  },
});

documentRoute({
  method: 'get',
  path: '/api/v1/templates/{kind}/file',
  tags: ['Document templates'],
  summary: 'Download a template',
  description: 'Needs masters.view. The workbook as uploaded. 404 when none has been uploaded.',
  request: { params: DocumentKindParamsSchema },
  responses: { 200: { description: 'The workbook', ...xlsx }, ...errorResponses(401, 403, 404) },
});

documentRoute({
  method: 'post',
  path: '/api/v1/templates/{kind}',
  tags: ['Document templates'],
  summary: 'Upload a template',
  description:
    'Needs masters.manage. The client’s format as the request body (.xlsx, up to 5 MB). It is checked first: an RFQ template must have the sheets and labels the engine fills by. When it passes it replaces the kind’s template (audited); otherwise saved is false and check lists the problems.',
  request: { params: DocumentKindParamsSchema, query: TemplateUploadQuerySchema, body: xlsx },
  responses: {
    200: {
      description: 'The check, and the template when saved',
      content: { 'application/json': { schema: TemplateUploadResultSchema } },
    },
    ...errorResponses(400, 401, 403, 413),
  },
});
