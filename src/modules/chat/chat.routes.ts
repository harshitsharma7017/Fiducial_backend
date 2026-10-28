import {
  AddGroupMembersRequestSchema,
  CHAT_FILE_TYPES,
  ChatAttachmentSchema,
  ChatDirectorySchema,
  ChatFileParamsSchema,
  ChatFileUploadQuerySchema,
  ChatMemberParamsSchema,
  ChatMessageParamsSchema,
  ChatMessageSchema,
  ConversationListSchema,
  ConversationParamsSchema,
  ConversationSchema,
  CreateDirectChatRequestSchema,
  CreateGroupRequestSchema,
  MAX_CHAT_FILE_BYTES,
  MessageListQuerySchema,
  MessagePageSchema,
  RenameGroupRequestSchema,
  SendMessageRequestSchema,
  type ChatEvent,
} from '../../shared/index.ts';
import express, { Router, type Request } from 'express';
import { z } from 'zod';
import { documentRoute, errorResponses } from '../../lib/openapi.ts';
import { authenticate } from '../../middleware/auth.ts';
import { authenticatedAccess, currentUser } from '../../middleware/require-permission.ts';
import { route } from '../../middleware/validate.ts';
import { UserModel } from '../users/user.model.ts';
import type { ChatHub } from './chat-hub.ts';
import {
  chatFile,
  deleteMessage,
  listMessages,
  markConversationRead,
  sendMessage,
  uploadChatFile,
} from './chat-messages.service.ts';
import {
  addGroupMembers,
  chatDirectory,
  createGroup,
  getConversation,
  listConversations,
  openDirectChat,
  removeGroupMember,
  renameGroup,
  type ChatActor,
} from './chat.service.ts';

/** How often the live connection is pinged (proxies close idle connections after about 60 s). */
export const CHAT_PING_MS = 25_000;

const UploadSchema = z.instanceof(Buffer, { error: 'Upload the file as the request body' });

function actorOf(req: Request): ChatActor {
  const user = currentUser(req);
  return { id: user.id, name: user.name, requestId: req.requestId };
}

/**
 * The internal chat (client review, 27 Oct 2026), under /api/v1/chat. Open to every signed-in
 * employee; each route acts only on conversations the caller is a member of (checked in the
 * services, 404 otherwise). GET /events is the live connection (server-sent events).
 */
