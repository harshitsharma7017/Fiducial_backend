import ExcelJS from 'exceljs';
import { withoutNotes } from '../imports/strip-notes.ts';
import { COVER_TICK, COVER_TICK_ARGB, TABLE_HEADER_FILL_ARGB } from './document-theme.ts';

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

  // spliceRows moves cells, not the rows' hidden flags and heights: they are moved here.
  const below = Array.from({ length: Math.max(sheet.rowCount - at + 1, 0) }, (_, index) => {
    const row = sheet.getRow(at + index);
    return { hidden: row.hidden, height: row.height };
  });
  sheet.spliceRows(at, 0, ...Array.from({ length: count }, () => []));
  below.forEach((props, index) => {
    const row = sheet.getRow(at + count + index);
    row.hidden = props.hidden;
    if (props.height) row.height = props.height;
  });

  for (let offset = 0; offset < count; offset += 1) {
    const row = sheet.getRow(at + offset);
    row.hidden = false;
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

/**
 * Hides a row: documents leave out what is empty or not required. A label merged down from the
 * row (the "Addon coverages" column) moves to the next row of its range, so the rows still shown
 * keep it.
 */
export function hideRow(sheet: ExcelJS.Worksheet, row: number): void {
  for (const range of mergeRanges(sheet)) {
    if (range.top !== row || range.bottom === row) continue;
    const master = sheet.getCell(row, range.left);
    const value = master.value;
    const style = JSON.parse(JSON.stringify(master.style)) as Partial<ExcelJS.Style>;
    sheet.unMergeCells(...rangeAddress(range));
    const next = sheet.getCell(row + 1, range.left);
    next.value = value;
    next.style = style;
    if (range.bottom > row + 1 || range.right > range.left) {
      sheet.mergeCells(row + 1, range.left, range.bottom, range.right);
    }
  }
  sheet.getRow(row).hidden = true;
}

/**
 * Hides the rows from `from` up to (not including) `to`, clearing their values first so no blank
 * framed row is printed. Documents leave out what is empty: when a titled block (for example
 * "Warranties / Conditions") has fewer lines than the template reserved, the unused rows between
 * it and the next title are hidden rather than shown empty. Does nothing when the range is empty.
 */
export function hideRowsBetween(sheet: ExcelJS.Worksheet, from: number, to: number): void {
  const columns = { from: 1, to: Math.max(sheet.columnCount, 1) };
  for (let row = from; row < to; row += 1) {
    clearCells(sheet, { from: row, to: row }, columns);
    hideRow(sheet, row);
  }
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

/** Marks an add-on cover asked for: a green tick, centred (in place of the word "Required"). */
export function markTick(cell: ExcelJS.Cell): void {
  cell.value = COVER_TICK;
  restyle(cell, {
    font: { ...cell.font, bold: true, color: { argb: COVER_TICK_ARGB } },
    alignment: { ...cell.alignment, horizontal: 'center', vertical: 'middle' },
  });
}

/** A heading row stands out: the table-header tint and bold text (client review, 27 Oct 2026). */
export function highlightHeading(
  sheet: ExcelJS.Worksheet,
  row: number,
  columns: { from: number; to: number },
): void {
  for (let column = columns.from; column <= columns.to; column += 1) {
    const cell = sheet.getCell(row, column);
    if (isCovered(cell)) continue;
    // A heading the template already fills (the navy section titles) keeps its own fill.
    const filled = cell.fill?.type === 'pattern' && cell.fill.pattern === 'solid';
    restyle(cell, {
      ...(filled
        ? {}
        : {
            fill: {
              type: 'pattern',
              pattern: 'solid',
              fgColor: { argb: TABLE_HEADER_FILL_ARGB },
            } satisfies ExcelJS.Fill,
          }),
      font: { ...cell.font, bold: true },
    });
  }
}

/**
 * Numbers the shown rows of a block 1, 2, 3… in the column, centred, so the S No reads in order
 * even when lines are left out (client review, 27 Oct 2026). Only cells that already hold a number
 * are renumbered; hidden rows are skipped.
 */
export function renumberRows(sheet: ExcelJS.Worksheet, rows: readonly number[], column = 1): void {
  let number = 0;
  for (const row of rows) {
    if (sheet.getRow(row).hidden) continue;
    const cell = sheet.getCell(row, column);
    if (isCovered(cell) || !/^\d+$/.test(cellText(cell).trim())) continue;
    number += 1;
    cell.value = number;
    restyle(cell, { alignment: { ...cell.alignment, horizontal: 'center', vertical: 'middle' } });
  }
}

/** A formula with its row references inside `from`..`to` moved by `delta`. */
function shiftFormula(formula: string, from: number, to: number, delta: number): string {
  return formula.replace(/(\$?[A-Z]{1,3})(\$?)(\d+)/g, (match, column: string, dollar, row) => {
    const number = Number(row);
    return number >= from && number <= to ? `${column}${dollar}${number + delta}` : match;
  });
}

/**
 * Copies rows `from`..`to` (values, formulas, styles, heights and the merges inside them) to new
 * rows inserted before row `at` (below the source), so a template block can be repeated — a
 * fourth quote option when the template has three. Formulas move with their rows.
 */
export function duplicateRows(
  sheet: ExcelJS.Worksheet,
  from: number,
  to: number,
  at: number,
): void {
  const count = to - from + 1;
  if (count <= 0 || at <= to) return;
  const inside = mergeRanges(sheet).filter((range) => range.top >= from && range.bottom <= to);
  const columns = Math.max(sheet.columnCount, 1);
  const source = Array.from({ length: count }, (_, offset) => {
    const row = sheet.getRow(from + offset);
    return {
      height: row.height,
      hidden: row.hidden,
      cells: Array.from({ length: columns }, (_, index) => {
        const cell = sheet.getCell(from + offset, index + 1);
        return {
          value: isCovered(cell) ? null : cell.value,
          style: JSON.parse(JSON.stringify(cell.style)) as Partial<ExcelJS.Style>,
        };
      }),
    };
  });
  insertRows(sheet, at, count, to);
  const delta = at - from;
  source.forEach((line, offset) => {
    const row = sheet.getRow(at + offset);
    row.hidden = line.hidden;
    if (line.height) row.height = line.height;
    // Merges copied from the `like` row by insertRows are taken apart before the block's own.
    for (const range of mergeRanges(sheet)) {
      if (range.top === at + offset && range.bottom === at + offset) {
        sheet.unMergeCells(...rangeAddress(range));
      }
    }
    line.cells.forEach((cell, index) => {
      const target = row.getCell(index + 1);
      target.style = cell.style;
      const value = cell.value;
      target.value =
        value &&
        typeof value === 'object' &&
        'formula' in value &&
        typeof value.formula === 'string'
          ? { formula: shiftFormula(value.formula, from, to, delta) }
          : value;
    });
  });
  for (const range of inside) {
    sheet.mergeCells(range.top + delta, range.left, range.bottom + delta, range.right);
  }
}

/**
 * Adds a column after `like` that looks like it (styles and width) and extends every merge that
 * ends at `like` (titles across the table) to it, and the print area too. Used for the schedule's
 * "Proposed Sum Insured - Option 3" column when the template has none.
 */
export function addColumnAfter(sheet: ExcelJS.Worksheet, like: number): number {
  const column = like + 1;
  const rows = Math.max(sheet.rowCount, 1);
  for (const range of mergeRanges(sheet)) {
    if (range.right === like && range.left < like) {
      sheet.unMergeCells(...rangeAddress(range));
      sheet.mergeCells(range.top, range.left, range.bottom, column);
    }
  }
  for (let row = 1; row <= rows; row += 1) {
    const cell = sheet.getCell(row, column);
    if (isCovered(cell)) continue;
    if (!cell.isMerged) cell.value = null;
    cell.style = JSON.parse(
      JSON.stringify(sheet.getCell(row, like).style),
    ) as Partial<ExcelJS.Style>;
  }
  const width = sheet.getColumn(like).width;
  if (width) sheet.getColumn(column).width = width;
  const area = sheet.pageSetup.printArea;
  if (area) {
    const printed = printColumns(sheet);
    if (printed.to === like) {
      sheet.pageSetup.printArea = area
        .split(',')
        .map((part, index) =>
          index === 0
            ? part.replace(
                /:(\$?)([A-Z]+)(\$?\d+)$/,
                (_, dollar: string, _letter, rest: string) =>
                  `:${dollar}${sheet.getColumn(column).letter}${rest}`,
              )
            : part,
        )
        .join(',');
    }
  }
  return column;
}

/** Makes the print area reach row `to` at least (a template's area can stop above its blocks). */
export function extendPrintRows(sheet: ExcelJS.Worksheet, to: number): void {
  const area = sheet.pageSetup.printArea;
  if (!area || printRows(sheet).to >= to) return;
  sheet.pageSetup.printArea = area
    .split(',')
    .map((part, index) =>
      index === 0
        ? part.replace(/(\$?[A-Z]+\$?)(\d+)$/, (_, column: string) => `${column}${to}`)
        : part,
    )
    .join(',');
}

/**
 * Lines at the foot of a sheet, after a blank row, across its printed columns and inside its
 * print area: the QCR's "Prepared by" on its last page (client review, 27 Oct 2026).
 */
export function appendSignOff(sheet: ExcelJS.Worksheet, lines: readonly string[]): void {
  if (lines.length === 0) return;
  const at = printRows(sheet).to + 1;
  const columns = printColumns(sheet);
  insertRows(sheet, at, lines.length + 1, Math.max(at - 1, 1));
  for (let row = at; row <= at + lines.length; row += 1) {
    for (let column = columns.from; column <= columns.to; column += 1) {
      const cell = sheet.getCell(row, column);
      if (cell.isMerged) sheet.unMergeCells(row, columns.from, row, columns.to);
      cell.value = null;
      cell.style = {};
    }
    sheet.getRow(row).hidden = false;
  }
  lines.forEach((line, offset) => {
    const row = at + 1 + offset;
    if (columns.to > columns.from) sheet.mergeCells(row, columns.from, row, columns.to);
    const cell = sheet.getCell(row, columns.from);
    cell.value = line;
    cell.style = {
      font: { bold: true, size: 11 },
      alignment: { horizontal: 'left', vertical: 'middle' },
    };
  });
  extendPrintRows(sheet, at + lines.length);
}

/**
 * Every written cell of the workbook in bold, as the client reads the RFQ and QCR (review of
 * 28 Oct 2026: "visually bold, easy to understand"). Excel and the PDF drawn from it alike.
 */
export function emboldenWorkbook(workbook: ExcelJS.Workbook): void {
  for (const sheet of workbook.worksheets) {
    sheet.eachRow((row) => {
      row.eachCell((cell) => {
        if (isCovered(cell) || cellText(cell) === '') return;
        if (!cell.font?.bold) restyle(cell, { font: { ...cell.font, bold: true } });
      });
    });
  }
}

const THIN: Partial<ExcelJS.Borders> = {
  top: { style: 'thin' },
  left: { style: 'thin' },
  bottom: { style: 'thin' },
  right: { style: 'thin' },
};

/**
 * Boxes a built-in sheet as the client's formats are: every row with something in it is ruled
 * across the table's columns; blank rows stay open, so each block reads as its own box.
 */
export function frameSheet(sheet: ExcelJS.Worksheet, columns: number): void {
  sheet.eachRow((row) => {
    let used = false;
    for (let column = 1; column <= columns; column += 1) {
      if (cellText(row.getCell(column)) !== '') used = true;
    }
    if (!used) return;
    // A line of text written in the first cell only (an address, a caption) runs across the
    // table: a boxed cell cannot spill into its neighbours, so it is merged instead of wrapping
    // in a narrow first column.
    const first = row.getCell(1);
    const alone = Array.from({ length: columns - 1 }, (_, index) => row.getCell(index + 2)).every(
      (cell) => cellText(cell) === '' && !cell.isMerged,
    );
    if (columns > 1 && !first.isMerged && cellText(first) !== '' && alone) {
      sheet.mergeCells(row.number, 1, row.number, columns);
      restyle(first, {
        alignment: { ...first.alignment, horizontal: 'left', vertical: 'top', wrapText: true },
      });
    }
    for (let column = 1; column <= columns; column += 1) {
      const cell = row.getCell(column);
      cell.border = { ...THIN, ...cell.border };
    }
  });
}
