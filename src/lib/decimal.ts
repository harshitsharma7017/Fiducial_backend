// Named import: decimal.js ships one CommonJS-style .d.ts, so the default import mis-types
// under "nodenext". The ESM build (decimal.mjs) exports Decimal by name as well.
import { Decimal as DecimalJs } from 'decimal.js';
import { Types } from 'mongoose';

/**
 * decimal.js configured for money and per-mille rates: 40 significant digits, ROUND_HALF_UP,
 * and no exponent notation in string output. Never use JavaScript numbers for money or rates.
 */
export const Decimal = DecimalJs.clone({
  precision: 40,
  rounding: DecimalJs.ROUND_HALF_UP,
  toExpNeg: -40,
  toExpPos: 40,
});
export type Decimal = DecimalJs;
export type DecimalValue = DecimalJs.Value;

export const ROUND_HALF_UP = DecimalJs.ROUND_HALF_UP;

/** Rounds an amount to paise (2 decimals), half up. */
export function roundMoney(value: Decimal): Decimal {
  return value.toDecimalPlaces(2, ROUND_HALF_UP);
}

/** Amount as a string with exactly 2 decimals. */
export function moneyString(value: Decimal): string {
  return value.toFixed(2, ROUND_HALF_UP);
}

/** Full-precision string without trailing zeros or exponent notation, for rates. */
export function decimalString(value: Decimal): string {
  return value.toFixed();
}

export function toDecimal128(value: Decimal | string): Types.Decimal128 {
  return Types.Decimal128.fromString(typeof value === 'string' ? value : value.toFixed());
}

export function fromDecimal128(value: Types.Decimal128 | null | undefined): Decimal | null {
  return value == null ? null : new Decimal(value.toString());
}

/** Decimal128 from MongoDB to the API's string representation. */
export function decimal128ToString(value: Types.Decimal128 | null | undefined): string | null {
  const decimal = fromDecimal128(value);
  return decimal === null ? null : decimalString(decimal);
}
