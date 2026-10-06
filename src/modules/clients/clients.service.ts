import {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  ERROR_CODES,
  type Client,
  type ClientListQuery,
  type ClientLocation,
  type ClientLocationListQuery,
  type CreateClientLocationRequest,
  type CreateClientRequest,
  type OccupancyRef,
  type Paginated,
  type PincodeRecord,
  type UpdateClientLocationRequest,
  type UpdateClientRequest,
} from '../../shared/index.ts';
import { Types, mongo, type QueryFilter } from 'mongoose';
import { withTransaction } from '../../lib/db.ts';
import { AppError, conflict, notFound, validationError } from '../../lib/errors.ts';
import { escapeRegExp, sortKey } from '../../lib/text.ts';
import { writeAudit } from '../audit/audit.service.ts';
import { getOccupancy, getPincode } from '../masters/masters.service.ts';
import { ClientLocationModel, type ClientLocationDoc } from './client-location.model.ts';
import { ClientModel, type ClientDoc } from './client.model.ts';
import {
  toClientAuditView,
  toClientDto,
  toClientLocationAuditView,
  toClientLocationDto,
} from './clients.mapper.ts';

export interface Actor {
  id: string;
  requestId: string | null;
}

function clientNotFound(): AppError {
  return notFound('Client not found');
}

function locationNotFound(): AppError {
  return notFound('Risk location not found');
}

function gstinTaken(gstin: string, other?: { id: string; name: string }): AppError {
  return conflict(
    ERROR_CODES.GSTIN_TAKEN,
    other
      ? `GSTIN ${gstin} already belongs to ${other.name}`
      : `GSTIN ${gstin} already belongs to another client`,
    other ? { clientId: other.id } : undefined,
  );
}

function isDuplicateKey(error: unknown): boolean {
  return error instanceof mongo.MongoServerError && error.code === 11000;
}

/** The occupancy from the active master, or a field error on `path` when the code is not in it. */
async function lookupOccupancy(tacCode: string, path: string): Promise<OccupancyRef> {
  try {
    const occupancy = await getOccupancy(tacCode);
    return { tacCode: occupancy.tacCode, description: occupancy.description };
  } catch (error) {
    if (error instanceof AppError && error.code === ERROR_CODES.OCCUPANCY_NOT_FOUND) {
      throw validationError([{ location: 'body', path, message: error.message }]);
    }
    throw error;
  }
}

/** The pincode from the active master, or a field error when it is not in it. */
async function lookupPincode(pincode: string): Promise<PincodeRecord> {
  try {
    return await getPincode(pincode);
  } catch (error) {
    if (error instanceof AppError && error.code === ERROR_CODES.PINCODE_NOT_FOUND) {
      throw validationError([{ location: 'body', path: 'pincode', message: error.message }]);
    }
    throw error;
  }
}

async function assertGstinFree(
  gstin: string,
  clientId: Types.ObjectId | null,
  session: mongo.ClientSession,
): Promise<void> {
  const filter: QueryFilter<ClientDoc> = { gstin };
  if (clientId) filter._id = { $ne: clientId };
  const other = await ClientModel.findOne(filter, { name: 1 }).session(session).lean();
  if (other) throw gstinTaken(gstin, { id: other._id.toHexString(), name: other.name });
}

async function countLocations(clientIds: readonly Types.ObjectId[]): Promise<Map<string, number>> {
  const counts = await ClientLocationModel.aggregate<{ _id: Types.ObjectId; count: number }>([
    { $match: { clientId: { $in: clientIds } } },
    { $group: { _id: '$clientId', count: { $sum: 1 } } },
  ]);
  return new Map(counts.map((row) => [row._id.toHexString(), row.count]));
}

