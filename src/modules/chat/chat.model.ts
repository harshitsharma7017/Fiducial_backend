import { CHAT_KINDS, type ChatKind } from '../../shared/index.ts';
import { Schema, model, type Types } from 'mongoose';

// The internal chat's records (client review, 27 Oct 2026): conversations with their members,
// messages (append-only; a sender may delete one, which keeps the row and clears its text), and
// the files shared in them (in the database, like every other document).

export interface ChatMemberDoc {
  userId: Types.ObjectId;
  admin: boolean;
  joinedAt: Date;
  /** Messages after this are unread for the member; null before the first read. */
  lastReadAt: Date | null;
}

export interface ConversationDoc {
  _id: Types.ObjectId;
  kind: ChatKind;
  /** A group's name; null for a direct chat. */
  name: string | null;
  /** A direct chat's two user ids, sorted and joined: one direct chat per pair. */
  directKey: string | null;
  members: ChatMemberDoc[];
  createdBy: Types.ObjectId;
  lastMessage: {
    text: string;
    senderId: Types.ObjectId | null;
    at: Date;
  } | null;
  createdAt: Date;
  updatedAt: Date;
}

const noId = { _id: false, versionKey: false as const, strict: true as const };

const conversationSchema = new Schema<ConversationDoc>(
  {
    kind: { type: String, enum: CHAT_KINDS, required: true },
    name: { type: String, default: null },
    directKey: { type: String, default: null },
    members: [
      new Schema(
        {
          userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
          admin: { type: Boolean, required: true },
          joinedAt: { type: Date, required: true },
          lastReadAt: { type: Date, default: null },
        },
        noId,
      ),
    ],
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    lastMessage: {
      type: new Schema(
        {
          text: { type: String, required: true },
          senderId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
          at: { type: Date, required: true },
        },
        noId,
      ),
      default: null,
    },
  },
  {
    collection: 'chat_conversations',
    timestamps: true,
    versionKey: false,
    strict: 'throw',
    minimize: false,
  },
);
conversationSchema.index({ 'members.userId': 1, updatedAt: -1 });
conversationSchema.index(
  { directKey: 1 },
  { unique: true, partialFilterExpression: { directKey: { $type: 'string' } } },
);

export const ConversationModel = model<ConversationDoc>('ChatConversation', conversationSchema);

export interface ChatMessageDoc {
  _id: Types.ObjectId;
  conversationId: Types.ObjectId;
  kind: 'TEXT' | 'SYSTEM';
  senderId: Types.ObjectId | null;
  text: string;
  attachment: {
    fileId: Types.ObjectId;
    fileName: string;
    contentType: string;
    size: number;
  } | null;
  clientId: string | null;
  deletedAt: Date | null;
  createdAt: Date;
}

const chatMessageSchema = new Schema<ChatMessageDoc>(
  {
    conversationId: { type: Schema.Types.ObjectId, ref: 'ChatConversation', required: true },
    kind: { type: String, enum: ['TEXT', 'SYSTEM'], required: true },
    senderId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    text: { type: String, default: '' },
    attachment: {
      type: new Schema(
        {
          fileId: { type: Schema.Types.ObjectId, ref: 'ChatFile', required: true },
          fileName: { type: String, required: true },
          contentType: { type: String, required: true },
          size: { type: Number, required: true },
        },
        noId,
      ),
      default: null,
    },
    clientId: { type: String, default: null },
    deletedAt: { type: Date, default: null },
    createdAt: { type: Date, required: true },
  },
  { collection: 'chat_messages', versionKey: false, strict: 'throw', minimize: false },
);
chatMessageSchema.index({ conversationId: 1, _id: -1 });
chatMessageSchema.index(
  { senderId: 1, clientId: 1 },
  { unique: true, partialFilterExpression: { clientId: { $type: 'string' } } },
);

export const ChatMessageModel = model<ChatMessageDoc>('ChatMessage', chatMessageSchema);

export interface ChatFileDoc {
  _id: Types.ObjectId;
  conversationId: Types.ObjectId;
  uploadedBy: Types.ObjectId;
  fileName: string;
  contentType: string;
  size: number;
  data: Buffer;
  /** The message that shared it; null until sent (an unsent upload is never shown). */
  messageId: Types.ObjectId | null;
  createdAt: Date;
}

const chatFileSchema = new Schema<ChatFileDoc>(
  {
    conversationId: { type: Schema.Types.ObjectId, ref: 'ChatConversation', required: true },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    fileName: { type: String, required: true },
    contentType: { type: String, required: true },
    size: { type: Number, required: true },
    data: { type: Buffer, required: true },
    messageId: { type: Schema.Types.ObjectId, ref: 'ChatMessage', default: null },
    createdAt: { type: Date, required: true },
  },
  { collection: 'chat_files', versionKey: false, strict: 'throw' },
);
chatFileSchema.index({ conversationId: 1 });

export const ChatFileModel = model<ChatFileDoc>('ChatFile', chatFileSchema);
