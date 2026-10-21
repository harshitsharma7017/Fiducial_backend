import {
  AUDIT_ACTIONS,
  EB_PRODUCT_NAMES,
  EB_REFERENCE_PREFIX,
  ERROR_CODES,
  ROLES,
  can,
  emptyGhiRequirements,
  DEFAULT_NOMINEE_REQUIREMENT,
  emptyGpaRequirements,
  emptyGtliRequirements,
  type EbProduct,
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
import { initialAssignment, planAudit } from './eb-plan-assignment.service.ts';
import { gmcFamilyCover } from './products/gmc.ts';
import { GMC_SCOPE, scopeOf, type CaseScope } from './products/profile.ts';
import {
  advanceStage,
  assertEditable,
  assertOpen,
  assertWritable,
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

/**
 * GHI-2026-0001 (GMC), GPA-2026-0001, GTLI-2026-0001: each product's own yearly series in IST,
 * apart from Property's PRP numbers (Requirements 1.6, 16.8).
 */
async function nextReference(product: EbProduct, session: mongo.ClientSession): Promise<string> {
  const year = istYear(new Date());
  const prefix = EB_REFERENCE_PREFIX[product];
  const counter = await CounterModel.findOneAndUpdate(
    { _id: `${prefix.toLowerCase()}-${year}` },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after', session },
  ).lean();
  return `${prefix}-${year}-${String(counter?.seq ?? 1).padStart(4, '0')}`;
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
  const created = await createCaseOf('GMC', input, actor, options);
  return getCase(created.id);
}

/** The Data Sheet a new case of the product starts with. */
function emptyRequirementsOf(product: EbProduct) {
  // A new GPA or GTLI case asks for a nominee on each employee's row (N5, N6; open question NM-1).
  if (product === 'GPA')
    return { ...emptyGpaRequirements(), nominees: DEFAULT_NOMINEE_REQUIREMENT };
  if (product === 'GTLI')
    return { ...emptyGtliRequirements(), nominees: DEFAULT_NOMINEE_REQUIREMENT };
  return emptyGhiRequirements();
}

/**
 * Creates a GMC, GPA or GTLI case (Requirement 1). The company and staff are checked before the
 * transaction, so a refused request takes no reference number (1.9). The reference continues the
 * product's own yearly series (1.6, 16.8). The plan comes from the company's default, else GTLI
 * Self only for GTLI, else none (15.2, 5.2, 15.8); both are audited in the same transaction.
 */
export async function createCaseOf(
  product: EbProduct,
  input: CreateGhiCaseRequest,
  actor: Actor,
  options: { defaultGstRatePercent: string },
): Promise<{ id: string; product: EbProduct; reference: string }> {
  const client = await ClientModel.findById(input.clientId, { name: 1 }).lean();
  if (!client) {
    throw validationError([{ location: 'body', path: 'clientId', message: 'Choose a client' }]);
  }
  if (input.ownerId) await assertOwner(input.ownerId);
  const userId = new Types.ObjectId(actor.id);
  const now = new Date();
  const scope = scopeOf(product);
  // The case keeps the GST rate in force today, as a Property proposal does (M-8).
  const gstRatePercent = await taxRatePercentOn('GST', istDay(now), options.defaultGstRatePercent);
  return withTransaction(async (session) => {
    const reference = await nextReference(product, session);
    const planAssignment = await initialAssignment(
      product,
      client._id,
      input.policyStart ?? istDay(now),
      userId,
      session,
    );
    const [doc] = await GhiCaseModel.create(
      [
        {
          product,
          reference,
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
          requirements: emptyRequirementsOf(product),
          requirementsSaved: false,
          requirementsRevision: 0,
          censusRevision: 0,
          insurers: [],
          finalQcr: null,
          policy: null,
          ...(planAssignment ? { planAssignment } : {}),
          activity: [
            {
              at: now,
              actorId: userId,
              message: `${product === 'GMC' ? 'Group health' : EB_PRODUCT_NAMES[product]} ${input.type === 'RENEWAL' ? 'renewal' : 'new business'} case created for ${client.name}`,
            },
            ...(planAssignment
              ? [
                  {
                    at: now,
                    actorId: userId,
                    message: `Family plan: ${planAssignment.name} v${planAssignment.versionNumber} (${planAssignment.source === 'COMPANY_DEFAULT' ? 'the company’s default' : 'GTLI Self only'})`,
                  },
                ]
              : []),
          ],
          createdBy: userId,
          updatedBy: userId,
        },
      ],
      { session },
    );
    if (!doc) throw new Error('Case was not created');
    const id = doc._id.toHexString();
    await auditCase(
      actor,
      AUDIT_ACTIONS.GHI_CASE_CREATED,
      id,
      null,
      caseAuditView(doc.toObject()),
      session,
      scope,
    );
    if (planAssignment) {
      await auditCase(
        actor,
        AUDIT_ACTIONS.EB_PLAN_ASSIGNED,
        id,
        null,
        { ...planAudit(planAssignment), source: planAssignment.source },
        session,
        scope,
      );
    }
    return { id, product, reference };
  });
}

/** Cases, most recently changed first, searchable by reference or client, with page numbers. */
export async function listCases(query: GhiCaseListQuery): Promise<GhiCaseListResponse> {
  // /ghi lists GMC cases only (Requirement 2.2); a stored case without a product is GMC.
  const filter: QueryFilter<GhiCaseDoc> = { product: { $in: [null, 'GMC'] } };
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
      product: doc.product ?? 'GMC',
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
  await updateCaseOf(id, input, actor, GMC_SCOPE);
  return getCase(id);
}

/** Changes a case's dates, staff and expiring policy (Requirement 2.5), for any product. */
export async function updateCaseOf(
  id: string,
  input: UpdateGhiCaseRequest,
  actor: Actor,
  scope: CaseScope,
): Promise<void> {
  const doc = await loadCase(id, undefined, scope);
  assertWritable(doc);
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
      scope,
    );
  });
}

