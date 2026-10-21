import type { EbPlanAssignment, EbProduct } from '../../shared/index.ts';
import { FamilyPlanModel } from '../family-plans/family-plan.model.ts';
import type { PlanAssignmentDoc } from './ghi-case.model.ts';
import { nameOf, userNames } from './ghi-common.ts';

/**
 * A case's plan assignment as the API returns it: the copy stored on the case, with the plan
 * version's "client confirmed" flag as it is today (it may have changed since the assignment).
 */
export async function planView(
  assignment: PlanAssignmentDoc | null | undefined,
  product: EbProduct,
): Promise<EbPlanAssignment | null> {
  if (!assignment) return null;
  const [plan, names] = await Promise.all([
    FamilyPlanModel.findById(assignment.planId, { versions: 1 }).lean(),
    userNames([assignment.assignedBy]),
  ]);
  const version = plan?.versions.find((item) => item.number === assignment.versionNumber);
  return {
    planId: assignment.planId.toHexString(),
    code: assignment.code,
    name: assignment.name,
    product,
    versionNumber: assignment.versionNumber,
    effectiveFrom: assignment.effectiveFrom,
    slots: assignment.slots.map((slot) => ({
      name: slot.name,
      min: slot.min,
      max: slot.max,
      relationships: slot.relationships.map((item) => ({
        relationship: item.relationship,
        max: item.max,
      })),
    })),
    parentsAndInLawsMixed: assignment.parentsAndInLawsMixed,
    clientConfirmed: version?.clientConfirmed ?? false,
    openQuestions: assignment.openQuestions,
    source: assignment.source,
    assignedAt: assignment.assignedAt.toISOString(),
    assignedBy: assignment.assignedBy ? nameOf(names, assignment.assignedBy) : 'System',
  };
}
