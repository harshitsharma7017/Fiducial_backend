import { z } from 'zod';
import { EmailSchema } from './auth.ts';
import { IsoDateTimeSchema, ObjectIdSchema, blankAsNull } from './common.ts';
import { DOCUMENT_FORMATS } from './documents.ts';
import {
  GHI_ROOM_RENT_KINDS,
  GHI_WAIVERS,
  GhiAmountSchema,
  GhiCaseRecordSchema,
  GhiCoverageTypeSchema,
  GhiPercentSchema,
  GhiRupeesSchema,
  MAX_GHI_INSURERS,
  type GhiWaiver,
} from './ghi.ts';
import { GhiCensusSummarySchema } from './ghi-census.ts';
import { MAIL_RESULTS } from './mail.ts';

// The GHI workflow after the census: the RFQ (G5), insurers' quotes and the QCR (G6), then the
// final QCR, payment, placement slip and policy (G7). Premiums are rupees with paise as decimal
// strings; GST and totals are always worked out by the API.

const OptionalText = (max: number) => blankAsNull(z.string().trim().max(max, 'This is too long'));
const SendIdSchema = z.uuid({ error: 'Send id must be a UUID' });
const FormatSchema = z.enum(DOCUMENT_FORMATS);
const uniqueIds = (ids: readonly string[]) => new Set(ids).size === ids.length;

// RFQ (G5)

export const GHI_RFQ_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'RETURNED'] as const;
export type GhiRfqStatus = (typeof GHI_RFQ_STATUSES)[number];
export const GHI_RFQ_STATUS_LABELS: Record<GhiRfqStatus, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Awaiting approval',
  APPROVED: 'Approved',
  RETURNED: 'Returned',
};

const DecisionSchema = z.object({
  at: IsoDateTimeSchema,
  by: z.string(),
  comment: z.string().nullable(),
});

export const GhiRfqVersionSchema = z.object({
  id: ObjectIdSchema,
  version: z.number().int(),
  status: z.enum(GHI_RFQ_STATUSES),
  /** The Data Sheet or census changed after this version was generated. */
  stale: z.boolean(),
  generatedAt: IsoDateTimeSchema,
  generatedBy: z.string(),
  submitted: z.object({ at: IsoDateTimeSchema, by: z.string() }).nullable(),
  decision: DecisionSchema.extend({ status: z.enum(['APPROVED', 'RETURNED']) }).nullable(),
  census: z.object({
    employees: z.number().int(),
    lives: z.number().int(),
    totalSumInsured: z.string().nullable(),
  }),
});
export type GhiRfqVersion = z.infer<typeof GhiRfqVersionSchema>;

export const GhiDispatchSchema = z.object({
  id: ObjectIdSchema,
  kind: z.enum(['RFQ', 'QCR']),
  insurerId: ObjectIdSchema.nullable(),
  recipient: z.string(),
  to: z.array(z.string()),
  subject: z.string(),
  attachment: z.string().nullable(),
  at: IsoDateTimeSchema,
  by: z.string(),
  result: z.enum(MAIL_RESULTS),
  error: z.string().nullable(),
});
export type GhiDispatch = z.infer<typeof GhiDispatchSchema>;

export const GhiRfqStateSchema = z.object({
  versions: z.array(GhiRfqVersionSchema),
  /** The latest version; only it can be approved and sent. */
  current: GhiRfqVersionSchema.nullable(),
  /** What the case needs before an RFQ can be generated; empty when ready. */
  missing: z.array(z.string()),
  /** Mail is turned off on the server: the RFQ can only be marked as sent outside the app. */
  mailEnabled: z.boolean(),
  dispatches: z.array(GhiDispatchSchema),
});
export type GhiRfqState = z.infer<typeof GhiRfqStateSchema>;

/** A document as the screen previews it: the sheets of the generated workbook as text rows. */
export const GhiDocumentPreviewSchema = z.object({
  title: z.string(),
  sheets: z.array(
    z.object({
      name: z.string(),
      rows: z.array(z.array(z.string())),
      /** Rows left out of the preview (the full list is in the download). */
      truncated: z.number().int(),
    }),
  ),
});
export type GhiDocumentPreview = z.infer<typeof GhiDocumentPreviewSchema>;

