import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.ts';
import { createLogger } from '../../src/lib/logger.ts';
import { quoteReaderFromEnv } from '../../src/modules/quotes/quote-reader.ts';
import { SYNTHETIC_QUOTE_ROWS, textPdf } from '../helpers/quote-pdf.ts';

// One real call to Gemini with the synthetic quote (never a real insurer's document). Runs only
// with GEMINI_LIVE_TEST=1 and a GEMINI_API_KEY: npm run test:live:gemini. It checks the request
// is accepted and the answer maps; it is not an accuracy measurement.

const enabled = process.env.GEMINI_LIVE_TEST === '1' && Boolean(process.env.GEMINI_API_KEY);

describe.skipIf(!enabled)('Gemini quote reader, live', () => {
  it('reads the synthetic text quote', async () => {
    const config = loadEnv({
      MONGODB_URI: 'mongodb://127.0.0.1:1/unused',
      JWT_SECRET: 'live-test-only-secret-with-32-characters',
      JWT_EXPIRES_IN_SECONDS: '3600',
      CORS_ORIGIN: 'http://localhost:3000',
      ...process.env,
      OCR_PROVIDER: 'gemini',
    });
    const reader = quoteReaderFromEnv(config, createLogger({ level: 'info' }));
    const result = await reader.read({
      id: 'a'.repeat(24),
      contentType: 'application/pdf',
      data: await textPdf(SYNTHETIC_QUOTE_ROWS),
    });
    expect(result).toMatchObject({
      reader: 'GEMINI',
      source: 'PDF_TEXT',
      manualEntryRequired: false,
    });
    expect(result.netPremium.value).toBe('102500.50');
    expect(result.totalPremium.value).toBe('120950.59');
  });
});
