import { describe, expect, it } from 'vitest';
import {
  checkCensus,
  parseCensusDate,
  readCensusRow,
  type CensusSettings,
} from './census-rules.ts';
import {
  candidateFromMember,
  candidateFromRow,
  checkEbCensus,
  ebMemberFromInput,
  familyShortfalls,
  freeCoverFlags,
  identityMismatches,
  issueSentence,
  memberSumInsured,
  readEbCensusRow,
  type EbCensusContext,
  type EbCensusMember,
  type PlanRules,
} from './eb-census-rules.ts';
import { emptyRowValues, type EbCensusRowValues } from './eb-census.ts';
import { percentOfSumInsured, salaryMultipleSumInsured } from './eb-money.ts';
import { DEFAULT_FAMILY_PLANS } from './family-plans.ts';

const noLimit = { min: null, max: null };
const defaultPlan = (product: string, code: string): PlanRules => {
  const plan = DEFAULT_FAMILY_PLANS.find((item) => item.product === product && item.code === code)!;
  return {
    code: plan.code,
    name: plan.name,
    versionNumber: 1,
    slots: plan.version.slots,
    parentsAndInLawsMixed: plan.version.parentsAndInLawsMixed,
  };
};

function context(overrides: Partial<EbCensusContext> = {}): EbCensusContext {
  return {
    product: 'GPA',
    family: { mode: 'PLAN', plan: defaultPlan('GPA', '1+3') },
    members: { product: 'GPA', basis: null, dependantBasis: null },
    ageLimits: { employee: noLimit, spouse: noLimit, child: noLimit, parent: noLimit },
    referenceDate: '2026-04-01',
    today: '2026-10-16',
    identities: new Map(),
    unresolvedKeys: new Map(),
    deriveSumInsured: salaryMultipleSumInsured,
    percentOf: percentOfSumInsured,
    identityChecks: true,
    ...overrides,
  };
}

const row = (values: Partial<EbCensusRowValues>): EbCensusRowValues => ({
  ...emptyRowValues(),
  employeeId: 'E1023',
  name: 'Ravi Nair',
  gender: 'Male',
  dateOfBirth: '01/02/1985',
  relationship: 'Self',
  sumInsured: '500000',
  ...values,
});

function check(
  rows: Array<Partial<EbCensusRowValues>>,
  ctx = context(),
  existing: EbCensusMember[] = [],
) {
  const candidates = rows.map((values, index) => candidateFromRow(index + 2, row(values), ctx));
  const result = checkEbCensus(candidates, existing, ctx);
  return candidates.map((candidate) => result.get(candidate.key) ?? []);
}

describe('dates (Requirement 20.6, 20.7)', () => {
  it('reads 03/04/1990 day first as 3 April 1990', () => {
    expect(parseCensusDate('03/04/1990')).toEqual({ ok: true, date: '1990-04-03' });
    expect(parseCensusDate('3 April 1990')).toEqual({ ok: true, date: '1990-04-03' });
    expect(parseCensusDate('03-Apr-1990')).toEqual({ ok: true, date: '1990-04-03' });
    expect(parseCensusDate('1990-04-03')).toEqual({ ok: true, date: '1990-04-03' });
    expect(parseCensusDate('32964')).toEqual({ ok: true, date: '1990-04-01' });
  });

  it('refuses 12/31/1990, 31/02/1990 and two-digit years', () => {
    expect(parseCensusDate('12/31/1990').ok).toBe(false);
    expect(parseCensusDate('31/02/1990').ok).toBe(false);
    expect(parseCensusDate('03/04/90')).toEqual({
      ok: false,
      message: 'Write the year in full, for example 1988',
    });
  });

  it('refuses a date of birth or joining after today, on its own field', () => {
    const read = readEbCensusRow(row({ dateOfBirth: '01/01/2027', dateOfJoining: '17/10/2026' }), {
      row: 5,
      today: '2026-10-16',
      assumeSelf: false,
    });
    expect(read.member).toBeNull();
    expect(read.issues.map((issue) => [issue.field, issue.message])).toEqual([
      ['dateOfBirth', 'The date of birth is after today'],
      ['dateOfJoining', 'The date of joining is after today'],
    ]);
    expect(read.issues[0]).toMatchObject({ row: 5, employeeId: 'E1023', value: '01/01/2027' });
  });

  it('reads the annual salary and assumes Self when the plan accepts only Self', () => {
    const read = readEbCensusRow(row({ relationship: '', annualSalary: '6,00,000' }), {
      row: 2,
      today: '2026-10-16',
      assumeSelf: true,
    });
    expect(read.member).toMatchObject({ relationship: 'SELF', annualSalary: '600000' });
    const bad = readEbCensusRow(row({ annualSalary: '12.5' }), {
      row: 2,
      today: '2026-10-16',
      assumeSelf: false,
    });
    expect(bad.issues.map((issue) => issue.field)).toEqual(['annualSalary']);
  });
});

