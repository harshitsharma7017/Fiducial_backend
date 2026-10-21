import { describe, expect, it } from 'vitest';
import { candidateFromRow, ebMemberFromInput, type EbCensusContext } from './eb-census-rules.ts';
import { emptyRowValues, type EbCensusRowValues } from './eb-census.ts';
import {
  applyImportPlan,
  applyPolicy,
  classifyImport,
  importResultOf,
  selfKeysAdded,
  type ExistingMember,
} from './eb-import-plan.ts';
import { percentOfSumInsured, salaryMultipleSumInsured } from './eb-money.ts';
import { DEFAULT_FAMILY_PLANS } from './family-plans.ts';

const plan = DEFAULT_FAMILY_PLANS.find((item) => item.product === 'GPA' && item.code === '1+3')!;
const noLimit = { min: null, max: null };
const context: EbCensusContext = {
  product: 'GPA',
  family: {
    mode: 'PLAN',
    plan: {
      code: plan.code,
      name: plan.name,
      versionNumber: 1,
      slots: plan.version.slots,
      parentsAndInLawsMixed: false,
    },
  },
  members: { product: 'GPA', basis: null, dependantBasis: null },
  ageLimits: { employee: noLimit, spouse: noLimit, child: noLimit, parent: noLimit },
  referenceDate: '2026-04-01',
  today: '2026-10-16',
  identities: new Map(),
  unresolvedKeys: new Map(),
  deriveSumInsured: salaryMultipleSumInsured,
  percentOf: percentOfSumInsured,
  identityChecks: true,
};

const values = (overrides: Partial<EbCensusRowValues>): EbCensusRowValues => ({
  ...emptyRowValues(),
  employeeId: 'E1',
  name: 'Ravi Nair',
  gender: 'Male',
  dateOfBirth: '01/02/1985',
  relationship: 'Self',
  sumInsured: '500000',
  ...overrides,
});
const rowsOf = (list: Array<Partial<EbCensusRowValues>>) =>
  list.map((item, index) => candidateFromRow(index + 2, values(item), context));

const self = (): ExistingMember => ({
  ...ebMemberFromInput({
    employeeId: 'E1',
    name: 'Ravi Nair',
    gender: 'MALE',
    dateOfBirth: '1985-02-01',
    relationship: 'SELF',
    dateOfJoining: null,
    sumInsured: '500000',
  }),
  id: 'm1',
  employeeIdentityId: 'i1',
});

describe('classifyImport (Requirement 22)', () => {
  it('reports identical rows as unchanged and adds nothing on a re-import', () => {
    for (const mode of ['ADD_NEW_ONLY', 'ADD_AND_UPDATE'] as const) {
      const plan = classifyImport(rowsOf([{}]), [self()], context, mode);
      expect(plan.rows[0]).toMatchObject({ match: 'SAME', issues: [] });
      expect(plan.add).toEqual([]);
      expect(plan.update).toEqual([]);
      expect(plan.unchanged).toEqual(['2']);
    }
  });

  it('refuses a changed row under Add new only, naming the member’s and the row’s value', () => {
    const plan = classifyImport(
      rowsOf([{ sumInsured: '700000' }]),
      [self()],
      context,
      'ADD_NEW_ONLY',
    );
    expect(plan.rows[0]!.match).toBe('CHANGED');
    expect(plan.rows[0]!.issues[0]).toMatchObject({ field: 'sumInsured', code: 'MEMBER_CHANGED' });
    expect(plan.rows[0]!.issues[0]!.message).toContain('500000');
    expect(plan.rows[0]!.issues[0]!.message).toContain('700000');
    expect(plan.rows[0]!.issues[0]!.fix).toContain('Add and update');
  });

  it('updates only sum insured, salary and joining date under Add and update', () => {
    const plan = classifyImport(
      rowsOf([{ sumInsured: '700000', dateOfJoining: '01/04/2020' }]),
      [self()],
      context,
      'ADD_AND_UPDATE',
    );
    expect(plan.update).toEqual([
      {
        key: '2',
        memberId: 'm1',
        changes: { sumInsured: '700000', annualSalary: null, dateOfJoining: '2020-04-01' },
      },
    ]);
    const after = applyImportPlan([self()], { add: [], update: plan.update });
    expect(after[0]).toEqual({ ...self(), sumInsured: '700000', dateOfJoining: '2020-04-01' });
  });

  it('adds new rows checked against the census, keeping existing members in their places', () => {
    const spouse = {
      relationship: 'Spouse',
      gender: 'Female',
      name: 'Meera Nair',
      dateOfBirth: '01/01/1988',
    };
    const existing = [
      self(),
      {
        ...self(),
        ...ebMemberFromInput({
          employeeId: 'E1',
          name: 'Anu Nair',
          gender: 'FEMALE',
          dateOfBirth: '1987-01-01',
          relationship: 'SPOUSE',
          dateOfJoining: null,
          sumInsured: null,
        }),
        id: 'm2',
        employeeIdentityId: null,
      },
    ];
    const plan = classifyImport(rowsOf([{}, spouse]), existing, context, 'ADD_NEW_ONLY');
    expect(plan.rows.map((row) => row.match)).toEqual(['SAME', 'NEW']);
    expect(plan.rows[1]!.issues[0]).toMatchObject({ code: 'RELATIONSHIP_LIMIT' });
  });
});

describe('import policy and counts (Requirements 22.1, 22.4, 22.10)', () => {
  const rows = rowsOf([
    { employeeId: 'E2', name: 'Asha' },
    { employeeId: 'E3', name: 'Bala', gender: 'Q' },
    { employeeId: 'E3', name: 'Bala Wife', relationship: 'Spouse', gender: 'Female' },
  ]);
  const plan = classifyImport(rows, [], context, 'ADD_NEW_ONLY');

  it('All valid refuses with the invalid count; Valid only leaves out invalid rows and their dependants', () => {
    expect(applyPolicy(plan, 'ALL_VALID')).toEqual({
      ok: false,
      reason: 'INVALID_ROWS',
      invalid: 2,
    });
    const outcome = applyPolicy(plan, 'VALID_ONLY');
    if (!outcome.ok) throw new Error('expected an import');
    expect(outcome.add.map((item) => item.key)).toEqual(['2']);
    expect(outcome.skipped.map((row) => row.key)).toEqual(['3', '4']);
    const result = importResultOf(outcome, { created: 1, reused: 0 });
    expect(result.added + result.updated + result.unchanged + result.skipped).toBe(rows.length);
    expect(result.identitiesCreated + result.identitiesReused).toBe(
      selfKeysAdded(outcome.add).length,
    );
    expect(result.leftOut.map((item) => item.row)).toEqual([3, 4]);
  });

  it('refuses when no row is valid', () => {
    const bad = classifyImport(rowsOf([{ gender: 'Q' }]), [], context, 'ADD_NEW_ONLY');
    expect(applyPolicy(bad, 'VALID_ONLY')).toEqual({
      ok: false,
      reason: 'NO_VALID_ROWS',
      invalid: 1,
    });
  });

  it('gives the census after the import with identities on the Self members added', () => {
    const outcome = applyPolicy(plan, 'VALID_ONLY');
    if (!outcome.ok) throw new Error('expected an import');
    const after = applyImportPlan([], outcome, new Map([['E2', 'identity-E2']]));
    expect(after).toHaveLength(1);
    expect(after[0]!.employeeIdentityId).toBe('identity-E2');
  });
});
