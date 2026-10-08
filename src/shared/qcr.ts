import { z } from 'zod';
import { EmailSchema } from './auth.ts';
import { SECTION_CODES } from './catalog.ts';
import { IsoDateTimeSchema, ObjectIdSchema, blankAsNull } from './common.ts';
import { MAX_MAIL_RECIPIENTS, MailAttachmentFormatSchema } from './mail.ts';
import { InsurerStatusSchema, ProposalStageSchema } from './proposals.ts';
import { QuoteOptionSchema } from './quotes.ts';

// The QCR, the quote comparison report (QC-1 to QC-6): the existing policy and up to five insurers
// side by side for each option, from the latest version of each quote; the lowest total marked;
// where insurers' cover differs; the broker's recommendation, remarks and "cheque / payment in
// favour of"; approval; and the mail to the insured. As in the client's QCR, premiums compare the
// recommended cover, Fire without terrorism (Fire with terrorism when that is all an insurer quoted).

export const QCR_STATUSES = ['DRAFT', 'APPROVED', 'SENT'] as const;
export const QcrStatusSchema = z.enum(QCR_STATUSES);
export type QcrStatus = z.infer<typeof QcrStatusSchema>;
export const QCR_STATUS_LABELS: Record<QcrStatus, string> = {
  DRAFT: 'Draft',
  APPROVED: 'Approved',
  SENT: 'Sent to the insured',
};

const OptionalText = (max: number) => blankAsNull(z.string().trim().max(max, 'This is too long'));

/** The broker's part of the QCR (QC-3). */
export const SaveQcrRequestSchema = z
  .strictObject({
    recommendedInsurerId: ObjectIdSchema.nullable(),
    recommendedOption: QuoteOptionSchema.nullable(),
    recommendation: OptionalText(2000),
    remarks: OptionalText(2000),
    paymentInFavourOf: OptionalText(300),
  })
  .refine((body) => (body.recommendedInsurerId === null) === (body.recommendedOption === null), {
    path: ['recommendedOption'],
    message: 'Choose both the insurer and the option recommended',
  });
export type SaveQcrRequest = z.infer<typeof SaveQcrRequestSchema>;
export type SaveQcrFormValues = z.input<typeof SaveQcrRequestSchema>;

/** Approves the QCR as shown: the fingerprint of what the approver saw. */
export const ApproveQcrRequestSchema = z.strictObject({ fingerprint: z.string().min(1).max(100) });

/** Mails the approved QCR to the insured (QC-6). */
export const SendQcrRequestSchema = z.strictObject({
  /** Made by the web app for each send; repeating it never mails twice. */
  sendId: z.uuid(),
  to: z
    .array(EmailSchema)
    .min(1, 'Choose at least one address')
    .max(MAX_MAIL_RECIPIENTS, `Choose at most ${MAX_MAIL_RECIPIENTS} addresses`)
    .refine((emails) => new Set(emails).size === emails.length, 'Each address can be chosen once'),
  format: MailAttachmentFormatSchema,
});
export type SendQcrRequest = z.infer<typeof SendQcrRequestSchema>;

const TotalsSchema = z.object({ net: z.string(), gst: z.string(), total: z.string() });

export const QcrOptionSchema = z.object({
  option: QuoteOptionSchema,
  sections: z.array(
    z.object({
      code: z.enum(SECTION_CODES),
      name: z.string(),
      /** Renewals: last year's sum insured and premium. */
      existingSumInsured: z.string().nullable(),
      existingPremium: z.string().nullable(),
      /** The sum insured this option asks for. */
      sumInsured: z.string().nullable(),
    }),
  ),
  /** Renewals: last year's premium in the same columns. */
  existing: TotalsSchema.nullable(),
  quotes: z.array(
    z.object({
      insurerId: ObjectIdSchema,
      quoteId: ObjectIdSchema,
      version: z.number().int(),
      /** Per section; Fire without terrorism when quoted so. Null: not quoted. */
      premiums: z.array(z.object({ code: z.enum(SECTION_CODES), premium: z.string().nullable() })),
      /** Fire was quoted with terrorism only. */
      fireWithTerrorism: z.boolean(),
      totals: TotalsSchema,
      /** The extra net premium for terrorism on Fire, when both were quoted. */
      terrorismExtra: z.string().nullable(),
      deviations: z.array(z.string()),
      /** The lowest total premium of the option (QC-2); ties are all marked. */
      lowest: z.boolean(),
    }),
  ),
  /** Where the insurers' cover differs (QC-2): each topic with every insurer's answer. */
  differences: z.array(
    z.object({
      topic: z.string(),
      values: z.array(z.object({ insurerId: ObjectIdSchema, value: z.string() })),
    }),
  ),
});
export type QcrOption = z.infer<typeof QcrOptionSchema>;

