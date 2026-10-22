import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  SECTION_CODES,
  field,
  lowConfidence,
  normalizePercent,
  normalizeRupees,
  premiumDiscrepancies,
  type OcrField,
  type OcrSection,
  type QuoteExtraction,
  type SectionCode,
} from '../../shared/index.ts';

// Reading an insurer's quote PDF (Q1): the text of a text-based PDF is split into lines, and the
// lines are matched to the quote form's fields. The result is only a set of candidates for staff
// to review: nothing is saved, a value that cannot be read cleanly is left empty or marked low,
// and the insurer's own figures are never "corrected". Scanned PDFs, pictures and mails are not
// read here: the staff enter those by hand, unless OCR_PROVIDER=gemini (gemini-quote-reader.ts).

/** Pages read from a PDF; a longer PDF is not read in full. */
export const MAX_PAGES = 30;
const MIN_TEXT_CHARACTERS = 40;

// ---------------------------------------------------------------------------------------------
// PDF text
// ---------------------------------------------------------------------------------------------

/** The lines of text of a PDF, top to bottom; null when the file cannot be opened as a PDF. */
export async function pdfLines(data: Buffer): Promise<string[] | null> {
  return (await pdfPages(data))?.pages.flat() ?? null;
}

/**
 * The lines of text of each of the first MAX_PAGES pages of a PDF, and how many pages it has;
 * null when the file cannot be opened as a PDF.
 */
