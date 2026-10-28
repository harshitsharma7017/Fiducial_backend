import {
  ERROR_CODES,
  MAX_CHAT_FILE_BYTES,
  isChatFileType,
  type ChatAttachment,
  type ChatMessage,
  type MessageListQuery,
  type MessagePage,
  type SendMessageRequest,
} from '../../shared/index.ts';
import { Types, mongo } from 'mongoose';
import { AppError, forbidden, notFound, validationError } from '../../lib/errors.ts';
import { putFile, readFile, removeFile } from '../files/file-store.ts';
import type { ChatHub } from './chat-hub.ts';
import { ChatFileModel, ChatMessageModel, ConversationModel } from './chat.model.ts';
import type { ChatActor } from './chat.service.ts';
import { memberIds, membership, messageView, peopleOf } from './chat-views.ts';

// Messages and files of the internal chat: read in pages, sent (each send once, by its client
// id), deleted by their sender, and delivered live to the conversation's members.

/** A page of messages, oldest first, before a message (or the latest). */
export async function listMessages(
  actor: ChatActor,
  conversationId: string,
  query: MessageListQuery,
): Promise<MessagePage> {
  await membership(conversationId, actor.id);
  const docs = await ChatMessageModel.find({
    conversationId: new Types.ObjectId(conversationId),
    ...(query.before ? { _id: { $lt: new Types.ObjectId(query.before) } } : {}),
  })
    .sort({ _id: -1 })
    .limit(query.limit + 1)
    .lean();
  const page = docs.slice(0, query.limit).reverse();
  const people = await peopleOf(page.map((doc) => doc.senderId));
  return { items: page.map((doc) => messageView(doc, people)), hasMore: docs.length > query.limit };
}

/** The line a conversation list shows for a message. */
function preview(text: string, fileName: string | null): string {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line) return line.length > 140 ? `${line.slice(0, 139)}…` : line;
  return fileName ? `File: ${fileName}` : '';
}

async function existingSend(actor: ChatActor, clientId: string) {
  return ChatMessageModel.findOne({ senderId: new Types.ObjectId(actor.id), clientId }).lean();
}

/** Sends a message, with a file uploaded before, to every member. A retried send returns the first. */
export async function sendMessage(
  actor: ChatActor,
  conversationId: string,
  input: SendMessageRequest,
  hub: ChatHub,
): Promise<ChatMessage> {
  const conversation = await membership(conversationId, actor.id);
  const people = await peopleOf([new Types.ObjectId(actor.id)]);
  const earlier = await existingSend(actor, input.clientId);
  if (earlier) return messageView(earlier, people);

  const file = input.attachmentId
    ? await ChatFileModel.findOne(
        {
          _id: new Types.ObjectId(input.attachmentId),
          conversationId: conversation._id,
          uploadedBy: new Types.ObjectId(actor.id),
          messageId: null,
        },
        { data: 0 },
      ).lean()
    : null;
  if (input.attachmentId && !file) {
    throw validationError(
      [{ location: 'body', path: 'attachmentId', message: 'Upload the file to this chat first' }],
      'The file was not found',
    );
  }
  const at = new Date();
  let doc;
  try {
    doc = (
      await ChatMessageModel.create({
        conversationId: conversation._id,
        kind: 'TEXT',
        senderId: new Types.ObjectId(actor.id),
        text: input.text,
        attachment: file
          ? {
              fileId: file._id,
              fileName: file.fileName,
              contentType: file.contentType,
              size: file.size,
            }
          : null,
        clientId: input.clientId,
        deletedAt: null,
        createdAt: at,
      })
    ).toObject();
  } catch (error) {
    // The same send twice at once: the other request posted it.
    if (error instanceof mongo.MongoServerError && error.code === 11000) {
      const posted = await existingSend(actor, input.clientId);
      if (posted) return messageView(posted, people);
    }
    throw error;
  }
  if (file) await ChatFileModel.updateOne({ _id: file._id }, { $set: { messageId: doc._id } });
  // The conversation moves up; the sender has read it up to their own message.
  await ConversationModel.updateOne(
    { _id: conversation._id, 'members.userId': new Types.ObjectId(actor.id) },
    {
      $set: {
        lastMessage: {
          text: preview(input.text, file?.fileName ?? null),
          senderId: new Types.ObjectId(actor.id),
          at,
        },
        updatedAt: at,
        'members.$.lastReadAt': at,
      },
    },
  );
  const message = messageView(doc, people);
  hub.publish(memberIds(conversation), { type: 'message', conversationId, message });
  return message;
}

