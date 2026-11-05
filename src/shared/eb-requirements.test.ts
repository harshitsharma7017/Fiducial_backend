import { describe, expect, it } from 'vitest';
import {
  GpaRequirementsInputSchema,
  GtliRequirementsInputSchema,
  emptyGpaRequirements,
  emptyGtliRequirements,
  gpaCoverList,
  gpaMissing,
  gtliMissing,
} from './eb-requirements.ts';
import { compareGpaTerms, emptyGpaQuoteTerms } from './eb-quotes.ts';

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

  describe('adding and deleting covers (alteration 3/11/2026)', () => {
    const withCovers = () => ({
      ...sheet(),
      removedCovers: ['permanentPartial', 'temporaryTotal'],
      temporaryTotal: { weeklyBenefit: null, weeks: null },
      customCovers: [
        { id: 'c1', name: 'Medical expenses', choice: 'REQUIRED', limit: '10% of the claim' },
        { id: 'c2', name: 'Education benefit', choice: null, limit: null },
      ],
    });

    it('lists the standard covers not deleted, then the added ones', () => {
      const parsed = GpaRequirementsInputSchema.parse(withCovers());
      expect(gpaCoverList(parsed).map((cover) => [cover.key, cover.label, cover.choice])).toEqual([
        ['covers.accidentalDeath', 'Accidental death', 'REQUIRED'],
        ['covers.permanentTotal', 'Permanent total disablement', 'REQUIRED'],
        ['customCovers.c1', 'Medical expenses', 'REQUIRED'],
        ['customCovers.c2', 'Education benefit', null],
      ]);
      // A deleted cover is never missing; an added one without a choice is.
      expect(gpaMissing(parsed, { planHasDependants: false }).map((item) => item.field)).toEqual([
        'customCovers.c2',
      ]);
    });

    it('reads a sheet saved before covers could be added or deleted as the four standard ones', () => {
      const { removedCovers: _removed, customCovers: _custom, ...old } = emptyGpaRequirements();
      const parsed = GpaRequirementsInputSchema.parse(old);
      expect(parsed).toMatchObject({ removedCovers: [], customCovers: [] });
      expect(gpaCoverList(parsed)).toHaveLength(4);
    });

    it('refuses a nameless or repeated cover, and benefit details for a deleted TTD cover', () => {
      expect(
        paths(
          GpaRequirementsInputSchema.safeParse({
            ...withCovers(),
            customCovers: [
              { id: 'c1', name: '', choice: 'REQUIRED', limit: null },
              { id: 'c2', name: 'Accidental death', choice: 'REQUIRED', limit: null },
              { id: 'c3', name: 'Funeral', choice: 'REQUIRED', limit: null },
              { id: 'c4', name: 'funeral', choice: 'REQUIRED', limit: null },
            ],
          }),
        ),
      ).toEqual(['customCovers.0.name', 'customCovers.1.name', 'customCovers.3.name']);
      expect(
        paths(
          GpaRequirementsInputSchema.safeParse({
            ...withCovers(),
            temporaryTotal: { weeklyBenefit: '5000', weeks: null },
          }),
        ),
      ).toEqual(['temporaryTotal.weeklyBenefit']);
    });

    it('compares the quote cover by cover, the added ones included', () => {
      const parsed = GpaRequirementsInputSchema.parse(withCovers());
      const terms = {
        ...emptyGpaQuoteTerms(),
        customCovers: {
          c1: { offer: 'OFFERED' as const, limitAmount: null, limitText: '10% of the claim' },
        },
      };
      terms.covers.accidentalDeath = { offer: 'OFFERED', limitAmount: '2500000', limitText: null };
      expect(
        compareGpaTerms(parsed, terms).map((row) => [row.label, row.requested, row.kind]),
      ).toEqual([
        ['Accidental death', 'Required', 'MATCH'],
        ['Permanent total disablement', 'Required', 'MISSING'],
        ['Medical expenses', 'Required (10% of the claim)', 'MATCH'],
        ['Education benefit', 'Not stated', 'NOT_ASKED'],
      ]);
    });
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
