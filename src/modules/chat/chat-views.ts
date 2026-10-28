import type { ChatMessage, Conversation } from '../../shared/index.ts';
import type { Types } from 'mongoose';
import { notFound } from '../../lib/errors.ts';
import { UserModel } from '../users/user.model.ts';
import {
  ChatMessageModel,
  ConversationModel,
  type ChatMessageDoc,
  type ConversationDoc,
} from './chat.model.ts';

/** A user as the chat shows them. */
export interface ChatPerson {
  name: string;
  active: boolean;
}
export type People = ReadonlyMap<string, ChatPerson>;

const UNKNOWN: ChatPerson = { name: 'Former user', active: false };

/** The users' names and whether they are active, by id. */
export async function peopleOf(ids: Iterable<Types.ObjectId | null | undefined>): Promise<People> {
  const wanted = [...new Set([...ids].flatMap((id) => (id ? [id.toHexString()] : [])))];
  if (wanted.length === 0) return new Map();
  const users = await UserModel.find({ _id: { $in: wanted } }, { name: 1, active: 1 }).lean();
  return new Map(
    users.map((user) => [user._id.toHexString(), { name: user.name, active: user.active }]),
  );
}

export const personOf = (people: People, id: Types.ObjectId | string | null | undefined) =>
  (id ? people.get(typeof id === 'string' ? id : id.toHexString()) : undefined) ?? UNKNOWN;

/** The member ids of a conversation, as strings (who its events go to). */
export const memberIds = (doc: Pick<ConversationDoc, 'members'>) =>
  doc.members.map((member) => member.userId.toHexString());

/** A conversation the user is a member of; 404 otherwise (its existence is not revealed). */
export async function membership(conversationId: string, userId: string): Promise<ConversationDoc> {
  const doc = await ConversationModel.findOne({
    _id: conversationId,
    'members.userId': userId,
  }).lean();
  if (!doc) throw notFound('This conversation was not found');
  return doc;
}

export function messageView(doc: ChatMessageDoc, people: People): ChatMessage {
  const deleted = doc.deletedAt !== null;
  return {
    id: doc._id.toHexString(),
    conversationId: doc.conversationId.toHexString(),
    kind: doc.kind,
    sender: doc.senderId
      ? { id: doc.senderId.toHexString(), name: personOf(people, doc.senderId).name }
      : null,
    text: deleted ? '' : doc.text,
    attachment:
      doc.attachment && !deleted
        ? {
            id: doc.attachment.fileId.toHexString(),
            fileName: doc.attachment.fileName,
            contentType: doc.attachment.contentType,
            size: doc.attachment.size,
          }
        : null,
    clientId: doc.clientId,
    deleted,
    createdAt: doc.createdAt.toISOString(),
  };
}

/** Messages from others since the member last read the conversation. */
export async function unreadOf(doc: ConversationDoc, userId: string): Promise<number> {
  const member = doc.members.find((item) => item.userId.toHexString() === userId);
  return ChatMessageModel.countDocuments({
    conversationId: doc._id,
    kind: 'TEXT',
    deletedAt: null,
    senderId: { $ne: member?.userId ?? null },
    ...(member?.lastReadAt ? { createdAt: { $gt: member.lastReadAt } } : {}),
  });
}

export function conversationView(
  doc: ConversationDoc,
  userId: string,
  people: People,
  unread: number,
): Conversation {
  const members = doc.members.map((member) => {
    const person = personOf(people, member.userId);
    return {
      id: member.userId.toHexString(),
      name: person.name,
      admin: member.admin,
      active: person.active,
    };
  });
  const other = members.find((member) => member.id !== userId);
  const last = doc.lastMessage;
  return {
    id: doc._id.toHexString(),
    kind: doc.kind,
    title: doc.kind === 'GROUP' ? (doc.name ?? 'Group') : (other?.name ?? 'Former user'),
    members,
    admin: doc.kind === 'GROUP' && members.some((member) => member.id === userId && member.admin),
    lastMessage: last
      ? {
          text: last.text,
          senderName: last.senderId ? personOf(people, last.senderId).name : null,
          at: last.at.toISOString(),
        }
      : null,
    unread,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

/** One conversation as the user sees it, with fresh names and unread count. */
export async function viewFor(doc: ConversationDoc, userId: string): Promise<Conversation> {
  const people = await peopleOf([
    ...doc.members.map((member) => member.userId),
    doc.lastMessage?.senderId,
  ]);
  return conversationView(doc, userId, people, await unreadOf(doc, userId));
}
