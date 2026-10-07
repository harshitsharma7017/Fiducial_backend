import ExcelJS from 'exceljs';
import { withoutNotes } from '../imports/strip-notes.ts';

// The document engine's Excel tools: open a template, find cells by the labels a person sees,
// write values that keep the template's look, and insert rows without breaking merged cells or
// the print area. Fillers (rfq-template.ts and, later, the QCR and Placement Slip) use only these,
// so the client can move rows in their template and the engine still finds them.

/** Indian digit grouping for whole rupees (1,23,45,678). */
export const RUPEES_FORMAT = '[>=10000000]##\\,##\\,##\\,##0;[>=100000]##\\,##\\,##0;##,##0';

export async function openTemplate(data: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  const readable = await withoutNotes(data);
  await workbook.xlsx.load(readable as unknown as Parameters<ExcelJS.Xlsx['load']>[0]);
  return workbook;
}

export async function saveWorkbook(workbook: ExcelJS.Workbook): Promise<Buffer> {
  // Formulas are kept, not computed here: Excel recalculates them when the file opens.
  workbook.calcProperties = { ...workbook.calcProperties, fullCalcOnLoad: true };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** A label as compared: lower case, words only, single spaces. */
export function labelKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** True for the cells of a merged range other than its top-left (they repeat its value). */
export function isCovered(cell: ExcelJS.Cell): boolean {
  return cell.isMerged && cell.master !== cell;
}

/** A cell's text as shown (formulas give their result, rich text is joined). */
export function cellText(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if ('richText' in value) return value.richText.map((part) => part.text).join('');
    if ('result' in value) {
      const result: unknown = value.result;
      return typeof result === 'string' || typeof result === 'number' || typeof result === 'boolean'
        ? String(result)
        : '';
    }
    if ('text' in value) return String(value.text);
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return '';
  }
  return String(value);
}

/** The sheet named so (ignoring case and spaces), if the template has it. */
export function sheetNamed(
  workbook: ExcelJS.Workbook,
  name: string,
): ExcelJS.Worksheet | undefined {
  const wanted = labelKey(name);
  return workbook.worksheets.find((sheet) => labelKey(sheet.name) === wanted);
}

export interface FindOptions {
  column?: number;
  from?: number;
  to?: number;
  /** Match when the cell's label starts with the text, rather than equals it. */
  prefix?: boolean;
}

/** The first row (1-based) whose cell in the column reads the label, or null. */
export function findRow(
  sheet: ExcelJS.Worksheet,
  label: string,
  options: FindOptions = {},
): number | null {
  const wanted = labelKey(label);
  const column = options.column ?? 1;
  const last = Math.min(options.to ?? sheet.rowCount, sheet.rowCount);
  for (let row = options.from ?? 1; row <= last; row += 1) {
    const cell = sheet.getCell(row, column);
    if (isCovered(cell)) continue;
    const text = labelKey(cellText(cell));
    if (text && (options.prefix ? text.startsWith(wanted) : text === wanted)) return row;
  }
  return null;
}

/** Every row whose cell in the column reads the label. */
export function findRows(sheet: ExcelJS.Worksheet, label: string, column = 1): number[] {
  const rows: number[] = [];
  let from = 1;
  for (;;) {
    const row = findRow(sheet, label, { column, from });
    if (row === null) return rows;
    rows.push(row);
    from = row + 1;
  }
}

/** The column (1-based) of a header in a row, or null. */
export function findColumn(
  sheet: ExcelJS.Worksheet,
  row: number,
  label: string,
  prefix = false,
): number | null {
  const wanted = labelKey(label);
  const columns = Math.max(sheet.columnCount, sheet.getRow(row).cellCount);
  for (let column = 1; column <= columns; column += 1) {
    const cell = sheet.getCell(row, column);
    if (isCovered(cell)) continue;
    const text = labelKey(cellText(cell));
    if (text && (prefix ? text.startsWith(wanted) : text === wanted)) return column;
  }
  return null;
}

/**
 * Changes some of a cell's style for this cell only. Cells loaded from a template share one style
 * object when they look alike, so setting cell.fill or cell.font would change all of them.
 */
export function restyle(cell: ExcelJS.Cell, patch: Partial<ExcelJS.Style>): void {
  cell.style = { ...cell.style, ...patch };
}

/** Writes a value, keeping the cell's style; amounts get Indian grouping where none is set. */
export function setValue(
  sheet: ExcelJS.Worksheet,
  row: number,
  column: number,
  value: string | number | null,
  options: { rupees?: boolean } = {},
): void {
  const cell = sheet.getCell(row, column);
  cell.value = value;
  if (typeof value === 'number' && options.rupees && (!cell.numFmt || cell.numFmt === 'General')) {
    restyle(cell, { numFmt: RUPEES_FORMAT });
  }
  if (typeof value === 'string' && value.includes('\n')) {
    restyle(cell, {
      alignment: { ...cell.alignment, wrapText: true, vertical: cell.alignment?.vertical ?? 'top' },
    });
  }
}