describe('families in plan mode (Requirement 18)', () => {
  it('gives the Requirement 18.7 sample message for a fourth child', () => {
    const issues = check([
      {},
      { name: 'Asha Nair', relationship: 'Child', gender: 'Female', dateOfBirth: '01/01/2015' },
      { name: 'Anil Nair', relationship: 'Child', dateOfBirth: '01/01/2016' },
      { name: 'Arun Nair', relationship: 'Child', dateOfBirth: '01/01/2017' },
      { name: 'Priya Nair', relationship: 'Child', gender: 'Female', dateOfBirth: '01/01/2018' },
    ]);
    const candidate = candidateFromRow(14, row({}), context());
    expect(candidate.row).toBe(14);
    expect(issues.slice(0, 4).every((list) => list.length === 0)).toBe(true);
    expect(issueSentence({ ...issues[4]![0]!, row: 14 })).toBe(
      'Row 14, employee E1023, Priya Nair (Child): employee E1023 already has 3 children; the plan GPA 1+3 v1 allows at most 3. Remove the row or change the plan.',
    );
  });

  it('refuses a relationship the plan does not cover and never applies the GMC child limit', () => {
    const issues = check([
      {},
      { name: 'Gopal Nair', relationship: 'Father', dateOfBirth: '01/01/1950' },
    ]);
    expect(issues[1]![0]).toMatchObject({
      code: 'RELATIONSHIP_NOT_COVERED',
      field: 'relationship',
    });
    const wide: PlanRules = {
      ...defaultPlan('GPA', '1+3'),
      slots: [
        defaultPlan('GPA', '1+3').slots[0]!,
        { name: 'Children', min: 0, max: 6, relationships: [{ relationship: 'CHILD', max: 6 }] },
      ],
    };
    const children = Array.from({ length: 5 }, (_, index) => ({
      name: `Child ${index}`,
      relationship: 'Child',
      dateOfBirth: `01/01/201${index}`,
    }));
    const result = check([{}, ...children], context({ family: { mode: 'PLAN', plan: wide } }));
    expect(result.every((list) => list.length === 0)).toBe(true);
  });

  it('refuses a 1+5 family with three parents, and passes a 1+7 family with four', () => {
    const parents = [
      { name: 'Gopal', relationship: 'Father', dateOfBirth: '01/01/1950' },
      { name: 'Lata', relationship: 'Mother', gender: 'Female', dateOfBirth: '01/01/1952' },
      { name: 'Mohan', relationship: 'Father-in-law', dateOfBirth: '01/01/1949' },
      { name: 'Sita', relationship: 'Mother-in-law', gender: 'Female', dateOfBirth: '01/01/1951' },
    ];
    const gmc = (code: string) =>
      context({
        product: 'GMC',
        family: { mode: 'PLAN', plan: defaultPlan('GMC', code) },
        members: { product: 'GMC', coverageType: 'FLOATER', sumInsuredOptions: [] },
      });
    const fivePlan = check([{}, ...parents.slice(0, 3)], gmc('1+5'));
    expect(fivePlan[3]![0]).toMatchObject({ code: 'SLOT_LIMIT' });
    expect(check([{}, ...parents], gmc('1+7')).every((list) => list.length === 0)).toBe(true);
    const twice = check([{}, parents[0]!, { ...parents[0]!, name: 'Gopal K' }], gmc('1+7'));
    expect(twice[2]![0]).toMatchObject({ code: 'RELATIONSHIP_LIMIT' });
  });

  it('refuses parents mixed with parents-in-law when the plan forbids mixing', () => {
    const plan = { ...defaultPlan('GMC', '1+5'), parentsAndInLawsMixed: false };
    const issues = check(
      [
        {},
        { name: 'Gopal', relationship: 'Father', dateOfBirth: '01/01/1950' },
        {
          name: 'Sita',
          relationship: 'Mother-in-law',
          gender: 'Female',
          dateOfBirth: '01/01/1951',
        },
      ],
      context({
        product: 'GMC',
        family: { mode: 'PLAN', plan },
        members: { product: 'GMC', coverageType: 'FLOATER', sumInsuredOptions: [] },
      }),
    );
    expect(issues[1]).toEqual([]);
    expect(issues[2]![0]).toMatchObject({ code: 'PARENTS_MIXED', relationship: 'MOTHER_IN_LAW' });
  });

  it('refuses a dependant without its employee, naming the failing Self row', () => {
    const missing = check([{ relationship: 'Spouse', gender: 'Female', name: 'Meera' }]);
    expect(missing[0]![0]!.message).toBe('No employee (Self) row for employee ID E1023');
    const failing = check([
      { gender: 'X' },
      { relationship: 'Spouse', gender: 'Female', name: 'Meera' },
    ]);
    expect(failing[1]![0]!.message).toBe('The employee’s own row (row 2) has errors');
  });

  it('refuses exact duplicates in the file and against the census, keeping the first', () => {
    const issues = check([
      {},
      { relationship: 'Spouse', gender: 'Female', name: 'Meera' },
      { relationship: 'Spouse', gender: 'Female', name: '  MEERA ' },
    ]);
    expect(issues[1]).toEqual([]);
    expect(issues[2]![0]).toMatchObject({ code: 'DUPLICATE' });
    const existing = [
      ebMemberFromInput({
        employeeId: 'E1023',
        name: 'Ravi Nair',
        gender: 'MALE',
        dateOfBirth: '1985-02-01',
        relationship: 'SELF',
        dateOfJoining: null,
        sumInsured: '500000',
      }),
    ];
    const again = check([{}], context(), existing);
    expect(again[0]![0]).toMatchObject({
      code: 'DUPLICATE',
      message: expect.stringContaining('already in the census'),
    });
  });

  it('applies the gender and age checks on every product', () => {
    const ctx = context({
      ageLimits: {
        employee: { min: 18, max: 40 },
        spouse: noLimit,
        child: noLimit,
        parent: noLimit,
      },
    });
    const issues = check([{ dateOfBirth: '01/02/1960' }], ctx);
    expect(issues[0]![0]).toMatchObject({ field: 'dateOfBirth', code: 'AGE_LIMIT' });
    const gmc = context({
      product: 'GMC',
      family: { mode: 'PLAN', plan: defaultPlan('GMC', '1+5') },
      members: { product: 'GMC', coverageType: 'FLOATER', sumInsuredOptions: [] },
    });
    const gender = check(
      [{}, { name: 'Gopal', relationship: 'Father', gender: 'Female', dateOfBirth: '01/01/1950' }],
      gmc,
    );
    expect(gender[1]![0]).toMatchObject({ field: 'gender', message: 'A father cannot be Female' });
  });
});

