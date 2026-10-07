import {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  ERROR_CODES,
  type AuditAction,
  type CreateProposalRequest,
  type DataSheetInput,
  type MarkRfqSentRequest,
  type Paginated,
  type ProposalListQuery,
  type ProposalRecord,
  type SetProposalInsurersRequest,
} from '../../shared/index.ts';
import { Types, type QueryFilter, type mongo } from 'mongoose';
import { withTransaction } from '../../lib/db.ts';
import { toDecimal128 } from '../../lib/decimal.ts';
import { conflict, notFound, validationError, type AppError } from '../../lib/errors.ts';
import { writeAudit } from '../audit/audit.service.ts';
import { ClientLocationModel } from '../clients/client-location.model.ts';
import { ClientModel } from '../clients/client.model.ts';
import { InsurerModel } from '../insurers/insurer.model.ts';
import { loadContext, toProposalAuditView, toProposalRecord } from './proposals.mapper.ts';
import { CounterModel, ProposalModel, type ProposalDoc } from './proposal.model.ts';

export interface Actor {
  id: string;
  requestId: string | null;
}

const money = (value: string | null) => (value === null ? null : toDecimal128(value));

function proposalNotFound(): AppError {
  return notFound('Proposal not found');
}

function locked(): AppError {
  return conflict(
    ERROR_CODES.PROPOSAL_LOCKED,
    'The RFQ has gone to an insurer, so the Data Sheet can no longer change.',
  );
}

async function recordOf(doc: ProposalDoc): Promise<ProposalRecord> {
  return toProposalRecord(doc, await loadContext([doc]));
}

/** The year in India, for references such as PRP-2026-0001. */
function istYear(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric' }).format(
    now,
  );
}

async function nextReference(session: mongo.ClientSession): Promise<string> {
  const year = istYear(new Date());
  const counter = await CounterModel.findOneAndUpdate(
    { _id: `proposal-${year}` },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after', session },
  ).lean();
  return `PRP-${year}-${String(counter?.seq ?? 1).padStart(4, '0')}`;
}

/** Every location must be one of the client's risk locations. */
async function assertClientLocations(
  clientId: Types.ObjectId,
  locationIds: readonly string[],
  path: string,
): Promise<void> {
  if (locationIds.length === 0) return;
  const found = await ClientLocationModel.countDocuments({
    _id: { $in: locationIds.map((id) => new Types.ObjectId(id)) },
    clientId,
  });
  if (found !== new Set(locationIds).size) {
    throw validationError([
      { location: 'body', path, message: "Choose risk locations from this client's locations" },
    ]);
  }
}

/** Saves the change, keeps the stored stage in step, and writes the audit entry. */
async function saveWith(
  doc: ProposalDoc,
  set: Partial<ProposalDoc>,
  activity: string | null,
  action: AuditAction,
  actor: Actor,
  before: ProposalRecord | null,
): Promise<ProposalRecord> {
  return withTransaction(async (session) => {
    const update: Record<string, unknown> = {
      $set: { ...set, updatedBy: new Types.ObjectId(actor.id) },
    };
    if (activity) {
      update.$push = {
        activity: { at: new Date(), actorId: new Types.ObjectId(actor.id), message: activity },
      };
    }
    const updated = await ProposalModel.findByIdAndUpdate(doc._id, update, {
      returnDocument: 'after',
      runValidators: true,
      session,
    }).lean();
    if (!updated) throw proposalNotFound();
    const record = await recordOf(updated);
    if (record.stage !== updated.stage) {
      await ProposalModel.updateOne(
        { _id: doc._id },
        { $set: { stage: record.stage } },
        { session },
      );
    }
    await writeAudit(
      {
        userId: actor.id,
        action,
        entity: AUDIT_ENTITIES.PROPOSAL,
        entityId: record.id,
        before: before ? toProposalAuditView(before) : null,
        after: toProposalAuditView(record),
        requestId: actor.requestId,
      },
      session,
    );
    return record;
  });
}

async function loadDoc(id: string): Promise<ProposalDoc> {
  const doc = await ProposalModel.findById(id).lean();
  if (!doc) throw proposalNotFound();
  return doc;
}

