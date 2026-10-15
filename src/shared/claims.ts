import { z } from 'zod';
import { EmailSchema } from './auth.ts';
import { IsoDateTimeSchema, ObjectIdSchema, blankAsNull } from './common.ts';
import { SearchTextSchema } from './clients.ts';
import { GhiAmountSchema } from './ghi.ts';
import { GhiRelationshipSchema } from './ghi-census.ts';
import { escapeHtml } from './mail.ts';

// Group health claims (C1 to C4): claims against a placed GHI policy, for a member of its census,
// worked on a board of statuses, with an email to the claimant and the company's HR at each move
// and an append-only timeline. Amounts are rupees with paise as decimal strings.

/**
 * The claim statuses, in board order. These four are agreed; Rejected or Settled / Paid would be
 * added here, to CLAIM_TRANSITIONS and to the email templates (which follow from the transitions),
 * once the client approves them. Nothing else lists the statuses.
 */
export const CLAIM_STATUSES = ['FORM', 'SUBMITTED', 'INVESTIGATION', 'APPROVED'] as const;
export const ClaimStatusSchema = z.enum(CLAIM_STATUSES);
export type ClaimStatus = z.infer<typeof ClaimStatusSchema>;
export const CLAIM_STATUS_LABELS: Record<ClaimStatus, string> = {
  FORM: 'Form',
  SUBMITTED: 'Submitted',
  INVESTIGATION: 'Investigation',
  APPROVED: 'Approved',
};

/** The moves allowed from each status. One step forward only, until the client says otherwise. */
export const CLAIM_TRANSITIONS: Record<ClaimStatus, readonly ClaimStatus[]> = {
  FORM: ['SUBMITTED'],
  SUBMITTED: ['INVESTIGATION'],
  INVESTIGATION: ['APPROVED'],
  APPROVED: [],
};

export function canMoveClaim(from: ClaimStatus, to: ClaimStatus): boolean {
  return CLAIM_TRANSITIONS[from].includes(to);
}

/** The statuses a claim can be moved into: each has its own email templates. */
export const CLAIM_NOTIFIED_STATUSES = CLAIM_STATUSES.filter((status) =>
  CLAIM_STATUSES.some((from) => CLAIM_TRANSITIONS[from].includes(status)),
);

export const CLAIM_TYPES = ['CASHLESS', 'REIMBURSEMENT'] as const;
export const ClaimTypeSchema = z.enum(CLAIM_TYPES);
export type ClaimType = z.infer<typeof ClaimTypeSchema>;
export const CLAIM_TYPE_LABELS: Record<ClaimType, string> = {
  CASHLESS: 'Cashless',
  REIMBURSEMENT: 'Reimbursement',
};

export const CLAIM_DOCUMENT_KINDS = [
  'MEDICAL_BILL',
  'DISCHARGE_SUMMARY',
  'ID_PROOF',
  'OTHER',
] as const;
export const ClaimDocumentKindSchema = z.enum(CLAIM_DOCUMENT_KINDS);
export type ClaimDocumentKind = z.infer<typeof ClaimDocumentKindSchema>;
export const CLAIM_DOCUMENT_KIND_LABELS: Record<ClaimDocumentKind, string> = {
  MEDICAL_BILL: 'Medical bills',
  DISCHARGE_SUMMARY: 'Discharge summary',
  ID_PROOF: 'ID proof',
  OTHER: 'Other supporting document',
};
/** A claim needs one of each before it is moved to Submitted. */
export const REQUIRED_CLAIM_DOCUMENTS: readonly ClaimDocumentKind[] = [
  'MEDICAL_BILL',
  'DISCHARGE_SUMMARY',
  'ID_PROOF',
];
/** Medical documents: PDF, or a scan or photo. */
export const CLAIM_DOCUMENT_TYPES = {
  'application/pdf': '.pdf',
  'image/png': '.png',
  'image/jpeg': '.jpg',
} as const;
export const MAX_CLAIM_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const MAX_CLAIM_DOCUMENTS = 30;

