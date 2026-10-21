import { describe, expect, it } from 'vitest';
import {
  candidateFromMember,
  candidateFromRow,
  checkEbCensus,
  ebMemberFromInput,
  memberCoverage,
  readEbCensusRow,
  type EbCensusContext,
  type EbCensusMember,
  type PlanRules,
} from './eb-census-rules.ts';
import { emptyRowValues, templateColumns, type EbCensusRowValues } from './eb-census.ts';
import { percentOfSumInsured, salaryMultipleSumInsured } from './eb-money.ts';
import {
  GPA_SAMPLE_RELATIONSHIP_RULES,
  GpaRequirementsInputSchema,
  emptyGpaRequirements,
  gpaMissing,
  type DependantBasis,
  type SumInsuredBasis,
} from './eb-requirements.ts';
import { DEFAULT_FAMILY_PLANS } from './family-plans.ts';

const noLimit = { min: null, max: null };
const planOf = (product: string, code: string): PlanRules => {
  const plan = DEFAULT_FAMILY_PLANS.find((item) => item.product === product && item.code === code)!;
  return {
    code,
    name: plan.name,
    versionNumber: 1,
    slots: plan.version.slots,
    parentsAndInLawsMixed: false,
  };
};
const byRelationship: DependantBasis = {
  kind: 'BY_RELATIONSHIP',
  rules: [...GPA_SAMPLE_RELATIONSHIP_RULES],
};

function gpa(
  basis: SumInsuredBasis | null,
  dependantBasis: DependantBasis | null,
  nominees?: 'EMPLOYEE_ROWS',
): EbCensusContext {
  return {
    product: 'GPA',
    family: { mode: 'PLAN', plan: planOf('GPA', '1+3') },
    members: { product: 'GPA', basis, dependantBasis, ...(nominees ? { nominees } : {}) },
    ageLimits: { employee: noLimit, spouse: noLimit, child: noLimit, parent: noLimit },
    referenceDate: '2026-04-01',
    today: '2026-10-21',
    identities: new Map(),
    unresolvedKeys: new Map(),
    deriveSumInsured: salaryMultipleSumInsured,
    percentOf: percentOfSumInsured,
    identityChecks: false,
  };
}
function gtli(basis: SumInsuredBasis, nominees?: 'EMPLOYEE_ROWS'): EbCensusContext {
  return {
    ...gpa(null, null),
    product: 'GTLI',
    family: { mode: 'PLAN', plan: planOf('GTLI', 'SELF') },
    members: { product: 'GTLI', basis, freeCoverLimit: null, ...(nominees ? { nominees } : {}) },
  };
}

const member = (
  relationship: EbCensusMember['relationship'],
  extra: Partial<EbCensusMember> = {},
): EbCensusMember => ({
  ...ebMemberFromInput({
    employeeId: 'E1',
    name: `${relationship} Nair`,
    gender: relationship === 'SPOUSE' ? 'FEMALE' : 'MALE',
    dateOfBirth: relationship === 'CHILD' ? '2015-01-01' : '1985-01-01',
    relationship,
    dateOfJoining: null,
    sumInsured: null,
  }),
  ...extra,
});
const issuesOf = (members: EbCensusMember[], context: EbCensusContext) => {
  const candidates = members.map((item, index) => candidateFromMember(String(index), item));
  const result = checkEbCensus(candidates, [], context);
  return candidates.map((candidate) => result.get(candidate.key) ?? []);
};