export const GhiDecisionRequestSchema = z
  .strictObject({
    decision: z.enum(['APPROVED', 'RETURNED']),
    comment: OptionalText(1000),
  })
  .refine((body) => body.decision !== 'RETURNED' || body.comment !== null, {
    path: ['comment'],
    message: 'Say what needs to change',
  });
export type GhiDecisionRequest = z.infer<typeof GhiDecisionRequestSchema>;

export const GhiDocumentQuerySchema = z.strictObject({ format: FormatSchema.default('xlsx') });
/** An RFQ file as generated: the latest version unless one is named. */
export const GhiRfqDocumentQuerySchema = z.strictObject({
  format: FormatSchema.default('xlsx'),
  versionId: ObjectIdSchema.optional(),
});

export const SetGhiInsurersRequestSchema = z.strictObject({
  insurerIds: z
    .array(ObjectIdSchema)
    .max(MAX_GHI_INSURERS, `Choose at most ${MAX_GHI_INSURERS} insurers`)
    .refine(uniqueIds, 'Each insurer can be chosen once'),
});
export type SetGhiInsurersRequest = z.infer<typeof SetGhiInsurersRequestSchema>;

export const DispatchGhiRfqRequestSchema = z.strictObject({
  /** Made by the web app for each send; a repeated request mails nobody twice. */
  sendId: SendIdSchema,
  insurerIds: z
    .array(ObjectIdSchema)
    .min(1, 'Choose the insurers to send the RFQ to')
    .max(MAX_GHI_INSURERS)
    .refine(uniqueIds, 'Each insurer once'),
  dueDate: z.iso.date({ error: 'Enter the date quotes are needed by' }),
  format: FormatSchema.default('xlsx'),
});
export type DispatchGhiRfqRequest = z.infer<typeof DispatchGhiRfqRequestSchema>;

export const GhiSendOutcomeSchema = z.object({
  insurerId: ObjectIdSchema.nullable(),
  recipient: z.string(),
  /** SENT only when the mail server (or the development outbox) accepted the mail. */
  outcome: z.enum(['SENT', 'FAILED']),
  result: z.enum(MAIL_RESULTS),
  reason: z.string().nullable(),
});
export type GhiSendOutcome = z.infer<typeof GhiSendOutcomeSchema>;

export const DispatchGhiRfqResponseSchema = z.object({
  results: z.array(GhiSendOutcomeSchema),
  case: GhiCaseRecordSchema,
});
export type DispatchGhiRfqResponse = z.infer<typeof DispatchGhiRfqResponseSchema>;

/** The RFQ went to these insurers another way (mail off, or the insurer's portal). */
export const MarkGhiRfqSentRequestSchema = z.strictObject({
  insurerIds: z
    .array(ObjectIdSchema)
    .min(1, 'Choose the insurers the RFQ was sent to')
    .max(MAX_GHI_INSURERS)
    .refine(uniqueIds, 'Each insurer once'),
  dueDate: z.iso.date({ error: 'Enter the date quotes are needed by' }),
});
export type MarkGhiRfqSentRequest = z.infer<typeof MarkGhiRfqSentRequestSchema>;

export const DeclineGhiInsurerRequestSchema = z.strictObject({
  reason: z.string().trim().min(1, 'Give the insurer’s reason').max(500, 'This is too long'),
});

export const GhiInsurerParamsSchema = z.strictObject({
  id: ObjectIdSchema,
  insurerId: ObjectIdSchema,
});

// Quotes (G6)