export async function closeCase(id: string, reason: string, actor: Actor): Promise<GhiCaseRecord> {
  await closeCaseOf(id, reason, actor, GMC_SCOPE);
  return getCase(id);
}

/** Closes a case that is not placed, with its reason (Requirements 3.5, 3.10). */
export async function closeCaseOf(
  id: string,
  reason: string,
  actor: Actor,
  scope: CaseScope,
): Promise<void> {
  const doc = await loadCase(id, undefined, scope);
  assertOpen(doc);
  if (doc.policy)
    throw conflict(
      ERROR_CODES.CONFLICT,
      'The policy is recorded: the case is complete and cannot be closed.',
    );
  if (doc.placement)
    throw conflict(
      ERROR_CODES.EB_PLACED,
      'The placement slip has been issued: a placed case is complete and cannot be closed.',
    );
  const actorId = new Types.ObjectId(actor.id);
  await withTransaction(async (session) => {
    const result = await GhiCaseModel.updateOne(
      { _id: doc._id, stage: { $ne: 'CLOSED' }, policy: null, placement: { $in: [null] } },
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
      scope,
    );
  });
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
  // Moved from the Data Sheet schema (design D6): with a plan, the plan says who is covered.
  if (
    input.parentsCoPayPercent !== null &&
    !gmcFamilyCover({ requirements: input, planAssignment: doc.planAssignment }).parentsCovered
  ) {
    throw validationError([
      {
        location: 'body',
        path: 'parentsCoPayPercent',
        message: 'Parents are not covered: leave the co-payment blank',
      },
    ]);
  }
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
  await setInsurersOf(id, input, actor, GMC_SCOPE);
  return getCase(id);
}

export async function setInsurersOf(
  id: string,
  input: SetGhiInsurersRequest,
  actor: Actor,
  scope: CaseScope,
): Promise<void> {
  const doc = await loadCase(id, undefined, scope);
  assertWritable(doc);
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
    if (result.matchedCount === 0) throw ghiCaseNotFound(scope);
    await auditCase(
      actor,
      AUDIT_ACTIONS.GHI_INSURERS_UPDATED,
      id,
      { insurerIds: doc.insurers.map((item) => item.insurerId.toHexString()) },
      { insurerIds: input.insurerIds },
      session,
      scope,
    );
  });
}

/** Records that an insurer declined to quote, with its reason. */
export async function declineInsurer(
  id: string,
  insurerId: string,
  reason: string,
  actor: Actor,
): Promise<GhiCaseRecord> {
  await declineInsurerOf(id, insurerId, reason, actor, GMC_SCOPE);
  return getCase(id);
}

export async function declineInsurerOf(
  id: string,
  insurerId: string,
  reason: string,
  actor: Actor,
  scope: CaseScope,
): Promise<void> {
  const doc = await loadCase(id, undefined, scope);
  assertWritable(doc);
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
      scope,
    );
  });
}