describe('GPA cover by relationship (N5)', () => {
  const context = gpa({ kind: 'FLAT', amount: '1000000' }, byRelationship);
  const self = member('SELF', { sumInsured: '1000000' });

  it('works out the employee, a spouse at 50% and each child at a fixed ₹50,000, with the basis', () => {
    expect(memberCoverage(self, self, context)).toEqual({
      amount: '1000000',
      basis: 'Flat sum insured',
    });
    expect(memberCoverage(member('SPOUSE'), self, context)).toEqual({
      amount: '500000',
      basis: '50% of the employee’s ₹10,00,000',
    });
    expect(memberCoverage(member('CHILD'), self, context)).toEqual({
      amount: '50000',
      basis: 'Fixed ₹50,000 for a child',
    });
  });

  it('follows other configured values, not the sample', () => {
    const other = gpa(
      { kind: 'FLAT', amount: '800000' },
      {
        kind: 'BY_RELATIONSHIP',
        rules: [
          { relationship: 'SPOUSE', kind: 'PERCENT_OF_EMPLOYEE', percent: '25' },
          { relationship: 'CHILD', kind: 'FIXED_AMOUNT', amount: '75000' },
        ],
      },
    );
    const employee = member('SELF', { sumInsured: '800000' });
    expect(memberCoverage(member('SPOUSE'), employee, other).amount).toBe('200000');
    expect(memberCoverage(member('CHILD'), employee, other).amount).toBe('75000');
  });

  it('refuses a typed amount that differs from the rule, and a relationship without a rule', () => {
    const [, spouse, child] = issuesOf(
      [self, member('SPOUSE', { sumInsured: '600000' }), member('CHILD', { sumInsured: '50000' })],
      context,
    );
    expect(spouse![0]).toMatchObject({ field: 'sumInsured', code: 'SUM_INSURED' });
    expect(child).toEqual([]);
    const spouseOnly = gpa(
      { kind: 'FLAT', amount: '1000000' },
      {
        kind: 'BY_RELATIONSHIP',
        rules: [{ relationship: 'SPOUSE', kind: 'PERCENT_OF_EMPLOYEE', percent: '50' }],
      },
    );
    expect(issuesOf([self, member('CHILD')], spouseOnly)[1]![0]!.message).toBe(
      'The Data Sheet has no cover rule for a child',
    );
  });

  it('refuses a relationship outside the plan as before', () => {
    expect(issuesOf([self, member('FATHER')], context)[1]![0]!.code).toBe(
      'RELATIONSHIP_NOT_COVERED',
    );
  });

  it('lists a missing rule for each relationship the plan covers, and validates the rules', () => {
    const sheet = {
      ...emptyGpaRequirements(),
      dependantBasis: {
        kind: 'BY_RELATIONSHIP' as const,
        rules: [GPA_SAMPLE_RELATIONSHIP_RULES[0]!],
      },
    };
    expect(
      gpaMissing(sheet, {
        planHasDependants: true,
        dependantRelationships: ['SELF', 'SPOUSE', 'CHILD'],
      })
        .filter((item) => item.field === 'dependantBasis.rules')
        .map((item) => item.label),
    ).toEqual(['The cover rule for Child (the plan covers this relationship)']);
    const parse = (rules: unknown[]) =>
      GpaRequirementsInputSchema.safeParse({
        ...emptyGpaRequirements(),
        dependantBasis: { kind: 'BY_RELATIONSHIP', rules },
      });
    expect(parse([...GPA_SAMPLE_RELATIONSHIP_RULES]).success).toBe(true);
    expect(
      parse([{ relationship: 'SPOUSE', kind: 'PERCENT_OF_EMPLOYEE', percent: '150' }]).success,
    ).toBe(false);
    expect(parse([{ relationship: 'CHILD', kind: 'FIXED_AMOUNT', amount: '0' }]).success).toBe(
      false,
    );
    expect(parse([{ relationship: 'SELF', kind: 'FIXED_AMOUNT', amount: '5000' }]).success).toBe(
      false,
    );
    expect(
      parse([
        { relationship: 'CHILD', kind: 'FIXED_AMOUNT', amount: '5000' },
        { relationship: 'CHILD', kind: 'FIXED_AMOUNT', amount: '6000' },
      ]).success,
    ).toBe(false);
  });
});

describe('GTLI sum assured from the monthly salary (N6)', () => {
  const basis = (multiplier: string, maximum: string | null): SumInsuredBasis => ({
    kind: 'SALARY_MULTIPLE',
    multiplier,
    maximum,
    salaryInput: 'MONTHLY',
  });

  it('turns ₹50,000 a month at 4 × into ₹24,00,000, showing each step', () => {
    expect(
      memberCoverage(member('SELF', { monthlySalary: '50000' }), null, gtli(basis('4', null))),
    ).toEqual({
      amount: '2400000',
      basis: '₹50,000 a month × 12 = ₹6,00,000 annual CTC × 4 = ₹24,00,000',
    });
  });

  it('follows other multipliers and the optional maximum', () => {
    const self = member('SELF', { monthlySalary: '50000' });
    expect(memberCoverage(self, null, gtli(basis('3', null))).amount).toBe('1800000');
    expect(memberCoverage(self, null, gtli(basis('2.5', null))).amount).toBe('1500000');
    expect(memberCoverage(self, null, gtli(basis('4', '2000000')))).toEqual({
      amount: '2000000',
      basis:
        '₹50,000 a month × 12 = ₹6,00,000 annual CTC × 4 = ₹24,00,000, capped at the maximum of ₹20,00,000',
    });
  });

  it('refuses a missing, negative or invalid monthly salary, and a typed amount that differs', () => {
    const context = gtli(basis('4', null));
    expect(issuesOf([member('SELF')], context)[0]![0]).toMatchObject({ field: 'monthlySalary' });
    expect(
      issuesOf([member('SELF', { monthlySalary: '50000', sumInsured: '2500000' })], context)[0]![0],
    ).toMatchObject({
      field: 'sumInsured',
    });
    expect(
      issuesOf(
        [member('SELF', { monthlySalary: '50000', annualSalary: '500000' })],
        context,
      )[0]![0],
    ).toMatchObject({
      field: 'annualSalary',
    });
    for (const text of ['-5000', '0', 'abc', '12.5']) {
      const read = readEbCensusRow(row({ monthlySalary: text }), {
        row: 2,
        today: '2026-10-21',
        assumeSelf: true,
      });
      expect(read.member).toBeNull();
      expect(read.issues.map((issue) => issue.field)).toEqual(['monthlySalary']);
    }
  });

  it('adds a Monthly Salary column to the template for the monthly input', () => {
    const keys = templateColumns('GTLI', planOf('GTLI', 'SELF').slots, basis('4', null), {
      nominees: 'EMPLOYEE_ROWS',
    }).map((column) => column.key);
    expect(keys).toContain('monthlySalary');
    expect(keys).not.toContain('annualSalary');
    expect(keys).toEqual(
      expect.arrayContaining([
        'nomineeName',
        'nomineeRelationship',
        'nomineeDateOfBirth',
        'nomineeAge',
      ]),
    );
  });
});

