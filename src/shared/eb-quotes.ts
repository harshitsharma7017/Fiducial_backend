import { z } from 'zod';
import { IsoDateTimeSchema, ObjectIdSchema, blankAsNull } from './common.ts';
import { EbProductSchema } from './eb-products.ts';
import {
  GPA_COVERS,
  GPA_COVER_LABELS,
  PositiveRupeesSchema,
  type GpaCover,
  type GpaRequirementsInput,
  type GtliRequirementsInput,
} from './eb-requirements.ts';
import { formatIndianNumber } from './format.ts';
import { GhiAmountSchema } from './ghi.ts';
import { GhiDeviationSchema, MAX_GHI_QUOTE_FILES, type GhiComparison } from './ghi-workflow.ts';

// GPA and GTLI quotes (Requirement 7): the insurer's base premium (GST and total are worked out
// by the API), the rate as stated (kept, used in no calculation), the terms offered by product,
// and the comparison with the case's Data Sheet. Cover limits are shown as given until open
// question 10 is answered.

const OptionalText = (max: number) => blankAsNull(z.string().trim().max(max, 'This is too long'));
const uniqueIds = (ids: readonly string[]) => new Set(ids).size === ids.length;

export const COVER_OFFERS = ['OFFERED', 'NOT_OFFERED', 'NOT_STATED'] as const;
export type CoverOffer = (typeof COVER_OFFERS)[number];
export const COVER_OFFER_LABELS: Record<CoverOffer, string> = {
  OFFERED: 'Offered',
  NOT_OFFERED: 'Not offered',
  NOT_STATED: 'Not stated',
};

const CoverTermSchema = z.strictObject({
  offer: z.enum(COVER_OFFERS),
  /** The limit offered as an amount in rupees, or as text (for example "as per the PPD table"). */
  limitAmount: PositiveRupeesSchema.nullable(),
  limitText: OptionalText(500),
});

export const GpaQuoteTermsSchema = z.strictObject({
  covers: z.strictObject(
    Object.fromEntries(GPA_COVERS.map((cover) => [cover, CoverTermSchema])) as Record<
      GpaCover,
      typeof CoverTermSchema
    >,
  ),
});
export type GpaQuoteTerms = z.infer<typeof GpaQuoteTermsSchema>;

export const GtliQuoteTermsSchema = z.strictObject({
  /** The free cover limit offered; null is "Not stated". */
  freeCoverLimit: PositiveRupeesSchema.nullable(),
  additionalBenefits: OptionalText(2000),
});
export type GtliQuoteTerms = z.infer<typeof GtliQuoteTermsSchema>;

export type EbQuoteTerms = GpaQuoteTerms | GtliQuoteTerms;

export function emptyGpaQuoteTerms(): GpaQuoteTerms {
  const notStated = () => ({ offer: 'NOT_STATED' as const, limitAmount: null, limitText: null });
  return {
    covers: {
      accidentalDeath: notStated(),
      permanentTotal: notStated(),
      permanentPartial: notStated(),
      temporaryTotal: notStated(),
    },
  };
}

export function emptyGtliQuoteTerms(): GtliQuoteTerms {
  return { freeCoverLimit: null, additionalBenefits: null };
}

function quoteBody<T extends z.ZodType>(terms: T) {
  return z.strictObject({
    /** Before GST; blank only on a draft. */
    basePremium: blankAsNull(GhiAmountSchema),
    /** The rate as the insurer states it; kept as text and used in no calculation (7.1). */
    statedRate: OptionalText(100),
    terms,
    otherTerms: OptionalText(4000),
    validUntil: blankAsNull(z.iso.date({ error: 'Enter a date' })),
    /** Why the quote was revised; needed when the insurer already has a recorded quote. */
    reason: OptionalText(500),
    /** The insurer's mail or PDF, uploaded to the case as QUOTE files. */
    attachmentIds: z
      .array(ObjectIdSchema)
      .max(MAX_GHI_QUOTE_FILES, `Attach at most ${MAX_GHI_QUOTE_FILES} files`)
      .refine(uniqueIds, 'Each file once'),
    /** false keeps it a draft; true records it (it can then only be revised). */
    finalize: z.boolean(),
  });
}

export const UpdateGpaQuoteRequestSchema = quoteBody(GpaQuoteTermsSchema);
export const CreateGpaQuoteRequestSchema = UpdateGpaQuoteRequestSchema.extend({
  insurerId: ObjectIdSchema,
});
export const UpdateGtliQuoteRequestSchema = quoteBody(GtliQuoteTermsSchema);
export const CreateGtliQuoteRequestSchema = UpdateGtliQuoteRequestSchema.extend({
  insurerId: ObjectIdSchema,
});
export type UpdateGpaQuoteRequest = z.infer<typeof UpdateGpaQuoteRequestSchema>;
export type UpdateGtliQuoteRequest = z.infer<typeof UpdateGtliQuoteRequestSchema>;
export type UpdateEbQuoteRequest = UpdateGpaQuoteRequest | UpdateGtliQuoteRequest;
export type CreateEbQuoteRequest = UpdateEbQuoteRequest & { insurerId: string };
export type GpaQuoteFormValues = z.input<typeof UpdateGpaQuoteRequestSchema>;
export type GtliQuoteFormValues = z.input<typeof UpdateGtliQuoteRequestSchema>;