/** New proposals, newest first. The cursor is the last proposal's id. */
export async function listProposals(query: ProposalListQuery): Promise<Paginated<ProposalRecord>> {
  const filter: QueryFilter<ProposalDoc> = {};
  if (query.stage) filter.stage = query.stage;
  if (query.clientId) filter.clientId = new Types.ObjectId(query.clientId);
  if (query.cursor) filter._id = { $lt: new Types.ObjectId(query.cursor) };
  const docs = await ProposalModel.find(filter)
    .sort({ _id: -1 })
    .limit(query.limit + 1)
    .lean();
  const page = docs.slice(0, query.limit);
  const context = await loadContext(page);
  const last = page.at(-1);
  return {
    items: page.map((doc) => toProposalRecord(doc, context)),
    nextCursor: docs.length > query.limit && last ? last._id.toHexString() : null,
  };
}

export async function getProposal(id: string): Promise<ProposalRecord> {
  return recordOf(await loadDoc(id));
}

export async function createProposal(
  input: CreateProposalRequest,
  actor: Actor,
): Promise<ProposalRecord> {
  const client = await ClientModel.findById(input.clientId, { name: 1 }).lean();
  if (!client) {
    throw validationError([{ location: 'body', path: 'clientId', message: 'Choose a client' }]);
  }
  await assertClientLocations(client._id, input.locationIds, 'locationIds');
  const userId = new Types.ObjectId(actor.id);
  return withTransaction(async (session) => {
    const [doc] = await ProposalModel.create(
      [
        {
          reference: await nextReference(session),
          type: 'NEW',
          stage: 'DRAFT',
          clientId: client._id,
          ownerId: userId,
          dueDate: input.dueDate,
          policyStart: null,
          locations: [...new Set(input.locationIds)].map((locationId) => ({
            locationId: new Types.ObjectId(locationId),
            fire: [],
            hypothecation: null,
            openStock: null,
            risk: {},
          })),
          fireOption2: [],
          sections: [],
          claims: [],
          notes: null,
          insurers: [],
          activity: [
            { at: new Date(), actorId: userId, message: `Proposal created for ${client.name}` },
          ],
          createdBy: userId,
          updatedBy: userId,
        },
      ],
      { session },
    );
    if (!doc) throw new Error('Proposal was not created');
    const record = await recordOf(doc.toObject());
    await writeAudit(
      {
        userId: actor.id,
        action: AUDIT_ACTIONS.PROPOSAL_CREATED,
        entity: AUDIT_ENTITIES.PROPOSAL,
        entityId: record.id,
        before: null,
        after: toProposalAuditView(record),
        requestId: actor.requestId,
      },
      session,
    );
    return record;
  });
}

/** Replaces the Data Sheet. Not allowed once the RFQ has gone to an insurer. */
export async function updateDataSheet(
  id: string,
  input: DataSheetInput,
  actor: Actor,
): Promise<ProposalRecord> {
  const doc = await loadDoc(id);
  if (doc.insurers.some((insurer) => insurer.status === 'SENT')) throw locked();
  await assertClientLocations(
    doc.clientId,
    input.locations.map((location) => location.locationId),
    'locations',
  );
  const before = await recordOf(doc);
  return saveWith(
    doc,
    {
      dueDate: input.dueDate,
      policyStart: input.policyStart,
      locations: input.locations.map((location) => ({
        locationId: new Types.ObjectId(location.locationId),
        fire: location.fire
          .filter((item) => item.sqFt !== null || item.ratePerSqFt !== null || item.amount !== null)
          .map((item) => ({
            key: item.key,
            sqFt: money(item.sqFt),
            ratePerSqFt: money(item.ratePerSqFt),
            amount: money(item.amount),
          })),
        hypothecation: location.hypothecation,
        openStock: location.openStock,
        risk: location.risk,
      })),
      fireOption2: input.fireOption2
        .filter((line) => line.amount !== null)
        .map((line) => ({ group: line.group, amount: money(line.amount) })),
      sections: input.sections.map((section) => ({
        code: section.code,
        included: section.included,
        proposed1: money(section.proposed1),
        proposed2: money(section.proposed2),
      })),
      claims: input.claims.map((claim) => ({
        period: claim.period,
        policyType: claim.policyType,
        sumInsured: money(claim.sumInsured),
        premium: money(claim.premium),
        claimedAmount: money(claim.claimedAmount),
        remarks: claim.remarks,
        insurer: claim.insurer,
      })),
      notes: input.notes,
    },
    'Data Sheet saved',
    AUDIT_ACTIONS.PROPOSAL_UPDATED,
    actor,
    before,
  );
}

