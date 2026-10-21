import {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  DEFAULT_AGE_BAND_SETS,
  ERROR_CODES,
  STANDARD_AGE_BANDS_NAME,
  type AgeBandSet,
  type AgeBandSetInput,
  type AuditAction,
} from '../../shared/index.ts';
import { Types, type mongo } from 'mongoose';
import { withTransaction } from '../../lib/db.ts';
import { conflict, notFound, validationError } from '../../lib/errors.ts';
import { writeAudit } from '../audit/audit.service.ts';
import { GhiCaseModel, type AgeBandSelectionDoc, type GhiCaseDoc } from '../ghi/ghi-case.model.ts';
import {
  assertWritable,
  auditCase,
  isLocked,
  loadCase,
  nameOf,
  userNames,
  type Actor,
} from '../ghi/ghi-common.ts';
import type { CaseScope } from '../ghi/products/profile.ts';
import { AgeBandSetModel, type AgeBandSetDoc } from './age-band-set.model.ts';

// The Age Band Master (N4) and a case's choice of age bands. Reading needs masters.view, every
// change masters.manage (routes). A case takes a copy of a set's bands at its current revision,
// so later edits change no case: the user chooses the set again to take a new revision, which
// makes any RFQ generated before out of date (N4.6). A case without a set uses the standard
// bands, exactly as the census summary did before N4.

const setNotFound = () => notFound('Age band set not found');
const keyOf = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

function view(doc: AgeBandSetDoc, names: ReadonlyMap<string, string>): AgeBandSet {
  return {
    id: doc._id.toHexString(),
    name: doc.name,
    description: doc.description,
    bands: doc.bands.map((band) => ({ label: band.label, min: band.min, max: band.max })),
    active: doc.active,
    revision: doc.revision,
    seeded: doc.seedKey !== null,
    updatedAt: doc.updatedAt.toISOString(),
    updatedBy: nameOf(names, doc.updatedBy),
  };
}

async function views(docs: readonly AgeBandSetDoc[]): Promise<AgeBandSet[]> {
  const names = await userNames(docs.map((doc) => doc.updatedBy));
  return docs.map((doc) => view(doc, names));
}

const auditOf = (
  doc: Pick<AgeBandSetDoc, 'name' | 'description' | 'bands' | 'active' | 'revision'>,
) => ({
  name: doc.name,
  description: doc.description,
  bands: doc.bands.map((band) => ({ label: band.label, min: band.min, max: band.max })),
  active: doc.active,
  revision: doc.revision,
});

async function audit(
  actor: Actor | null,
  action: AuditAction,
  id: Types.ObjectId,
  before: unknown,
  after: unknown,
  session: mongo.ClientSession,
): Promise<void> {
  await writeAudit(
    {
      userId: actor?.id ?? null,
      action,
      entity: AUDIT_ENTITIES.AGE_BAND_SET,
      entityId: id.toHexString(),
      before,
      after,
      requestId: actor?.requestId ?? null,
    },
    session,
  );
}

async function loadSet(id: string, session?: mongo.ClientSession): Promise<AgeBandSetDoc> {
  const doc = await AgeBandSetModel.findById(id)
    .session(session ?? null)
    .lean<AgeBandSetDoc>();
  if (!doc) throw setNotFound();
  return doc;
}

const nameTaken = (name: string) =>
  conflict(ERROR_CODES.AGE_BAND_SET_NAME_TAKEN, `An age band set named "${name}" already exists.`);

function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: number } | null)?.code === 11000;
}

export async function listAgeBandSets(query: {
  active?: boolean;
}): Promise<{ items: AgeBandSet[] }> {
  const docs = await AgeBandSetModel.find(
    query.active === undefined ? {} : { active: query.active },
  )
    .sort({ active: -1, nameKey: 1 })
    .lean<AgeBandSetDoc[]>();
  return { items: await views(docs) };
}

export async function getAgeBandSet(id: string): Promise<AgeBandSet> {
  return (await views([await loadSet(id)]))[0]!;
}

