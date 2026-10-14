import {
  emptyGhiQuoteTerms,
  emptyGhiRequirements,
  type GhiRequirementsInput,
} from '../../shared/index.ts';
import { describe, expect, it } from 'vitest';
import { ageBandOf, summarizeCensus, type SummaryMember } from './census-summary.ts';
import { compareTerms, deviationsOf, lowestTotals, premiumOf } from './ghi-quote-calc.ts';

// The census summary (G4) and the quote arithmetic and comparison (G6).

const family = (
  key: string,
  sumInsured: string,
  dependants: Array<[SummaryMember['relationship'], string, string | null]>,
) => [
  { employeeKey: key, relationship: 'SELF' as const, dateOfBirth: '1990-01-01', sumInsured },
  ...dependants.map(([relationship, dateOfBirth, si]) => ({
    employeeKey: key,
    relationship,
    dateOfBirth,
    sumInsured: si,
  })),
];

describe('census summary', () => {
  const members: SummaryMember[] = [
    ...family('E1', '500000', [
      ['SPOUSE', '1992-06-01', null],
      ['CHILD', '2020-01-01', null],
      ['FATHER', '1955-03-01', null],
    ]),
    ...family('E2', '300000', []),
    ...family('E3', '300000', [['CHILD', '2008-04-02', null]]),
  ];

  it('bands ages at the edges', () => {
    expect([0, 18, 19, 35, 36, 45, 46, 55, 56, 65, 66, 90].map(ageBandOf)).toEqual([
      '0-18',
      '0-18',
      '19-35',
      '19-35',
      '36-45',
      '36-45',
      '46-55',
      '46-55',
      '56-65',
      '56-65',
      '66+',
      '66+',
    ]);
  });

  it('counts employees, lives, relationships and age bands on the reference date', () => {
    const summary = summarizeCensus(members, {
      coverageType: 'FLOATER',
      referenceDate: '2026-04-01',
      declaredEmployees: 3,
      revision: 4,
    });
    expect(summary.employees).toBe(3);
    expect(summary.lives).toBe(7);
    expect(summary.byRelationship).toMatchObject({
      SELF: 3,
      SPOUSE: 1,
      CHILD: 2,
      FATHER: 1,
      MOTHER: 0,
    });
    // Employees born 1990-01-01 are 36; 2008-04-02 is 17 on 2026-04-01 (a day short of 18).
    expect(Object.fromEntries(summary.byAgeBand.map((band) => [band.band, band.lives]))).toEqual({
      '0-18': 2,
      '19-35': 1,
      '36-45': 3,
      '46-55': 0,
      '56-65': 0,
      '66+': 1,
    });
    // (36 + 33 + 6 + 71 + 36 + 36 + 17) / 7 = 33.57
    expect(summary.averageAge).toBe('33.6');
    expect(summary.revision).toBe(4);
  });

  it('adds one sum insured per family for a floater, one per member for individual cover', () => {
    const floater = summarizeCensus(members, {
      coverageType: 'FLOATER',
      referenceDate: '2026-04-01',
      declaredEmployees: null,
      revision: 0,
    });
    expect(floater.totalSumInsured).toBe('1100000');
    expect(floater.bySumInsured).toEqual([
      { sumInsured: '300000', families: 2, lives: 3 },
      { sumInsured: '500000', families: 1, lives: 4 },
    ]);
    expect(floater.missingSumInsured).toBe(0);

    const individual = summarizeCensus(
      [
        ...family('E1', '500000', [
          ['SPOUSE', '1992-06-01', '300000'],
          ['CHILD', '2020-01-01', null],
        ]),
      ],
      {
        coverageType: 'INDIVIDUAL',
        referenceDate: '2026-04-01',
        declaredEmployees: null,
        revision: 0,
      },
    );
    expect(individual.totalSumInsured).toBe('800000');
    expect(individual.missingSumInsured).toBe(1);
  });

  it('has no total until the coverage type is chosen, and handles an empty census', () => {
    const empty = summarizeCensus([], {
      coverageType: null,
      referenceDate: '2026-04-01',
      declaredEmployees: 10,
      revision: 0,
    });
    expect(empty).toMatchObject({
      employees: 0,
      lives: 0,
      totalSumInsured: null,
      averageAge: null,
      declaredEmployees: 10,
    });
  });
});

