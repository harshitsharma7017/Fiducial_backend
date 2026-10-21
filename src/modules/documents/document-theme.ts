// Q2 (one design for all generated documents): the single source of the Fiducial document design
// used by every generated PDF — RFQ, QCR, Placement Slip and the Coverage Confirmation Letter.
// These constants were previously inlined in sheet-pdf.ts; they are named here so each document
// reuses the same branding, colours, spacing, page geometry, header rule, footer and page
// numbering by reference rather than by copying values. Nothing here changes the rendered output:
// it is the one place the design lives. The look follows the client's RFQ design (Invoice-2).
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

/**
 * The brand palette, as used across the documents (the RFQ design of "Invoice-2": deep navy
 * headings and text, light-blue table fills and lines, a green and blue accent).
 */
export const DOCUMENT_COLORS = {
  /** The header accent and primary headings (Fiducial navy). */
  rule: '#12285e',
  /** Body text: navy, as in the RFQ design. */
  ink: '#1a2b6d',
  /** Muted grey-blue for footers, sheet captions and secondary text. */
  muted: '#5b6b8c',
  /** Body text for labels (the letterhead address). */
  text: '#2d3a63',
  /** Table gridlines: a light blue. */
  gridline: '#b9d3ee',
  /** Table-header fill (light blue); the same tone the document workbooks use (TABLE_HEADER_FILL_ARGB). */
  tableHeader: '#dcebfa',
  /** The green of the header and footer accents. */
  accentGreen: '#4caf50',
  /** The blue of the header accent. */
  accentBlue: '#2b8fd6',
} as const;

/** The same table-header tint as an exceljs ARGB, for the workbook documents (one source). */
export const TABLE_HEADER_FILL_ARGB = 'FFDCEBFA';

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

/** A faint "Fiducial" mark behind every page. */
export const WATERMARK = {
  text: 'Fiducial',
  color: DOCUMENT_COLORS.rule,
  opacity: 0.04,
  bold: true,
  italics: false,
  fontSize: 96,
} as const;