export async function pdfPages(
  data: Buffer,
): Promise<{ numPages: number; pages: string[][] } | null> {
  try {
    const task = pdfjs.getDocument({
      data: new Uint8Array(data),
      // Nothing from the file is executed, fetched or rendered.
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      useWorkerFetch: false,
      verbosity: 0,
    });
    const document = await task.promise;
    const pages: string[][] = [];
    try {
      for (let number = 1; number <= Math.min(document.numPages, MAX_PAGES); number += 1) {
        const lines: string[] = [];
        pages.push(lines);
        const page = await document.getPage(number);
        const content = await page.getTextContent();
        const rows: Array<{ y: number; parts: Array<{ x: number; text: string }> }> = [];
        for (const item of content.items) {
          if (!('str' in item) || item.str.trim() === '') continue;
          const x = item.transform[4] as number;
          const y = item.transform[5] as number;
          const row = rows.find((candidate) => Math.abs(candidate.y - y) <= 2.5);
          if (row) row.parts.push({ x, text: item.str });
          else rows.push({ y, parts: [{ x, text: item.str }] });
        }
        rows.sort((a, b) => b.y - a.y);
        for (const row of rows) {
          row.parts.sort((a, b) => a.x - b.x);
          lines.push(
            row.parts
              .map((part) => part.text.trim())
              .join(' ')
              .replace(/\s+/g, ' '),
          );
        }
        page.cleanup();
      }
      return { numPages: document.numPages, pages };
    } finally {
      await document.destroy();
    }
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Matching lines to fields (pure)
// ---------------------------------------------------------------------------------------------

/** How each section is worded in an insurer's quote; the longest wording found on a line wins. */
const SECTION_WORDS: Record<SectionCode, readonly string[]> = {
  FIRE: ['fire and special perils', 'fire & special perils', 'standard fire', 'sfsp', 'fire'],
  FIRE_FLOATER: ['fire floater'],
  BURGLARY: ['burglary', 'house breaking', 'housebreaking'],
  BURGLARY_FLOATER: ['burglary floater'],
  FIRE_LOSS_OF_PROFIT: ['fire loss of profit', 'loss of profit', 'fire lop', 'flop'],
  MONEY: ['money in transit', 'money in safe', 'money'],
  FIDELITY_GUARANTEE: ['fidelity guarantee', 'fidelity'],
  PLATE_GLASS: ['plate glass'],
  NEON_GLOW_SIGN: ['neon glow sign', 'neon / glow sign', 'neon', 'glow sign'],
  ALL_RISK: ['all risks', 'all risk'],
  EEI: ['electronic equipment', 'eei'],
  MECHANICAL_BREAKDOWN: ['mechanical breakdown', 'machinery breakdown'],
  BOILER_PRESSURE_PLANT: ['boiler and pressure plant', 'boiler & pressure plant', 'boiler'],
  PUBLIC_LIABILITY: ['public liability'],
};
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SECTION_PATTERNS = SECTION_CODES.flatMap((code) =>
  SECTION_WORDS[code].map((word) => ({
    code,
    length: word.length,
    pattern: new RegExp(`(?<![a-z])${escape(word).replace(/\s+/g, '\\s+')}(?![a-z])`, 'i'),
  })),
).sort((a, b) => b.length - a.length);

/** The section a line is about: the longest wording on it; null when it names none. */
export function sectionOf(line: string): SectionCode | null {
  return SECTION_PATTERNS.find((entry) => entry.pattern.test(line))?.code ?? null;
}

const AMOUNT = /(?<![\d.,])\d[\d,]*(?:\.\d{1,2})?(?![\d])/g;

/** The money amounts on a line, as clean rupee strings; percentages and dates are left out. */
export function amountsOn(line: string): Array<{ raw: string; value: string }> {
  const cleaned = line
    .replace(/\d+(?:\.\d+)?\s*%/g, ' ')
    .replace(/\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/g, ' ')
    .replace(/\b\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}\b/g, ' ');
  const found: Array<{ raw: string; value: string }> = [];
  for (const match of cleaned.matchAll(AMOUNT)) {
    const value = normalizeRupees(match[0]);
    // Only figures that look like money: at least 3 digits or with paise (so "1", "2025" noise
    // such as clause numbers is left out of 1-2 digit counts).
    if (value !== null && (value.length >= 3 || value.includes('.'))) {
      found.push({ raw: match[0], value });
    }
  }
  return found;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function isoDate(day: number, month: number, year: number): string | null {
  const full = year < 100 ? 2000 + year : year;
  const date = new Date(Date.UTC(full, month - 1, day));
  if (date.getUTCFullYear() !== full || date.getUTCMonth() !== month - 1) return null;
  if (date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

/** A date written day first (30/11/2026, 30-11-26, 30 Nov 2026), or null. */
export function dateIn(text: string): { raw: string; iso: string } | null {
  const numeric = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b/.exec(text);
  if (numeric) {
    const iso = isoDate(Number(numeric[1]), Number(numeric[2]), Number(numeric[3]));
    return iso ? { raw: numeric[0], iso } : null;
  }
  const worded = /\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9}),?\s+(\d{4})\b/.exec(text);
  if (worded) {
    const month = MONTHS.indexOf(worded[2]!.slice(0, 3).toLowerCase()) + 1;
    const iso = month > 0 ? isoDate(Number(worded[1]), month, Number(worded[3])) : null;
    return iso ? { raw: worded[0], iso } : null;
  }
  return null;
}

/** A field nothing was found for. */
export const missing = (): OcrField => field(null, null);

/** The last amount of the lines' matches; several different candidates make it low confidence. */
function pick(candidates: ReadonlyArray<{ line: string; amounts: ReturnType<typeof amountsOn> }>) {
  if (candidates.length === 0) return missing();
  const first = candidates[0]!;
  const last = first.amounts[first.amounts.length - 1]!;
  const result = field(first.line, last.value);
  const competing =
    first.amounts.length > 1 ||
    candidates.some((item) => item.amounts[item.amounts.length - 1]!.value !== last.value);
  return competing ? lowConfidence(result) : result;
}

/** The candidate values of a quote from the lines of its text. Pure. */
export function parseQuoteLines(lines: readonly string[], attachmentId: string): QuoteExtraction {
  const per = new Map<
    SectionCode,
    {
      premium: Array<{ line: string; amounts: ReturnType<typeof amountsOn> }>;
      without: Array<{ line: string; amounts: ReturnType<typeof amountsOn> }>;
    }
  >();
  const net: Array<{ line: string; amounts: ReturnType<typeof amountsOn> }> = [];
  const total: typeof net = [];
  const gst: typeof net = [];
  let rate: OcrField = missing();
  let validUntil: OcrField = missing();
  let reference: OcrField = missing();

  for (const line of lines) {
    const amounts = amountsOn(line);
    const lower = line.toLowerCase();
    const percent = /(\d{1,2}(?:\.\d{1,2})?)\s*%/.exec(line);

    if (
      /quot(?:e|ation)\s*(?:no|number|ref(?:erence)?)\b/i.test(line) &&
      reference.value === null
    ) {
      const match =
        /quot(?:e|ation)\s*(?:no|number|ref(?:erence)?)\.?\s*[:-]?\s*([A-Za-z0-9/-]{4,40})/i.exec(
          line,
        );
      if (match) reference = field(line, match[1]!);
    }
    if (/valid(?:ity)?|expir/i.test(line) && validUntil.value === null) {
      const date = dateIn(line);
      if (date) validUntil = field(line, date.iso);
    }
    if (amounts.length === 0) {
      if (percent && /gst/i.test(line) && rate.value === null) {
        rate = field(line, normalizePercent(percent[1]));
      }
      continue;
    }
    // Totals first: "Total premium" and "Net premium" are not sections.
    if (/before\s+gst|excluding\s+gst|excl\.?\s+gst|net\s+premium|basic\s+premium/.test(lower)) {
      net.push({ line, amounts });
      continue;
    }
    if (
      /(total|grand|gross)\s+(premium|payable|amount)|premium\s+payable|amount\s+payable/.test(
        lower,
      )
    ) {
      total.push({ line, amounts });
      continue;
    }
    if (/\b(i|c|s)?gst\b|service\s+tax/.test(lower)) {
      gst.push({ line, amounts });
      if (percent && rate.value === null) rate = field(line, normalizePercent(percent[1]));
      continue;
    }
    const code = sectionOf(line);
    if (code === null) continue;
    const entry = per.get(code) ?? { premium: [], without: [] };
    if (
      /without\s+terrorism|excluding\s+terrorism|excl\.?\s+terrorism|ex\.?\s+terrorism/.test(lower)
    ) {
      entry.without.push({ line, amounts });
    } else {
      entry.premium.push({ line, amounts });
    }
    per.set(code, entry);
  }

  // CGST and SGST are two lines of half the rate each: their amounts are added.
  let gstAmount: OcrField;
  const halves = gst.filter((item) => /\b[cs]gst\b/i.test(item.line));
  if (halves.length === 2) {
    const sum = halves.reduce(
      (acc, item) => acc + Math.round(Number(item.amounts[item.amounts.length - 1]!.value) * 100),
      0,
    );
    gstAmount = lowConfidence(
      field(halves.map((item) => item.line).join(' | '), (sum / 100).toFixed(2)),
    );
    if (rate.value !== null)
      rate = lowConfidence({ ...rate, value: String(Number(rate.value) * 2) });
  } else {
    gstAmount = pick(gst);
  }

  const sections: OcrSection[] = [...per.entries()].map(([code, entry]) => ({
    code,
    premium: pick(entry.premium),
    premiumWithoutTerrorism: code === 'FIRE' ? pick(entry.without) : missing(),
  }));

  const extraction: QuoteExtraction = {
    source: 'PDF_TEXT',
    reader: 'BUILT_IN',
    attachmentId,
    insurerName: missing(),
    insuredName: missing(),
    quoteReference: reference,
    option: { value: null, state: 'MISSING' },
    sections,
    netPremium: pick(net),
    gstRatePercent: rate,
    gstAmount,
    totalPremium: pick(total),
    validUntil,
    discrepancies: [],
    manualEntryRequired: false,
  };
  extraction.discrepancies = premiumDiscrepancies(extraction);
  return extraction;
}

/** Nothing read: the staff enter every value by hand, for the reason given. */
export const nothing = (
  attachmentId: string,
  reason: string,
  reader: QuoteExtraction['reader'] = 'BUILT_IN',
): QuoteExtraction => ({
  source: 'NONE',
  reader,
  attachmentId,
  insurerName: missing(),
  insuredName: missing(),
  quoteReference: missing(),
  option: { value: null, state: 'MISSING' },
  sections: [],
  netPremium: missing(),
  gstRatePercent: missing(),
  gstAmount: missing(),
  totalPremium: missing(),
  validUntil: missing(),
  discrepancies: [reason],
  manualEntryRequired: true,
});

/** Reads a stored attachment: a text PDF is parsed; anything else asks for manual entry. */
export async function extractQuote(attachment: {
  id: string;
  contentType: string;
  data: Buffer;
}): Promise<QuoteExtraction> {
  if (attachment.contentType !== 'application/pdf') {
    return nothing(
      attachment.id,
      attachment.contentType.startsWith('image/')
        ? 'Pictures are read only when a reading service is set up. Enter the figures by hand.'
        : 'Only PDF quotes are read automatically. Enter the figures from this file by hand.',
    );
  }
  const lines = await pdfLines(attachment.data);
  if (lines === null) {
    return nothing(attachment.id, 'The PDF could not be read. Enter the figures by hand.');
  }
  if (lines.join('').replace(/\s/g, '').length < MIN_TEXT_CHARACTERS) {
    return nothing(
      attachment.id,
      'This PDF has no text to read (it looks scanned). Enter the figures by hand.',
    );
  }
  const extraction = parseQuoteLines(lines, attachment.id);
  const nothingFound =
    extraction.sections.length === 0 &&
    extraction.netPremium.value === null &&
    extraction.totalPremium.value === null;
  if (nothingFound) {
    return {
      ...nothing(attachment.id, 'No premiums were recognised in this PDF. Enter them by hand.'),
      source: 'PDF_TEXT',
    };
  }
  return extraction;
}