export async function createAgeBandSet(input: AgeBandSetInput, actor: Actor): Promise<AgeBandSet> {
  const actorId = new Types.ObjectId(actor.id);
  try {
    const id = await withTransaction(async (session) => {
      const [doc] = await AgeBandSetModel.create(
        [
          {
            name: input.name,
            nameKey: keyOf(input.name),
            description: input.description,
            bands: input.bands,
            active: true,
            revision: 1,
            seedKey: null,
            createdBy: actorId,
            updatedBy: actorId,
          },
        ],
        { session },
      );
      if (!doc) throw new Error('Age band set was not created');
      await audit(actor, AUDIT_ACTIONS.AGE_BAND_SET_CREATED, doc._id, null, auditOf(doc), session);
      return doc._id.toHexString();
    });
    return getAgeBandSet(id);
  } catch (error) {
    if (isDuplicateKey(error)) throw nameTaken(input.name);
    throw error;
  }
}

/** Edits a set in place: its revision rises; cases keep the copy they took (N4.8). */
export async function updateAgeBandSet(
  id: string,
  input: AgeBandSetInput,
  actor: Actor,
): Promise<AgeBandSet> {
  const before = await loadSet(id);
  const actorId = new Types.ObjectId(actor.id);
  try {
    await withTransaction(async (session) => {
      const after = await AgeBandSetModel.findOneAndUpdate(
        { _id: before._id, revision: before.revision },
        {
          $set: {
            name: input.name,
            nameKey: keyOf(input.name),
            description: input.description,
            bands: input.bands,
            updatedBy: actorId,
          },
          $inc: { revision: 1 },
        },
        { session, returnDocument: 'after' },
      ).lean<AgeBandSetDoc>();
      if (!after) {
        throw conflict(ERROR_CODES.CONFLICT, 'The set changed meanwhile. Reload it and try again.');
      }
      await audit(
        actor,
        AUDIT_ACTIONS.AGE_BAND_SET_UPDATED,
        before._id,
        auditOf(before),
        auditOf(after),
        session,
      );
    });
  } catch (error) {
    if (isDuplicateKey(error)) throw nameTaken(input.name);
    throw error;
  }
  return getAgeBandSet(id);
}

/** An inactive set cannot be chosen for a case; cases holding a copy keep it. */
export async function setAgeBandSetActive(
  id: string,
  active: boolean,
  actor: Actor,
): Promise<AgeBandSet> {
  const before = await loadSet(id);
  if (before.active === active) {
    throw conflict(
      ERROR_CODES.CONFLICT,
      `This age band set is already ${active ? 'active' : 'inactive'}.`,
    );
  }
  await withTransaction(async (session) => {
    const result = await AgeBandSetModel.updateOne(
      { _id: before._id, active: before.active },
      { $set: { active, updatedBy: new Types.ObjectId(actor.id) } },
      { session },
    );
    if (result.modifiedCount === 0) {
      throw conflict(ERROR_CODES.CONFLICT, 'The set changed meanwhile. Reload it and try again.');
    }
    await audit(
      actor,
      active ? AUDIT_ACTIONS.AGE_BAND_SET_ACTIVATED : AUDIT_ACTIONS.AGE_BAND_SET_DEACTIVATED,
      before._id,
      { active: before.active },
      { active },
      session,
    );
  });
  return getAgeBandSet(id);
}

/** Open cases whose copy came from the set, for the master's page. */
export async function casesUsingSet(id: string) {
  const set = await loadSet(id);
  const cases = await GhiCaseModel.find(
    { 'ageBandSelection.setId': set._id, stage: { $ne: 'CLOSED' } },
    { reference: 1, product: 1, stage: 1, 'ageBandSelection.revision': 1 },
  )
    .sort({ _id: -1 })
    .limit(200)
    .lean<GhiCaseDoc[]>();
  return {
    items: cases.map((doc) => ({
      id: doc._id.toHexString(),
      product: doc.product ?? ('GMC' as const),
      reference: doc.reference,
      stage: doc.stage,
      revision: doc.ageBandSelection?.revision ?? 0,
      outdated: (doc.ageBandSelection?.revision ?? 0) !== set.revision,
    })),
  };
}

/**
 * Creates each default set the master does not hold (by seed key), once. A set that exists is
 * never changed by a later start, whatever an Admin has edited.
 */