const OptionalText = (max: number) => blankAsNull(z.string().trim().max(max, 'This is too long'));
const ClaimAmountSchema = GhiAmountSchema.refine(
  (value) => Number(value) > 0,
  'Enter an amount above 0',
);
const HospitalSchema = z.strictObject({
  name: z.string().trim().min(1, 'Enter the hospital').max(200, 'This is too long'),
  city: OptionalText(100),
});
const RemarkSchema = z
  .string()
  .trim()
  .min(1, 'Enter a remark')
  .max(1000, 'Keep the remark under 1,000 characters');

function checkDates(
  body: { admissionDate: string; dischargeDate: string },
  context: z.RefinementCtx,
) {
  if (body.dischargeDate < body.admissionDate) {
    context.addIssue({
      code: 'custom',
      path: ['dischargeDate'],
      message: 'The discharge date cannot be before the admission date',
    });
  }
}

/** The claim's own details, as staff or the employee enter them. */
const ClaimDetailsShape = {
  hospital: HospitalSchema,
  admissionDate: z.iso.date({ error: 'Enter the admission date' }),
  dischargeDate: z.iso.date({ error: 'Enter the discharge date' }),
  claimType: ClaimTypeSchema,
  amountClaimed: ClaimAmountSchema,
  contactEmail: EmailSchema,
  contactPhone: blankAsNull(
    z
      .string()
      .trim()
      .regex(/^[0-9+\-() ]{6,20}$/, 'Enter a phone number'),
  ).default(null),
};

/** Staff create a claim (C2): company, policy, employee and patient from the census. */
export const CreateClaimRequestSchema = z
  .strictObject({
    clientId: ObjectIdSchema,
    /** The placed GHI case whose policy covers the claim. */
    ghiCaseId: ObjectIdSchema,
    /** The employee's own (Self) census row. */
    employeeMemberId: ObjectIdSchema,
    /** The patient: the employee or one of their covered dependants. */
    patientMemberId: ObjectIdSchema,
    /** Who processes it; the creator when left out. */
    assignedTo: ObjectIdSchema.optional(),
    ...ClaimDetailsShape,
  })
  .superRefine(checkDates);
export type CreateClaimRequest = z.infer<typeof CreateClaimRequestSchema>;
export type CreateClaimFormValues = z.input<typeof CreateClaimRequestSchema>;

/** Corrects a claim's details; the patient and policy stay as created. */
export const UpdateClaimRequestSchema = z.strictObject(ClaimDetailsShape).superRefine(checkDates);
export type UpdateClaimRequest = z.infer<typeof UpdateClaimRequestSchema>;

/** Moves a claim to another status with the staff member's remark (C1). */
export const TransitionClaimRequestSchema = z.strictObject({
  toStatus: ClaimStatusSchema,
  /** The status the user saw; the move fails if someone moved the claim meanwhile. */
  expectedStatus: ClaimStatusSchema,
  remark: RemarkSchema,
});
export type TransitionClaimRequest = z.infer<typeof TransitionClaimRequestSchema>;

export const AddClaimRemarkRequestSchema = z.strictObject({ remark: RemarkSchema });
export const AssignClaimRequestSchema = z.strictObject({ assignedTo: ObjectIdSchema.nullable() });

