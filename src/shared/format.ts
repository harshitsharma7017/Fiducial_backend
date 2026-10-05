/**
 * Display formatting for amounts, rates and dates.
 * All number formatting works on decimal strings, so values never pass through floating point.
 */

const DECIMAL_PATTERN = /^\s*(-)?(\d+)(?:\.(\d+))?\s*$/;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Dates are shown in India Standard Time. */
export const DISPLAY_TIME_ZONE = 'Asia/Kolkata';

interface ParsedDecimal {
  negative: boolean;
  integer: string;
  fraction: string;
}

function parseDecimal(value: string): ParsedDecimal | null {
  const match = DECIMAL_PATTERN.exec(value);
  if (!match) return null;
  return {
    negative: match[1] === '-',
    integer: (match[2] ?? '0').replace(/^0+(?=\d)/, ''),
    fraction: match[3] ?? '',
  };
}

function incrementDigits(digits: string): string {
  const chars = digits.split('');
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    if (chars[i] === '9') {
      chars[i] = '0';
    } else {
      chars[i] = String(Number(chars[i]) + 1);
      return chars.join('');
    }
  }
  return `1${chars.join('')}`;
}

/**
 * Rounds a decimal string to a fixed number of decimals, half away from zero
 * (the same rule as decimal.js ROUND_HALF_UP). Returns null when the input is not a decimal.
 */
export function roundDecimalString(value: string, fractionDigits: number): string | null {
  const parsed = parseDecimal(value);
  if (!parsed) return null;
  let { integer, fraction } = parsed;

  if (fraction.length > fractionDigits) {
    const roundUp = Number(fraction[fractionDigits]) >= 5;
    let digits = integer + fraction.slice(0, fractionDigits);
    if (roundUp) digits = incrementDigits(digits);
    integer = digits.slice(0, digits.length - fractionDigits) || '0';
    fraction = digits.slice(digits.length - fractionDigits);
  } else {
    fraction = fraction.padEnd(fractionDigits, '0');
  }

  const isZero = /^0*$/.test(integer + fraction);
  const sign = parsed.negative && !isZero ? '-' : '';
  return fractionDigits > 0 ? `${sign}${integer}.${fraction}` : `${sign}${integer}`;
}

/** Groups integer digits the Indian way: 1,36,880 and 10,00,00,000. */
export function groupIndianDigits(integerDigits: string): string {
  if (integerDigits.length <= 3) return integerDigits;
  const lastThree = integerDigits.slice(-3);
  const rest = integerDigits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${rest},${lastThree}`;
}

/** Formats a decimal string with Indian digit grouping and a fixed number of decimals. */
export function formatIndianNumber(value: string, fractionDigits = 2): string {
  const rounded = roundDecimalString(value, fractionDigits);
  if (rounded === null) return value;
  const negative = rounded.startsWith('-');
  const [integer = '0', fraction] = (negative ? rounded.slice(1) : rounded).split('.');
  const grouped = groupIndianDigits(integer);
  return `${negative ? '-' : ''}${grouped}${fraction === undefined ? '' : `.${fraction}`}`;
}

/** Rupee amount with Indian grouping and 2 decimals, for example 1,36,880.00. */
export function formatAmount(value: string): string {
  return formatIndianNumber(value, 2);
}

/**
 * Per-mille rate with at least 2 decimals. More decimals are kept when the master holds them
 * (0.075 stays 0.075) so a displayed rate never differs from the stored one.
 */
export function formatRate(value: string, minFractionDigits = 2): string {
  const parsed = parseDecimal(value);
  if (!parsed) return value;
  const significantFraction = parsed.fraction.replace(/0+$/, '');
  return formatIndianNumber(value, Math.max(minFractionDigits, significantFraction.length));
}

interface DateParts {
  day: string;
  month: string;
  year: string;
  hour: string;
  minute: string;
}

function toDateParts(value: string | Date, timeZone: string): DateParts | null {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? '';
  return {
    day: part('day'),
    month: MONTHS[Number(part('month')) - 1] ?? '',
    year: part('year'),
    hour: part('hour'),
    minute: part('minute'),
  };
}

/** Date as DD MMM YYYY, for example 05 Oct 2026. Returns an empty string for invalid input. */
export function formatDate(value: string | Date, timeZone: string = DISPLAY_TIME_ZONE): string {
  const parts = toDateParts(value, timeZone);
  return parts ? `${parts.day} ${parts.month} ${parts.year}` : '';
}

/** Date and 24-hour time, for example 05 Oct 2026, 14:30. */
export function formatDateTime(value: string | Date, timeZone: string = DISPLAY_TIME_ZONE): string {
  const parts = toDateParts(value, timeZone);
  return parts ? `${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute}` : '';
}
