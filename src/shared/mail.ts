import { z } from 'zod';
import { EmailSchema } from './auth.ts';
import {
  CursorSchema,
  IsoDateTimeSchema,
  LimitSchema,
  ObjectIdSchema,
  paginatedSchema,
} from './common.ts';
import { formatDate } from './format.ts';
import { MAX_PROPOSAL_INSURERS, ProposalRecordSchema, type ProposalRecord } from './proposals.ts';

// RFQ email (E-2, E-3, E-6): templates an Admin edits, the mails built from them, and the log of
// every mail sent for a case. The API and the web app render with the same renderMail(), so a
// preview is exactly what is sent.

/** The two emails the app sends. */
export const EMAIL_TEMPLATE_KINDS = ['RFQ', 'REMINDER', 'QCR', 'PLACEMENT_SLIP'] as const;
export const EmailTemplateKindSchema = z.enum(EMAIL_TEMPLATE_KINDS);
export type EmailTemplateKind = z.infer<typeof EmailTemplateKindSchema>;
export const EMAIL_TEMPLATE_KIND_LABELS: Record<EmailTemplateKind, string> = {
  RFQ: 'RFQ email',
  REMINDER: 'Reminder email',
  QCR: 'QCR email to the insured',
  PLACEMENT_SLIP: 'Placement slip email to the insurer',
};

export const EMAIL_SUBJECT_MAX = 200;
export const EMAIL_BODY_MAX = 10_000;

/** The values a template can use, written {{name}}. */
export const MERGE_FIELDS = [
  'insuredName',
  'policyPeriod',
  'dueDate',
  'reference',
  'insurerName',
  'contactName',
  'senderName',
] as const;
export type MergeField = (typeof MERGE_FIELDS)[number];
export type MergeValues = Record<MergeField, string>;

export const MERGE_FIELD_LABELS: Record<MergeField, string> = {
  insuredName: 'Insured name',
  policyPeriod: 'Policy period',
  dueDate: 'Quote due date',
  reference: 'Case reference',
  insurerName: 'Insurer and branch',
  contactName: 'Contact name',
  senderName: 'Sender name',
};

/** Values for a preview without a case. */
export const SAMPLE_MERGE_VALUES: MergeValues = {
  insuredName: 'Sundarvan Agro Foods Pvt Ltd',
  policyPeriod: '01 Nov 2026 to 31 Oct 2027',
  dueDate: '20 Oct 2026',
  reference: 'PRP-2026-0001',
  insurerName: 'Kavach General Insurance, Pune',
  contactName: 'Meera Shah',
  senderName: 'Priya Nair',
};

export type TemplatePart = { type: 'text'; text: string } | { type: 'field'; field: MergeField };
export type ParsedTemplate = { ok: true; parts: TemplatePart[] } | { ok: false; errors: string[] };

/** A placeholder: {{name}}, with optional spaces inside the braces. */
const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g;
const KNOWN_FIELDS: ReadonlySet<string> = new Set(MERGE_FIELDS);

function isMergeField(name: string): name is MergeField {
  return KNOWN_FIELDS.has(name);
}

function snippet(text: string, at: number): string {
  return text.slice(at, at + 24).split('\n')[0] ?? '';
}

/** Problems in the text between placeholders: a {{ or }} there belongs to no merge field. */
function strayBraces(text: string): string[] {
  const errors: string[] = [];
  const open = text.indexOf('{{');
  if (open !== -1) {
    errors.push(`"${snippet(text, open)}" is not a merge field: write it as {{fieldName}}`);
  }
  if (text.includes('}}')) errors.push('"}}" has no merge field before it');
  return errors;
}

/**
 * Splits a template into text and merge fields. A field is {{name}}, spaces inside the braces
 * allowed, and must be one of MERGE_FIELDS. Any other {{ or }} is an error; single braces are
 * ordinary text.
 */
