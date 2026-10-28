import { formatDate, formatIndianNumber } from '../../shared/index.ts';
import type ExcelJS from 'exceljs';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import pdfmake from 'pdfmake';
import type { Content, TableCell } from 'pdfmake';
import {
  BROKER,
  CONTENT_WIDTH,
  COVER_TICK,
  COVER_TICK_ARGB,
  DOCUMENT_COLORS,
  DOCUMENT_FONT,
  DOCUMENT_FONT_FAMILY,
  DOCUMENT_LINE_HEIGHT,
  MARGIN,
  PAGE,
  WATERMARK,
} from './document-theme.ts';
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
  [DOCUMENT_FONT_FAMILY]: {
    normal: join(fontDir, 'Roboto-Regular.ttf'),
    bold: join(fontDir, 'Roboto-Medium.ttf'),
    italics: join(fontDir, 'Roboto-Italic.ttf'),
    bolditalics: join(fontDir, 'Roboto-MediumItalic.ttf'),
  },
});
// Nothing is fetched: only the bundled fonts are read, and images come as data.
pdfmake.setUrlAccessPolicy(() => false);
pdfmake.setLocalAccessPolicy((path) => path.startsWith(fontDir));

// Page geometry, margins, the palette and fonts come from the shared document theme (Q2) so the
// Coverage Confirmation Letter and every Excel-drawn document read the same.
/** Points per Excel character width (Calibri 11). */
const POINTS_PER_CHARACTER = 5.6;
const DEFAULT_COLUMN_WIDTH = 8.43;
/** Points per Excel indent level (sub-items of the schedules are indented). */
const POINTS_PER_INDENT = 9;
/** Words a heading keeps in lower case unless they come first. */
const MINOR_WORDS = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'by',
  'for',
  'in',
  'of',
  'on',
  'or',
  'the',
  'to',
]);

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

/**
 * A template fill in the document design (Invoice-2): the light greys and blues the templates use
 * for header rows become the light blue, dark fills become the navy, anything else is kept. A
 * light but coloured fill (the yellow of a highlighted note) is a highlight and stays as it is.
 */
function designFill(hex: string | undefined): string | undefined {
  if (!hex) return undefined;
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const brightest = Math.max(r, g, b);
  const saturation = brightest === 0 ? 0 : (brightest - Math.min(r, g, b)) / brightest;
  if (luminance > 0.82 && saturation < 0.15) return DOCUMENT_COLORS.tableHeader;
  if (luminance < 0.3) return DOCUMENT_COLORS.rule;
  return hex;
}

/** Narrowest a column with figures is drawn, in points, so an amount in crores fits on one line. */
const MIN_COLUMN_POINTS = 62;

/**
 * Column widths in points that fit the page: the sheet's widths scaled down, but no column
 * narrower than MIN_COLUMN_POINTS (or its own width, if less); the room that takes comes from the
 * wider columns (descriptions), which wrap.
 */
function fitWidths(natural: readonly number[]): number[] {
  const total = natural.reduce((sum, width) => sum + width, 0);
  const scale = Math.min(1, CONTENT_WIDTH / total);
  const floor = natural.map((width) => Math.min(width, MIN_COLUMN_POINTS));
  const widths = natural.map((width, index) => Math.max(width * scale, floor[index] ?? 0));
  const excess = widths.reduce((sum, width) => sum + width, 0) - CONTENT_WIDTH;
  if (excess <= 0) return widths;
  // Taken from each column in proportion to what it has above its floor.
  const spare = widths.map((width, index) => width - (floor[index] ?? 0));
  const room = spare.reduce((sum, value) => sum + value, 0);
  return widths.map((width, index) =>
    room > 0 ? width - (excess * (spare[index] ?? 0)) / room : (width * CONTENT_WIDTH) / total,
  );
}

