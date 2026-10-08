import { z } from 'zod';
import { EmailSchema } from './auth.ts';
import { SECTION_CODES } from './catalog.ts';
import { ClientApprovalSchema } from './client-approval.ts';
import { IsoDateTimeSchema, ObjectIdSchema, blankAsNull } from './common.ts';
import { MAX_MAIL_RECIPIENTS, MailAttachmentFormatSchema } from './mail.ts';
import { ProposalStageSchema } from './proposals.ts';
import { QUOTE_ATTACHMENT_TYPES } from './quotes.ts';

// The placement slip: the quote the client accepted, filled into the client's Placement Slip
// format (premium details for the insurer chosen, the schedule for the option accepted, the
// insurer's deductibles and conditions, the clauses); approved like the QCR and mailed to that
// insurer. Mailing it moves the case to Placement Slip; recording the policy or cover note the
// insurer issues moves it to Placed.

export const PLACEMENT_SLIP_STATUSES = ['DRAFT', 'APPROVED', 'SENT'] as const;
export const PlacementSlipStatusSchema = z.enum(PLACEMENT_SLIP_STATUSES);
export type PlacementSlipStatus = z.infer<typeof PlacementSlipStatusSchema>;
export const PLACEMENT_SLIP_STATUS_LABELS: Record<PlacementSlipStatus, string> = {
  DRAFT: 'Draft',
  APPROVED: 'Approved',
  SENT: 'Sent to the insurer',
};

/** What the insurer issued against the slip. */
export const PLACED_DOCUMENT_KINDS = ['POLICY', 'COVER_NOTE'] as const;
export const PlacedDocumentKindSchema = z.enum(PLACED_DOCUMENT_KINDS);
export type PlacedDocumentKind = z.infer<typeof PlacedDocumentKindSchema>;
export const PLACED_DOCUMENT_KIND_LABELS: Record<PlacedDocumentKind, string> = {
  POLICY: 'Policy',
  COVER_NOTE: 'Cover note',
};

/** Files accepted as the insurer's policy or cover note: the same kinds as a quote's proof. */
export const PLACEMENT_FILE_TYPES = QUOTE_ATTACHMENT_TYPES;
export const MAX_PLACEMENT_FILES = 10;

const OptionalText = (max: number) => blankAsNull(z.string().trim().max(max, 'This is too long'));

/** The broker's part of the slip: the remarks printed on it. */
export const SavePlacementSlipRequestSchema = z.strictObject({
  remarks: OptionalText(2000),
});
export type SavePlacementSlipRequest = z.infer<typeof SavePlacementSlipRequestSchema>;
export type SavePlacementSlipFormValues = z.input<typeof SavePlacementSlipRequestSchema>;

/** Approves the slip as shown: the fingerprint of what the approver saw. */
export const ApprovePlacementSlipRequestSchema = z.strictObject({
  fingerprint: z.string().min(1).max(100),
});

/** Mails the approved slip to the insurer the client accepted. */
export const SendPlacementSlipRequestSchema = z.strictObject({
  /** Made by the web app for each send; repeating it never mails twice. */
  sendId: z.uuid(),
  to: z
    .array(EmailSchema)
    .min(1, 'Choose at least one address')
    .max(MAX_MAIL_RECIPIENTS, `Choose at most ${MAX_MAIL_RECIPIENTS} addresses`)
    .refine((emails) => new Set(emails).size === emails.length, 'Each address can be chosen once'),
  format: MailAttachmentFormatSchema,
});
export type SendPlacementSlipRequest = z.infer<typeof SendPlacementSlipRequestSchema>;

/** The policy or cover note the insurer issued: moves the case to Placed. */
export const RecordPlacedRequestSchema = z.strictObject({
  documentKind: PlacedDocumentKindSchema,
  number: z
    .string()
    .trim()
    .min(1, 'Enter the policy or cover note number')
    .max(100, 'This is too long'),
  issuedOn: z.iso.date({ error: 'Enter the date it was issued' }),
  note: OptionalText(1000).default(null),
  /** The insurer's policy or cover note: files uploaded for this case's placement. */
  attachmentIds: z
    .array(ObjectIdSchema)
    .min(1, 'Attach the policy or cover note')
    .max(MAX_PLACEMENT_FILES),
});
export type RecordPlacedRequest = z.infer<typeof RecordPlacedRequestSchema>;
export type RecordPlacedFormValues = z.input<typeof RecordPlacedRequestSchema>;

