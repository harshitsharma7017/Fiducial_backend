import { z } from 'zod';
import { IsoDateTimeSchema, ObjectIdSchema, blankAsNull } from './common.ts';
import {
  MAX_CLAIM_ROWS,
  ProposalRecordSchema,
  RISK_DETAIL_FIELDS,
  type ProposalRecord,
  type RiskDetailKey,
} from './proposals.ts';

// The RFQ as a document of its own (R-1, R-2, R-5): generated from the case, previewed with a few
// edits made on the RFQ itself (its heading, the notes for insurers, risk details, claims), saved
// as v1, v2, v3 at each generation, and approved before it can be sent. Everything else comes
// from the Data Sheet, so nothing is typed twice.

export const RFQ_VERSION_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'RETURNED'] as const;
export const RfqVersionStatusSchema = z.enum(RFQ_VERSION_STATUSES);
export type RfqVersionStatus = z.infer<typeof RfqVersionStatusSchema>;
export const RFQ_VERSION_STATUS_LABELS: Record<RfqVersionStatus, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted for approval',
  APPROVED: 'Approved',
  RETURNED: 'Returned',
};

const RISK_KEYS = RISK_DETAIL_FIELDS.map((field) => field.key) as [
  RiskDetailKey,
  ...RiskDetailKey[],
];
const OptionalText = (max: number) => blankAsNull(z.string().trim().max(max, 'This is too long'));

const ClaimRowSchema = z.strictObject({
  period: z.string().trim().min(1, 'Enter the policy period').max(20),
  policyType: OptionalText(100),
  sumInsured: blankAsNull(
    z
      .string()
      .trim()
      .regex(/^\d{1,13}$/, 'Enter whole rupees'),
  ),
  premium: blankAsNull(
    z
      .string()
      .trim()
      .regex(/^\d{1,13}$/, 'Enter whole rupees'),
  ),
  claimedAmount: blankAsNull(
    z
      .string()
      .trim()
      .regex(/^\d{1,13}$/, 'Enter whole rupees'),
  ),
  remarks: OptionalText(300),
  insurer: OptionalText(200),
});

/**
 * The edits made on the RFQ (R-2). Each one replaces the Data Sheet's value on the RFQ only; a
 * field left out (null, or no entry) shows the Data Sheet's.
 */
export const RfqEditsSchema = z.strictObject({
  /** The heading of premium details ("RFQ FOR THE RENEWAL OF 2026-27"). */
  title: OptionalText(200),
  /** The notes for the insurers. */
  notes: OptionalText(1000),
  /** Risk details answers by location. */
  risk: z
    .array(
      z.strictObject({
        locationId: ObjectIdSchema,
        key: z.enum(RISK_KEYS),
        value: OptionalText(300),
      }),
    )
    .max(2000),
  /** The claims table as a whole; null keeps the Data Sheet's. */
  claims: z.array(ClaimRowSchema).max(MAX_CLAIM_ROWS).nullable(),
});
export type RfqEdits = z.infer<typeof RfqEditsSchema>;
export type RfqEditsFormValues = z.input<typeof RfqEditsSchema>;
export const NO_RFQ_EDITS: RfqEdits = { title: null, notes: null, risk: [], claims: null };

export const RfqCommentRequestSchema = z.strictObject({
  comment: OptionalText(1000).default(null),
});
/** Returning a version needs the reason. */
export const RfqReturnRequestSchema = z.strictObject({
  comment: z.string().trim().min(1, 'Say what needs changing').max(1000, 'This is too long'),
});

const EventSchema = z.object({
  action: z.enum(['GENERATED', 'SUBMITTED', 'APPROVED', 'RETURNED']),
  at: IsoDateTimeSchema,
  by: z.string(),
  comment: z.string().nullable(),
});

export const RfqVersionSummarySchema = z.object({
  version: z.number().int().min(1),
  status: RfqVersionStatusSchema,
  /** The layout it was filled in: the client's template, or the built-in one. */
  layout: z.enum(['template', 'built-in']),
  fileName: z.string(),
  createdAt: IsoDateTimeSchema,
  createdBy: z.string(),
  events: z.array(EventSchema),
});
export type RfqVersionSummary = z.infer<typeof RfqVersionSummarySchema>;

export const RfqVersionSchema = RfqVersionSummarySchema.extend({
  /** The case and the edits as the version was generated from them, for its preview. */
  record: ProposalRecordSchema,
  edits: RfqEditsSchema,
});
export type RfqVersion = z.infer<typeof RfqVersionSchema>;

export const RfqStateSchema = z.object({
  edits: RfqEditsSchema,
  editsUpdatedAt: IsoDateTimeSchema.nullable(),
  editsUpdatedBy: z.string().nullable(),
  /** Newest first. */
  versions: z.array(RfqVersionSummarySchema),
  /**
   * The latest version, and whether the case or the edits changed since it was generated (then a
   * new version is needed before sending).
   */
  current: z
    .object({ version: z.number().int(), status: RfqVersionStatusSchema, stale: z.boolean() })
    .nullable(),
  /** True when the RFQ may go to insurers: the latest version approved and still current. */
  sendable: z.boolean(),
  /** Why it may not be sent yet, when it may not. */
  blocked: z.string().nullable(),
});
export type RfqState = z.infer<typeof RfqStateSchema>;

export const RfqVersionParamsSchema = z.strictObject({
  id: ObjectIdSchema,
  version: z.coerce.number().int().min(1).max(10_000),
});
export const RfqVersionFileQuerySchema = z.strictObject({
  format: z.enum(['xlsx', 'pdf']).default('xlsx'),
});

// Pure helpers used by both repos

/** "2026-27" for a policy starting in 2026. */
export function policyYearOf(date: string): string {
  const year = Number(date.slice(0, 4));
  return `${year}-${String((year + 1) % 100).padStart(2, '0')}`;
}

/** The RFQ's heading: the edited one, else as the client's RFQ words it. */
export function rfqTitleOf(
  record: Pick<ProposalRecord, 'type' | 'policyStart' | 'dueDate'>,
  edits: Pick<RfqEdits, 'title'>,
): string {
  if (edits.title) return edits.title;
  const year = policyYearOf(record.policyStart ?? record.dueDate);
  return record.type === 'EXISTING'
    ? `RFQ FOR THE RENEWAL OF ${year}`
    : `RFQ FOR NEW BUSINESS ${year}`;
}

/** The case as the RFQ prints it: the Data Sheet with the RFQ's edits in place (R-2). */
export function applyRfqEdits(record: ProposalRecord, edits: RfqEdits): ProposalRecord {
  const risk = new Map(
    edits.risk.map((entry) => [`${entry.locationId}|${entry.key}`, entry.value]),
  );
  return {
    ...record,
    notes: edits.notes ?? record.notes,
    claims: edits.claims ?? record.claims,
    locations: record.locations.map((location) => ({
      ...location,
      risk: Object.fromEntries(
        Object.entries(location.risk).map(([key, value]) => {
          const edited = risk.get(`${location.locationId}|${key}`);
          return [key, edited === undefined ? value : edited];
        }),
      ),
    })),
  };
}