describe('sums insured by basis (Requirements 4.2, 4.5, 18.3)', () => {
  it('needs the flat amount, one of the graded amounts, or a salary', () => {
    const flat = context({
      members: { product: 'GPA', basis: { kind: 'FLAT', amount: '500000' }, dependantBasis: null },
    });
    expect(check([{ sumInsured: '400000' }], flat)[0]![0]).toMatchObject({ field: 'sumInsured' });
    expect(check([{}], flat)[0]).toEqual([]);
    const graded = context({
      members: {
        product: 'GPA',
        basis: { kind: 'GRADED', amounts: ['300000', '500000'] },
        dependantBasis: null,
      },
    });
    expect(check([{}], graded)[0]).toEqual([]);
    expect(check([{ sumInsured: '' }], graded)[0]![0]).toMatchObject({ field: 'sumInsured' });
    const salary = context({
      members: {
        product: 'GPA',
        basis: { kind: 'SALARY_MULTIPLE', multiplier: '2.5', maximum: '1000000' },
        dependantBasis: null,
      },
    });
    expect(check([{ sumInsured: '' }], salary)[0]![0]).toMatchObject({ field: 'annualSalary' });
    expect(check([{ sumInsured: '', annualSalary: '300000' }], salary)[0]).toEqual([]);
    expect(check([{ sumInsured: '750000', annualSalary: '300000' }], salary)[0]).toEqual([]);
    expect(check([{ sumInsured: '1000000', annualSalary: '600000' }], salary)[0]).toEqual([]);
    expect(check([{ sumInsured: '700000', annualSalary: '300000' }], salary)[0]![0]).toMatchObject({
      field: 'sumInsured',
    });
  });

  it('checks GPA dependants by the dependant basis', () => {
    const percent = context({
      members: {
        product: 'GPA',
        basis: { kind: 'FLAT', amount: '500000' },
        dependantBasis: { kind: 'PERCENT_OF_EMPLOYEE', percent: '50' },
      },
    });
    const spouse = { relationship: 'Spouse', gender: 'Female', name: 'Meera' };
    expect(check([{}, { ...spouse, sumInsured: '' }], percent)[1]).toEqual([]);
    expect(check([{}, { ...spouse, sumInsured: '250000' }], percent)[1]).toEqual([]);
    expect(check([{}, { ...spouse, sumInsured: '300000' }], percent)[1]![0]).toMatchObject({
      field: 'sumInsured',
    });
    const own = context({
      members: { product: 'GPA', basis: null, dependantBasis: { kind: 'OWN_AMOUNT' } },
    });
    expect(check([{}, { ...spouse, sumInsured: '' }], own)[1]![0]).toMatchObject({
      field: 'sumInsured',
    });
    const self = ebMemberFromInput({
      employeeId: 'E1',
      name: 'A',
      gender: 'MALE',
      dateOfBirth: '1980-01-01',
      relationship: 'SELF',
      dateOfJoining: null,
      sumInsured: '500000',
    });
    const dependant = { ...self, relationship: 'SPOUSE' as const, sumInsured: null };
    expect(memberSumInsured(dependant, self, percent)).toBe('250000');
  });
});

