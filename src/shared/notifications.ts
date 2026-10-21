import { z } from 'zod';
import { CursorSchema, IsoDateTimeSchema, LimitSchema, ObjectIdSchema } from './common.ts';

// A4: in-app notifications. A notification is a small, persistent, per-recipient record that an
// authoritative business event created (approval needed/granted/returned, a quote recorded, a QCR
// decision, a payment, a renewal falling due). It references its source entity and resolves to a
// case the user may open. Notifications are generated on the backend from real events only; the
// frontend never creates them. The architecture is extensible: new event types (e.g. appointment
// reminders, when the calendar feature ships) are added here without redesign.

export const NOTIFICATION_EVENTS = [
  'APPROVAL_NEEDED',
  'APPROVED',
  'RETURNED',
  'QUOTE_RECEIVED',
  'QCR_DECISION',
  'PAYMENT_RECORDED',
  'RENEWAL_DUE',
] as const;
export const NotificationEventSchema = z.enum(NOTIFICATION_EVENTS);
export type NotificationEvent = z.infer<typeof NotificationEventSchema>;

export const NOTIFICATION_EVENT_LABELS: Record<NotificationEvent, string> = {
  APPROVAL_NEEDED: 'Approval needed',
  APPROVED: 'Approved',
  RETURNED: 'Returned for changes',
  QUOTE_RECEIVED: 'Quote received',
  QCR_DECISION: 'QCR decision',
  PAYMENT_RECORDED: 'Payment recorded',
  RENEWAL_DUE: 'Renewal due',
};

/** The kind of record a notification points at, so the frontend can resolve navigation. */
export const NOTIFICATION_ENTITIES = ['proposal', 'ghi_case', 'eb_case'] as const;
export const NotificationEntitySchema = z.enum(NOTIFICATION_ENTITIES);
export type NotificationEntity = z.infer<typeof NotificationEntitySchema>;

export const NotificationSchema = z.object({
  id: ObjectIdSchema,
  event: NotificationEventSchema,
  title: z.string(),
  message: z.string(),
  entity: NotificationEntitySchema,
  entityId: ObjectIdSchema,
  /** The case/proposal the notification is about, for the "open case" link and its reference. */
  proposalId: ObjectIdSchema.nullable(),
  reference: z.string().nullable(),
  read: z.boolean(),
  readAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});
export type Notification = z.infer<typeof NotificationSchema>;

export const NotificationListResponseSchema = z.object({
  items: z.array(NotificationSchema),
  nextCursor: z.string().nullable(),
  /** The current recipient's total unread count (not just this page). */
  unreadCount: z.number().int(),
});
export type NotificationListResponse = z.infer<typeof NotificationListResponseSchema>;

export const NotificationListQuerySchema = z.strictObject({
  limit: LimitSchema,
  cursor: CursorSchema.optional(),
  /** true: only unread notifications. */
  unread: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});
export type NotificationListQuery = z.infer<typeof NotificationListQuerySchema>;

export const UnreadCountResponseSchema = z.object({ unreadCount: z.number().int() });
export type UnreadCountResponse = z.infer<typeof UnreadCountResponseSchema>;

export const NotificationIdParamsSchema = z.strictObject({ id: ObjectIdSchema });

/** Marking read is idempotent: it reports the recipient's remaining unread count. */
export const MarkReadResponseSchema = z.object({
  updated: z.number().int(),
  unreadCount: z.number().int(),
});
export type MarkReadResponse = z.infer<typeof MarkReadResponseSchema>;
