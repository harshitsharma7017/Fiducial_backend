import { z } from 'zod';
import { SECTION_CODES, type SectionCode } from './catalog.ts';
import { IsoDateTimeSchema, ObjectIdSchema, blankAsNull } from './common.ts';
import { formatDate, formatIndianNumber } from './format.ts';
import { InsurerStatusSchema, type ProposalRecord } from './proposals.ts';

// Insurers' quotes (Q-1 to Q-5): for each insurer and each quote option of the RFQ, the premium of
// every section asked for (Fire with and without terrorism), the insurer's terms, and the
// insurer's mail or PDF as proof. A revised quote is a new version with its reason; the QCR uses
// the latest version of each insurer that has not declined. Premiums are rupees with paise at
// most; net, GST and total are worked out exactly, here, for both the API and the screen.

/** The quote options, as the RFQ's premium details asks for them. */
export const QUOTE_OPTIONS = ['EXISTING', 'P1', 'P2'] as const;
export const QuoteOptionSchema = z.enum(QUOTE_OPTIONS);
export type QuoteOption = z.infer<typeof QuoteOptionSchema>;
export const QUOTE_OPTION_LABELS: Record<QuoteOption, string> = {
  EXISTING: 'Existing sum insured',
  P1: 'Proposed Option 1',
  P2: 'Proposed Option 2',
};

/** Files accepted as the insurer's proof: its mail (.eml, .msg), a PDF, or a picture of it. */
export const QUOTE_ATTACHMENT_TYPES = {
  'application/pdf': '.pdf',
  'message/rfc822': '.eml',
  'application/vnd.ms-outlook': '.msg',
  'image/png': '.png',
  'image/jpeg': '.jpg',
} as const;
export type QuoteAttachmentType = keyof typeof QUOTE_ATTACHMENT_TYPES;
export const MAX_QUOTE_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_QUOTE_ATTACHMENTS = 10;

const PREMIUM = /^\d{1,13}(\.\d{1,2})?$/;
const PremiumSchema = blankAsNull(
  z.string().trim().regex(PREMIUM, 'Enter rupees, with paise at most (for example 125000.50)'),
);
const OptionalRupees = blankAsNull(
  z
    .string()
    .trim()
    .regex(/^\d{1,13}$/, 'Enter whole rupees, digits only'),
);
const OptionalText = (max: number) => blankAsNull(z.string().trim().max(max, 'This is too long'));

export const QuoteSectionInputSchema = z.strictObject({
  code: z.enum(SECTION_CODES),
  /** The sum insured the insurer quoted on; blank: as the RFQ asked. */
  sumInsured: OptionalRupees,
  /** Blank: the insurer did not quote the section. Fire: with terrorism. */
  premium: PremiumSchema,
  /** Fire only: the premium without terrorism. */
  premiumWithoutTerrorism: PremiumSchema.default(null),
});

/** An add-on or cover the RFQ asked for, and whether the insurer accepted it. */
export const QuoteTermInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(400),
  accepted: z.boolean(),
});

export const RecordQuoteRequestSchema = z
  .strictObject({
    option: QuoteOptionSchema,
    /** Why the quote was revised; needed from the second version on. */
    reason: OptionalText(500).default(null),
    sections: z.array(QuoteSectionInputSchema).min(1).max(SECTION_CODES.length),
    terms: z.array(QuoteTermInputSchema).max(500).default([]),
    deductibles: OptionalText(2000).default(null),
    /** The share of the risk the insurer takes, in %. */
    capacityPercent: blankAsNull(
      z
        .string()
        .trim()
        .regex(/^\d{1,3}(\.\d{1,2})?$/, 'Enter a percentage, for example 100 or 62.5')
        .refine((value) => Number(value) > 0 && Number(value) <= 100, 'Enter 0.01 to 100'),
    ).default(null),
    conditions: OptionalText(4000).default(null),
    validUntil: blankAsNull(z.iso.date({ error: 'Enter a date' })).default(null),
    /** The insurer's mail or PDF (Q-3): files uploaded for this insurer on this case. */
    attachmentIds: z
      .array(ObjectIdSchema)
      .min(1, 'Attach the insurer’s email or PDF')
      .max(MAX_QUOTE_ATTACHMENTS),
  })
  .superRefine((quote, context) => {
    const codes = quote.sections.map((section) => section.code);
    if (new Set(codes).size !== codes.length) {
      context.addIssue({ code: 'custom', path: ['sections'], message: 'Each section once' });
    }
    quote.sections.forEach((section, index) => {
      if (section.code !== 'FIRE' && section.premiumWithoutTerrorism !== null) {
        context.addIssue({
          code: 'custom',
          path: ['sections', index, 'premiumWithoutTerrorism'],
          message: 'Only Fire has a premium without terrorism',
        });
      }
    });
    if (!quote.sections.some((section) => section.premium !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['sections'],
        message: 'Enter the premium of at least one section',
      });
    }
  });
