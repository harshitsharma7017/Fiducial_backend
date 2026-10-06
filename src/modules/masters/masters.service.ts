import {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  ERROR_CODES,
  formatDate,
  type MasterType,
  type MasterVersion,
  type MasterVersionListQuery,
  type MasterVersionListResponse,
  type Occupancy,
  type OccupancyListResponse,
  type OccupancySearchQuery,
  type PincodeRecord,
} from '../../shared/index.ts';
import { Types, type QueryFilter, type mongo } from 'mongoose';
import { withTransaction } from '../../lib/db.ts';
import { conflict, notFound, validationError } from '../../lib/errors.ts';
import { escapeRegExp } from '../../lib/text.ts';
import { writeAudit } from '../audit/audit.service.ts';
import { MasterVersionModel, type MasterVersionDoc } from './master-version.model.ts';
import { toMasterVersionDto, toOccupancyDto, toPincodeDto } from './masters.mapper.ts';
import { OccupancyModel, type OccupancyDoc } from './occupancy.model.ts';
import { PincodeModel } from './pincode.model.ts';

const MASTER_LABELS: Record<MasterType, string> = { OCCUPANCY: 'occupancy', PINCODE: 'pincode' };

/** Allowed clock difference when an effective date-time is checked against "now". */
const CLOCK_SKEW_MS = 60_000;

/** The ACTIVE version of a master type. Every lookup reads from it. */
export async function getActiveVersion(type: MasterType): Promise<MasterVersionDoc> {
  const version = await MasterVersionModel.findOne(
    { type, status: 'ACTIVE' },
    { report: 0 },
  ).lean();
  if (!version) {
    throw conflict(
      ERROR_CODES.MASTER_NOT_ACTIVE,
      `No ${MASTER_LABELS[type]} master is active. An admin uploads the IIB workbook on the Import data page and activates it.`,
      { type },
    );
  }
  return version;
}

/** Search by TAC code prefix or by text in the description (case-insensitive). */
export async function searchOccupancies(
  query: OccupancySearchQuery,
): Promise<OccupancyListResponse> {
  const version = await getActiveVersion('OCCUPANCY');
  const filter: QueryFilter<OccupancyDoc> = { versionId: version._id };
  if (query.q) {
    // User text is escaped, so it is matched literally and cannot form a costly pattern.
    const pattern = escapeRegExp(query.q);
    filter.$or = [
      { tacCode: { $regex: `^${pattern}`, $options: 'i' } },
      { description: { $regex: pattern, $options: 'i' } },
    ];
  }
  if (query.cursor) filter._id = { $gt: new Types.ObjectId(query.cursor) };

  const docs = await OccupancyModel.find(filter)
    .sort({ _id: 1 })
    .limit(query.limit + 1)
    .lean();
  const page = docs.slice(0, query.limit);
  const last = page.at(-1);
  return {
    items: page.map(toOccupancyDto),
    nextCursor: docs.length > query.limit && last ? last._id.toHexString() : null,
  };
}

export async function getOccupancy(tacCode: string): Promise<Occupancy> {
  const version = await getActiveVersion('OCCUPANCY');
  const doc = await OccupancyModel.findOne({ versionId: version._id, tacCode }).lean();
  if (!doc) {
    throw notFound(
      `Occupancy code ${tacCode} is not in the active master`,
      ERROR_CODES.OCCUPANCY_NOT_FOUND,
    );
  }
  return toOccupancyDto(doc);
}

export async function getPincode(pincode: string): Promise<PincodeRecord> {
  const version = await getActiveVersion('PINCODE');
  const doc = await PincodeModel.findOne({ versionId: version._id, pincode }).lean();
  if (!doc) {
    throw notFound(`Pincode ${pincode} is not in the active master`, ERROR_CODES.PINCODE_NOT_FOUND);
  }
  return toPincodeDto(doc);
}

/** Newest first. */
export async function listVersions(
  query: MasterVersionListQuery,
): Promise<MasterVersionListResponse> {
  const filter: QueryFilter<MasterVersionDoc> = {};
  if (query.type) filter.type = query.type;
  if (query.status) filter.status = query.status;
  if (query.cursor) filter._id = { $lt: new Types.ObjectId(query.cursor) };

  const docs = await MasterVersionModel.find(filter, { report: 0 })
    .sort({ _id: -1 })
    .limit(query.limit + 1)
    .lean();
  const page = docs.slice(0, query.limit);
  const last = page.at(-1);
  return {
    items: page.map(toMasterVersionDto),
    nextCursor: docs.length > query.limit && last ? last._id.toHexString() : null,
  };
}