describe('premium', () => {
  it('works out GST at the case rate, rounded half up to the paisa', () => {
    expect(premiumOf('100000', '18')).toEqual({
      basePremium: '100000.00',
      gst: '18000.00',
      totalPremium: '118000.00',
    });
    // 0.125 × 18% = 0.0225 → 0.02; 12345.67 × 18% = 2222.2206 → 2222.22
    expect(premiumOf('12345.67', '18')).toEqual({
      basePremium: '12345.67',
      gst: '2222.22',
      totalPremium: '14567.89',
    });
    // 0.25 × 18% = 0.045 → 0.05 (half up)
    expect(premiumOf('0.25', '18').gst).toBe('0.05');
    expect(premiumOf('9999999999999.99', '18').totalPremium).toBe('11799999999999.99');
  });

  it('marks every lowest total on a tie', () => {
    expect([...lowestTotals(['118000.00', '117999.99', '117999.99'])]).toEqual([1, 2]);
    expect([...lowestTotals([])]).toEqual([]);
  });
});

describe('quote against the RFQ', () => {
  const requested: GhiRequirementsInput = {
    ...emptyGhiRequirements(),
    familyDefinition: { spouse: true, maxChildren: 2, parents: 'PARENTS' },
    coverageType: 'FLOATER',
    maternity: {
      covered: true,
      normalLimit: '50000',
      cesareanLimit: '75000',
      newbornCovered: true,
      nineMonthWaiver: true,
    },
    preExistingDiseases: { covered: true, note: null },
    waivers: {
      initialWaitingPeriod: true,
      firstYearExclusions: true,
      twoYearExclusions: false,
      preExistingWaitingPeriod: true,
    },
    roomRent: { kind: 'PERCENT_OF_SI', normal: '1', icu: '2' },
    parentsCoPayPercent: '10',
    corporateBuffer: { amount: '1000000', perFamilyLimit: null, note: null },
  };

  it('matches a quote that gives what was asked', () => {
    const offered = {
      ...emptyGhiQuoteTerms(),
      coverageType: 'FLOATER' as const,
      roomRent: { kind: 'PERCENT_OF_SI' as const, normal: '1', icu: '2' },
      maternity: {
        covered: true,
        normalLimit: '50000',
        cesareanLimit: '75000',
        newbornCovered: true,
        nineMonthWaiver: true,
      },
      preExistingCovered: true,
      parentsCoPayPercent: '10',
      waivers: {
        initialWaitingPeriod: true,
        firstYearExclusions: true,
        twoYearExclusions: false,
        preExistingWaitingPeriod: true,
      },
      waitingPeriods: {
        initialDays: 0,
        specificDiseasesMonths: 24,
        preExistingMonths: 0,
        maternityMonths: 0,
      },
      corporateBufferAmount: '1000000',
    };
    expect(deviationsOf(requested, offered)).toEqual([]);
  });

  it('flags lower limits, higher co-pay, refused waivers and missing terms; better terms are not deviations', () => {
    const offered = {
      ...emptyGhiQuoteTerms(),
      coverageType: 'FLOATER' as const,
      roomRent: { kind: 'NO_LIMIT' as const, normal: null, icu: null },
      maternity: {
        covered: true,
        normalLimit: '40000',
        cesareanLimit: '75000',
        newbornCovered: null,
        nineMonthWaiver: false,
      },
      preExistingCovered: true,
      parentsCoPayPercent: '20',
      waivers: {
        initialWaitingPeriod: false,
        firstYearExclusions: true,
        twoYearExclusions: true,
        preExistingWaitingPeriod: true,
      },
      waitingPeriods: {
        initialDays: 30,
        specificDiseasesMonths: 0,
        preExistingMonths: 0,
        maternityMonths: 9,
      },
      corporateBufferAmount: null,
    };
    const rows = new Map(compareTerms(requested, offered).map((row) => [row.key, row.kind]));
    expect(rows.get('roomRent')).toBe('BETTER');
    expect(rows.get('waivers.twoYearExclusions')).toBe('BETTER');
    const deviations = deviationsOf(requested, offered);
    expect(deviations.map((item) => [item.field, item.kind])).toEqual([
      ['maternity.normalLimit', 'DEVIATION'],
      ['maternity.newbornCovered', 'MISSING'],
      ['maternity.nineMonthWaiver', 'DEVIATION'],
      ['parentsCoPayPercent', 'DEVIATION'],
      ['waivers.initialWaitingPeriod', 'DEVIATION'],
      ['waitingPeriods.initialDays', 'DEVIATION'],
      ['waitingPeriods.maternityMonths', 'DEVIATION'],
      ['corporateBuffer', 'MISSING'],
    ]);
    expect(deviations[0]).toMatchObject({ requested: '₹50,000', offered: '₹40,000' });
  });

  it('treats a different room-rent basis as a deviation', () => {
    const offered = {
      ...emptyGhiQuoteTerms(),
      roomRent: { kind: 'FIXED_AMOUNT' as const, normal: '5000', icu: '10000' },
    };
    expect(compareTerms(requested, offered).find((row) => row.key === 'roomRent')?.kind).toBe(
      'DEVIATION',
    );
  });
});
