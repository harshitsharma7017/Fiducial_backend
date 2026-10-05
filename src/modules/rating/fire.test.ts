import { describe, expect, it } from 'vitest';
import { moneyString } from '../../lib/decimal.ts';
import { toBreakdownDto } from './rating.service.ts';
import { calculateFire, perMillePremium } from './fire.ts';
import { Decimal } from '../../lib/decimal.ts';

describe('calculateFire', () => {
  it('matches the worked example: SI 10 Cr, IIB 0.69, STFI 0.37, EQ 0.10', () => {
    const result = toBreakdownDto(
      calculateFire({ sumInsured: '100000000', iibRate: '0.69', stfiRate: '0.37', eqRate: '0.10' }),
    );
    expect(result).toEqual({
      sumInsured: '100000000.00',
      rates: { fire: '0.69', stfi: '0.37', earthquake: '0.1', terrorism: null },
      premiums: { fire: '69000.00', stfi: '37000.00', earthquake: '10000.00', terrorism: null },
      basePremium: '116000.00',
      policyRate: '1.16',
      totalBeforeTax: '116000.00',
      gstRatePercent: '18',
      gst: '20880.00',
      total: '136880.00',
    });
  });

  it('adds terrorism only when a rate is supplied', () => {
    const withTerrorism = calculateFire({
      sumInsured: '100000000',
      iibRate: '0.69',
      stfiRate: '0.37',
      eqRate: '0.10',
      terrorismRate: '0.05',
    });
    expect(moneyString(withTerrorism.premiums.terrorism!)).toBe('5000.00');
    expect(moneyString(withTerrorism.basePremium)).toBe('121000.00');
    expect(withTerrorism.policyRate.toFixed()).toBe('1.21');
    expect(moneyString(withTerrorism.gst)).toBe('21780.00');
    expect(moneyString(withTerrorism.total)).toBe('142780.00');

    const withoutTerrorism = calculateFire({
      sumInsured: '100000000',
      iibRate: '0.69',
      stfiRate: '0.37',
      eqRate: '0.10',
      terrorismRate: null,
    });
    expect(withoutTerrorism.premiums.terrorism).toBeNull();
    expect(withoutTerrorism.rates.terrorism).toBeNull();
  });

  it('rounds each component half up to paise and adds the rounded components', () => {
    // 12,345 x 0.69 / 1000 = 8.51805 -> 8.52
    expect(perMillePremium(new Decimal('12345'), new Decimal('0.69')).toFixed(2)).toBe('8.52');
    // 1,000 x 0.005 / 1000 = 0.005 -> 0.01 (half up, not banker's rounding)
    expect(perMillePremium(new Decimal('1000'), new Decimal('0.005')).toFixed(2)).toBe('0.01');

    const result = calculateFire({
      sumInsured: '12345',
      iibRate: '0.69',
      stfiRate: '0.37',
      eqRate: '0.1',
    });
    // fire 8.52 + STFI 4.57 (4.56765) + EQ 1.23 (1.2345) = 14.32
    expect(moneyString(result.basePremium)).toBe('14.32');
    // GST 14.32 x 18% = 2.5776 -> 2.58
    expect(moneyString(result.gst)).toBe('2.58');
    expect(moneyString(result.total)).toBe('16.90');
  });

  it('keeps exact decimal arithmetic where floats would drift', () => {
    const result = calculateFire({
      sumInsured: '1000',
      iibRate: '0.1',
      stfiRate: '0.2',
      eqRate: '0',
    });
    expect(result.policyRate.toFixed()).toBe('0.3');
    expect(moneyString(result.basePremium)).toBe('0.30');
  });

  it('handles large sums insured without losing precision', () => {
    const result = calculateFire({
      sumInsured: '123456789012345.67',
      iibRate: '0.69',
      stfiRate: '0.37',
      eqRate: '0.5',
    });
    // 123456789012345.67 x 0.69 / 1000 = 85185184418.5185123 -> 85185184418.52
    expect(moneyString(result.premiums.fire)).toBe('85185184418.52');
  });

  it('uses a configurable GST rate', () => {
    const exempt = calculateFire({
      sumInsured: '100000',
      iibRate: '1',
      stfiRate: '0',
      eqRate: '0',
      gstRatePercent: '0',
    });
    expect(moneyString(exempt.gst)).toBe('0.00');
    const twelve = calculateFire({
      sumInsured: '100000',
      iibRate: '1',
      stfiRate: '0',
      eqRate: '0',
      gstRatePercent: '12',
    });
    expect(moneyString(twelve.gst)).toBe('12.00');
    expect(moneyString(twelve.total)).toBe('112.00');
  });

  it('does not price add-ons yet (formulas to be confirmed)', () => {
    const result = calculateFire({
      sumInsured: '100000000',
      iibRate: '0.69',
      stfiRate: '0.37',
      eqRate: '0.1',
    });
    expect(result.addOns).toEqual([]);
    expect(result.totalBeforeTax.equals(result.basePremium)).toBe(true);
  });

  it('rejects invalid input', () => {
    const base = { sumInsured: '1000', iibRate: '0.1', stfiRate: '0.1', eqRate: '0.1' };
    expect(() => calculateFire({ ...base, sumInsured: '0' })).toThrow(RangeError);
    expect(() => calculateFire({ ...base, sumInsured: '-5' })).toThrow(RangeError);
    expect(() => calculateFire({ ...base, iibRate: '-0.1' })).toThrow(RangeError);
    expect(() => calculateFire({ ...base, eqRate: 'abc' })).toThrow(RangeError);
    expect(() => calculateFire({ ...base, terrorismRate: 'Infinity' })).toThrow(RangeError);
  });
});