export const EbDeviationSchema = GhiDeviationSchema;
export type EbDeviation = z.infer<typeof EbDeviationSchema>;

const rupees = (value: string) => `₹${formatIndianNumber(value, 0)}`;

function coverOfferedText(term: GpaQuoteTerms['covers'][GpaCover]): string {
  if (term.offer !== 'OFFERED') return COVER_OFFER_LABELS[term.offer];
  const limit = [term.limitAmount ? rupees(term.limitAmount) : null, term.limitText]
    .filter(Boolean)
    .join(', ');
  return limit ? `Offered (${limit})` : 'Offered';
}

export interface EbComparedRow {
  key: string;
  label: string;
  requested: string;
  offered: string;
  kind: GhiComparison;
}

/** The GPA covers asked for against those offered: one row per cover. */
export function compareGpaTerms(
  sheet: GpaRequirementsInput,
  terms: GpaQuoteTerms,
): EbComparedRow[] {
  return GPA_COVERS.map((cover) => {
    const asked = sheet.covers[cover];
    const term = terms.covers[cover];
    const kind: GhiComparison =
      asked !== 'REQUIRED'
        ? 'NOT_ASKED'
        : term.offer === 'NOT_OFFERED'
          ? 'DEVIATION'
          : term.offer === 'NOT_STATED'
            ? 'MISSING'
            : 'MATCH';
    return {
      key: `covers.${cover}`,
      label: GPA_COVER_LABELS[cover],
      requested: asked === null ? 'Not stated' : asked === 'REQUIRED' ? 'Required' : 'Not required',
      offered: coverOfferedText(term),
      kind,
    };
  });
}

/** The GTLI free cover limit and benefits asked for against those offered. */
export function compareGtliTerms(
  sheet: GtliRequirementsInput,
  terms: GtliQuoteTerms,
): EbComparedRow[] {
  const asked = sheet.freeCoverLimit;
  const offered = terms.freeCoverLimit;
  const kind: GhiComparison =
    asked === null
      ? 'NOT_ASKED'
      : offered === null
        ? 'MISSING'
        : BigInt(offered) < BigInt(asked)
          ? 'DEVIATION'
          : BigInt(offered) > BigInt(asked)
            ? 'BETTER'
            : 'MATCH';
  return [
    {
      key: 'freeCoverLimit',
      label: 'Free cover limit',
      requested: asked === null ? 'Not asked' : rupees(asked),
      offered: offered === null ? 'Not stated' : rupees(offered),
      kind,
    },
    {
      key: 'additionalBenefits',
      label: 'Additional benefits',
      requested: sheet.additionalBenefits ?? 'Not asked',
      offered: terms.additionalBenefits ?? 'Not stated',
      kind: 'NOT_ASKED',
    },
  ];
}

function deviationsOfRows(rows: readonly EbComparedRow[]): EbDeviation[] {
  return rows.flatMap((row) =>
    row.kind === 'DEVIATION' || row.kind === 'MISSING'
      ? [
          {
            field: row.key,
            label: row.label,
            requested: row.requested,
            offered: row.offered === 'Not stated' ? null : row.offered,
            kind: row.kind,
          },
        ]
      : [],
  );
}

/**
 * GPA gaps (7.4): a Required cover Not offered is a deviation; Required and Not stated is
 * missing. Not required covers and the limits offered give neither (open question 10).
 */
export function gpaDeviations(sheet: GpaRequirementsInput, terms: GpaQuoteTerms): EbDeviation[] {
  return deviationsOfRows(compareGpaTerms(sheet, terms));
}

/** GTLI gaps (7.4): a free cover limit offered below the one asked is a deviation; none stated is missing. */
export function gtliDeviations(sheet: GtliRequirementsInput, terms: GtliQuoteTerms): EbDeviation[] {
  return deviationsOfRows(compareGtliTerms(sheet, terms));
}

export const EbQuoteSchema = z.object({
  id: ObjectIdSchema,
  product: EbProductSchema,
  insurerId: ObjectIdSchema,
  insurerName: z.string(),
  version: z.number().int(),
  /** DRAFT can change; FINAL is a recorded quote, revised only by a new version. */
  status: z.enum(['DRAFT', 'FINAL']),
  reason: z.string().nullable(),
  basePremium: z.string().nullable(),
  statedRate: z.string().nullable(),
  gstRatePercent: z.string(),
  gst: z.string().nullable(),
  totalPremium: z.string().nullable(),
  terms: z.union([GpaQuoteTermsSchema, GtliQuoteTermsSchema]),
  otherTerms: z.string().nullable(),
  validUntil: z.iso.date().nullable(),
  attachments: z.array(z.object({ id: ObjectIdSchema, fileName: z.string() })),
  deviations: z.array(EbDeviationSchema),
  /** The insurer's highest recorded version: the one the QCR compares. */
  latest: z.boolean(),
  createdAt: IsoDateTimeSchema,
  createdBy: z.string(),
  finalizedAt: IsoDateTimeSchema.nullable(),
  finalizedBy: z.string().nullable(),
});
export type EbQuote = z.infer<typeof EbQuoteSchema>;
export const EbQuoteListResponseSchema = z.object({ items: z.array(EbQuoteSchema) });
export type EbQuoteListResponse = z.infer<typeof EbQuoteListResponseSchema>;
