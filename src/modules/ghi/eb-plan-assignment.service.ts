import {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  EB_CENSUS_FIELD_LABELS,
  EB_PRODUCTS,
  ERROR_CODES,
  candidateFromMember,
  checkEbCensus,
  isError,
  type EbPlanDefaultsResponse,
  type EbProduct,
  type PlanAssignmentSource,
} from '../../shared/index.ts';
import { Types, type mongo } from 'mongoose';
import { withTransaction } from '../../lib/db.ts';
import { conflict, notFound, validationError } from '../../lib/errors.ts';
import { istDay } from '../../lib/ist-day.ts';
import { writeAudit } from '../audit/audit.service.ts';
import { ClientModel } from '../clients/client.model.ts';
import { ClientPlanDefaultModel } from '../family-plans/client-plan-default.model.ts';
import {
  FamilyPlanModel,
  type FamilyPlanDoc,
  type FamilyPlanVersionDoc,
} from '../family-plans/family-plan.model.ts';
import { planForAssignment } from '../family-plans/family-plans.service.ts';
import { buildCensusContext, toEbCensusMember } from './eb-census-context.ts';
import { GhiCaseModel, type GhiCaseDoc, type PlanAssignmentDoc } from './ghi-case.model.ts';
import { GhiMemberModel } from './ghi-census.model.ts';
import {
  assertWritable,
  auditCase,
  isLocked,
  loadCase,
  nameOf,
  userNames,
  type Actor,
} from './ghi-common.ts';
import type { CaseScope } from './products/profile.ts';

// Plan assignment (N2, Requirement 15): a company's default plan per product, the plan given to
// a new case, and a user's assignment or change on an unlocked case. The case keeps a copy of the
// version's slots, which later versions, deactivations or default changes never touch (15.4).

/** The day a case's plan version is chosen on: the policy start, else the creation date. */
export function planDateOf(doc: Pick<GhiCaseDoc, 'policyStart' | 'createdAt'>): string {
  return doc.policyStart ?? istDay(doc.createdAt);
}

export function assignmentOf(
  plan: FamilyPlanDoc,
  version: FamilyPlanVersionDoc,
  source: PlanAssignmentSource,
  actorId: Types.ObjectId | null,
): PlanAssignmentDoc {
  return {
    planId: plan._id,
    code: plan.code,
    name: plan.name,
    versionNumber: version.number,
    effectiveFrom: version.effectiveFrom,
    slots: version.slots.map((slot) => ({
      name: slot.name,
      min: slot.min,
      max: slot.max,
      relationships: slot.relationships.map((item) => ({
        relationship: item.relationship,
        max: item.max,
      })),
    })),
    parentsAndInLawsMixed: version.parentsAndInLawsMixed,
    openQuestions: plan.openQuestions,
    source,
    assignedAt: new Date(),
    assignedBy: actorId,
  };
}

/**
 * The plan of a new case (15.2, 15.8, 5.2): the company's active default for the product in the
 * version in effect on the plan date; for GTLI without one, GTLI Self only; otherwise none.
 */
export async function initialAssignment(
  product: EbProduct,
  clientId: Types.ObjectId,
  planDate: string,
  actorId: Types.ObjectId,
  session?: mongo.ClientSession,
): Promise<PlanAssignmentDoc | null> {
  const preset = await ClientPlanDefaultModel.findOne({ clientId, product })
    .session(session ?? null)
    .lean();
  if (preset) {
    const found = await planForAssignment(preset.planId, product, planDate, session);
    if (found.ok) return assignmentOf(found.plan, found.version, 'COMPANY_DEFAULT', actorId);
  }
  if (product === 'GTLI') {
    const selfOnly = await FamilyPlanModel.findOne({ product: 'GTLI', code: 'SELF' }, { _id: 1 })
      .session(session ?? null)
      .lean();
    if (selfOnly) {
      const found = await planForAssignment(selfOnly._id, product, planDate, session);
      if (found.ok) return assignmentOf(found.plan, found.version, 'GTLI_DEFAULT', actorId);
    }
  }
  return null;
}

