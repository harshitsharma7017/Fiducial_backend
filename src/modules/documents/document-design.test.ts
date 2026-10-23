import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { pdfLines } from '../quotes/quote-extraction.ts';
import { DOCUMENT_COLORS } from './document-theme.ts';
import { sheetHeading, workbookToPdf } from './sheet-pdf.ts';

// The generated PDFs: the Fiducial letterhead (logo, address, rule; the contact line and corner
// accent at the foot) with the reference and page number on every page, and the RFQ design's
// light-blue tables and navy text.

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
    // The Fiducial letterhead: the broker's address, and the contact line at the foot.
    expect(lines.filter((line) => line.includes('Coimbatore - 641 012.'))).toHaveLength(2);
    expect(
      lines.filter((line) => line.includes('info@fiducial.in') && line.includes('www.fiducial.in')),
    ).toHaveLength(2);
    expect(lines.filter((line) => line.includes('RFQ PRP-2026-0001 · Acme Mills'))).toHaveLength(2);
    expect(lines.some((line) => line.includes('Page 2 of 2'))).toBe(true);
    expect(lines.some((line) => line.includes('section 2'))).toBe(true);
  });

  it('heads each sheet with its name in title case', async () => {
    const heading = (name: string) =>
      (sheetHeading(name).table.body[0]?.[0] as { text: string }).text;
    expect(heading('premium details')).toBe('Premium Details');
    expect(heading('fire by location')).toBe('Fire by Location');
    expect(heading('add-on covers')).toBe('Add-on Covers');
    expect(heading('Annexure')).toBe('Annexure');
    const lines = (await pdfLines(await pdfOf(1))) ?? [];
    expect(lines.some((line) => line.includes('Sheet 1'))).toBe(true);
  });

  it('uses the navy and light-blue palette of the RFQ design', () => {
    expect(DOCUMENT_COLORS.rule).toBe('#12285e');
    expect(DOCUMENT_COLORS.tableHeader).toBe('#dcebfa');
  });
});
