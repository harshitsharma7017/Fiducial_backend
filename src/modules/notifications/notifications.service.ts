import {
  NOTIFICATION_EVENT_LABELS,
  type Notification,
  type NotificationEntity,
  type NotificationEvent,
  type NotificationListQuery,
  type NotificationListResponse,
  type Permission,
} from '../../shared/index.ts';
import { Types, mongo, type QueryFilter } from 'mongoose';
import type { Logger } from '../../lib/logger.ts';
import { usersWithPermission } from '../roles/roles.service.ts';
import { UserModel } from '../users/user.model.ts';
import { NotificationModel, type NotificationDoc } from './notification.model.ts';

// A4: creating and reading in-app notifications. Creation is idempotent (a unique dedupeKey) and
// always runs AFTER the business transaction has committed, so a notification never appears for a
// change that rolled back and a retried request never duplicates one. Reads are always scoped to
// the authenticated recipient — a user can never see another user's notifications.

/** One notification to create. The dedupeKey must be stable for the same event + recipient. */
export interface NotifyInput {
  recipientId: string;
  event: NotificationEvent;
  title: string;
  message: string;
  entity: NotificationEntity;
  entityId: string;
  proposalId?: string | null;
  reference?: string | null;
  /** Encodes the event milestone (e.g. `rfq-approved:<proposalId>:v3`), unique per recipient. */
  dedupeKey: string;
}

function isDuplicateKey(error: unknown): boolean {
  return error instanceof mongo.MongoServerError && error.code === 11000;
}

/**
 * Creates notifications, skipping any whose dedupeKey already exists (idempotent). Recipients are
 * de-duplicated, and a recipient never notifies about their own action is the caller's choice (it
 * passes only the recipients it wants). Failures are logged, never thrown: a notification problem
 * must not fail the business operation that already succeeded. Returns the number created.
 */
export async function notify(inputs: readonly NotifyInput[], logger?: Logger): Promise<number> {
  if (inputs.length === 0) return 0;
  // Collapse duplicates within this batch by dedupeKey.
  const byKey = new Map(inputs.map((input) => [`${input.recipientId}:${input.dedupeKey}`, input]));
  const now = new Date();
  let created = 0;
  for (const input of byKey.values()) {
    try {
      await NotificationModel.create({
        recipientId: new Types.ObjectId(input.recipientId),
        event: input.event,
        title: input.title,
        message: input.message,
        entity: input.entity,
        entityId: new Types.ObjectId(input.entityId),
        proposalId: input.proposalId ? new Types.ObjectId(input.proposalId) : null,
        reference: input.reference ?? null,
        read: false,
        readAt: null,
        // The recipient is part of the key so the same event notifies each recipient once.
        dedupeKey: `${input.recipientId}:${input.dedupeKey}`,
        createdAt: now,
        updatedAt: now,
      });
      created += 1;
    } catch (error) {
      if (isDuplicateKey(error)) continue; // already notified for this milestone
      logger?.warn({ err: error, event: input.event }, 'Notification could not be created');
    }
  }
  return created;
}

/** Active users whose roles may approve (the approval group; Property by default), by id. */
export async function approverIds(permission: Permission = 'property.approve'): Promise<string[]> {
  const users = await UserModel.find(await usersWithPermission(permission), { _id: 1 }).lean();
  return users.map((user) => user._id.toHexString());
}

/** The ids that still belong to active users who may edit (so we never notify a deactivated account). */
export async function activeEditorIds(
  ids: readonly string[],
  permission: Permission = 'property.edit',
): Promise<string[]> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return [];
  const users = await UserModel.find(
    {
      _id: { $in: unique.map((id) => new Types.ObjectId(id)) },
      ...(await usersWithPermission(permission)),
    },
    { _id: 1 },
  ).lean();
  return users.map((user) => user._id.toHexString());
}

function toDto(doc: NotificationDoc): Notification {
  return {
    id: doc._id.toHexString(),
    event: doc.event,
    title: doc.title,
    message: doc.message,
    entity: doc.entity,
    entityId: doc.entityId.toHexString(),
    proposalId: doc.proposalId ? doc.proposalId.toHexString() : null,
    reference: doc.reference,
    read: doc.read,
    readAt: doc.readAt ? doc.readAt.toISOString() : null,
    createdAt: doc.createdAt.toISOString(),
  };
}

/** The authenticated recipient's unread count. */
export async function unreadCount(recipientId: string): Promise<number> {
  return NotificationModel.countDocuments({
    recipientId: new Types.ObjectId(recipientId),
    read: false,
  });
}

/** A page of the recipient's notifications, newest first, with their unread total. */
export async function listNotifications(
  recipientId: string,
  query: NotificationListQuery,
): Promise<NotificationListResponse> {
  const recipient = new Types.ObjectId(recipientId);
  const filter: QueryFilter<NotificationDoc> = { recipientId: recipient };
  if (query.unread) filter.read = false;
  if (query.cursor) {
    const cursor = await NotificationModel.findOne(
      { _id: new Types.ObjectId(query.cursor), recipientId: recipient },
      { createdAt: 1 },
    ).lean();
    // An unknown cursor (or one of another user) yields an empty page rather than another's data.
    if (!cursor)
      return { items: [], nextCursor: null, unreadCount: await unreadCount(recipientId) };
    filter.$or = [
      { createdAt: { $lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, _id: { $lt: cursor._id } },
    ];
  }
  const docs = await NotificationModel.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(query.limit + 1)
    .lean<NotificationDoc[]>();
  const page = docs.slice(0, query.limit);
  const last = page.at(-1);
  return {
    items: page.map(toDto),
    nextCursor: docs.length > query.limit && last ? last._id.toHexString() : null,
    unreadCount: await unreadCount(recipientId),
  };
}

/** Marks one of the recipient's notifications read (idempotent); 404 if not theirs. */
export async function markRead(
  recipientId: string,
  notificationId: string,
): Promise<{ updated: number; unreadCount: number }> {
  const result = await NotificationModel.updateOne(
    { _id: new Types.ObjectId(notificationId), recipientId: new Types.ObjectId(recipientId) },
    { $set: { read: true, readAt: new Date() } },
  );
  return { updated: result.modifiedCount, unreadCount: await unreadCount(recipientId) };
}

/** Whether a notification id belongs to the recipient (so routes can 404 vs other users' ids). */
export async function ownsNotification(
  recipientId: string,
  notificationId: string,
): Promise<boolean> {
  return (
    (await NotificationModel.exists({
      _id: new Types.ObjectId(notificationId),
      recipientId: new Types.ObjectId(recipientId),
    })) !== null
  );
}

/** Marks all of the recipient's unread notifications read (idempotent). */
export async function markAllRead(
  recipientId: string,
): Promise<{ updated: number; unreadCount: number }> {
  const result = await NotificationModel.updateMany(
    { recipientId: new Types.ObjectId(recipientId), read: false },
    { $set: { read: true, readAt: new Date() } },
  );
  return { updated: result.modifiedCount, unreadCount: 0 };
}

/** A short title for an event, for callers that do not supply one. */
export function eventTitle(event: NotificationEvent): string {
  return NOTIFICATION_EVENT_LABELS[event];
}