function row(values: Partial<EbCensusRowValues>): EbCensusRowValues {
  return {
    ...emptyRowValues(),
    employeeId: 'E1',
    name: 'Ravi Nair',
    gender: 'Male',
    dateOfBirth: '01/02/1985',
    relationship: 'Self',
    ...values,
  };
}

describe('nominees (N5, N6)', () => {
  const context = gtli({ kind: 'FLAT', amount: '1000000' }, 'EMPLOYEE_ROWS');

  it('reads a nominee from the census with a date of birth or an age', () => {
    const read = readEbCensusRow(
      row({
        sumInsured: '1000000',
        nomineeName: ' Meera  Nair ',
        nomineeRelationship: 'Wife',
        nomineeDateOfBirth: '03/04/1990',
      }),
      { row: 2, today: '2026-10-21', assumeSelf: true },
    );
    expect(read.issues).toEqual([]);
    expect(read.member?.nominee).toEqual({
      name: 'Meera Nair',
      relationship: 'SPOUSE',
      dateOfBirth: '1990-04-03',
      age: null,
    });
    const byAge = readEbCensusRow(
      row({ nomineeName: 'Asha', nomineeRelationship: 'Daughter', nomineeAge: '12' }),
      {
        row: 2,
        today: '2026-10-21',
        assumeSelf: true,
      },
    );
    expect(byAge.member?.nominee).toMatchObject({ age: 12, dateOfBirth: null });
  });

  it('refuses incomplete or invalid nominee details, each on its field', () => {
    const fields = (values: Partial<EbCensusRowValues>) =>
      readEbCensusRow(row(values), { row: 2, today: '2026-10-21', assumeSelf: true }).issues.map(
        (issue) => issue.field,
      );
    expect(fields({ nomineeName: 'Meera' })).toEqual(['nomineeRelationship', 'nomineeDateOfBirth']);
    expect(fields({ nomineeRelationship: 'Wife', nomineeAge: '30' })).toEqual(['nomineeName']);
    expect(fields({ nomineeName: 'M', nomineeRelationship: 'Cousin', nomineeAge: '30' })).toEqual([
      'nomineeRelationship',
    ]);
    expect(fields({ nomineeName: 'M', nomineeRelationship: 'Wife', nomineeAge: '130' })).toEqual([
      'nomineeAge',
    ]);
    expect(
      fields({ nomineeName: 'M', nomineeRelationship: 'Wife', nomineeDateOfBirth: '01/01/2030' }),
    ).toEqual(['nomineeDateOfBirth']);
  });

  it('requires a nominee on the employee’s row when the Data Sheet asks, and not otherwise', () => {
    const withoutNominee = member('SELF', { sumInsured: '1000000' });
    expect(issuesOf([withoutNominee], context)[0]![0]).toMatchObject({
      field: 'nomineeName',
      code: 'NOMINEE_REQUIRED',
    });
    const named = {
      ...withoutNominee,
      nominee: { name: 'Meera', relationship: 'SPOUSE' as const, dateOfBirth: null, age: 34 },
    };
    expect(issuesOf([named], context)[0]).toEqual([]);
    expect(issuesOf([withoutNominee], gtli({ kind: 'FLAT', amount: '1000000' }))[0]).toEqual([]);
  });

  it('never asks GMC for a nominee', () => {
    const gmc: EbCensusContext = {
      ...gpa(null, null),
      product: 'GMC',
      family: { mode: 'PLAN', plan: planOf('GMC', '1+3') },
      members: { product: 'GMC', coverageType: 'FLOATER', sumInsuredOptions: [] },
    };
    expect(issuesOf([member('SELF', { sumInsured: '500000' })], gmc)[0]).toEqual([]);
    const file = candidateFromRow(2, row({ sumInsured: '500000' }), gmc);
    expect(file.issues).toEqual([]);
  });
});
