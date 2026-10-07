import { formatDate, formatIndianNumber } from '../../shared/index.ts';
import type ExcelJS from 'exceljs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import pdfmake from 'pdfmake';
import type { Content, TableCell } from 'pdfmake';
import { cellText, printColumns, printRows } from './excel-template.ts';

// The document engine's PDF (R-4): each chosen sheet of a filled workbook drawn as a table, within
// its print area, keeping merged cells, bold text, fills, borders and alignment, on A4 with the
// broker's letterhead (the logo and address in the client's template) on every page. The PDF
// therefore always shows what the Excel shows.

type TDocumentDefinitions = Parameters<typeof pdfmake.createPdf>[0];

const fontDir = join(
  dirname(createRequire(import.meta.url).resolve('pdfmake/package.json')),
  'fonts',
  'Roboto',
);
pdfmake.setFonts({
  Roboto: {
    normal: join(fontDir, 'Roboto-Regular.ttf'),
    bold: join(fontDir, 'Roboto-Medium.ttf'),
    italics: join(fontDir, 'Roboto-Italic.ttf'),
    bolditalics: join(fontDir, 'Roboto-MediumItalic.ttf'),
  },
});
// Nothing is fetched: only the bundled fonts are read, and images come as data.
pdfmake.setUrlAccessPolicy(() => false);
pdfmake.setLocalAccessPolicy((path) => path.startsWith(fontDir));

/** A4 portrait in points, and the margins used. */
const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = { left: 36, right: 36, top: 92, bottom: 44 };
const CONTENT_WIDTH = PAGE.width - MARGIN.left - MARGIN.right;
/** Points per Excel character width (Calibri 11). */
const POINTS_PER_CHARACTER = 5.6;
const DEFAULT_COLUMN_WIDTH = 8.43;

export interface Letterhead {
  logo: { data: Buffer; extension: string } | null;
  address: string | null;
}

/**
 * The broker's letterhead from a template: its first picture (the logo at the top of the client's
 * sheets) and the cell with the broker's name and address (the footer of the schedule).
 */
export function letterheadOf(workbook: ExcelJS.Workbook): Letterhead {
  let logo: Letterhead['logo'] = null;
  for (const sheet of workbook.worksheets) {
    const image = sheet.getImages()[0];
    if (!image) continue;
    const media = workbook.getImage(Number(image.imageId));
    if (media.buffer) {
      logo = { data: Buffer.from(media.buffer), extension: media.extension };
      break;
    }
  }
  let address: string | null = null;
  for (const sheet of workbook.worksheets) {
    sheet.eachRow((row) => {
      row.eachCell((cell) => {
        const text = cellText(cell);
        if (!address && /insurance brokers/i.test(text) && /\d/.test(text)) address = text;
      });
    });
    if (address) break;
  }
  return { logo, address };
}

function argbColour(argb: string | undefined, skip = 'FFFFFF'): string | undefined {
  if (!argb || argb.length < 6) return undefined;
  const hex = argb.slice(-6);
  return /^[0-9a-f]{6}$/i.test(hex) && hex.toUpperCase() !== skip ? `#${hex}` : undefined;
}

