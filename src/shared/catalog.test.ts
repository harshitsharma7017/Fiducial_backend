import { describe, expect, it } from 'vitest';
import {
  addonRuleFormula,
  catalogKeyOf,
  catalogRowToCells,
  formatRupeesShort,
  parseCatalogCells,
  productRangeText,
  suggestProducts,
  taxRateOn,
} from './catalog.ts';

const product = (code: string, aboveSi: string | null, upToSi: string | null, order: number) => ({
  code,
  aboveSi,
  upToSi,
  order,
  active: true,
});
const PRODUCTS = [
  product('BSUS', null, '50000000', 1),
  product('BLUS', '50000000', '500000000', 2),
  product('SFSP', '500000000', null, 3),
  product('PAR', '50000000', null, 4),
];

describe('products', () => {
  it('suggests by range: up to includes the limit, above excludes it', () => {
    const codes = (si: string) => suggestProducts(PRODUCTS, si).map((p) => p.code);
    expect(codes('50000000')).toEqual(['BSUS']);
    expect(codes('50000001')).toEqual(['BLUS', 'PAR']);
    expect(codes('500000000')).toEqual(['BLUS', 'PAR']);
    expect(codes('500000001')).toEqual(['SFSP', 'PAR']);
    expect(suggestProducts([{ ...PRODUCTS[0]!, active: false }], '1')).toEqual([]);
  });

  it('words ranges and amounts', () => {
    expect(productRangeText(PRODUCTS[0]!)).toBe('Up to ₹5 Cr');
    expect(productRangeText(PRODUCTS[1]!)).toBe('Above ₹5 Cr and up to ₹50 Cr');
    expect(productRangeText(PRODUCTS[2]!)).toBe('Above ₹50 Cr');
    expect(formatRupeesShort('2500000')).toBe('₹25 L');
    expect(formatRupeesShort('12500000')).toBe('₹1.25 Cr');
    expect(formatRupeesShort('50000')).toBe('₹50,000');
  });
});

describe('taxRateOn', () => {
  const rates = [
    { tax: 'GST' as const, ratePercent: '18', effectiveFrom: '2017-07-01' },
    { tax: 'GST' as const, ratePercent: '12', effectiveFrom: '2027-04-01' },
  ];
  it('takes the latest rate effective on the date', () => {
    expect(taxRateOn(rates, 'GST', '2026-10-07')?.ratePercent).toBe('18');
    expect(taxRateOn(rates, 'GST', '2027-04-01')?.ratePercent).toBe('12');
    expect(taxRateOn(rates, 'GST', '2017-06-30')).toBeNull();
  });
});

describe('parseCatalogCells', () => {
  it('reads sheet text into a row', () => {
    const result = parseCatalogCells('addons', {
      list: 'BSUS & BLUS',
      seq: '7',
      name: 'Start-up expenses',
      kind: 'inbuilt',
      limit: 'Covered upto Rs 1 Lac',
      active: 'Yes',
    });
    expect(result.issues).toEqual([]);
    expect(result.row).toEqual({
      list: 'BSUS_BLUS',
      seq: 7,
      name: 'Start-up expenses',
      kind: 'INBUILT',
      limit: 'Covered upto Rs 1 Lac',
      active: true,
    });
  });

  it('names the column of each problem', () => {
    const result = parseCatalogCells('sections', {
      code: 'FIRE',
      name: 'Fire',
      order: '1',
      active: 'No',
      fields: '',
      addons: 'Earthquake; Terrorism',
    });
    expect(result.issues).toEqual([{ column: 'active', message: 'Fire cannot be switched off' }]);
    const bad = parseCatalogCells('addon-rules', {
      seq: '1',
      name: 'Loss minimisation',
      sookshmaLimit: '5% of claim',
      laghuLimit: '5% of claim',
      calcType: 'PCT_OF_SI_BASE',
      rateFactorPct: '150',
      basePct: '',
      maxSelectablePct: '',
      sookshmaCap: '25,00,000',
      laghuCap: '',
      perBlock: 'maybe',
      active: 'Yes',
    });
    expect(bad.issues).toEqual([{ column: 'perBlock', message: 'Enter Yes or No' }]);
  });

  it('round-trips a row through cells', () => {
    const row = {
      code: 'MONEY',
      name: 'Money',
      order: 6,
      active: true,
      fields: ['Cash in safe / counter', 'Cash in transit - Single carrying limit'],
      addons: ['Terrorism'],
    };
    const parsed = parseCatalogCells('sections', catalogRowToCells('sections', row));
    expect(parsed.row).toEqual(row);
    expect(catalogKeyOf('addons', { list: 'PAR', name: '  Waiver  of Recourse ' })).toBe(
      'par|waiver of recourse',
    );
  });

  it('describes rate formulas', () => {
    expect(
      addonRuleFormula({
        calcType: 'PCT_OF_SI_BASE',
        rateFactorPct: '2.5',
        basePct: '5',
        maxSelectablePct: null,
      }),
    ).toBe('2.5% of policy rate on 5% of SI');
  });
});
