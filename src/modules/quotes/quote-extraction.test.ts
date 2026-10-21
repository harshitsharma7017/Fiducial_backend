import { describe, expect, it } from 'vitest';
import { SYNTHETIC_QUOTE_ROWS, textPdf } from '../../../test/helpers/quote-pdf.ts';
import {
  amountsOn,
  dateIn,
  extractQuote,
  parseQuoteLines,
  pdfLines,
  sectionOf,
} from './quote-extraction.ts';

// Reading quote PDFs (Q1) on synthetic layouts. Real insurers' layouts are not available, so
// accuracy on them is unverified: every value is a candidate for staff to review.

describe('matching lines', () => {
  it('names the section of a line by its longest wording, never Fire for a Fire variant', () => {
    expect(sectionOf('Fire and Special Perils 1,00,000')).toBe('FIRE');
    expect(sectionOf('Fire Floater 40,000')).toBe('FIRE_FLOATER');
    expect(sectionOf('Fire Loss of Profit 12,000')).toBe('FIRE_LOSS_OF_PROFIT');
    expect(sectionOf('Burglary Floater 9,000')).toBe('BURGLARY_FLOATER');
    expect(sectionOf('Boiler & Pressure Plant 5,000')).toBe('BOILER_PRESSURE_PLANT');
    expect(sectionOf('Terms and conditions apply')).toBeNull();
    expect(sectionOf('Firefighting equipment')).toBeNull();
  });

  it('reads money amounts and leaves out percentages and dates', () => {
    expect(amountsOn('GST @ 18% 18,450.09').map((item) => item.value)).toEqual(['18450.09']);
    expect(amountsOn('Valid till 31/12/2026').map((item) => item.value)).toEqual([]);
    expect(amountsOn('Fire 6,00,00,000 1,00,000.50').map((item) => item.value)).toEqual([
      '60000000',
      '100000.50',
    ]);
  });

  it('reads day-first dates and refuses impossible ones', () => {
    expect(dateIn('valid till 31/12/2026')?.iso).toBe('2026-12-31');
    expect(dateIn('valid until 5 Jan 2027')?.iso).toBe('2027-01-05');
    expect(dateIn('valid till 31/02/2026')).toBeNull();
    expect(dateIn('valid for 30 days')).toBeNull();
  });
});

describe('parseQuoteLines', () => {
  it('maps premiums, totals, GST and validity, and marks a line with two amounts low', () => {
    const lines = [
      'Quotation No: FTI/2026/0457',
      'Fire and Special Perils (with terrorism) 6,00,00,000 1,00,000.50',
      'Fire and Special Perils (without terrorism) 90,000.00',
      'Money in Transit 2,500.00',
      'Net Premium (before GST) 1,02,500.50',
      'GST @ 18% 18,450.09',
      'Total Premium payable 1,20,950.59',
      'This quotation is valid till 31/12/2026',
    ];
    const result = parseQuoteLines(lines, 'a'.repeat(24));
    const bySection = Object.fromEntries(result.sections.map((section) => [section.code, section]));
    expect(bySection.FIRE!.premium).toMatchObject({ value: '100000.50', state: 'LOW' });
    expect(bySection.FIRE!.premiumWithoutTerrorism).toMatchObject({
      value: '90000.00',
      state: 'HIGH',
    });
    expect(bySection.MONEY!.premium).toMatchObject({ value: '2500.00', state: 'HIGH' });
    expect(result.netPremium.value).toBe('102500.50');
    expect(result.gstAmount.value).toBe('18450.09');
    expect(result.gstRatePercent.value).toBe('18');
    expect(result.totalPremium.value).toBe('120950.59');
    expect(result.validUntil.value).toBe('2026-12-31');
    expect(result.quoteReference.value).toBe('FTI/2026/0457');
    expect(result.discrepancies).toEqual([]);
  });

  it('shows an arithmetic mismatch without changing the insurer’s figures', () => {
    const result = parseQuoteLines(
      ['Net Premium (before GST) 1,00,000', 'GST @ 18% 18,000', 'Total Premium 1,20,000'],
      'a'.repeat(24),
    );
    expect(result.totalPremium.value).toBe('120000');
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]).toContain('does not match the stated total');
  });

  it('adds CGST and SGST, with a low-confidence mark', () => {
    const result = parseQuoteLines(
      ['Net Premium 1,00,000', 'CGST @ 9% 9,000', 'SGST @ 9% 9,000', 'Total Premium 1,18,000'],
      'a'.repeat(24),
    );
    expect(result.gstAmount).toMatchObject({ value: '18000.00', state: 'LOW' });
  });
});

describe('extractQuote', () => {
  it('reads a text PDF end to end', async () => {
    const data = await textPdf(SYNTHETIC_QUOTE_ROWS);
    expect((await pdfLines(data))?.some((line) => line.includes('Money in Transit'))).toBe(true);
    const result = await extractQuote({ id: 'b'.repeat(24), contentType: 'application/pdf', data });
    expect(result).toMatchObject({ source: 'PDF_TEXT', manualEntryRequired: false });
    expect(result.netPremium.value).toBe('102500.50');
    expect(result.totalPremium.value).toBe('120950.59');
    expect(result.sections.find((section) => section.code === 'MONEY')?.premium.value).toBe(
      '2500.00',
    );
  });

  it('asks for manual entry for pictures, mails, broken and text-less PDFs', async () => {
    for (const [contentType, data] of [
      ['image/png', Buffer.from([0x89, 0x50])],
      ['message/rfc822', Buffer.from('From: a@b')],
      ['application/pdf', Buffer.from('%PDF-1.4 not really')],
    ] as const) {
      const result = await extractQuote({ id: 'c'.repeat(24), contentType, data });
      expect(result).toMatchObject({ source: 'NONE', manualEntryRequired: true });
      expect(result.sections).toEqual([]);
    }
    const empty = await extractQuote({
      id: 'c'.repeat(24),
      contentType: 'application/pdf',
      data: await textPdf([['.']]),
    });
    expect(empty.manualEntryRequired).toBe(true);
    const unrelated = await extractQuote({
      id: 'c'.repeat(24),
      contentType: 'application/pdf',
      data: await textPdf([
        ['A letter with no premium figures at all, only a long paragraph of words.'],
      ]),
    });
    expect(unrelated).toMatchObject({ source: 'PDF_TEXT', manualEntryRequired: true });
  });
});
