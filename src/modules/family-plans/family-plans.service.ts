import {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  EB_PRODUCTS,
  ERROR_CODES,
  overlaps,
  planVersionIssues,
  versionOn,
  type AuditAction,
  type CreateFamilyPlanRequest,
  type EbProduct,
  type FamilyPlan,
  type FamilyPlanListResponse,
  type FamilyPlanOpenCasesResponse,
  type FamilyPlanVersion,
  type PlanVersionInput,
} from '../../shared/index.ts';
import { Types, type mongo } from 'mongoose';
import { withTransaction } from '../../lib/db.ts';
import { conflict, notFound, validationError } from '../../lib/errors.ts';
import { istDay } from '../../lib/ist-day.ts';
import { writeAudit } from '../audit/audit.service.ts';
import { ClientModel } from '../clients/client.model.ts';
import { GhiCaseModel } from '../ghi/ghi-case.model.ts';
import { nameOf, userNames, type Actor } from '../ghi/ghi-common.ts';
import {
  FamilyPlanModel,
  type FamilyPlanDoc,
  type FamilyPlanVersionDoc,
} from './family-plan.model.ts';

// The Family Plan Master (N2, Requirements 12 to 14). An Active version's slots, limits and start
// date never change: only its blank end date (once) and its client confirmation (No to Yes).
// Nothing is deleted. Every change is audited in the transaction that makes it, with the same
// fields before and after.

const planNotFound = () => notFound('Family plan not found');

function versionView(
  version: FamilyPlanVersionDoc,
  names: ReadonlyMap<string, string>,
): FamilyPlanVersion {
  return {
    number: version.number,
    status: version.status,
    effectiveFrom: version.effectiveFrom,
    effectiveTo: version.effectiveTo,
    clientConfirmed: version.clientConfirmed,
    parentsAndInLawsMixed: version.parentsAndInLawsMixed,
    slots: version.slots.map((slot) => ({
      name: slot.name,
      min: slot.min,
      max: slot.max,
      relationships: slot.relationships.map((item) => ({
        relationship: item.relationship,
        max: item.max,
      })),
    })),
    createdAt: version.createdAt.toISOString(),
    createdBy: nameOf(names, version.createdBy),
    activatedAt: version.activatedAt?.toISOString() ?? null,
    activatedBy: version.activatedBy ? nameOf(names, version.activatedBy) : null,
  };
}

