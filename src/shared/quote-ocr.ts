import { z } from 'zod';
import { SECTION_CODES } from './catalog.ts';
import { QuoteOptionSchema } from './quotes.ts';

// Q1 (read insurer quotes with OCR): the contracts and the pure helpers for turning an uploaded
// insurer quote (PDF text or OCR text) into *candidate* values that pre-fill the existing
// quote-capture form. Nothing here saves a quote: the staff must review and confirm every value,
// and the save still goes through the existing recordQuote path. These helpers are deliberately
// dependency-free so they can be unit-tested and reused by both repos.
//
// Design notes that match the requirement:
//  - Every candidate carries a review classification, never an invented confidence percentage.
//  - Ambiguous / unreadable values are left UNRESOLVED for the staff, never silently coerced.
//  - Arithmetic (net + GST = total) is checked with a configurable tolerance and surfaced as a
//    discrepancy; the insurer's explicitly-stated figures are preserved, never overwritten.

/**
 * How much the system trusts a candidate value. Derived from available extraction evidence, not a
 * fabricated score: HIGH when a single unambiguous match was found, LOW when the text was noisy or
 * multiple candidates competed, MISSING when nothing was found, INVALID when a value was found but
 * does not fit the expected type/range. Staff states add CONFIRMED / CORRECTED after review.
 */
export const OCR_REVIEW_STATES = [
  'HIGH',
  'LOW',
  'MISSING',
  'INVALID',
  'CORRECTED',
  'CONFIRMED',
] as const;
export const OcrReviewStateSchema = z.enum(OCR_REVIEW_STATES);
export type OcrReviewState = z.infer<typeof OcrReviewStateSchema>;

export const OCR_REVIEW_STATE_LABELS: Record<OcrReviewState, string> = {
  HIGH: 'Read clearly',
  LOW: 'Low confidence — please check',
  MISSING: 'Not found — please enter',
  INVALID: 'Unreadable — please correct',
  CORRECTED: 'Corrected by staff',
  CONFIRMED: 'Confirmed by staff',
};

/** The engine that produced the text behind an extraction, for the audit trail (never the text). */
export const OCR_SOURCES = ['PDF_TEXT', 'OCR_IMAGE', 'NONE'] as const;
export const OcrSourceSchema = z.enum(OCR_SOURCES);
export type OcrSource = z.infer<typeof OcrSourceSchema>;

/**
 * Who read the file: the built-in text-PDF reader (nothing leaves the server), or Google's Gemini
 * API (the file or its text was sent to Google). Shown to staff and kept in the audit trail.
 */
export const OCR_READERS = ['BUILT_IN', 'GEMINI'] as const;
export const OcrReaderSchema = z.enum(OCR_READERS);
export type OcrReader = z.infer<typeof OcrReaderSchema>;
export const OCR_READER_LABELS: Record<OcrReader, string> = {
  BUILT_IN: 'the built-in PDF reader',
  GEMINI: 'Gemini (Google’s external AI service)',
};

/** One candidate field: the raw text the engine saw and the normalized value, with its state. */
export const OcrFieldSchema = z.object({
  /** The raw snippet the value came from (shown to staff so they can verify), or null. */
  raw: z.string().nullable(),
  /** The normalized value in the app's representation (rupee/percent string), or null. */
  value: z.string().nullable(),
  state: OcrReviewStateSchema,
});
export type OcrField = z.infer<typeof OcrFieldSchema>;

/** A candidate section premium, keyed to the existing section codes. */
export const OcrSectionSchema = z.object({
  code: z.enum(SECTION_CODES),
  premium: OcrFieldSchema,
  premiumWithoutTerrorism: OcrFieldSchema,
});
export type OcrSection = z.infer<typeof OcrSectionSchema>;

