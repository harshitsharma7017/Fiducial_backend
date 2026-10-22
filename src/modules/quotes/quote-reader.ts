import type { OcrReader, QuoteExtraction } from '../../shared/index.ts';
import type { Env } from '../../config/env.ts';
import type { Logger } from '../../lib/logger.ts';
import { geminiQuoteReader, geminiSdkGenerate } from './gemini-quote-reader.ts';
import { extractQuote } from './quote-extraction.ts';

// Who reads a kept quote file for the quote form's auto-fill (Q1), chosen by OCR_PROVIDER. Every
// reader returns candidate values only: nothing is saved, and the staff check each value before
// the quote is recorded through the usual quote route.

/** A quote file as kept on the case: its type was checked from its content on upload. */
export interface QuoteFile {
  id: string;
  contentType: string;
  data: Buffer;
}

export interface QuoteReader {
  readonly name: OcrReader;
  /** True when the file, or its text, may be sent outside the server to be read. */
  readonly external: boolean;
  /**
   * Candidate values for the quote form. A file that cannot be read gives manualEntryRequired; a
   * reading service that fails throws an AppError the staff can retry after.
   */
  read(file: QuoteFile): Promise<QuoteExtraction>;
}

/** The built-in reader: text PDFs only, read on the server (OCR_PROVIDER=none). */
export const builtInQuoteReader: QuoteReader = {
  name: 'BUILT_IN',
  external: false,
  read: extractQuote,
};

/** The reader OCR_PROVIDER selects. There is no fallback from one reader to another. */
export function quoteReaderFromEnv(
  config: Pick<Env, 'OCR_PROVIDER' | 'GEMINI_API_KEY' | 'GEMINI_MODEL' | 'GEMINI_TIMEOUT_MS'>,
  logger: Logger,
): QuoteReader {
  if (config.OCR_PROVIDER !== 'gemini') return builtInQuoteReader;
  // loadEnv refuses OCR_PROVIDER=gemini without a key; this guards a config built by hand.
  if (!config.GEMINI_API_KEY)
    throw new Error('GEMINI_API_KEY is required when OCR_PROVIDER=gemini');
  return geminiQuoteReader({
    model: config.GEMINI_MODEL,
    logger,
    generate: geminiSdkGenerate({
      apiKey: config.GEMINI_API_KEY,
      model: config.GEMINI_MODEL,
      timeoutMs: config.GEMINI_TIMEOUT_MS,
    }),
  });
}