export type RecordQuoteRequest = z.infer<typeof RecordQuoteRequestSchema>;
export type RecordQuoteFormValues = z.input<typeof RecordQuoteRequestSchema>;

export const QuoteAttachmentSchema = z.object({
  id: ObjectIdSchema,
  insurerId: ObjectIdSchema,
  fileName: z.string(),
  contentType: z.string(),
  size: z.number().int(),
  uploadedAt: IsoDateTimeSchema,
  uploadedBy: z.string(),
});
export type QuoteAttachment = z.infer<typeof QuoteAttachmentSchema>;

const TotalsSchema = z.object({ net: z.string(), gst: z.string(), total: z.string() });
export type QuoteTotals = z.infer<typeof TotalsSchema>;

export const QuoteVersionSchema = z.object({
  id: ObjectIdSchema,
  insurerId: ObjectIdSchema,
  option: QuoteOptionSchema,
  version: z.number().int().min(1),
  reason: z.string().nullable(),
  sections: z.array(
    z.object({
      code: z.enum(SECTION_CODES),
      sumInsured: z.string().nullable(),
      premium: z.string().nullable(),
      premiumWithoutTerrorism: z.string().nullable(),
    }),
  ),
  terms: z.array(z.object({ name: z.string(), accepted: z.boolean() })),
  deductibles: z.string().nullable(),
  capacityPercent: z.string().nullable(),
  conditions: z.string().nullable(),
  validUntil: z.iso.date().nullable(),
  attachments: z.array(QuoteAttachmentSchema),
  /** The case's GST rate, as used for the totals. */
  gstRatePercent: z.string(),
  /** With terrorism; and without, when Fire was quoted without terrorism too. */
  totals: z.object({ withTerrorism: TotalsSchema, withoutTerrorism: TotalsSchema.nullable() }),
  /** Where the quote departs from the RFQ (Q-2). */
  deviations: z.array(z.string()),
  createdAt: IsoDateTimeSchema,
  createdBy: z.string(),
});
export type QuoteVersion = z.infer<typeof QuoteVersionSchema>;

export const ProposalQuotesSchema = z.object({
  gstRatePercent: z.string(),
  /** The options insurers quote on for this case, in the RFQ's order. */
  options: z.array(QuoteOptionSchema),
  insurers: z.array(
    z.object({
      insurerId: ObjectIdSchema,
      company: z.string(),
      branch: z.string(),
      status: InsurerStatusSchema,
      /** Declined with its reason (Q-5); such an insurer is left out of the QCR. */
      declined: z
        .object({ reason: z.string().nullable(), at: IsoDateTimeSchema, by: z.string() })
        .nullable(),
      /** Per option, every version, newest first. */
      quotes: z.array(
        z.object({ option: QuoteOptionSchema, versions: z.array(QuoteVersionSchema) }),
      ),
    }),
  ),
  attachments: z.array(QuoteAttachmentSchema),
  /** What the QCR compares: each option's latest version of every insurer that has not declined. */
  qcr: z.array(
    z.object({
      insurerId: ObjectIdSchema,
      company: z.string(),
      branch: z.string(),
      option: QuoteOptionSchema,
      quoteId: ObjectIdSchema,
      version: z.number().int(),
    }),
  ),
});
export type ProposalQuotes = z.infer<typeof ProposalQuotesSchema>;

export const QuoteAttachmentUploadQuerySchema = z.strictObject({
  fileName: z.string().trim().min(1, 'Name the file').max(200, 'File name is too long'),
});
export const QuoteAttachmentParamsSchema = z.strictObject({
  id: ObjectIdSchema,
  attachmentId: ObjectIdSchema,
});

// Pure helpers used by both repos

type RecordForQuotes = Pick<
  ProposalRecord,
  'type' | 'fire' | 'sections' | 'addons' | 'policyStart'
>;

/** The options of a case: a renewal also quotes the existing sum insured; Option 2 only if asked. */
export function quoteOptionsOf(
  record: Pick<RecordForQuotes, 'type' | 'fire' | 'sections'>,
): QuoteOption[] {
  const option2 =
    record.fire.proposed2 !== null ||
    record.sections.some((s) => s.included && s.proposed2 !== null);
  return [
    ...(record.type === 'EXISTING' ? (['EXISTING'] as const) : []),
    'P1' as const,
    ...(option2 ? (['P2'] as const) : []),
  ];
}

export interface QuoteExpectation {
  sections: { code: SectionCode; name: string; sumInsured: string | null }[];
  /** The add-ons and covers the RFQ asked for, as the quote's terms name them. */
  asked: string[];
}