export async function ensureDefaultAgeBandSets(): Promise<{ created: string[] }> {
  const created: string[] = [];
  for (const item of DEFAULT_AGE_BAND_SETS) {
    if (await AgeBandSetModel.exists({ seedKey: item.seedKey })) continue;
    try {
      await withTransaction(async (session) => {
        const result = await AgeBandSetModel.updateOne(
          { seedKey: item.seedKey },
          {
            $setOnInsert: {
              name: item.name,
              nameKey: keyOf(item.name),
              description: item.description,
              bands: item.bands,
              active: true,
              revision: 1,
              seedKey: item.seedKey,
              createdBy: null,
              updatedBy: null,
            },
          },
          { upsert: true, session },
        );
        if (result.upsertedId) {
          await audit(
            null,
            AUDIT_ACTIONS.AGE_BAND_SET_CREATED,
            result.upsertedId,
            null,
            {
              name: item.name,
              bands: item.bands,
              active: true,
              revision: 1,
              seedKey: item.seedKey,
            },
            session,
          );
          created.push(item.name);
        }
      });
    } catch (error) {
      // Another instance created it, or an Admin already used the name: leave theirs as it is.
      if (!isDuplicateKey(error)) throw error;
    }
  }
  return { created };
}

/**
 * Gives a case a copy of a set's bands (its current revision), or the standard bands (null), while
 * the RFQ has not gone to an insurer (N4.7). The Data Sheet revision rises, so an RFQ generated
 * with other bands is out of date and is generated again; versions already generated keep theirs.
 */
export async function selectCaseAgeBands(
  scope: CaseScope,
  caseId: string,
  setId: string | null,
  actor: Actor,
): Promise<void> {
  const doc = await loadCase(caseId, undefined, scope);
  assertWritable(doc);
  if (isLocked(doc) || doc.policy) {
    throw conflict(
      ERROR_CODES.GHI_LOCKED,
      'The RFQ has gone to an insurer, so the age bands can no longer change.',
    );
  }
  let selection: AgeBandSelectionDoc | null = null;
  const actorId = new Types.ObjectId(actor.id);
  if (setId !== null) {
    const set = await AgeBandSetModel.findById(setId).lean<AgeBandSetDoc>();
    if (!set || !set.active) {
      const reason = set ? 'This age band set is inactive' : 'Age band set not found';
      throw validationError([{ location: 'body', path: 'setId', message: reason }], reason);
    }
    selection = {
      setId: set._id,
      name: set.name,
      revision: set.revision,
      bands: set.bands.map((band) => ({ label: band.label, min: band.min, max: band.max })),
      selectedAt: new Date(),
      selectedBy: actorId,
    };
  }
  const describe = (item: { name: string; revision: number } | null | undefined) =>
    item ? `${item.name} (revision ${item.revision})` : STANDARD_AGE_BANDS_NAME;
  await withTransaction(async (session) => {
    const result = await GhiCaseModel.updateOne(
      {
        _id: doc._id,
        requirementsRevision: doc.requirementsRevision,
        stage: { $ne: 'CLOSED' },
        insurers: { $not: { $elemMatch: { sentAt: { $ne: null } } } },
        placement: { $in: [null] },
        policy: null,
      },
      {
        $set: { ageBandSelection: selection, updatedBy: actorId },
        $inc: { requirementsRevision: 1 },
        $push: {
          activity: {
            at: new Date(),
            actorId,
            message: `Age bands: ${describe(selection)} (was ${describe(doc.ageBandSelection)})`,
          },
        },
      },
      { session },
    );
    if (result.modifiedCount === 0) {
      assertWritable(await loadCase(caseId, session, scope));
      throw conflict(ERROR_CODES.CONFLICT, 'The case changed meanwhile. Reload it and try again.');
    }
    const snapshot = (item: AgeBandSelectionDoc | null | undefined) =>
      item
        ? {
            setId: item.setId.toHexString(),
            name: item.name,
            revision: item.revision,
            bands: item.bands,
          }
        : { setId: null, name: STANDARD_AGE_BANDS_NAME };
    await auditCase(
      actor,
      AUDIT_ACTIONS.GHI_AGE_BANDS_SELECTED,
      caseId,
      snapshot(doc.ageBandSelection),
      snapshot(selection),
      session,
      scope,
    );
  });
}
