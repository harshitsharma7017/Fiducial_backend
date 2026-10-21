import { describe, expect, it } from 'vitest';
import {
  field,
  normalizePercent,
  normalizeRupees,
  premiumDiscrepancies,
  type OcrField,
} from './quote-ocr.ts';

// Q1: the pure extraction logic. These are the unblocked, dependency-free parts of the OCR
// pipeline — currency/percent normalization and premium arithmetic checks — tested against safe
// synthetic inputs. Real insurer-layout accuracy stays pending until the client supplies samples.

describe('normalizeRupees', () => {
  it('handles Indian grouping, currency symbols and paise', () => {
    expect(normalizeRupees('₹1,25,000.00')).toBe('125000.00');
    expect(normalizeRupees('Rs. 1,25,000')).toBe('125000');
    expect(normalizeRupees('INR 50,00,000.50')).toBe('5000000.50');
    expect(normalizeRupees('  2500  ')).toBe('2500');
  });

  it('recovers common OCR character confusions', () => {
    expect(normalizeRupees('l25,O00')).toBe('125000'); // l->1, O->0
    expect(normalizeRupees('₹ S0,000')).toBe('50000'); // S->5
  });

  it('accepts a European-style decimal comma', () => {
    expect(normalizeRupees('125.000,50')).toBe('125000.50');
  });

  it('leaves unreadable or ambiguous values unresolved (null)', () => {
    expect(normalizeRupees('')).toBeNull();
    expect(normalizeRupees('see annexure')).toBeNull();
    expect(normalizeRupees('12..34')).toBeNull();
    expect(normalizeRupees(null)).toBeNull();
  });
});

describe('normalizePercent', () => {
  it('strips the percent sign and extra formatting', () => {
    expect(normalizePercent('18%')).toBe('18');
    expect(normalizePercent('18.00 %')).toBe('18');
    expect(normalizePercent('GST @ 18')).toBe('18');
    expect(normalizePercent('12.5%')).toBe('12.5');
  });

  it('rejects out-of-range or unreadable rates', () => {
    expect(normalizePercent('180%')).toBeNull();
    expect(normalizePercent('n/a')).toBeNull();
    expect(normalizePercent(null)).toBeNull();
  });
});

describe('field', () => {
  it('classifies clean, missing and invalid values', () => {
    expect(field('₹100', '100').state).toBe('HIGH');
    expect(field(null, null).state).toBe('MISSING');
    expect(field('garbled', null).state).toBe('INVALID');
  });
});

function f(value: string | null): OcrField {
  return field(value, value);
}

describe('premiumDiscrepancies', () => {
  const base = {
    sections: [],
    netPremium: f('100000.00'),
    gstRatePercent: f('18'),
    gstAmount: f('18000.00'),
    totalPremium: f('118000.00'),
  };

  it('is silent when net + GST = total and GST matches the rate', () => {
    expect(premiumDiscrepancies(base)).toEqual([]);
  });

  it('flags a net + GST vs total mismatch beyond tolerance', () => {
    const out = premiumDiscrepancies({ ...base, totalPremium: f('120000.00') });
    expect(out.some((m) => /does not match the stated total/.test(m))).toBe(true);
  });

  it('flags a GST amount that does not fit the stated rate', () => {
    const out = premiumDiscrepancies({
      ...base,
      gstAmount: f('15000.00'),
      totalPremium: f('115000.00'),
    });
    expect(out.some((m) => /works out to about/.test(m))).toBe(true);
  });

  it('tolerates one rupee of rounding by default', () => {
    expect(premiumDiscrepancies({ ...base, totalPremium: f('118000.50') })).toEqual([]);
  });

  it('flags section premiums that do not add up to the net', () => {
    const out = premiumDiscrepancies({
      ...base,
      sections: [
        { code: 'FIRE', premium: f('60000.00'), premiumWithoutTerrorism: f(null) },
        { code: 'BURGLARY', premium: f('20000.00'), premiumWithoutTerrorism: f(null) },
      ],
    });
    expect(out.some((m) => /section premiums add up/.test(m))).toBe(true);
  });

  it('preserves conflicting figures (does not throw or mutate) for staff review', () => {
    const input = { ...base, gstAmount: f('17000.00'), totalPremium: f('117000.00') };
    const snapshot = structuredClone(input);
    premiumDiscrepancies(input);
    expect(input).toEqual(snapshot);
  });
});
