import { describe, expect, it } from 'vitest';
import {
  formatAmount,
  formatDate,
  formatDateTime,
  formatRate,
  groupIndianDigits,
  roundDecimalString,
} from './format.ts';

describe('groupIndianDigits', () => {
  it.each([
    ['0', '0'],
    ['999', '999'],
    ['1000', '1,000'],
    ['12345', '12,345'],
    ['136880', '1,36,880'],
    ['10000000', '1,00,00,000'],
    ['100000000', '10,00,00,000'],
  ])('groups %s as %s', (input, expected) => {
    expect(groupIndianDigits(input)).toBe(expected);
  });
});

describe('roundDecimalString', () => {
  it.each([
    ['1', 2, '1.00'],
    ['8.51805', 2, '8.52'],
    ['0.005', 2, '0.01'],
    ['0.004', 2, '0.00'],
    ['9.995', 2, '10.00'],
    ['0.999', 2, '1.00'],
    ['-1.005', 2, '-1.01'],
    ['-0.001', 2, '0.00'],
    ['12.5', 0, '13'],
    ['007.10', 2, '7.10'],
  ])('rounds %s to %i decimals as %s', (input, digits, expected) => {
    expect(roundDecimalString(input, digits)).toBe(expected);
  });

  it('returns null for non-decimal input', () => {
    expect(roundDecimalString('1e5', 2)).toBeNull();
    expect(roundDecimalString('abc', 2)).toBeNull();
  });
});

describe('formatAmount', () => {
  it('uses Indian grouping and two decimals', () => {
    expect(formatAmount('136880')).toBe('1,36,880.00');
    expect(formatAmount('136880.00')).toBe('1,36,880.00');
    expect(formatAmount('100000000')).toBe('10,00,00,000.00');
    expect(formatAmount('20880.004')).toBe('20,880.00');
    expect(formatAmount('-1234567.895')).toBe('-12,34,567.90');
  });

  it('keeps precision beyond the float range', () => {
    expect(formatAmount('12345678901234.56')).toBe('1,23,45,67,89,01,234.56');
  });

  it('returns the input unchanged when it is not a number', () => {
    expect(formatAmount('n/a')).toBe('n/a');
  });
});

describe('formatRate', () => {
  it('shows at least two decimals', () => {
    expect(formatRate('0.69')).toBe('0.69');
    expect(formatRate('1.1')).toBe('1.10');
    expect(formatRate('2')).toBe('2.00');
    expect(formatRate('0.0500')).toBe('0.05');
  });

  it('keeps extra decimals held in the master', () => {
    expect(formatRate('0.075')).toBe('0.075');
    expect(formatRate('0.225')).toBe('0.225');
  });
});

describe('formatDate', () => {
  it('formats as DD MMM YYYY in India time', () => {
    expect(formatDate('2026-10-05T06:30:00.000Z')).toBe('05 Oct 2026');
    // 20:00 UTC on 4 Oct is already 5 Oct in India.
    expect(formatDate('2026-10-04T20:00:00.000Z')).toBe('05 Oct 2026');
    expect(formatDate('2026-09-01T00:00:00.000Z')).toBe('01 Sep 2026');
  });

  it('formats date and time', () => {
    expect(formatDateTime('2026-10-05T06:30:00.000Z')).toBe('05 Oct 2026, 12:00');
  });

  it('returns an empty string for invalid dates', () => {
    expect(formatDate('not a date')).toBe('');
  });
});
