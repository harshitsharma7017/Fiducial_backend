import {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  ERROR_CODES,
  type AuditAction,
  type TpaFormat,
  type TpaFormatInput,
} from '../../shared/index.ts';
import { Types, type mongo } from 'mongoose';
import { withTransaction } from '../../lib/db.ts';
import { conflict, notFound } from '../../lib/errors.ts';
import { writeAudit } from '../audit/audit.service.ts';
import { nameOf, userNames, type Actor } from '../ghi/ghi-common.ts';
import { TpaClaimModel, TpaFormatModel, type TpaFormatDoc } from './tpa.model.ts';

// TPA formats (N9 1): how one TPA's export maps to claim fields. Administered with claims.tpa_manage.
// An edit raises the revision; an import keeps the format as it was when its file was checked.
// The TPA code is part of every claim's key, so it cannot change once claims use it.

const keyOf = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

export function formatView(doc: TpaFormatDoc, names: ReadonlyMap<string, string>): TpaFormat {
  return {
    id: doc._id.toHexString(),
    name: doc.name,
    tpaCode: doc.tpaCode,
    description: doc.description,
    sheetName: doc.sheetName,
    headerRow: doc.headerRow,
    mappings: doc.mappings.map((item) => ({
      field: item.field,
      header: item.header,
      required: item.required,
    })),
    statusMap: doc.statusMap.map((item) => ({ source: item.source, status: item.status })),
    requestTypeMap: doc.requestTypeMap.map((item) => ({
      source: item.source,
      requestType: item.requestType,
    })),
    claimTypeMap: doc.claimTypeMap.map((item) => ({
      source: item.source,
      claimType: item.claimType,
    })),
    relationshipMap: doc.relationshipMap.map((item) => ({
      source: item.source,
      relationship: item.relationship,
    })),
    keepColumns: [...doc.keepColumns],
    requireMemberMatch: doc.requireMemberMatch,
    boardStatusMap: (doc.boardStatusMap ?? []).map((item) => ({
      source: item.source,
      boardStatus: item.boardStatus,
    })),
    boardStatusOverrides: (doc.boardStatusOverrides ?? []).map((item) => ({
      clientId: item.clientId,
      source: item.source,
      boardStatus: item.boardStatus,
    })),
    boardUpdate: doc.boardUpdate ?? 'FORWARD_ONLY',
    createBoardClaims: doc.createBoardClaims ?? true,
    active: doc.active,
    revision: doc.revision,
    updatedAt: doc.updatedAt.toISOString(),
    updatedBy: nameOf(names, doc.updatedBy),
  };
}

const auditView = (
  doc: Pick<
    TpaFormatDoc,
    | 'name'
    | 'tpaCode'
    | 'sheetName'
    | 'headerRow'
    | 'mappings'
    | 'statusMap'
    | 'active'
    | 'revision'
  >,
) => ({
  name: doc.name,
  tpaCode: doc.tpaCode,
  sheetName: doc.sheetName,
  headerRow: doc.headerRow,
  mappings: doc.mappings,
  statusMap: doc.statusMap,
  active: doc.active,
  revision: doc.revision,
});

async function audit(
  actor: Actor,
  action: AuditAction,
  id: Types.ObjectId,
  before: unknown,
  after: unknown,
  session: mongo.ClientSession,
) {
  await writeAudit(
    {
      userId: actor.id,
      action,
      entity: AUDIT_ENTITIES.TPA_FORMAT,
      entityId: id.toHexString(),
      before,
      after,
      requestId: actor.requestId,
    },
    session,
  );
}

const duplicate = (error: unknown) => (error as { code?: number } | null)?.code === 11000;

export async function loadFormat(id: string): Promise<TpaFormatDoc> {
  const doc = await TpaFormatModel.findById(id).lean<TpaFormatDoc>();
  if (!doc) throw notFound('TPA format not found');
  return doc;
}

export async function listFormats(): Promise<{ items: TpaFormat[] }> {
  const docs = await TpaFormatModel.find().sort({ active: -1, nameKey: 1 }).lean<TpaFormatDoc[]>();
  const names = await userNames(docs.map((doc) => doc.updatedBy));
  return { items: docs.map((doc) => formatView(doc, names)) };
}

export async function getFormat(id: string): Promise<TpaFormat> {
  const doc = await loadFormat(id);
  return formatView(doc, await userNames([doc.updatedBy]));
}

export async function createFormat(input: TpaFormatInput, actor: Actor): Promise<TpaFormat> {
  const actorId = new Types.ObjectId(actor.id);
  try {
    const id = await withTransaction(async (session) => {
      const [doc] = await TpaFormatModel.create(
        [
          {
            ...input,
            nameKey: keyOf(input.name),
            active: true,
            revision: 1,
            createdBy: actorId,
            updatedBy: actorId,
          },
        ],
        { session },
      );
      if (!doc) throw new Error('Format was not saved');
      await audit(actor, AUDIT_ACTIONS.TPA_FORMAT_CREATED, doc._id, null, auditView(doc), session);
      return doc._id.toHexString();
    });
    return getFormat(id);
  } catch (error) {
    if (duplicate(error))
      throw conflict(ERROR_CODES.CONFLICT, `A TPA format named "${input.name}" already exists.`);
    throw error;
  }
}

export async function updateFormat(
  id: string,
  input: TpaFormatInput,
  actor: Actor,
): Promise<TpaFormat> {
  const before = await loadFormat(id);
  if (
    input.tpaCode !== before.tpaCode &&
    (await TpaClaimModel.exists({ tpaCode: before.tpaCode }))
  ) {
    throw conflict(
      ERROR_CODES.CONFLICT,
      `Claims are already imported under TPA code ${before.tpaCode}; the code cannot change. Create a new format for another TPA.`,
    );
  }
  try {
    await withTransaction(async (session) => {
      const after = await TpaFormatModel.findOneAndUpdate(
        { _id: before._id, revision: before.revision },
        {
          $set: { ...input, nameKey: keyOf(input.name), updatedBy: new Types.ObjectId(actor.id) },
          $inc: { revision: 1 },
        },
        { session, returnDocument: 'after' },
      ).lean<TpaFormatDoc>();
      if (!after)
        throw conflict(
          ERROR_CODES.CONFLICT,
          'The format changed meanwhile. Reload it and try again.',
        );
      await audit(
        actor,
        AUDIT_ACTIONS.TPA_FORMAT_UPDATED,
        before._id,
        auditView(before),
        auditView(after),
        session,
      );
    });
  } catch (error) {
    if (duplicate(error))
      throw conflict(ERROR_CODES.CONFLICT, `A TPA format named "${input.name}" already exists.`);
    throw error;
  }
  return getFormat(id);
}

export async function setFormatActive(
  id: string,
  active: boolean,
  actor: Actor,
): Promise<TpaFormat> {
  const before = await loadFormat(id);
  if (before.active === active)
    throw conflict(
      ERROR_CODES.CONFLICT,
      `This format is already ${active ? 'active' : 'inactive'}.`,
    );
  await withTransaction(async (session) => {
    await TpaFormatModel.updateOne(
      { _id: before._id },
      { $set: { active, updatedBy: new Types.ObjectId(actor.id) } },
      { session },
    );
    await audit(
      actor,
      AUDIT_ACTIONS.TPA_FORMAT_UPDATED,
      before._id,
      { active: before.active },
      { active },
      session,
    );
  });
  return getFormat(id);
}
