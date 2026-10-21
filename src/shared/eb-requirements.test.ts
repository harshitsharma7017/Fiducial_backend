import { describe, expect, it } from 'vitest';
import {
  GpaRequirementsInputSchema,
  GtliRequirementsInputSchema,
  emptyGpaRequirements,
  emptyGtliRequirements,
  gpaMissing,
  gtliMissing,
} from './eb-requirements.ts';

const paths = (result: { success: boolean; error?: { issues: Array<{ path: PropertyKey[] }> } }) =>
  result.success ? [] : (result.error?.issues ?? []).map((issue) => issue.path.join('.'));

describe('GPA Data Sheet (Requirement 4)', () => {
  const sheet = () => ({
    ...emptyGpaRequirements(),
    employeeCount: 120,
    sumInsuredBasis: { kind: 'SALARY_MULTIPLE', multiplier: '3', maximum: '2500000' },
    covers: {
      accidentalDeath: 'REQUIRED',
      permanentTotal: 'REQUIRED',
      permanentPartial: 'NOT_REQUIRED',
      temporaryTotal: 'REQUIRED',
    },
    temporaryTotal: { weeklyBenefit: '5000', weeks: 104 },
    dependantBasis: { kind: 'PERCENT_OF_EMPLOYEE', percent: '50' },
  });

  it('accepts a complete sheet and reads it back unchanged', () => {
    const parsed = GpaRequirementsInputSchema.parse(sheet());
    expect(GpaRequirementsInputSchema.parse(parsed)).toEqual(parsed);
    expect(gpaMissing(parsed, { planHasDependants: true })).toEqual([]);
  });

  it('refuses each invalid field, naming it', () => {
    const cases: Array<[unknown, string]> = [
      [
        {
          ...sheet(),
          sumInsuredBasis: { kind: 'SALARY_MULTIPLE', multiplier: '0', maximum: null },
        },
        'sumInsuredBasis.multiplier',
      ],
      [
        {
          ...sheet(),
          sumInsuredBasis: { kind: 'SALARY_MULTIPLE', multiplier: '100.01', maximum: null },
        },
        'sumInsuredBasis.multiplier',
      ],
      [
        { ...sheet(), sumInsuredBasis: { kind: 'GRADED', amounts: ['100000', '100000'] } },
        'sumInsuredBasis.amounts',
      ],
      [
        {
          ...sheet(),
          sumInsuredBasis: {
            kind: 'GRADED',
            amounts: Array.from({ length: 11 }, (_, i) => String(100000 + i)),
          },
        },
        'sumInsuredBasis.amounts',
      ],
      [
        { ...sheet(), sumInsuredBasis: { kind: 'FLAT', amount: '500000', amounts: ['1'] } },
        'sumInsuredBasis',
      ],
      [
        { ...sheet(), covers: { ...sheet().covers, temporaryTotal: 'NOT_REQUIRED' } },
        'temporaryTotal.weeklyBenefit',
      ],
      [
        { ...sheet(), dependantBasis: { kind: 'PERCENT_OF_EMPLOYEE', percent: '101' } },
        'dependantBasis.percent',
      ],
      [
        { ...sheet(), ageLimits: { ...sheet().ageLimits, employee: { min: 40, max: 30 } } },
        'ageLimits.employee.max',
      ],
      [
        {
          ...sheet(),
          claims: [
            {
              policyYear: '2025-26',
              insurer: null,
              livesCovered: null,
              premium: null,
              claimsPaid: null,
              claimsOutstanding: null,
              claimCount: null,
            },
            {
              policyYear: '2025-26',
              insurer: null,
              livesCovered: null,
              premium: null,
              claimsPaid: null,
              claimsOutstanding: null,
              claimCount: null,
            },
          ],
        },
        'claims',
      ],
      [{ ...sheet(), sumInsuredBasis: { kind: 'FLAT', amount: 500000 } }, 'sumInsuredBasis.amount'],
      [{ ...sheet(), maternity: { covered: true } }, ''],
    ];
    for (const [input, path] of cases) {
      const result = GpaRequirementsInputSchema.safeParse(input);
      expect(result.success, path).toBe(false);
      expect(paths(result), path).toContain(path);
    }
  });

  it('lists what is missing: basis, each unmarked cover, the dependant basis when the plan has dependants', () => {
    const empty = emptyGpaRequirements();
    expect(gpaMissing(empty, { planHasDependants: false }).map((item) => item.field)).toEqual([
      'sumInsuredBasis',
      'covers.accidentalDeath',
      'covers.permanentTotal',
      'covers.permanentPartial',
      'covers.temporaryTotal',
    ]);
    expect(gpaMissing(empty, { planHasDependants: true }).at(-1)?.field).toBe('dependantBasis');
  });
});

describe('GTLI Data Sheet (Requirement 5)', () => {
  it('refuses GPA and GMC fields, and lists what is missing', () => {
    const result = GtliRequirementsInputSchema.safeParse({
      ...emptyGtliRequirements(),
      covers: {},
    });
    expect(paths(result)).toContain('');
    const room = GtliRequirementsInputSchema.safeParse({
      ...emptyGtliRequirements(),
      roomRent: null,
    });
    expect(room.success).toBe(false);
    expect(
      gtliMissing(emptyGtliRequirements(), { renewal: true }).map((item) => item.field),
    ).toEqual(['employeeCount', 'sumInsuredBasis', 'claims']);
    const complete = GtliRequirementsInputSchema.parse({
      ...emptyGtliRequirements(),
      employeeCount: 10,
      sumInsuredBasis: { kind: 'FLAT', amount: '1000000' },
      freeCoverLimit: '2000000',
    });
    expect(gtliMissing(complete, { renewal: false })).toEqual([]);
  });
});
