import { z } from 'zod';
import { EmailSchema } from './auth.ts';
import { IsoDateTimeSchema, ObjectIdSchema, blankAsNull } from './common.ts';
import { DOCUMENT_FORMATS } from './documents.ts';
import { compareDecimal, subtractMoneyFloor, sumMoney } from './eb-money.ts';
import { EbCaseRecordSchema } from './eb.ts';
import { EbPlanAssignmentSchema } from './eb-plan.ts';
import { EbDeviationSchema, EbQuoteSchema } from './eb-quotes.ts';
import { GhiCensusSummarySchema } from './ghi-census.ts';
import {
  GHI_COMPARISONS,
  GHI_QCR_STATUSES,
  GhiDispatchSchema,
  GhiPaymentSchema,
  GhiSendOutcomeSchema,
  SaveGhiPaymentRequestSchema,
  type GhiPaymentStatus,
} from './ghi-workflow.ts';

// The GPA and GTLI workflow after the quotes (Requirements 8 to 11): the QCR of each insurer's
// latest recorded quote with its approval, the client's decision within Approval (open question
// 1), the payments against the agreed premium, and the placement slip that places the case.

const OptionalText = (max: number) => blankAsNull(z.string().trim().max(max, 'This is too long'));
const uniqueIds = (ids: readonly string[]) => new Set(ids).size === ids.length;
const FingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/, 'Reload the QCR and check it again');

// QCR

export const SaveEbQcrRequestSchema = z.strictObject({
  /** One of the insurers compared, or none. */
  recommendedInsurerId: ObjectIdSchema.nullable(),
  remarks: OptionalText(2000),
});
export type SaveEbQcrRequest = z.infer<typeof SaveEbQcrRequestSchema>;

export const EbQcrDecisionRequestSchema = z
  .strictObject({
    decision: z.enum(['APPROVED', 'REJECTED']),
    comment: OptionalText(1000),
    /** The content the approver saw; a change since then refuses the decision (8.5). */
    fingerprint: FingerprintSchema,
  })
  .refine((body) => body.decision !== 'REJECTED' || body.comment !== null, {
    path: ['comment'],
    message: 'Say why the QCR is rejected',
  });
export type EbQcrDecisionRequest = z.infer<typeof EbQcrDecisionRequestSchema>;

export const SendEbQcrRequestSchema = z.strictObject({
  sendId: z.uuid({ error: 'Send id must be a UUID' }),
  to: z
    .array(EmailSchema)
    .min(1, 'Choose who receives the QCR')
    .max(10, 'Choose at most 10 addresses')
    .refine(uniqueIds, 'Each address once'),
  format: z.enum(DOCUMENT_FORMATS).default('pdf'),
});

/** The client's decision on the approved QCR (Requirement 9, open question 1). */
export const RecordEbClientDecisionRequestSchema = z.discriminatedUnion('decision', [
  z.strictObject({
    decision: z.literal('ACCEPTED'),
    insurerId: ObjectIdSchema,
    decidedOn: z.iso.date({ error: 'Enter the date of the client’s decision' }),
    confirmedBy: z
      .string()
      .trim()
      .min(1, 'Enter who confirmed it at the client')
      .max(120, 'This is too long'),
    note: OptionalText(1000),
    fileIds: z
      .array(ObjectIdSchema)
      .min(1, 'Attach the client’s mail or document')
      .max(10, 'Attach at most 10 files')
      .refine(uniqueIds, 'Each file once'),
    fingerprint: FingerprintSchema,
  }),
  z.strictObject({
    decision: z.literal('REJECTED'),
    decidedOn: z.iso.date({ error: 'Enter the date of the client’s decision' }),
    confirmedBy: z
      .string()
      .trim()
      .min(1, 'Enter who confirmed it at the client')
      .max(120, 'This is too long'),
    reason: z
      .string()
      .trim()
      .min(1, 'Say why the client rejected the QCR')
      .max(1000, 'This is too long'),
    fileIds: z
      .array(ObjectIdSchema)
      .max(10, 'Attach at most 10 files')
      .refine(uniqueIds, 'Each file once'),
    fingerprint: FingerprintSchema,
  }),
]);
export type RecordEbClientDecisionRequest = z.infer<typeof RecordEbClientDecisionRequestSchema>;

