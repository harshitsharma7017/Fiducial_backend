import { formatIndianNumber, type GhiDocumentPreview } from '../../shared/index.ts';
import ExcelJS from 'exceljs';
import {
  NOTE_FILL_ARGB,
  SECTION_HEADING_FILL_ARGB,
  TABLE_HEADER_FILL_ARGB,
} from '../documents/document-theme.ts';
import {
  RUPEES_FORMAT,
  emboldenWorkbook,
  frameSheet,
  saveWorkbook,
} from '../documents/excel-template.ts';
import { workbookToPdf, type Letterhead } from '../documents/sheet-pdf.ts';

// The GHI documents (RFQ, QCR, placement slip) are described once as sheets of rows, then
// written to Excel, drawn as an A4 PDF by the document engine, and shown on screen as a preview,
// so all three always say the same thing. They are drawn in the design of the Property and Fire
// documents (client review, 30 Oct 2026): a navy title and column headings in white, light-blue
// sub-headings, every line bold and boxed, and numbers and ticks centred.

/** An amount kept exact until it is written: whole rupees, or rupees with paise. */
export interface MoneyCell {
  money: string;
  paise: boolean;
}
export type SheetCell = string | number | null | MoneyCell;
export type RowStyle = 'title' | 'section' | 'header' | 'label' | 'total' | 'highlight' | 'note';

export interface SheetRow {
  cells: SheetCell[];
  style?: RowStyle;
}

export interface SheetModel {
  name: string;
  widths: number[];
  rows: SheetRow[];
}

export interface DocumentModel {
  title: string;
  fileBase: string;
  sheets: SheetModel[];
}

export const money = (value: string | null, paise = false): SheetCell =>
  value === null ? null : { money: value, paise };

const PAISE_FORMAT = RUPEES_FORMAT.replace(/##0(?=;|$)/g, '##0.00');
const WHITE = { argb: 'FFFFFFFF' };
const NAVY = { argb: SECTION_HEADING_FILL_ARGB };
/** The lowest quote, green as on the Property QCR. */
const LOWEST_FILL_ARGB = 'FF92D050';
const FILLS: Partial<Record<RowStyle, string>> = {
  title: SECTION_HEADING_FILL_ARGB,
  header: SECTION_HEADING_FILL_ARGB,
  section: TABLE_HEADER_FILL_ARGB,
  highlight: LOWEST_FILL_ARGB,
  note: NOTE_FILL_ARGB,
};
const CENTRED: Partial<ExcelJS.Alignment> = {
  horizontal: 'center',
  vertical: 'middle',
  wrapText: true,
};

function isMoney(cell: SheetCell): cell is MoneyCell {
  return typeof cell === 'object' && cell !== null;
}

export function cellDisplay(cell: SheetCell): string {
  if (cell === null) return '';
  if (isMoney(cell)) return `₹${formatIndianNumber(cell.money, cell.paise ? 2 : 0)}`;
  return typeof cell === 'number' ? String(cell) : cell;
}

/** Writes the sheets into a new workbook. */
export function toWorkbook(model: DocumentModel): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Fiducial';
  workbook.title = model.title;
  for (const sheetModel of model.sheets) {
    const sheet = workbook.addWorksheet(sheetModel.name, {
      pageSetup: {
        paperSize: 9,
        orientation: 'portrait',
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
      },
    });
    sheet.columns = sheetModel.widths.map((width) => ({ width }));
    const span = sheetModel.widths.length;
    for (const rowModel of sheetModel.rows) {
      const row = sheet.addRow(
        rowModel.cells.map((cell) => (isMoney(cell) ? Number(cell.money) : cell)),
      );
      // A table row (three cells or more) is centred except its first, text column; a label and
      // its value keep the value on the left, but amounts and numbers are always centred.
      const table = rowModel.cells.length > 2;
      rowModel.cells.forEach((cell, index) => {
        const target = row.getCell(index + 1);
        if (isMoney(cell)) target.numFmt = cell.paise ? PAISE_FORMAT : RUPEES_FORMAT;
        const figure = isMoney(cell) || typeof cell === 'number';
        const centred = figure || (table && (index > 0 || rowModel.style === 'header'));
        target.alignment = centred
          ? CENTRED
          : { horizontal: 'left', vertical: 'middle', wrapText: true };
      });
      const fill = rowModel.style ? FILLS[rowModel.style] : undefined;
      if (fill) {
        rowModel.cells.forEach((_cell, index) => {
          row.getCell(index + 1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: fill },
          };
        });
      }
      if (rowModel.style === 'title') {
        row.font = { bold: true, size: 12, color: WHITE };
        row.getCell(1).alignment = CENTRED;
        row.height = 22;
        if (span > 1) sheet.mergeCells(row.number, 1, row.number, span);
      } else if (rowModel.style === 'section') {
        row.font = { bold: true, color: NAVY };
        row.getCell(1).alignment = CENTRED;
        row.height = 18;
        if (rowModel.cells.length === 1 && span > 1)
          sheet.mergeCells(row.number, 1, row.number, span);
      } else if (rowModel.style === 'note') {
        // Highlighted, as the notes of the Property QCR.
        row.font = { bold: true };
        if (rowModel.cells.length === 1 && span > 1)
          sheet.mergeCells(row.number, 1, row.number, span);
        row.getCell(1).alignment = { horizontal: 'left', vertical: 'top', wrapText: true };
      } else if (rowModel.style === 'header') {
        row.font = { bold: true, color: WHITE };
      } else if (rowModel.style === 'highlight') {
        row.font = { bold: true, color: NAVY };
      } else if (rowModel.style === 'total') {
        row.font = { bold: true };
      } else if (rowModel.style === 'label') {
        row.getCell(1).font = { bold: true };
        // A label with one value runs the value across the rest of the sheet.
        if (rowModel.cells.length === 2 && span > 2)
          sheet.mergeCells(row.number, 2, row.number, span);
      }
    }
    // Every line boxed, then every written cell bold, as the Property and Fire documents.
    frameSheet(sheet, span);
    sheet.pageSetup.printArea = `A1:${sheet.getColumn(span).letter}${Math.max(1, sheet.rowCount)}`;
  }
  emboldenWorkbook(workbook);
  return workbook;
}

export async function toXlsx(model: DocumentModel): Promise<Buffer> {
  return saveWorkbook(toWorkbook(model));
}

export async function toPdf(model: DocumentModel, letterhead: Letterhead): Promise<Buffer> {
  return workbookToPdf(toWorkbook(model), {
    letterhead,
    title: model.title,
    footer: model.title,
  });
}

/** The document as text rows for the screen, at most `limit` rows per sheet. */
export function toPreview(model: DocumentModel, limit = 120): GhiDocumentPreview {
  return {
    title: model.title,
    sheets: model.sheets.map((sheet) => ({
      name: sheet.name,
      rows: sheet.rows.slice(0, limit).map((row) => row.cells.map(cellDisplay)),
      truncated: Math.max(0, sheet.rows.length - limit),
    })),
  };
}
