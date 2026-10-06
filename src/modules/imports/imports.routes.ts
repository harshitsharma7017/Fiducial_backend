import {
  IMPORT_SHEETS,
  ImportEntityParamsSchema,
  ImportQuerySchema,
  ImportReportSchema,
  ImportTemplateQuerySchema,
  MAX_IMPORT_BYTES,
  XLSX_CONTENT_TYPE,
  can,
  type ImportEntity,
} from '../../shared/index.ts';
import express, { Router, type Request } from 'express';
import { z } from 'zod';
import { forbidden } from '../../lib/errors.ts';
import { documentRoute, errorResponses } from '../../lib/openapi.ts';
import { authenticate } from '../../middleware/auth.ts';
import { currentUser } from '../../middleware/require-permission.ts';
import { route } from '../../middleware/validate.ts';
import { runImport } from './imports.service.ts';
import { SAMPLE_ROWS } from './samples.ts';
import { buildTemplate } from './workbook.ts';

const UploadSchema = z.instanceof(Buffer, {
  error: 'Upload an .xlsx workbook as the request body',
});

/** Each entity needs its own permission: clients.manage for clients, masters.manage for insurers. */
function assertMayImport(req: Request, entity: ImportEntity): void {
  if (!can(currentUser(req).roles, IMPORT_SHEETS[entity].permission)) throw forbidden();
}

export function createImportsRouter(options: { jwtSecret: string }): Router {
  const router = Router();
  router.use(authenticate(options));

  router.get(
    '/:entity/template',
    route(
      { params: ImportEntityParamsSchema, query: ImportTemplateQuerySchema },
      async ({ params, query }, req, res) => {
        assertMayImport(req, params.entity);
        const file = await buildTemplate(
          params.entity,
          query.sample ? SAMPLE_ROWS[params.entity] : [],
        );
        const name = `${params.entity}-${query.sample ? 'sample' : 'template'}.xlsx`;
        res.setHeader('Content-Type', XLSX_CONTENT_TYPE);
        res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
        res.send(file);
      },
    ),
  );

  router.post(
    '/:entity',
    express.raw({ type: [XLSX_CONTENT_TYPE, 'application/octet-stream'], limit: MAX_IMPORT_BYTES }),
    route(
      { params: ImportEntityParamsSchema, query: ImportQuerySchema, body: UploadSchema },
      async ({ params, query, body }, req, res) => {
        assertMayImport(req, params.entity);
        const actor = { id: currentUser(req).id, requestId: req.requestId };
        res.json(await runImport(params.entity, body, query, actor, req.log));
      },
    ),
  );

  return router;
}

documentRoute({
  method: 'get',
  path: '/api/v1/imports/{entity}/template',
  tags: ['Imports'],
  summary: 'Download an import template',
  description:
    'Needs the permission of the entity (clients.manage for clients and risk locations, ' +
    'masters.manage for insurers). An .xlsx workbook with an Instructions sheet and the data ' +
    'sheet; sample=true fills in fictional rows that pass the import.',
  request: { params: ImportEntityParamsSchema, query: ImportTemplateQuerySchema },
  responses: {
    200: {
      description: 'The workbook',
      content: { [XLSX_CONTENT_TYPE]: { schema: z.string().meta({ format: 'binary' }) } },
    },
    ...errorResponses(400, 401, 403),
  },
});

documentRoute({
  method: 'post',
  path: '/api/v1/imports/{entity}',
  tags: ['Imports'],
  summary: 'Preview or import a filled-in template',
  description:
    'Send the .xlsx file as the request body (up to 5 MB and 1,000 rows). With dryRun=true ' +
    '(the default) nothing is saved and the report has every row: its values, whether it is ' +
    'valid, and its problems by column. With dryRun=false the chosen rows (rows=2,3,7) are ' +
    'saved in one transaction, each audited as a create; left out, all valid rows are saved. ' +
    'Rows with problems are never saved, and choosing one stops the import. Duplicates within ' +
    'the file or with saved records are problems.',
  request: {
    params: ImportEntityParamsSchema,
    query: ImportQuerySchema,
    body: { content: { [XLSX_CONTENT_TYPE]: { schema: z.string().meta({ format: 'binary' }) } } },
  },
  responses: {
    200: {
      description: 'The import report',
      content: { 'application/json': { schema: ImportReportSchema } },
    },
    ...errorResponses(400, 401, 403, 409),
  },
});
