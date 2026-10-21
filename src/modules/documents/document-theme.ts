// Q2 (one design for all generated documents): the single source of the Fiducial document design
// used by every generated PDF — RFQ, QCR, Placement Slip and the Coverage Confirmation Letter.
// These constants were previously inlined in sheet-pdf.ts; they are named here so each document
// reuses the same branding, colours, spacing, page geometry, header rule, footer and page
// numbering by reference rather than by copying values. Nothing here changes the rendered output:
// it is the existing look, given one home.
//
// The approved QCR is the visual reference. The QCR, RFQ and Placement Slip are drawn from the
// client's Excel templates through sheet-pdf.ts's workbookToPdf; the Coverage Confirmation Letter
// (Q4) is drawn directly with pdfmake and takes its header, footer, fonts and palette from here so
// it sits in the same family without a second, disconnected stylesheet.

/** A4 portrait in points (the unit pdfmake uses). */
export const PAGE = { width: 595.28, height: 841.89 } as const;

/** Page margins in points. The top leaves room for the letterhead band drawn in the header. */
export const MARGIN = { left: 36, right: 36, top: 92, bottom: 44 } as const;

export const CONTENT_WIDTH = PAGE.width - MARGIN.left - MARGIN.right;

/** The brand palette, as used across the documents. Navy is the Fiducial primary. */
export const DOCUMENT_COLORS = {
  /** The header rule and primary accents (Fiducial navy). */
  rule: '#1f3a5f',
  /** Muted grey for footers, sheet captions and secondary text. */
  muted: '#6b7280',
  /** Body text grey (the letterhead address and labels). */
  text: '#374151',
  /** Table gridlines. */
  gridline: '#6b7280',
  /**
   * Table-header fill (light navy tint). The same tone the Excel documents use for their header
   * rows (ARGB FFE8EEF6 in rfq-workbook.ts), so a directly-drawn document's table headers match
   * the workbook-derived PDFs. Kept as a 6-hex string for pdfmake; the Excel side pairs with
   * TABLE_HEADER_FILL_ARGB below.
   */
  tableHeader: '#E8EEF6',
} as const;

/** The same table-header tint as an exceljs ARGB, for the workbook documents (one source). */
export const TABLE_HEADER_FILL_ARGB = 'FFE8EEF6';

/** Font sizes in points, shared so every document reads the same. */
export const DOCUMENT_FONT = {
  body: 8,
  footer: 7,
  caption: 7,
  letterheadAddress: 7,
  /** A document's own title block (used by the Coverage Confirmation Letter). */
  title: 15,
  heading: 11,
} as const;

/** The bundled font family (no network or arbitrary file access; see sheet-pdf.ts). */
export const DOCUMENT_FONT_FAMILY = 'Roboto';

export const DOCUMENT_LINE_HEIGHT = 1.1;
