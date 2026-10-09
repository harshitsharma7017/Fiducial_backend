import { describe, expect, it } from 'vitest';
import { fireTotals, itemSumInsured, missingForRfq, stageOf } from './proposal-calc.ts';

const item = (key: string, values: Partial<Record<'sqFt' | 'ratePerSqFt' | 'amount', string>>) =>
  ({
    key,
    sqFt: values.sqFt ?? null,
    ratePerSqFt: values.ratePerSqFt ?? null,
    amount: values.amount ?? null,
  }) as Parameters<typeof itemSumInsured>[0];

describe('itemSumInsured', () => {
  it('prices a measured item as area × rate, exactly, as Excel does', () => {
    expect(
      itemSumInsured(item('BUILDING_1', { sqFt: '12500.5', ratePerSqFt: '2400' })).toFixed(),
    ).toBe('30001200');
    expect(itemSumInsured(item('INTERIOR', { sqFt: '10.25', ratePerSqFt: '3' })).toFixed()).toBe(
      '30.75',
    );
  });

  it('totals the exact amounts, so the rounded total matches the client’s Excel', () => {
    // Two buildings of 10.5 sq ft at ₹3: Excel shows 32 and 32 (31.5 each) and a total of 63.
    const totals = fireTotals(
      [
        {
          name: 'Plant',
          fire: [
            item('BUILDING_1', { sqFt: '10.5', ratePerSqFt: '3' }),
            item('BUILDING_2', { sqFt: '10.5', ratePerSqFt: '3' }),
          ],
        },
      ],
      new Map(),
    );
    expect(totals.proposed1.toFixed()).toBe('63');
  });

  it('uses a typed amount over area × rate', () => {
    expect(
      itemSumInsured(
        item('BUILDING_1', { sqFt: '100', ratePerSqFt: '10', amount: '5000' }),
      ).toFixed(),
    ).toBe('5000');
  });

  it('never prices an unmeasured item from an area', () => {
    expect(itemSumInsured(item('STOCKS', { sqFt: '100', ratePerSqFt: '10' })).toFixed()).toBe('0');
  });
});

describe('fireTotals', () => {
  it('adds every location into the RFQ lines and keeps Option 2 as entered', () => {
    const totals = fireTotals(
      [
        {
          name: 'Plant 1',
          fire: [
            item('BUILDING_1', { sqFt: '1000', ratePerSqFt: '2000' }),
            item('STOCKS', { amount: '500000' }),
          ],
        },
        {
          name: 'Plant 2',
          fire: [
            item('COMPOUND_WALL', { amount: '300000' }),
            item('STOCKS_THIRD_PARTY', { amount: '100000' }),
          ],
        },
      ],
      new Map([['STOCKS', '1000000']]),
    );
    const line = (group: string) => totals.groups.find((g) => g.group === group)!;
    expect(line('BUILDING').proposed1.toFixed()).toBe('2300000');
    expect(line('STOCKS').proposed1.toFixed()).toBe('600000');
    expect(line('STOCKS').proposed2?.toFixed()).toBe('1000000');
    expect(line('FFF').proposed2).toBeNull();
    expect(totals.proposed1.toFixed()).toBe('2900000');
    expect(totals.proposed2?.toFixed()).toBe('1000000');
  });

  it('has no Option 2 total when no line has one', () => {
    expect(fireTotals([], new Map()).proposed2).toBeNull();
  });
});

describe('missingForRfq and stageOf', () => {
  it('asks for a location, Fire sums insured and included sections', () => {
    expect(
      missingForRfq({
        locations: [],
        fireProposed1: fireTotals([], new Map()).proposed1,
        sections: [],
      }),
    ).toEqual(['Add at least one risk location.']);
    const locations = [{ name: 'Godown', fire: [] }];
    expect(
      missingForRfq({
        locations,
        fireProposed1: fireTotals(locations, new Map()).proposed1,
        sections: [
          { code: 'MONEY', included: true, proposed1: null },
          { code: 'BURGLARY', included: false, proposed1: null },
        ],
      }),
    ).toEqual([
      'Enter the Fire sums insured for Godown.',
      'Money: enter Cash in safe / counter or Cash in transit - Single carrying limit, or leave the section out.',
    ]);
  });

  it('moves from draft to Data Sheet to RFQ sent', () => {
    expect(stageOf(['x'], false)).toBe('DRAFT');
    expect(stageOf([], false)).toBe('DATA_SHEET');
    expect(stageOf([], true)).toBe('RFQ_SENT');
  });
});