/** An insurer's terms as quoted, compared with the Data Sheet. Null is "not stated". */
export const GhiQuoteTermsInputSchema = z.strictObject({
  coverageType: GhiCoverageTypeSchema.nullable(),
  roomRent: z.strictObject({
    kind: z.enum(GHI_ROOM_RENT_KINDS).nullable(),
    normal: blankAsNull(GhiAmountSchema),
    icu: blankAsNull(GhiAmountSchema),
  }),
  maternity: z.strictObject({
    covered: z.boolean().nullable(),
    normalLimit: blankAsNull(GhiRupeesSchema),
    cesareanLimit: blankAsNull(GhiRupeesSchema),
    newbornCovered: z.boolean().nullable(),
    nineMonthWaiver: z.boolean().nullable(),
  }),
  preExistingCovered: z.boolean().nullable(),
  parentsCoPayPercent: blankAsNull(GhiPercentSchema),
  waivers: z.strictObject(
    Object.fromEntries(GHI_WAIVERS.map((key) => [key, z.boolean().nullable()])) as Record<
      GhiWaiver,
      z.ZodNullable<z.ZodBoolean>
    >,
  ),
  /** Waiting periods the insurer applies (days for the initial period, months for the rest). */
  waitingPeriods: z.strictObject({
    initialDays: z.number().int().min(0).max(365).nullable(),
    specificDiseasesMonths: z.number().int().min(0).max(60).nullable(),
    preExistingMonths: z.number().int().min(0).max(60).nullable(),
    maternityMonths: z.number().int().min(0).max(60).nullable(),
  }),
  corporateBufferAmount: blankAsNull(GhiRupeesSchema),
});
export type GhiQuoteTermsInput = z.infer<typeof GhiQuoteTermsInputSchema>;

export function emptyGhiQuoteTerms(): GhiQuoteTermsInput {
  return {
    coverageType: null,
    roomRent: { kind: null, normal: null, icu: null },
    maternity: {
      covered: null,
      normalLimit: null,
      cesareanLimit: null,
      newbornCovered: null,
      nineMonthWaiver: null,
    },
    preExistingCovered: null,
    parentsCoPayPercent: null,
    waivers: {
      initialWaitingPeriod: null,
      firstYearExclusions: null,
      twoYearExclusions: null,
      preExistingWaitingPeriod: null,
    },
    waitingPeriods: {
      initialDays: null,
      specificDiseasesMonths: null,
      preExistingMonths: null,
      maternityMonths: null,
    },
    corporateBufferAmount: null,
  };
}

export const MAX_GHI_QUOTE_FILES = 10;

const QuoteBodySchema = z.strictObject({
  /** Before GST. Blank only on a draft. */
  basePremium: blankAsNull(GhiAmountSchema),
  terms: GhiQuoteTermsInputSchema,
  otherTerms: OptionalText(4000),
  validUntil: blankAsNull(z.iso.date({ error: 'Enter a date' })),
  /** Why the quote was revised; needed when the insurer already has a final quote. */
  reason: OptionalText(500),
  /** The insurer's mail or PDF, uploaded to the case as QUOTE files. */
  attachmentIds: z
    .array(ObjectIdSchema)
    .max(MAX_GHI_QUOTE_FILES)
    .refine(uniqueIds, 'Each file once'),
  /** false keeps it a draft that can still change; true records it (it can then only be revised). */
  finalize: z.boolean(),
});

export const CreateGhiQuoteRequestSchema = QuoteBodySchema.extend({ insurerId: ObjectIdSchema });
export type CreateGhiQuoteRequest = z.infer<typeof CreateGhiQuoteRequestSchema>;
export const UpdateGhiQuoteRequestSchema = QuoteBodySchema;
export type UpdateGhiQuoteRequest = z.infer<typeof UpdateGhiQuoteRequestSchema>;
export type GhiQuoteFormValues = z.input<typeof QuoteBodySchema>;

export const GhiQuoteParamsSchema = z.strictObject({ id: ObjectIdSchema, quoteId: ObjectIdSchema });

/** How an offered term compares with what the RFQ asked for. */
export const GHI_COMPARISONS = ['MATCH', 'DEVIATION', 'MISSING', 'BETTER', 'NOT_ASKED'] as const;
export type GhiComparison = (typeof GHI_COMPARISONS)[number];

export const GhiDeviationSchema = z.object({
  field: z.string(),
  label: z.string(),
  requested: z.string(),
  offered: z.string().nullable(),
  kind: z.enum(['DEVIATION', 'MISSING']),
});
export type GhiDeviation = z.infer<typeof GhiDeviationSchema>;