/** A cell as it reads on paper: numbers grouped the Indian way when the format groups them. */
function displayText(cell: ExcelJS.Cell): string {
  const value = cell.value;
  const numberOf = (result: unknown) => (typeof result === 'number' ? result : null);
  const number =
    typeof value === 'number'
      ? value
      : value && typeof value === 'object' && 'result' in value
        ? numberOf(value.result)
        : null;
  if (number !== null) {
    const format = cell.numFmt ?? '';
    if (/#,##0|##0/.test(format)) return formatIndianNumber(number.toFixed(2), 0);
    if (/0\.00/.test(format)) return formatIndianNumber(number.toFixed(2), 2);
    return Number.isInteger(number) ? String(number) : String(Number(number.toFixed(2)));
  }
  if (value instanceof Date) return formatDate(value.toISOString().slice(0, 10));
  return cellText(cell);
}

interface Span {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

function merges(sheet: ExcelJS.Worksheet): Span[] {
  return ((sheet.model as { merges?: string[] }).merges ?? []).map((address) => {
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

/** One sheet's print area as a pdfmake table. */
function sheetTable(sheet: ExcelJS.Worksheet): Content {
  const rows = printRows(sheet);
  const columns = printColumns(sheet);
  const visible: number[] = [];
  for (let row = rows.from; row <= rows.to; row += 1) {
    if (!sheet.getRow(row).hidden) visible.push(row);
  }
  const columnNumbers = Array.from(
    { length: columns.to - columns.from + 1 },
    (_, i) => columns.from + i,
  );
  const characterWidths = columnNumbers.map(
    (column) => sheet.getColumn(column).width ?? DEFAULT_COLUMN_WIDTH,
  );
  const naturalWidth = characterWidths.reduce(
    (total, width) => total + width * POINTS_PER_CHARACTER,
    0,
  );
  const scale = Math.min(1, CONTENT_WIDTH / naturalWidth);
  const widths = characterWidths.map((width) => width * POINTS_PER_CHARACTER * scale - 4);
  const fontSize = Math.max(6.5, Math.min(9, 11 * scale));

  const spans = merges(sheet);
  const masterOf = new Map<string, Span>();
  const covered = new Set<string>();
  for (const span of spans) {
    masterOf.set(`${span.top}:${span.left}`, span);
    for (let row = span.top; row <= span.bottom; row += 1) {
      for (let column = span.left; column <= span.right; column += 1) {
        if (row !== span.top || column !== span.left) covered.add(`${row}:${column}`);
      }
    }
  }
  // Text that Excel lets run into empty cells to its right (not wrapped, not merged) does so here.
  const overflow = new Map<string, number>();
  for (const row of visible) {
    for (const column of columnNumbers) {
      const key = `${row}:${column}`;
      if (covered.has(key) || masterOf.has(key)) continue;
      const cell = sheet.getCell(row, column);
      const bordered = (target: ExcelJS.Cell) =>
        Boolean(
          target.border?.left?.style ??
          target.border?.right?.style ??
          target.border?.top?.style ??
          target.border?.bottom?.style,
        );
      // Only free-standing text runs over (titles, notes); text in a bordered table stays put.
      if (
        !cellText(cell) ||
        cell.alignment?.wrapText ||
        typeof cell.value === 'number' ||
        bordered(cell)
      ) {
        continue;
      }
      let span = 1;
      for (let next = column + 1; next <= columns.to; next += 1) {
        const other = sheet.getCell(row, next);
        if (
          cellText(other) ||
          bordered(other) ||
          covered.has(`${row}:${next}`) ||
          masterOf.has(`${row}:${next}`)
        ) {
          break;
        }
        span += 1;
      }
      if (span > 1) {
        overflow.set(key, span);
        for (let next = column + 1; next < column + span; next += 1) covered.add(`${row}:${next}`);
      }
    }
  }

  const body: TableCell[][] = visible.map((row) =>
    columnNumbers.map((column): TableCell => {
      if (covered.has(`${row}:${column}`)) return {};
      const cell = sheet.getCell(row, column);
      const span = masterOf.get(`${row}:${column}`);
      const last = span
        ? sheet.getCell(Math.min(span.bottom, rows.to), Math.min(span.right, columns.to))
        : cell;
      const border = cell.border ?? {};
      const lastBorder = last.border ?? {};
      const fill = cell.fill?.type === 'pattern' ? argbColour(cell.fill.fgColor?.argb) : undefined;
      const horizontal = cell.alignment?.horizontal;
      const text = displayText(cell);
      const isNumber =
        typeof cell.value === 'number' ||
        (typeof cell.value === 'object' && cell.value !== null && 'formula' in cell.value);
      const result: TableCell & Record<string, unknown> = {
        text,
        fontSize: cell.font?.size ? Math.max(6.5, Math.min(10, cell.font.size * scale)) : fontSize,
        bold: Boolean(cell.font?.bold),
        italics: Boolean(cell.font?.italic),
        alignment:
          horizontal === 'center' || horizontal === 'centerContinuous'
            ? 'center'
            : horizontal === 'right' || (isNumber && horizontal !== 'left')
              ? 'right'
              : 'left',
        border: [
          Boolean(border.left?.style),
          Boolean(border.top?.style),
          Boolean(lastBorder.right?.style),
          Boolean(lastBorder.bottom?.style),
        ],
      };
      if (fill) result.fillColor = fill;
      // Theme colours 0 and 1 are the sheet's light and dark (white and black in Office themes).
      const theme = cell.font?.color?.theme;
      const colour = theme === 0 ? '#FFFFFF' : argbColour(cell.font?.color?.argb, '000000');
      if (colour) result.color = colour;
      const runs = overflow.get(`${row}:${column}`);
      if (runs) {
        result.colSpan = runs;
        result.border = [
          Boolean(border.left?.style),
          Boolean(border.top?.style),
          false,
          Boolean(border.bottom?.style),
        ];
      }
      if (span) {
        const right = Math.min(span.right, columns.to);
        if (right > column) result.colSpan = right - column + 1;
        const lastVisible = visible.filter((r) => r >= span.top && r <= span.bottom).length;
        if (lastVisible > 1) result.rowSpan = lastVisible;
      }
      return result;
    }),
  );

  return {
    table: { widths, body, dontBreakRows: true },
    layout: {
      hLineWidth: () => 0.5,
      vLineWidth: () => 0.5,
      hLineColor: () => '#6b7280',
      vLineColor: () => '#6b7280',
      paddingLeft: () => 2,
      paddingRight: () => 2,
      paddingTop: () => 1.5,
      paddingBottom: () => 1.5,
    },
  };
}

export interface PdfOptions {
  /** Sheets to print, in order; the workbook's order when not given. */
  sheets?: readonly ExcelJS.Worksheet[];
  letterhead: Letterhead;
  /** Document title (PDF metadata) and the footer's left text. */
  title: string;
  footer: string;
}

/** The workbook's sheets as an A4 PDF with the letterhead on every page. */
export async function workbookToPdf(
  workbook: ExcelJS.Workbook,
  options: PdfOptions,
): Promise<Buffer> {
  const sheets = options.sheets ?? workbook.worksheets.filter((sheet) => sheet.state !== 'hidden');
  const { logo, address } = options.letterhead;
  const logoImage = logo
    ? `data:image/${logo.extension === 'png' ? 'png' : 'jpeg'};base64,${logo.data.toString('base64')}`
    : null;

  const content: Content[] = sheets.flatMap((sheet, index): Content[] => [
    {
      text: sheet.name,
      fontSize: 7,
      color: '#6b7280',
      margin: [0, 0, 0, 3],
      ...(index > 0 ? { pageBreak: 'before' as const } : {}),
    },
    sheetTable(sheet),
  ]);

  const definition: TDocumentDefinitions = {
    pageSize: 'A4',
    pageOrientation: 'portrait',
    pageMargins: [MARGIN.left, MARGIN.top, MARGIN.right, MARGIN.bottom],
    info: { title: options.title, creator: 'Fiducial', producer: 'Fiducial' },
    defaultStyle: { font: 'Roboto', fontSize: 8, lineHeight: 1.1 },
    header: () => ({
      margin: [MARGIN.left, 22, MARGIN.right, 0],
      stack: [
        {
          columns: [
            logoImage ? { image: logoImage, fit: [130, 42], width: 140 } : { text: '', width: 140 },
            {
              text: (address ?? '').replace(/\s*\|\s*/g, ' · ').replace(/\s*\n\s*/g, '\n'),
              alignment: 'right',
              fontSize: 7,
              color: '#374151',
              width: '*',
            },
          ],
        },
        {
          canvas: [
            {
              type: 'line',
              x1: 0,
              y1: 6,
              x2: CONTENT_WIDTH,
              y2: 6,
              lineWidth: 0.75,
              lineColor: '#1f3a5f',
            },
          ],
        },
      ],
    }),
    footer: (page: number, pages: number) => ({
      margin: [MARGIN.left, 14, MARGIN.right, 0],
      columns: [
        { text: options.footer, fontSize: 7, color: '#6b7280' },
        { text: `Page ${page} of ${pages}`, fontSize: 7, color: '#6b7280', alignment: 'right' },
      ],
    }),
    content,
  };
  return Buffer.from(await pdfmake.createPdf(definition).getBuffer());
}