/** Clients in name order. The cursor is the last client's id; the page continues after it. */
export async function listClients(query: ClientListQuery): Promise<Paginated<Client>> {
  const conditions: QueryFilter<ClientDoc>[] = [];
  if (query.q) {
    const byText: QueryFilter<ClientDoc>[] = [
      { name: { $regex: escapeRegExp(query.q), $options: 'i' } },
    ];
    const gstinPrefix = query.q.replace(/\s+/g, '').toUpperCase();
    if (/^[0-9A-Z]+$/.test(gstinPrefix)) byText.push({ gstin: { $regex: `^${gstinPrefix}` } });
    conditions.push({ $or: byText });
  }
  if (query.cursor) {
    const last = await ClientModel.findById(query.cursor, { nameKey: 1 }).lean();
    if (!last) {
      throw validationError([
        { location: 'query', path: 'cursor', message: 'This cursor is not from the client list' },
      ]);
    }
    conditions.push({
      $or: [{ nameKey: { $gt: last.nameKey } }, { nameKey: last.nameKey, _id: { $gt: last._id } }],
    });
  }

  const docs = await ClientModel.find(conditions.length > 0 ? { $and: conditions } : {})
    .sort({ nameKey: 1, _id: 1 })
    .limit(query.limit + 1)
    .lean();
  const page = docs.slice(0, query.limit);
  const counts = await countLocations(page.map((doc) => doc._id));
  const last = page.at(-1);
  return {
    items: page.map((doc) => toClientDto(doc, counts.get(doc._id.toHexString()) ?? 0)),
    nextCursor: docs.length > query.limit && last ? last._id.toHexString() : null,
  };
}

export async function getClient(id: string): Promise<Client> {
  const doc = await ClientModel.findById(id).lean();
  if (!doc) throw clientNotFound();
  const locationCount = await ClientLocationModel.countDocuments({ clientId: doc._id });
  return toClientDto(doc, locationCount);
}

/** A new client record, as both the screen and the import save it. */
export function newClientFields(
  input: CreateClientRequest,
  occupancy: OccupancyRef,
  actorId: string,
): Omit<ClientDoc, '_id' | 'createdAt' | 'updatedAt'> {
  const userId = new Types.ObjectId(actorId);
  return {
    name: input.name,
    nameKey: sortKey(input.name),
    gstin: input.gstin,
    address: input.address,
    contacts: input.contacts,
    natureOfBusiness: input.natureOfBusiness,
    occupancy,
    createdBy: userId,
    updatedBy: userId,
  };
}

export async function createClient(input: CreateClientRequest, actor: Actor): Promise<Client> {
  const occupancy = await lookupOccupancy(input.occupancyCode, 'occupancyCode');
  try {
    return await withTransaction(async (session) => {
      if (input.gstin) await assertGstinFree(input.gstin, null, session);
      const [doc] = await ClientModel.create([newClientFields(input, occupancy, actor.id)], {
        session,
      });
      if (!doc) throw new Error('Client was not created');
      const client = toClientDto(doc.toObject(), 0);
      await writeAudit(
        {
          userId: actor.id,
          action: AUDIT_ACTIONS.CLIENT_CREATED,
          entity: AUDIT_ENTITIES.CLIENT,
          entityId: client.id,
          before: null,
          after: toClientAuditView(client),
          requestId: actor.requestId,
        },
        session,
      );
      return client;
    });
  } catch (error) {
    // Two concurrent creates can both pass the check; the unique index decides.
    if (isDuplicateKey(error) && input.gstin) throw gstinTaken(input.gstin);
    throw error;
  }
}