export const PlacementFileSchema = z.object({
  id: ObjectIdSchema,
  fileName: z.string(),
  contentType: z.string(),
  size: z.number().int(),
  uploadedAt: IsoDateTimeSchema,
  uploadedBy: z.string(),
});
export type PlacementFile = z.infer<typeof PlacementFileSchema>;

const TotalsSchema = z.object({ net: z.string(), gst: z.string(), total: z.string() });

export const PlacementSlipSchema = z.object({
  status: PlacementSlipStatusSchema,
  /** The quote the client accepted; null until the client approval is recorded. */
  accepted: ClientApprovalSchema.nullable(),
  /** The sections placed: the sum insured of the option accepted and the insurer's premium. */
  sections: z.array(
    z.object({
      code: z.enum(SECTION_CODES),
      name: z.string(),
      sumInsured: z.string().nullable(),
      premium: z.string(),
    }),
  ),
  premium: TotalsSchema.nullable(),
  gstRatePercent: z.string(),
  capacityPercent: z.string().nullable(),
  deductibles: z.string().nullable(),
  conditions: z.string().nullable(),
  remarks: z.string().nullable(),
  updatedAt: IsoDateTimeSchema.nullable(),
  updatedBy: z.string().nullable(),
  /** Changes whenever the quote accepted, a figure or the remarks change. */
  fingerprint: z.string(),
  approval: z.object({ at: IsoDateTimeSchema, by: z.string(), current: z.boolean() }).nullable(),
  /** What still stops approval. */
  missing: z.array(z.string()),
  /** Whether the client's Placement Slip format has been uploaded (needed for the file). */
  templateUploaded: z.boolean(),
  /** The mails to the insurer, newest first. */
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
  /** The accepted insurer's RFQ addresses and contacts, for the send. */
  recipients: z.array(z.object({ name: z.string(), email: z.string() })),
  /** The policy or cover note recorded; null until then. */
  placed: z
    .object({
      documentKind: PlacedDocumentKindSchema,
      number: z.string(),
      issuedOn: z.iso.date(),
      note: z.string().nullable(),
      files: z.array(PlacementFileSchema),
      recordedAt: IsoDateTimeSchema,
      recordedBy: z.string(),
    })
    .nullable(),
  /** Every file uploaded for the placement, to attach on a save. */
  files: z.array(PlacementFileSchema),
  /** Why the slip cannot be worked on now (no client approval, closed); null when it can. */
  blocked: z.string().nullable(),
});
export type PlacementSlip = z.infer<typeof PlacementSlipSchema>;

export const PlacementSlipDocumentQuerySchema = z.strictObject({
  format: MailAttachmentFormatSchema.default('xlsx'),
});

export const PlacementSlipSendResponseSchema = z.object({
  outcome: z.enum(['SENT', 'FAILED']),
  reason: z.string().nullable(),
  slip: PlacementSlipSchema,
});
export type PlacementSlipSendResponse = z.infer<typeof PlacementSlipSendResponseSchema>;

export const PlacementFileUploadQuerySchema = z.strictObject({
  fileName: z.string().trim().min(1, 'Name the file').max(200, 'File name is too long'),
});
export const PlacementFileParamsSchema = z.strictObject({
  id: ObjectIdSchema,
  fileId: ObjectIdSchema,
});

/** One case on the Placement Slips list: the quote accepted, the slip and the policy. */
export const PlacementSlipSummarySchema = z.object({
  proposalId: ObjectIdSchema,
  reference: z.string(),
  clientName: z.string(),
  clientCity: z.string(),
  type: z.enum(['NEW', 'EXISTING']),
  stage: ProposalStageSchema,
  accepted: z.object({
    company: z.string(),
    branch: z.string(),
    option: z.enum(['EXISTING', 'P1', 'P2']),
    withTerrorism: z.boolean().nullable(),
    total: z.string(),
    acceptedOn: z.iso.date(),
  }),
  slip: z.object({
    status: PlacementSlipStatusSchema,
    approvedAt: IsoDateTimeSchema.nullable(),
    sentAt: IsoDateTimeSchema.nullable(),
  }),
  placed: z
    .object({ documentKind: PlacedDocumentKindSchema, number: z.string(), issuedOn: z.iso.date() })
    .nullable(),
});
export type PlacementSlipSummary = z.infer<typeof PlacementSlipSummarySchema>;
export const PlacementSlipSummaryListSchema = z.object({
  items: z.array(PlacementSlipSummarySchema),
});