export const EbQcrParamsSchema = z.strictObject({ id: ObjectIdSchema, qcrId: ObjectIdSchema });

const ComparedValueSchema = z.object({ text: z.string(), kind: z.enum(GHI_COMPARISONS) });

export const EbClientDecisionSchema = z.object({
  decision: z.enum(['ACCEPTED', 'REJECTED']),
  insurerId: ObjectIdSchema.nullable(),
  insurerName: z.string().nullable(),
  quoteId: ObjectIdSchema.nullable(),
  quoteVersion: z.number().int().nullable(),
  /** The total (base + GST) of the chosen quote version, with 2 decimals (9.2). */
  agreedPremium: z.string().nullable(),
  decidedOn: z.iso.date(),
  confirmedBy: z.string(),
  note: z.string().nullable(),
  files: z.array(z.object({ id: ObjectIdSchema, fileName: z.string() })),
  recordedAt: IsoDateTimeSchema,
  recordedBy: z.string(),
});
export type EbClientDecision = z.infer<typeof EbClientDecisionSchema>;

export const EbQcrSchema = z.object({
  id: ObjectIdSchema,
  version: z.number().int(),
  status: z.enum(GHI_QCR_STATUSES),
  latest: z.boolean(),
  /** The content changed after it was submitted or approved: void, kept as history (8.4). */
  outOfDate: z.boolean(),
  /** The content as shown: sent back with an approval or decision (8.3, 8.5). */
  fingerprint: z.string(),
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
      deviations: z.array(EbDeviationSchema),
    }),
  ),
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
  decision: z
    .object({
      status: z.enum(['APPROVED', 'REJECTED']),
      at: IsoDateTimeSchema,
      by: z.string(),
      comment: z.string().nullable(),
    })
    .nullable(),
  sends: z.array(GhiDispatchSchema),
  clientDecision: EbClientDecisionSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  createdBy: z.string(),
});
export type EbQcr = z.infer<typeof EbQcrSchema>;

export const EbQcrListResponseSchema = z.object({
  items: z.array(EbQcrSchema),
  mailEnabled: z.boolean(),
  /** What a new QCR would compare now: each insurer's latest recorded, non-declined quote. */
  candidates: z.array(EbQuoteSchema),
});
export type EbQcrListResponse = z.infer<typeof EbQcrListResponseSchema>;

// Payments (Requirement 10): the GMC modes and statuses (GHI-08)

export const SaveEbPaymentRequestSchema = SaveGhiPaymentRequestSchema;
export type SaveEbPaymentRequest = z.infer<typeof SaveEbPaymentRequestSchema>;

export const EbPaymentsResponseSchema = z.object({
  /** The agreed total premium from the client's decision; null until it is recorded. */
  agreedPremium: z.string().nullable(),
  received: z.string(),
  pending: z.string(),
  outstanding: z.string().nullable(),
  /** RECEIVED payments cover the agreed premium. */
  covered: z.boolean(),
  items: z.array(GhiPaymentSchema),
});
export type EbPaymentsResponse = z.infer<typeof EbPaymentsResponseSchema>;

// Placement (Requirement 11)

export const IssueEbPlacementRequestSchema = z
  .strictObject({
    /** At most 50 characters: a technical bound, not a client rule (open question 2). */
    policyNumber: OptionalText(50),
    policyStart: blankAsNull(z.iso.date({ error: 'Enter a valid date' })),
    policyEnd: blankAsNull(z.iso.date({ error: 'Enter a valid date' })),
  })
  .refine((body) => !body.policyStart || !body.policyEnd || body.policyEnd >= body.policyStart, {
    path: ['policyEnd'],
    message: 'The policy end date must not be before the start date',
  });
export type IssueEbPlacementRequest = z.infer<typeof IssueEbPlacementRequestSchema>;

