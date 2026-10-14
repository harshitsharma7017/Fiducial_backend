import {
  AUDIT_ACTIONS,
  ERROR_CODES,
  ROLES,
  can,
  emptyGhiRequirements,
  type CreateGhiCaseRequest,
  type GhiCaseListQuery,
  type GhiCaseListResponse,
  type GhiCaseRecord,
  type GhiRequirementsInput,
  type SetGhiInsurersRequest,
  type UpdateGhiCaseRequest,
} from '../../shared/index.ts';
import { Types, type QueryFilter, type mongo } from 'mongoose';
import { withTransaction } from '../../lib/db.ts';
import { toDecimal128 } from '../../lib/decimal.ts';
import { conflict, validationError } from '../../lib/errors.ts';
import { istDay } from '../../lib/ist-day.ts';
import { escapeRegExp } from '../../lib/text.ts';
import { taxRatePercentOn } from '../catalog/catalog.service.ts';
import { ClientModel } from '../clients/client.model.ts';
import { InsurerModel } from '../insurers/insurer.model.ts';
import { CounterModel } from '../proposals/proposal.model.ts';
import { UserModel } from '../users/user.model.ts';
import {
  advanceStage,
  assertEditable,
  assertOpen,
  auditCase,
  caseAuditView,
  ghiCaseNotFound,
  insurerNames,
  loadCase,
  toCaseRecord,
  userNames,
  type Actor,
} from './ghi-common.ts';
import { GhiCaseModel, type GhiCaseDoc } from './ghi-case.model.ts';
import { GhiMemberModel } from './ghi-census.model.ts';
import { GhiQuoteModel } from './ghi-workflow.model.ts';

/** Staff a case can be assigned to: those who may edit cases, as on Property. */
const OWNER_ROLES = ROLES.filter((role) => can([role], 'proposals.edit'));

function istYear(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric' }).format(
    now,
  );
}

/** GHI-2026-0001: its own yearly series, apart from Property's PRP numbers. */
async function nextReference(session: mongo.ClientSession): Promise<string> {
  const year = istYear(new Date());
  const counter = await CounterModel.findOneAndUpdate(
    { _id: `ghi-${year}` },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after', session },
  ).lean();
  return `GHI-${year}-${String(counter?.seq ?? 1).padStart(4, '0')}`;
}

async function assertOwner(ownerId: string): Promise<void> {
  const owner = await UserModel.exists({
    _id: new Types.ObjectId(ownerId),
    active: true,
    roles: { $in: OWNER_ROLES },
  });
  if (!owner) {
    throw validationError([
      { location: 'body', path: 'ownerId', message: 'Choose active staff who can edit cases' },
    ]);
  }
}

export async function getCase(id: string): Promise<GhiCaseRecord> {
  return toCaseRecord(await loadCase(id));
}

export async function createCase(
  input: CreateGhiCaseRequest,
  actor: Actor,
  options: { defaultGstRatePercent: string },
): Promise<GhiCaseRecord> {
  const client = await ClientModel.findById(input.clientId, { name: 1 }).lean();
  if (!client) {
    throw validationError([{ location: 'body', path: 'clientId', message: 'Choose a client' }]);
  }
  if (input.ownerId) await assertOwner(input.ownerId);
  const userId = new Types.ObjectId(actor.id);
  const now = new Date();
  // The case keeps the GST rate in force today, as a Property proposal does (M-8).
  const gstRatePercent = await taxRatePercentOn('GST', istDay(now), options.defaultGstRatePercent);
  const id = await withTransaction(async (session) => {
    const [doc] = await GhiCaseModel.create(
      [
        {
          reference: await nextReference(session),
          type: input.type,
          stage: 'CREATED',
          closedReason: null,
          clientId: client._id,
          ownerId: input.ownerId ? new Types.ObjectId(input.ownerId) : userId,
          policyStart: input.policyStart,
          policyEnd: input.policyEnd,
          dueDate: input.dueDate,
          existingInsurer: input.existingInsurer,
          existingPolicyNumber: input.existingPolicyNumber,
          gstRatePercent: toDecimal128(gstRatePercent),
          requirements: emptyGhiRequirements(),
          requirementsSaved: false,
          requirementsRevision: 0,
          censusRevision: 0,
          insurers: [],
          finalQcr: null,
          policy: null,
          activity: [
            {
              at: now,
              actorId: userId,
              message: `Group health ${input.type === 'RENEWAL' ? 'renewal' : 'new business'} case created for ${client.name}`,
            },
          ],
          createdBy: userId,
          updatedBy: userId,
        },
      ],
      { session },
    );
    if (!doc) throw new Error('Case was not created');
    await auditCase(
      actor,
      AUDIT_ACTIONS.GHI_CASE_CREATED,
      doc._id.toHexString(),
      null,
      caseAuditView(doc.toObject()),
      session,
    );
    return doc._id.toHexString();
  });
  return getCase(id);
}

