import { describe, expect, it } from 'vitest';
import {
  CLAIMS_ANALYSIS_AGE_BANDS,
  analyseClaims,
  bucketOf,
  icrOf,
  paidAndOutstanding,
  premiumBasis,
  toPaise,
  type AnalysisClaim,
} from './claims-analysis.ts';
import {
  renewalChanges,
  renewalQuotes,
  renewalYear,
  type PolicyYearFigures,
} from './renewal-analysis.ts';

const claim = (overrides: Partial<AnalysisClaim>): AnalysisClaim => ({
  id: 'x',
  status: 'SETTLED',
  requestType: 'MAIN',
  parentLinked: false,
  sourceStatus: 'Settled',
  claimType: 'CASHLESS',
  relationship: 'SELF',
  gender: 'MALE',
  age: 40,
  icdChapter: 'XI',
  claimedAmount: '100000.00',
  sanctionedAmount: '90000.00',
  settledAmount: '85000.00',
  disallowedAmount: '15000.00',
  ...overrides,
});
const policy = {
  basePremium: '1000000.00',
  policyStart: '2025-04-01',
  policyEnd: '2026-03-31',
  adjustments: [],
};

describe('status classification and paid / outstanding (N10 A, F)', () => {
  it('puts a claim in exactly one status and never counts a linked pre-auth twice', () => {
    expect(bucketOf(claim({}))).toBe('SETTLED');
    expect(bucketOf(claim({ requestType: 'PRE_AUTH', parentLinked: true }))).toBe('NOT_COUNTED');
    expect(
      bucketOf(claim({ requestType: 'PRE_AUTH', parentLinked: false, status: 'OUTSTANDING' })),
    ).toBe('OUTSTANDING');
    expect(paidAndOutstanding(claim({}), 'SANCTIONED_ELSE_CLAIMED')).toEqual({
      paid: 8_500_000n,
      outstanding: 0n,
    });
    expect(paidAndOutstanding(claim({ status: 'OUTSTANDING' }), 'SANCTIONED_ELSE_CLAIMED')).toEqual(
      { paid: 0n, outstanding: 9_000_000n },
    );
    expect(
      paidAndOutstanding(
        claim({ status: 'OUTSTANDING', sanctionedAmount: null }),
        'SANCTIONED_ELSE_CLAIMED',
      ),
    ).toEqual({
      paid: 0n,
      outstanding: 10_000_000n,
    });
    expect(paidAndOutstanding(claim({ status: 'OUTSTANDING' }), 'CLAIMED').outstanding).toBe(
      10_000_000n,
    );
    expect(paidAndOutstanding(claim({ status: 'REJECTED' }), 'CLAIMED')).toEqual({
      paid: 0n,
      outstanding: 0n,
    });
  });
});

describe('premium and ICR (N10 F)', () => {
  it('earns the premium by days in force and keeps the total after additions and deletions', () => {
    // 2025-04-01 to 2026-03-31 is 365 days; to 2025-09-30 is 183 days.
    const basis = premiumBasis(
      {
        ...policy,
        adjustments: [
          { kind: 'ADDITION', amount: '36500.00', effectiveDate: '2025-07-01' }, // 274-day term, 92 days to 30/09
          { kind: 'DELETION', amount: '10000.00', effectiveDate: '2026-01-01' }, // not yet in force
        ],
      },
      '2025-09-30',
    );
    expect(basis).toMatchObject({
      additions: '36500.00',
      deletions: '10000.00',
      total: '1026500.00',
      daysElapsed: 183,
      policyDays: 365,
    });
    // base 10,00,000 × 183/365 = 5,01,369.86; addition 36,500 × 92/274 = 12,255.47; deletion 0.
    expect(basis.prorated).toBe('513625.33');
  });

  it('works out both ICRs over the same paid + outstanding, and says why when the premium is missing or zero', () => {
    const analysis = analyseClaims({
      claims: [
        claim({}),
        claim({ status: 'OUTSTANDING' }),
        claim({ status: 'REJECTED' }),
        claim({ requestType: 'PRE_AUTH', parentLinked: true }),
      ],
      bands: CLAIMS_ANALYSIS_AGE_BANDS,
      premium: policy,
      asOf: '2026-03-31',
      outstandingBasis: 'SANCTIONED_ELSE_CLAIMED',
    });
    expect(analysis.icr).toMatchObject({
      paid: '85000.00',
      outstanding: '90000.00',
      incurred: '175000.00',
      total: { percent: '17.50', premium: '1000000.00' },
      prorated: { percent: '17.50', premium: '1000000.00' },
    });
    expect(analysis.notCounted).toBe(1);
    expect(icrOf(100n, null)).toEqual({
      percent: null,
      reason: 'No premium is recorded for the policy',
    });
    expect(icrOf(100n, '0.00').percent).toBeNull();
    // 1/3 is 33.333…: rounded half up to 33.33.
    expect(icrOf(toPaise('1.00'), '3.00').percent).toBe('33.33');
    expect(icrOf(toPaise('2.00'), '3.00').percent).toBe('66.67');
  });

  it('adds every dimension up to the reported claims and puts boundary ages in their bands', () => {
    const ages = [0, 10, 11, 70, 71, null];
    const analysis = analyseClaims({
      claims: ages.map((age, index) =>
        claim({
          id: String(index),
          age,
          relationship: index % 2 === 0 ? 'SELF' : 'SPOUSE',
          claimType: index === 5 ? null : 'REIMBURSEMENT',
          icdChapter: index === 5 ? 'UNCLASSIFIED' : 'IX',
        }),
      ),
      bands: CLAIMS_ANALYSIS_AGE_BANDS,
      premium: policy,
      asOf: '2026-03-31',
      outstandingBasis: 'SANCTIONED_ELSE_CLAIMED',
    });
    const count = (label: string) => analysis.ageBands.find((row) => row.label === label)?.count;
    expect([
      count('0–10'),
      count('11–20'),
      count('61–70'),
      count('Above 70'),
      count('Age not known'),
    ]).toEqual([2, 1, 1, 1, 1]);
    for (const dimension of [
      analysis.status,
      analysis.members,
      analysis.gender,
      analysis.relationship,
      analysis.ageBands,
      analysis.claimType,
      analysis.disease,
    ]) {
      expect(dimension.reduce((sum, row) => sum + row.count, 0)).toBe(analysis.reported.count);
    }
    expect(analysis.members.map((row) => [row.key, row.count])).toEqual([
      ['MAIN', 3],
      ['DEPENDANT', 3],
    ]);
    expect(analysis.claimType.find((row) => row.key === 'UNKNOWN')?.count).toBe(1);
  });
});

