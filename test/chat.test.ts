import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLogModel } from '../src/modules/audit/audit.model.ts';
import { ChatHub } from '../src/modules/chat/chat-hub.ts';
import { bearer, createTestApp, createTestUser, loginAs, useTestDatabase } from './helpers/app.ts';

// The internal chat (client review, 27 Oct 2026): direct messages, groups, file sharing and live
// delivery, each user seeing only their own conversations.

useTestDatabase();
const hub = new ChatHub();
const app = createTestApp({}, undefined, undefined, undefined, undefined, {
  chatHub: hub,
  chatPingMs: 200,
});
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');

interface Person {
  id: string;
  token: string;
}
let asha: Person;
let ravi: Person;
let meena: Person;
let inactiveId: string;

async function person(name: string, roles: ('ACCOUNT_MANAGER' | 'READ_ONLY' | 'MANAGER')[]) {
  const user = await createTestUser({ name, roles });
  return { id: user.id, token: await loginAs(app, user) };
}

const send = (who: Person, conversationId: string, text: string, extra = {}) =>
  request(app)
    .post(`/api/v1/chat/conversations/${conversationId}/messages`)
    .set(bearer(who.token))
    .send({ text, clientId: randomUUID(), ...extra });

const conversations = async (who: Person) =>
  (await request(app).get('/api/v1/chat/conversations').set(bearer(who.token)).expect(200))
    .body as {
    items: { id: string; kind: string; title: string; unread: number; admin: boolean }[];
    unreadTotal: number;
  };

beforeAll(async () => {
  asha = await person('Asha Rao', ['ACCOUNT_MANAGER']);
  ravi = await person('Ravi Mehta', ['READ_ONLY']);
  meena = await person('Meena Iyer', ['MANAGER']);
  inactiveId = (await createTestUser({ name: 'Old Hand', active: false })).id;
});

