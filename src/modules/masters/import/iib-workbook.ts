import type { EqZone } from '../../../shared/index.ts';
import ExcelJS, { type Row, type Worksheet } from 'exceljs';
import {
  cellHighlight,
  cellText,
  parseRate,
  parseWholeNumber,
  readCell,
  type RawValue,
} from './cells.ts';
import { crossCheckEqRates } from './cross-check.ts';
import { matchState, pinFirstDigits } from './india-states.ts';
import { normaliseRiskGrade, normaliseRiskType, normaliseTacCode } from './normalise.ts';
import type {
  OccupancyRow,
  OccupancySheetReport,
  ParsedIibWorkbook,
  PincodeRow,
  PincodeSheetReport,
  ZoneRateValues,
} from './types.ts';

export const OCCUPANCY_SHEET = 'IIB Code';
export const PINCODE_SHEET = 'Pincode';

/** The workbook does not have the expected sheets or headers; nothing is imported. */
export class ImportStructureError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(
      `The workbook does not have the expected layout:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    );
    this.name = 'ImportStructureError';
    this.problems = problems;
  }
}

// "IIB Code": group headers on row 1, column headers on row 2, data from row 3, columns A to L.
const OCC = {
  serialNo: 1,
  tacCode: 2,
  description: 3,
  riskGrade: 4,
  iibRate: 5,
  fireRiskType: 6,
  terrorismRiskType: 7,
  minStfiRate: 8,
  zone4: 9,
  zone3: 10,
  zone2: 11,
  zone1: 12,
} as const;
const OCC_FIRST_DATA_ROW = 3;
const OCC_LAST_COLUMN = 12;

// "Pincode": headers on row 1, data from row 2, columns A to G.
const PIN = {
  pincode: 1,
  state: 2,
  district: 3,
  zone: 4,
  residential: 5,
  nonIndustrial: 6,
  industrial: 7,
} as const;
const PIN_FIRST_DATA_ROW = 2;
const PIN_LAST_COLUMN = 7;

const OCC_RATE_FIELDS = [
  { key: 'iibRate', column: 'E', label: 'IIB rate' },
  { key: 'minStfiRate', column: 'H', label: 'Min STFI rate' },
  { key: 'zone4', column: 'I', label: 'Min EQ rate Zone IV' },
  { key: 'zone3', column: 'J', label: 'Min EQ rate Zone III' },
  { key: 'zone2', column: 'K', label: 'Min EQ rate Zone II' },
  { key: 'zone1', column: 'L', label: 'Min EQ rate Zone I' },
] as const;

const PIN_RATE_FIELDS = [
  { key: 'residential', column: 'E', label: 'Residential EQ rate' },
  { key: 'nonIndustrial', column: 'F', label: 'Non-industrial EQ rate' },
  { key: 'industrial', column: 'G', label: 'Industrial EQ rate' },
] as const;

function header(row: Row, column: number): string {
  return (cellText(readCell(row.getCell(column))) ?? '').toLowerCase();
}

function findSheet(workbook: ExcelJS.Workbook, name: string): Worksheet | undefined {
  const wanted = name.trim().toLowerCase();
  return workbook.worksheets.find((sheet) => sheet.name.trim().toLowerCase() === wanted);
}

function checkOccupancyHeaders(sheet: Worksheet): string[] {
  const groups = sheet.getRow(1);
  const columns = sheet.getRow(2);
  const problems: string[] = [];
  const expect = (ok: boolean, message: string) => {
    if (!ok) problems.push(`${OCCUPANCY_SHEET}: ${message}`);
  };
  expect(header(columns, OCC.serialNo) === 's no', 'A2 should be "S No"');
  expect(header(columns, OCC.tacCode).includes('tac'), 'B2 should be the TAC occupancy code');
  expect(
    header(columns, OCC.description).includes('description'),
    'C2 should be the occupancy description',
  );
  expect(header(columns, OCC.riskGrade).includes('risk grade'), 'D2 should be "Risk Grade"');
  expect(header(groups, OCC.iibRate).includes('iib rate'), 'E1 should be "IIB Rate"');
  expect(
    header(groups, OCC.fireRiskType).includes('fire'),
    'F1 should be the type of risk for Fire',
  );
  expect(
    header(groups, OCC.terrorismRiskType).includes('terrorism'),
    'G1 should be the type of risk for Terrorism',
  );
  expect(header(groups, OCC.minStfiRate).includes('stfi'), 'H1 should be "Min STFI Rate"');
  const zones = [
    [OCC.zone4, 'I2', 'Zone IV'],
    [OCC.zone3, 'J2', 'Zone III'],
    [OCC.zone2, 'K2', 'Zone II'],
    [OCC.zone1, 'L2', 'Zone I'],
  ] as const;
  for (const [column, cell, label] of zones) {
    expect(header(columns, column) === label.toLowerCase(), `${cell} should be "${label}"`);
  }
  return problems;
}

function checkPincodeHeaders(sheet: Worksheet): string[] {
  const row = sheet.getRow(1);
  const problems: string[] = [];
  const expect = (ok: boolean, message: string) => {
    if (!ok) problems.push(`${PINCODE_SHEET}: ${message}`);
  };
  expect(header(row, PIN.pincode) === 'pincode', 'A1 should be "Pincode"');
  expect(header(row, PIN.state) === 'state', 'B1 should be "State"');
  expect(header(row, PIN.district) === 'district', 'C1 should be "District"');
  expect(
    header(row, PIN.zone).includes('earthquake zone'),
    'D1 should be the AIFT earthquake zone',
  );
  expect(
    header(row, PIN.residential).includes('residential'),
    'E1 should be the Residential risk rate',
  );
  const nonIndustrial = header(row, PIN.nonIndustrial);
  expect(
    nonIndustrial.includes('non') && nonIndustrial.includes('industrial'),
    'F1 should be the Non-Industrial risk rate',
  );
  expect(
    header(row, PIN.industrial).startsWith('industrial'),
    'G1 should be the Industrial risk rate',
  );
  return problems;
}

function readRow(row: Row, lastColumn: number): RawValue[] {
  const values: RawValue[] = [];
  for (let column = 1; column <= lastColumn; column += 1)
    values.push(readCell(row.getCell(column)));
  return values;
}

const isBlankRow = (values: RawValue[]) => values.every((value) => cellText(value) === null);

function value(values: RawValue[], column: number): RawValue {
  return values[column - 1] ?? null;
}

function parseOccupancies(sheet: Worksheet): {
  rows: OccupancyRow[];
  report: OccupancySheetReport;
} {
  const report: OccupancySheetReport = {
    sheet: sheet.name,
    rowsRead: 0,
    recordsValid: 0,
    rowsSkipped: 0,
    rateYearLabel: cellText(readCell(sheet.getRow(2).getCell(OCC.iibRate))),
    skippedRows: [],
    blankRiskTypes: [],
    unrecognisedRiskTypes: [],
    nonNumericRates: [],
    riskGradeIssues: [],
    otherWarnings: [],
    highlightedRows: [],
  };
  const rows: OccupancyRow[] = [];
  const seen = new Map<string, number>();

  for (let rowNumber = OCC_FIRST_DATA_ROW; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const values = readRow(row, OCC_LAST_COLUMN);
    if (isBlankRow(values)) continue;
    report.rowsRead += 1;

    const tac = normaliseTacCode(value(values, OCC.tacCode));
    if (tac.kind !== 'value') {
      report.skippedRows.push({
        row: rowNumber,
        reason: tac.kind === 'blank' ? 'TAC code is blank' : 'TAC code has unexpected characters',
        value: tac.kind === 'invalid' ? tac.raw : null,
      });
      continue;
    }
    const tacCode = tac.value;
    const firstRow = seen.get(tacCode);
    if (firstRow !== undefined) {
      report.skippedRows.push({
        row: rowNumber,
        reason: `Duplicate TAC code (first in row ${firstRow})`,
        value: tacCode,
      });
      continue;
    }
    seen.set(tacCode, rowNumber);

    const description = cellText(value(values, OCC.description)) ?? '';
    if (!description)
      report.otherWarnings.push({ row: rowNumber, message: `${tacCode}: description is blank` });

    const serialNo = parseWholeNumber(value(values, OCC.serialNo));
    if (serialNo === null)
      report.otherWarnings.push({
        row: rowNumber,
        message: `${tacCode}: S No is not a whole number`,
      });

    const grade = normaliseRiskGrade(value(values, OCC.riskGrade));
    if (grade.kind !== 'value') {
      report.riskGradeIssues.push({
        row: rowNumber,
        tacCode,
        value: grade.kind === 'invalid' ? grade.raw : null,
      });
    }

    const riskTypes = { Fire: OCC.fireRiskType, Terrorism: OCC.terrorismRiskType } as const;
    const resolvedRiskTypes: Record<keyof typeof riskTypes, OccupancyRow['fireRiskType']> = {
      Fire: null,
      Terrorism: null,
    };
    for (const field of ['Fire', 'Terrorism'] as const) {
      const riskType = normaliseRiskType(value(values, riskTypes[field]));
      if (riskType.kind === 'value') resolvedRiskTypes[field] = riskType.value;
      else if (riskType.kind === 'blank')
        report.blankRiskTypes.push({ row: rowNumber, tacCode, description, field });
      else
        report.unrecognisedRiskTypes.push({ row: rowNumber, tacCode, field, value: riskType.raw });
    }

    const rates: Record<(typeof OCC_RATE_FIELDS)[number]['key'], string | null> = {
      iibRate: null,
      minStfiRate: null,
      zone4: null,
      zone3: null,
      zone2: null,
      zone1: null,
    };
    let iibRateNote: string | null = null;
    for (const field of OCC_RATE_FIELDS) {
      const parsed = parseRate(value(values, OCC[field.key]));
      if (parsed.kind === 'value') {
        rates[field.key] = parsed.value;
        continue;
      }
      const raw = parsed.kind === 'invalid' ? parsed.raw : null;
      // Text in the IIB rate column is a rating instruction; keep it so users can see it.
      if (field.key === 'iibRate' && parsed.kind === 'invalid' && parsed.reason === 'NOT_NUMERIC')
        iibRateNote = raw;
      report.nonNumericRates.push({
        row: rowNumber,
        tacCode,
        description,
        column: field.column,
        field:
          parsed.kind === 'invalid' && parsed.reason === 'NEGATIVE'
            ? `${field.label} (negative)`
            : field.label,
        value: raw,
      });
    }

    for (let column = 1; column <= OCC_LAST_COLUMN; column += 1) {
      const colour = cellHighlight(row.getCell(column));
      if (colour) {
        report.highlightedRows.push({ row: rowNumber, tacCode, description, colour });
        break;
      }
    }

    const minEqRates: ZoneRateValues = {
      zone1: rates.zone1,
      zone2: rates.zone2,
      zone3: rates.zone3,
      zone4: rates.zone4,
    };
    rows.push({
      sourceRow: rowNumber,
      serialNo,
      tacCode,
      description,
      riskGrade: grade.kind === 'value' ? grade.value : null,
      iibRate: rates.iibRate,
      iibRateNote,
      fireRiskType: resolvedRiskTypes.Fire,
      terrorismRiskType: resolvedRiskTypes.Terrorism,
      minStfiRate: rates.minStfiRate,
      minEqRates,
    });
  }

  report.recordsValid = rows.length;
  report.rowsSkipped = report.skippedRows.length;
  return { rows, report };
}

function samePincodeData(a: PincodeRow, b: PincodeRow): boolean {
  return (
    a.state === b.state &&
    a.district === b.district &&
    a.eqZone === b.eqZone &&
    a.eqRates.residential === b.eqRates.residential &&
    a.eqRates.nonIndustrial === b.eqRates.nonIndustrial &&
    a.eqRates.industrial === b.eqRates.industrial
  );
}

function toZone(raw: RawValue): EqZone | null {
  const zone = parseWholeNumber(raw);
  return zone === 1 || zone === 2 || zone === 3 || zone === 4 ? zone : null;
}

function parsePincodes(sheet: Worksheet): { rows: PincodeRow[]; report: PincodeSheetReport } {
  const report: PincodeSheetReport = {
    sheet: sheet.name,
    rowsRead: 0,
    recordsValid: 0,
    rowsSkipped: 0,
    skippedRows: [],
    duplicates: [],
    nonNumericRates: [],
    invalidZones: [],
    blankFields: [],
    unrecognisedStates: [],
    inconsistentStateSpellings: [],
    regionMismatches: [],
  };
  const rows: PincodeRow[] = [];
  const kept = new Map<string, PincodeRow>();
  const stateCounts = new Map<string, number>();

  for (let rowNumber = PIN_FIRST_DATA_ROW; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const values = readRow(sheet.getRow(rowNumber), PIN_LAST_COLUMN);
    if (isBlankRow(values)) continue;
    report.rowsRead += 1;

    const rawPincode = value(values, PIN.pincode);
    const pincode =
      typeof rawPincode === 'number' && Number.isInteger(rawPincode)
        ? String(rawPincode)
        : cellText(rawPincode);
    if (pincode === null || !/^\d{6}$/.test(pincode)) {
      report.skippedRows.push({
        row: rowNumber,
        reason: 'Pincode is not six digits',
        value: pincode,
      });
      continue;
    }

    const state = cellText(value(values, PIN.state)) ?? '';
    const district = cellText(value(values, PIN.district)) ?? '';
    const zoneRaw = value(values, PIN.zone);
    const eqZone = toZone(zoneRaw);

    const eqRates: PincodeRow['eqRates'] = {
      residential: null,
      nonIndustrial: null,
      industrial: null,
    };
    const rateProblems: PincodeSheetReport['nonNumericRates'] = [];
    for (const field of PIN_RATE_FIELDS) {
      const parsed = parseRate(value(values, PIN[field.key]));
      if (parsed.kind === 'value') eqRates[field.key] = parsed.value;
      else {
        rateProblems.push({
          row: rowNumber,
          pincode,
          column: field.column,
          field: field.label,
          value: parsed.kind === 'invalid' ? parsed.raw : null,
        });
      }
    }

    const record: PincodeRow = { sourceRow: rowNumber, pincode, state, district, eqZone, eqRates };

    const first = kept.get(pincode);
    if (first) {
      report.duplicates.push({
        pincode,
        keptRow: first.sourceRow,
        duplicateRow: rowNumber,
        identical: samePincodeData(first, record),
      });
      continue;
    }
    kept.set(pincode, record);
    rows.push(record);

    report.nonNumericRates.push(...rateProblems);
    if (eqZone === null)
      report.invalidZones.push({ row: rowNumber, pincode, value: cellText(zoneRaw) });
    if (!state) report.blankFields.push({ row: rowNumber, pincode, field: 'State' });
    if (!district) report.blankFields.push({ row: rowNumber, pincode, field: 'District' });

    if (state) {
      stateCounts.set(state, (stateCounts.get(state) ?? 0) + 1);
      const match = matchState(state);
      const resolved = match.canonical ?? match.suggestion;
      const digits = resolved ? pinFirstDigits(resolved) : null;
      if (resolved && digits && !digits.includes(pincode.charAt(0))) {
        report.regionMismatches.push({
          row: rowNumber,
          pincode,
          state,
          district,
          regionState: resolved,
          expectedFirstDigits: digits,
        });
      }
    }
  }

  const spellings = new Map<string, Array<{ value: string; rows: number }>>();
  for (const [state, count] of stateCounts) {
    const match = matchState(state);
    if (!match.canonical)
      report.unrecognisedStates.push({ value: state, rows: count, suggestion: match.suggestion });
    const groupKey = match.canonical ?? match.suggestion ?? state;
    spellings.set(groupKey, [...(spellings.get(groupKey) ?? []), { value: state, rows: count }]);
  }
  report.unrecognisedStates.sort((a, b) => b.rows - a.rows);
  for (const [state, variants] of spellings) {
    if (variants.length > 1) {
      report.inconsistentStateSpellings.push({
        state,
        spellings: variants.sort((a, b) => b.rows - a.rows),
      });
    }
  }
  report.inconsistentStateSpellings.sort((a, b) => a.state.localeCompare(b.state));

  report.recordsValid = rows.length;
  report.rowsSkipped = report.skippedRows.length + report.duplicates.length;
  return { rows, report };
}

export interface ParseOptions {
  sourceFileName: string;
  sourceSha256: string;
}

/**
 * Reads and validates the IIB workbook. Throws ImportStructureError when sheets or headers are
 * not as expected; row-level problems never throw but are collected in the report.
 */
export async function parseIibWorkbook(
  data: Buffer,
  options: ParseOptions,
): Promise<ParsedIibWorkbook> {
  const workbook = new ExcelJS.Workbook();
  try {
    // exceljs declares its own global `Buffer` type that conflicts with Node's; at runtime it
    // reads a Node Buffer directly.
    await workbook.xlsx.load(data as unknown as Parameters<ExcelJS.Xlsx['load']>[0]);
  } catch {
    throw new ImportStructureError(['The file is not a readable .xlsx workbook']);
  }

  const occupancySheet = findSheet(workbook, OCCUPANCY_SHEET);
  const pincodeSheet = findSheet(workbook, PINCODE_SHEET);
  const problems: string[] = [];
  if (!occupancySheet) problems.push(`Sheet "${OCCUPANCY_SHEET}" is missing`);
  if (!pincodeSheet) problems.push(`Sheet "${PINCODE_SHEET}" is missing`);
  if (occupancySheet) problems.push(...checkOccupancyHeaders(occupancySheet));
  if (pincodeSheet) problems.push(...checkPincodeHeaders(pincodeSheet));
  if (problems.length > 0 || !occupancySheet || !pincodeSheet)
    throw new ImportStructureError(problems);

  const occupancies = parseOccupancies(occupancySheet);
  const pincodes = parsePincodes(pincodeSheet);

  return {
    occupancies: occupancies.rows,
    pincodes: pincodes.rows,
    report: {
      sourceFileName: options.sourceFileName,
      sourceSha256: options.sourceSha256,
      occupancy: occupancies.report,
      pincode: pincodes.report,
      crossCheck: crossCheckEqRates(occupancies.rows, pincodes.rows),
    },
  };
}