export const EbPlacementStateSchema = z.object({
  /** The slip can be downloaded and issued. */
  ready: z.boolean(),
  placed: z.boolean(),
  missing: z.array(z.string()),
  insurerName: z.string().nullable(),
  quoteVersion: z.number().int().nullable(),
  basePremium: z.string().nullable(),
  gst: z.string().nullable(),
  agreedPremium: z.string().nullable(),
  receivedPayments: z.array(
    z.object({ amount: z.string(), paidOn: z.iso.date(), reference: z.string() }),
  ),
  plan: EbPlanAssignmentSchema.nullable(),
  summary: GhiCensusSummarySchema,
  policyNumber: z.string().nullable(),
  policyStart: z.iso.date().nullable(),
  policyEnd: z.iso.date().nullable(),
  issuedAt: IsoDateTimeSchema.nullable(),
  issuedBy: z.string().nullable(),
});
export type EbPlacementState = z.infer<typeof EbPlacementStateSchema>;

// Pure helpers

export interface QuoteLike {
  id: string;
  insurerId: string;
  version: number;
  status: 'DRAFT' | 'FINAL';
  totalPremium: string | null;
}

/**
 * What a QCR compares (8.1): for each insurer not declined, its highest recorded (FINAL)
 * version; drafts never.
 */
export function qcrCandidates<Q extends QuoteLike>(
  quotes: readonly Q[],
  declined: ReadonlySet<string>,
): Q[] {
  const latest = new Map<string, Q>();
  for (const quote of quotes) {
    if (quote.status !== 'FINAL' || declined.has(quote.insurerId)) continue;
    const current = latest.get(quote.insurerId);
    if (!current || quote.version > current.version) latest.set(quote.insurerId, quote);
  }
  return [...latest.values()];
}

/** The indexes of every total equal to the smallest, to the paisa (8.1). */
export function lowestMarks(totals: readonly string[]): Set<number> {
  if (totals.length === 0) return new Set();
  let lowest = totals[0]!;
  for (const total of totals) if (compareDecimal(total, lowest) < 0) lowest = total;
  return new Set(
    totals.flatMap((total, index) => (compareDecimal(total, lowest) === 0 ? [index] : [])),
  );
}

export interface PaymentLike {
  amount: string;
  status: GhiPaymentStatus;
}

/** Received and pending sums, what is outstanding, and whether the premium is covered (10.2). */
export function paymentsSummary(
  agreedPremium: string | null,
  payments: readonly PaymentLike[],
): { received: string; pending: string; outstanding: string | null; covered: boolean } {
  const received = sumMoney(
    payments.filter((payment) => payment.status === 'RECEIVED').map((payment) => payment.amount),
  );
  const pending = sumMoney(
    payments.filter((payment) => payment.status === 'PENDING').map((payment) => payment.amount),
  );
  return {
    received,
    pending,
    outstanding: agreedPremium === null ? null : subtractMoneyFloor(agreedPremium, received),
    covered: agreedPremium !== null && compareDecimal(received, agreedPremium) >= 0,
  };
}

/** A stable text of a QCR's content, hashed by the API into its fingerprint (8.3). */
export function qcrContentKey(content: {
  columns: ReadonlyArray<{
    quoteId: string;
    quoteVersion: number;
    basePremium: string;
    gst: string;
    totalPremium: string;
    lowest: boolean;
    deviations: ReadonlyArray<{ field: string; kind: string }>;
  }>;
  recommendedInsurerId: string | null;
  remarks: string | null;
}): string {
  return JSON.stringify({
    columns: content.columns.map((column) => [
      column.quoteId,
      column.quoteVersion,
      column.basePremium,
      column.gst,
      column.totalPremium,
      column.lowest,
      column.deviations.map((item) => `${item.field}:${item.kind}`),
    ]),
    recommendedInsurerId: content.recommendedInsurerId,
    remarks: content.remarks,
  });
}

/** The RFQ mail's outcome per insurer, with the case as it is after (6.5, 6.10). */
export const EbDispatchRfqResponseSchema = z.object({
  results: z.array(GhiSendOutcomeSchema),
  case: EbCaseRecordSchema,
});
export type EbDispatchRfqResponse = z.infer<typeof EbDispatchRfqResponseSchema>;

export const EbQcrSendResponseSchema = z.object({ result: GhiSendOutcomeSchema, qcr: EbQcrSchema });