describe('direct chats', () => {
  let chatId: string;

  it('lists the other active colleagues to chat with', async () => {
    const directory = await request(app)
      .get('/api/v1/chat/directory')
      .set(bearer(asha.token))
      .expect(200);
    const names = (directory.body.items as { name: string }[]).map((item) => item.name);
    expect(names).toContain('Ravi Mehta');
    expect(names).toContain('Meena Iyer');
    expect(names).not.toContain('Asha Rao');
    expect(names).not.toContain('Old Hand');
  });

  it('opens one direct chat per pair, from either side', async () => {
    const opened = await request(app)
      .post('/api/v1/chat/conversations/direct')
      .set(bearer(asha.token))
      .send({ userId: ravi.id })
      .expect(200);
    chatId = opened.body.id as string;
    expect(opened.body).toMatchObject({ kind: 'DIRECT', title: 'Ravi Mehta', admin: false });
    const again = await request(app)
      .post('/api/v1/chat/conversations/direct')
      .set(bearer(ravi.token))
      .send({ userId: asha.id })
      .expect(200);
    expect(again.body).toMatchObject({ id: chatId, title: 'Asha Rao' });
    await request(app)
      .post('/api/v1/chat/conversations/direct')
      .set(bearer(asha.token))
      .send({ userId: asha.id })
      .expect(400);
    await request(app)
      .post('/api/v1/chat/conversations/direct')
      .set(bearer(asha.token))
      .send({ userId: inactiveId })
      .expect(400);
  });

  it('sends messages once, counts them unread for the other and marks them read', async () => {
    const clientId = randomUUID();
    const first = await send(asha, chatId, '  Hello Ravi  ', { clientId }).expect(201);
    expect(first.body).toMatchObject({ text: 'Hello Ravi', sender: { name: 'Asha Rao' } });
    // The same send again (a retry) posts nothing new.
    const retry = await send(asha, chatId, 'Hello Ravi', { clientId }).expect(201);
    expect(retry.body.id).toBe(first.body.id);
    await send(asha, chatId, '   ').expect(400);

    expect((await conversations(ravi)).unreadTotal).toBe(1);
    expect((await conversations(asha)).unreadTotal).toBe(0);
    const page = await request(app)
      .get(`/api/v1/chat/conversations/${chatId}/messages`)
      .set(bearer(ravi.token))
      .expect(200);
    expect((page.body.items as { text: string }[]).map((item) => item.text)).toEqual([
      'Hello Ravi',
    ]);
    await request(app)
      .post(`/api/v1/chat/conversations/${chatId}/read`)
      .set(bearer(ravi.token))
      .expect(204);
    expect((await conversations(ravi)).unreadTotal).toBe(0);
  });

  it('pages older messages', async () => {
    for (const text of ['one', 'two', 'three']) await send(ravi, chatId, text).expect(201);
    const latest = await request(app)
      .get(`/api/v1/chat/conversations/${chatId}/messages?limit=2`)
      .set(bearer(asha.token))
      .expect(200);
    expect(latest.body.hasMore).toBe(true);
    expect((latest.body.items as { text: string }[]).map((item) => item.text)).toEqual([
      'two',
      'three',
    ]);
    const older = await request(app)
      .get(
        `/api/v1/chat/conversations/${chatId}/messages?limit=2&before=${latest.body.items[0].id as string}`,
      )
      .set(bearer(asha.token))
      .expect(200);
    expect((older.body.items as { text: string }[]).map((item) => item.text)).toEqual([
      'Hello Ravi',
      'one',
    ]);
    expect(older.body.hasMore).toBe(false);
  });

  it('keeps a conversation from everyone but its members', async () => {
    await request(app)
      .get(`/api/v1/chat/conversations/${chatId}/messages`)
      .set(bearer(meena.token))
      .expect(404);
    await send(meena, chatId, 'Let me in').expect(404);
    expect((await conversations(meena)).items.map((item) => item.id)).not.toContain(chatId);
  });

  it('lets only the sender delete a message, for everyone', async () => {
    const message = await send(asha, chatId, 'Wrong chat').expect(201);
    const path = `/api/v1/chat/conversations/${chatId}/messages/${message.body.id as string}`;
    await request(app).delete(path).set(bearer(ravi.token)).expect(403);
    const deleted = await request(app).delete(path).set(bearer(asha.token)).expect(200);
    expect(deleted.body).toMatchObject({ deleted: true, text: '' });
  });
});

