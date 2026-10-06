import {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  ERROR_CODES,
  type CreateOccupancyRequest,
  type CreatePincodeRequest,
  type Occupancy,
  type PincodeListQuery,
  type PincodeListResponse,
  type PincodeRecord,
  type UpdateOccupancyRequest,
  type UpdatePincodeRequest,
} from '../../shared/index.ts';
import { mongo, type QueryFilter } from 'mongoose';
import { withTransaction } from '../../lib/db.ts';
import { toDecimal128 } from '../../lib/decimal.ts';
import { conflict, notFound, type AppError } from '../../lib/errors.ts';
import { escapeRegExp } from '../../lib/text.ts';
import { writeAudit } from '../audit/audit.service.ts';
import { toOccupancyDto, toPincodeDto } from './masters.mapper.ts';
import { getActiveVersion } from './masters.service.ts';
import { OccupancyModel, type OccupancyDoc } from './occupancy.model.ts';
import { PincodeModel, type PincodeDoc } from './pincode.model.ts';

// Corrections to the ACTIVE occupancy and pincode masters, made by an Admin on screen. The row
// changes in place; its audit entry keeps every field's old and new value, so the history of a
// rate stays readable. Bulk changes are uploaded as a new version instead.

export interface Actor {
  id: string;
  requestId: string | null;
}

const rate = (value: string | null) => (value === null ? null : toDecimal128(value));

function isDuplicateKey(error: unknown): boolean {
  return error instanceof mongo.MongoServerError && error.code === 11000;
}

function occupancyExists(tacCode: string): AppError {
  return conflict(
    ERROR_CODES.CONFLICT,
    `Occupancy code ${tacCode} is already in the active master. Edit it instead.`,
  );
}

function pincodeExists(pincode: string): AppError {
  return conflict(
    ERROR_CODES.CONFLICT,
    `Pincode ${pincode} is already in the active master. Edit it instead.`,
  );
}

/** The fields an occupancy edit sets. */
function occupancyFields(input: UpdateOccupancyRequest) {
  return {
    description: input.description,
    riskGrade: input.riskGrade,
    iibRate: rate(input.iibRate),
    iibRateNote: input.iibRateNote,
    fireRiskType: input.fireRiskType,
    terrorismRiskType: input.terrorismRiskType,
    minStfiRate: rate(input.minStfiRate),
    minEqRates: {
      zone1: rate(input.minEqRates.zone1),
      zone2: rate(input.minEqRates.zone2),
      zone3: rate(input.minEqRates.zone3),
      zone4: rate(input.minEqRates.zone4),
    },
  };
}

/** The fields recorded in audit snapshots for an occupancy. */
function occupancyAuditView(occupancy: Occupancy) {
  const { id: _id, serialNo: _serialNo, ...fields } = occupancy;
  return fields;
}

/** The next row number, so a new row sorts last when the master is downloaded. */
async function nextSourceRow(
  model: typeof OccupancyModel | typeof PincodeModel,
  versionId: OccupancyDoc['versionId'],
  session: mongo.ClientSession,
): Promise<number> {
  const last = await (model as typeof OccupancyModel)
    .findOne({ versionId }, { sourceRow: 1 })
    .sort({ sourceRow: -1 })
    .session(session)
    .lean();
  return (last?.sourceRow ?? 0) + 1;
}

export async function createOccupancy(
  input: CreateOccupancyRequest,
  actor: Actor,
): Promise<Occupancy> {
  const version = await getActiveVersion('OCCUPANCY');
  try {
    return await withTransaction(async (session) => {
      if (
        await OccupancyModel.exists({ versionId: version._id, tacCode: input.tacCode }).session(
          session,
        )
      ) {
        throw occupancyExists(input.tacCode);
      }
      const sourceRow = await nextSourceRow(OccupancyModel, version._id, session);
      const [doc] = await OccupancyModel.create(
        [
          {
            versionId: version._id,
            serialNo: null,
            tacCode: input.tacCode,
            ...occupancyFields(input),
            sourceRow,
          },
        ],
        { session },
      );
      if (!doc) throw new Error('Occupancy was not created');
      const occupancy = toOccupancyDto(doc.toObject());
      await writeAudit(
        {
          userId: actor.id,
          action: AUDIT_ACTIONS.OCCUPANCY_CREATED,
          entity: AUDIT_ENTITIES.OCCUPANCY,
          entityId: occupancy.id,
          before: null,
          after: occupancyAuditView(occupancy),
          requestId: actor.requestId,
        },
        session,
      );
      return occupancy;
    });
  } catch (error) {
    if (isDuplicateKey(error)) throw occupancyExists(input.tacCode);
    throw error;
  }
}

