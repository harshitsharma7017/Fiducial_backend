import {
  basisText,
  ebQuoteOptions,
  type EbQuoteOptionPremium,
  type SumInsuredBasis,
} from '../../shared/index.ts';
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

/**
 * A GPA or GTLI quote's premium for each option of the case (client review 4/11/2026): Option 1 is
 * the quote's own premium, Options 2–4 those quoted for the other sum insured bases (null where the
 * insurer did not quote one).
 */
export function ebQuoteOptionPremiums(
  quote: {
    basePremium: { toString(): string } | null;
    gst: { toString(): string } | null;
    totalPremium: { toString(): string } | null;
    optionPremiums?: ReadonlyArray<{
      basePremium: string;
      gst: string;
      totalPremium: string;
    } | null>;
  },
  requirements: {
    sumInsuredBasis: SumInsuredBasis | null;
    quoteOptions?: readonly { basis: SumInsuredBasis }[] | undefined;
  },
): EbQuoteOptionPremium[] {
  const money = (value: { toString(): string } | null) =>
    value === null ? null : new Decimal(value.toString()).toFixed(2);
  return ebQuoteOptions(requirements).map((info) => {
    const premium =
      info.option === 1
        ? {
            basePremium: money(quote.basePremium),
            gst: money(quote.gst),
            totalPremium: money(quote.totalPremium),
          }
        : (quote.optionPremiums?.[info.option - 2] ?? null);
    return {
      option: info.option,
      label: info.label,
      basis: basisText(info.basis),
      basePremium: premium?.basePremium ?? null,
      gst: premium?.gst ?? null,
      totalPremium: premium?.totalPremium ?? null,
    };
  });
}

/** For each option, the indexes of the quotes with its lowest total (among those that quoted it). */
export function lowestByEbOption(premiums: readonly EbQuoteOptionPremium[][]): Set<number>[] {
  const count = premiums[0]?.length ?? 0;
  return Array.from({ length: count }, (_, option) => {
    const priced = premiums.flatMap((list, index) => {
      const total = list[option]?.totalPremium ?? null;
      return total === null ? [] : [{ index, total }];
    });
    let lowest: Decimal | null = null;
    for (const item of priced) {
      const total = new Decimal(item.total);
      if (lowest === null || total.lessThan(lowest)) lowest = total;
    }
    return new Set(
      priced
        .filter((item) => lowest !== null && new Decimal(item.total).equals(lowest))
        .map((item) => item.index),
    );
  });
}
