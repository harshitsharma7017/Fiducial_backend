import {
  GHI_CENSUS_COLUMNS,
  GHI_CENSUS_SHEET,
  GHI_GENDER_ALIASES,
  GHI_RELATIONSHIP_ALIASES,
  MAX_GHI_CENSUS_ROWS,
  type GhiCensusField,
  type GhiCensusRowValues,
} from '../../shared/index.ts';
import ExcelJS from 'exceljs';
import { readCell, type RawValue } from '../masters/import/cells.ts';
import { withoutNotes } from '../imports/strip-notes.ts';

// The census template (G3) and reading an uploaded census: columns are found by their headers
// (the template's, or the names HR files commonly use), in any order.

const INSTRUCTIONS_SHEET = 'Instructions';
const HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFE8EEF6' },
};
const DATE_COLUMNS = new Set<GhiCensusField>(['dateOfBirth', 'dateOfJoining']);

/** Other headers HR files use for each column (compared ignoring case, spaces and dots). */
const HEADER_ALIASES: Record<GhiCensusField, readonly string[]> = {
  employeeId: ['Employee ID', 'Emp ID', 'Employee Code', 'Emp Code', 'Employee No', 'Emp No'],
  name: ['Name', 'Member Name', 'Insured Name', 'Full Name', 'Employee Name'],
  gender: ['Gender', 'Sex'],
  dateOfBirth: ['Date of Birth', 'DOB', 'Birth Date'],
  relationship: ['Relationship', 'Relation', 'Relationship with Employee'],
  dateOfJoining: ['Date of Joining', 'DOJ', 'Joining Date'],
  sumInsured: ['Sum Insured', 'SI', 'Sum Assured'],
};

function headerKey(text: string): string {
  return text
    .replace(/\*+\s*$/, '')
    .toLowerCase()
    .replace(/[\s._-]+/g, '');
}

const FIELD_BY_HEADER = new Map<string, GhiCensusField>(
  Object.entries(HEADER_ALIASES).flatMap(([field, aliases]) =>
    aliases.map((alias) => [headerKey(alias), field as GhiCensusField] as const),
  ),
);

