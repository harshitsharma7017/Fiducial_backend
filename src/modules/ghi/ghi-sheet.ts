import { formatIndianNumber, type GhiDocumentPreview } from '../../shared/index.ts';
import ExcelJS from 'exceljs';
import { RUPEES_FORMAT, saveWorkbook } from '../documents/excel-template.ts';
import { workbookToPdf, type Letterhead } from '../documents/sheet-pdf.ts';

// The GHI documents (RFQ, QCR, placement slip) are described once as sheets of rows, then
// written to Excel, drawn as an A4 PDF by the document engine, and shown on screen as a preview,
// so all three always say the same thing.

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
const FILLS: Partial<Record<RowStyle, string>> = {
  header: 'FFE8EEF6',
  section: 'FFF3F4F6',
  total: 'FFF3F4F6',
  highlight: 'FFD9F2D0',
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
      rowModel.cells.forEach((cell, index) => {
        const target = row.getCell(index + 1);
        if (isMoney(cell)) {
          target.numFmt = cell.paise ? PAISE_FORMAT : RUPEES_FORMAT;
          target.alignment = { horizontal: 'right', vertical: 'top' };
        } else {
          target.alignment = { wrapText: true, vertical: 'top' };
        }
        if (rowModel.style !== 'title' && rowModel.style !== 'note' && rowModel.cells.length > 1) {
          target.border = {
            top: { style: 'thin' },
            left: { style: 'thin' },
            bottom: { style: 'thin' },
            right: { style: 'thin' },
          };
        }
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
        row.font = { bold: true, size: 13 };
        if (span > 1) sheet.mergeCells(row.number, 1, row.number, span);
      } else if (rowModel.style === 'section' || rowModel.style === 'note') {
        row.font = { bold: rowModel.style === 'section', italic: rowModel.style === 'note' };
        if (rowModel.cells.length === 1 && span > 1)
          sheet.mergeCells(row.number, 1, row.number, span);
        if (rowModel.style === 'note')
          row.getCell(1).alignment = { wrapText: true, vertical: 'top' };
      } else if (rowModel.style === 'header' || rowModel.style === 'total') {
        row.font = { bold: true };
      } else if (rowModel.style === 'label') {
        row.getCell(1).font = { bold: true };
        // A label with one value runs the value across the rest of the sheet.
        if (rowModel.cells.length === 2 && span > 2)
          sheet.mergeCells(row.number, 2, row.number, span);
      }
    }
    sheet.pageSetup.printArea = `A1:${sheet.getColumn(span).letter}${Math.max(1, sheet.rowCount)}`;
  }
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
