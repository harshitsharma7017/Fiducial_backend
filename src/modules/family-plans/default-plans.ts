import {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  DEFAULT_FAMILY_PLANS,
  type DefaultFamilyPlan,
} from '../../shared/index.ts';
import { withTransaction } from '../../lib/db.ts';
import { writeAudit } from '../audit/audit.service.ts';
import { FamilyPlanModel } from './family-plan.model.ts';

/**
 * Creates each default family plan (Requirement 14.2) that the Family Plan Master does not hold
 * under its product and code, active or not, with version 1 Active from 01/01/2000, no end date
 * and the client's confirmation off. A plan that exists is never touched, whatever an Admin has
 * changed (14.7). Each creation is audited as made by the system in the same transaction (14.8).
 * Safe on every start and when two API instances start at once (the unique { product, code }
 * index keeps one plan; the loser's transaction finds it there).
 */
export async function ensureDefaultFamilyPlans(): Promise<{ created: string[] }> {
  const created: string[] = [];
  for (const plan of DEFAULT_FAMILY_PLANS) {
    if (await createIfMissing(plan)) created.push(`${plan.product} ${plan.code}`);
  }
  return { created };
}

async function createIfMissing(plan: DefaultFamilyPlan): Promise<boolean> {
  if (await FamilyPlanModel.exists({ product: plan.product, code: plan.code })) return false;
  const now = new Date();
  const version = {
    number: 1,
    status: 'ACTIVE' as const,
    effectiveFrom: plan.version.effectiveFrom,
    effectiveTo: plan.version.effectiveTo,
    clientConfirmed: false,
    parentsAndInLawsMixed: plan.version.parentsAndInLawsMixed,
    slots: plan.version.slots.map((slot) => ({
      name: slot.name,
      min: slot.min,
      max: slot.max,
      relationships: slot.relationships.map((item) => ({ ...item })),
    })),
    createdAt: now,
    createdBy: null,
    activatedAt: now,
    activatedBy: null,
  };
  try {
    return await withTransaction(async (session) => {
      // timestamps off: an existing plan's updatedAt must not move either (14.7).
      const result = await FamilyPlanModel.updateOne(
        { product: plan.product, code: plan.code },
        {
          $setOnInsert: {
            product: plan.product,
            code: plan.code,
            name: plan.name,
            active: true,
            isDefault: true,
            openQuestions: plan.openQuestions,
            versions: [version],
            createdBy: null,
            updatedBy: null,
            createdAt: now,
            updatedAt: now,
            __v: 0,
          },
        },
        { upsert: true, session, timestamps: false },
      );
      if (!result.upsertedId) return false;
      await writeAudit(
        {
          userId: null,
          action: AUDIT_ACTIONS.FAMILY_PLAN_CREATED,
          entity: AUDIT_ENTITIES.FAMILY_PLAN,
          entityId: result.upsertedId.toHexString(),
          before: null,
          after: {
            code: plan.code,
            name: plan.name,
            product: plan.product,
            active: true,
            version: {
              number: 1,
              status: 'ACTIVE',
              effectiveFrom: version.effectiveFrom,
              effectiveTo: version.effectiveTo,
              clientConfirmed: false,
              parentsAndInLawsMixed: version.parentsAndInLawsMixed,
              slots: version.slots,
            },
          },
        },
        session,
      );
      return true;
    });
  } catch (error) {
    // Another instance created it at the same moment: it exists, which is all that is needed.
    if ((error as { code?: number }).code === 11000) return false;
    throw error;
  }
}
