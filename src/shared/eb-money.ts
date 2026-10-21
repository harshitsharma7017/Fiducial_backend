// Exact money arithmetic for Employee Benefits in BigInt fixed point (the web app has no
// decimal.js). Amounts travel as decimal strings; every result is rounded half up. The API
// stores and computes its amounts with Decimal (src/modules/ghi/eb-calc.ts); a unit test there
// pins both to the same results.

interface Fixed {
  /** The digits as an integer. */
  value: bigint;
  /** Decimal places: the number is value / 10^scale. */
  scale: number;
}

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/** Reads a non-negative decimal string ("1000", "1000.05"); throws on anything else. */
function parse(text: string): Fixed {
  const match = DECIMAL.exec(text.trim());
  if (!match) throw new Error(`Not a decimal amount: ${text}`);
  const whole = match[1] ?? '0';
  const fraction = match[2] ?? '';
  return { value: BigInt(whole + fraction), scale: fraction.length };
}

const TEN = 10n;
const pow10 = (exponent: number) => TEN ** BigInt(exponent);

/** numerator / denominator rounded half up to a whole number (both non-negative). */
function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator * 2n + denominator) / (denominator * 2n);
}

function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/** Paise as a rupee string with exactly two decimals. */
function paiseText(paise: bigint): string {
  const whole = paise / 100n;
  const fraction = (paise % 100n).toString().padStart(2, '0');
  return `${whole.toString()}.${fraction}`;
}

/** True when the text is a non-negative decimal string. */
export function isDecimalText(text: string): boolean {
  return DECIMAL.test(text.trim());
}

/** Compares two non-negative decimal strings exactly: -1, 0 or 1. */
export function compareDecimal(a: string, b: string): -1 | 0 | 1 {
  const x = parse(a);
  const y = parse(b);
  const scale = Math.max(x.scale, y.scale);
  const left = x.value * pow10(scale - x.scale);
  const right = y.value * pow10(scale - y.scale);
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The sum insured as a multiple of salary (Requirements 4.3, 5.4): salary × multiplier rounded
 * half up to the whole rupee (open question 9), then capped at the maximum when one is set.
 */
export function salaryMultipleSumInsured(
  annualSalary: string,
  multiplier: string,
  maximum: string | null,
): string {
  const salary = parse(annualSalary);
  const times = parse(multiplier);
  const exact = salary.value * times.value;
  const rupees = roundHalfUp(exact, pow10(salary.scale + times.scale));
  if (maximum === null) return rupees.toString();
  const cap = parse(maximum);
  const capRupees = roundHalfUp(cap.value, pow10(cap.scale));
  return minBig(rupees, capRupees).toString();
}

/**
 * The annual CTC from a monthly salary (N6): monthly × 12, exact for whole rupees (half up to
 * the rupee if paise were ever given).
 */
export function annualFromMonthly(monthlySalary: string): string {
  const monthly = parse(monthlySalary);
  return roundHalfUp(monthly.value * 12n, pow10(monthly.scale)).toString();
}

/** A percentage of a sum insured (GPA dependants, Requirement 4.5), half up to the rupee. */
export function percentOfSumInsured(sumInsured: string, percent: string): string {
  const amount = parse(sumInsured);
  const rate = parse(percent);
  return roundHalfUp(amount.value * rate.value, pow10(amount.scale + rate.scale) * 100n).toString();
}

export interface EbPremium {
  basePremium: string;
  gst: string;
  totalPremium: string;
}

/**
 * A quote's GST and total (Requirement 7.2): GST = base × rate / 100 rounded half up to the
 * paisa; total = base + GST. All three with exactly two decimals.
 */
export function ebPremium(basePremium: string, gstRatePercent: string): EbPremium {
  const base = parse(basePremium);
  const rate = parse(gstRatePercent);
  // base in paise is base.value × 100 / 10^scale; GST in paise is that × rate / 100.
  const basePaise = roundHalfUp(base.value * 100n, pow10(base.scale));
  const gstPaise = roundHalfUp(base.value * rate.value, pow10(base.scale + rate.scale));
  return {
    basePremium: paiseText(basePaise),
    gst: paiseText(gstPaise),
    totalPremium: paiseText(basePaise + gstPaise),
  };
}

/** Adds decimal strings to the paisa; the result has exactly two decimals. */
export function sumMoney(amounts: readonly string[]): string {
  let total = 0n;
  for (const amount of amounts) {
    const value = parse(amount);
    total += roundHalfUp(value.value * 100n, pow10(value.scale));
  }
  return paiseText(total);
}

/** a − b to the paisa, never below 0.00. */
export function subtractMoneyFloor(a: string, b: string): string {
  const x = parse(a);
  const y = parse(b);
  const left = roundHalfUp(x.value * 100n, pow10(x.scale));
  const right = roundHalfUp(y.value * 100n, pow10(y.scale));
  return paiseText(left > right ? left - right : 0n);
}

/** Adds whole rupee strings. */
export function sumRupees(amounts: readonly string[]): string {
  let total = 0n;
  for (const amount of amounts) total += parse(amount).value / pow10(parse(amount).scale);
  return total.toString();
}
