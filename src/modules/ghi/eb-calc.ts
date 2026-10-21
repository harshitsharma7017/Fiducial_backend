import { Decimal, ROUND_HALF_UP, moneyString } from '../../lib/decimal.ts';

// The API's Employee Benefits amounts, worked out with Decimal (ROUND_HALF_UP) as every stored
// amount is (Requirement 25.7). src/shared/eb-money.ts holds BigInt twins for the web app;
// eb-calc.test.ts pins both to the same results (design D9).

/** salary × multiplier, half up to the rupee, then capped at the maximum (4.3, 5.4). */
export function salaryMultipleSumInsured(
  annualSalary: string,
  multiplier: string,
  maximum: string | null,
): string {
  const amount = new Decimal(annualSalary).times(multiplier).toDecimalPlaces(0, ROUND_HALF_UP);
  if (maximum === null) return amount.toFixed(0);
  return Decimal.min(amount, new Decimal(maximum).toDecimalPlaces(0, ROUND_HALF_UP)).toFixed(0);
}

/** The annual CTC from a monthly salary: monthly × 12, half up to the rupee (N6). */
export function annualFromMonthly(monthlySalary: string): string {
  return new Decimal(monthlySalary).times(12).toDecimalPlaces(0, ROUND_HALF_UP).toFixed(0);
}

/** sumInsured × percent / 100, half up to the rupee (4.5). */
export function percentOfSumInsured(sumInsured: string, percent: string): string {
  return new Decimal(sumInsured)
    .times(percent)
    .dividedBy(100)
    .toDecimalPlaces(0, ROUND_HALF_UP)
    .toFixed(0);
}

/** GST at the case's rate, half up to the paisa, and the total (7.2). */
export function ebPremium(basePremium: string, gstRatePercent: string) {
  const base = new Decimal(basePremium);
  const gst = base.times(gstRatePercent).dividedBy(100).toDecimalPlaces(2, ROUND_HALF_UP);
  return {
    basePremium: moneyString(base),
    gst: moneyString(gst),
    totalPremium: moneyString(base.plus(gst)),
  };
}
