import {
  EmailTemplateKindParamsSchema,
  EmailTemplateListResponseSchema,
  EmailTemplateSchema,
  UpdateEmailTemplateRequestSchema,
} from '../../shared/index.ts';
import { Router } from 'express';
import { documentRoute, errorResponses } from '../../lib/openapi.ts';
import { authenticate } from '../../middleware/auth.ts';
import { currentUser, requirePermission } from '../../middleware/require-permission.ts';
import { route } from '../../middleware/validate.ts';
import { listEmailTemplates, updateEmailTemplate } from './email-templates.service.ts';

/**
 * The wording of the RFQ and reminder mails (E-2): every role that sees the masters reads them
 * (masters.view); Admins edit them (masters.manage).
 */
export function createEmailTemplatesRouter(options: { jwtSecret: string }): Router {
  const router = Router();
  router.use(authenticate(options));
  router.use(requirePermission('masters.view'));

  router.get('/', async (_req, res) => {
    res.json(await listEmailTemplates());
  });

  router.put(
    '/:kind',
    requirePermission('masters.manage'),
    route(
      { params: EmailTemplateKindParamsSchema, body: UpdateEmailTemplateRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(
          await updateEmailTemplate(params.kind, body, {
            id: currentUser(req).id,
            requestId: req.requestId,
          }),
        );
      },
    ),
  );

  return router;
}

documentRoute({
  method: 'get',
  path: '/api/v1/email-templates',
  tags: ['Email templates'],
  summary: 'List the email templates',
  description:
    'Needs masters.view. The RFQ and Reminder templates, each with its subject, body, version and who last changed it. Missing kinds are created with the default wording.',
  responses: {
    200: {
      description: 'The templates',
      content: { 'application/json': { schema: EmailTemplateListResponseSchema } },
    },
    ...errorResponses(401, 403),
  },
});

documentRoute({
  method: 'put',
  path: '/api/v1/email-templates/{kind}',
  tags: ['Email templates'],
  summary: 'Save an email template',
  description:
    'Needs masters.manage. Merge fields are written {{fieldName}}; an unknown field or a stray {{ or }} is a 400 naming it. expectedVersion is the version being edited: when someone saved a newer one, 409 TEMPLATE_VERSION_CONFLICT carries details.currentVersion. Audited with the old and new wording.',
  request: {
    params: EmailTemplateKindParamsSchema,
    body: { content: { 'application/json': { schema: UpdateEmailTemplateRequestSchema } } },
  },
  responses: {
    200: {
      description: 'The saved template',
      content: { 'application/json': { schema: EmailTemplateSchema } },
    },
    ...errorResponses(400, 401, 403, 409),
  },
});
