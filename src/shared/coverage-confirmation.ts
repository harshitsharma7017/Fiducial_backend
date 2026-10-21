import { z } from 'zod';
import { EmailSchema } from './auth.ts';
import { SECTION_CODES } from './catalog.ts';
import { IsoDateTimeSchema, ObjectIdSchema, blankAsNull } from './common.ts';
import { MAX_MAIL_RECIPIENTS } from './mail.ts';
import { PlacedDocumentKindSchema } from './placement-slip.ts';
import { QuoteOptionSchema } from './quotes.ts';

// Q4 (coverage confirmation): after an insurer confirms cover, staff record the confirmation
// against the placed case and generate a confirmation communication — a letter (PDF) on Fiducial
// branding, an email to the insured, or both. The policy details come live from the Placement
// Slip and its placed policy / cover note; nothing is duplicated or invented.
//
// Rules baked into the contract:
//  - Recording a confirmation never sends anything. A send/download is a separate explicit action.
//  - The format (letter / email / both) and the signatory are configurable, because the client
//    has not confirmed them. No signature is ever rendered; a signatory, if entered, is shown as
//    typed text and clearly marked, never as a signed signature.
//  - The underlying case must already be Placed (an insurer policy / cover note recorded), so cover
//    is only ever treated as confirmed after a real insurer document exists.

/** Where staff indicate the client wants the confirmation delivered. Both is allowed. */
export const COVERAGE_CONFIRMATION_CHANNELS = ['LETTER', 'EMAIL', 'BOTH'] as const;
export const CoverageConfirmationChannelSchema = z.enum(COVERAGE_CONFIRMATION_CHANNELS);
export type CoverageConfirmationChannel = z.infer<typeof CoverageConfirmationChannelSchema>;
export const COVERAGE_CONFIRMATION_CHANNEL_LABELS: Record<CoverageConfirmationChannel, string> = {
  LETTER: 'Letter (PDF) only',
  EMAIL: 'Email only',
  BOTH: 'Letter and email',
};

const OptionalText = (max: number) => blankAsNull(z.string().trim().max(max, 'This is too long'));

/**
 * Records the insurer's confirmation against the placed case. Does not send anything. The policy
 * details are NOT taken here: they are read live from the placement slip when shown or generated.
 */
export const RecordCoverageConfirmationRequestSchema = z.strictObject({
  /** The date the insurer confirmed cover. */
  confirmedOn: z.iso.date({ error: 'Enter the date the insurer confirmed cover' }),
  /** The insurer's confirmation reference, when they gave one. */
  insurerReference: OptionalText(100).default(null),
  /** How the client wants the confirmation (configurable; the client has not confirmed). */
  channel: CoverageConfirmationChannelSchema.default('LETTER'),
  notes: OptionalText(2000).default(null),
  /**
   * The signatory to show on the letter, if any. Configurable and unconfirmed by the client: shown
   * as typed text, never as a signature. Left blank when not yet decided.
   */
  signatoryName: OptionalText(200).default(null),
  signatoryTitle: OptionalText(200).default(null),
  /** The insurer's confirmation email / document: files already uploaded for this case's placement. */
  attachmentIds: z.array(ObjectIdSchema).max(10).default([]),
});
export type RecordCoverageConfirmationRequest = z.infer<
  typeof RecordCoverageConfirmationRequestSchema
>;
export type RecordCoverageConfirmationFormValues = z.input<
  typeof RecordCoverageConfirmationRequestSchema
>;

/** Emails the coverage confirmation to the insured. A separate, explicit step from recording it. */
export const SendCoverageConfirmationRequestSchema = z.strictObject({
  /** Made by the web app for each send; repeating it never mails twice. */
  sendId: z.uuid(),
  to: z
    .array(EmailSchema)
    .min(1, 'Choose at least one address')
    .max(MAX_MAIL_RECIPIENTS, `Choose at most ${MAX_MAIL_RECIPIENTS} addresses`)
    .refine((emails) => new Set(emails).size === emails.length, 'Each address can be chosen once'),
  /** Attach the confirmation letter PDF to the email. */
  attachLetter: z.boolean().default(true),
});
export type SendCoverageConfirmationRequest = z.infer<typeof SendCoverageConfirmationRequestSchema>;

