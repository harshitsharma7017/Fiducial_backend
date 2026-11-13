import { QUOTE_OPTION_LABELS, formatIndianNumber, type Qcr } from '../../shared/index.ts';

const rupees = (value: string) => `Rs ${formatIndianNumber(value, 2)}/-`;
const NO_FIGURE = 'Rs —/-';

/**
 * The terrorism note's blanks ("additional premium of Rs ____/- for Option1 & Rs ____/- for
 * Option2") filled from the QCR (change request NOTE-1): each option's terrorism extra, taken from
 * the recommended (else the lowest, else any) quote that gave one. An option with no figure shows
 * "—", never a blank line; so does the RFQ, which has no quotes yet (pass no QCR). A note without
 * the blanks gets the sentence added when there is a figure. Any other text is returned as it is.
 */
export function fillTerrorismNote(text: string, qcr: Qcr | null): string {
  const hasBlanks = /If you opt for the same,/.test(text);
  const isTerrorismNote =
    /^\s*\*?\s*New \/ Renewal Quote is given as per recommended coverage/i.test(text);
  if (!hasBlanks && !isTerrorismNote) return text;
  const hasExtra = (quote: { terrorismExtra: string | null }) =>
    Boolean(quote.terrorismExtra) && Number(quote.terrorismExtra) > 0;
  const figures = (qcr?.options ?? []).map((option) => {
    const quote =
      option.quotes.find(
        (item) => item.insurerId === qcr?.recommendedInsurerId && hasExtra(item),
      ) ??
      option.quotes.find((item) => item.lowest && hasExtra(item)) ??
      option.quotes.find(hasExtra);
    return {
      label: QUOTE_OPTION_LABELS[option.option],
      value: quote?.terrorismExtra ? rupees(quote.terrorismExtra) : NO_FIGURE,
    };
  });
  const anyFigure = figures.some((item) => item.value !== NO_FIGURE);
  if (!hasBlanks) {
    // The template's wording has no "if you opt" sentence: add it only when there is a figure.
    return anyFigure
      ? `${text.trim()} If you opt for the same, additional premium of ${figures
          .map((item) => `${item.value} for ${item.label}`)
          .join(' & ')} (before GST) will be charged.`
      : text;
  }
  if (anyFigure) {
    return text.replace(
      /If you opt for the same,[\s\S]*$/,
      `If you opt for the same, additional premium of ${figures
        .map((item) => `${item.value} for ${item.label}`)
        .join(' & ')} (before GST) will be charged.`,
    );
  }
  // Nothing to fill in yet: the blanks of the printed text become dashes.
  return text.replace(/Rs\s*_{2,}\s*\/-/g, NO_FIGURE).replace(/_{2,}/g, '—');
}