export const planAudit = (assignment: PlanAssignmentDoc | null | undefined) =>
  assignment ? { code: assignment.code, versionNumber: assignment.versionNumber } : null;

/**
 * Assigns or changes the plan of an unlocked, unplaced case (15.3 to 15.7, 15.9). Every family
 * already in the census is checked against the new slots; one that breaks them refuses the change
 * (409, listing employee IDs and rules, no names). The change raises the requirements revision so
 * an RFQ generated before goes out of date (design D11).
 */
export async function assignPlan(
  scope: CaseScope,
  caseId: string,
  planId: string,
  actor: Actor,
): Promise<void> {
  const doc = await loadCase(caseId, undefined, scope);
  assertWritable(doc);
  if (isLocked(doc)) {
    throw conflict(
      ERROR_CODES.GHI_LOCKED,
      'The RFQ has gone to an insurer, so the plan can no longer change.',
    );
  }
  const found = await planForAssignment(new Types.ObjectId(planId), scope.product, planDateOf(doc));
  if (!found.ok) {
    throw validationError(
      [{ location: 'body', path: 'planId', message: found.reason }],
      found.reason,
    );
  }
  const actorId = new Types.ObjectId(actor.id);
  const assignment = assignmentOf(found.plan, found.version, 'USER', actorId);
  const members = await GhiMemberModel.find({ caseId: doc._id }).lean();
  if (members.length > 0) {
    const context = await buildCensusContext(
      { ...doc, planAssignment: assignment },
      { identityChecks: false },
    );
    const ordered = [...members].sort((a, b) =>
      a.employeeKey === b.employeeKey
        ? a.relationship === 'SELF'
          ? -1
          : b.relationship === 'SELF'
            ? 1
            : 0
        : a.employeeKey.localeCompare(b.employeeKey),
    );
    const result = checkEbCensus(
      ordered.map((member) =>
        candidateFromMember(
          member._id.toHexString(),
          toEbCensusMember(member),
          `${member.employeeId}`,
        ),
      ),
      [],
      context,
    );
    const families = new Map<string, string[]>();
    for (const member of ordered) {
      for (const issue of (result.get(member._id.toHexString()) ?? []).filter(isError)) {
        const rules = families.get(member.employeeId) ?? [];
        const rule =
          issue.code === 'DUPLICATE'
            ? 'A member appears twice'
            : `${issue.field ? `${EB_CENSUS_FIELD_LABELS[issue.field]}: ` : ''}${issue.message}`;
        if (!rules.includes(rule)) rules.push(rule);
        families.set(member.employeeId, rules);
      }
    }
    if (families.size > 0) {
      throw conflict(
        ERROR_CODES.EB_PLAN_CONFLICT,
        `${families.size} famil${families.size === 1 ? 'y breaks' : 'ies break'} ${found.plan.name} v${found.version.number}. Correct the census or choose another plan.`,
        { families: [...families.entries()].map(([employeeId, rules]) => ({ employeeId, rules })) },
      );
    }
  }
  await withTransaction(async (session) => {
    const result = await GhiCaseModel.updateOne(
      {
        _id: doc._id,
        requirementsRevision: doc.requirementsRevision,
        stage: { $ne: 'CLOSED' },
        insurers: { $not: { $elemMatch: { sentAt: { $ne: null } } } },
        placement: { $in: [null] },
      },
      {
        $set: { planAssignment: assignment, updatedBy: actorId },
        $inc: { requirementsRevision: 1 },
        $push: {
          activity: {
            at: new Date(),
            actorId,
            message: `Family plan: ${found.plan.name} v${found.version.number}${doc.planAssignment ? ` (was ${doc.planAssignment.name} v${doc.planAssignment.versionNumber})` : ''}`,
          },
        },
      },
      { session },
    );
    if (result.modifiedCount === 0) {
      assertWritable(await loadCase(caseId, session, scope));
      throw conflict(ERROR_CODES.CONFLICT, 'The case changed meanwhile. Reload it and try again.');
    }
    await auditCase(
      actor,
      AUDIT_ACTIONS.EB_PLAN_ASSIGNED,
      caseId,
      planAudit(doc.planAssignment),
      { ...planAudit(assignment), source: 'USER' },
      session,
      scope,
    );
  });
}

