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

/**
 * Page margins in points. The top leaves room for the letterhead (logo, address and rule), the
 * bottom for the contact line and the reference and page number above it.
 */
export const MARGIN = { left: 36, right: 36, top: 118, bottom: 62 } as const;

/** The broker as the letterhead prints it (the Fiducial letterhead, "Invoice-2"). */
export const BROKER = {
  name: 'Fiducial Insurance Brokers India Pvt Ltd',
  address: [
    'LBR Complex, 172/1, Third Floor, Rajunaidu',
    'Road, Sivananda Colony,',
    'Coimbatore - 641 012.',
  ],
  telephone: '+91 422 4372530 / 2499962',
  email: 'info@fiducial.in',
  website: 'www.fiducial.in',
} as const;

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
  /** The green of the letterhead's corner accent. */
  accentGreen: '#5fa83a',
  /** The letterhead's address and the contact line. */
  letterhead: '#111827',
  contact: '#1d3d7a',
  /** The blue of the header accent. */
  accentBlue: '#2b8fd6',
} as const;

/** The same table-header tint as an exceljs ARGB, for the workbook documents (one source). */
export const TABLE_HEADER_FILL_ARGB = 'FFDCEBFA';

/**
 * An add-on cover asked for is marked with a green tick rather than the word "Required" (client
 * review of 27 Oct 2026). The PDF draws the tick (the bundled font has no ✓); Excel shows the
 * character in this green.
 */
export const COVER_TICK = '✓';
export const COVER_TICK_ARGB = 'FF00A04A';

/** The highlight of a document's note section: a soft yellow the PDF keeps (not the table tint). */
export const NOTE_FILL_ARGB = 'FFFFF2CC';

/** Font sizes in points, shared so every document reads the same. */
export const DOCUMENT_FONT = {
  body: 8,
  /**
   * Every table cell of a sheet drawn to PDF, whatever the sheet's width (client review of 27 Oct
   * 2026: one readable size); titles in a larger template font get `tableTitle`.
   */
  table: 8,
  tableTitle: 9.5,
  footer: 7,
  caption: 7,
  letterheadAddress: 9,
  contact: 8.5,
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