export const GhiQuoteSchema = z.object({
  id: ObjectIdSchema,
  insurerId: ObjectIdSchema,
  insurerName: z.string(),
  version: z.number().int(),
  status: z.enum(['DRAFT', 'FINAL']),
  /** QUOTE: the insurer's quote; FINAL_AGREED: the terms finally agreed (G7). */
  kind: z.enum(['QUOTE', 'FINAL_AGREED']),
  reason: z.string().nullable(),
  basePremium: z.string().nullable(),
  gstRatePercent: z.string(),
  gst: z.string().nullable(),
  totalPremium: z.string().nullable(),
  terms: GhiQuoteTermsInputSchema,
  otherTerms: z.string().nullable(),
  validUntil: z.iso.date().nullable(),
  attachments: z.array(z.object({ id: ObjectIdSchema, fileName: z.string() })),
  deviations: z.array(GhiDeviationSchema),
  /** The insurer's latest final quote: the one a new QCR takes. */
  latest: z.boolean(),
  createdAt: IsoDateTimeSchema,
  createdBy: z.string(),
  finalizedAt: IsoDateTimeSchema.nullable(),
  finalizedBy: z.string().nullable(),
});
export type GhiQuote = z.infer<typeof GhiQuoteSchema>;

export const GhiQuoteListResponseSchema = z.object({ items: z.array(GhiQuoteSchema) });
export type GhiQuoteListResponse = z.infer<typeof GhiQuoteListResponseSchema>;

// QCR (G6)

export const GHI_QCR_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED'] as const;
export type GhiQcrStatus = (typeof GHI_QCR_STATUSES)[number];
export const GHI_QCR_STATUS_LABELS: Record<GhiQcrStatus, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Awaiting approval',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
};

export const SaveGhiQcrRequestSchema = z.strictObject({
  /** Final quotes of different insurers, at most five. */
  quoteIds: z
    .array(ObjectIdSchema)
    .min(1, 'Choose at least one quote')
    .max(MAX_GHI_INSURERS, `Compare at most ${MAX_GHI_INSURERS} insurers`)
    .refine(uniqueIds, 'Each quote once'),
  recommendedInsurerId: ObjectIdSchema.nullable(),
  remarks: OptionalText(2000),
});
export type SaveGhiQcrRequest = z.infer<typeof SaveGhiQcrRequestSchema>;

export const GhiQcrDecisionRequestSchema = z
  .strictObject({
    decision: z.enum(['APPROVED', 'REJECTED']),
    comment: OptionalText(1000),
  })
  .refine((body) => body.decision !== 'REJECTED' || body.comment !== null, {
    path: ['comment'],
    message: 'Say why the QCR is rejected',
  });
export type GhiQcrDecisionRequest = z.infer<typeof GhiQcrDecisionRequestSchema>;

export const SendGhiQcrRequestSchema = z.strictObject({
  sendId: SendIdSchema,
  /** The client's contacts' addresses only (client master). */
  to: z
    .array(EmailSchema)
    .min(1, 'Choose who receives the QCR')
    .max(10)
    .refine(uniqueIds, 'Each address once'),
  format: FormatSchema.default('pdf'),
});
export type SendGhiQcrRequest = z.infer<typeof SendGhiQcrRequestSchema>;

export const RecordGhiClientDecisionRequestSchema = z
  .strictObject({
    decision: z.enum(['ACCEPTED', 'REJECTED']),
    /** The insurer the client chose; needed when accepted. */
    insurerId: ObjectIdSchema.nullable(),
    decidedOn: z.iso.date({ error: 'Enter the date of the client’s decision' }),
    confirmedBy: z
      .string()
      .trim()
      .min(1, 'Enter who confirmed it at the client')
      .max(120, 'This is too long'),
    note: OptionalText(1000),
    /** The client's mail or letter, uploaded as CLIENT_DECISION files. */
    fileIds: z.array(ObjectIdSchema).max(10).refine(uniqueIds, 'Each file once'),
  })
  .refine((body) => body.decision !== 'ACCEPTED' || body.insurerId !== null, {
    path: ['insurerId'],
    message: 'Choose the insurer the client selected',
  })
  .refine((body) => body.decision !== 'REJECTED' || body.note !== null, {
    path: ['note'],
    message: 'Say why the client rejected the QCR',
  });
export type RecordGhiClientDecisionRequest = z.infer<typeof RecordGhiClientDecisionRequestSchema>;

export const GhiQcrParamsSchema = z.strictObject({ id: ObjectIdSchema, qcrId: ObjectIdSchema });