// Company defaults (15.1)

async function assertClient(clientId: string): Promise<Types.ObjectId> {
  if (!(await ClientModel.exists({ _id: new Types.ObjectId(clientId) }))) {
    throw notFound('Company not found');
  }
  return new Types.ObjectId(clientId);
}

export async function planDefaults(clientIdText: string): Promise<EbPlanDefaultsResponse> {
  const clientId = await assertClient(clientIdText);
  const defaults = await ClientPlanDefaultModel.find({ clientId }).lean();
  const plans = await FamilyPlanModel.find(
    { _id: { $in: defaults.map((item) => item.planId) } },
    { code: 1, name: 1, active: 1 },
  ).lean();
  const names = await userNames(defaults.map((item) => item.setBy));
  return {
    items: EB_PRODUCTS.map((product) => {
      const preset = defaults.find((item) => item.product === product);
      const plan = preset ? plans.find((item) => item._id.equals(preset.planId)) : undefined;
      return {
        product,
        planId: preset?.planId.toHexString() ?? null,
        code: plan?.code ?? null,
        name: plan?.name ?? null,
        active: plan?.active ?? null,
        setAt: preset?.setAt.toISOString() ?? null,
        setBy: preset ? nameOf(names, preset.setBy) : null,
      };
    }),
  };
}

/** Sets or clears a company's default plan for a product; its cases keep their plans (15.1). */
export async function setPlanDefault(
  clientIdText: string,
  product: EbProduct,
  planId: string | null,
  actor: Actor,
): Promise<EbPlanDefaultsResponse> {
  const clientId = await assertClient(clientIdText);
  const current = await ClientPlanDefaultModel.findOne({ clientId, product }).lean();
  let plan: Pick<FamilyPlanDoc, '_id' | 'code' | 'name'> | null = null;
  if (planId) {
    const found = await FamilyPlanModel.findById(planId, {
      code: 1,
      name: 1,
      product: 1,
      active: 1,
    }).lean();
    const reason = !found
      ? 'Choose a family plan from the Family Plan Master'
      : found.product !== product
        ? `"${found.name}" is a ${found.product} plan; choose a ${product} plan`
        : !found.active
          ? `"${found.name}" is inactive`
          : null;
    if (reason)
      throw validationError([{ location: 'body', path: 'planId', message: reason }], reason);
    plan = found;
  }
  const previous = current
    ? await FamilyPlanModel.findById(current.planId, { code: 1, name: 1 }).lean()
    : null;
  const actorId = new Types.ObjectId(actor.id);
  await withTransaction(async (session) => {
    if (plan) {
      await ClientPlanDefaultModel.updateOne(
        { clientId, product },
        { $set: { planId: plan._id, setAt: new Date(), setBy: actorId } },
        { upsert: true, session },
      );
    } else {
      await ClientPlanDefaultModel.deleteOne({ clientId, product }, { session });
    }
    await writeAudit(
      {
        userId: actor.id,
        action: plan
          ? AUDIT_ACTIONS.CLIENT_PLAN_DEFAULT_SET
          : AUDIT_ACTIONS.CLIENT_PLAN_DEFAULT_CLEARED,
        entity: AUDIT_ENTITIES.CLIENT_PLAN_DEFAULT,
        entityId: clientId.toHexString(),
        before: previous ? { product, code: previous.code, name: previous.name } : null,
        after: plan ? { product, code: plan.code, name: plan.name } : null,
        requestId: actor.requestId,
      },
      session,
    );
  });
  return planDefaults(clientIdText);
}
