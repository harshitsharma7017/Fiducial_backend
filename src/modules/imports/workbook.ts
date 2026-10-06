import {
  IMPORT_SHEETS,
  INDIAN_STATES,
  MAX_IMPORT_ROWS,
  type ImportColumn,
  type ImportEntity,
  type ImportIssue,
} from '../../shared/index.ts';
import ExcelJS from 'exceljs';
import { cellText, readCell } from '../masters/import/cells.ts';
import { withoutNotes } from './strip-notes.ts';

const INSTRUCTIONS_SHEET = 'Instructions';
const LISTS_SHEET = 'Lists';
const HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFE8EEF6' },
};
/** Columns typed as text, so Excel keeps leading zeros and does not reformat codes. */
const TEXT_COLUMNS = new Set(['gstin', 'clientGstin', 'pincode', 'occupancyCode']);

function headerText(column: ImportColumn): string {
  return column.required ? `${column.header} *` : column.header;
}

/** A header as typed in a sheet, compared ignoring case, spaces and a trailing "*". */
function headerKey(text: string): string {
  return text
    .replace(/\*+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function addInstructions(workbook: ExcelJS.Workbook, entity: ImportEntity, sample: boolean) {
  const spec = IMPORT_SHEETS[entity];
  const sheet = workbook.addWorksheet(INSTRUCTIONS_SHEET);
  sheet.columns = [{ width: 28 }, { width: 12 }, { width: 90 }];
  sheet.addRow([`${spec.label} import`]).font = { bold: true, size: 14 };
  sheet.addRow([spec.description]);
  sheet.addRow([]);
  const steps = [
    `1. Fill the "${spec.sheetName}" sheet, one ${spec.label.toLowerCase()} record per row, from row 2.`,
    '2. Columns marked * are required. Keep the headers in row 1 as they are.',
    `3. Up to ${MAX_IMPORT_ROWS} rows per file. Blank rows are skipped.`,
    '4. Upload the file on the Import data page. It is checked first; nothing is saved until every row passes.',
  ];
  if (sample) {
    steps.push(
      '',
      'This file holds fictional sample rows that pass the import. GSTINs use the placeholder PAN ZZZZZ, which no real taxpayer has.',
    );
  }
  for (const step of steps) sheet.addRow([step]);
  sheet.addRow([]);
  const header = sheet.addRow(['Column', 'Required', 'What to enter']);
  header.font = { bold: true };
  header.eachCell((cell) => {
    cell.fill = HEADER_FILL;
  });
  for (const column of spec.columns) {
    sheet.addRow([column.header, column.required ? 'Yes' : 'No', column.note]);
  }
}

/**
 * The import template for an entity: an Instructions sheet and the data sheet with its headers,
 * a note on each header, a drop-down for State and text format for codes. Sample rows, when
 * given, are filled in below the headers.
 */
export async function buildTemplate(
  entity: ImportEntity,
  sampleRows: readonly Record<string, string>[] = [],
): Promise<Buffer> {
  const spec = IMPORT_SHEETS[entity];
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Fiducial';
  addInstructions(workbook, entity, sampleRows.length > 0);

  const sheet = workbook.addWorksheet(spec.sheetName, {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  sheet.columns = spec.columns.map((column) => ({
    key: column.key,
    width: Math.max(16, column.header.length + 6),
    style: TEXT_COLUMNS.has(column.key) ? { numFmt: '@' } : {},
  }));
  const header = sheet.getRow(1);
  spec.columns.forEach((column, index) => {
    const cell = header.getCell(index + 1);
    cell.value = headerText(column);
    cell.font = { bold: true };
    cell.fill = HEADER_FILL;
    if (column.note) cell.note = column.note;
  });
  for (const row of sampleRows) sheet.addRow(row);

  const stateIndex = spec.columns.findIndex((column) => column.key === 'state');
  if (stateIndex >= 0) {
    // The list lives on a hidden sheet: an inline list is limited to 255 characters.
    const lists = workbook.addWorksheet(LISTS_SHEET, { state: 'hidden' });
    INDIAN_STATES.forEach((state, index) => {
      lists.getCell(index + 1, 1).value = state;
    });
    const letter = sheet.getColumn(stateIndex + 1).letter;
    const range = `${LISTS_SHEET}!$A$1:$A$${INDIAN_STATES.length}`;
    for (let row = 2; row <= MAX_IMPORT_ROWS + 1; row += 1) {
      sheet.getCell(`${letter}${row}`).dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: [range],
        showErrorMessage: true,
        errorTitle: 'State',
        error: 'Choose a state or union territory from the list.',
      };
    }
  }

  workbook.views = [
    { x: 0, y: 0, width: 20000, height: 12000, activeTab: 1, firstSheet: 0, visibility: 'visible' },
  ];
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export interface SheetRow {
  /** The row number in Excel. */
  row: number;
  values: Record<string, string>;
}

export type ParsedSheet =
  | { ok: true; rows: SheetRow[] }
  /** cause: why the workbook could not be opened, for the server log (not shown to users). */
  | { ok: false; issues: ImportIssue[]; cause?: unknown };

function fileIssue(message: string): ParsedSheet {
  return { ok: false, issues: [{ row: null, column: null, message }] };
}

/** The data sheet: the one named as in the template, else the first that is not instructions. */
function findDataSheet(workbook: ExcelJS.Workbook, name: string): ExcelJS.Worksheet | undefined {
  const wanted = name.toLowerCase();
  return (
    workbook.worksheets.find((sheet) => sheet.name.trim().toLowerCase() === wanted) ??
    workbook.worksheets.find(
      (sheet) =>
        ![INSTRUCTIONS_SHEET, LISTS_SHEET].includes(sheet.name) && sheet.state !== 'hidden',
    )
  );
}

/**
 * Reads an uploaded workbook: finds the columns by their headers in row 1 (in any order), then
 * returns each non-blank row's values as trimmed text keyed by column.
 */
export async function parseUpload(entity: ImportEntity, data: Buffer): Promise<ParsedSheet> {
  const spec = IMPORT_SHEETS[entity];
  // Every .xlsx file is a zip archive, which starts with "PK".
  if (data.length < 4 || data.readUInt32LE(0) !== 0x04034b50) {
    return fileIssue(
      'This is not an Excel workbook (.xlsx). Save the file as .xlsx and try again.',
    );
  }
  const workbook = new ExcelJS.Workbook();
  try {
    const readable = await withoutNotes(data);
    await workbook.xlsx.load(readable as unknown as Parameters<ExcelJS.Xlsx['load']>[0]);
  } catch (cause) {
    const message =
      'The workbook could not be read. Open it in Excel, save it as .xlsx (Excel Workbook) and try again.';
    return { ok: false, issues: [{ row: null, column: null, message }], cause };
  }
  const sheet = findDataSheet(workbook, spec.sheetName);
  if (!sheet) return fileIssue(`The workbook has no "${spec.sheetName}" sheet.`);

  const byHeader = new Map(spec.columns.map((column) => [headerKey(column.header), column]));
  const positions = new Map<string, number>();
  sheet.getRow(1).eachCell((cell, columnNumber) => {
    const text = cellText(readCell(cell));
    const column = text ? byHeader.get(headerKey(text)) : undefined;
    if (column && !positions.has(column.key)) positions.set(column.key, columnNumber);
  });
  const missing = spec.columns.filter((column) => column.required && !positions.has(column.key));
  if (missing.length > 0) {
    return {
      ok: false,
      issues: missing.map((column) => ({
        row: 1,
        column: column.header,
        message: `The "${column.header}" column is missing. Use the headers from the template.`,
      })),
    };
  }

  const rows: SheetRow[] = [];
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const values: Record<string, string> = {};
    let blank = true;
    for (const [key, columnNumber] of positions) {
      const text = cellText(readCell(row.getCell(columnNumber))) ?? '';
      values[key] = text;
      if (text) blank = false;
    }
    if (blank) continue;
    if (rows.length === MAX_IMPORT_ROWS) {
      return fileIssue(
        `The sheet has more than ${MAX_IMPORT_ROWS} rows. Split it into several files.`,
      );
    }
    rows.push({ row: rowNumber, values });
  }
  if (rows.length === 0) return fileIssue(`The "${sheet.name}" sheet has no rows to import.`);
  return { ok: true, rows };
}
