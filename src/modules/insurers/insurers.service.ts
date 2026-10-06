import {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  ERROR_CODES,
  type CreateInsurerRequest,
  type Insurer,
  type InsurerListQuery,
  type Paginated,
  type UpdateInsurerRequest,
} from '../../shared/index.ts';
import { Types, mongo, type QueryFilter } from 'mongoose';
import { withTransaction } from '../../lib/db.ts';
import { conflict, notFound, validationError, type AppError } from '../../lib/errors.ts';
import { escapeRegExp, sortKey } from '../../lib/text.ts';
import { writeAudit } from '../audit/audit.service.ts';
import type { Actor } from '../clients/clients.service.ts';
import { InsurerModel, type InsurerDoc } from './insurer.model.ts';
import { toInsurerAuditView, toInsurerDto } from './insurers.mapper.ts';

function insurerNotFound(): AppError {
  return notFound('Insurer not found');
}

function insurerExists(company: string, branch: string): AppError {
  return conflict(ERROR_CODES.INSURER_EXISTS, `${company}, ${branch} is already in the master`);
}

function isDuplicateKey(error: unknown): boolean {
  return error instanceof mongo.MongoServerError && error.code === 11000;
}

/**
 * Insurers by company then branch. The cursor is the last insurer's id; company and branch are
 * unique together, so the page continues strictly after them.
 */
export async function listInsurers(query: InsurerListQuery): Promise<Paginated<Insurer>> {
  const conditions: QueryFilter<InsurerDoc>[] = [];
  if (query.active !== undefined) conditions.push({ active: query.active });
  if (query.q) {
    const pattern = escapeRegExp(query.q);
    conditions.push({
      $or: [
        { company: { $regex: pattern, $options: 'i' } },
        { branch: { $regex: pattern, $options: 'i' } },
      ],
    });
  }
  if (query.cursor) {
    const last = await InsurerModel.findById(query.cursor, { companyKey: 1, branchKey: 1 }).lean();
    if (!last) {
      throw validationError([
        { location: 'query', path: 'cursor', message: 'This cursor is not from the insurer list' },
      ]);
    }
    conditions.push({
      $or: [
        { companyKey: { $gt: last.companyKey } },
        { companyKey: last.companyKey, branchKey: { $gt: last.branchKey } },
      ],
    });
  }

  const docs = await InsurerModel.find(conditions.length > 0 ? { $and: conditions } : {})
    .sort({ companyKey: 1, branchKey: 1 })
    .limit(query.limit + 1)
    .lean();
  const page = docs.slice(0, query.limit);
  const last = page.at(-1);
  return {
    items: page.map(toInsurerDto),
    nextCursor: docs.length > query.limit && last ? last._id.toHexString() : null,
  };
}

export async function getInsurer(id: string): Promise<Insurer> {
  const doc = await InsurerModel.findById(id).lean();
  if (!doc) throw insurerNotFound();
  return toInsurerDto(doc);
}

/** A new insurer record, as both the screen and the import save it. */
export function newInsurerFields(
  input: CreateInsurerRequest,
  actorId: string,
): Omit<InsurerDoc, '_id' | 'createdAt' | 'updatedAt'> {
  const userId = new Types.ObjectId(actorId);
  return {
    company: input.company,
    branch: input.branch,
    companyKey: sortKey(input.company),
    branchKey: sortKey(input.branch),
    contacts: input.contacts,
    rfqEmails: input.rfqEmails,
    active: true,
    createdBy: userId,
    updatedBy: userId,
  };
}

export async function createInsurer(input: CreateInsurerRequest, actor: Actor): Promise<Insurer> {
  const fields = newInsurerFields(input, actor.id);
  try {
    return await withTransaction(async (session) => {
      const { companyKey, branchKey } = fields;
      if (await InsurerModel.exists({ companyKey, branchKey }).session(session)) {
        throw insurerExists(input.company, input.branch);
      }
      const [doc] = await InsurerModel.create([fields], { session });
      if (!doc) throw new Error('Insurer was not created');
      const insurer = toInsurerDto(doc.toObject());
      await writeAudit(
        {
          userId: actor.id,
          action: AUDIT_ACTIONS.INSURER_CREATED,
          entity: AUDIT_ENTITIES.INSURER,
          entityId: insurer.id,
          before: null,
          after: toInsurerAuditView(insurer),
          requestId: actor.requestId,
        },
        session,
      );
      return insurer;
    });
  } catch (error) {
    if (isDuplicateKey(error)) throw insurerExists(input.company, input.branch);
    throw error;
  }
}

export async function updateInsurer(
  id: string,
  changes: UpdateInsurerRequest,
  actor: Actor,
): Promise<Insurer> {
  try {
    return await withTransaction(async (session) => {
      const before = await InsurerModel.findById(id).session(session).lean();
      if (!before) throw insurerNotFound();

      const set: Partial<Omit<InsurerDoc, '_id' | 'createdAt' | 'updatedAt'>> = {
        updatedBy: new Types.ObjectId(actor.id),
      };
      if (changes.company !== undefined) {
        set.company = changes.company;
        set.companyKey = sortKey(changes.company);
      }
      if (changes.branch !== undefined) {
        set.branch = changes.branch;
        set.branchKey = sortKey(changes.branch);
      }
      if (set.companyKey !== undefined || set.branchKey !== undefined) {
        const companyKey = set.companyKey ?? before.companyKey;
        const branchKey = set.branchKey ?? before.branchKey;
        const clash = await InsurerModel.exists({
          companyKey,
          branchKey,
          _id: { $ne: before._id },
        }).session(session);
        if (clash) {
          throw insurerExists(set.company ?? before.company, set.branch ?? before.branch);
        }
      }
      if (changes.contacts !== undefined) set.contacts = changes.contacts;
      if (changes.rfqEmails !== undefined) set.rfqEmails = changes.rfqEmails;
      if (changes.active !== undefined) set.active = changes.active;

      const after = await InsurerModel.findByIdAndUpdate(
        id,
        { $set: set },
        { returnDocument: 'after', runValidators: true, session },
      ).lean();
      if (!after) throw insurerNotFound();

      const beforeDto = toInsurerDto(before);
      const afterDto = toInsurerDto(after);
      await writeAudit(
        {
          userId: actor.id,
          action: AUDIT_ACTIONS.INSURER_UPDATED,
          entity: AUDIT_ENTITIES.INSURER,
          entityId: id,
          before: toInsurerAuditView(beforeDto),
          after: toInsurerAuditView(afterDto),
          requestId: actor.requestId,
        },
        session,
      );
      return afterDto;
    });
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw conflict(
        ERROR_CODES.INSURER_EXISTS,
        'This company and branch are already in the master',
      );
    }
    throw error;
  }
}
