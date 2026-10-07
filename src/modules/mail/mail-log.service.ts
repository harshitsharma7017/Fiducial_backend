import {
  MAX_ATTACHMENT_BYTES,
  type MailDetail,
  type MailListQuery,
  type MailListResponse,
  type MailSummary,
} from '../../shared/index.ts';
import { createHash } from 'node:crypto';
import { Types, mongo, type QueryFilter } from 'mongoose';
import { notFound } from '../../lib/errors.ts';
import { InsurerModel } from '../insurers/insurer.model.ts';
import { UserModel } from '../users/user.model.ts';
import { MailAttachmentModel } from './mail-attachment.model.ts';
import { MailLogModel, type MailLogDoc } from './mail-log.model.ts';

export interface StoredAttachment {
  id: Types.ObjectId;
  fileName: string;
  contentType: string;
  size: number;
  data: Buffer;
}

function isDuplicateKey(error: unknown): boolean {
  return error instanceof mongo.MongoServerError && error.code === 11000;
}

/** True when a file is small enough to attach. */
export function fitsAttachmentLimit(size: number): boolean {
  return size <= MAX_ATTACHMENT_BYTES;
}

/**
 * Keeps a file a mail carries. The same bytes under the same name are stored once, so every
 * mail of a send (and a repeated send) points at one file.
 */
export async function storeAttachment(file: {
  fileName: string;
  contentType: string;
  data: Buffer;
}): Promise<StoredAttachment> {
  const sha256 = createHash('sha256').update(file.data).digest('hex');
  const existing = await MailAttachmentModel.findOne(
    { sha256, fileName: file.fileName },
    { _id: 1 },
  ).lean();
  const stored = (id: Types.ObjectId): StoredAttachment => ({
    id,
    fileName: file.fileName,
    contentType: file.contentType,
    size: file.data.length,
    data: file.data,
  });
  if (existing) return stored(existing._id);
  try {
    const [doc] = await MailAttachmentModel.create([
      { sha256, ...file, size: file.data.length, createdAt: new Date() },
    ]);
    if (!doc) throw new Error('Attachment was not stored');
    return stored(doc._id);
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    const raced = await MailAttachmentModel.findOne(
      { sha256, fileName: file.fileName },
      { _id: 1 },
    ).lean();
    if (!raced) throw error;
    return stored(raced._id);
  }
}

interface MailLookups {
  insurers: Map<string, string>;
  users: Map<string, string>;
  attachments: Map<string, { fileName: string; size: number }>;
}

async function lookupsFor(docs: readonly MailLogDoc[]): Promise<MailLookups> {
  const ids = (values: Types.ObjectId[]) => [...new Set(values.map((id) => id.toHexString()))];
  const [insurers, users, attachments] = await Promise.all([
    InsurerModel.find(
      { _id: { $in: ids(docs.map((doc) => doc.insurerId)) } },
      { company: 1, branch: 1 },
    ).lean(),
    UserModel.find({ _id: { $in: ids(docs.map((doc) => doc.sentBy)) } }, { name: 1 }).lean(),
    MailAttachmentModel.find(
      {
        _id: {
          $in: ids(docs.flatMap((doc) => (doc.attachmentId ? [doc.attachmentId] : []))),
        },
      },
      { fileName: 1, size: 1 },
    ).lean(),
  ]);
  return {
    insurers: new Map(
      insurers.map((insurer) => [
        insurer._id.toHexString(),
        `${insurer.company}, ${insurer.branch}`,
      ]),
    ),
    users: new Map(users.map((user) => [user._id.toHexString(), user.name])),
    attachments: new Map(
      attachments.map((file) => [
        file._id.toHexString(),
        { fileName: file.fileName, size: file.size },
      ]),
    ),
  };
}

