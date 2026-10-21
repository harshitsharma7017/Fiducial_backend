import { describe, expect, it } from 'vitest';
import * as shared from '../../shared/eb-money.ts';
import { premiumOf } from './ghi-quote-calc.ts';
import {
  annualFromMonthly,
  ebPremium,
  percentOfSumInsured,
  salaryMultipleSumInsured,
} from './eb-calc.ts';

// The Decimal functions the API uses and the BigInt functions the web app uses must agree
// (design D9), including on the .5 ties.

const salaries = [
  '1',
  '7',
  '99999',
  '123455',
  '123457',
  '250000',
  '333333',
  '999999',
  '1000000',
  '9999999999999',
];
const multipliers = [
  '0.01',
  '0.5',
  '1',
  '1.11',
  '1.5',
  '2.25',
  '2.5',
  '3',
  '33.33',
  '99.99',
  '100',
];
const caps = [null, '1', '500000', '1000000', '9999999999999'];
const percents = ['0.01', '1', '12.5', '33.33', '50', '66.67', '99.99', '100'];
const premiums = [
  '0',
  '0.01',
  '0.05',
  '0.25',
  '1',
  '999.99',
  '1000.05',
  '123456.78',
  '999999999.99',
];
const rates = ['0', '5', '12', '12.5', '18', '18.25', '28', '100'];

describe('Decimal and BigInt money agree', () => {
  it('on the salary multiple with and without a cap', () => {
    for (const salary of salaries) {
      for (const multiplier of multipliers) {
        for (const cap of caps) {
          expect(
            salaryMultipleSumInsured(salary, multiplier, cap),
            `${salary} × ${multiplier} cap ${cap}`,
          ).toBe(shared.salaryMultipleSumInsured(salary, multiplier, cap));
        }
      }
    }
  });

  it('on the annual CTC from a monthly salary, and the N6 example', () => {
    for (const salary of salaries) {
      expect(annualFromMonthly(salary)).toBe(shared.annualFromMonthly(salary));
    }
    // ₹50,000 a month is ₹6,00,000 a year; at 4 × the sum assured is ₹24,00,000.
    expect(annualFromMonthly('50000')).toBe('600000');
    expect(salaryMultipleSumInsured(annualFromMonthly('50000'), '4', null)).toBe('2400000');
    expect(salaryMultipleSumInsured(annualFromMonthly('50000'), '4', '2000000')).toBe('2000000');
  });

  it('on percentages of the sum insured', () => {
    for (const salary of salaries) {
      for (const percent of percents) {
        expect(percentOfSumInsured(salary, percent)).toBe(
          shared.percentOfSumInsured(salary, percent),
        );
      }
    }
  });

  it('on GST and totals, and with the GHI premium calculation', () => {
    for (const premium of premiums) {
      for (const rate of rates) {
        const decimal = ebPremium(premium, rate);
        expect(decimal, `${premium} at ${rate}%`).toEqual(shared.ebPremium(premium, rate));
        expect(premiumOf(premium, rate)).toEqual(decimal);
      }
    }
    expect(ebPremium('1000.05', '18')).toEqual({
      basePremium: '1000.05',
      gst: '180.01',
      totalPremium: '1180.06',
    });
  });
});