/** Deletes one's own message for everyone: its text and file go, a "deleted" line stays. */
export async function deleteMessage(
  actor: ChatActor,
  conversationId: string,
  messageId: string,
  hub: ChatHub,
): Promise<ChatMessage> {
  const conversation = await membership(conversationId, actor.id);
  const doc = await ChatMessageModel.findOne({
    _id: new Types.ObjectId(messageId),
    conversationId: conversation._id,
  }).lean();
  if (!doc) throw notFound('This message was not found');
  if (doc.kind !== 'TEXT' || doc.senderId?.toHexString() !== actor.id) {
    throw forbidden('You can delete only your own messages');
  }
  const people = await peopleOf([doc.senderId]);
  if (doc.deletedAt) return messageView(doc, people);
  const deletedAt = new Date();
  await ChatMessageModel.updateOne(
    { _id: doc._id },
    { $set: { deletedAt, text: '', attachment: null } },
  );
  if (doc.attachment) {
    const removed = await ChatFileModel.findOneAndDelete(
      { _id: doc.attachment.fileId },
      { projection: { storageKey: 1 } },
    ).lean();
    await removeFile(removed?.storageKey);
  }
  if (
    conversation.lastMessage &&
    conversation.lastMessage.at.getTime() === doc.createdAt.getTime()
  ) {
    await ConversationModel.updateOne(
      { _id: conversation._id },
      { $set: { 'lastMessage.text': 'This message was deleted' } },
    );
  }
  const message = messageView({ ...doc, deletedAt, text: '', attachment: null }, people);
  hub.publish(memberIds(conversation), { type: 'message', conversationId, message });
  return message;
}

/** Marks the conversation read up to now, for the user (and their other windows). */
export async function markConversationRead(
  actor: ChatActor,
  conversationId: string,
  hub: ChatHub,
): Promise<void> {
  await membership(conversationId, actor.id);
  await ConversationModel.updateOne(
    { _id: new Types.ObjectId(conversationId), 'members.userId': new Types.ObjectId(actor.id) },
    { $set: { 'members.$.lastReadAt': new Date() } },
    { timestamps: false },
  );
  hub.publish([actor.id], { type: 'read', conversationId });
}

/** Keeps a file for a message about to be sent in the conversation (the app's own storage). */
export async function uploadChatFile(
  actor: ChatActor,
  conversationId: string,
  data: Buffer,
  fileName: string,
  contentType: string,
): Promise<ChatAttachment> {
  const conversation = await membership(conversationId, actor.id);
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!isChatFileType(type)) {
    throw new AppError(
      415,
      ERROR_CODES.UNSUPPORTED_MEDIA_TYPE,
      'This kind of file cannot be shared in the chat',
    );
  }
  if (data.length === 0) {
    throw validationError([{ location: 'body', path: '', message: 'The file is empty' }]);
  }
  if (data.length > MAX_CHAT_FILE_BYTES) {
    throw new AppError(413, ERROR_CODES.PAYLOAD_TOO_LARGE, 'The file is larger than 10 MB');
  }
  // The file goes to the file store (S3); the record keeps its key.
  const storageKey = await putFile('chat', data, type, fileName);
  const file = await ChatFileModel.create({
    conversationId: conversation._id,
    uploadedBy: new Types.ObjectId(actor.id),
    fileName,
    contentType: type,
    size: data.length,
    storageKey,
    messageId: null,
    createdAt: new Date(),
  }).catch(async (error: unknown) => {
    await removeFile(storageKey);
    throw error;
  });
  return { id: file._id.toHexString(), fileName, contentType: type, size: data.length };
}

/** A file shared in the conversation (or uploaded by the user and not sent yet). */
export async function chatFile(
  actor: ChatActor,
  conversationId: string,
  fileId: string,
): Promise<{ fileName: string; contentType: string; data: Buffer }> {
  const conversation = await membership(conversationId, actor.id);
  const file = await ChatFileModel.findOne({
    _id: new Types.ObjectId(fileId),
    conversationId: conversation._id,
    $or: [{ messageId: { $ne: null } }, { uploadedBy: new Types.ObjectId(actor.id) }],
  }).lean();
  if (!file) throw notFound('This file was not found');
  return {
    fileName: file.fileName,
    contentType: file.contentType,
    data: await readFile(file, file.data),
  };
}
