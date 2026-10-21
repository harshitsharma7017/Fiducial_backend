import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { pdfLines } from '../quotes/quote-extraction.ts';
import { DOCUMENT_COLORS } from './document-theme.ts';
import { workbookToPdf } from './sheet-pdf.ts';

// The generated PDFs: the placement slip's header (logo, address, rule) and footer (reference,
// page number) on every page, with the RFQ design's light-blue tables and navy text.

async function pdfOf(pages: number) {
  const workbook = new ExcelJS.Workbook();
  for (let page = 1; page <= pages; page += 1) {
    const sheet = workbook.addWorksheet(`Sheet ${page}`);
    sheet.getCell('A1').value = `Coverage section ${page}`;
    sheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF6' } };
    sheet.getCell('B1').value = 'Premium';
  }
  return workbookToPdf(workbook, {
    letterhead: { logo: null, address: 'Fiducial Insurance Brokers India Pvt Ltd | Pune' },
    title: 'RFQ PRP-2026-0001 — Acme Mills',
    footer: 'RFQ PRP-2026-0001 · Acme Mills',
  });
}

describe('document design', () => {
  it('prints the letterhead, the reference and the page numbers on every page', async () => {
    const lines = (await pdfLines(await pdfOf(2))) ?? [];
    expect(
      lines.filter((line) => line.includes('Fiducial Insurance Brokers India Pvt Ltd · Pune')),
    ).toHaveLength(2);
    expect(lines.filter((line) => line.includes('RFQ PRP-2026-0001 · Acme Mills'))).toHaveLength(2);
    expect(lines.some((line) => line.includes('Page 2 of 2'))).toBe(true);
    expect(lines.some((line) => line.includes('section 2'))).toBe(true);
  });

  it('uses the navy and light-blue palette of the RFQ design', () => {
    expect(DOCUMENT_COLORS.rule).toBe('#12285e');
    expect(DOCUMENT_COLORS.tableHeader).toBe('#dcebfa');
  });
});