interface Range {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

function mergeRanges(sheet: ExcelJS.Worksheet): Range[] {
  const merges = (sheet.model as { merges?: string[] }).merges ?? [];
  return merges.map((address) => {
    const [from = '', to = from] = address.split(':');
    const start = sheet.getCell(from);
    const end = sheet.getCell(to);
    return {
      top: Number(start.row),
      left: Number(start.col),
      bottom: Number(end.row),
      right: Number(end.col),
    };
  });
}

function rangeAddress(range: Range): [number, number, number, number] {
  return [range.top, range.left, range.bottom, range.right];
}

function shiftPrintArea(sheet: ExcelJS.Worksheet, at: number, count: number): void {
  const area = sheet.pageSetup.printArea;
  if (!area) return;
  sheet.pageSetup.printArea = area
    .split(',')
    .map((part) =>
      part.replace(/(\$?[A-Z]+\$?)(\d+)$/, (match, column: string, row: string) =>
        Number(row) >= at ? `${column}${Number(row) + count}` : match,
      ),
    )
    .join(',');
}

/**
 * Inserts `count` rows before row `at`, styled like row `like` (cells, height and its merges
 * across columns). Merges and the print area below move down; merges spanning `at` grow.
 */
export function insertRows(
  sheet: ExcelJS.Worksheet,
  at: number,
  count: number,
  like: number,
): void {
  if (count <= 0) return;
  const merges = mergeRanges(sheet);
  const touched = merges.filter((range) => range.bottom >= at);
  for (const range of touched) sheet.unMergeCells(...rangeAddress(range));

  const source = sheet.getRow(like);
  const styles = new Map<number, Partial<ExcelJS.Style>>();
  source.eachCell({ includeEmpty: true }, (cell, column) => {
    styles.set(column, JSON.parse(JSON.stringify(cell.style)) as Partial<ExcelJS.Style>);
  });
  const height = source.height;
  const rowMerges = merges
    .filter((range) => range.top === like && range.bottom === like)
    .map((range) => ({ left: range.left, right: range.right }));

  sheet.spliceRows(at, 0, ...Array.from({ length: count }, () => []));

  for (let offset = 0; offset < count; offset += 1) {
    const row = sheet.getRow(at + offset);
    if (height) row.height = height;
    for (const [column, style] of styles)
      row.getCell(column).style = JSON.parse(JSON.stringify(style)) as Partial<ExcelJS.Style>;
  }
  for (const range of touched) {
    const moved =
      range.top >= at
        ? { ...range, top: range.top + count, bottom: range.bottom + count }
        : { ...range, bottom: range.bottom + count };
    sheet.mergeCells(...rangeAddress(moved));
  }
  for (let offset = 0; offset < count; offset += 1) {
    for (const merge of rowMerges) {
      sheet.mergeCells(at + offset, merge.left, at + offset, merge.right);
    }
  }
  shiftPrintArea(sheet, at, count);
}

/** Copies a column's look (cell styles and width) to another column. */
export function copyColumnStyle(
  sheet: ExcelJS.Worksheet,
  from: number,
  to: number,
  rows: number,
): void {
  const width = sheet.getColumn(from).width;
  if (width) sheet.getColumn(to).width = width;
  for (let row = 1; row <= rows; row += 1) {
    sheet.getCell(row, to).style = JSON.parse(
      JSON.stringify(sheet.getCell(row, from).style),
    ) as Partial<ExcelJS.Style>;
  }
}

/** Clears values in a block of cells, keeping their styles. */
export function clearCells(
  sheet: ExcelJS.Worksheet,
  rows: { from: number; to: number },
  columns: { from: number; to: number },
): void {
  for (let row = rows.from; row <= rows.to; row += 1) {
    for (let column = columns.from; column <= columns.to; column += 1) {
      const cell = sheet.getCell(row, column);
      if (cell.isMerged && cell.master !== cell) continue;
      cell.value = null;
    }
  }
}

/** The columns (1-based) of the print area, or of the used range when there is none. */
export function printColumns(sheet: ExcelJS.Worksheet): { from: number; to: number } {
  const area = sheet.pageSetup.printArea?.split(',')[0];
  const match = area
    ? /^\$?([A-Z]+)\$?\d+:\$?([A-Z]+)\$?\d+$/.exec(area.replace(/^.*!/, ''))
    : null;
  if (match) {
    return {
      from: sheet.getColumn(match[1] ?? 'A').number,
      to: sheet.getColumn(match[2] ?? 'A').number,
    };
  }
  return { from: 1, to: sheet.columnCount };
}

/** The rows (1-based) of the print area, or of the used range. */
export function printRows(sheet: ExcelJS.Worksheet): { from: number; to: number } {
  const area = sheet.pageSetup.printArea?.split(',')[0];
  const match = area
    ? /^\$?[A-Z]+\$?(\d+):\$?[A-Z]+\$?(\d+)$/.exec(area.replace(/^.*!/, ''))
    : null;
  if (match) return { from: Number(match[1]), to: Number(match[2]) };
  return { from: 1, to: sheet.rowCount };
}
