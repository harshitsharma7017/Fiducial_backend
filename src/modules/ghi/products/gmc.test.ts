import { emptyGhiRequirements, emptyGhiQuoteTerms } from '../../../shared/index.ts';
import { describe, expect, it } from 'vitest';
import { compareTerms } from '../ghi-quote-calc.ts';
import { gmcFamilyCover } from './gmc.ts';

// Design D6: GMC's "parents covered" comes from the Data Sheet without a plan, from the plan with one.

const self = {
  name: 'Self',
  min: 1,
  max: 1,
  relationships: [{ relationship: 'SELF' as const, max: 1 }],
};
const parents = {
  name: 'Parents',
  min: 0,
  max: 2,
  relationships: [
    { relationship: 'FATHER' as const, max: 1 },
    { relationship: 'MOTHER_IN_LAW' as const, max: 1 },
  ],
};

describe('gmcFamilyCover', () => {
  it('uses the family definition without a plan', () => {
    const requirements = emptyGhiRequirements();
    expect(gmcFamilyCover({ requirements }).parentsCovered).toBe(false);
    requirements.familyDefinition.parents = 'EITHER';
    expect(gmcFamilyCover({ requirements }).parentsCovered).toBe(true);
  });

  it('uses the plan’s slots with one, whatever the family definition says', () => {
    const requirements = emptyGhiRequirements();
    expect(
      gmcFamilyCover({ requirements, planAssignment: { slots: [self, parents] } }).parentsCovered,
    ).toBe(true);
    requirements.familyDefinition.parents = 'PARENTS';
    expect(gmcFamilyCover({ requirements, planAssignment: { slots: [self] } }).parentsCovered).toBe(
      false,
    );
  });

  it('asks the co-payment in the QCR comparison only when parents are covered', () => {
    const requirements = { ...emptyGhiRequirements(), parentsCoPayPercent: '20' };
    const row = (covered: boolean) =>
      compareTerms(requirements, emptyGhiQuoteTerms(), covered).find(
        (item) => item.key === 'parentsCoPayPercent',
      );
    expect(row(false)?.kind).toBe('NOT_ASKED');
    expect(row(true)?.kind).toBe('MISSING');
  });
});