/** The complete candidate set for one uploaded quote, mapped onto the existing quote model. */
export const QuoteExtractionSchema = z.object({
  source: OcrSourceSchema,
  reader: OcrReaderSchema.default('BUILT_IN'),
  /** The attachment this was extracted from, so a save references the same proof file. */
  attachmentId: z.string(),
  insurerName: OcrFieldSchema,
  insuredName: OcrFieldSchema,
  quoteReference: OcrFieldSchema,
  option: z.object({ value: QuoteOptionSchema.nullable(), state: OcrReviewStateSchema }),
  sections: z.array(OcrSectionSchema),
  netPremium: OcrFieldSchema,
  gstRatePercent: OcrFieldSchema,
  gstAmount: OcrFieldSchema,
  totalPremium: OcrFieldSchema,
  validUntil: OcrFieldSchema,
  /** Arithmetic / consistency discrepancies to show the staff; never auto-resolved. */
  discrepancies: z.array(z.string()),
  /** True when no engine could read the document and the staff must enter everything by hand. */
  manualEntryRequired: z.boolean(),
});
export type QuoteExtraction = z.output<typeof QuoteExtractionSchema>;

// ---------------------------------------------------------------------------------------------
// Pure normalization helpers
// ---------------------------------------------------------------------------------------------

const RUPEE = /^\d{1,13}(\.\d{1,2})?$/;

/**
 * Normalizes a money string from OCR/PDF text to the app's rupee representation (digits with up to
 * two decimals), handling ₹/Rs, Indian or plain thousands separators, stray spaces and the common
 * OCR confusions (O→0, l/I→1, S→5, comma/period slips). Returns null when the result is not a
 * clean amount — the caller then marks the field INVALID rather than guessing.
 */
export function normalizeRupees(input: string | null | undefined): string | null {
  if (input == null) return null;
  let text = input.trim();
  if (text === '') return null;
  // Drop currency words/symbols and surrounding labels.
  text = text.replace(/(?:₹|rs\.?|inr)/gi, ' ').trim();
  // Keep only the numeric run (first number-looking token).
  const match = text.match(/[\dOolISB.,\s]+/);
  if (!match) return null;
  let token = match[0]
    .replace(/[Oo]/g, '0')
    .replace(/[lI]/g, '1')
    .replace(/S/g, '5')
    .replace(/B/g, '8')
    .replace(/\s+/g, '');
  // Remove thousands separators (both grouping styles). Keep the last '.' as the decimal point.
  // Two adjacent separators, or a separator with no digits around it, is unreadable: refuse to
  // guess rather than silently coerce.
  if (/[.,]{2,}/.test(token) || /^[.,]|[.,]$/.test(token)) return null;
  // Decide the decimal point: the last '.' or ',' counts as the decimal separator only when it is
  // followed by exactly one or two digits (paise). A separator followed by three digits is a
  // thousands group (for example 1,25,000 or 125.000), so there is no fractional part.
  const lastSepMatch = token.match(/[.,](\d+)$/);
  let decimalPos = -1;
  if (lastSepMatch) {
    const digits = lastSepMatch[1] ?? '';
    if (digits.length <= 2) decimalPos = token.length - digits.length - 1;
  }
  if (decimalPos >= 0) {
    const whole = token.slice(0, decimalPos).replace(/[.,]/g, '');
    const fraction = token.slice(decimalPos + 1).replace(/[.,]/g, '');
    token = `${whole}.${fraction}`;
  } else {
    token = token.replace(/[.,]/g, '');
  }
  // Collapse an accidental double decimal and trim to two places.
  const parts = token.split('.');
  if (parts.length > 2) return null;
  let normalized = parts[0] ?? '';
  if (parts.length === 2) normalized += '.' + (parts[1] ?? '').slice(0, 2);
  normalized = normalized.replace(/^0+(?=\d)/, '');
  if (normalized === '' || normalized === '.') return null;
  return RUPEE.test(normalized) ? normalized : null;
}

/**
 * Normalizes a percentage ("18%", "18.00 %", "GST @ 18") to the app's rate string (no % sign,
 * up to two decimals). Returns null when it is not a sane 0–100 rate.
 */
