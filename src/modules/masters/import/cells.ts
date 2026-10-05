import type { Cell, CellValue } from 'exceljs';
import { Decimal } from '../../../lib/decimal.ts';

/** What a cell shows: formula results, rich text joined, hyperlink text, error codes as text. */
export type RawValue = string | number | boolean | Date | null;

function fromCellValue(value: CellValue): RawValue {
  if (value === null || value === undefined) return null;
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value instanceof Date
  ) {
    return value;
  }
  if ('result' in value) return fromCellValue(value.result);
  if ('richText' in value) return value.richText.map((part) => part.text).join('');
  if ('error' in value) return String(value.error);
  if ('text' in value && typeof value.text === 'string') return value.text;
  return null;
}

export function readCell(cell: Cell): RawValue {
  return fromCellValue(cell.value);
}

/** Trimmed text with inner whitespace (including line breaks) collapsed; null when blank. */
export function cellText(value: RawValue): string | null {
  if (value === null) return null;
  const text = (value instanceof Date ? value.toISOString() : String(value))
    .replace(/\s+/g, ' ')
    .trim();
  return text === '' ? null : text;
}

export type RateResult =
  | { kind: 'value'; value: string }
  | { kind: 'blank' }
  | { kind: 'invalid'; reason: 'NOT_NUMERIC' | 'NEGATIVE'; raw: string };

const DECIMAL_TEXT = /^-?\d+(\.\d+)?$/;

/**
 * Reads a per-mille rate cell as a normalised decimal string. Excel stores numbers as binary
 * floats (0.04999999999999999), so numbers are read to 15 significant digits, the precision a
 * double holds, which recovers the value typed in the sheet (0.05).
 */
export function parseRate(value: RawValue): RateResult {
  if (value === null) return { kind: 'blank' };
  let decimal: Decimal;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      return { kind: 'invalid', reason: 'NOT_NUMERIC', raw: String(value) };
    decimal = new Decimal(value.toPrecision(15));
  } else {
    const text = cellText(value);
    if (text === null) return { kind: 'blank' };
    if (typeof value === 'boolean' || !DECIMAL_TEXT.test(text)) {
      return { kind: 'invalid', reason: 'NOT_NUMERIC', raw: text };
    }
    decimal = new Decimal(text);
  }
  if (decimal.isNegative()) return { kind: 'invalid', reason: 'NEGATIVE', raw: decimal.toFixed() };
  return { kind: 'value', value: decimal.toFixed() };
}

/** Whole numbers only (serial numbers, zones, pincodes); null otherwise. */
export function parseWholeNumber(value: RawValue): number | null {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  const text = cellText(value);
  return text !== null && /^\d+$/.test(text) ? Number(text) : null;
}

/** The fill colour of a highlighted cell (ARGB or theme), or null when the cell has no fill. */
export function cellHighlight(cell: Cell): string | null {
  const fill = cell.fill;
  if (fill?.type !== 'pattern' || fill.pattern !== 'solid') return null;
  const colour = fill.fgColor;
  if (!colour) return null;
  if (colour.argb)
    return colour.argb.toUpperCase() === 'FFFFFFFF' ? null : colour.argb.toUpperCase();
  if (colour.theme !== undefined) return `theme ${colour.theme}`;
  return null;
}
