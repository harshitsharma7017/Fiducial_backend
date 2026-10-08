import { z } from 'zod';
import { IsoDateTimeSchema, ObjectIdSchema, blankAsNull } from './common.ts';
import { QUOTE_ATTACHMENT_TYPES, QuoteOptionSchema } from './quotes.ts';

// Client approval: after the QCR has gone to the insured, the quote the client accepted (an
// insurer and option from the QCR, and for Fire whether terrorism is taken), when and by whom
// it was confirmed, and the client's mail or signed letter as proof. Recording it moves the case
// to Client Approval; the premium accepted is kept as it was, for the placement slip.

/** Files accepted as the client's confirmation: the same kinds as an insurer's quote. */
export const CLIENT_APPROVAL_FILE_TYPES = QUOTE_ATTACHMENT_TYPES;
export const MAX_CLIENT_APPROVAL_FILES = 10;

const OptionalText = (max: number) => blankAsNull(z.string().trim().max(max, 'This is too long'));

export const RecordClientApprovalRequestSchema = z.strictObject({
  insurerId: ObjectIdSchema,
  option: QuoteOptionSchema,
  /**
   * Fire with terrorism (true) or without (false). Needed only when the insurer quoted Fire both
   * ways; otherwise blank.
   */
  withTerrorism: z.boolean().nullable().default(null),
  acceptedOn: z.iso.date({ error: 'Enter the date the client accepted' }),
  /** Who at the client confirmed, for example the contact who replied. */
  confirmedBy: z
    .string()
    .trim()
    .min(1, 'Enter who confirmed for the client')
    .max(200, 'This is too long'),
  note: OptionalText(1000).default(null),
  /** The client's mail or signed letter: files uploaded for this case's client approval. */
  attachmentIds: z
    .array(ObjectIdSchema)
    .min(1, 'Attach the client’s email or signed letter')
    .max(MAX_CLIENT_APPROVAL_FILES),
});
export type RecordClientApprovalRequest = z.infer<typeof RecordClientApprovalRequestSchema>;
export type RecordClientApprovalFormValues = z.input<typeof RecordClientApprovalRequestSchema>;

export const ClientApprovalFileSchema = z.object({
  id: ObjectIdSchema,
  fileName: z.string(),
  contentType: z.string(),
  size: z.number().int(),
  uploadedAt: IsoDateTimeSchema,
  uploadedBy: z.string(),
});
export type ClientApprovalFile = z.infer<typeof ClientApprovalFileSchema>;

const TotalsSchema = z.object({ net: z.string(), gst: z.string(), total: z.string() });

/** A quote the client can accept: each insurer and option the QCR compares. */
export const ClientApprovalChoiceSchema = z.object({
  insurerId: ObjectIdSchema,
  company: z.string(),
  branch: z.string(),
  option: QuoteOptionSchema,
  quoteId: ObjectIdSchema,
  version: z.number().int(),
  /** Fire with terrorism; and without, when Fire was quoted both ways. */
  withTerrorism: TotalsSchema,
  withoutTerrorism: TotalsSchema.nullable(),
  /** The QCR's recommendation, and its lowest total for the option. */
  recommended: z.boolean(),
  lowest: z.boolean(),
});
export type ClientApprovalChoice = z.infer<typeof ClientApprovalChoiceSchema>;

export const ClientApprovalSchema = z.object({
  insurerId: ObjectIdSchema,
  company: z.string(),
  branch: z.string(),
  option: QuoteOptionSchema,
  quoteId: ObjectIdSchema,
  version: z.number().int(),
  withTerrorism: z.boolean().nullable(),
  /** The premium accepted, as the quote stood when the approval was recorded. */
  premium: TotalsSchema,
  acceptedOn: z.iso.date(),
  confirmedBy: z.string(),
  note: z.string().nullable(),
  files: z.array(ClientApprovalFileSchema),
  recordedAt: IsoDateTimeSchema,
  recordedBy: z.string(),
  /** False once the quote accepted has a newer version: the premium kept may be out of date. */
  quoteCurrent: z.boolean(),
});
export type ClientApproval = z.infer<typeof ClientApprovalSchema>;

export const ProposalClientApprovalSchema = z.object({
  /** Null until the client's acceptance is recorded. */
  approval: ClientApprovalSchema.nullable(),
  choices: z.array(ClientApprovalChoiceSchema),
  /** Every file uploaded for the client approval, to attach (again) on a save. */
  files: z.array(ClientApprovalFileSchema),
  /** The client's contacts, to name who confirmed. */
  contacts: z.array(z.string()),
  /** Why it cannot be recorded now (the QCR not sent, the case placed or closed); null when it can. */
  blocked: z.string().nullable(),
});
export type ProposalClientApproval = z.infer<typeof ProposalClientApprovalSchema>;

export const ClientApprovalFileUploadQuerySchema = z.strictObject({
  fileName: z.string().trim().min(1, 'Name the file').max(200, 'File name is too long'),
});
export const ClientApprovalFileParamsSchema = z.strictObject({
  id: ObjectIdSchema,
  fileId: ObjectIdSchema,
});
