import { describe, expect, it } from 'vitest';
import type { ProposalRecord } from '../../shared/index.ts';
import { burglaryContentsLines } from './burglary-breakdown.ts';

type Line = ProposalRecord['fire']['groups'][number];
type Location = ProposalRecord['locations'][number];
const line = (
  group: Line['group'],
  proposed1: string,
  proposed2: string | null = null,
  existing: string | null = null,
): Line => ({ group, existing, proposed1, proposed2, proposed3: null });
const item = (
  key: string,
  sumInsured: string,
  sqFt: string | null = null,
  rate: string | null = null,
) => ({
  key,
  sqFt,
  ratePerSqFt: rate,
  amount: sqFt ? null : sumInsured,
  sumInsured,
});
const place = (
  name: string,
  fire: ReturnType<typeof item>[],
  buildings: { name: string; sumInsured: string; sqFt?: string; rate?: string }[] = [],
  extras: { hypothecation?: string; openStock?: string } = {},
) =>
  ({
    location: { name },
    fire,
    buildings: buildings.map((building) => ({
      name: building.name,
      sqFt: building.sqFt ?? null,
      ratePerSqFt: building.rate ?? null,
      amount: building.sqFt ? null : building.sumInsured,
      sumInsured: building.sumInsured,
    })),
    hypothecation: extras.hypothecation ?? null,
    openStock: extras.openStock ?? null,
  }) as unknown as Location;

function caseWith(
  basis: 'FULL' | null,
  groups: Line[],
  locations: Location[],
  totals: { existing?: string | null; proposed1: string; proposed2?: string | null },
) {
  return {
    sections: [{ code: 'BURGLARY', basis }],
    locations,
    fire: {
      groups,
      existing: totals.existing ?? null,
      proposed1: totals.proposed1,
      proposed2: totals.proposed2 ?? null,
    },
  } as unknown as ProposalRecord;
}

const shape = (rows: ReturnType<typeof burglaryContentsLines>) =>
  rows.map((row) => [row.number, row.label, row.existing, row.proposed1, row.proposed2]);

describe('burglaryContentsLines', () => {
  it('prints the Data Sheet’s Fire & Burglary table, every item in its order and numbering', () => {
    const rows = burglaryContentsLines(
      caseWith(
        'FULL',
        [
          line('BUILDING', '2100000', '2500000', '1800000'),
          line('FFF', '300000', '350000', '250000'),
          line('PLANT_MACHINERY', '1500000', null, '1200000'),
          line('STOCKS', '5000000'),
        ],
        [
          place(
            'Plant 1',
            [
              item('COMPOUND_WALL', '100000', '1000', '100'),
              item('FFF', '300000'),
              item('GENSET', '1000000'),
              item('TRANSFORMER', '500000'),
              item('STOCKS', '5000000'),
            ],
            [{ name: 'Main shed', sumInsured: '2000000', sqFt: '2000', rate: '1000' }],
            { hypothecation: 'State Bank of India, Pune' },
          ),
        ],
        { existing: '3250000', proposed1: '8900000', proposed2: '2850000' },
      ),
    );
    expect(shape(rows)).toEqual([
      [
        '1',
        'All Building & all type of civil structures Including Plinth & Foundation, Compound wall, False Ceiling and all Allied Building',
        '1800000',
        '2100000',
        '2500000',
      ],
      [null, 'Main shed (2,000 sq ft × ₹1,000 per sq ft)', null, '2000000', null],
      ['a', 'Compound wall (1,000 sq ft × ₹100 per sq ft)', null, '100000', null],
      ['2', 'Furniture, Fixtures and Fittings & Interiors', '250000', '300000', '350000'],
      ['5', 'All types of Plant and Machinery and all its accessories', '1200000', '1500000', null],
      ['a', 'Genset and all its accessories', null, '1000000', null],
      ['c', 'Transformer and all its accessories', null, '500000', null],
      ['6', 'All types of stock pertaining to insured business', null, '5000000', null],
      [null, 'Total sum insured', '3250000', '8900000', '2850000'],
      ['1', 'Hypothecation if any - Please specify: State Bank of India, Pune', null, null, null],
    ]);
    expect(rows.map((row) => row.kind)).toEqual([
      'heading',
      'sub',
      'sub',
      'item',
      'heading',
      'sub',
      'sub',
      'item',
      'total',
      'text',
    ]);
  });

  it('adds items up across locations and names each building’s location', () => {
    const rows = burglaryContentsLines(
      caseWith(
        'FULL',
        [line('BUILDING', '3000000'), line('STOCKS', '700000', '900000')],
        [
          place('Plant 1', [item('STOCKS', '400000')], [{ name: 'Shed A', sumInsured: '1000000' }]),
          place(
            'Plant 2',
            [item('STOCKS', '200000'), item('STOCKS_THIRD_PARTY', '100000')],
            [{ name: 'Shed B', sumInsured: '2000000' }],
            { openStock: 'Coils in the yard' },
          ),
        ],
        { proposed1: '3700000', proposed2: '900000' },
      ),
    );
    expect(shape(rows).slice(1)).toEqual([
      [null, 'Plant 1: Shed A', null, '1000000', null],
      [null, 'Plant 2: Shed B', null, '2000000', null],
      // 6 and 6a show Option 1; the line's Option 2 is on a stock total of its own.
      ['6', 'All types of stock pertaining to insured business', null, '600000', null],
      ['a', 'Any other stocks kept at third party job work location', null, '100000', null],
      [null, 'Total - All types of stock (6 and 6a)', null, '700000', '900000'],
      [null, 'Total sum insured', null, '3700000', '900000'],
      [
        '1',
        'Stock kept at open space if any - Please Specify: Plant 2: Coils in the yard',
        null,
        null,
        null,
      ],
    ]);
  });

  it('has nothing to break down when Burglary is typed (no basis)', () => {
    expect(
      burglaryContentsLines(
        caseWith(null, [line('STOCKS', '500000')], [place('Plant 1', [item('STOCKS', '500000')])], {
          proposed1: '500000',
        }),
      ),
    ).toEqual([]);
  });
});
