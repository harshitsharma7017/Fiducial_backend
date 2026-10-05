/**
 * Fire rating: a pure, side-effect-free calculation with decimal arithmetic.
 *
 * Rates are per mille: premium = sum insured x rate / 1000. Each component premium is rounded
 * to 2 decimals (ROUND_HALF_UP) and the base premium is the sum of the rounded components, so
 * the breakdown always adds up. GST is rounded the same way.
 */
import { DEFAULT_GST_RATE_PERCENT } from '../../shared/index.ts';
import { Decimal, roundMoney, type DecimalValue } from '../../lib/decimal.ts';
import {
  calculateAddOnPremiums,
  totalAddOnPremium,
  type AddOnPremiumLine,
} from './extension-points.ts';

const PER_MILLE = new Decimal(1000);
const HUNDRED = new Decimal(100);

export interface FireRatingInput {
  sumInsured: DecimalValue;
  /** IIB rate of the occupancy, per mille. */
  iibRate: DecimalValue;
  /** STFI rate, per mille (the occupancy minimum). */
  stfiRate: DecimalValue;
  /** EQ rate of the pincode for the occupancy's Fire risk type, per mille. */
  eqRate: DecimalValue;
  /** Terrorism rate per mille. Terrorism is only priced when a rate is supplied. */
  terrorismRate?: DecimalValue | null;
  /** GST percentage, default 18. */
  gstRatePercent?: DecimalValue;
}

export interface FireComponents<T> {
  fire: T;
  stfi: T;
  earthquake: T;
  terrorism: T | null;
}

export interface FireRatingResult {
  sumInsured: Decimal;
  rates: FireComponents<Decimal>;
  premiums: FireComponents<Decimal>;
  basePremium: Decimal;
  /** Sum of the component rates included in the base premium, per mille. */
  policyRate: Decimal;
  /** Always empty until add-on formulas are confirmed (see extension-points.ts). */
  addOns: AddOnPremiumLine[];
  totalBeforeTax: Decimal;
  gstRatePercent: Decimal;
  gst: Decimal;
  total: Decimal;
}

function toDecimal(name: string, value: DecimalValue): Decimal {
  let decimal: Decimal;
  try {
    decimal = new Decimal(value);
  } catch {
    throw new RangeError(`${name} is not a valid number`);
  }
  if (!decimal.isFinite()) throw new RangeError(`${name} must be finite`);
  return decimal;
}

function nonNegative(name: string, value: DecimalValue): Decimal {
  const decimal = toDecimal(name, value);
  if (decimal.isNegative()) throw new RangeError(`${name} cannot be negative`);
  return decimal;
}

function positive(name: string, value: DecimalValue): Decimal {
  const decimal = toDecimal(name, value);
  if (!decimal.greaterThan(0)) throw new RangeError(`${name} must be greater than zero`);
  return decimal;
}

/** sumInsured x rate / 1000, rounded to 2 decimals half up. */
export function perMillePremium(sumInsured: Decimal, rate: Decimal): Decimal {
  return roundMoney(sumInsured.times(rate).dividedBy(PER_MILLE));
}

export function calculateFire(input: FireRatingInput): FireRatingResult {
  const sumInsured = positive('sumInsured', input.sumInsured);
  const rates: FireComponents<Decimal> = {
    fire: nonNegative('iibRate', input.iibRate),
    stfi: nonNegative('stfiRate', input.stfiRate),
    earthquake: nonNegative('eqRate', input.eqRate),
    terrorism:
      input.terrorismRate == null ? null : nonNegative('terrorismRate', input.terrorismRate),
  };
  const gstRatePercent = nonNegative(
    'gstRatePercent',
    input.gstRatePercent ?? DEFAULT_GST_RATE_PERCENT,
  );

  const premiums: FireComponents<Decimal> = {
    fire: perMillePremium(sumInsured, rates.fire),
    stfi: perMillePremium(sumInsured, rates.stfi),
    earthquake: perMillePremium(sumInsured, rates.earthquake),
    terrorism: rates.terrorism === null ? null : perMillePremium(sumInsured, rates.terrorism),
  };

  const basePremium = premiums.fire
    .plus(premiums.stfi)
    .plus(premiums.earthquake)
    .plus(premiums.terrorism ?? 0);
  const policyRate = rates.fire
    .plus(rates.stfi)
    .plus(rates.earthquake)
    .plus(rates.terrorism ?? 0);

  const addOns = calculateAddOnPremiums({ sumInsured, policyRate });
  const totalBeforeTax = basePremium.plus(totalAddOnPremium(addOns));
  const gst = roundMoney(totalBeforeTax.times(gstRatePercent).dividedBy(HUNDRED));
  const total = totalBeforeTax.plus(gst);

  return {
    sumInsured,
    rates,
    premiums,
    basePremium,
    policyRate,
    addOns,
    totalBeforeTax,
    gstRatePercent,
    gst,
    total,
  };
}