describe('identity (Requirement 17.5, 17.12)', () => {
  const identity = {
    employeeId: 'E1023',
    name: 'Ravi  NAIR',
    nameKey: 'ravi nair',
    gender: 'MALE' as const,
    dateOfBirth: '1985-02-01',
  };

  it('compares the name ignoring case and repeated spaces, the gender and the date of birth, never joining', () => {
    expect(
      identityMismatches(identity, {
        name: 'ravi nair',
        gender: 'MALE',
        dateOfBirth: '1985-02-01',
      }),
    ).toEqual([]);
    expect(
      identityMismatches(identity, {
        name: 'Ravi K Nair',
        gender: 'FEMALE',
        dateOfBirth: '1985-02-02',
      }).map((item) => item.field),
    ).toEqual(['name', 'gender', 'dateOfBirth']);
  });

  it('refuses a Self row that differs from the identity or whose key is unresolved', () => {
    const ctx = context({ identities: new Map([['E1023', identity]]) });
    expect(check([{}], ctx)[0]).toEqual([]);
    const differs = check([{ dateOfBirth: '02/02/1985' }], ctx)[0]!;
    expect(differs[0]).toMatchObject({ field: 'dateOfBirth', code: 'IDENTITY_MISMATCH' });
    expect(differs[0]!.message).toContain('"1985-02-01" there, "1985-02-02" here');
    const unresolved = check(
      [{}],
      context({ unresolvedKeys: new Map([['E1023', ['GHI-2026-0001', 'GPA-2026-0002']]]) }),
    )[0]!;
    expect(unresolved[0]).toMatchObject({ code: 'EMPLOYEE_UNRESOLVED' });
    expect(
      check(
        [{}],
        context({ identityChecks: false, unresolvedKeys: new Map([['E1023', ['X']]]) }),
      )[0],
    ).toEqual([]);
  });
});

