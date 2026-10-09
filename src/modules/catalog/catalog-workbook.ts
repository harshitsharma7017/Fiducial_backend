import {
  CATALOG_MASTERS,
  CATALOG_SHEETS,
  MAX_IMPORT_ROWS,
  catalogRowToCells,
  type CatalogColumn,
  type CatalogItem,
  type CatalogMaster,
} from '../../shared/index.ts';
import ExcelJS from 'exceljs';
import { Decimal } from '../../lib/decimal.ts';
import { withoutNotes } from '../imports/strip-notes.ts';
import { readCell, type RawValue } from '../masters/import/cells.ts';

// The product and cover masters workbook: an Instructions sheet, then one sheet per master with
// its headers in row 1. The download holds the saved rows, so it is edited and uploaded back.

const INSTRUCTIONS_SHEET = 'Instructions';
const HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFE8EEF6' },
};
/** Rows below the data that still get the drop-downs, for rows added in Excel. */
const SPARE_ROWS = 200;

const headerText = (column: CatalogColumn) =>
  column.required ? `${column.header} *` : column.header;

/** A header as typed, compared ignoring case, spaces and a trailing "*". */
function headerKey(text: string): string {
  return text
    .replace(/\*+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function columnWidth(column: CatalogColumn): number {
  if (column.type === 'longtext' || column.type === 'list') return 60;
  if (column.key === 'name' || column.key === 'title') return 44;
  return Math.max(12, column.header.length + 4);
}

/** A cell as Excel should hold it: numbers as numbers, everything else as text. */
function cellValue(column: CatalogColumn, text: string): string | number | null {
  if (text === '') return null;
  if (column.type === 'integer' || column.type === 'rupees' || column.type === 'percent') {
    const number = Number(text);
    if (Number.isSafeInteger(number) || column.type === 'percent') return number;
  }
  return text;
}

function addInstructions(workbook: ExcelJS.Workbook) {
  const sheet = workbook.addWorksheet(INSTRUCTIONS_SHEET);
  sheet.columns = [{ width: 30 }, { width: 12 }, { width: 100 }];
  sheet.addRow(['Policy and cover masters']).font = { bold: true, size: 14 };
  for (const line of [
    'One sheet per master. Edit the rows, keep the headers in row 1, and upload the file on the Import data page.',
    'Each sheet in the file replaces that master as a whole; a sheet left out of the file leaves its master as it is.',
    'The upload is checked first. Nothing is saved until every sheet in the file passes.',
    'Amounts are whole rupees (50000000 for 5 Cr). Percentages are numbers (18 for 18%). Dates are YYYY-MM-DD.',
    'Lists in one cell (schedule lines, add-on covers) are separated by a semicolon (;).',
  ]) {
    sheet.addRow([line]);
  }
  for (const master of CATALOG_MASTERS) {
    const spec = CATALOG_SHEETS[master];
    sheet.addRow([]);
    const title = sheet.addRow([`${spec.sheetName}`, null, spec.description]);
    title.font = { bold: true };
    const header = sheet.addRow(['Column', 'Required', 'What to enter']);
    header.eachCell((cell) => {
      cell.fill = HEADER_FILL;
    });
    for (const column of spec.columns) {
      sheet.addRow([column.header, column.required ? 'Yes' : 'No', column.note]);
    }
  }
}

function addMasterSheet(workbook: ExcelJS.Workbook, master: CatalogMaster, items: CatalogItem[]) {
  const spec = CATALOG_SHEETS[master];
  const sheet = workbook.addWorksheet(spec.sheetName, { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = spec.columns.map((column) => ({
    key: column.key,
    width: columnWidth(column),
    style: {
      ...(column.type === 'date' || column.type === 'code' ? { numFmt: '@' } : {}),
      alignment: {
        vertical: 'top',
        wrapText: column.type === 'longtext' || column.type === 'list',
      },
    },
  }));
  const header = sheet.getRow(1);
  spec.columns.forEach((column, index) => {
    const cell = header.getCell(index + 1);
    cell.value = headerText(column);
    cell.font = { bold: true };
    cell.fill = HEADER_FILL;
    cell.alignment = { wrapText: true, vertical: 'top' };
    if (column.note) cell.note = column.note;
  });
  for (const item of items) {
    const cells = catalogRowToCells(master, item);
    sheet.addRow(spec.columns.map((column) => cellValue(column, cells[column.key] ?? '')));
  }
  const lastRow = items.length + 1 + SPARE_ROWS;
  spec.columns.forEach((column, index) => {
    const options =
      column.type === 'yesno' ? ['Yes', 'No'] : column.type === 'enum' ? column.options : null;
    if (!options) return;
    const letter = sheet.getColumn(index + 1).letter;
    for (let row = 2; row <= lastRow; row += 1) {
      sheet.getCell(`${letter}${row}`).dataValidation = {
        type: 'list',
        allowBlank: !column.required,
        formulae: [`"${options.join(',')}"`],
        showErrorMessage: true,
        errorTitle: column.header,
        error: `Choose one of: ${options.join(', ')}.`,
      };
    }
  });
}

/** The workbook of every master with its saved rows (headers only for an empty master). */
export async function buildCatalogWorkbook(
  rows: Readonly<Record<CatalogMaster, CatalogItem[]>>,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Fiducial';
  addInstructions(workbook);
  for (const master of CATALOG_MASTERS) addMasterSheet(workbook, master, rows[master]);
  workbook.views = [
    { x: 0, y: 0, width: 20000, height: 12000, activeTab: 1, firstSheet: 0, visibility: 'visible' },
  ];
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** A cell as the text a form would hold. Long text keeps its line breaks. */
function cellToText(column: CatalogColumn, value: RawValue): string {
  if (value === null) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') {
    // Excel keeps numbers as binary floats; 15 significant digits recover what was typed.
    return Number.isFinite(value) ? new Decimal(value.toPrecision(15)).toFixed() : String(value);
  }
  if (column.type === 'longtext' || column.type === 'list') {
    return value
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.replace(/[ \t]+/g, ' ').trim())
      .join('\n')
      .trim();
  }
  return value.replace(/\s+/g, ' ').trim();
}

export interface CatalogSheetRows {
  master: CatalogMaster;
  /** False when the workbook has no such sheet. */
  present: boolean;
  rows: { row: number; cells: Record<string, string> }[];
  issues: { row: number | null; column: string | null; message: string }[];
}

export type ParsedCatalogWorkbook =
  { ok: true; sheets: CatalogSheetRows[] } | { ok: false; message: string; cause?: unknown };

function readSheet(sheet: ExcelJS.Worksheet | undefined, master: CatalogMaster): CatalogSheetRows {
  const spec = CATALOG_SHEETS[master];
  if (!sheet) return { master, present: false, rows: [], issues: [] };
  const byHeader = new Map(spec.columns.map((column) => [headerKey(column.header), column]));
  const positions = new Map<string, number>();
  sheet.getRow(1).eachCell((cell, columnNumber) => {
    const raw = readCell(cell);
    const column = typeof raw === 'string' ? byHeader.get(headerKey(raw)) : undefined;
    if (column && !positions.has(column.key)) positions.set(column.key, columnNumber);
  });
  const missing = spec.columns.filter((column) => column.required && !positions.has(column.key));
  if (missing.length > 0) {
    return {
      master,
      present: true,
      rows: [],
      issues: missing.map((column) => ({
        row: 1,
        column: column.header,
        message: `The "${column.header}" column is missing. Use the headers from the downloaded workbook.`,
      })),
    };
  }
  const rows: CatalogSheetRows['rows'] = [];
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const cells: Record<string, string> = {};
    let blank = true;
    for (const column of spec.columns) {
      const position = positions.get(column.key);
      const text = position ? cellToText(column, readCell(row.getCell(position))) : '';
      cells[column.key] = text;
      if (text) blank = false;
    }
    if (blank) continue;
    if (rows.length === MAX_IMPORT_ROWS) {
      return {
        master,
        present: true,
        rows: [],
        issues: [
          { row: null, column: null, message: `More than ${MAX_IMPORT_ROWS} rows in one sheet.` },
        ],
      };
    }
    rows.push({ row: rowNumber, cells });
  }
  return { master, present: true, rows, issues: [] };
}

/** Reads every master's sheet that the workbook has, matched by sheet name. */
export async function parseCatalogWorkbook(data: Buffer): Promise<ParsedCatalogWorkbook> {
  if (data.length < 4 || data.readUInt32LE(0) !== 0x04034b50) {
    return {
      ok: false,
      message: 'This is not an Excel workbook (.xlsx). Save the file as .xlsx and try again.',
    };
  }
  const workbook = new ExcelJS.Workbook();
  try {
    const readable = await withoutNotes(data);
    await workbook.xlsx.load(readable as unknown as Parameters<ExcelJS.Xlsx['load']>[0]);
  } catch (cause) {
    return {
      ok: false,
      message:
        'The workbook could not be read. Open it in Excel, save it as .xlsx (Excel Workbook) and try again.',
      cause,
    };
  }
  const byName = new Map(
    workbook.worksheets.map((sheet) => [sheet.name.trim().toLowerCase(), sheet]),
  );
  const sheets = CATALOG_MASTERS.map((master) =>
    readSheet(
      [CATALOG_SHEETS[master].sheetName, ...(CATALOG_SHEETS[master].formerSheetNames ?? [])]
        .map((name) => byName.get(name.toLowerCase()))
        .find(Boolean),
      master,
    ),
  );
  if (!sheets.some((sheet) => sheet.present)) {
    return {
      ok: false,
      message: `The workbook has none of the master sheets (${CATALOG_MASTERS.map((m) => `"${CATALOG_SHEETS[m].sheetName}"`).join(', ')}). Start from the downloaded workbook.`,
    };
  }
  return { ok: true, sheets };
}