export function createChatRouter(options: {
  jwtSecret: string;
  hub: ChatHub;
  pingMs?: number;
}): Router {
  const router = Router();
  const { hub } = options;
  router.use(
    authenticate(options),
    authenticatedAccess('the caller’s own conversations only (membership checked per request)'),
  );

  router.get(
    '/events',
    route({}, async (_input, req, res) => {
      const actor = actorOf(req);
      res.status(200).set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // Nginx (and the web app's proxy) pass each event on at once.
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
      res.write('retry: 5000\n\n');
      const send = (event: ChatEvent) =>
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      const unsubscribe = hub.subscribe(actor.id, send, () => res.end());
      await new Promise<void>((resolve) => {
        const close = () => {
          clearInterval(ping);
          unsubscribe();
          resolve();
        };
        // A ping keeps proxies from closing the connection; a deactivated user is let go.
        const ping = setInterval(() => {
          void UserModel.exists({ _id: actor.id, active: true }).then((active) => {
            if (active) res.write(': ping\n\n');
            else res.end();
          });
        }, options.pingMs ?? CHAT_PING_MS);
        req.on('close', close);
      });
    }),
  );

  router.get(
    '/directory',
    route({}, async (_input, req, res) => {
      res.json(await chatDirectory(actorOf(req)));
    }),
  );

  router.get(
    '/conversations',
    route({}, async (_input, req, res) => {
      res.json(await listConversations(actorOf(req)));
    }),
  );

  router.post(
    '/conversations/direct',
    route({ body: CreateDirectChatRequestSchema }, async ({ body }, req, res) => {
      res.json(await openDirectChat(actorOf(req), body.userId, hub));
    }),
  );

  router.post(
    '/conversations/groups',
    route({ body: CreateGroupRequestSchema }, async ({ body }, req, res) => {
      res.status(201).json(await createGroup(actorOf(req), body, hub));
    }),
  );

  router.get(
    '/conversations/:conversationId',
    route({ params: ConversationParamsSchema }, async ({ params }, req, res) => {
      res.json(await getConversation(actorOf(req), params.conversationId));
    }),
  );

  router.put(
    '/conversations/:conversationId/name',
    route(
      { params: ConversationParamsSchema, body: RenameGroupRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await renameGroup(actorOf(req), params.conversationId, body.name, hub));
      },
    ),
  );

  router.post(
    '/conversations/:conversationId/members',
    route(
      { params: ConversationParamsSchema, body: AddGroupMembersRequestSchema },
      async ({ params, body }, req, res) => {
        res.json(await addGroupMembers(actorOf(req), params.conversationId, body, hub));
      },
    ),
  );

  router.delete(
    '/conversations/:conversationId/members/:userId',
    route({ params: ChatMemberParamsSchema }, async ({ params }, req, res) => {
      const left = await removeGroupMember(actorOf(req), params.conversationId, params.userId, hub);
      if (left) res.json(left);
      else res.status(204).end();
    }),
  );

  router.get(
    '/conversations/:conversationId/messages',
    route(
      { params: ConversationParamsSchema, query: MessageListQuerySchema },
      async ({ params, query }, req, res) => {
        res.json(await listMessages(actorOf(req), params.conversationId, query));
      },
    ),
  );

  router.post(
    '/conversations/:conversationId/messages',
    route(
      { params: ConversationParamsSchema, body: SendMessageRequestSchema },
      async ({ params, body }, req, res) => {
        res.status(201).json(await sendMessage(actorOf(req), params.conversationId, body, hub));
      },
    ),
  );

  router.delete(
    '/conversations/:conversationId/messages/:messageId',
    route({ params: ChatMessageParamsSchema }, async ({ params }, req, res) => {
      res.json(await deleteMessage(actorOf(req), params.conversationId, params.messageId, hub));
    }),
  );

  router.post(
    '/conversations/:conversationId/read',
    route({ params: ConversationParamsSchema }, async ({ params }, req, res) => {
      await markConversationRead(actorOf(req), params.conversationId, hub);
      res.status(204).end();
    }),
  );

  router.post(
    '/conversations/:conversationId/files',
    // Any type is read; the service accepts the chat's file types and refuses others with 415.
    express.raw({ type: () => true, limit: MAX_CHAT_FILE_BYTES }),
    route(
      { params: ConversationParamsSchema, query: ChatFileUploadQuerySchema, body: UploadSchema },
      async ({ params, query, body }, req, res) => {
        res
          .status(201)
          .json(
            await uploadChatFile(
              actorOf(req),
              params.conversationId,
              body,
              query.fileName,
              req.get('content-type') ?? '',
            ),
          );
      },
    ),
  );

  router.get(
    '/conversations/:conversationId/files/:fileId',
    route({ params: ChatFileParamsSchema }, async ({ params }, req, res) => {
      const file = await chatFile(actorOf(req), params.conversationId, params.fileId);
      res.setHeader('Content-Type', file.contentType);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${file.fileName.replace(/[^\w.\- ]/g, '_')}"`,
      );
      res.send(file.data);
    }),
  );

  return router;
}

const json = (schema: z.ZodType) => ({ content: { 'application/json': { schema } } });
const SIGNED_IN = 'Any signed-in user; only conversations they are a member of (404 otherwise).';
const doc = (
  method: 'get' | 'post' | 'put' | 'delete',
  path: string,
  summary: string,
  description: string,
  request: Parameters<typeof documentRoute>[0]['request'],
  responses: Parameters<typeof documentRoute>[0]['responses'],
) =>
  documentRoute({
    method,
    path: `/api/v1/chat${path}`,
    tags: ['Chat'],
    summary,
    description: `${SIGNED_IN} ${description}`,
    request,
    responses,
  });

