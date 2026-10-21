import { describe, expect, it } from 'vitest';
import { DEFAULT_AGE_BAND_SETS } from './age-bands.ts';
import { buildSelectionSummary, type SelectionMember } from './rfq-summary.ts';

const custom = DEFAULT_AGE_BAND_SETS.find((set) => set.seedKey === 'CUSTOM_EXAMPLE')!.bands;
const reference = '2026-04-01';
const member = (
  employeeKey: string,
  relationship: SelectionMember['relationship'],
  dateOfBirth: string | null,
  cover: string | null,
  gender: SelectionMember['gender'] = 'MALE',
): SelectionMember => ({ employeeKey, relationship, gender, dateOfBirth, cover });

describe('RFQ selection summary (N7)', () => {
  // Two GPA families: E1 (₹10L, spouse 50%, child ₹50,000) and E2 (₹5L, no dependants).
  const gpa = [
    member('E1', 'SELF', '1985-06-01', '1000000'), // 40 → 36–45
    member('E1', 'SPOUSE', '1988-06-01', '500000', 'FEMALE'), // 37 → 36–45
    member('E1', 'CHILD', '2015-06-01', '50000', 'FEMALE'), // 10 → 0–35
    member('E2', 'SELF', '1978-04-01', '500000'), // 48 → 46–50
  ];

  it('counts employees, lives, categories and the matrix exactly, and reconciles', () => {
    const summary = buildSelectionSummary({
      product: 'GPA',
      floater: false,
      bands: custom,
      referenceDate: reference,
      members: gpa,
    });
    expect(summary.categories).toEqual(['50000', '500000', '1000000']);
    expect(summary.coverage).toEqual({
      rows: [
        { amount: '50000', employees: 0, lives: 1, total: '50000' },
        { amount: '500000', employees: 1, lives: 2, total: '1000000' },
        { amount: '1000000', employees: 1, lives: 1, total: '1000000' },
      ],
      employees: 2,
      lives: 4,
      total: '2050000',
    });
    expect(
      summary.matrix.rows.map((row) => [row.label, row.lives, row.totalLives, row.totalCover]),
    ).toEqual([
      ['0–35', [1, 0, 0], 1, '50000'],
      ['36–45', [0, 1, 1], 2, '1500000'],
      ['46–50', [0, 1, 0], 1, '500000'],
    ]);
    expect(summary.matrix.totals).toEqual({
      lives: [1, 2, 1],
      cover: ['50000', '1000000', '1000000'],
      totalLives: 4,
      totalCover: '2050000',
    });
    expect(summary.genders).toEqual({ MALE: 2, FEMALE: 2, OTHER: 0 });
    expect(summary.relationships).toMatchObject({ SELF: 2, SPOUSE: 1, CHILD: 1, FATHER: 0 });
    expect(summary.byRelationship).toEqual([
      { relationship: 'SELF', lives: 2, total: '1500000' },
      { relationship: 'SPOUSE', lives: 1, total: '500000' },
      { relationship: 'CHILD', lives: 1, total: '50000' },
    ]);
    expect(summary.measure).toBe('SUM_INSURED');
    expect(summary.problems).toEqual([]);
    expect(summary.reconciled).toBe(true);
  });

  it('calls GTLI cover a sum assured', () => {
    const summary = buildSelectionSummary({
      product: 'GTLI',
      floater: false,
      bands: custom,
      referenceDate: reference,
      members: [member('E1', 'SELF', '1990-01-01', '2400000')],
    });
    expect(summary.measure).toBe('SUM_ASSURED');
    expect(summary.coverage.total).toBe('2400000');
  });

  it('counts a floater family’s sum insured once and gives no per-band amount', () => {
    const summary = buildSelectionSummary({
      product: 'GMC',
      floater: true,
      bands: custom,
      referenceDate: reference,
      members: [
        member('E1', 'SELF', '1985-06-01', '300000'),
        member('E1', 'SPOUSE', '1988-06-01', '300000', 'FEMALE'),
        member('E1', 'CHILD', '2015-06-01', '300000'),
      ],
    });
    expect(summary.coverage).toMatchObject({ employees: 1, lives: 3, total: '300000' });
    expect(summary.coverage.rows).toEqual([
      { amount: '300000', employees: 1, lives: 3, total: '300000' },
    ]);
    expect(summary.matrix.totals.totalCover).toBeNull();
    expect(summary.byRelationship.find((row) => row.relationship === 'SPOUSE')?.total).toBeNull();
    expect(summary.reconciled).toBe(true);
  });

  it('reports members without cover, without a valid date of birth or outside the bands', () => {
    const summary = buildSelectionSummary({
      product: 'GPA',
      floater: false,
      bands: custom,
      referenceDate: reference,
      members: [
        member('E1', 'SELF', '1960-01-01', '500000'), // 66: outside 0–50
        member('E2', 'SELF', null, '500000'),
        member('E3', 'SELF', '1990-01-01', null),
      ],
    });
    expect(summary.problems.map((problem) => [problem.code, problem.count])).toEqual([
      ['NO_COVER', 1],
      ['AGE_UNKNOWN', 1],
      ['OUTSIDE_BANDS', 1],
    ]);
    expect(summary.matrix.rows.map((row) => row.kind)).toEqual([
      'BAND',
      'BAND',
      'BAND',
      'OUTSIDE',
      'UNKNOWN',
    ]);
    expect(summary.matrix.totals.totalLives).toBe(3);
    expect(
      buildSelectionSummary({
        product: 'GPA',
        floater: false,
        bands: custom,
        referenceDate: reference,
        members: [],
      }).problems[0]!.code,
    ).toBe('NO_MEMBERS');
  });
});