export async function updateClient(
  id: string,
  changes: UpdateClientRequest,
  actor: Actor,
): Promise<Client> {
  const existing = await ClientModel.findById(id, { occupancy: 1 }).lean();
  if (!existing) throw clientNotFound();
  // A new code must be in the active master; an unchanged one keeps the description stored.
  const occupancy =
    changes.occupancyCode !== undefined && changes.occupancyCode !== existing.occupancy.tacCode
      ? await lookupOccupancy(changes.occupancyCode, 'occupancyCode')
      : undefined;

  try {
    return await withTransaction(async (session) => {
      const before = await ClientModel.findById(id).session(session).lean();
      if (!before) throw clientNotFound();

      const set: Partial<Omit<ClientDoc, '_id' | 'createdAt' | 'updatedAt'>> = {
        updatedBy: new Types.ObjectId(actor.id),
      };
      if (changes.name !== undefined) {
        set.name = changes.name;
        set.nameKey = sortKey(changes.name);
      }
      if (changes.gstin !== undefined) {
        if (changes.gstin && changes.gstin !== before.gstin) {
          await assertGstinFree(changes.gstin, before._id, session);
        }
        set.gstin = changes.gstin;
      }
      if (changes.address !== undefined) set.address = changes.address;
      if (changes.contacts !== undefined) set.contacts = changes.contacts;
      if (changes.natureOfBusiness !== undefined) set.natureOfBusiness = changes.natureOfBusiness;
      if (occupancy) set.occupancy = occupancy;

      const after = await ClientModel.findByIdAndUpdate(
        id,
        { $set: set },
        { returnDocument: 'after', runValidators: true, session },
      ).lean();
      if (!after) throw clientNotFound();
      const locationCount = await ClientLocationModel.countDocuments({
        clientId: after._id,
      }).session(session);

      const beforeDto = toClientDto(before, locationCount);
      const afterDto = toClientDto(after, locationCount);
      await writeAudit(
        {
          userId: actor.id,
          action: AUDIT_ACTIONS.CLIENT_UPDATED,
          entity: AUDIT_ENTITIES.CLIENT,
          entityId: id,
          before: toClientAuditView(beforeDto),
          after: toClientAuditView(afterDto),
          requestId: actor.requestId,
        },
        session,
      );
      return afterDto;
    });
  } catch (error) {
    if (isDuplicateKey(error) && changes.gstin) throw gstinTaken(changes.gstin);
    throw error;
  }
}

// Risk locations

/** A client's locations in the order they were added. */
export async function listClientLocations(
  clientId: string,
  query: ClientLocationListQuery,
): Promise<Paginated<ClientLocation>> {
  if (!(await ClientModel.exists({ _id: clientId }))) throw clientNotFound();
  const filter: QueryFilter<ClientLocationDoc> = { clientId: new Types.ObjectId(clientId) };
  if (query.cursor) filter._id = { $gt: new Types.ObjectId(query.cursor) };
  const docs = await ClientLocationModel.find(filter)
    .sort({ _id: 1 })
    .limit(query.limit + 1)
    .lean();
  const page = docs.slice(0, query.limit);
  const last = page.at(-1);
  return {
    items: page.map(toClientLocationDto),
    nextCursor: docs.length > query.limit && last ? last._id.toHexString() : null,
  };
}

/** What a pincode from the master gives a location: its state, district, EQ zone and version. */
export interface PincodeFacts {
  state: string;
  district: string;
  eqZone: ClientLocationDoc['eqZone'];
  versionId: string;
}

/** The address, district, EQ zone and master version that a pincode from the master gives. */
function pincodeFields(
  pincode: PincodeFacts,
): Pick<ClientLocationDoc, 'district' | 'eqZone' | 'pincodeVersionId'> & { state: string } {
  return {
    state: pincode.state,
    district: pincode.district,
    eqZone: pincode.eqZone,
    pincodeVersionId: new Types.ObjectId(pincode.versionId),
  };
}

/** A new risk location record, as both the screen and the import save it. */
export function newLocationFields(
  clientId: Types.ObjectId,
  input: CreateClientLocationRequest,
  pincode: PincodeFacts,
  occupancy: OccupancyRef | null,
  actorId: string,
): Omit<ClientLocationDoc, '_id' | 'createdAt' | 'updatedAt'> {
  const userId = new Types.ObjectId(actorId);
  const { state, ...fromPincode } = pincodeFields(pincode);
  return {
    clientId,
    name: input.name,
    address: {
      line1: input.line1,
      line2: input.line2,
      city: input.city,
      state,
      pincode: input.pincode,
    },
    ...fromPincode,
    occupancy,
    createdBy: userId,
    updatedBy: userId,
  };
}

