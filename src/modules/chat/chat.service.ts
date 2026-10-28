import {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  ERROR_CODES,
  MAX_GROUP_MEMBERS,
  type AddGroupMembersRequest,
  type ChatDirectory,
  type Conversation,
  type ConversationList,
  type CreateGroupRequest,
} from '../../shared/index.ts';
import { Types, mongo } from 'mongoose';
import { conflict, forbidden, notFound, validationError } from '../../lib/errors.ts';
import { writeAudit } from '../audit/audit.service.ts';
import { UserModel } from '../users/user.model.ts';
import type { ChatHub } from './chat-hub.ts';
import { ChatMessageModel, ConversationModel, type ConversationDoc } from './chat.model.ts';
import {
  conversationView,
  memberIds,
  membership,
  peopleOf,
  personOf,
  unreadOf,
  viewFor,
} from './chat-views.ts';

// Conversations of the internal chat: one direct chat per pair of colleagues, and groups whose
// admins name them and choose their members. Every action is the signed-in user's own; a user
// sees and acts only on the conversations they are a member of.

export interface ChatActor {
  id: string;
  name: string;
  requestId: string | null;
}

/** Every other active colleague, by name: who a chat can be started with. */
export async function chatDirectory(actor: ChatActor): Promise<ChatDirectory> {
  const users = await UserModel.find(
    { active: true, _id: { $ne: new Types.ObjectId(actor.id) } },
    { name: 1, email: 1 },
  )
    .sort({ name: 1 })
    .lean();
  return {
    items: users.map((user) => ({
      id: user._id.toHexString(),
      name: user.name,
      email: user.email,
    })),
  };
}

/** The user's conversations, most recent activity first, with what each has unread. */
export async function listConversations(actor: ChatActor): Promise<ConversationList> {
  const docs = await ConversationModel.find({ 'members.userId': actor.id })
    .sort({ updatedAt: -1 })
    .lean();
  const people = await peopleOf(
    docs.flatMap((doc) => [
      ...doc.members.map((member) => member.userId),
      doc.lastMessage?.senderId,
    ]),
  );
  const unread = await Promise.all(docs.map((doc) => unreadOf(doc, actor.id)));
  const items = docs.map((doc, index) =>
    conversationView(doc, actor.id, people, unread[index] ?? 0),
  );
  return { items, unreadTotal: unread.reduce((total, count) => total + count, 0) };
}

export async function getConversation(actor: ChatActor, id: string): Promise<Conversation> {
  return viewFor(await membership(id, actor.id), actor.id);
}

/** Active users among the ids (the others are refused: unknown or deactivated). */
async function activeUsers(ids: readonly string[]) {
  const users = await UserModel.find({ _id: { $in: ids }, active: true }, { name: 1 }).lean();
  const found = new Set(users.map((user) => user._id.toHexString()));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw validationError(
      missing.map((id) => ({ location: 'body', path: id, message: 'No active user has this id' })),
      'Some of these colleagues cannot be added',
    );
  }
  return users;
}

const now = () => new Date();

/** A system line in the conversation ("Asha created the group"), and the conversation moved up. */
async function systemLine(doc: ConversationDoc, text: string, hub: ChatHub, extra: string[] = []) {
  const at = now();
  const message = await ChatMessageModel.create({
    conversationId: doc._id,
    kind: 'SYSTEM',
    senderId: null,
    text,
    attachment: null,
    clientId: null,
    deletedAt: null,
    createdAt: at,
  });
  await ConversationModel.updateOne(
    { _id: doc._id },
    { $set: { lastMessage: { text, senderId: null, at }, updatedAt: at } },
  );
  const view = {
    id: message._id.toHexString(),
    conversationId: doc._id.toHexString(),
    kind: 'SYSTEM' as const,
    sender: null,
    text,
    attachment: null,
    clientId: null,
    deleted: false,
    createdAt: at.toISOString(),
  };
  hub.publish([...memberIds(doc), ...extra], {
    type: 'message',
    conversationId: view.conversationId,
    message: view,
  });
}

function announce(hub: ChatHub, doc: ConversationDoc, removed: string[] = []) {
  const conversationId = doc._id.toHexString();
  hub.publish(memberIds(doc), { type: 'conversation', conversationId, removed: false });
  hub.publish(removed, { type: 'conversation', conversationId, removed: true });
}

/** The direct chat with a colleague, opened (created on first use). */
export async function openDirectChat(
  actor: ChatActor,
  userId: string,
  hub: ChatHub,
): Promise<Conversation> {
  if (userId === actor.id) {
    throw validationError(
      [{ location: 'body', path: 'userId', message: 'Choose a colleague' }],
      'You cannot start a chat with yourself',
    );
  }
  await activeUsers([userId]);
  const directKey = [actor.id, userId].sort().join(':');
  let doc = await ConversationModel.findOne({ directKey }).lean();
  if (!doc) {
    const at = now();
    try {
      const created = await ConversationModel.create({
        kind: 'DIRECT',
        name: null,
        directKey,
        members: [actor.id, userId].map((id) => ({
          userId: new Types.ObjectId(id),
          admin: false,
          joinedAt: at,
          lastReadAt: null,
        })),
        createdBy: new Types.ObjectId(actor.id),
        lastMessage: null,
      });
      doc = created.toObject();
      announce(hub, doc);
    } catch (error) {
      // Both started the chat at once: the other request created it.
      if (!(error instanceof mongo.MongoServerError && error.code === 11000)) throw error;
      doc = await ConversationModel.findOne({ directKey }).lean();
    }
  }
  if (!doc) throw notFound('This conversation was not found');
  return viewFor(doc, actor.id);
}