export function parseTemplate(source: string): ParsedTemplate {
  const parts: TemplatePart[] = [];
  const errors: string[] = [];
  let last = 0;
  const pushText = (text: string) => {
    errors.push(...strayBraces(text));
    if (text) parts.push({ type: 'text', text });
  };
  for (const match of source.matchAll(PLACEHOLDER)) {
    const name = match[1] ?? '';
    pushText(source.slice(last, match.index));
    if (isMergeField(name)) parts.push({ type: 'field', field: name });
    else errors.push(`{{${name}}} is not a merge field. Use one of: ${MERGE_FIELDS.join(', ')}`);
    last = match.index + match[0].length;
  }
  pushText(source.slice(last));
  return errors.length > 0 ? { ok: false, errors: [...new Set(errors)] } : { ok: true, parts };
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

function partsOf(source: string): TemplatePart[] {
  const parsed = parseTemplate(source);
  if (!parsed.ok) throw new Error(`Invalid email template: ${parsed.errors.join('; ')}`);
  return parsed.parts;
}

function fill(parts: readonly TemplatePart[], values: MergeValues, map: (value: string) => string) {
  return parts
    .map((part) => (part.type === 'text' ? map(part.text) : map(values[part.field])))
    .join('');
}

export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
}

/**
 * Fills a template. The subject is one line (any run of whitespace becomes a space); the text
 * body keeps its line breaks; the HTML body escapes every character of the template and the
 * values, so a value can never become markup, and turns line breaks into <br>.
 */
