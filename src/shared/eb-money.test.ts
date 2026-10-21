import { describe, expect, it } from 'vitest';
import {
  compareDecimal,
  ebPremium,
  percentOfSumInsured,
  salaryMultipleSumInsured,
  subtractMoneyFloor,
  sumMoney,
} from './eb-money.ts';

describe('salary multiple (Requirements 4.3, 5.4, open question 9)', () => {
  it('rounds salary × multiplier half up to the rupee', () => {
    expect(salaryMultipleSumInsured('300000', '2.5', null)).toBe('750000');
    expect(salaryMultipleSumInsured('123457', '1.5', null)).toBe('185186'); // 185185.5 → up
    expect(salaryMultipleSumInsured('123455', '1.11', null)).toBe('137035'); // 137035.05
    expect(salaryMultipleSumInsured('1', '0.5', null)).toBe('1'); // 0.5 → 1
    expect(salaryMultipleSumInsured('1', '0.49', null)).toBe('0');
  });

  it('caps at the maximum when one is set', () => {
    expect(salaryMultipleSumInsured('600000', '2', '1000000')).toBe('1000000');
    expect(salaryMultipleSumInsured('400000', '2', '1000000')).toBe('800000');
  });
});

describe('percentage of the sum insured (Requirement 4.5)', () => {
  it('rounds half up to the rupee', () => {
    expect(percentOfSumInsured('500000', '50')).toBe('250000');
    expect(percentOfSumInsured('333333', '50')).toBe('166667'); // 166666.5 → up
    expect(percentOfSumInsured('100001', '33.33')).toBe('33330'); // 33330.33
    expect(percentOfSumInsured('500000', '100')).toBe('500000');
  });
});

describe('quote GST (Requirement 7.2)', () => {
  it('gives 180.01 and 1,180.06 for 1,000.05 at 18%', () => {
    expect(ebPremium('1000.05', '18')).toEqual({
      basePremium: '1000.05',
      gst: '180.01',
      totalPremium: '1180.06',
    });
  });

  it('rounds the GST half up to the paisa and writes two decimals', () => {
    expect(ebPremium('0.25', '18')).toEqual({
      basePremium: '0.25',
      gst: '0.05',
      totalPremium: '0.30',
    }); // 0.045
    expect(ebPremium('100', '12.5')).toEqual({
      basePremium: '100.00',
      gst: '12.50',
      totalPremium: '112.50',
    });
    expect(ebPremium('0', '18').totalPremium).toBe('0.00');
    expect(ebPremium('999999999.99', '100').totalPremium).toBe('1999999999.98');
  });
});

describe('sums', () => {
  it('adds and subtracts money exactly', () => {
    expect(sumMoney(['0.10', '0.20', '1'])).toBe('1.30');
    expect(sumMoney([])).toBe('0.00');
    expect(subtractMoneyFloor('100.00', '30.5')).toBe('69.50');
    expect(subtractMoneyFloor('100.00', '130')).toBe('0.00');
    expect(compareDecimal('1180.06', '1180.060')).toBe(0);
    expect(compareDecimal('2', '10')).toBe(-1);
  });
});