export const QcrSchema = z.object({
  status: QcrStatusSchema,
  gstRatePercent: z.string(),
  /** The insurers compared, in the case's order (declined ones are left out). */
  insurers: z.array(
    z.object({
      insurerId: ObjectIdSchema,
      company: z.string(),
      branch: z.string(),
      status: InsurerStatusSchema,
    }),
  ),
  options: z.array(QcrOptionSchema),
  recommendedInsurerId: ObjectIdSchema.nullable(),
  recommendedOption: QuoteOptionSchema.nullable(),
  recommendation: z.string().nullable(),
  remarks: z.string().nullable(),
  paymentInFavourOf: z.string().nullable(),
  updatedAt: IsoDateTimeSchema.nullable(),
  updatedBy: z.string().nullable(),
  /** Changes whenever a figure or the broker's part changes; approval is for one fingerprint. */
  fingerprint: z.string(),
  /** The approval, if any; `current` is false once anything changed after it. */
  approval: z.object({ at: IsoDateTimeSchema, by: z.string(), current: z.boolean() }).nullable(),
  /** What still stops approval. */
  missing: z.array(z.string()),
  /** The mails to the insured, newest first. */
  sends: z.array(
    z.object({
      mailId: ObjectIdSchema,
      at: IsoDateTimeSchema,
      by: z.string(),
      to: z.array(z.string()),
      result: z.enum(['DELIVERED', 'OUTBOX', 'FAILED']),
      error: z.string().nullable(),
    }),
  ),
  /** The insured's contacts with an email, for the send. */
  recipients: z.array(z.object({ name: z.string(), email: z.string() })),
});
export type Qcr = z.infer<typeof QcrSchema>;

export const QcrDocumentQuerySchema = z.strictObject({
  format: MailAttachmentFormatSchema.default('xlsx'),
});

export const QcrSendResponseSchema = z.object({
  outcome: z.enum(['SENT', 'FAILED']),
  reason: z.string().nullable(),
  qcr: QcrSchema,
});
export type QcrSendResponse = z.infer<typeof QcrSendResponseSchema>;

/** One case on the Quotes and QCR list: its insurers' answers, the lowest quote and the QCR. */
export const QcrSummarySchema = z.object({
  proposalId: ObjectIdSchema,
  reference: z.string(),
  clientName: z.string(),
  clientCity: z.string(),
  type: z.enum(['NEW', 'EXISTING']),
  stage: ProposalStageSchema,
  dueDate: z.iso.date(),
  insurers: z.object({
    /** Insurers that have the RFQ. */
    asked: z.number().int(),
    quoted: z.number().int(),
    declined: z.number().int(),
    /** Sent or reminded, nothing recorded yet. */
    awaiting: z.number().int(),
    overdue: z.number().int(),
  }),
  /** The lowest total of Option 1 (else the first option quoted). */
  lowest: z
    .object({
      company: z.string(),
      branch: z.string(),
      option: QuoteOptionSchema,
      total: z.string(),
    })
    .nullable(),
  qcr: z.object({
    status: QcrStatusSchema,
    recommended: z.string().nullable(),
    approvedAt: IsoDateTimeSchema.nullable(),
    sentAt: IsoDateTimeSchema.nullable(),
  }),
});
export type QcrSummary = z.infer<typeof QcrSummarySchema>;
export const QcrSummaryListSchema = z.object({ items: z.array(QcrSummarySchema) });