/** The census template: instructions, then the Census sheet with drop-downs and date formats. */
export async function buildCensusTemplate(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Fiducial';
  const help = workbook.addWorksheet(INSTRUCTIONS_SHEET);
  help.columns = [{ width: 22 }, { width: 12 }, { width: 96 }];
  help.addRow(['Group health census']).font = { bold: true, size: 14 };
  for (const line of [
    `1. Fill the "${GHI_CENSUS_SHEET}" sheet: one row per insured life (the employee and each dependant), from row 2.`,
    '2. Each dependant repeats the employee ID of the employee they belong to. Add the employee’s own row (Self) too.',
    '3. Columns marked * are required. Keep the headers in row 1. Dates as DD/MM/YYYY.',
    `4. Up to ${MAX_GHI_CENSUS_ROWS.toLocaleString('en-IN')} rows per file. Blank rows are skipped.`,
    '5. Upload the file on the case’s Census tab. Every row is checked first, with its row number and field; nothing is saved until you import.',
    '6. Family rules: one spouse, at most three children, and either parents or parents-in-law, as the case’s Data Sheet allows.',
    '7. Family floater: the employee’s sum insured covers the family, so dependants may leave it blank. Individual: every member gives their own.',
  ]) {
    help.addRow([line]);
  }
  help.addRow([]);
  const head = help.addRow(['Column', 'Required', 'What to enter']);
  head.font = { bold: true };
  head.eachCell((cell) => {
    cell.fill = HEADER_FILL;
  });
  const notes: Record<GhiCensusField, string> = {
    employeeId: 'The employee’s ID, the same on every member of the family.',
    name: 'The insured member’s full name.',
    gender: 'Male, Female or Other (M, F, O accepted).',
    dateOfBirth: 'DD/MM/YYYY. Ages are worked out on the case’s age reference date.',
    relationship: `${GHI_RELATIONSHIP_ALIASES.SELF[0]}, ${['SPOUSE', 'CHILD', 'FATHER', 'MOTHER', 'FATHER_IN_LAW', 'MOTHER_IN_LAW'].map((key) => GHI_RELATIONSHIP_ALIASES[key as keyof typeof GHI_RELATIONSHIP_ALIASES][0]).join(', ')}. Son, Daughter, Wife and Husband are accepted.`,
    dateOfJoining: 'The employee’s date of joining, DD/MM/YYYY.',
    sumInsured:
      'Whole rupees, for example 500000. Required on the employee’s row; on every row for individual cover.',
  };
  for (const column of GHI_CENSUS_COLUMNS) {
    help.addRow([column.header, column.required ? 'Yes' : 'No', notes[column.key]]);
  }

  const sheet = workbook.addWorksheet(GHI_CENSUS_SHEET, {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  sheet.columns = GHI_CENSUS_COLUMNS.map((column) => ({
    key: column.key,
    width: column.key === 'name' ? 32 : 18,
    style: DATE_COLUMNS.has(column.key)
      ? { numFmt: 'dd/mm/yyyy' }
      : column.key === 'employeeId'
        ? { numFmt: '@' }
        : column.key === 'sumInsured'
          ? { numFmt: '#,##0' }
          : {},
  }));
  const header = sheet.getRow(1);
  GHI_CENSUS_COLUMNS.forEach((column, index) => {
    const cell = header.getCell(index + 1);
    cell.value = column.required ? `${column.header} *` : column.header;
    cell.font = { bold: true };
    cell.fill = HEADER_FILL;
    cell.note = notes[column.key];
  });
  const lists: Partial<Record<GhiCensusField, string>> = {
    gender: Object.values(GHI_GENDER_ALIASES)
      .map((aliases) => aliases[0])
      .join(','),
    relationship: Object.values(GHI_RELATIONSHIP_ALIASES)
      .map((aliases) => aliases[0])
      .join(','),
  };
  GHI_CENSUS_COLUMNS.forEach((column, index) => {
    const list = lists[column.key];
    if (!list) return;
    const letter = sheet.getColumn(index + 1).letter;
    // Data validation per cell would bloat the file; one range covers the template's rows.
    (
      sheet as unknown as {
        dataValidations: { add(range: string, rule: ExcelJS.DataValidation): void };
      }
    ).dataValidations.add(`${letter}2:${letter}${MAX_GHI_CENSUS_ROWS + 1}`, {
      type: 'list',
      allowBlank: true,
      formulae: [`"${list}"`],
      showErrorMessage: false,
    });
  });
  workbook.views = [
    { x: 0, y: 0, width: 20000, height: 12000, activeTab: 1, firstSheet: 0, visibility: 'visible' },
  ];
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** A cell's value as the census reads it: dates as YYYY-MM-DD, numbers without grouping. */
function cellString(value: RawValue): string {
  if (value === null) return '';
  if (value instanceof Date) {
    // Excel dates come as midnight UTC of the day shown in the cell.
    return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
  }
  return String(value).replace(/\s+/g, ' ').trim();
}

export type ParsedCensus =
  | { ok: true; rows: Array<{ row: number; values: GhiCensusRowValues }> }
  | { ok: false; issues: string[] };

/** Reads an uploaded census workbook into rows of text, with their Excel row numbers. */
export async function parseCensusWorkbook(data: Buffer): Promise<ParsedCensus> {
  if (data.length < 4 || data.readUInt32LE(0) !== 0x04034b50) {
    return {
      ok: false,
      issues: ['This is not an Excel workbook (.xlsx). Save the file as .xlsx and try again.'],
    };
  }
  const workbook = new ExcelJS.Workbook();
  try {
    const readable = await withoutNotes(data);
    await workbook.xlsx.load(readable as unknown as Parameters<ExcelJS.Xlsx['load']>[0]);
  } catch {
    return {
      ok: false,
      issues: [
        'The workbook could not be read. Open it in Excel, save it as .xlsx (Excel Workbook) and try again.',
      ],
    };
  }
  const sheet =
    workbook.worksheets.find(
      (item) => item.name.trim().toLowerCase() === GHI_CENSUS_SHEET.toLowerCase(),
    ) ??
    workbook.worksheets.find((item) => item.name !== INSTRUCTIONS_SHEET && item.state !== 'hidden');
  if (!sheet) return { ok: false, issues: [`The workbook has no "${GHI_CENSUS_SHEET}" sheet.`] };

  const positions = new Map<GhiCensusField, number>();
  sheet.getRow(1).eachCell((cell, columnNumber) => {
    const field = FIELD_BY_HEADER.get(headerKey(cellString(readCell(cell))));
    if (field && !positions.has(field)) positions.set(field, columnNumber);
  });
  const missing = GHI_CENSUS_COLUMNS.filter(
    (column) => column.required && !positions.has(column.key),
  );
  if (missing.length > 0) {
    return {
      ok: false,
      issues: missing.map(
        (column) =>
          `Row 1: the "${column.header}" column is missing. Use the headers from the census template.`,
      ),
    };
  }

  const rows: Array<{ row: number; values: GhiCensusRowValues }> = [];
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const values = Object.fromEntries(
      GHI_CENSUS_COLUMNS.map((column) => {
        const position = positions.get(column.key);
        return [
          column.key,
          position ? cellString(readCell(row.getCell(position))).slice(0, 200) : '',
        ];
      }),
    ) as GhiCensusRowValues;
    if (Object.values(values).every((value) => value === '')) continue;
    if (rows.length === MAX_GHI_CENSUS_ROWS) {
      return {
        ok: false,
        issues: [
          `The sheet has more than ${MAX_GHI_CENSUS_ROWS.toLocaleString('en-IN')} rows. Split it into several files.`,
        ],
      };
    }
    rows.push({ row: rowNumber, values });
  }
  if (rows.length === 0) return { ok: false, issues: [`The "${sheet.name}" sheet has no rows.`] };
  return { ok: true, rows };
}