const ComparedValueSchema = z.object({ text: z.string(), kind: z.enum(GHI_COMPARISONS) });

export const GhiQcrSchema = z.object({
  id: ObjectIdSchema,
  version: z.number().int(),
  status: z.enum(GHI_QCR_STATUSES),
  /** The newest QCR version; older ones are kept as history. */
  latest: z.boolean(),
  columns: z.array(
    z.object({
      quoteId: ObjectIdSchema,
      insurerId: ObjectIdSchema,
      insurerName: z.string(),
      quoteVersion: z.number().int(),
      basePremium: z.string(),
      gst: z.string(),
      totalPremium: z.string(),
      lowest: z.boolean(),
      recommended: z.boolean(),
      deviations: z.number().int(),
      missing: z.number().int(),
    }),
  ),
  /** The side-by-side table: what the RFQ asked for and each insurer's offer, flagged. */
  rows: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      requested: z.string(),
      values: z.array(ComparedValueSchema),
    }),
  ),
  recommendedInsurerId: ObjectIdSchema.nullable(),
  remarks: z.string().nullable(),
  submitted: z.object({ at: IsoDateTimeSchema, by: z.string() }).nullable(),
  decision: DecisionSchema.extend({ status: z.enum(['APPROVED', 'REJECTED']) }).nullable(),
  sends: z.array(GhiDispatchSchema),
  clientDecision: z
    .object({
      decision: z.enum(['ACCEPTED', 'REJECTED']),
      insurerId: ObjectIdSchema.nullable(),
      insurerName: z.string().nullable(),
      quoteId: ObjectIdSchema.nullable(),
      decidedOn: z.iso.date(),
      confirmedBy: z.string(),
      note: z.string().nullable(),
      files: z.array(z.object({ id: ObjectIdSchema, fileName: z.string() })),
      recordedAt: IsoDateTimeSchema,
      recordedBy: z.string(),
    })
    .nullable(),
  createdAt: IsoDateTimeSchema,
  createdBy: z.string(),
});
export type GhiQcr = z.infer<typeof GhiQcrSchema>;

export const GhiQcrListResponseSchema = z.object({
  items: z.array(GhiQcrSchema),
  /** Mail is turned off on the server. */
  mailEnabled: z.boolean(),
});
export type GhiQcrListResponse = z.infer<typeof GhiQcrListResponseSchema>;

// Final QCR, payment, placement and policy (G7)

export const RecordGhiFinalQcrRequestSchema = z.strictObject({
  basePremium: GhiAmountSchema,
  terms: GhiQuoteTermsInputSchema,
  otherTerms: OptionalText(4000),
  /** What changed from the accepted quote, if anything. */
  note: OptionalText(1000),
  attachmentIds: z
    .array(ObjectIdSchema)
    .max(MAX_GHI_QUOTE_FILES)
    .refine(uniqueIds, 'Each file once'),
});
export type RecordGhiFinalQcrRequest = z.infer<typeof RecordGhiFinalQcrRequestSchema>;
export type GhiFinalQcrFormValues = z.input<typeof RecordGhiFinalQcrRequestSchema>;

export const GhiFinalQcrStateSchema = z.object({
  /** The QCR and quote the client accepted; null until the client accepts. */
  accepted: z
    .object({ qcrId: ObjectIdSchema, qcrVersion: z.number().int(), quote: GhiQuoteSchema })
    .nullable(),
  /** The final agreed terms in force; the earlier ones stay in history. */
  current: GhiQuoteSchema.nullable(),
  history: z.array(GhiQuoteSchema),
  note: z.string().nullable(),
});
export type GhiFinalQcrState = z.infer<typeof GhiFinalQcrStateSchema>;

export const GHI_PAYMENT_STATUSES = ['PENDING', 'RECEIVED', 'FAILED'] as const;
export type GhiPaymentStatus = (typeof GHI_PAYMENT_STATUSES)[number];
export const GHI_PAYMENT_STATUS_LABELS: Record<GhiPaymentStatus, string> = {
  PENDING: 'Pending',
  RECEIVED: 'Received',
  FAILED: 'Failed / bounced',
};
export const GHI_PAYMENT_MODES = ['CHEQUE', 'NEFT', 'RTGS', 'IMPS', 'UPI', 'DD', 'OTHER'] as const;
export type GhiPaymentMode = (typeof GHI_PAYMENT_MODES)[number];
export const GHI_PAYMENT_MODE_LABELS: Record<GhiPaymentMode, string> = {
  CHEQUE: 'Cheque',
  NEFT: 'NEFT',
  RTGS: 'RTGS',
  IMPS: 'IMPS',
  UPI: 'UPI',
  DD: 'Demand draft',
  OTHER: 'Other',
};

