import { QuoteExtractionSchema, type QuoteExtraction } from '../../src/shared/index.ts';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.ts';
import { createLogger } from '../../src/lib/logger.ts';
import { quoteReaderFromEnv, type QuoteReader } from '../../src/modules/quotes/quote-reader.ts';
import { SYNTHETIC_QUOTE_ROWS, textPdf } from '../helpers/quote-pdf.ts';

// Real calls to Gemini with synthetic quotes only (never a real insurer's document, never the
// database). Runs only with GEMINI_LIVE_TEST=1 and a GEMINI_API_KEY: npm run test:live:gemini.
// Two requests: the standard synthetic quote, and one with conflicting totals and missing fields.
// They check the request is accepted and the answer maps and validates; not accuracy.

const enabled = process.env.GEMINI_LIVE_TEST === '1' && Boolean(process.env.GEMINI_API_KEY);

/** Made up: two different totals are printed, and there is no validity date or quote number. */
const CONFLICTING_QUOTE_ROWS = [
  ['Sample Assurance Test Ltd.'],
  ['Section', 'Premium (Rs.)'],
  ['Money in Transit', '1,00,000.00'],
  ['Net Premium (before GST)', '1,00,000.00'],
  ['GST @ 18%', '18,000.00'],
  ['Total Premium payable', '1,18,000.00'],
  ['Total amount payable', '1,25,000.00'],
];

function liveReader(): QuoteReader {
  const config = loadEnv({
    MONGODB_URI: 'mongodb://127.0.0.1:1/unused',
    JWT_SECRET: 'live-test-only-secret-with-32-characters',
    JWT_EXPIRES_IN_SECONDS: '3600',
    CORS_ORIGIN: 'http://localhost:3000',
    ...process.env,
    OCR_PROVIDER: 'gemini',
  });
  return quoteReaderFromEnv(config, createLogger({ level: 'info' }));
}

async function readLive(rows: string[][]): Promise<QuoteExtraction> {
  const result = await liveReader().read({
    id: 'a'.repeat(24),
    contentType: 'application/pdf',
    data: await textPdf(rows),
  });
  // The answer must be the app's own contract, with nothing extra.
  const parsed = QuoteExtractionSchema.safeParse(result);
  expect(parsed.success).toBe(true);
  expect(parsed.data).toEqual(result);
  return result;
}

/** What was read, for the run's record (synthetic values only; never the key). */
function summary(label: string, result: QuoteExtraction): void {
  const show = (name: string, field: { value: string | null; state: string }) =>
    `  ${name}: ${field.value ?? '—'} [${field.state}]`;
  process.stdout.write(
    [
      `\n[live] ${label}: reader=${result.reader} source=${result.source} manualEntryRequired=${String(result.manualEntryRequired)}`,
      show('insurerName', result.insurerName),
      show('insuredName', result.insuredName),
      show('quoteReference', result.quoteReference),
      show('validUntil', result.validUntil),
      ...result.sections.flatMap((section) => [
        show(`${section.code}.premium`, section.premium),
        ...(section.code === 'FIRE'
          ? [show(`${section.code}.premiumWithoutTerrorism`, section.premiumWithoutTerrorism)]
          : []),
      ]),
      show('netPremium', result.netPremium),
      show('gstRatePercent', result.gstRatePercent),
      show('gstAmount', result.gstAmount),
      show('totalPremium', result.totalPremium),
      `  discrepancies: ${result.discrepancies.length ? result.discrepancies.join(' / ') : 'none'}`,
      '',
    ].join('\n'),
  );
}

describe.skipIf(!enabled)('Gemini quote reader, live', () => {
  it('reads the synthetic text quote', async () => {
    const result = await readLive(SYNTHETIC_QUOTE_ROWS);
    summary('synthetic quote', result);
    expect(result).toMatchObject({
      reader: 'GEMINI',
      source: 'PDF_TEXT',
      manualEntryRequired: false,
      option: { value: null, state: 'MISSING' },
      // Not printed on the synthetic quote: must stay missing, not be invented.
      insuredName: { value: null, state: 'MISSING' },
      quoteReference: { value: 'FTI/2026/0457' },
      validUntil: { value: '2026-12-31' },
      netPremium: { value: '102500.50' },
      gstAmount: { value: '18450.09' },
      totalPremium: { value: '120950.59' },
    });
    const by = Object.fromEntries(result.sections.map((section) => [section.code, section]));
    expect(by.FIRE?.premium.value).toBe('100000.50');
    expect(by.FIRE?.premiumWithoutTerrorism.value).toBe('90000.00');
    expect(by.MONEY?.premium.value).toBe('2500.00');
  });

  it('flags conflicting totals and leaves unprinted values missing', async () => {
    const result = await readLive(CONFLICTING_QUOTE_ROWS);
    summary('conflicting quote', result);
    expect(result).toMatchObject({ reader: 'GEMINI', manualEntryRequired: false });
    expect(result.validUntil).toEqual({ raw: null, value: null, state: 'MISSING' });
    expect(result.quoteReference).toEqual({ raw: null, value: null, state: 'MISSING' });
    // The conflict must reach the staff: the total is not "read clearly" without a warning.
    expect(result.totalPremium.state !== 'HIGH' || result.discrepancies.length > 0).toBe(true);
  });
});