/** What the RFQ asked insurers to quote for an option: the sections and their sums insured. */
export function quoteExpectation(record: RecordForQuotes, option: QuoteOption): QuoteExpectation {
  const pick = (values: {
    existing: string | null;
    proposed1: string | null;
    proposed2: string | null;
  }) =>
    option === 'EXISTING'
      ? values.existing
      : option === 'P1'
        ? values.proposed1
        : (values.proposed2 ?? values.proposed1);
  const fire = { code: 'FIRE' as const, name: 'Fire', sumInsured: pick(record.fire) };
  const sections = record.sections
    .filter((section) => section.included)
    .map((section) => ({ code: section.code, name: section.name, sumInsured: pick(section) }));
  const asked = [
    ...record.addons.map((addon) => addon.name),
    ...record.fire.covers.filter((c) => c.required).map((c) => `Fire: ${c.name}`),
    ...record.sections
      .filter((section) => section.included)
      .flatMap((section) =>
        section.covers.filter((c) => c.required).map((c) => `${section.name}: ${c.name}`),
      ),
  ];
  return { sections: [fire, ...sections], asked };
}

const toPaise = (value: string) => {
  const [rupees = '0', paise = ''] = value.split('.');
  return BigInt(rupees) * 100n + BigInt(paise.padEnd(2, '0').slice(0, 2));
};
const fromPaise = (paise: bigint) =>
  `${paise / 100n}.${(paise % 100n).toString().padStart(2, '0')}`;

/** GST on a net premium in paise, rounded half up to the paisa. The rate has 4 decimals at most. */
function gstPaise(net: bigint, ratePercent: string): bigint {
  const [whole = '0', fraction = ''] = ratePercent.split('.');
  const rate = BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, '0').slice(0, 4));
  // net × rate / (100 × 10 000), half up.
  return (net * rate + 500_000n) / 1_000_000n;
}

function totalsOf(premiums: readonly string[], ratePercent: string): QuoteTotals {
  const net = premiums.reduce((sum, value) => sum + toPaise(value), 0n);
  const gst = gstPaise(net, ratePercent);
  return { net: fromPaise(net), gst: fromPaise(gst), total: fromPaise(net + gst) };
}

/**
 * Net, GST and total (Q-1): every section's premium, Fire with terrorism; and again with Fire
 * without terrorism when that was quoted.
 */
export function quoteTotals(
  sections: readonly {
    code: string;
    premium: string | null;
    premiumWithoutTerrorism?: string | null;
  }[],
  gstRatePercent: string,
): { withTerrorism: QuoteTotals; withoutTerrorism: QuoteTotals | null } {
  const valid = (value: string | null | undefined): value is string =>
    typeof value === 'string' && PREMIUM.test(value.trim());
  const others = sections
    .filter((section) => section.code !== 'FIRE')
    .flatMap((section) => (valid(section.premium) ? [section.premium.trim()] : []));
  const fire = sections.find((section) => section.code === 'FIRE');
  const withFire = valid(fire?.premium) ? [fire.premium.trim()] : [];
  const without = fire?.premiumWithoutTerrorism;
  return {
    withTerrorism: totalsOf([...withFire, ...others], gstRatePercent),
    withoutTerrorism: valid(without) ? totalsOf([without.trim(), ...others], gstRatePercent) : null,
  };
}

const rupees = (value: string) => `₹${formatIndianNumber(value, 0)}`;

/** Where a quote departs from what the RFQ asked (Q-2), in words. */
export function quoteDeviations(
  expectation: QuoteExpectation,
  quote: {
    sections: readonly { code: string; sumInsured: string | null; premium: string | null }[];
    terms: readonly { name: string; accepted: boolean }[];
    capacityPercent: string | null;
    validUntil: string | null;
  },
  policyStart: string | null,
): string[] {
  const deviations: string[] = [];
  for (const asked of expectation.sections) {
    const quoted = quote.sections.find((section) => section.code === asked.code);
    if (!quoted?.premium) {
      deviations.push(`${asked.name}: not quoted`);
      continue;
    }
    if (
      quoted.sumInsured !== null &&
      asked.sumInsured !== null &&
      BigInt(quoted.sumInsured) !== toPaise(asked.sumInsured) / 100n
    ) {
      deviations.push(
        `${asked.name}: quoted on ${rupees(quoted.sumInsured)}, the RFQ asked ${rupees(asked.sumInsured)}`,
      );
    }
  }
  const answers = new Map(quote.terms.map((term) => [term.name.toLowerCase(), term.accepted]));
  for (const name of expectation.asked) {
    const accepted = answers.get(name.toLowerCase());
    if (accepted === undefined) deviations.push(`Not answered: ${name}`);
    else if (!accepted) deviations.push(`Declined: ${name}`);
  }
  if (quote.capacityPercent !== null && Number(quote.capacityPercent) < 100) {
    deviations.push(`Capacity ${quote.capacityPercent}%: not the whole risk`);
  }
  if (quote.validUntil && policyStart && quote.validUntil < policyStart) {
    deviations.push(
      `Valid until ${formatDate(quote.validUntil)}, before the policy starts on ${formatDate(policyStart)}`,
    );
  }
  return deviations;
}