describe('renewal analysis (N8)', () => {
  const year = (overrides: Partial<PolicyYearFigures>): PolicyYearFigures => ({
    source: 'RECORDED',
    sourceId: 'y',
    label: 'Year',
    product: 'GMC',
    policyNumber: null,
    insurerName: 'Insurer',
    policyStart: '2023-04-01',
    policyEnd: '2024-03-31',
    employees: 126,
    lives: 380,
    bySumInsured: null,
    totalSumInsured: '63000000.00',
    premiumBeforeGst: '2520000.00',
    gst: '453600.00',
    claims: {
      toDate: '2016000.00',
      paid: '2016000.00',
      outstanding: '0.00',
      count: 40,
      asOf: '2024-03-31',
      source: 'RECORDED',
    },
    incomplete: false,
    notes: [],
    ...overrides,
  });

  it('works out each average from its own denominator, and the claims ratio and premium per lakh', () => {
    const result = renewalYear(year({}));
    expect(result.dependants.value).toBe('254');
    expect(result.premiumWithGst.value).toBe('2973600.00');
    expect(result.premiumPerFamily.value).toBe('20000.00'); // 25,20,000 ÷ 126
    expect(result.premiumPerLife.value).toBe('6631.58'); // 25,20,000 ÷ 380
    expect(result.premiumPerLakh.value).toBe('4000.00'); // 25,20,000 ÷ 630 lakh
    expect(result.claimsRatio.value).toBe('80.00');
  });

  it('gives a reason instead of a figure for missing data and zero denominators', () => {
    const result = renewalYear(
      year({
        employees: 0,
        lives: null,
        premiumBeforeGst: null,
        claims: {
          toDate: null,
          paid: null,
          outstanding: null,
          count: null,
          asOf: null,
          source: 'NONE',
        },
      }),
    );
    expect(result.premiumPerFamily).toEqual({ value: null, reason: 'Premium not recorded' });
    expect(result.claimsRatio.reason).toBe('No claims data for this year');
    expect(renewalYear(year({ employees: 0 })).premiumPerFamily.reason).toBe(
      'No employees recorded',
    );
    expect(renewalYear(year({ totalSumInsured: '0.00' })).premiumPerLakh.reason).toBe(
      'Total sum insured is zero',
    );
  });

  it('shows absolute and percentage changes, ratio changes in points, and none from zero', () => {
    const first = renewalYear(year({ label: 'Y1' }));
    const second = renewalYear(
      year({
        label: 'Y2',
        employees: 145,
        premiumBeforeGst: '2900000.00',
        claims: {
          toDate: '2030000.00',
          paid: '2030000.00',
          outstanding: '0',
          count: 50,
          asOf: '2025-03-31',
          source: 'TPA',
        },
      }),
    );
    const changes = renewalChanges(first, second);
    const of = (metric: string) => changes.find((change) => change.metric === metric)!;
    expect(of('employees')).toMatchObject({ absolute: '19', percent: '15.08' });
    expect(of('premiumBeforeGst')).toMatchObject({ absolute: '380000.00', percent: '15.08' });
    expect(of('claimsRatio')).toMatchObject({ absolute: '-10.00', percent: null });
    const fromZero = renewalChanges(
      renewalYear(
        year({
          claims: {
            toDate: '0.00',
            paid: '0',
            outstanding: '0',
            count: 0,
            asOf: null,
            source: 'TPA',
          },
        }),
      ),
      second,
    );
    expect(fromZero.find((change) => change.metric === 'claimsToDate')).toMatchObject({
      percent: null,
      reason: 'The earlier year is zero',
    });
    const quotes = renewalQuotes(
      [
        {
          insurerName: 'A',
          quoteVersion: 1,
          basePremium: '3000000.00',
          gst: '540000.00',
          totalPremium: '3540000.00',
        },
        {
          insurerName: 'B',
          quoteVersion: 2,
          basePremium: '2800000.00',
          gst: '504000.00',
          totalPremium: '3304000.00',
        },
      ],
      '2900000.00',
    );
    expect(quotes.map((quote) => [quote.insurerName, quote.changePercent, quote.lowest])).toEqual([
      ['A', '3.45', false],
      ['B', '-3.45', true],
    ]);
  });
});
