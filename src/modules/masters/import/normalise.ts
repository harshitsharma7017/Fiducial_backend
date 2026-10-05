import type { RiskGrade, RiskType } from '../../../shared/index.ts';
import { cellText, type RawValue } from './cells.ts';

export type Normalised<T> =
  { kind: 'value'; value: T } | { kind: 'blank' } | { kind: 'invalid'; raw: string };

// The sheet writes "Residential", "Industrial" and "N Industrial".
const RISK_TYPE_SPELLINGS: Record<string, RiskType> = {
  residential: 'RESIDENTIAL',
  industrial: 'INDUSTRIAL',
  'n industrial': 'NON_INDUSTRIAL',
  'n. industrial': 'NON_INDUSTRIAL',
  'non industrial': 'NON_INDUSTRIAL',
  'non-industrial': 'NON_INDUSTRIAL',
  'non - industrial': 'NON_INDUSTRIAL',
  nonindustrial: 'NON_INDUSTRIAL',
};

/** Maps the sheet's risk type text to RESIDENTIAL, NON_INDUSTRIAL or INDUSTRIAL; blank stays blank. */
export function normaliseRiskType(value: RawValue): Normalised<RiskType> {
  const text = cellText(value);
  if (text === null) return { kind: 'blank' };
  const riskType = RISK_TYPE_SPELLINGS[text.toLowerCase()];
  return riskType ? { kind: 'value', value: riskType } : { kind: 'invalid', raw: text };
}

/** RG1 to RG9. */
export function normaliseRiskGrade(value: RawValue): Normalised<RiskGrade> {
  const text = cellText(value);
  if (text === null) return { kind: 'blank' };
  const match = /^RG\s*([1-9])$/i.exec(text);
  return match
    ? { kind: 'value', value: `RG${match[1]}` as RiskGrade }
    : { kind: 'invalid', raw: text };
}

/** TAC codes are text. Numeric cells become their digits ("1001"); text is kept ("1001_2"). */
export function normaliseTacCode(value: RawValue): Normalised<string> {
  const text = cellText(value);
  if (text === null) return { kind: 'blank' };
  return /^[A-Za-z0-9_./-]{1,20}$/.test(text)
    ? { kind: 'value', value: text }
    : { kind: 'invalid', raw: text };
}
