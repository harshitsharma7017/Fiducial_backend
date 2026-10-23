import {
  MarkReadResponseSchema,
  NotificationIdParamsSchema,
  NotificationListQuerySchema,
  NotificationListResponseSchema,
  UnreadCountResponseSchema,
} from '../../shared/index.ts';
import { Router } from 'express';
import type { Request } from 'express';
import type { z } from 'zod';
import { notFound } from '../../lib/errors.ts';
import { documentRoute, errorResponses } from '../../lib/openapi.ts';
import { authenticate } from '../../middleware/auth.ts';
import { authenticatedAccess, currentUser } from '../../middleware/require-permission.ts';
import { route } from '../../middleware/validate.ts';
import {
  listNotifications,
  markAllRead,
  markRead,
  ownsNotification,
  unreadCount,
} from './notifications.service.ts';

// A4: the current user's notification feed. Every route is authenticated and scoped to the
// authenticated recipient — a user can only ever read or mark their own notifications. No
// permission beyond a valid session is required: notifications belong to the signed-in user.

function recipientId(req: Request): string {
  return currentUser(req).id;
}

export function createNotificationsRouter(options: { jwtSecret: string }): Router {
  const router = Router();
  // Every route acts on the caller's own notifications only (scoped by recipient in the service).
  router.use(authenticate(options), authenticatedAccess('own notifications only'));

  router.get(
    '/',
    route({ query: NotificationListQuerySchema }, async ({ query }, req, res) => {
      res.json(await listNotifications(recipientId(req), query));
    }),
  );

  router.get(
    '/unread-count',
    route({}, async (_input, req, res) => {
      res.json({ unreadCount: await unreadCount(recipientId(req)) });
    }),
  );

  router.post(
    '/read-all',
    route({}, async (_input, req, res) => {
      res.json(await markAllRead(recipientId(req)));
    }),
  );

  router.post(
    '/:id/read',
    route({ params: NotificationIdParamsSchema }, async ({ params }, req, res) => {
      const recipient = recipientId(req);
      // Scope to the recipient: another user's id is "not found", never readable or mutable.
      if (!(await ownsNotification(recipient, params.id))) throw notFound('Notification not found');
      res.json(await markRead(recipient, params.id));
    }),
  );

  return router;
}

const json = (schema: z.ZodType) => ({ content: { 'application/json': { schema } } });
const TAGS = ['Notifications'];

documentRoute({
  method: 'get',
  path: '/api/v1/notifications',
  tags: TAGS,
  summary: 'The current user’s notifications',
  description:
    'Newest first, scoped to the authenticated recipient. `unread=true` filters to unread. Cursor pagination; the response includes the recipient’s total unread count.',
  request: { query: NotificationListQuerySchema },
  responses: {
    200: { description: 'The notifications', ...json(NotificationListResponseSchema) },
    ...errorResponses(400, 401),
  },
});

documentRoute({
  method: 'get',
  path: '/api/v1/notifications/unread-count',
  tags: TAGS,
  summary: 'The current user’s unread notification count',
  responses: {
    200: { description: 'The unread count', ...json(UnreadCountResponseSchema) },
    ...errorResponses(401),
  },
});

documentRoute({
  method: 'post',
  path: '/api/v1/notifications/read-all',
  tags: TAGS,
  summary: 'Mark all the current user’s notifications read',
  description: 'Idempotent.',
  responses: {
    200: {
      description: 'How many were marked, and the unread count (0)',
      ...json(MarkReadResponseSchema),
    },
    ...errorResponses(401),
  },
});

documentRoute({
  method: 'post',
  path: '/api/v1/notifications/{id}/read',
  tags: TAGS,
  summary: 'Mark one notification read',
  description: 'Idempotent. 404 when the notification is not the current user’s.',
  request: { params: NotificationIdParamsSchema },
  responses: {
    200: {
      description: 'The result and the remaining unread count',
      ...json(MarkReadResponseSchema),
    },
    ...errorResponses(400, 401, 404),
  },
});
