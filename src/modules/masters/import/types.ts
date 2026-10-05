import type { EqZone, RiskGrade, RiskType } from '../../../shared/index.ts';

/** Decimal strings, or null when the cell was blank or not a number. */
export interface ZoneRateValues {
  zone1: string | null;
  zone2: string | null;
  zone3: string | null;
  zone4: string | null;
}

export interface OccupancyRow {
  sourceRow: number;
  serialNo: number | null;
  tacCode: string;
  description: string;
  riskGrade: RiskGrade | null;
  iibRate: string | null;
  iibRateNote: string | null;
  fireRiskType: RiskType | null;
  terrorismRiskType: RiskType | null;
  minStfiRate: string | null;
  minEqRates: ZoneRateValues;
}

export interface PincodeRow {
  sourceRow: number;
  pincode: string;
  state: string;
  district: string;
  eqZone: EqZone | null;
  eqRates: { residential: string | null; nonIndustrial: string | null; industrial: string | null };
}

export interface SkippedRow {
  row: number;
  reason: string;
  value: string | null;
}

export interface OccupancySheetReport {
  sheet: string;
  /** Non-empty data rows. */
  rowsRead: number;
  recordsValid: number;
  rowsSkipped: number;
  /** The IIB rate column's year label (E2), for example "2019". */
  rateYearLabel: string | null;
  skippedRows: SkippedRow[];
  blankRiskTypes: Array<{
    row: number;
    tacCode: string;
    description: string;
    field: 'Fire' | 'Terrorism';
  }>;
  unrecognisedRiskTypes: Array<{
    row: number;
    tacCode: string;
    field: 'Fire' | 'Terrorism';
    value: string;
  }>;
  nonNumericRates: Array<{
    row: number;
    tacCode: string;
    description: string;
    column: string;
    field: string;
    value: string | null;
  }>;
  riskGradeIssues: Array<{ row: number; tacCode: string; value: string | null }>;
  otherWarnings: Array<{ row: number; message: string }>;
  /** Rows with a fill colour. The sheet does not say what highlighting means. */
  highlightedRows: Array<{ row: number; tacCode: string; description: string; colour: string }>;
}

export interface PincodeSheetReport {
  sheet: string;
  rowsRead: number;
  recordsValid: number;
  /** Rows not imported: invalid pincodes and later duplicates. */
  rowsSkipped: number;
  skippedRows: SkippedRow[];
  /** The first row is kept; later rows with the same pincode are skipped. */
  duplicates: Array<{ pincode: string; keptRow: number; duplicateRow: number; identical: boolean }>;
  nonNumericRates: Array<{
    row: number;
    pincode: string;
    column: string;
    field: string;
    value: string | null;
  }>;
  invalidZones: Array<{ row: number; pincode: string; value: string | null }>;
  blankFields: Array<{ row: number; pincode: string; field: 'State' | 'District' }>;
  /** State values that are not a current state or union territory name. */
  unrecognisedStates: Array<{ value: string; rows: number; suggestion: string | null }>;
  /** The same state written more than one way. */
  inconsistentStateSpellings: Array<{
    state: string;
    spellings: Array<{ value: string; rows: number }>;
  }>;
  /** Pincodes whose first digit does not belong to the state's postal region. */
  regionMismatches: Array<{
    row: number;
    pincode: string;
    state: string;
    district: string;
    /** The current state name the check used (the sheet may use a former name). */
    regionState: string;
    expectedFirstDigits: string;
  }>;
}

export interface CrossCheckReport {
  /** Most common occupancy minimum EQ rate for each Fire risk type and zone. */
  reference: Record<RiskType, ZoneRateValues>;
  /** Occupancies whose zone columns differ from the reference for their risk type. */
  occupancyDeviations: Array<{
    row: number;
    tacCode: string;
    riskType: RiskType;
    zones: Array<{ zone: EqZone; value: string; reference: string }>;
  }>;
  /** Pincodes with at least one EQ rate that differs from the reference for its zone. */
  pincodesWithMismatch: number;
  mismatchGroups: Array<{
    zone: EqZone;
    riskType: RiskType;
    pincodeRate: string | null;
    expected: string;
    count: number;
    samplePincodes: string[];
  }>;
}

export interface ImportReport {
  sourceFileName: string;
  sourceSha256: string;
  occupancy: OccupancySheetReport;
  pincode: PincodeSheetReport;
  crossCheck: CrossCheckReport;
}

export interface ParsedIibWorkbook {
  occupancies: OccupancyRow[];
  pincodes: PincodeRow[];
  report: ImportReport;
}

export function occupancyWarningCount(report: ImportReport): number {
  const sheet = report.occupancy;
  return (
    sheet.blankRiskTypes.length +
    sheet.unrecognisedRiskTypes.length +
    sheet.nonNumericRates.length +
    sheet.riskGradeIssues.length +
    sheet.otherWarnings.length +
    report.crossCheck.occupancyDeviations.length
  );
}

export function pincodeWarningCount(report: ImportReport): number {
  const sheet = report.pincode;
  return (
    sheet.duplicates.length +
    sheet.nonNumericRates.length +
    sheet.invalidZones.length +
    sheet.blankFields.length +
    sheet.unrecognisedStates.length +
    sheet.inconsistentStateSpellings.length +
    sheet.regionMismatches.length +
    report.crossCheck.mismatchGroups.length
  );
}