/** A date (YYYY-MM-DD) means midnight in India; a date-time is used as given. */
export function parseEffectiveFrom(value: string | undefined, now: Date = new Date()): Date {
  if (value === undefined) return now;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T00:00:00+05:30`)
    : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw validationError([{ location: 'body', path: 'effectiveFrom', message: 'Invalid date' }]);
  }
  if (date.getTime() > now.getTime() + CLOCK_SKEW_MS) {
    throw validationError([
      {
        location: 'body',
        path: 'effectiveFrom',
        message:
          'The effective date cannot be in the future; scheduled activation is not supported',
      },
    ]);
  }
  return date;
}

export interface ActivationOptions {
  effectiveFrom?: string;
  actorId: string | null;
  requestId: string | null;
}

/**
 * Activates a DRAFT version. In one transaction the current ACTIVE version of the same type
 * becomes SUPERSEDED (effectiveTo = the new effectiveFrom), the draft becomes ACTIVE, and the
 * change is audited. Data rows are never modified, so earlier versions stay reproducible.
 */
export async function activateMasterVersion(
  versionId: string,
  options: ActivationOptions,
): Promise<MasterVersion> {
  const [version] = await activateMasterVersions([versionId], options);
  if (!version) throw notFound('Master version not found');
  return version;
}

/** Activates several DRAFT versions (for example the occupancy and pincode masters) together. */
export async function activateMasterVersions(
  versionIds: string[],
  options: ActivationOptions,
): Promise<MasterVersion[]> {
  const now = new Date();
  const effectiveFrom = parseEffectiveFrom(options.effectiveFrom, now);
  return withTransaction(async (session) => {
    const activated: MasterVersion[] = [];
    for (const versionId of versionIds) {
      activated.push(await activateInSession(versionId, effectiveFrom, now, options, session));
    }
    return activated;
  });
}

async function activateInSession(
  versionId: string,
  effectiveFrom: Date,
  now: Date,
  options: ActivationOptions,
  session: mongo.ClientSession,
): Promise<MasterVersion> {
  const target = await MasterVersionModel.findById(versionId, { report: 0 })
    .session(session)
    .lean();
  if (!target) throw notFound('Master version not found');
  if (target.status !== 'DRAFT') {
    throw conflict(
      ERROR_CODES.MASTER_VERSION_NOT_DRAFT,
      `Only DRAFT versions can be activated; this version is ${target.status}`,
    );
  }

  const current = await MasterVersionModel.findOne(
    { type: target.type, status: 'ACTIVE' },
    { report: 0 },
  )
    .session(session)
    .lean();
  if (current?.effectiveFrom && effectiveFrom < current.effectiveFrom) {
    throw conflict(
      ERROR_CODES.CONFLICT,
      `The effective date must be on or after ${formatDate(current.effectiveFrom)}, when the current version took effect`,
    );
  }

  if (current) {
    await MasterVersionModel.updateOne(
      { _id: current._id, status: 'ACTIVE' },
      { $set: { status: 'SUPERSEDED', effectiveTo: effectiveFrom } },
      { session },
    );
    // The superseded version changes too, so it gets its own entry with old and new values.
    await writeAudit(
      {
        userId: options.actorId,
        action: AUDIT_ACTIONS.MASTER_SUPERSEDED,
        entity: AUDIT_ENTITIES.MASTER_VERSION,
        entityId: current._id.toHexString(),
        before: {
          type: current.type,
          status: current.status,
          effectiveTo: current.effectiveTo?.toISOString() ?? null,
          supersededBy: null,
        },
        after: {
          type: current.type,
          status: 'SUPERSEDED',
          effectiveTo: effectiveFrom.toISOString(),
          supersededBy: target._id.toHexString(),
        },
        requestId: options.requestId,
      },
      session,
    );
  }

  const activated = await MasterVersionModel.findOneAndUpdate(
    { _id: target._id, status: 'DRAFT' },
    {
      $set: {
        status: 'ACTIVE',
        effectiveFrom,
        activatedAt: now,
        activatedBy: options.actorId ? new Types.ObjectId(options.actorId) : null,
      },
    },
    { returnDocument: 'after', session, projection: { report: 0 } },
  ).lean();
  if (!activated) {
    throw conflict(ERROR_CODES.MASTER_VERSION_NOT_DRAFT, 'The version changed while activating');
  }

  await writeAudit(
    {
      userId: options.actorId,
      action: AUDIT_ACTIONS.MASTER_ACTIVATED,
      entity: AUDIT_ENTITIES.MASTER_VERSION,
      entityId: activated._id.toHexString(),
      // The same fields on both sides, so the log shows each one's old and new value.
      before: {
        type: target.type,
        status: target.status,
        effectiveFrom: target.effectiveFrom?.toISOString() ?? null,
        supersededVersionId: null,
      },
      after: {
        type: activated.type,
        status: activated.status,
        effectiveFrom: effectiveFrom.toISOString(),
        supersededVersionId: current?._id.toHexString() ?? null,
      },
      requestId: options.requestId,
    },
    session,
  );

  return toMasterVersionDto(activated);
}
