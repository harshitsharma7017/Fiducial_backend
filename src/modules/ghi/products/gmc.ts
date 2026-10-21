import {
  planAcceptsParents,
  type GhiRequirementsInput,
  type PlanSlot,
} from '../../../shared/index.ts';

// GMC's profile rules that depend on the plan (design D6). Wherever GMC asks "does the cover
// include parents?" (the co-payment row of the QCR, the Data Sheet's co-payment item and check,
// and the documents), this one helper answers: from the Data Sheet's family definition when the
// case has no plan, exactly as before; from the assigned plan's slots when it has one
// (Requirement 16.4 makes the plan the source of the family definition).

export interface GmcFamilySource {
  requirements: Pick<GhiRequirementsInput, 'familyDefinition'>;
  planAssignment?: { slots: readonly Pick<PlanSlot, 'relationships'>[] } | null;
}

export function gmcFamilyCover(doc: GmcFamilySource): { parentsCovered: boolean } {
  if (doc.planAssignment) return { parentsCovered: planAcceptsParents(doc.planAssignment.slots) };
  return { parentsCovered: doc.requirements.familyDefinition.parents !== 'NONE' };
}