export const ClaimParamsSchema = z.strictObject({ id: ObjectIdSchema });
export const ClaimFileParamsSchema = z.strictObject({ id: ObjectIdSchema, fileId: ObjectIdSchema });
export const ClaimNotificationParamsSchema = z.strictObject({
  id: ObjectIdSchema,
  notificationId: ObjectIdSchema,
});
export const ClaimDocumentUploadQuerySchema = z.strictObject({
  kind: ClaimDocumentKindSchema,
  fileName: z
    .string()
    .trim()
    .min(1, 'Name the file')
    .max(200, 'The file name is too long')
    .regex(/^[^\\/:*?"<>|\r\n]+$/, 'The file name has characters that are not allowed'),
});

// Responses

export const ClaimDocumentSchema = z.object({
  id: ObjectIdSchema,
  kind: ClaimDocumentKindSchema,
  fileName: z.string(),
  contentType: z.string(),
  size: z.number().int(),
  uploadedAt: IsoDateTimeSchema,
  /** A staff member's name, or "Employee (submission link)". */
  uploadedBy: z.string(),
});
export type ClaimDocument = z.infer<typeof ClaimDocumentSchema>;

export const ClaimCardSchema = z.object({
  id: ObjectIdSchema,
  claimNumber: z.string(),
  status: ClaimStatusSchema,
  clientName: z.string(),
  employeeName: z.string(),
  patientName: z.string(),
  relationship: GhiRelationshipSchema,
  hospital: z.string(),
  amountClaimed: z.string(),
  claimType: ClaimTypeSchema,
  admissionDate: z.iso.date(),
  /** Whole days since the claim reached its current status. */
  daysInStage: z.number().int(),
  assignedTo: z.object({ id: ObjectIdSchema, name: z.string() }).nullable(),
  /** The signed-in user may move this claim (assigned to them, or an Admin). */
  canMove: z.boolean(),
  createdAt: IsoDateTimeSchema,
});
export type ClaimCard = z.infer<typeof ClaimCardSchema>;

export const ClaimBoardSchema = z.object({
  columns: z.array(
    z.object({
      status: ClaimStatusSchema,
      total: z.number().int(),
      items: z.array(ClaimCardSchema),
    }),
  ),
});
export type ClaimBoard = z.infer<typeof ClaimBoardSchema>;

export const CLAIM_DATE_FIELDS = ['CREATED', 'ADMISSION'] as const;
export const ClaimListQuerySchema = z.strictObject({
  q: SearchTextSchema.optional(),
  status: ClaimStatusSchema.optional(),
  clientId: ObjectIdSchema.optional(),
  /** Which date `from` and `to` filter on. */
  dateField: z.enum(CLAIM_DATE_FIELDS).default('CREATED'),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ClaimListQuery = z.infer<typeof ClaimListQuerySchema>;
export const ClaimBoardQuerySchema = ClaimListQuerySchema.pick({ q: true, clientId: true });

export const ClaimListResponseSchema = z.object({
  items: z.array(ClaimCardSchema),
  total: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
});
export type ClaimListResponse = z.infer<typeof ClaimListResponseSchema>;

export const CLAIM_EVENT_TYPES = [
  'CREATED',
  'UPDATED',
  'STATUS_CHANGED',
  'REMARK',
  'ASSIGNED',
  'DOCUMENT_UPLOADED',
  'EMAIL_SENT',
  'EMAIL_FAILED',
  'EMAIL_RETRY_REQUESTED',
] as const;
export type ClaimEventType = (typeof CLAIM_EVENT_TYPES)[number];
export const CLAIM_ACTOR_KINDS = ['STAFF', 'EMPLOYEE', 'SYSTEM'] as const;
export type ClaimActorKind = (typeof CLAIM_ACTOR_KINDS)[number];

export const CLAIM_EMAIL_AUDIENCES = ['CLAIMANT', 'HR'] as const;
export const ClaimEmailAudienceSchema = z.enum(CLAIM_EMAIL_AUDIENCES);
export type ClaimEmailAudience = z.infer<typeof ClaimEmailAudienceSchema>;
export const CLAIM_EMAIL_AUDIENCE_LABELS: Record<ClaimEmailAudience, string> = {
  CLAIMANT: 'Claimant',
  HR: 'Company HR',
};

/**
 * Where a notification stands. ACCEPTED means the mail server took the mail; delivery to the
 * inbox is not confirmed (the transport reports no delivery receipts). OUTBOX is the development
 * transport: kept, never delivered.
 */
export const CLAIM_NOTIFICATION_STATUSES = [
  'PENDING',
  'SENDING',
  'ACCEPTED',
  'OUTBOX',
  'FAILED',
] as const;
export type ClaimNotificationStatus = (typeof CLAIM_NOTIFICATION_STATUSES)[number];
export const CLAIM_NOTIFICATION_STATUS_LABELS: Record<ClaimNotificationStatus, string> = {
  PENDING: 'Waiting to send',
  SENDING: 'Sending',
  ACCEPTED: 'Accepted by the mail server',
  OUTBOX: 'Kept in the outbox (not delivered)',
  FAILED: 'Failed',
};

export const ClaimEventSchema = z.object({
  id: ObjectIdSchema,
  type: z.enum(CLAIM_EVENT_TYPES),
  at: IsoDateTimeSchema,
  actor: z.object({ kind: z.enum(CLAIM_ACTOR_KINDS), name: z.string() }),
  description: z.string(),
  fromStatus: ClaimStatusSchema.nullable(),
  toStatus: ClaimStatusSchema.nullable(),
  remark: z.string().nullable(),
  changes: z.array(
    z.object({ field: z.string(), before: z.string().nullable(), after: z.string().nullable() }),
  ),
  email: z
    .object({
      audience: ClaimEmailAudienceSchema,
      recipient: z.string(),
      subject: z.string(),
      attempt: z.number().int(),
      result: z.enum(['ACCEPTED', 'OUTBOX', 'FAILED']),
      error: z.string().nullable(),
    })
    .nullable(),
});
export type ClaimEvent = z.infer<typeof ClaimEventSchema>;

export const ClaimNotificationSchema = z.object({
  id: ObjectIdSchema,
  eventId: ObjectIdSchema,
  audience: ClaimEmailAudienceSchema,
  recipient: z.string(),
  toStatus: ClaimStatusSchema,
  subject: z.string(),
  status: z.enum(CLAIM_NOTIFICATION_STATUSES),
  attempts: z.number().int(),
  lastAttemptAt: IsoDateTimeSchema.nullable(),
  nextAttemptAt: IsoDateTimeSchema.nullable(),
  error: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
});
export type ClaimNotification = z.infer<typeof ClaimNotificationSchema>;

export const ClaimRecordSchema = z.object({
  id: ObjectIdSchema,
  claimNumber: z.string(),
  status: ClaimStatusSchema,
  statusChangedAt: IsoDateTimeSchema,
  daysInStage: z.number().int(),
  source: z.enum(['STAFF', 'EMPLOYEE_LINK']),
  client: z.object({ id: ObjectIdSchema, name: z.string() }),
  policy: z.object({
    ghiCaseId: ObjectIdSchema,
    caseReference: z.string(),
    policyNumber: z.string(),
    insurerName: z.string(),
    policyStart: z.iso.date(),
    policyEnd: z.iso.date(),
  }),
  employee: z.object({ memberId: ObjectIdSchema, employeeId: z.string(), name: z.string() }),
  patient: z.object({
    memberId: ObjectIdSchema,
    name: z.string(),
    relationship: GhiRelationshipSchema,
    gender: z.string(),
    dateOfBirth: z.iso.date(),
  }),
  hospital: z.object({ name: z.string(), city: z.string().nullable() }),
  admissionDate: z.iso.date(),
  dischargeDate: z.iso.date(),
  claimType: ClaimTypeSchema,
  amountClaimed: z.string(),
  contactEmail: z.string(),
  contactPhone: z.string().nullable(),
  assignedTo: z.object({ id: ObjectIdSchema, name: z.string() }).nullable(),
  documents: z.array(ClaimDocumentSchema),
  /** Required documents not yet uploaded; the claim cannot be Submitted until none are missing. */
  missingDocuments: z.array(ClaimDocumentKindSchema),
  /** The statuses the signed-in user may move it to now. */
  allowedMoves: z.array(ClaimStatusSchema),
  /** The signed-in user may edit details and add documents and remarks. */
  canEdit: z.boolean(),
  createdAt: IsoDateTimeSchema,
  createdBy: z.string(),
  updatedAt: IsoDateTimeSchema,
});
export type ClaimRecord = z.infer<typeof ClaimRecordSchema>;

export const ClaimDetailSchema = ClaimRecordSchema.extend({
  /** Every event, oldest first. Never changed once written. */
  timeline: z.array(ClaimEventSchema),
  notifications: z.array(ClaimNotificationSchema),
});
export type ClaimDetail = z.infer<typeof ClaimDetailSchema>;

export const TransitionClaimResponseSchema = z.object({
  claim: ClaimDetailSchema,
  /** The emails queued by the move and where each stands after the first try. */
  notifications: z.array(ClaimNotificationSchema),
});
export type TransitionClaimResponse = z.infer<typeof TransitionClaimResponseSchema>;

// Pickers: placed GHI policies, their employees and the employees' covered members (C2)

export const ClaimPolicySchema = z.object({
  ghiCaseId: ObjectIdSchema,
  caseReference: z.string(),
  clientId: ObjectIdSchema,
  clientName: z.string(),
  policyNumber: z.string(),
  insurerName: z.string(),
  policyStart: z.iso.date(),
  policyEnd: z.iso.date(),
});
export type ClaimPolicy = z.infer<typeof ClaimPolicySchema>;
export const ClaimPolicyListResponseSchema = z.object({ items: z.array(ClaimPolicySchema) });
export const ClaimPolicyQuerySchema = z.strictObject({ clientId: ObjectIdSchema.optional() });
export const ClaimPolicyParamsSchema = z.strictObject({ caseId: ObjectIdSchema });
export const ClaimEmployeeParamsSchema = z.strictObject({
  caseId: ObjectIdSchema,
  memberId: ObjectIdSchema,
});
export const ClaimEmployeeQuerySchema = z.strictObject({ q: SearchTextSchema.optional() });

export const ClaimMemberSchema = z.object({
  memberId: ObjectIdSchema,
  employeeId: z.string(),
  name: z.string(),
  relationship: GhiRelationshipSchema,
  dateOfBirth: z.iso.date(),
});
export type ClaimMember = z.infer<typeof ClaimMemberSchema>;
export const ClaimMemberListResponseSchema = z.object({ items: z.array(ClaimMemberSchema) });

// Employee submission links (C2)

export const CLAIM_LINK_STATUSES = ['ACTIVE', 'USED', 'EXPIRED', 'REVOKED'] as const;
export type ClaimLinkStatus = (typeof CLAIM_LINK_STATUSES)[number];
export const MAX_CLAIM_LINK_DAYS = 30;

export const CreateClaimLinkRequestSchema = z.strictObject({
  ghiCaseId: ObjectIdSchema,
  /** The employee the link is for: it offers only their covered family. */
  employeeMemberId: ObjectIdSchema,
  expiresInDays: z.number().int().min(1).max(MAX_CLAIM_LINK_DAYS).default(7),
  /** How many claims the link can create. */
  maxClaims: z.number().int().min(1).max(10).default(1),
});
export type CreateClaimLinkRequest = z.infer<typeof CreateClaimLinkRequestSchema>;

export const ClaimLinkSchema = z.object({
  id: ObjectIdSchema,
  ghiCaseId: ObjectIdSchema,
  caseReference: z.string(),
  clientName: z.string(),
  employee: z.object({ employeeId: z.string(), name: z.string() }),
  status: z.enum(CLAIM_LINK_STATUSES),
  expiresAt: IsoDateTimeSchema,
  maxClaims: z.number().int(),
  usedClaims: z.number().int(),
  createdAt: IsoDateTimeSchema,
  createdBy: z.string(),
});
export type ClaimLink = z.infer<typeof ClaimLinkSchema>;
export const ClaimLinkListResponseSchema = z.object({ items: z.array(ClaimLinkSchema) });
export const ClaimLinkListQuerySchema = z.strictObject({ ghiCaseId: ObjectIdSchema.optional() });
export const ClaimLinkParamsSchema = z.strictObject({ linkId: ObjectIdSchema });

/** The new link's token, shown once: only its hash is kept. */
export const CreateClaimLinkResponseSchema = z.object({ link: ClaimLinkSchema, token: z.string() });
export type CreateClaimLinkResponse = z.infer<typeof CreateClaimLinkResponseSchema>;

/** A link token: 43 URL-safe characters (32 random bytes). */
export const ClaimLinkTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, 'This link is not valid');
export const PublicClaimLinkParamsSchema = z.strictObject({ token: ClaimLinkTokenSchema });
export const PublicClaimDocumentParamsSchema = z.strictObject({
  token: ClaimLinkTokenSchema,
  claimNumber: z.string().regex(/^CLM-\d{4}-\d{4,}$/, 'Not a claim number'),
});

/** What the employee sees on the link: only their own covered family, by name and relationship. */
export const PublicClaimLinkSchema = z.object({
  clientName: z.string(),
  policyNumber: z.string(),
  insurerName: z.string(),
  policyStart: z.iso.date(),
  policyEnd: z.iso.date(),
  employee: z.object({ employeeId: z.string(), name: z.string() }),
  members: z.array(
    z.object({ memberId: ObjectIdSchema, name: z.string(), relationship: GhiRelationshipSchema }),
  ),
  expiresAt: IsoDateTimeSchema,
  remainingClaims: z.number().int(),
  /** Claims made through this link, for adding their documents. */
  claims: z.array(
    z.object({
      claimNumber: z.string(),
      patientName: z.string(),
      documents: z.array(z.object({ kind: ClaimDocumentKindSchema, fileName: z.string() })),
      missingDocuments: z.array(ClaimDocumentKindSchema),
      /** Documents can be added while the claim is still in Form. */
      open: z.boolean(),
    }),
  ),
});
export type PublicClaimLink = z.infer<typeof PublicClaimLinkSchema>;

export const PublicClaimSubmitRequestSchema = z
  .strictObject({ patientMemberId: ObjectIdSchema, ...ClaimDetailsShape })
  .superRefine(checkDates);
export type PublicClaimSubmitRequest = z.infer<typeof PublicClaimSubmitRequestSchema>;
export type PublicClaimSubmitFormValues = z.input<typeof PublicClaimSubmitRequestSchema>;

export const PublicClaimSubmitResponseSchema = z.object({
  claimNumber: z.string(),
  missingDocuments: z.array(ClaimDocumentKindSchema),
});

// HR contacts per company (C3)

export const ClaimHrContactSchema = z.object({
  clientId: ObjectIdSchema,
  clientName: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  /** HR is emailed at each status change only when switched on and an address is set. */
  notify: z.boolean(),
  updatedAt: IsoDateTimeSchema.nullable(),
  updatedBy: z.string().nullable(),
});
export type ClaimHrContact = z.infer<typeof ClaimHrContactSchema>;
export const ClaimHrContactParamsSchema = z.strictObject({ clientId: ObjectIdSchema });
export const SetClaimHrContactRequestSchema = z
  .strictObject({
    name: OptionalText(120),
    email: blankAsNull(EmailSchema),
    notify: z.boolean(),
  })
  .refine((body) => !body.notify || body.email !== null, {
    path: ['email'],
    message: 'Enter the HR email to notify',
  });
export type SetClaimHrContactRequest = z.infer<typeof SetClaimHrContactRequestSchema>;

// Email templates (C3): one per status a claim can move into, for each audience.

export const CLAIM_MERGE_FIELDS = [
  'claimNumber',
  'employeeName',
  'patientName',
  'companyName',
  'hospital',
  'amount',
  'status',
  'previousStatus',
  'date',
  'remark',
  'recipientName',
] as const;
export type ClaimMergeField = (typeof CLAIM_MERGE_FIELDS)[number];
export type ClaimMergeValues = Record<ClaimMergeField, string>;
export const CLAIM_MERGE_FIELD_LABELS: Record<ClaimMergeField, string> = {
  claimNumber: 'Claim number',
  employeeName: 'Employee name',
  patientName: 'Patient name',
  companyName: 'Company',
  hospital: 'Hospital',
  amount: 'Amount claimed',
  status: 'New status',
  previousStatus: 'Previous status',
  date: 'Date of the change',
  remark: 'Staff remark',
  recipientName: 'Recipient name',
};
export const SAMPLE_CLAIM_MERGE_VALUES: ClaimMergeValues = {
  claimNumber: 'CLM-2026-0001',
  employeeName: 'Ravi Kumar',
  patientName: 'Anita Kumar',
  companyName: 'Nilgiri Software Pvt Ltd',
  hospital: 'Lakeview Hospital, Pune',
  amount: '₹48,500.00',
  status: 'Investigation',
  previousStatus: 'Submitted',
  date: '14 Oct 2026',
  remark: 'The insurer has asked for the pharmacy bills.',
  recipientName: 'Ravi Kumar',
};

type Part = { type: 'text'; text: string } | { type: 'field'; field: ClaimMergeField };
const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g;
const CLAIM_FIELDS: ReadonlySet<string> = new Set(CLAIM_MERGE_FIELDS);

/** Splits a claim template into text and merge fields; unknown fields and stray braces are errors. */
export function parseClaimTemplate(
  source: string,
): { ok: true; parts: Part[] } | { ok: false; errors: string[] } {
  const parts: Part[] = [];
  const errors: string[] = [];
  let last = 0;
  const pushText = (text: string) => {
    if (text.includes('{{') || text.includes('}}')) {
      errors.push('Write merge fields as {{fieldName}}; a lone {{ or }} is not allowed');
    }
    if (text) parts.push({ type: 'text', text });
  };
  for (const match of source.matchAll(PLACEHOLDER)) {
    const name = match[1] ?? '';
    pushText(source.slice(last, match.index));
    if (CLAIM_FIELDS.has(name)) parts.push({ type: 'field', field: name as ClaimMergeField });
    else
      errors.push(`{{${name}}} is not a merge field. Use one of: ${CLAIM_MERGE_FIELDS.join(', ')}`);
    last = match.index + match[0].length;
  }
  pushText(source.slice(last));
  return errors.length > 0 ? { ok: false, errors: [...new Set(errors)] } : { ok: true, parts };
}

/**
 * Fills a claim template. The subject is one line; the HTML body escapes the template and every
 * value, so a remark can never become markup.
 */
export function renderClaimMail(
  template: { subject: string; body: string },
  values: ClaimMergeValues,
): { subject: string; text: string; html: string } {
  const fill = (source: string) => {
    const parsed = parseClaimTemplate(source);
    if (!parsed.ok) throw new Error(`Invalid claim email template: ${parsed.errors.join('; ')}`);
    return parsed.parts
      .map((part) => (part.type === 'text' ? part.text : values[part.field]))
      .join('');
  };
  const subject = fill(template.subject).replace(/\s+/g, ' ').trim();
  const text = fill(template.body.replace(/\r\n?/g, '\n'));
  return { subject, text, html: `<div>${escapeHtml(text).replace(/\n/g, '<br>\n')}</div>` };
}

export const ClaimEmailTemplateSchema = z.object({
  status: ClaimStatusSchema,
  audience: ClaimEmailAudienceSchema,
  subject: z.string(),
  body: z.string(),
  version: z.number().int(),
  isDefault: z.boolean(),
  updatedBy: z.string().nullable(),
  updatedAt: IsoDateTimeSchema,
});
export type ClaimEmailTemplate = z.infer<typeof ClaimEmailTemplateSchema>;
export const ClaimEmailTemplateListResponseSchema = z.object({
  items: z.array(ClaimEmailTemplateSchema),
});
export const ClaimEmailTemplateParamsSchema = z.strictObject({
  status: ClaimStatusSchema,
  audience: ClaimEmailAudienceSchema,
});

function templateIssues(source: string, path: string, context: z.RefinementCtx) {
  const parsed = parseClaimTemplate(source);
  if (!parsed.ok)
    for (const message of parsed.errors)
      context.addIssue({ code: 'custom', path: [path], message });
}

export const UpdateClaimEmailTemplateRequestSchema = z
  .strictObject({
    subject: z
      .string()
      .trim()
      .min(1, 'Enter a subject')
      .max(200, 'Keep the subject under 200 characters'),
    body: z
      .string()
      .max(10_000, 'Keep the message under 10,000 characters')
      .refine((value) => value.trim().length > 0, 'Enter the message'),
    /** The version being edited; saving fails if someone saved a newer one meanwhile. */
    expectedVersion: z.number().int().min(1),
  })
  .superRefine((body, context) => {
    templateIssues(body.subject, 'subject', context);
    templateIssues(body.body, 'body', context);
  });
export type UpdateClaimEmailTemplateRequest = z.infer<typeof UpdateClaimEmailTemplateRequestSchema>;