export function renderMail(
  template: { subject: string; body: string },
  values: MergeValues,
): RenderedMail {
  const subject = fill(partsOf(template.subject), values, (value) => value)
    .replace(/\s+/g, ' ')
    .trim();
  const bodyParts = partsOf(template.body.replace(/\r\n?/g, '\n'));
  const text = fill(bodyParts, values, (value) => value.replace(/\r\n?/g, '\n'));
  const html = `<div>${escapeHtml(text).replace(/\n/g, '<br>\n')}</div>`;
  return { subject, text, html };
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The policy period as the mail states it. */
export function policyPeriodText(start: string | null, end: string | null): string {
  if (!start) return '1 year from the date of payment';
  return `${formatDate(start)} to ${formatDate(end ?? addDays(start, 364))}`;
}

/** The merge values for one insurer's mail. */
export function mergeValuesFor(input: {
  record: Pick<ProposalRecord, 'reference' | 'client' | 'policyStart' | 'policyEnd'>;
  insurer: { company: string; branch: string };
  contactName: string | null;
  dueDate: string;
  senderName: string;
}): MergeValues {
  return {
    insuredName: input.record.client.name,
    policyPeriod: policyPeriodText(input.record.policyStart, input.record.policyEnd),
    dueDate: formatDate(input.dueDate),
    reference: input.record.reference,
    insurerName: `${input.insurer.company}, ${input.insurer.branch}`,
    contactName: input.contactName ?? '',
    senderName: input.senderName,
  };
}

// Templates

function templateIssues(source: string, path: 'subject' | 'body', ctx: z.RefinementCtx): void {
  const parsed = parseTemplate(source);
  if (parsed.ok) return;
  for (const message of parsed.errors) ctx.addIssue({ code: 'custom', path: [path], message });
}

export const EmailTemplateSchema = z.object({
  kind: EmailTemplateKindSchema,
  subject: z.string(),
  body: z.string(),
  /** Goes up by one at each save; every mail records the version it was built from. */
  version: z.number().int().min(1),
  /** Still the wording the app was installed with. */
  isDefault: z.boolean(),
  updatedBy: z.string().nullable(),
  updatedAt: IsoDateTimeSchema,
});
export type EmailTemplate = z.infer<typeof EmailTemplateSchema>;

export const EmailTemplateListResponseSchema = z.object({ items: z.array(EmailTemplateSchema) });
export type EmailTemplateListResponse = z.infer<typeof EmailTemplateListResponseSchema>;

export const EmailTemplateKindParamsSchema = z.strictObject({ kind: EmailTemplateKindSchema });

export const UpdateEmailTemplateRequestSchema = z
  .strictObject({
    subject: z
      .string()
      .trim()
      .min(1, 'Enter a subject')
      .max(EMAIL_SUBJECT_MAX, `Keep the subject under ${EMAIL_SUBJECT_MAX} characters`),
    body: z
      .string()
      .min(1, 'Enter the message')
      .max(
        EMAIL_BODY_MAX,
        `Keep the message under ${EMAIL_BODY_MAX.toLocaleString('en-IN')} characters`,
      )
      .refine((value) => value.trim().length > 0, 'Enter the message'),
    /** The version being edited; saving fails if someone saved a newer one meanwhile. */
    expectedVersion: z.number().int().min(1),
  })
  .superRefine((value, ctx) => {
    templateIssues(value.subject, 'subject', ctx);
    templateIssues(value.body, 'body', ctx);
  });
export type UpdateEmailTemplateRequest = z.infer<typeof UpdateEmailTemplateRequestSchema>;

// Sending

/** Addresses per mail: an insurer branch's RFQ addresses plus its contacts. */
export const MAX_MAIL_RECIPIENTS = 20;
/** The largest attachment a mail may carry. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export const MAIL_ATTACHMENT_FORMATS = ['xlsx', 'pdf'] as const;
export const MailAttachmentFormatSchema = z.enum(MAIL_ATTACHMENT_FORMATS);
export type MailAttachmentFormat = z.infer<typeof MailAttachmentFormatSchema>;

const RecipientsSchema = z
  .array(EmailSchema)
  .min(1, 'Choose at least one address')
  .max(MAX_MAIL_RECIPIENTS, `Choose at most ${MAX_MAIL_RECIPIENTS} addresses`)
  .refine((emails) => new Set(emails).size === emails.length, 'Each address can be chosen once');

/** One insurer's mail: the addresses it goes to, all from the insurer master. */
export const RfqRecipientSchema = z.strictObject({
  insurerId: ObjectIdSchema,
  to: RecipientsSchema,
});
export type RfqRecipient = z.infer<typeof RfqRecipientSchema>;

const RecipientListSchema = z
  .array(RfqRecipientSchema)
  .min(1, 'Choose at least one insurer')
  .max(MAX_PROPOSAL_INSURERS, `Choose at most ${MAX_PROPOSAL_INSURERS} insurers`)
  .refine(
    (insurers) => new Set(insurers.map((insurer) => insurer.insurerId)).size === insurers.length,
    'Each insurer can be chosen once',
  );

/** Emails the RFQ: one mail per insurer, each to that insurer's addresses only (E-3). */
export const SendRfqRequestSchema = z.strictObject({
  /** Made by the client for each send; repeating it never mails an insurer twice. */
  sendId: z.uuid(),
  insurers: RecipientListSchema,
  /** The quote due date given to these insurers. */
  dueDate: z.iso.date(),
  format: MailAttachmentFormatSchema,
});
export type SendRfqRequest = z.infer<typeof SendRfqRequestSchema>;

/** Builds the mails a send would make, without sending anything. */
export const PreviewMailRequestSchema = z
  .strictObject({
    kind: EmailTemplateKindSchema.default('RFQ'),
    insurers: RecipientListSchema,
    /** Needed for the RFQ; a reminder uses the insurer's own due date when left out. */
    dueDate: z.iso.date().optional(),
    format: MailAttachmentFormatSchema.default('xlsx'),
  })
  .refine((value) => value.kind !== 'RFQ' || value.dueDate !== undefined, {
    message: 'Choose the quote due date',
    path: ['dueDate'],
  });
export type PreviewMailRequest = z.infer<typeof PreviewMailRequestSchema>;

/** Reminds one insurer that has the RFQ. */
export const SendReminderRequestSchema = z.strictObject({
  sendId: z.uuid(),
  to: RecipientsSchema,
  attachRfq: z.boolean(),
  format: MailAttachmentFormatSchema.default('xlsx'),
});
export type SendReminderRequest = z.infer<typeof SendReminderRequestSchema>;

export const MailPreviewSchema = z.object({
  insurerId: ObjectIdSchema,
  insurerName: z.string(),
  to: z.array(z.string()),
  subject: z.string(),
  text: z.string(),
  html: z.string(),
});
export type MailPreview = z.infer<typeof MailPreviewSchema>;

export const MailPreviewResponseSchema = z.object({
  mails: z.array(MailPreviewSchema),
  /** The file the mails would carry, or null for a reminder without the RFQ. */
  attachmentName: z.string().nullable(),
});
export type MailPreviewResponse = z.infer<typeof MailPreviewResponseSchema>;

/**
 * SENT: accepted by the mail server (or stored, in the outbox). FAILED: rejected, with the
 * reason; the insurer's status is unchanged. SKIPPED: not sent now, because the insurer already
 * had this mail or another send to it was in progress.
 */
export const SEND_OUTCOMES = ['SENT', 'FAILED', 'SKIPPED'] as const;
export type SendOutcome = (typeof SEND_OUTCOMES)[number];

export const SendResultSchema = z.object({
  insurerId: ObjectIdSchema,
  insurerName: z.string(),
  outcome: z.enum(SEND_OUTCOMES),
  mailId: ObjectIdSchema.nullable(),
  reason: z.string().nullable(),
});
export type SendResult = z.infer<typeof SendResultSchema>;

export const SendMailResponseSchema = z.object({
  results: z.array(SendResultSchema),
  proposal: ProposalRecordSchema,
});
export type SendMailResponse = z.infer<typeof SendMailResponseSchema>;

// The mail log (E-6)

export const MAIL_TRANSPORTS = ['smtp', 'outbox', 'off'] as const;
export type MailTransportName = (typeof MAIL_TRANSPORTS)[number];

/**
 * DELIVERED: the mail server accepted it (it may still bounce later). OUTBOX: stored only, as the
 * app is set not to deliver mail. FAILED: the mail server refused it or could not be reached.
 */
export const MAIL_RESULTS = ['DELIVERED', 'OUTBOX', 'FAILED'] as const;
export type MailResult = (typeof MAIL_RESULTS)[number];
export const MAIL_RESULT_LABELS: Record<MailResult, string> = {
  DELIVERED: 'Delivered to the mail server',
  OUTBOX: 'Not delivered (outbox)',
  FAILED: 'Failed',
};

export const MailSummarySchema = z.object({
  id: ObjectIdSchema,
  kind: EmailTemplateKindSchema,
  /** Null for a mail to the insured (the QCR). */
  insurerId: ObjectIdSchema.nullable(),
  /** The insurer and branch, or "The insured". */
  insurerName: z.string(),
  to: z.array(z.string()),
  subject: z.string(),
  sentBy: z.string(),
  at: IsoDateTimeSchema,
  transport: z.enum(['smtp', 'outbox']),
  result: z.enum(MAIL_RESULTS),
  error: z.string().nullable(),
  attachment: z.object({ fileName: z.string(), size: z.number().int() }).nullable(),
});
export type MailSummary = z.infer<typeof MailSummarySchema>;

export const MailDetailSchema = MailSummarySchema.extend({
  from: z.string(),
  replyTo: z.string(),
  text: z.string(),
  html: z.string(),
  templateVersion: z.number().int(),
  dueDate: z.iso.date().nullable(),
  messageId: z.string().nullable(),
});
export type MailDetail = z.infer<typeof MailDetailSchema>;

export const MailListQuerySchema = z.strictObject({
  limit: LimitSchema,
  cursor: CursorSchema.optional(),
});
export type MailListQuery = z.infer<typeof MailListQuerySchema>;

export const MailListResponseSchema = paginatedSchema(MailSummarySchema);
export type MailListResponse = z.infer<typeof MailListResponseSchema>;

export const ProposalMailParamsSchema = z.strictObject({
  id: ObjectIdSchema,
  mailId: ObjectIdSchema,
});

/** How the API sends mail, for Settings. Never includes credentials. */
export const MailStatusSchema = z.object({
  transport: z.enum(MAIL_TRANSPORTS),
  from: z.string().nullable(),
  host: z.string().nullable(),
});
export type MailStatus = z.infer<typeof MailStatusSchema>;