doc(
  'get',
  '/events',
  'Live chat events (server-sent events)',
  'A text/event-stream that stays open: message (new or deleted), conversation (created, changed, or you were removed) and read events for the signed-in user. Pinged every 25 s.',
  {},
  {
    200: { description: 'The stream', content: { 'text/event-stream': { schema: z.string() } } },
    ...errorResponses(401),
  },
);
doc(
  'get',
  '/directory',
  'Colleagues to chat with',
  'Every other active user, by name.',
  {},
  {
    200: { description: 'The colleagues', ...json(ChatDirectorySchema) },
    ...errorResponses(401),
  },
);
doc(
  'get',
  '/conversations',
  'Your conversations',
  'Direct chats and groups, most recent first, with unread counts.',
  {},
  {
    200: { description: 'The conversations', ...json(ConversationListSchema) },
    ...errorResponses(401),
  },
);
doc(
  'post',
  '/conversations/direct',
  'Open a direct chat',
  'The one direct chat with an active colleague, created on first use.',
  { body: json(CreateDirectChatRequestSchema) },
  { 200: { description: 'The chat', ...json(ConversationSchema) }, ...errorResponses(400, 401) },
);
doc(
  'post',
  '/conversations/groups',
  'Create a group',
  'You are its admin; the members must be active colleagues. Audited.',
  { body: json(CreateGroupRequestSchema) },
  { 201: { description: 'The group', ...json(ConversationSchema) }, ...errorResponses(400, 401) },
);
doc(
  'get',
  '/conversations/{conversationId}',
  'A conversation',
  'Its members and unread count.',
  { params: ConversationParamsSchema },
  {
    200: { description: 'The conversation', ...json(ConversationSchema) },
    ...errorResponses(401, 404),
  },
);
doc(
  'put',
  '/conversations/{conversationId}/name',
  'Rename a group',
  'Group admins only. Audited.',
  { params: ConversationParamsSchema, body: json(RenameGroupRequestSchema) },
  {
    200: { description: 'The group', ...json(ConversationSchema) },
    ...errorResponses(400, 401, 403, 404, 409),
  },
);
doc(
  'post',
  '/conversations/{conversationId}/members',
  'Add members to a group',
  'Group admins only; active colleagues; at most 200 members. Audited.',
  { params: ConversationParamsSchema, body: json(AddGroupMembersRequestSchema) },
  {
    200: { description: 'The group', ...json(ConversationSchema) },
    ...errorResponses(400, 401, 403, 404, 409),
  },
);
doc(
  'delete',
  '/conversations/{conversationId}/members/{userId}',
  'Remove a member, or leave a group',
  'An admin removes a colleague (200 with the group); anyone leaves with their own id (204). A group left without an admin makes its longest-standing member one. Audited.',
  { params: ChatMemberParamsSchema },
  {
    200: { description: 'The group', ...json(ConversationSchema) },
    204: { description: 'Left the group' },
    ...errorResponses(401, 403, 404, 409),
  },
);
doc(
  'get',
  '/conversations/{conversationId}/messages',
  'Messages',
  'A page of messages, oldest first; before = a message id for older ones.',
  { params: ConversationParamsSchema, query: MessageListQuerySchema },
  {
    200: { description: 'The page', ...json(MessagePageSchema) },
    ...errorResponses(400, 401, 404),
  },
);
doc(
  'post',
  '/conversations/{conversationId}/messages',
  'Send a message',
  'Text, a file uploaded to the conversation, or both; delivered live to every member. The same clientId again returns the first message.',
  { params: ConversationParamsSchema, body: json(SendMessageRequestSchema) },
  {
    201: { description: 'The message', ...json(ChatMessageSchema) },
    ...errorResponses(400, 401, 404),
  },
);
doc(
  'delete',
  '/conversations/{conversationId}/messages/{messageId}',
  'Delete your message',
  'Its text and file are removed for everyone; a “deleted” line stays.',
  { params: ChatMessageParamsSchema },
  {
    200: { description: 'The message', ...json(ChatMessageSchema) },
    ...errorResponses(401, 403, 404),
  },
);
doc(
  'post',
  '/conversations/{conversationId}/read',
  'Mark a conversation read',
  'Clears its unread count for you.',
  { params: ConversationParamsSchema },
  { 204: { description: 'Read' }, ...errorResponses(401, 404) },
);
doc(
  'post',
  '/conversations/{conversationId}/files',
  'Upload a file to share',
  `The file is the request body (${Object.values(CHAT_FILE_TYPES).join(', ')}; up to ${MAX_CHAT_FILE_BYTES / 1024 / 1024} MB), kept in the app's database. Send it with a message by its id.`,
  { params: ConversationParamsSchema, query: ChatFileUploadQuerySchema },
  {
    201: { description: 'The file', ...json(ChatAttachmentSchema) },
    ...errorResponses(400, 401, 404, 413, 415),
  },
);
doc(
  'get',
  '/conversations/{conversationId}/files/{fileId}',
  'Download a shared file',
  'A file sent in the conversation.',
  { params: ChatFileParamsSchema },
  {
    200: {
      description: 'The file',
      content: { 'application/octet-stream': { schema: z.string().meta({ format: 'binary' }) } },
    },
    ...errorResponses(401, 404),
  },
);