async function planView(doc: FamilyPlanDoc): Promise<FamilyPlan> {
  const names = await userNames(
    doc.versions.flatMap((version) => [version.createdBy, version.activatedBy]),
  );
  return {
    id: doc._id.toHexString(),
    product: doc.product,
    code: doc.code,
    name: doc.name,
    active: doc.active,
    isDefault: doc.isDefault,
    openQuestions: doc.openQuestions,
    inEffect: versionOn(doc, istDay(new Date()))?.number ?? null,
    versions: [...doc.versions]
      .sort((a, b) => b.number - a.number)
      .map((version) => versionView(version, names)),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

/** A version's fields as the audit log keeps them. */
function versionAudit(
  version: Pick<
    FamilyPlanVersionDoc,
    keyof PlanVersionInput | 'number' | 'status' | 'clientConfirmed'
  >,
) {
  return {
    number: version.number,
    status: version.status,
    effectiveFrom: version.effectiveFrom,
    effectiveTo: version.effectiveTo,
    clientConfirmed: version.clientConfirmed,
    parentsAndInLawsMixed: version.parentsAndInLawsMixed,
    slots: version.slots,
  };
}

async function audit(
  actor: Actor | null,
  action: AuditAction,
  planId: Types.ObjectId,
  before: unknown,
  after: unknown,
  session: mongo.ClientSession,
): Promise<void> {
  await writeAudit(
    {
      userId: actor?.id ?? null,
      action,
      entity: AUDIT_ENTITIES.FAMILY_PLAN,
      entityId: planId.toHexString(),
      before,
      after,
      requestId: actor?.requestId ?? null,
    },
    session,
  );
}

async function loadPlan(planId: string, session?: mongo.ClientSession): Promise<FamilyPlanDoc> {
  const doc = await FamilyPlanModel.findById(planId)
    .session(session ?? null)
    .lean<FamilyPlanDoc>();
  if (!doc) throw planNotFound();
  return doc;
}

function versionOf(doc: FamilyPlanDoc, number: number): FamilyPlanVersionDoc {
  const version = doc.versions.find((item) => item.number === number);
  if (!version) throw notFound(`Version ${number} of this plan not found`);
  return version;
}

const changedMeanwhile = () =>
  conflict(
    ERROR_CODES.CONFLICT,
    'Someone else changed this plan meanwhile. Reload it and try again.',
  );

function locked(version: FamilyPlanVersionDoc) {
  return conflict(
    ERROR_CODES.FAMILY_PLAN_VERSION_LOCKED,
    `Version ${version.number} is Active: its slots, limits and start date no longer change. Create a new version instead.`,
  );
}

function storedVersion(input: PlanVersionInput) {
  return {
    effectiveFrom: input.effectiveFrom,
    effectiveTo: input.effectiveTo,
    parentsAndInLawsMixed: input.parentsAndInLawsMixed,
    slots: input.slots.map((slot) => ({
      name: slot.name,
      min: slot.min,
      max: slot.max,
      relationships: slot.relationships.map((item) => ({
        relationship: item.relationship,
        max: item.max,
      })),
    })),
  };
}

/** Plans, filtered by product, in product order then code. */
export async function listPlans(query: { product?: EbProduct }): Promise<FamilyPlanListResponse> {
  const docs = await FamilyPlanModel.find(query.product ? { product: query.product } : {})
    .sort({ code: 1 })
    .lean<FamilyPlanDoc[]>();
  docs.sort((a, b) => EB_PRODUCTS.indexOf(a.product) - EB_PRODUCTS.indexOf(b.product));
  const today = istDay(new Date());
  const names = await userNames(
    docs.flatMap((doc) =>
      doc.versions.flatMap((version) => [version.createdBy, version.activatedBy]),
    ),
  );
  return {
    items: docs.map((doc) => {
      const current = versionOn(doc, today);
      return {
        id: doc._id.toHexString(),
        product: doc.product,
        code: doc.code,
        name: doc.name,
        active: doc.active,
        isDefault: doc.isDefault,
        openQuestions: doc.openQuestions,
        inEffect: current?.number ?? null,
        versionCount: doc.versions.length,
        current: current ? versionView(current, names) : null,
        updatedAt: doc.updatedAt.toISOString(),
      };
    }),
  };
}

export async function getPlan(planId: string): Promise<FamilyPlan> {
  return planView(await loadPlan(planId));
}

/** Creates a plan with its first version as a Draft (Requirement 12.1). */
export async function createPlan(
  input: CreateFamilyPlanRequest,
  actor: Actor,
): Promise<FamilyPlan> {
  const taken = await FamilyPlanModel.findOne(
    { product: input.product, code: input.code },
    { name: 1 },
  ).lean();
  if (taken) {
    throw conflict(
      ERROR_CODES.FAMILY_PLAN_CODE_TAKEN,
      `The ${input.product} plan "${taken.name}" already uses the code ${input.code}. Choose another code.`,
    );
  }
  const actorId = new Types.ObjectId(actor.id);
  const now = new Date();
  try {
    const id = await withTransaction(async (session) => {
      const version = {
        number: 1,
        status: 'DRAFT' as const,
        ...storedVersion(input.firstVersion),
        clientConfirmed: false,
        createdAt: now,
        createdBy: actorId,
        activatedAt: null,
        activatedBy: null,
      };
      const [doc] = await FamilyPlanModel.create(
        [
          {
            product: input.product,
            code: input.code,
            name: input.name,
            active: true,
            isDefault: false,
            openQuestions: [],
            versions: [version],
            createdBy: actorId,
            updatedBy: actorId,
          },
        ],
        { session },
      );
      if (!doc) throw new Error('Plan was not created');
      await audit(
        actor,
        AUDIT_ACTIONS.FAMILY_PLAN_CREATED,
        doc._id,
        null,
        {
          code: input.code,
          name: input.name,
          product: input.product,
          active: true,
          version: versionAudit(version),
        },
        session,
      );
      return doc._id.toHexString();
    });
    return getPlan(id);
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      throw conflict(
        ERROR_CODES.FAMILY_PLAN_CODE_TAKEN,
        `Another ${input.product} plan already uses the code ${input.code}. Choose another code.`,
      );
    }
    throw error;
  }
}

/** Renames a plan; its code and product never change (12.1). */
export async function renamePlan(planId: string, name: string, actor: Actor): Promise<FamilyPlan> {
  const doc = await loadPlan(planId);
  await withTransaction(async (session) => {
    const result = await FamilyPlanModel.updateOne(
      { _id: doc._id, __v: doc.__v },
      { $set: { name, updatedBy: new Types.ObjectId(actor.id) }, $inc: { __v: 1 } },
      { session },
    );
    if (result.modifiedCount === 0) throw changedMeanwhile();
    await audit(
      actor,
      AUDIT_ACTIONS.FAMILY_PLAN_UPDATED,
      doc._id,
      { name: doc.name },
      { name },
      session,
    );
  });
  return getPlan(planId);
}

/** Activates or deactivates a plan; existing assignments and snapshots stay as they are (12.8). */
export async function setPlanActive(
  planId: string,
  active: boolean,
  actor: Actor,
): Promise<FamilyPlan> {
  const doc = await loadPlan(planId);
  if (doc.active === active) {
    throw conflict(ERROR_CODES.CONFLICT, `This plan is already ${active ? 'active' : 'inactive'}.`);
  }
  await withTransaction(async (session) => {
    const result = await FamilyPlanModel.updateOne(
      { _id: doc._id, __v: doc.__v },
      { $set: { active, updatedBy: new Types.ObjectId(actor.id) }, $inc: { __v: 1 } },
      { session },
    );
    if (result.modifiedCount === 0) throw changedMeanwhile();
    await audit(
      actor,
      active ? AUDIT_ACTIONS.FAMILY_PLAN_ACTIVATED : AUDIT_ACTIONS.FAMILY_PLAN_DEACTIVATED,
      doc._id,
      { active: doc.active },
      { active },
      session,
    );
  });
  return getPlan(planId);
}

/** A new Draft version numbered after the last one, never reusing a number (12.2, 12.6). */
export async function createVersion(
  planId: string,
  input: PlanVersionInput,
  actor: Actor,
): Promise<FamilyPlan> {
  const doc = await loadPlan(planId);
  const actorId = new Types.ObjectId(actor.id);
  const version = {
    number: doc.versions.length + 1,
    status: 'DRAFT' as const,
    ...storedVersion(input),
    clientConfirmed: false,
    createdAt: new Date(),
    createdBy: actorId,
    activatedAt: null,
    activatedBy: null,
  };
  await withTransaction(async (session) => {
    const result = await FamilyPlanModel.updateOne(
      { _id: doc._id, __v: doc.__v, versions: { $size: doc.versions.length } },
      { $push: { versions: version }, $set: { updatedBy: actorId }, $inc: { __v: 1 } },
      { session },
    );
    if (result.modifiedCount === 0) throw changedMeanwhile();
    await audit(
      actor,
      AUDIT_ACTIONS.FAMILY_PLAN_VERSION_CREATED,
      doc._id,
      null,
      versionAudit(version),
      session,
    );
  });
  return getPlan(planId);
}

/** Edits a Draft version; an Active one is refused (12.6). */
export async function updateDraftVersion(
  planId: string,
  number: number,
  input: PlanVersionInput,
  actor: Actor,
): Promise<FamilyPlan> {
  const doc = await loadPlan(planId);
  const version = versionOf(doc, number);
  if (version.status !== 'DRAFT') throw locked(version);
  const next = storedVersion(input);
  await withTransaction(async (session) => {
    const result = await FamilyPlanModel.updateOne(
      { _id: doc._id, __v: doc.__v },
      {
        $set: {
          'versions.$[target].effectiveFrom': next.effectiveFrom,
          'versions.$[target].effectiveTo': next.effectiveTo,
          'versions.$[target].parentsAndInLawsMixed': next.parentsAndInLawsMixed,
          'versions.$[target].slots': next.slots,
          updatedBy: new Types.ObjectId(actor.id),
        },
        $inc: { __v: 1 },
      },
      { session, arrayFilters: [{ 'target.number': number, 'target.status': 'DRAFT' }] },
    );
    if (result.modifiedCount === 0) throw changedMeanwhile();
    await audit(
      actor,
      AUDIT_ACTIONS.FAMILY_PLAN_VERSION_UPDATED,
      doc._id,
      versionAudit(version),
      versionAudit({ ...version, ...next }),
      session,
    );
  });
  return getPlan(planId);
}

function assertNoOverlap(
  doc: FamilyPlanDoc,
  number: number,
  range: { effectiveFrom: string; effectiveTo: string | null },
): void {
  const other = doc.versions.find(
    (item) => item.number !== number && item.status === 'ACTIVE' && overlaps(item, range),
  );
  if (other) {
    throw conflict(
      ERROR_CODES.FAMILY_PLAN_OVERLAP,
      `The dates overlap Active version ${other.number} (${other.effectiveFrom} to ${other.effectiveTo ?? 'no end'}). Set that version's end date first, or change the dates.`,
      { version: other.number },
    );
  }
}

/** Activates a Draft that meets the rules and overlaps no other Active version (12.6, 12.7, 13.1). */
export async function activateVersion(
  planId: string,
  number: number,
  actor: Actor,
): Promise<FamilyPlan> {
  const doc = await loadPlan(planId);
  const version = versionOf(doc, number);
  if (version.status === 'ACTIVE') {
    throw conflict(ERROR_CODES.FAMILY_PLAN_VERSION_LOCKED, `Version ${number} is already Active.`);
  }
  const issues = planVersionIssues(version);
  if (issues.length > 0) {
    throw validationError(
      issues.map((issue) => ({
        location: 'body',
        path: issue.path.join('.'),
        message: issue.message,
      })),
      issues[0]?.message,
    );
  }
  assertNoOverlap(doc, number, version);
  const actorId = new Types.ObjectId(actor.id);
  const now = new Date();
  await withTransaction(async (session) => {
    const result = await FamilyPlanModel.updateOne(
      { _id: doc._id, __v: doc.__v },
      {
        $set: {
          'versions.$[target].status': 'ACTIVE',
          'versions.$[target].activatedAt': now,
          'versions.$[target].activatedBy': actorId,
          updatedBy: actorId,
        },
        $inc: { __v: 1 },
      },
      { session, arrayFilters: [{ 'target.number': number, 'target.status': 'DRAFT' }] },
    );
    if (result.modifiedCount === 0) throw changedMeanwhile();
    await audit(
      actor,
      AUDIT_ACTIONS.FAMILY_PLAN_VERSION_ACTIVATED,
      doc._id,
      versionAudit(version),
      versionAudit({ ...version, status: 'ACTIVE' }),
      session,
    );
  });
  return getPlan(planId);
}

/** Sets an Active version's blank end date, once (12.11). */
export async function setEffectiveTo(
  planId: string,
  number: number,
  effectiveTo: string,
  actor: Actor,
): Promise<FamilyPlan> {
  const doc = await loadPlan(planId);
  const version = versionOf(doc, number);
  if (version.status !== 'ACTIVE') {
    throw conflict(
      ERROR_CODES.CONFLICT,
      `Version ${number} is a Draft: set its end date by editing the draft.`,
    );
  }
  if (version.effectiveTo !== null) {
    throw conflict(
      ERROR_CODES.FAMILY_PLAN_VERSION_LOCKED,
      `Version ${number} already ends on ${version.effectiveTo}; the end date is set once.`,
    );
  }
  if (effectiveTo < version.effectiveFrom) {
    throw validationError([
      {
        location: 'body',
        path: 'effectiveTo',
        message: 'The end date must be on or after the start date',
      },
    ]);
  }
  assertNoOverlap(doc, number, { effectiveFrom: version.effectiveFrom, effectiveTo });
  await withTransaction(async (session) => {
    const result = await FamilyPlanModel.updateOne(
      { _id: doc._id, __v: doc.__v },
      {
        $set: {
          'versions.$[target].effectiveTo': effectiveTo,
          updatedBy: new Types.ObjectId(actor.id),
        },
        $inc: { __v: 1 },
      },
      {
        session,
        arrayFilters: [
          { 'target.number': number, 'target.status': 'ACTIVE', 'target.effectiveTo': null },
        ],
      },
    );
    if (result.modifiedCount === 0) throw changedMeanwhile();
    await audit(
      actor,
      AUDIT_ACTIONS.FAMILY_PLAN_VERSION_ENDED,
      doc._id,
      versionAudit(version),
      versionAudit({ ...version, effectiveTo }),
      session,
    );
  });
  return getPlan(planId);
}

/** Records the client's confirmation of a version: No to Yes only (12.11). */
export async function confirmVersion(
  planId: string,
  number: number,
  actor: Actor,
): Promise<FamilyPlan> {
  const doc = await loadPlan(planId);
  const version = versionOf(doc, number);
  if (version.clientConfirmed) {
    throw conflict(
      ERROR_CODES.FAMILY_PLAN_VERSION_LOCKED,
      `Version ${number} is already confirmed by the client; a confirmation is not withdrawn.`,
    );
  }
  await withTransaction(async (session) => {
    const result = await FamilyPlanModel.updateOne(
      { _id: doc._id, __v: doc.__v },
      {
        $set: {
          'versions.$[target].clientConfirmed': true,
          updatedBy: new Types.ObjectId(actor.id),
        },
        $inc: { __v: 1 },
      },
      { session, arrayFilters: [{ 'target.number': number, 'target.clientConfirmed': false }] },
    );
    if (result.modifiedCount === 0) throw changedMeanwhile();
    await audit(
      actor,
      AUDIT_ACTIONS.FAMILY_PLAN_VERSION_CONFIRMED,
      doc._id,
      versionAudit(version),
      versionAudit({ ...version, clientConfirmed: true }),
      session,
    );
  });
  return getPlan(planId);
}

/** Open cases (not placed, not closed) assigned the plan, listed before a deactivation (12.8). */
export async function openCasesUsing(planId: string): Promise<FamilyPlanOpenCasesResponse> {
  const doc = await loadPlan(planId);
  const cases = await GhiCaseModel.find(
    {
      'planAssignment.planId': doc._id,
      stage: { $ne: 'CLOSED' },
      policy: null,
      placement: { $in: [null] },
    },
    { reference: 1, product: 1, clientId: 1, stage: 1, planAssignment: 1 },
  )
    .sort({ reference: 1 })
    .limit(500)
    .lean();
  const clients = await ClientModel.find(
    { _id: { $in: cases.map((item) => item.clientId) } },
    { name: 1 },
  ).lean();
  return {
    items: cases.map((item) => ({
      id: item._id.toHexString(),
      product: item.product ?? 'GMC',
      reference: item.reference,
      clientName: clients.find((client) => client._id.equals(item.clientId))?.name ?? '',
      stage: item.stage,
      versionNumber: item.planAssignment?.versionNumber ?? 0,
    })),
  };
}

/** An active plan of a product with its version in effect on a day (for assignments, 15.2–15.6). */
export async function planForAssignment(
  planId: Types.ObjectId | string,
  product: EbProduct,
  day: string,
  session?: mongo.ClientSession,
): Promise<
  { ok: true; plan: FamilyPlanDoc; version: FamilyPlanVersionDoc } | { ok: false; reason: string }
> {
  const plan = await FamilyPlanModel.findById(planId)
    .session(session ?? null)
    .lean<FamilyPlanDoc>();
  if (!plan) return { ok: false, reason: 'Choose a family plan from the Family Plan Master' };
  if (plan.product !== product) {
    return {
      ok: false,
      reason: `"${plan.name}" is a ${plan.product} plan; choose a ${product} plan`,
    };
  }
  if (!plan.active) return { ok: false, reason: `"${plan.name}" is inactive` };
  const version = versionOn(plan, day);
  if (!version) {
    return { ok: false, reason: `"${plan.name}" has no Active version in effect on ${day}` };
  }
  return { ok: true, plan, version };
}