/** Cases, most recently changed first, searchable by reference or client, with page numbers. */
export async function listCases(query: GhiCaseListQuery): Promise<GhiCaseListResponse> {
  const filter: QueryFilter<GhiCaseDoc> = {};
  if (query.stage) filter.stage = query.stage;
  if (query.type) filter.type = query.type;
  if (query.q) {
    const pattern = new RegExp(escapeRegExp(query.q.trim()), 'i');
    const clients = await ClientModel.find({ name: pattern }, { _id: 1 }).limit(500).lean();
    filter.$or = [
      { reference: pattern },
      { clientId: { $in: clients.map((client) => client._id) } },
    ];
  }
  const [total, docs] = await Promise.all([
    GhiCaseModel.countDocuments(filter),
    GhiCaseModel.find(filter, { requirements: 0, activity: 0 })
      .sort({ updatedAt: -1, _id: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean(),
  ]);
  const caseIds = docs.map((doc) => doc._id);
  const [clients, owners, counts] = await Promise.all([
    ClientModel.find({ _id: { $in: docs.map((doc) => doc.clientId) } }, { name: 1 }).lean(),
    userNames(docs.map((doc) => doc.ownerId)),
    GhiMemberModel.aggregate<{ _id: Types.ObjectId; lives: number; employees: number }>([
      { $match: { caseId: { $in: caseIds } } },
      {
        $group: {
          _id: '$caseId',
          lives: { $sum: 1 },
          employees: { $sum: { $cond: [{ $eq: ['$relationship', 'SELF'] }, 1, 0] } },
        },
      },
    ]),
  ]);
  const clientName = new Map(clients.map((client) => [client._id.toHexString(), client.name]));
  const countOf = new Map(counts.map((count) => [count._id.toHexString(), count]));
  return {
    items: docs.map((doc) => ({
      id: doc._id.toHexString(),
      reference: doc.reference,
      type: doc.type,
      stage: doc.stage,
      placed: doc.policy !== null,
      client: {
        id: doc.clientId.toHexString(),
        name: clientName.get(doc.clientId.toHexString()) ?? 'Client no longer exists',
      },
      owner: owners.get(doc.ownerId.toHexString()) ?? 'Unknown user',
      policyStart: doc.policyStart,
      dueDate: doc.dueDate,
      employees: countOf.get(doc._id.toHexString())?.employees ?? 0,
      lives: countOf.get(doc._id.toHexString())?.lives ?? 0,
      updatedAt: doc.updatedAt.toISOString(),
    })),
    total,
    page: query.page,
    limit: query.limit,
  };
}

export async function updateCase(
  id: string,
  input: UpdateGhiCaseRequest,
  actor: Actor,
): Promise<GhiCaseRecord> {
  const doc = await loadCase(id);
  assertOpen(doc);
  const issues: { location: 'body'; path: string; message: string }[] = [];
  if (input.policyEnd && !input.policyStart) {
    issues.push({
      location: 'body',
      path: 'policyStart',
      message: 'Enter the start of the policy period',
    });
  }
  if (input.policyStart && input.policyEnd && input.policyEnd <= input.policyStart) {
    issues.push({
      location: 'body',
      path: 'policyEnd',
      message: 'The policy period must end after it starts',
    });
  }
  if (doc.type === 'RENEWAL' && (!input.policyStart || !input.policyEnd)) {
    issues.push({
      location: 'body',
      path: input.policyStart ? 'policyEnd' : 'policyStart',
      message: 'A renewal needs its policy period',
    });
  }
  if (issues.length > 0) throw validationError(issues);
  // The policy start can be the age reference date: once the RFQ is out it stays as sent.
  if (doc.policyStart !== input.policyStart && !doc.requirements.ageReferenceDate)
    assertEditable(doc);
  if (input.ownerId !== doc.ownerId.toHexString()) await assertOwner(input.ownerId);
  const actorId = new Types.ObjectId(actor.id);
  await withTransaction(async (session) => {
    const updated = await GhiCaseModel.findOneAndUpdate(
      { _id: doc._id, stage: { $ne: 'CLOSED' } },
      {
        $set: {
          ownerId: new Types.ObjectId(input.ownerId),
          policyStart: input.policyStart,
          policyEnd: input.policyEnd,
          dueDate: input.dueDate,
          existingInsurer: input.existingInsurer,
          existingPolicyNumber: input.existingPolicyNumber,
          updatedBy: actorId,
          // The age reference date may follow the policy start: the census is checked again.
          ...(doc.policyStart !== input.policyStart
            ? { censusRevision: doc.censusRevision + 1 }
            : {}),
        },
        $push: { activity: { at: new Date(), actorId, message: 'Case details changed' } },
      },
      { returnDocument: 'after', session },
    ).lean<GhiCaseDoc>();
    if (!updated) throw conflict(ERROR_CODES.GHI_LOCKED, 'This case is closed.');
    await auditCase(
      actor,
      AUDIT_ACTIONS.GHI_CASE_UPDATED,
      id,
      caseAuditView(doc),
      caseAuditView(updated),
      session,
    );
  });
  return getCase(id);
}

export async function closeCase(id: string, reason: string, actor: Actor): Promise<GhiCaseRecord> {
  const doc = await loadCase(id);
  assertOpen(doc);
  if (doc.policy)
    throw conflict(
      ERROR_CODES.CONFLICT,
      'The policy is recorded: the case is complete and cannot be closed.',
    );
  const actorId = new Types.ObjectId(actor.id);
  await withTransaction(async (session) => {
    const result = await GhiCaseModel.updateOne(
      { _id: doc._id, stage: { $ne: 'CLOSED' }, policy: null },
      {
        $set: { stage: 'CLOSED', closedReason: reason, updatedBy: actorId },
        $push: { activity: { at: new Date(), actorId, message: `Case closed: ${reason}` } },
      },
      { session },
    );
    if (result.modifiedCount === 0) throw conflict(ERROR_CODES.GHI_LOCKED, 'This case is closed.');
    await auditCase(
      actor,
      AUDIT_ACTIONS.GHI_CASE_CLOSED,
      id,
      { stage: doc.stage },
      { stage: 'CLOSED', reason },
      session,
    );
  });
  return getCase(id);
}

/**
 * Saves the Data Sheet (G2). The first save moves a new case to Data Sheet. A change to who the
 * family covers, the coverage type, the sums insured or the age limits applies to the census at
 * once, so members that no longer fit show on the census with their problems.
 */
export async function saveRequirements(
  id: string,
  input: GhiRequirementsInput,
  actor: Actor,
): Promise<GhiCaseRecord> {
  const doc = await loadCase(id);
  assertEditable(doc);
  const actorId = new Types.ObjectId(actor.id);
  const affectsCensus =
    JSON.stringify([
      doc.requirements.familyDefinition,
      doc.requirements.coverageType,
      doc.requirements.sumInsuredOptions,
      doc.requirements.ageLimits,
      doc.requirements.ageReferenceDate,
    ]) !==
    JSON.stringify([
      input.familyDefinition,
      input.coverageType,
      input.sumInsuredOptions,
      input.ageLimits,
      input.ageReferenceDate,
    ]);
  await withTransaction(async (session) => {
    // Guarded: no concurrent save (same revision), still open, and no RFQ sent meanwhile.
    const result = await GhiCaseModel.updateOne(
      {
        _id: doc._id,
        requirementsRevision: doc.requirementsRevision,
        stage: { $ne: 'CLOSED' },
        insurers: { $not: { $elemMatch: { sentAt: { $ne: null } } } },
      },
      {
        $set: {
          requirements: input,
          requirementsSaved: true,
          updatedBy: actorId,
          ...(affectsCensus ? { censusRevision: doc.censusRevision + 1 } : {}),
        },
        $inc: { requirementsRevision: 1 },
        $push: { activity: { at: new Date(), actorId, message: 'Data Sheet saved' } },
      },
      { session },
    );
    if (result.modifiedCount === 0) assertEditable(await loadCase(id, session));
    if (result.modifiedCount === 0) {
      throw conflict(
        ERROR_CODES.CONFLICT,
        'Someone else saved this Data Sheet meanwhile. Reload it and make your change again.',
      );
    }
    await advanceStage(doc._id, 'DATA_SHEET', actorId, session);
    await auditCase(
      actor,
      AUDIT_ACTIONS.GHI_REQUIREMENTS_SAVED,
      id,
      doc.requirementsSaved ? doc.requirements : null,
      input,
      session,
    );
  });
  return getCase(id);
}

/**
 * Chooses the insurers for the RFQ (up to five). An insurer that already has the RFQ or a quote
 * stays on the case.
 */
export async function setInsurers(
  id: string,
  input: SetGhiInsurersRequest,
  actor: Actor,
): Promise<GhiCaseRecord> {
  const doc = await loadCase(id);
  assertOpen(doc);
  const wanted = input.insurerIds.map((insurerId) => new Types.ObjectId(insurerId));
  const known = await InsurerModel.find({ _id: { $in: wanted } }, { active: 1 }).lean();
  const kept = new Map(doc.insurers.map((item) => [item.insurerId.toHexString(), item]));
  const issues: { location: 'body'; path: string; message: string }[] = [];
  input.insurerIds.forEach((insurerId, index) => {
    const insurer = known.find((item) => item._id.toHexString() === insurerId);
    if (!insurer)
      issues.push({
        location: 'body',
        path: `insurerIds.${index}`,
        message: 'Choose an insurer from the insurer master',
      });
    else if (!insurer.active && !kept.has(insurerId)) {
      issues.push({
        location: 'body',
        path: `insurerIds.${index}`,
        message: 'This insurer is inactive',
      });
    }
  });
  if (issues.length > 0) throw validationError(issues);
  const quoted = await GhiQuoteModel.distinct('insurerId', { caseId: doc._id });
  const quotedIds = new Set(quoted.map((insurerId: Types.ObjectId) => insurerId.toHexString()));
  const removed = doc.insurers.filter(
    (item) => !input.insurerIds.includes(item.insurerId.toHexString()),
  );
  const stuck = removed.find(
    (item) => item.status !== 'NOT_SENT' || quotedIds.has(item.insurerId.toHexString()),
  );
  if (stuck) {
    throw conflict(
      ERROR_CODES.CONFLICT,
      'An insurer that has the RFQ or a quote stays on the case.',
    );
  }
  const actorId = new Types.ObjectId(actor.id);
  const insurers = input.insurerIds.map(
    (insurerId) =>
      kept.get(insurerId) ?? {
        insurerId: new Types.ObjectId(insurerId),
        status: 'NOT_SENT' as const,
        sentVia: null,
        sentAt: null,
        sentBy: null,
        dueDate: null,
        lastDispatch: null,
        declineReason: null,
        sending: null,
      },
  );
  await withTransaction(async (session) => {
    const result = await GhiCaseModel.updateOne(
      { _id: doc._id, stage: { $ne: 'CLOSED' } },
      {
        $set: { insurers, updatedBy: actorId },
        $push: {
          activity: {
            at: new Date(),
            actorId,
            message: `Insurers chosen: ${input.insurerIds.length}`,
          },
        },
      },
      { session },
    );
    if (result.matchedCount === 0) throw ghiCaseNotFound();
    await auditCase(
      actor,
      AUDIT_ACTIONS.GHI_INSURERS_UPDATED,
      id,
      { insurerIds: doc.insurers.map((item) => item.insurerId.toHexString()) },
      { insurerIds: input.insurerIds },
      session,
    );
  });
  return getCase(id);
}

/** Records that an insurer declined to quote, with its reason. */
export async function declineInsurer(
  id: string,
  insurerId: string,
  reason: string,
  actor: Actor,
): Promise<GhiCaseRecord> {
  const doc = await loadCase(id);
  assertOpen(doc);
  const item = doc.insurers.find((insurer) => insurer.insurerId.toHexString() === insurerId);
  if (!item)
    throw validationError([
      { location: 'params', path: 'insurerId', message: 'This insurer is not on the case' },
    ]);
  if (item.status === 'NOT_SENT')
    throw conflict(ERROR_CODES.CONFLICT, 'Send the RFQ to this insurer first.');
  const actorId = new Types.ObjectId(actor.id);
  const names = await insurerNames([item.insurerId]);
  await withTransaction(async (session) => {
    await GhiCaseModel.updateOne(
      { _id: doc._id },
      {
        $set: {
          'insurers.$[target].status': 'DECLINED',
          'insurers.$[target].declineReason': reason,
          updatedBy: actorId,
        },
        $push: {
          activity: {
            at: new Date(),
            actorId,
            message: `${names.get(insurerId) ?? 'Insurer'} declined: ${reason}`,
          },
        },
      },
      { session, arrayFilters: [{ 'target.insurerId': item.insurerId }] },
    );
    await auditCase(
      actor,
      AUDIT_ACTIONS.GHI_INSURER_DECLINED,
      id,
      { insurerId, status: item.status },
      { insurerId, status: 'DECLINED', reason },
      session,
    );
  });
  return getCase(id);
}
