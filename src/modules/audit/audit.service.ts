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
import { ClientLocationModel } from '../clients/client-location.model.ts';
import { ClientModel } from '../clients/client.model.ts';
import { InsurerModel } from '../insurers/insurer.model.ts';
import { MasterVersionModel } from '../masters/master-version.model.ts';
import { OccupancyModel } from '../masters/occupancy.model.ts';
import { PincodeModel } from '../masters/pincode.model.ts';
import { ProposalModel } from '../proposals/proposal.model.ts';
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

function toAuditDoc(entry: AuditEntry, at: Date) {
  return {
    at,
    userId: entry.userId ? new Types.ObjectId(entry.userId) : null,
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
    requestId: entry.requestId ?? null,
  };
}

/**
 * Appends one audit entry. Pass the session when the audited change runs in a transaction,
 * so the change and its audit entry commit or roll back together.
 */
export async function writeAudit(entry: AuditEntry, session?: mongo.ClientSession): Promise<void> {
  await AuditLogModel.create([toAuditDoc(entry, new Date())], { session });
}

/** Appends many entries in one write (an import), in the transaction that made the changes. */
export async function writeAudits(
  entries: readonly AuditEntry[],
  session: mongo.ClientSession,
): Promise<void> {
  if (entries.length === 0) return;
  const at = new Date();
  await AuditLogModel.insertMany(
    entries.map((entry) => toAuditDoc(entry, at)),
    { session },
  );
}

const OBJECT_ID = /^[a-f0-9]{24}$/i;
const MASTER_TYPE_NAMES: Record<MasterType, string> = {
  OCCUPANCY: 'Occupancy',
  PINCODE: 'Pincode',
};

/** Looks up who acted and a readable name for each record on one page, a query per record type. */
async function loadLookups(docs: readonly AuditLogDoc[]): Promise<AuditLookups> {
  const userIds = new Set<string>();
  const versionIds = new Set<string>();
  const clientIds = new Set<string>();
  const locationIds = new Set<string>();
  const insurerIds = new Set<string>();
  const occupancyIds = new Set<string>();
  const pincodeIds = new Set<string>();
  const proposalIds = new Set<string>();
  for (const doc of docs) {
    if (doc.userId) userIds.add(doc.userId.toHexString());
    if (!doc.entityId || !OBJECT_ID.test(doc.entityId)) continue;
    if (doc.entity === AUDIT_ENTITIES.USER) userIds.add(doc.entityId);
    if (doc.entity === AUDIT_ENTITIES.MASTER_VERSION) versionIds.add(doc.entityId);
    if (doc.entity === AUDIT_ENTITIES.CLIENT) clientIds.add(doc.entityId);
    if (doc.entity === AUDIT_ENTITIES.CLIENT_LOCATION) locationIds.add(doc.entityId);
    if (doc.entity === AUDIT_ENTITIES.INSURER) insurerIds.add(doc.entityId);
    if (doc.entity === AUDIT_ENTITIES.OCCUPANCY) occupancyIds.add(doc.entityId);
    if (doc.entity === AUDIT_ENTITIES.PINCODE) pincodeIds.add(doc.entityId);
    if (doc.entity === AUDIT_ENTITIES.PROPOSAL) proposalIds.add(doc.entityId);
  }

  const [users, versions, locations, insurers, occupancies, pincodes, proposals] =
    await Promise.all([
      UserModel.find({ _id: { $in: [...userIds] } }, { name: 1, email: 1 }).lean(),
      MasterVersionModel.find(
        { _id: { $in: [...versionIds] } },
        { type: 1, sourceFileName: 1 },
      ).lean(),
      ClientLocationModel.find({ _id: { $in: [...locationIds] } }, { clientId: 1, name: 1 }).lean(),
      InsurerModel.find({ _id: { $in: [...insurerIds] } }, { company: 1, branch: 1 }).lean(),
      OccupancyModel.find(
        { _id: { $in: [...occupancyIds] } },
        { tacCode: 1, description: 1 },
      ).lean(),
      PincodeModel.find({ _id: { $in: [...pincodeIds] } }, { pincode: 1, district: 1 }).lean(),
      // Cases in the Deleted bin keep their names in the log.
      Promise.all(
        [null, { $ne: null }].map((deleted) =>
          ProposalModel.find(
            { _id: { $in: [...proposalIds] }, deleted },
            { reference: 1, clientId: 1 },
          ).lean(),
        ),
      ).then((found) => found.flat()),
    ]);
  // A location is labelled with its client's name, so those clients are read too.
  for (const location of locations) clientIds.add(location.clientId.toHexString());
  for (const proposal of proposals) clientIds.add(proposal.clientId.toHexString());
  const clients = await ClientModel.find({ _id: { $in: [...clientIds] } }, { name: 1 }).lean();
  const clientNames = new Map(clients.map((client) => [client._id.toHexString(), client.name]));

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
  for (const [id, name] of clientNames) labels.set(recordKey(AUDIT_ENTITIES.CLIENT, id), name);
  for (const location of locations) {
    const clientName = clientNames.get(location.clientId.toHexString());
    labels.set(
      recordKey(AUDIT_ENTITIES.CLIENT_LOCATION, location._id.toHexString()),
      clientName ? `${clientName} · ${location.name}` : location.name,
    );
  }
  for (const insurer of insurers) {
    labels.set(
      recordKey(AUDIT_ENTITIES.INSURER, insurer._id.toHexString()),
      `${insurer.company} · ${insurer.branch}`,
    );
  }
  for (const occupancy of occupancies) {
    labels.set(
      recordKey(AUDIT_ENTITIES.OCCUPANCY, occupancy._id.toHexString()),
      `${occupancy.tacCode} · ${occupancy.description}`,
    );
  }
  for (const proposal of proposals) {
    const clientName = clientNames.get(proposal.clientId.toHexString());
    labels.set(
      recordKey(AUDIT_ENTITIES.PROPOSAL, proposal._id.toHexString()),
      clientName ? `${proposal.reference} · ${clientName}` : proposal.reference,
    );
  }
  for (const pincode of pincodes) {
    labels.set(
      recordKey(AUDIT_ENTITIES.PINCODE, pincode._id.toHexString()),
      `${pincode.pincode} · ${pincode.district}`,
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
