import { z } from 'zod';
import { IsoDateTimeSchema, ObjectIdSchema } from './common.ts';

// The internal chat (client review, 27 Oct 2026): employees message each other one to one and in
// groups, and share files, in real time. A conversation is seen only by its members. Files stay in
// the app's own database, like every other document.

export const CHAT_KINDS = ['DIRECT', 'GROUP'] as const;
export const ChatKindSchema = z.enum(CHAT_KINDS);
export type ChatKind = z.infer<typeof ChatKindSchema>;

export const MAX_CHAT_TEXT = 4000;
export const MAX_GROUP_NAME = 80;
export const MAX_GROUP_MEMBERS = 200;
export const MAX_CHAT_FILE_BYTES = 10 * 1024 * 1024;
export const CHAT_PAGE_SIZE = 50;

/** Files that can be shared in a chat, by content type, with the extension they are saved with. */
export const CHAT_FILE_TYPES = {
  'application/pdf': '.pdf',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/zip': '.zip',
  'message/rfc822': '.eml',
} as const;
export type ChatFileType = keyof typeof CHAT_FILE_TYPES;

/** True for a content type the chat accepts. */
export function isChatFileType(type: string): type is ChatFileType {
  return Object.hasOwn(CHAT_FILE_TYPES, type);
}

export const ChatUserSchema = z.object({ id: ObjectIdSchema, name: z.string(), email: z.string() });
export type ChatUser = z.infer<typeof ChatUserSchema>;

/** The colleagues a user can start a chat with: every other active user. */
export const ChatDirectorySchema = z.object({ items: z.array(ChatUserSchema) });
export type ChatDirectory = z.infer<typeof ChatDirectorySchema>;

export const ChatMemberSchema = z.object({
  id: ObjectIdSchema,
  name: z.string(),
  /** A group's admins rename it and add or remove members; its creator is the first. */
  admin: z.boolean(),
  /** False for a user deactivated since: kept in the group, cannot sign in. */
  active: z.boolean(),
});
export type ChatMember = z.infer<typeof ChatMemberSchema>;

export const ChatAttachmentSchema = z.object({
  id: ObjectIdSchema,
  fileName: z.string(),
  contentType: z.string(),
  size: z.number().int().min(0),
});
export type ChatAttachment = z.infer<typeof ChatAttachmentSchema>;