/** The add-on tick, drawn (the bundled font has no ✓ glyph). */
const TICK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M2.5 8.5l3.5 3.5 7.5-8" fill="none" stroke="#${COVER_TICK_ARGB.slice(-6)}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

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
  // Hidden columns are left out, as hidden rows are.
  const columnNumbers = Array.from(
    { length: columns.to - columns.from + 1 },
    (_, i) => columns.from + i,
  ).filter((column) => !sheet.getColumn(column).hidden);
  const characterWidths = columnNumbers.map(
    (column) => sheet.getColumn(column).width ?? DEFAULT_COLUMN_WIDTH,
  );
  const naturalWidth = characterWidths.reduce(
    (total, width) => total + width * POINTS_PER_CHARACTER,
    0,
  );
  const scale = Math.min(1, CONTENT_WIDTH / naturalWidth);
  const widths = fitWidths(characterWidths.map((width) => width * POINTS_PER_CHARACTER)).map(
    (width) => width - 4,
  );
  // One size for every sheet and cell, so the document reads the same throughout; a template
  // title set larger than the body (11 pt) is a little larger.
  const fontSize = DOCUMENT_FONT.table;

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
      for (const next of columnNumbers.slice(columnNumbers.indexOf(column) + 1)) {
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
        const index = columnNumbers.indexOf(column);
        for (const next of columnNumbers.slice(index + 1, index + span))
          covered.add(`${row}:${next}`);
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
      const fill =
        cell.fill?.type === 'pattern' ? designFill(argbColour(cell.fill.fgColor?.argb)) : undefined;
      const horizontal = cell.alignment?.horizontal;
      const text = displayText(cell);
      const isNumber =
        typeof cell.value === 'number' ||
        (typeof cell.value === 'object' && cell.value !== null && 'formula' in cell.value);
      const result: TableCell & Record<string, unknown> = {
        text,
        fontSize: (cell.font?.size ?? 11) > 11 ? DOCUMENT_FONT.tableTitle : fontSize,
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
      const indent = cell.alignment?.indent ?? 0;
      if (indent > 0 && result.alignment === 'left') {
        result.margin = [indent * POINTS_PER_INDENT * scale, 0, 0, 0];
      }
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
        const spanned = columnNumbers.filter((other) => other >= column && other <= right).length;
        if (spanned > 1) result.colSpan = spanned;
        const lastVisible = visible.filter((r) => r >= span.top && r <= span.bottom).length;
        if (lastVisible > 1) result.rowSpan = lastVisible;
      }
      if (text.trim() === COVER_TICK) {
        // The tick is drawn, centred, in place of the character.
        const { text: _tick, ...rest } = result;
        return { ...rest, svg: TICK_SVG, width: 8, height: 8, alignment: 'center' };
      }
      return result;
    }),
  );

  return {
    table: { widths, body, dontBreakRows: true },
    layout: {
      // Every cell carries its own borders from the sheet; the cells hidden under a merged range
      // must draw none (pdfmake would otherwise rule a line under part of an unbordered title).
      defaultBorder: false,
      hLineWidth: () => 0.5,
      vLineWidth: () => 0.5,
      hLineColor: () => DOCUMENT_COLORS.gridline,
      vLineColor: () => DOCUMENT_COLORS.gridline,
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
  const logoImage = logoDataUrl(options.letterhead.logo);

  const content: Content[] = sheets.flatMap((sheet, index): Content[] => [
    {
      ...sheetHeading(sheet.name),
      ...(index > 0 ? { pageBreak: 'before' as const } : {}),
    },
    sheetTable(sheet),
  ]);

  const definition: TDocumentDefinitions = {
    pageSize: 'A4',
    pageOrientation: 'portrait',
    pageMargins: [MARGIN.left, MARGIN.top, MARGIN.right, MARGIN.bottom],
    info: { title: options.title, creator: 'Fiducial', producer: 'Fiducial' },
    defaultStyle: {
      font: DOCUMENT_FONT_FAMILY,
      fontSize: DOCUMENT_FONT.body,
      lineHeight: DOCUMENT_LINE_HEIGHT,
      color: DOCUMENT_COLORS.ink,
    },
    watermark: { ...WATERMARK },
    header: () => documentHeader(logoImage),
    footer: (page: number, pages: number) => documentFooter(options.footer, page, pages),
    background: () => documentBackground(),
    content,
  };
  return Buffer.from(await pdfmake.createPdf(definition).getBuffer());
}

/**
 * A sheet's name as the heading of its part of the PDF: in title case ("premium details" reads
 * "Premium Details"), white on a navy band so each part of the document stands out.
 */
export function sheetHeading(name: string) {
  const text = name
    .trim()
    .split(/\s+/)
    .map((word, index) =>
      index > 0 && MINOR_WORDS.has(word.toLowerCase())
        ? word.toLowerCase()
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(' ');
  return {
    table: {
      widths: ['*'],
      body: [[{ text, bold: true, fontSize: DOCUMENT_FONT.heading, color: '#FFFFFF' }]],
    },
    layout: {
      hLineWidth: () => 0,
      vLineWidth: () => 0,
      fillColor: () => DOCUMENT_COLORS.rule,
      paddingLeft: () => 6,
      paddingRight: () => 6,
      paddingTop: () => 3,
      paddingBottom: () => 3,
    },
    margin: [0, 0, 0, 6] as [number, number, number, number],
  } satisfies Content;
}

/**
 * The Fiducial letterhead's logo, bundled with the app as data/letterhead/logo.png (or .jpg).
 * Without it, the logo of the client's uploaded template is used.
 */
const BRAND_LOGO = ((): string | null => {
  for (const extension of ['png', 'jpg']) {
    try {
      const data = readFileSync(
        new URL(`../../../data/letterhead/logo.${extension}`, import.meta.url),
      );
      return logoDataUrl({ data, extension });
    } catch {
      // Not bundled in this format.
    }
  }
  return null;
})();

/**
 * The letterhead at the top of every page of every generated PDF (Q2), as the Fiducial letterhead
 * lays it out: the logo on the left, the broker's name and address in bold on the right, and a
 * navy rule across the full width of the page. Exported so the Coverage Confirmation Letter (Q4),
 * which pdfmake draws directly, shows the same header.
 */
export function documentHeader(logoImage: string | null): Content {
  const logo = BRAND_LOGO ?? logoImage;
  return {
    margin: [MARGIN.left, 20, MARGIN.right, 0],
    stack: [
      {
        columnGap: 30,
        columns: [
          logo
            ? { image: logo, fit: [200, 66], width: 230 }
            : {
                text: 'Fiducial',
                bold: true,
                fontSize: 26,
                color: DOCUMENT_COLORS.rule,
                width: 230,
              },
          {
            width: '*',
            stack: [BROKER.name, ...BROKER.address],
            bold: true,
            fontSize: DOCUMENT_FONT.letterheadAddress,
            color: DOCUMENT_COLORS.letterhead,
            lineHeight: 1.2,
            margin: [0, 6, 0, 0],
          },
        ],
      },
      {
        canvas: [
          {
            type: 'line',
            x1: -MARGIN.left,
            y1: 10,
            x2: PAGE.width - MARGIN.left,
            y2: 10,
            lineWidth: 2.5,
            lineColor: DOCUMENT_COLORS.rule,
          },
        ],
      },
    ],
  };
}

/**
 * The foot of every page (Q2): the document's reference and "Page X of Y", then the letterhead's
 * contact line (telephone, e-mail and website) in navy.
 */
export function documentFooter(text: string, page: number, pages: number): Content {
  const separator = { text: '  |  ', fontSize: DOCUMENT_FONT.contact + 3 };
  return {
    margin: [MARGIN.left, 10, MARGIN.right, 0],
    stack: [
      {
        columns: [
          { text, fontSize: DOCUMENT_FONT.footer, color: DOCUMENT_COLORS.muted },
          {
            text: `Page ${page} of ${pages}`,
            fontSize: DOCUMENT_FONT.footer,
            color: DOCUMENT_COLORS.muted,
            alignment: 'right',
          },
        ],
      },
      {
        text: [
          `Tel : ${BROKER.telephone}`,
          separator,
          `E-mail : ${BROKER.email}`,
          separator,
          BROKER.website,
        ],
        alignment: 'center',
        bold: true,
        fontSize: DOCUMENT_FONT.contact,
        color: DOCUMENT_COLORS.contact,
        margin: [0, 8, 0, 0],
      },
    ],
  };
}

/** The letterhead's corner accent: a green and a navy triangle at the bottom right of each page. */
export function documentBackground(): Content {
  const { width, height } = PAGE;
  const triangle = (run: number, rise: number, color: string) => ({
    type: 'polyline' as const,
    closePath: true,
    color,
    lineColor: color,
    lineWidth: 0.1,
    points: [
      { x: width - run, y: height },
      { x: width, y: height - rise },
      { x: width, y: height },
    ],
  });
  return {
    canvas: [triangle(63, 88, DOCUMENT_COLORS.accentGreen), triangle(40, 57, DOCUMENT_COLORS.rule)],
  };
}

/** A letterhead logo as a pdfmake data URL, or null. Shared by the directly-drawn documents (Q4). */
export function logoDataUrl(logo: Letterhead['logo']): string | null {
  return logo
    ? `data:image/${logo.extension === 'png' ? 'png' : 'jpeg'};base64,${logo.data.toString('base64')}`
    : null;
}
