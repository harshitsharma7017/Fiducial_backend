import {
  AUDIT_ENTITIES,
  auditActionsOfKind,
  type AuditAction,
  type AuditActor,
  type AuditEntity,
  type AuditLogEntry,
  type AuditLogQuery,
  type MasterType,
  type Paginated,
} from '../../shared/index.ts';
import { Types, type QueryFilter, type mongo } from 'mongoose';
import { validationError } from '../../lib/errors.ts';
import { MasterVersionModel } from '../masters/master-version.model.ts';
import { UserModel } from '../users/user.model.ts';
import { recordKey, toAuditLogEntry, type AuditLookups } from './audit.mapper.ts';
import { AuditLogModel, type AuditLogDoc } from './audit.model.ts';

export interface AuditEntry {
  userId?: string | null;
  action: AuditAction;
  entity: AuditEntity;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  requestId?: string | null;
}

/**
 * Appends one audit entry. Pass the session when the audited change runs in a transaction,
 * so the change and its audit entry commit or roll back together.
 */
export async function writeAudit(entry: AuditEntry, session?: mongo.ClientSession): Promise<void> {
  await AuditLogModel.create(
    [
      {
        at: new Date(),
        userId: entry.userId ? new Types.ObjectId(entry.userId) : null,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId ?? null,
        before: entry.before ?? null,
        after: entry.after ?? null,
        requestId: entry.requestId ?? null,
      },
    ],
    { session },
  );
}

const OBJECT_ID = /^[a-f0-9]{24}$/i;
const MASTER_TYPE_NAMES: Record<MasterType, string> = {
  OCCUPANCY: 'Occupancy',
  PINCODE: 'Pincode',
};

/** Looks up who acted and a readable name for each record on one page, in two queries. */
async function loadLookups(docs: readonly AuditLogDoc[]): Promise<AuditLookups> {
  const userIds = new Set<string>();
  const versionIds = new Set<string>();
  for (const doc of docs) {
    if (doc.userId) userIds.add(doc.userId.toHexString());
    if (!doc.entityId || !OBJECT_ID.test(doc.entityId)) continue;
    if (doc.entity === AUDIT_ENTITIES.USER) userIds.add(doc.entityId);
    if (doc.entity === AUDIT_ENTITIES.MASTER_VERSION) versionIds.add(doc.entityId);
  }

  const [users, versions] = await Promise.all([
    UserModel.find({ _id: { $in: [...userIds] } }, { name: 1, email: 1 }).lean(),
    MasterVersionModel.find(
      { _id: { $in: [...versionIds] } },
      { type: 1, sourceFileName: 1 },
    ).lean(),
  ]);

  const actors = new Map<string, AuditActor>();
  const labels = new Map<string, string>();
  for (const user of users) {
    const id = user._id.toHexString();
    actors.set(id, { id, name: user.name, email: user.email });
    labels.set(recordKey(AUDIT_ENTITIES.USER, id), user.email);
  }
  for (const version of versions) {
    labels.set(
      recordKey(AUDIT_ENTITIES.MASTER_VERSION, version._id.toHexString()),
      `${MASTER_TYPE_NAMES[version.type]} master · ${version.sourceFileName}`,
    );
  }
  return { actors, labels };
}

/**
 * A page of the audit log, newest first. Filters come only from the parsed query: a kind (its
 * actions), a record (entity and entityId) and who acted (actorId). The cursor is the last
 * entry's id; the next page continues strictly after it in (at, _id) order.
 */
export async function listAuditLog(query: AuditLogQuery): Promise<Paginated<AuditLogEntry>> {
  const filter: QueryFilter<AuditLogDoc> = {};
  if (query.kind) filter.action = { $in: auditActionsOfKind(query.kind) };
  if (query.entity) filter.entity = query.entity;
  if (query.entityId) filter.entityId = query.entityId;
  if (query.actorId) filter.userId = new Types.ObjectId(query.actorId);
  if (query.cursor) {
    const last = await AuditLogModel.findById(query.cursor, { at: 1 }).lean();
    if (!last) {
      throw validationError([
        { location: 'query', path: 'cursor', message: 'This cursor is not from the audit log' },
      ]);
    }
    filter.$or = [{ at: { $lt: last.at } }, { at: last.at, _id: { $lt: last._id } }];
  }

  const docs = await AuditLogModel.find(filter)
    .sort({ at: -1, _id: -1 })
    .limit(query.limit + 1)
    .lean();
  const page = docs.slice(0, query.limit);
  const lookups = await loadLookups(page);
  const lastOnPage = page.at(-1);
  return {
    items: page.map((doc) => toAuditLogEntry(doc, lookups)),
    nextCursor: docs.length > query.limit && lastOnPage ? lastOnPage._id.toHexString() : null,
  };
}