export const SaveGhiPaymentRequestSchema = z.strictObject({
  amount: GhiAmountSchema.refine((value) => Number(value) > 0, 'Enter an amount above 0'),
  paidOn: z.iso.date({ error: 'Enter the payment date' }),
  reference: z
    .string()
    .trim()
    .min(1, 'Enter the cheque or transaction reference')
    .max(100, 'This is too long'),
  mode: z.enum(GHI_PAYMENT_MODES),
  status: z.enum(GHI_PAYMENT_STATUSES),
  payer: OptionalText(200),
  note: OptionalText(1000),
  fileIds: z.array(ObjectIdSchema).max(10).refine(uniqueIds, 'Each file once'),
});
export type SaveGhiPaymentRequest = z.infer<typeof SaveGhiPaymentRequestSchema>;
export type GhiPaymentFormValues = z.input<typeof SaveGhiPaymentRequestSchema>;

export const GhiPaymentParamsSchema = z.strictObject({
  id: ObjectIdSchema,
  paymentId: ObjectIdSchema,
});

export const GhiPaymentSchema = z.object({
  id: ObjectIdSchema,
  amount: z.string(),
  paidOn: z.iso.date(),
  reference: z.string(),
  mode: z.enum(GHI_PAYMENT_MODES),
  status: z.enum(GHI_PAYMENT_STATUSES),
  payer: z.string().nullable(),
  note: z.string().nullable(),
  files: z.array(z.object({ id: ObjectIdSchema, fileName: z.string() })),
  recordedAt: IsoDateTimeSchema,
  recordedBy: z.string(),
  updatedAt: IsoDateTimeSchema,
  updatedBy: z.string(),
});
export type GhiPayment = z.infer<typeof GhiPaymentSchema>;

export const GhiPaymentsResponseSchema = z.object({
  /** The final agreed total premium; null until the final QCR is recorded. */
  expected: z.string().nullable(),
  received: z.string(),
  pending: z.string(),
  outstanding: z.string().nullable(),
  /** Received covers the expected premium: the placement slip can be issued. */
  settled: z.boolean(),
  items: z.array(GhiPaymentSchema),
});
export type GhiPaymentsResponse = z.infer<typeof GhiPaymentsResponseSchema>;

export const RecordGhiPolicyRequestSchema = z
  .strictObject({
    policyNumber: z.string().trim().min(1, 'Enter the policy number').max(100, 'This is too long'),
    issuedOn: z.iso.date({ error: 'Enter the date of issue' }),
    policyStart: z.iso.date({ error: 'Enter the start of the policy period' }),
    policyEnd: z.iso.date({ error: 'Enter the end of the policy period' }),
    renewalDate: z.iso.date({ error: 'Enter the renewal date' }),
    /** The policy copy, uploaded as a POLICY file. */
    fileId: ObjectIdSchema,
  })
  .refine((body) => body.policyEnd > body.policyStart, {
    path: ['policyEnd'],
    message: 'The policy period must end after it starts',
  })
  .refine((body) => body.renewalDate > body.policyStart, {
    path: ['renewalDate'],
    message: 'The renewal date must be after the policy starts',
  });
export type RecordGhiPolicyRequest = z.infer<typeof RecordGhiPolicyRequestSchema>;
export type GhiPolicyFormValues = z.input<typeof RecordGhiPolicyRequestSchema>;

/** What the placement slip is made of, and whether it can be issued yet. */
export const GhiPlacementStateSchema = z.object({
  ready: z.boolean(),
  missing: z.array(z.string()),
  insurerName: z.string().nullable(),
  finalQuote: GhiQuoteSchema.nullable(),
  summary: GhiCensusSummarySchema,
});
export type GhiPlacementState = z.infer<typeof GhiPlacementStateSchema>;
