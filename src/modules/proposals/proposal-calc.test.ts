import { describe, expect, it } from 'vitest';
import {
  buildingSumInsured,
  buildingsTotal,
  contentsTotals,
  fireTotals,
  itemSumInsured,
  missingForRfq,
  stageOf,
  sumOf,
  type LocationValues,
} from './proposal-calc.ts';
import type { FireGroup } from '../../shared/index.ts';

const item = (key: string, values: Partial<Record<'sqFt' | 'ratePerSqFt' | 'amount', string>>) =>
  ({
    key,
    sqFt: values.sqFt ?? null,
    ratePerSqFt: values.ratePerSqFt ?? null,
    amount: values.amount ?? null,
  }) as Parameters<typeof itemSumInsured>[0];

// D1: a building (name is ignored by the calc; only its figures matter).
const building = (values: Partial<Record<'sqFt' | 'ratePerSqFt' | 'amount', string>>) => ({
  sqFt: values.sqFt ?? null,
  ratePerSqFt: values.ratePerSqFt ?? null,
  amount: values.amount ?? null,
});

describe('itemSumInsured', () => {
  it('prices a measured item as area × rate, exactly, as Excel does', () => {
    // D1: a building is priced the same way, area × rate, exactly.
    expect(buildingSumInsured(building({ sqFt: '12500.5', ratePerSqFt: '2400' })).toFixed()).toBe(
      '30001200',
    );
    expect(
      itemSumInsured(item('COMPOUND_WALL', { sqFt: '10.25', ratePerSqFt: '3' })).toFixed(),
    ).toBe('30.75');
  });

  it('totals the exact amounts, so the rounded total matches the client’s Excel', () => {
    // D1: two buildings of 10.5 sq ft at ₹3: Excel shows 32 and 32 (31.5 each), a total of 63.
    const totals = fireTotals(
      [
        {
          name: 'Plant',
          buildings: [
            building({ sqFt: '10.5', ratePerSqFt: '3' }),
            building({ sqFt: '10.5', ratePerSqFt: '3' }),
          ],
          fire: [],
        },
      ],
      new Map(),
    );
    expect(totals.proposed1.toFixed()).toBe('63');
  });

  it('uses a typed amount over area × rate', () => {
    expect(
      buildingSumInsured(building({ sqFt: '100', ratePerSqFt: '10', amount: '5000' })).toFixed(),
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
          // D1: the building is in the BUILDING line.
          buildings: [building({ sqFt: '1000', ratePerSqFt: '2000' })],
          fire: [item('STOCKS', { amount: '500000' })],
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
    // D1: 1000 × 2000 (building) + 300000 (compound wall) = 2,300,000.
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

// D3 (client-confirmed Option A): Burglary Sum Insured = Total Fire Sum Insured − Building Sum
// Insured, where "Building" is the dynamic buildings only. Plinth & Foundation (and the other
// civil-structure items, Compound wall and False ceiling) are NOT deducted — they stay in the
// Burglary base. The calc below mirrors how the mapper derives the Burglary contents.
describe('contentsTotals (D3 — Burglary Option A)', () => {
  /** Burglary contents for a set of locations, as the mapper computes it (Option A). */
  const burglaryContents = (
    locations: readonly LocationValues[],
    option2: ReadonlyMap<FireGroup, string | null> = new Map(),
  ) => contentsTotals(fireTotals(locations, option2), sumOf(locations.map(buildingsTotal)));

  it('Test 1: deducts only the building; Plinth & Foundation stays in the base', () => {
    // Total Fire 10,000,000 = building 4,000,000 + Plinth & Foundation 1,000,000 + stocks 5,000,000.
    const location: LocationValues = {
      name: 'Plant 1',
      buildings: [building({ amount: '4000000' })],
      fire: [
        item('PLINTH_FOUNDATION', { amount: '1000000' }),
        item('STOCKS', { amount: '5000000' }),
      ],
    };
    const totals = fireTotals([location], new Map());
    expect(totals.proposed1.toFixed()).toBe('10000000');
    // Burglary = Total Fire (10,000,000) − building (4,000,000) = 6,000,000. P&F not deducted.
    expect(burglaryContents([location]).proposed1.toFixed()).toBe('6000000');
  });

  it('Test 2: changing only Plinth & Foundation changes the Fire total but, for a fixed Fire total, Burglary follows Total Fire − building', () => {
    const withPnf = (pnf: string): LocationValues => ({
      name: 'Plant 1',
      buildings: [building({ amount: '4000000' })],
      fire: [item('PLINTH_FOUNDATION', { amount: pnf }), item('STOCKS', { amount: '5000000' })],
    });
    // Burglary is Total Fire − building. P&F is never separately deducted, so it is always part of
    // Burglary: raising P&F raises both the Fire total and Burglary by the same amount.
    const a = withPnf('1000000');
    const b = withPnf('2000000');
    expect(burglaryContents([a]).proposed1.toFixed()).toBe('6000000'); // 10,000,000 − 4,000,000
    expect(burglaryContents([b]).proposed1.toFixed()).toBe('7000000'); // 11,000,000 − 4,000,000
    // Holding the Total Fire fixed (shift 1,000,000 from P&F to stocks) leaves Burglary unchanged.
    const shifted: LocationValues = {
      name: 'Plant 1',
      buildings: [building({ amount: '4000000' })],
      fire: [
        item('PLINTH_FOUNDATION', { amount: '2000000' }),
        item('STOCKS', { amount: '4000000' }),
      ],
    };
    expect(fireTotals([shifted], new Map()).proposed1.toFixed()).toBe('10000000');
    expect(burglaryContents([shifted]).proposed1.toFixed()).toBe('6000000');
  });

  it('Test 3: aggregates buildings across multiple buildings and locations, deducted exactly once', () => {
    const plant1: LocationValues = {
      name: 'Plant 1',
      buildings: [building({ amount: '3000000' }), building({ amount: '1000000' })],
      fire: [item('STOCKS', { amount: '2000000' })],
    };
    const plant2: LocationValues = {
      name: 'Plant 2',
      buildings: [building({ amount: '2000000' })],
      fire: [item('STOCKS', { amount: '1500000' })],
    };
    // Total Fire = buildings (3,000,000 + 1,000,000 + 2,000,000) + stocks (2,000,000 + 1,500,000)
    // = 9,500,000. Buildings total = 6,000,000, deducted once → Burglary = 3,500,000.
    expect(fireTotals([plant1, plant2], new Map()).proposed1.toFixed()).toBe('9500000');
    expect(burglaryContents([plant1, plant2]).proposed1.toFixed()).toBe('3500000');
  });

  it('Test 4: Plinth & Foundation stays in the Fire total (unchanged) and in the Burglary base', () => {
    const location: LocationValues = {
      name: 'Plant 1',
      buildings: [building({ amount: '4000000' })],
      fire: [
        item('COMPOUND_WALL', { amount: '500000' }),
        item('PLINTH_FOUNDATION', { amount: '1000000' }),
        item('STOCKS', { amount: '5000000' }),
      ],
    };
    // Fire total is unchanged by D3: building 4,000,000 + compound wall 500,000 + P&F 1,000,000 +
    // stocks 5,000,000 = 10,500,000. The BUILDING group line still sums its civil items + buildings.
    const totals = fireTotals([location], new Map());
    expect(totals.proposed1.toFixed()).toBe('10500000');
    const buildingGroup = totals.groups.find((g) => g.group === 'BUILDING');
    expect(buildingGroup?.proposed1.toFixed()).toBe('5500000'); // 4,000,000 + 500,000 + 1,000,000
    // Burglary (Option A) = Total Fire − buildings = 10,500,000 − 4,000,000 = 6,500,000, i.e. the
    // compound wall and P&F remain in the Burglary base.
    expect(burglaryContents([location]).proposed1.toFixed()).toBe('6500000');
  });

  it('Test 5: zero and missing building values — nothing is deducted, no misleading amount', () => {
    // No buildings at all: Burglary equals the full Fire total.
    const noBuildings: LocationValues = {
      name: 'Plant 1',
      fire: [
        item('PLINTH_FOUNDATION', { amount: '1000000' }),
        item('STOCKS', { amount: '5000000' }),
      ],
    };
    expect(burglaryContents([noBuildings]).proposed1.toFixed()).toBe('6000000');
    // A zero-valued / empty building contributes 0 and does not reduce the base.
    const zeroBuilding: LocationValues = {
      name: 'Plant 1',
      buildings: [building({ amount: '0' }), building({})],
      fire: [item('STOCKS', { amount: '5000000' })],
    };
    expect(sumOf([zeroBuilding].map(buildingsTotal)).toFixed()).toBe('0');
    expect(burglaryContents([zeroBuilding]).proposed1.toFixed()).toBe('5000000');
  });

  it('Option 2: keeps each Fire line’s second figure in the Burglary base (null when none given)', () => {
    const location: LocationValues = {
      name: 'Plant 1',
      buildings: [building({ amount: '4000000' })],
      fire: [
        item('PLINTH_FOUNDATION', { amount: '1000000' }),
        item('STOCKS', { amount: '5000000' }),
      ],
    };
    // No Option 2 anywhere → Burglary Option 2 is null.
    expect(burglaryContents([location]).proposed2).toBeNull();
    // A STOCKS Option 2 of 7,000,000 flows into the Burglary Option 2 (civil items stay in base).
    const option2 = new Map<FireGroup, string | null>([['STOCKS', '7000000']]);
    expect(burglaryContents([location], option2).proposed2?.toFixed()).toBe('7000000');
  });

  it('Option 2: the Building line’s typed second figure is not pulled into Burglary', () => {
    const location: LocationValues = {
      name: 'Plant 1',
      buildings: [building({ amount: '4000000' })],
      fire: [item('STOCKS', { amount: '5000000' })],
    };
    // The BUILDING line's Option 2 (its single typed figure includes the building) stays out of
    // Burglary; only the STOCKS Option 2 counts. Burglary Option 2 = 7,000,000.
    const option2 = new Map<FireGroup, string | null>([
      ['BUILDING', '9000000'],
      ['STOCKS', '7000000'],
    ]);
    expect(burglaryContents([location], option2).proposed2?.toFixed()).toBe('7000000');
  });
});