export async function updateOccupancy(
  tacCode: string,
  input: UpdateOccupancyRequest,
  actor: Actor,
): Promise<Occupancy> {
  const version = await getActiveVersion('OCCUPANCY');
  return withTransaction(async (session) => {
    const filter = { versionId: version._id, tacCode };
    const before = await OccupancyModel.findOne(filter).session(session).lean();
    if (!before) {
      throw notFound(
        `Occupancy code ${tacCode} is not in the active master`,
        ERROR_CODES.OCCUPANCY_NOT_FOUND,
      );
    }
    const after = await OccupancyModel.findOneAndUpdate(
      filter,
      { $set: occupancyFields(input) },
      { returnDocument: 'after', runValidators: true, session },
    ).lean();
    if (!after) throw new Error('Occupancy was not updated');
    const updated = toOccupancyDto(after);
    await writeAudit(
      {
        userId: actor.id,
        action: AUDIT_ACTIONS.OCCUPANCY_UPDATED,
        entity: AUDIT_ENTITIES.OCCUPANCY,
        entityId: updated.id,
        before: occupancyAuditView(toOccupancyDto(before)),
        after: occupancyAuditView(updated),
        requestId: actor.requestId,
      },
      session,
    );
    return updated;
  });
}

// Pincodes

/** Pincodes of the active master in pincode order; q is a pincode prefix or district/state text. */
export async function listPincodes(query: PincodeListQuery): Promise<PincodeListResponse> {
  const version = await getActiveVersion('PINCODE');
  const filter: QueryFilter<PincodeDoc> = { versionId: version._id };
  const conditions: QueryFilter<PincodeDoc>[] = [];
  if (query.q) {
    if (/^\d{1,6}$/.test(query.q)) {
      conditions.push({ pincode: { $regex: `^${query.q}` } });
    } else {
      const pattern = escapeRegExp(query.q);
      conditions.push({
        $or: [
          { district: { $regex: pattern, $options: 'i' } },
          { state: { $regex: pattern, $options: 'i' } },
        ],
      });
    }
  }
  if (query.cursor) conditions.push({ pincode: { $gt: query.cursor } });
  if (conditions.length > 0) filter.$and = conditions;

  const docs = await PincodeModel.find(filter)
    .sort({ pincode: 1 })
    .limit(query.limit + 1)
    .lean();
  const page = docs.slice(0, query.limit);
  const last = page.at(-1);
  return {
    items: page.map(toPincodeDto),
    nextCursor: docs.length > query.limit && last ? last.pincode : null,
  };
}

function pincodeFields(input: UpdatePincodeRequest) {
  return {
    state: input.state,
    district: input.district,
    eqZone: input.eqZone,
    eqRates: {
      residential: rate(input.eqRates.residential),
      nonIndustrial: rate(input.eqRates.nonIndustrial),
      industrial: rate(input.eqRates.industrial),
    },
  };
}

function pincodeAuditView(record: PincodeRecord) {
  const { id: _id, ...fields } = record;
  return fields;
}

export async function createPincode(
  input: CreatePincodeRequest,
  actor: Actor,
): Promise<PincodeRecord> {
  const version = await getActiveVersion('PINCODE');
  try {
    return await withTransaction(async (session) => {
      if (
        await PincodeModel.exists({ versionId: version._id, pincode: input.pincode }).session(
          session,
        )
      ) {
        throw pincodeExists(input.pincode);
      }
      const sourceRow = await nextSourceRow(PincodeModel, version._id, session);
      const [doc] = await PincodeModel.create(
        [{ versionId: version._id, pincode: input.pincode, ...pincodeFields(input), sourceRow }],
        { session },
      );
      if (!doc) throw new Error('Pincode was not created');
      const record = toPincodeDto(doc.toObject());
      await writeAudit(
        {
          userId: actor.id,
          action: AUDIT_ACTIONS.PINCODE_CREATED,
          entity: AUDIT_ENTITIES.PINCODE,
          entityId: record.id,
          before: null,
          after: pincodeAuditView(record),
          requestId: actor.requestId,
        },
        session,
      );
      return record;
    });
  } catch (error) {
    if (isDuplicateKey(error)) throw pincodeExists(input.pincode);
    throw error;
  }
}

export async function updatePincode(
  pincode: string,
  input: UpdatePincodeRequest,
  actor: Actor,
): Promise<PincodeRecord> {
  const version = await getActiveVersion('PINCODE');
  return withTransaction(async (session) => {
    const filter = { versionId: version._id, pincode };
    const before = await PincodeModel.findOne(filter).session(session).lean();
    if (!before) {
      throw notFound(
        `Pincode ${pincode} is not in the active master`,
        ERROR_CODES.PINCODE_NOT_FOUND,
      );
    }
    const after = await PincodeModel.findOneAndUpdate(
      filter,
      { $set: pincodeFields(input) },
      { returnDocument: 'after', runValidators: true, session },
    ).lean();
    if (!after) throw new Error('Pincode was not updated');
    const updated = toPincodeDto(after);
    await writeAudit(
      {
        userId: actor.id,
        action: AUDIT_ACTIONS.PINCODE_UPDATED,
        entity: AUDIT_ENTITIES.PINCODE,
        entityId: updated.id,
        before: pincodeAuditView(toPincodeDto(before)),
        after: pincodeAuditView(updated),
        requestId: actor.requestId,
      },
      session,
    );
    return updated;
  });
}
