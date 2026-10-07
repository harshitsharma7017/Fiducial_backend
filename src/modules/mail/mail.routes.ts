import { MailStatusSchema } from '../../shared/index.ts';
import { Router } from 'express';
import { documentRoute, errorResponses } from '../../lib/openapi.ts';
import { authenticate } from '../../middleware/auth.ts';
import { requirePermission } from '../../middleware/require-permission.ts';
import { mailStatusOf, type MailTransport } from './transport.ts';

/** How mail leaves the API, for the Settings page (settings.view). */
export function createMailRouter(options: { jwtSecret: string; transport: MailTransport }): Router {
  const router = Router();
  router.use(authenticate(options));
  router.get('/status', requirePermission('settings.view'), (_req, res) => {
    res.json(mailStatusOf(options.transport));
  });
  return router;
}

documentRoute({
  method: 'get',
  path: '/api/v1/mail/status',
  tags: ['Mail'],
  summary: 'How mail is sent',
  description:
    'Needs settings.view. The transport (smtp delivers, outbox keeps mails in the mail log only, off refuses to send), the From address and the SMTP host. Never the SMTP user or password.',
  responses: {
    200: {
      description: 'The mail settings',
      content: { 'application/json': { schema: MailStatusSchema } },
    },
    ...errorResponses(401, 403),
  },
});