describe('groups', () => {
  let groupId: string;

  it('creates a group with its creator as admin, audited', async () => {
    const created = await request(app)
      .post('/api/v1/chat/conversations/groups')
      .set(bearer(asha.token))
      .send({ name: 'Renewals team', memberIds: [ravi.id, meena.id] })
      .expect(201);
    groupId = created.body.id as string;
    expect(created.body).toMatchObject({ kind: 'GROUP', title: 'Renewals team', admin: true });
    expect(created.body.members).toHaveLength(3);
    expect(created.body.lastMessage.text).toBe('Asha Rao created the group “Renewals team”');
    const audit = await AuditLogModel.findOne({ action: 'CHAT_GROUP_CREATED', entityId: groupId });
    expect(audit?.after).toMatchObject({ name: 'Renewals team' });
    await request(app)
      .post('/api/v1/chat/conversations/groups')
      .set(bearer(asha.token))
      .send({ name: 'Ghosts', memberIds: [inactiveId] })
      .expect(400);
  });

  it('lets only admins rename it and choose its members', async () => {
    await request(app)
      .put(`/api/v1/chat/conversations/${groupId}/name`)
      .set(bearer(meena.token))
      .send({ name: 'Mine now' })
      .expect(403);
    const renamed = await request(app)
      .put(`/api/v1/chat/conversations/${groupId}/name`)
      .set(bearer(asha.token))
      .send({ name: 'Renewals 2026' })
      .expect(200);
    expect(renamed.body.title).toBe('Renewals 2026');
    const removed = await request(app)
      .delete(`/api/v1/chat/conversations/${groupId}/members/${meena.id}`)
      .set(bearer(asha.token))
      .expect(200);
    expect(removed.body.members).toHaveLength(2);
    await request(app)
      .get(`/api/v1/chat/conversations/${groupId}`)
      .set(bearer(meena.token))
      .expect(404);
    const added = await request(app)
      .post(`/api/v1/chat/conversations/${groupId}/members`)
      .set(bearer(asha.token))
      .send({ userIds: [meena.id] })
      .expect(200);
    expect(added.body.members).toHaveLength(3);
  });

  it('shares files with the members only', async () => {
    const upload = await request(app)
      .post(`/api/v1/chat/conversations/${groupId}/files?fileName=quote.pdf`)
      .set(bearer(asha.token))
      .set('Content-Type', 'application/pdf')
      .send(PDF)
      .expect(201);
    const message = await send(asha, groupId, '', { attachmentId: upload.body.id }).expect(201);
    expect(message.body.attachment).toMatchObject({ fileName: 'quote.pdf', size: PDF.length });
    const file = await request(app)
      .get(`/api/v1/chat/conversations/${groupId}/files/${upload.body.id as string}`)
      .set(bearer(ravi.token))
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(Buffer.compare(file.body as Buffer, PDF)).toBe(0);
    const list = await conversations(ravi);
    expect(list.items.find((item) => item.id === groupId)).toBeDefined();
    await request(app)
      .post(`/api/v1/chat/conversations/${groupId}/files?fileName=run.exe`)
      .set(bearer(asha.token))
      .set('Content-Type', 'application/x-msdownload')
      .send(Buffer.from('MZ'))
      .expect(415);
  });

  it('lets a member leave, and makes another admin when the last one leaves', async () => {
    await request(app)
      .delete(`/api/v1/chat/conversations/${groupId}/members/${asha.id}`)
      .set(bearer(asha.token))
      .expect(204);
    const group = await request(app)
      .get(`/api/v1/chat/conversations/${groupId}`)
      .set(bearer(ravi.token))
      .expect(200);
    expect(group.body.members).toHaveLength(2);
    expect(group.body.admin).toBe(true);
    await request(app)
      .delete(`/api/v1/chat/conversations/${groupId}/members/${ravi.id}`)
      .set(bearer(meena.token))
      .expect(403);
  });
});

describe('live delivery', () => {
  let server: Server;
  beforeAll(async () => {
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('delivers a message to the other member’s open connection as it is sent', async () => {
    const { port } = server.address() as AddressInfo;
    const abort = new AbortController();
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/chat/events`, {
      headers: bearer(ravi.token),
      signal: abort.signal,
    });
    expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    await expect.poll(() => hub.connections(ravi.id)).toBe(1);

    const opened = await request(app)
      .post('/api/v1/chat/conversations/direct')
      .set(bearer(asha.token))
      .send({ userId: ravi.id })
      .expect(200);
    await send(asha, opened.body.id as string, 'Are you there?').expect(201);

    let received = '';
    while (!received.includes('Are you there?')) {
      const { value, done } = await reader.read();
      if (done) break;
      received += decoder.decode(value);
    }
    expect(received).toContain('event: message');
    const data = /data: (.*Are you there\?.*)\n/.exec(received)?.[1];
    expect(JSON.parse(data ?? '{}')).toMatchObject({
      type: 'message',
      conversationId: opened.body.id,
      message: { text: 'Are you there?', sender: { name: 'Asha Rao' } },
    });
    // Pings keep the connection open.
    while (!received.includes(': ping')) {
      const { value, done } = await reader.read();
      if (done) break;
      received += decoder.decode(value);
    }
    abort.abort();
    await expect.poll(() => hub.connections(ravi.id)).toBe(0);
  });

  it('needs a signed-in user', async () => {
    await request(app).get('/api/v1/chat/events').expect(401);
  });
});
