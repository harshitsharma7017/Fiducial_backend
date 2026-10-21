import {
  NOTIFICATION_ENTITIES,
  NOTIFICATION_EVENTS,
  type NotificationEntity,
  type NotificationEvent,
} from '../../shared/index.ts';
import { Schema, model, type Types } from 'mongoose';

/**
 * A4: one in-app notification for one recipient. Created only from authoritative business events
 * (see notifications.service.ts). `dedupeKey` makes creation idempotent: the same event for the
 * same recipient (e.g. a retried request, or a repeated renewal scan) never creates a duplicate.
 * The source entity is referenced by id and resolved at click time, so a deleted or now-forbidden
 * case cannot leak data through the notification.
 */
export interface NotificationDoc {
  _id: Types.ObjectId;
  recipientId: Types.ObjectId;
  event: NotificationEvent;
  title: string;
  message: string;
  entity: NotificationEntity;
  entityId: Types.ObjectId;
  proposalId: Types.ObjectId | null;
  /** Denormalised case reference for display; the case is re-checked for access on navigation. */
  reference: string | null;
  read: boolean;
  readAt: Date | null;
  /** One notification per (recipient, event) milestone; unique so retries do not duplicate. */
  dedupeKey: string;
  createdAt: Date;
  updatedAt: Date;
}

const notificationSchema = new Schema<NotificationDoc>(
  {
    recipientId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    event: { type: String, enum: NOTIFICATION_EVENTS, required: true },
    title: { type: String, required: true },
    message: { type: String, required: true },
    entity: { type: String, enum: NOTIFICATION_ENTITIES, required: true },
    entityId: { type: Schema.Types.ObjectId, required: true },
    proposalId: { type: Schema.Types.ObjectId, ref: 'Proposal', default: null },
    reference: { type: String, default: null },
    read: { type: Boolean, required: true, default: false },
    readAt: { type: Date, default: null },
    dedupeKey: { type: String, required: true },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
  },
  { collection: 'notifications', timestamps: true, strict: 'throw', minimize: false },
);

// The recipient's feed, newest first; and the unread badge.
notificationSchema.index({ recipientId: 1, createdAt: -1, _id: -1 });
notificationSchema.index({ recipientId: 1, read: 1 });
// Idempotency: one notification per dedupeKey (the key encodes recipient + event + milestone).
notificationSchema.index({ dedupeKey: 1 }, { unique: true });

export const NotificationModel = model<NotificationDoc>('Notification', notificationSchema);