function toSummary(doc: MailLogDoc, lookups: MailLookups): MailSummary {
  return {
    id: doc._id.toHexString(),
    kind: doc.kind,
    insurerId: doc.insurerId.toHexString(),
    insurerName: lookups.insurers.get(doc.insurerId.toHexString()) ?? 'Unknown insurer',
    to: [...doc.to],
    subject: doc.subject,
    sentBy: lookups.users.get(doc.sentBy.toHexString()) ?? 'Unknown user',
    at: doc.at.toISOString(),
    transport: doc.transport,
    result: doc.result,
    error: doc.error,
    attachment: doc.attachmentId
      ? (lookups.attachments.get(doc.attachmentId.toHexString()) ?? null)
      : null,
  };
}

function toDetail(doc: MailLogDoc, lookups: MailLookups): MailDetail {
  return {
    ...toSummary(doc, lookups),
    from: doc.from,
    replyTo: doc.replyTo,
    text: doc.text,
    html: doc.html,
    templateVersion: doc.templateVersion,
    dueDate: doc.dueDate,
    messageId: doc.messageId,
  };
}

/** The case's mails, newest first. The cursor is the last mail's id. */
export async function listCaseMails(
  proposalId: string,
  query: MailListQuery,
): Promise<MailListResponse> {
  const filter: QueryFilter<MailLogDoc> = { proposalId: new Types.ObjectId(proposalId) };
  if (query.cursor) {
    const cursor = await MailLogModel.findOne(
      { _id: new Types.ObjectId(query.cursor), proposalId: filter.proposalId },
      { at: 1 },
    ).lean();
    if (!cursor) return { items: [], nextCursor: null };
    filter.$or = [{ at: { $lt: cursor.at } }, { at: cursor.at, _id: { $lt: cursor._id } }];
  }
  const docs = await MailLogModel.find(filter, { text: 0, html: 0 })
    .sort({ at: -1, _id: -1 })
    .limit(query.limit + 1)
    .lean<MailLogDoc[]>();
  const page = docs.slice(0, query.limit);
  const lookups = await lookupsFor(page);
  const last = page.at(-1);
  return {
    items: page.map((doc) => toSummary(doc, lookups)),
    nextCursor: docs.length > query.limit && last ? last._id.toHexString() : null,
  };
}

async function caseMailDoc(proposalId: string, mailId: string): Promise<MailLogDoc> {
  const doc = await MailLogModel.findOne({
    _id: new Types.ObjectId(mailId),
    proposalId: new Types.ObjectId(proposalId),
  }).lean();
  if (!doc) throw notFound('Mail not found');
  return doc;
}

/** One mail of a case with its bodies. */
export async function getCaseMail(proposalId: string, mailId: string): Promise<MailDetail> {
  const doc = await caseMailDoc(proposalId, mailId);
  return toDetail(doc, await lookupsFor([doc]));
}

/** The file a mail carried, exactly as sent. */
export async function caseMailAttachment(
  proposalId: string,
  mailId: string,
): Promise<{ fileName: string; contentType: string; data: Buffer }> {
  const doc = await caseMailDoc(proposalId, mailId);
  if (!doc.attachmentId) throw notFound('This mail had no attachment');
  const file = await MailAttachmentModel.findById(doc.attachmentId).lean();
  if (!file) throw notFound('This mail had no attachment');
  // Read without Mongoose documents, a stored file comes back as a BSON Binary.
  const raw: unknown = file.data;
  const data = Buffer.isBuffer(raw) ? raw : Buffer.from((raw as { buffer: Uint8Array }).buffer);
  return { fileName: file.fileName, contentType: file.contentType, data };
}

/** The mails a send already made (a repeated sendId), by insurer. */
export async function mailsOfSend(
  proposalId: Types.ObjectId,
  sendId: string,
  kind: MailLogDoc['kind'],
): Promise<Map<string, MailLogDoc>> {
  const docs = await MailLogModel.find({ proposalId, sendId, kind }, { text: 0, html: 0 }).lean<
    MailLogDoc[]
  >();
  return new Map(docs.map((doc) => [doc.insurerId.toHexString(), doc]));
}