export function normalizePercent(input: string | null | undefined): string | null {
  if (input == null) return null;
  const match = input
    .replace(/[Oo]/g, '0')
    .replace(/[lI]/g, '1')
    .match(/\d{1,3}(?:\.\d{1,2})?/);
  if (!match) return null;
  const value = Number(match[0]);
  if (!Number.isFinite(value) || value < 0 || value > 100) return null;
  // Normalize formatting (e.g. "18.0" -> "18").
  return String(value);
}

/** A field whose value was read cleanly. */
export function field(raw: string | null, value: string | null): OcrField {
  if (value === null) return { raw, value: null, state: raw ? 'INVALID' : 'MISSING' };
  return { raw, value, state: 'HIGH' };
}

/** Marks an otherwise-read field as low confidence (noisy source, competing candidates). */
export function lowConfidence(f: OcrField): OcrField {
  return f.value !== null && f.state === 'HIGH' ? { ...f, state: 'LOW' } : f;
}

// ---------------------------------------------------------------------------------------------
// Pure arithmetic validation
// ---------------------------------------------------------------------------------------------

/** Paise from a clean rupee string (two decimals at most). */
function toPaise(value: string): bigint {
  const [rupees = '0', paise = ''] = value.split('.');
  return BigInt(rupees) * 100n + BigInt(paise.padEnd(2, '0').slice(0, 2));
}

/** Default rounding tolerance for arithmetic checks: one rupee (configurable by the caller). */
export const DEFAULT_OCR_TOLERANCE_PAISE = 100n;

/**
 * Checks the extracted premium arithmetic and returns human-readable discrepancies (QC/Q
 * validation). It never changes the extracted figures: the insurer's stated net/GST/total are
 * preserved for staff review and the mismatch is surfaced. Tolerance absorbs rounding differences
 * between insurers.
 */
export function premiumDiscrepancies(
  extraction: Pick<
    QuoteExtraction,
    'sections' | 'netPremium' | 'gstRatePercent' | 'gstAmount' | 'totalPremium'
  >,
  tolerancePaise: bigint = DEFAULT_OCR_TOLERANCE_PAISE,
): string[] {
  const out: string[] = [];
  const net = extraction.netPremium.value;
  const gst = extraction.gstAmount.value;
  const total = extraction.totalPremium.value;
  const rate = extraction.gstRatePercent.value;

  const within = (a: bigint, b: bigint) => (a > b ? a - b : b - a) <= tolerancePaise;

  if (net !== null && gst !== null && total !== null) {
    if (!within(toPaise(net) + toPaise(gst), toPaise(total))) {
      out.push(
        `Net (₹${net}) + GST (₹${gst}) = ₹${fmt(toPaise(net) + toPaise(gst))} does not match the stated total (₹${total}).`,
      );
    }
  }
  if (net !== null && rate !== null && gst !== null) {
    const expected =
      (toPaise(net) * BigInt(Math.round(Number(rate) * 10_000)) + 500_000n) / 1_000_000n;
    if (!within(expected, toPaise(gst))) {
      out.push(
        `GST at ${rate}% on ₹${net} works out to about ₹${fmt(expected)}, but the quote states ₹${gst}.`,
      );
    }
  }
  // Section premiums vs the stated net (when enough sections were read).
  const sectionPaise = extraction.sections.reduce((sum, section) => {
    const premium = section.premium.value;
    return premium !== null ? sum + toPaise(premium) : sum;
  }, 0n);
  if (net !== null && sectionPaise > 0n && !within(sectionPaise, toPaise(net))) {
    out.push(
      `The section premiums add up to ₹${fmt(sectionPaise)}, which does not match the stated net premium (₹${net}).`,
    );
  }
  return out;
}

function fmt(paise: bigint): string {
  return `${paise / 100n}.${(paise % 100n).toString().padStart(2, '0')}`;
}

/** True once every value that will be saved has been confirmed or corrected by staff. */
export function allConfirmed(fields: readonly OcrField[]): boolean {
  return fields.every(
    (f) => f.state === 'CONFIRMED' || f.state === 'CORRECTED' || f.state === 'MISSING',
  );
}