export async function createClientLocation(
  clientId: string,
  input: CreateClientLocationRequest,
  actor: Actor,
): Promise<ClientLocation> {
  if (!(await ClientModel.exists({ _id: clientId }))) throw clientNotFound();
  const pincode = await lookupPincode(input.pincode);
  const occupancy = input.occupancyCode
    ? await lookupOccupancy(input.occupancyCode, 'occupancyCode')
    : null;

  return withTransaction(async (session) => {
    if (!(await ClientModel.exists({ _id: clientId }).session(session))) throw clientNotFound();
    const [doc] = await ClientLocationModel.create(
      [newLocationFields(new Types.ObjectId(clientId), input, pincode, occupancy, actor.id)],
      { session },
    );
    if (!doc) throw new Error('Risk location was not created');
    const location = toClientLocationDto(doc.toObject());
    await writeAudit(
      {
        userId: actor.id,
        action: AUDIT_ACTIONS.CLIENT_LOCATION_CREATED,
        entity: AUDIT_ENTITIES.CLIENT_LOCATION,
        entityId: location.id,
        before: null,
        after: toClientLocationAuditView(location),
        requestId: actor.requestId,
      },
      session,
    );
    return location;
  });
}

export async function updateClientLocation(
  clientId: string,
  locationId: string,
  changes: UpdateClientLocationRequest,
  actor: Actor,
): Promise<ClientLocation> {
  const filter = { _id: locationId, clientId };
  const existing = await ClientLocationModel.findOne(filter, {
    'address.pincode': 1,
    occupancy: 1,
  }).lean();
  if (!existing) throw locationNotFound();

  // A changed pincode is looked up again; an unchanged one keeps what the master gave before.
  const pincode =
    changes.pincode !== undefined && changes.pincode !== existing.address.pincode
      ? await lookupPincode(changes.pincode)
      : null;
  let occupancy: ClientLocationDoc['occupancy'] | undefined;
  if (changes.occupancyCode === null) occupancy = null;
  else if (
    changes.occupancyCode !== undefined &&
    changes.occupancyCode !== existing.occupancy?.tacCode
  ) {
    occupancy = await lookupOccupancy(changes.occupancyCode, 'occupancyCode');
  }

  return withTransaction(async (session) => {
    const before = await ClientLocationModel.findOne(filter).session(session).lean();
    if (!before) throw locationNotFound();

    const set: Record<string, unknown> = { updatedBy: new Types.ObjectId(actor.id) };
    if (changes.name !== undefined) set.name = changes.name;
    if (changes.line1 !== undefined) set['address.line1'] = changes.line1;
    if (changes.line2 !== undefined) set['address.line2'] = changes.line2;
    if (changes.city !== undefined) set['address.city'] = changes.city;
    if (pincode) {
      const { state, ...fromPincode } = pincodeFields(pincode);
      set['address.pincode'] = pincode.pincode;
      set['address.state'] = state;
      Object.assign(set, fromPincode);
    }
    if (occupancy !== undefined) set.occupancy = occupancy;

    const after = await ClientLocationModel.findOneAndUpdate(
      filter,
      { $set: set },
      { returnDocument: 'after', runValidators: true, session },
    ).lean();
    if (!after) throw locationNotFound();

    const beforeDto = toClientLocationDto(before);
    const afterDto = toClientLocationDto(after);
    await writeAudit(
      {
        userId: actor.id,
        action: AUDIT_ACTIONS.CLIENT_LOCATION_UPDATED,
        entity: AUDIT_ENTITIES.CLIENT_LOCATION,
        entityId: locationId,
        before: toClientLocationAuditView(beforeDto),
        after: toClientLocationAuditView(afterDto),
        requestId: actor.requestId,
      },
      session,
    );
    return afterDto;
  });
}