/** A new group with the user as its admin. Audited. */
export async function createGroup(
  actor: ChatActor,
  input: CreateGroupRequest,
  hub: ChatHub,
): Promise<Conversation> {
  const others = input.memberIds.filter((id) => id !== actor.id);
  const users = await activeUsers(others);
  const at = now();
  const created = await ConversationModel.create({
    kind: 'GROUP',
    name: input.name,
    directKey: null,
    members: [
      { userId: new Types.ObjectId(actor.id), admin: true, joinedAt: at, lastReadAt: at },
      ...others.map((id) => ({
        userId: new Types.ObjectId(id),
        admin: false,
        joinedAt: at,
        lastReadAt: null,
      })),
    ],
    createdBy: new Types.ObjectId(actor.id),
    lastMessage: null,
  });
  const doc = created.toObject();
  await writeAudit({
    userId: actor.id,
    action: AUDIT_ACTIONS.CHAT_GROUP_CREATED,
    entity: AUDIT_ENTITIES.CHAT_GROUP,
    entityId: doc._id.toHexString(),
    before: null,
    after: { name: input.name, members: [actor.name, ...users.map((user) => user.name)] },
    requestId: actor.requestId,
  });
  announce(hub, doc);
  await systemLine(doc, `${actor.name} created the group “${input.name}”`, hub);
  return viewFor(await membership(doc._id.toHexString(), actor.id), actor.id);
}

async function adminGroup(actor: ChatActor, id: string): Promise<ConversationDoc> {
  const doc = await membership(id, actor.id);
  if (doc.kind !== 'GROUP') {
    throw conflict(ERROR_CODES.CHAT_NOT_A_GROUP, 'A direct chat has no name or members to change');
  }
  const me = doc.members.find((member) => member.userId.toHexString() === actor.id);
  if (!me?.admin) throw forbidden('Only the group’s admins can do this');
  return doc;
}

async function audit(actor: ChatActor, doc: ConversationDoc, before: unknown, after: unknown) {
  await writeAudit({
    userId: actor.id,
    action: AUDIT_ACTIONS.CHAT_GROUP_UPDATED,
    entity: AUDIT_ENTITIES.CHAT_GROUP,
    entityId: doc._id.toHexString(),
    before,
    after,
    requestId: actor.requestId,
  });
}

/** Renames a group (its admins). Audited. */
export async function renameGroup(
  actor: ChatActor,
  id: string,
  name: string,
  hub: ChatHub,
): Promise<Conversation> {
  const doc = await adminGroup(actor, id);
  if (doc.name === name) return viewFor(doc, actor.id);
  await ConversationModel.updateOne({ _id: doc._id }, { $set: { name } });
  await audit(actor, doc, { name: doc.name }, { name });
  announce(hub, doc);
  await systemLine(doc, `${actor.name} renamed the group to “${name}”`, hub);
  return getConversation(actor, id);
}

/** Adds colleagues to a group (its admins). Audited. */
export async function addGroupMembers(
  actor: ChatActor,
  id: string,
  input: AddGroupMembersRequest,
  hub: ChatHub,
): Promise<Conversation> {
  const doc = await adminGroup(actor, id);
  const current = new Set(memberIds(doc));
  const wanted = input.userIds.filter((userId) => !current.has(userId));
  if (wanted.length === 0) return viewFor(doc, actor.id);
  if (current.size + wanted.length > MAX_GROUP_MEMBERS) {
    throw validationError(
      [
        {
          location: 'body',
          path: 'userIds',
          message: `A group has at most ${MAX_GROUP_MEMBERS} members`,
        },
      ],
      `A group has at most ${MAX_GROUP_MEMBERS} members`,
    );
  }
  const users = await activeUsers(wanted);
  const at = now();
  await ConversationModel.updateOne(
    { _id: doc._id },
    {
      $push: {
        members: {
          $each: wanted.map((userId) => ({
            userId: new Types.ObjectId(userId),
            admin: false,
            joinedAt: at,
            lastReadAt: null,
          })),
        },
      },
    },
  );
  const names = users.map((user) => user.name);
  await audit(actor, doc, null, { added: names });
  const updated = await membership(id, actor.id);
  announce(hub, updated);
  await systemLine(updated, `${actor.name} added ${names.join(', ')}`, hub);
  return viewFor(updated, actor.id);
}

/**
 * Takes a member out of a group: an admin removes a colleague, or anyone leaves. A group left
 * without an admin makes its longest-standing member one. Audited.
 */
export async function removeGroupMember(
  actor: ChatActor,
  id: string,
  userId: string,
  hub: ChatHub,
): Promise<Conversation | null> {
  const leaving = userId === actor.id;
  const doc = leaving ? await membership(id, actor.id) : await adminGroup(actor, id);
  if (doc.kind !== 'GROUP')
    throw conflict(ERROR_CODES.CHAT_NOT_A_GROUP, 'You cannot leave a direct chat');
  if (!doc.members.some((member) => member.userId.toHexString() === userId)) {
    throw notFound('This colleague is not in the group');
  }
  const rest = doc.members.filter((member) => member.userId.toHexString() !== userId);
  if (rest.length > 0 && !rest.some((member) => member.admin)) {
    const first = [...rest].sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime())[0];
    if (first) first.admin = true;
  }
  await ConversationModel.updateOne({ _id: doc._id }, { $set: { members: rest } });
  const people = await peopleOf([new Types.ObjectId(userId)]);
  const name = personOf(people, userId).name;
  await audit(actor, doc, { member: name }, leaving ? { left: name } : { removed: name });
  const updated: ConversationDoc = { ...doc, members: rest };
  announce(hub, updated, [userId]);
  if (rest.length > 0) {
    await systemLine(
      updated,
      leaving ? `${actor.name} left` : `${actor.name} removed ${name}`,
      hub,
    );
  }
  return leaving ? null : getConversation(actor, id);
}