const TotalsSchema = z.object({ net: z.string(), gst: z.string(), total: z.string() });

/**
 * The policy details for the confirmation, read live from the placement slip and placed policy.
 * Every field is nullable because it is only shown when it genuinely exists; nothing is invented.
 */
export const CoveragePolicyDetailsSchema = z.object({
  insuredName: z.string(),
  insurerName: z.string(),
  insurerBranch: z.string(),
  /** POLICY or COVER_NOTE, from the placed record. */
  documentKind: PlacedDocumentKindSchema.nullable(),
  policyNumber: z.string().nullable(),
  issuedOn: z.iso.date().nullable(),
  policyStart: z.iso.date().nullable(),
  policyEnd: z.iso.date().nullable(),
  option: QuoteOptionSchema.nullable(),
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
  reference: z.string(),
});
export type CoveragePolicyDetails = z.infer<typeof CoveragePolicyDetailsSchema>;

/** One send of the confirmation email, newest first. */
export const CoverageSendSchema = z.object({
  mailId: ObjectIdSchema,
  at: IsoDateTimeSchema,
  by: z.string(),
  to: z.array(z.string()),
  result: z.enum(['DELIVERED', 'OUTBOX', 'FAILED']),
  error: z.string().nullable(),
});

export const CoverageConfirmationSchema = z.object({
  /** Null until a confirmation has been recorded for the case. */
  confirmation: z
    .object({
      confirmedOn: z.iso.date(),
      insurerReference: z.string().nullable(),
      channel: CoverageConfirmationChannelSchema,
      notes: z.string().nullable(),
      signatoryName: z.string().nullable(),
      signatoryTitle: z.string().nullable(),
      recordedAt: IsoDateTimeSchema,
      recordedBy: z.string(),
      updatedAt: IsoDateTimeSchema,
      updatedBy: z.string().nullable(),
      /** Ids of the placement files chosen as the insurer's proof of confirmation. */
      attachmentIds: z.array(ObjectIdSchema),
    })
    .nullable(),
  /** The policy details for the letter / email, read live from the placement slip. */
  policy: CoveragePolicyDetailsSchema.nullable(),
  /** Placement files available to attach as the insurer's confirmation proof. */
  files: z.array(
    z.object({
      id: ObjectIdSchema,
      fileName: z.string(),
      uploadedAt: IsoDateTimeSchema,
      uploadedBy: z.string(),
    }),
  ),
  /** The insured's contacts with an email, auto-filled into the send (reused from Q3). */
  recipients: z.array(z.object({ name: z.string(), email: z.string() })),
  /** The emails sent to the insured, newest first. */
  sends: z.array(CoverageSendSchema),
  /** What still stops a complete confirmation (e.g. the case is not placed, missing policy data). */
  missing: z.array(z.string()),
  /** Why the confirmation cannot be worked on now (case not placed / closed); null when it can. */
  blocked: z.string().nullable(),
  /**
   * The client has not confirmed the letter format and the authorised signatory. True so the UI
   * shows a clear "awaiting client confirmation" note next to the letter / signatory fields.
   */
  presentationPending: z.boolean(),
});
export type CoverageConfirmation = z.infer<typeof CoverageConfirmationSchema>;

export const CoverageConfirmationSendResponseSchema = z.object({
  outcome: z.enum(['SENT', 'FAILED']),
  reason: z.string().nullable(),
  coverage: CoverageConfirmationSchema,
});
export type CoverageConfirmationSendResponse = z.infer<
  typeof CoverageConfirmationSendResponseSchema
>;