/** Chooses the insurers (up to five). Insurers the RFQ was sent to stay on the list. */
export async function setInsurers(
  id: string,
  input: SetProposalInsurersRequest,
  actor: Actor,
): Promise<ProposalRecord> {
  const doc = await loadDoc(id);
  const wanted = new Set(input.insurerIds);
  const sentMissing = doc.insurers.filter(
    (insurer) => insurer.status === 'SENT' && !wanted.has(insurer.insurerId.toHexString()),
  );
  if (sentMissing.length > 0) {
    throw conflict(ERROR_CODES.CONFLICT, 'An insurer the RFQ was sent to cannot be taken off.');
  }
  const current = new Map(
    doc.insurers.map((insurer) => [insurer.insurerId.toHexString(), insurer]),
  );
  const added = input.insurerIds.filter((insurerId) => !current.has(insurerId));
  const found = await InsurerModel.find(
    { _id: { $in: added.map((insurerId) => new Types.ObjectId(insurerId)) } },
    { company: 1, branch: 1, active: 1 },
  ).lean();
  if (found.length !== added.length || found.some((insurer) => !insurer.active)) {
    throw validationError([
      {
        location: 'body',
        path: 'insurerIds',
        message: 'Choose active insurers from the insurer master',
      },
    ]);
  }
  const before = await recordOf(doc);
  return saveWith(
    doc,
    {
      insurers: input.insurerIds.map(
        (insurerId) =>
          current.get(insurerId) ?? {
            insurerId: new Types.ObjectId(insurerId),
            status: 'NOT_SENT' as const,
            sentAt: null,
            sentBy: null,
          },
      ),
    },
    added.length > 0
      ? `Insurers added: ${found.map((insurer) => `${insurer.company}, ${insurer.branch}`).join('; ')}`
      : 'Insurers changed',
    AUDIT_ACTIONS.PROPOSAL_UPDATED,
    actor,
    before,
  );
}

/** Records that the RFQ was emailed to these insurers. The Data Sheet must be complete. */
export async function markRfqSent(
  id: string,
  input: MarkRfqSentRequest,
  actor: Actor,
): Promise<ProposalRecord> {
  const doc = await loadDoc(id);
  const before = await recordOf(doc);
  if (before.missing.length > 0) {
    throw conflict(
      ERROR_CODES.DATA_SHEET_INCOMPLETE,
      'Finish the Data Sheet before sending the RFQ.',
      {
        missing: before.missing,
      },
    );
  }
  const chosen = new Set(input.insurerIds);
  const unknown = input.insurerIds.filter(
    (insurerId) => !doc.insurers.some((insurer) => insurer.insurerId.toHexString() === insurerId),
  );
  if (unknown.length > 0) {
    throw validationError([
      { location: 'body', path: 'insurerIds', message: 'Choose insurers already on the proposal' },
    ]);
  }
  const now = new Date();
  const sentTo = before.insurers.filter(
    (insurer) => chosen.has(insurer.insurerId) && insurer.status === 'NOT_SENT',
  );
  return saveWith(
    doc,
    {
      insurers: doc.insurers.map((insurer) =>
        chosen.has(insurer.insurerId.toHexString()) && insurer.status === 'NOT_SENT'
          ? {
              ...insurer,
              status: 'SENT' as const,
              sentAt: now,
              sentBy: new Types.ObjectId(actor.id),
            }
          : insurer,
      ),
    },
    sentTo.length > 0
      ? `RFQ sent to ${sentTo.map((insurer) => `${insurer.company}, ${insurer.branch} (${insurer.rfqEmails.join(', ')})`).join('; ')}`
      : null,
    AUDIT_ACTIONS.RFQ_SENT,
    actor,
    before,
  );
}

/** The proposal for an RFQ download, audited as an export. The Data Sheet must be complete. */
export async function proposalForRfq(id: string, actor: Actor): Promise<ProposalRecord> {
  const record = await getProposal(id);
  if (record.missing.length > 0) {
    throw conflict(ERROR_CODES.DATA_SHEET_INCOMPLETE, 'Finish the Data Sheet before the RFQ.', {
      missing: record.missing,
    });
  }
  await writeAudit({
    userId: actor.id,
    action: AUDIT_ACTIONS.RFQ_DOWNLOADED,
    entity: AUDIT_ENTITIES.PROPOSAL,
    entityId: record.id,
    after: { reference: record.reference, fireProposed1: record.fire.proposed1 },
    requestId: actor.requestId,
  });
  return record;
}