export const ChatMessageSchema = z.object({
  id: ObjectIdSchema,
  conversationId: ObjectIdSchema,
  /** SYSTEM: a line about the group itself (created, renamed, members added or removed). */
  kind: z.enum(['TEXT', 'SYSTEM']),
  /** Null for a system line. */
  sender: z.object({ id: ObjectIdSchema, name: z.string() }).nullable(),
  /** Empty for a deleted message, or a file sent without text. */
  text: z.string(),
  attachment: ChatAttachmentSchema.nullable(),
  /** The sender's id for the send, so a retried send is not posted twice. */
  clientId: z.string().nullable(),
  deleted: z.boolean(),
  createdAt: IsoDateTimeSchema,
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ConversationSchema = z.object({
  id: ObjectIdSchema,
  kind: ChatKindSchema,
  /** A group's name; for a direct chat, the other person's name. */
  title: z.string(),
  members: z.array(ChatMemberSchema),
  /** Whether the signed-in user is an admin of the group (always false for a direct chat). */
  admin: z.boolean(),
  lastMessage: z
    .object({
      text: z.string(),
      senderName: z.string().nullable(),
      at: IsoDateTimeSchema,
    })
    .nullable(),
  /** Messages from others since the signed-in user last read the conversation. */
  unread: z.number().int().min(0),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Conversation = z.infer<typeof ConversationSchema>;

export const ConversationListSchema = z.object({
  /** Most recent activity first. */
  items: z.array(ConversationSchema),
  unreadTotal: z.number().int().min(0),
});
export type ConversationList = z.infer<typeof ConversationListSchema>;

export const MessagePageSchema = z.object({
  /** Oldest first. */
  items: z.array(ChatMessageSchema),
  /** True when older messages remain (ask again with before = the first item's id). */
  hasMore: z.boolean(),
});
export type MessagePage = z.infer<typeof MessagePageSchema>;

export const ConversationParamsSchema = z.strictObject({ conversationId: ObjectIdSchema });
export const ChatMessageParamsSchema = z.strictObject({
  conversationId: ObjectIdSchema,
  messageId: ObjectIdSchema,
});
export const ChatFileParamsSchema = z.strictObject({
  conversationId: ObjectIdSchema,
  fileId: ObjectIdSchema,
});
export const ChatMemberParamsSchema = z.strictObject({
  conversationId: ObjectIdSchema,
  userId: ObjectIdSchema,
});

export const MessageListQuerySchema = z.strictObject({
  before: ObjectIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(CHAT_PAGE_SIZE),
});
export type MessageListQuery = z.infer<typeof MessageListQuerySchema>;

export const ChatFileUploadQuerySchema = z.strictObject({
  fileName: z.string().trim().min(1, 'Name the file').max(200, 'File name is too long'),
});

const GroupNameSchema = z
  .string()
  .trim()
  .min(1, 'Name the group')
  .max(MAX_GROUP_NAME, `Use at most ${MAX_GROUP_NAME} characters`);

const MemberIdsSchema = z
  .array(ObjectIdSchema)
  .min(1, 'Choose at least one colleague')
  .max(MAX_GROUP_MEMBERS - 1, `A group has at most ${MAX_GROUP_MEMBERS} members`)
  .refine((ids) => new Set(ids).size === ids.length, 'Each colleague can be added once');

export const CreateDirectChatRequestSchema = z.strictObject({ userId: ObjectIdSchema });
export type CreateDirectChatRequest = z.infer<typeof CreateDirectChatRequestSchema>;

export const CreateGroupRequestSchema = z.strictObject({
  name: GroupNameSchema,
  memberIds: MemberIdsSchema,
});
export type CreateGroupRequest = z.infer<typeof CreateGroupRequestSchema>;
export type CreateGroupFormValues = z.input<typeof CreateGroupRequestSchema>;

export const RenameGroupRequestSchema = z.strictObject({ name: GroupNameSchema });
export type RenameGroupRequest = z.infer<typeof RenameGroupRequestSchema>;

export const AddGroupMembersRequestSchema = z.strictObject({ userIds: MemberIdsSchema });
export type AddGroupMembersRequest = z.infer<typeof AddGroupMembersRequestSchema>;

export const SendMessageRequestSchema = z
  .strictObject({
    text: z
      .string()
      .max(MAX_CHAT_TEXT, `Use at most ${MAX_CHAT_TEXT} characters`)
      .transform((text) => text.trim()),
    /** A file uploaded to this conversation and not sent yet. */
    attachmentId: ObjectIdSchema.nullable().default(null),
    /** A new id per send (crypto.randomUUID()), kept for retries of the same send. */
    clientId: z.uuid('Must be a UUID'),
  })
  .refine((body) => body.text !== '' || body.attachmentId !== null, {
    path: ['text'],
    message: 'Type a message or attach a file',
  });
export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;

/**
 * What the live connection (GET /chat/events, server-sent events) tells a member. message: a new
 * or deleted message. conversation: a conversation was created or changed (name, members), or
 * the user was removed from it (removed). read: the user read a conversation in another window.
 */
export const ChatEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message'),
    conversationId: ObjectIdSchema,
    message: ChatMessageSchema,
  }),
  z.object({
    type: z.literal('conversation'),
    conversationId: ObjectIdSchema,
    removed: z.boolean(),
  }),
  z.object({ type: z.literal('read'), conversationId: ObjectIdSchema }),
]);
export type ChatEvent = z.infer<typeof ChatEventSchema>;