describe('free cover limit and shortfalls (Requirements 5.3, 18.9)', () => {
  it('flags only members strictly above the limit, as warnings', () => {
    expect(
      freeCoverFlags(
        [
          { key: 'a', sumInsured: '500000' },
          { key: 'b', sumInsured: '500001' },
          { key: 'c', sumInsured: null },
        ],
        '500000',
      ),
    ).toEqual({ flagged: ['b'], count: 1 });
    const gtli = context({
      product: 'GTLI',
      family: { mode: 'PLAN', plan: defaultPlan('GTLI', 'SELF') },
      members: {
        product: 'GTLI',
        basis: { kind: 'FLAT', amount: '600000' },
        freeCoverLimit: '500000',
      },
    });
    const issues = check([{ sumInsured: '600000', relationship: '' }], gtli)[0]!;
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: 'WARNING', code: 'ABOVE_FREE_COVER_LIMIT' });
  });

  it('reports each family below a slot minimum', () => {
    const plan: PlanRules = {
      ...defaultPlan('GPA', '1+3'),
      slots: [
        defaultPlan('GPA', '1+3').slots[0]!,
        { name: 'Spouse', min: 1, max: 1, relationships: [{ relationship: 'SPOUSE', max: 1 }] },
      ],
    };
    const self = ebMemberFromInput({
      employeeId: 'E1',
      name: 'A',
      gender: 'MALE',
      dateOfBirth: '1980-01-01',
      relationship: 'SELF',
      dateOfJoining: null,
      sumInsured: '1',
    });
    expect(familyShortfalls([self], plan)).toEqual([
      expect.objectContaining({ employeeId: 'E1', slot: 'Spouse', count: 0, min: 1 }),
    ]);
  });
});

describe('GMC legacy mode (Requirement 16.3)', () => {
  const settings: CensusSettings = {
    familyDefinition: { spouse: true, maxChildren: 2, parents: 'PARENTS' },
    coverageType: 'FLOATER',
    sumInsuredOptions: ['500000'],
    ageLimits: { employee: noLimit, spouse: noLimit, child: noLimit, parent: noLimit },
    referenceDate: '2026-04-01',
    today: '2026-10-16',
  };
  const legacy = context({
    product: 'GMC',
    family: { mode: 'LEGACY', settings },
    members: { product: 'GMC', coverageType: 'FLOATER', sumInsuredOptions: ['500000'] },
    identityChecks: false,
  });

  it('gives the same fields and messages as checkCensus', () => {
    const rows = [
      {},
      { name: 'A', relationship: 'Child', dateOfBirth: '01/01/2015' },
      { name: 'B', relationship: 'Child', dateOfBirth: '01/01/2016' },
      { name: 'C', relationship: 'Child', dateOfBirth: '01/01/2017' },
      { name: 'D', relationship: 'Mother-in-law', gender: 'Female', dateOfBirth: '01/01/1950' },
      { gender: 'Q', employeeId: 'E9' },
    ];
    const ours = check(rows, legacy);
    const theirs = checkCensus(
      rows.map((values, index) => {
        const read = readCensusRow(row(values));
        return {
          key: String(index + 2),
          label: `row ${index + 2}`,
          member: read.member,
          issues: read.issues,
        };
      }),
      [],
      settings,
    );
    expect(ours.map((list) => list.map((issue) => [issue.field, issue.message]))).toEqual(
      rows.map((_, index) =>
        (theirs.get(String(index + 2)) ?? []).map((issue) => [issue.field, issue.message]),
      ),
    );
  });

  it('adds the identity checks of design D7 when they are on', () => {
    const identity = {
      employeeId: 'E1023',
      name: 'Someone Else',
      nameKey: 'someone else',
      gender: 'MALE' as const,
      dateOfBirth: '1985-02-01',
    };
    const issues = check([{}, { name: 'Meera', relationship: 'Spouse', gender: 'Female' }], {
      ...legacy,
      identityChecks: true,
      identities: new Map([['E1023', identity]]),
    });
    expect(issues[0]![0]).toMatchObject({ code: 'IDENTITY_MISMATCH', field: 'name' });
    expect(issues[1]![0]!.message).toBe('The employee’s own row (row 2) has errors: fix it first');
  });

  it('checks a typed member the same way as a one-row file', () => {
    const member = ebMemberFromInput({
      employeeId: 'E1',
      name: 'Asha',
      gender: 'FEMALE',
      dateOfBirth: '1990-01-01',
      relationship: 'SELF',
      dateOfJoining: null,
      sumInsured: '400000',
    });
    const typed = checkEbCensus([candidateFromMember('m', member)], [], legacy).get('m');
    expect(typed?.map((issue) => issue.field)).toEqual(['sumInsured']);
  });
});
