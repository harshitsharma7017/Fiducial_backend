import { z } from 'zod';
import { ClaimStatusSchema, type ClaimStatus } from './claims.ts';
import { parseCensusDate, parseRelationship, parseGender } from './census-rules.ts';
import { IsoDateTimeSchema, ObjectIdSchema } from './common.ts';
import { headerKey } from './eb-census.ts';
import { EbProductSchema } from './eb-products.ts';
import { GhiRelationshipSchema, type GhiRelationship } from './ghi-census.ts';
import { icdChapterOf, primaryIcdCode } from './icd.ts';

// TPA claims (N9): claims as a TPA's Excel export reports them, imported through a format that
// maps the TPA's own column headers to these fields. A TPA record is kept apart from the claims
// board (C1 to C4): it never changes a board claim's status, details or emails, and links to one
// only through reliable identifiers. Its source values are kept beside the normalised ones.

export const TPA_CLAIM_FIELDS = [
  'tpaClaimId',
  'parentClaimId',
  'requestType',
  'employeeId',
  'memberName',
  'tpaMemberId',
  'relationship',
  'gender',
  'dateOfBirth',
  'age',
  'admissionDate',
  'dischargeDate',
  'diagnosis',
  'icdCode',
  'claimType',
  'hospital',
  'hospitalCity',
  'claimedAmount',
  'sanctionedAmount',
  'settledAmount',
  'disallowedAmount',
  'status',
  'rejectionReason',
  'settlementDate',
  'bankAccount',
] as const;
export type TpaClaimField = (typeof TPA_CLAIM_FIELDS)[number];
export const TpaClaimFieldSchema = z.enum(TPA_CLAIM_FIELDS);

export type TpaFieldKind = 'TEXT' | 'DATE' | 'AMOUNT' | 'INTEGER' | 'CODE';
export const TPA_FIELD_INFO: Record<
  TpaClaimField,
  { label: string; kind: TpaFieldKind; sensitive?: true }
> = {
  tpaClaimId: { label: 'TPA claim ID', kind: 'CODE' },
  parentClaimId: { label: 'Main claim ID (for pre-auth / pre-post records)', kind: 'CODE' },
  requestType: { label: 'Request type', kind: 'CODE' },
  employeeId: { label: 'Employee ID', kind: 'CODE' },
  memberName: { label: 'Member (patient) name', kind: 'TEXT' },
  tpaMemberId: { label: 'TPA member ID / UHID', kind: 'CODE' },
  relationship: { label: 'Relationship', kind: 'CODE' },
  gender: { label: 'Gender', kind: 'CODE' },
  dateOfBirth: { label: 'Date of birth', kind: 'DATE' },
  age: { label: 'Age', kind: 'INTEGER' },
  admissionDate: { label: 'Admission date', kind: 'DATE' },
  dischargeDate: { label: 'Discharge date', kind: 'DATE' },
  diagnosis: { label: 'Diagnosis', kind: 'TEXT', sensitive: true },
  icdCode: { label: 'ICD code', kind: 'CODE', sensitive: true },
  claimType: { label: 'Cashless / reimbursement', kind: 'CODE' },
  hospital: { label: 'Hospital', kind: 'TEXT' },
  hospitalCity: { label: 'Hospital city', kind: 'TEXT' },
  claimedAmount: { label: 'Claimed amount', kind: 'AMOUNT' },
  sanctionedAmount: { label: 'Sanctioned amount', kind: 'AMOUNT' },
  settledAmount: { label: 'Settled amount', kind: 'AMOUNT' },
  disallowedAmount: { label: 'Disallowed amount', kind: 'AMOUNT' },
  status: { label: 'Claim status', kind: 'CODE' },
  rejectionReason: { label: 'Rejection reason', kind: 'TEXT', sensitive: true },
  settlementDate: { label: 'Settlement date', kind: 'DATE' },
  bankAccount: { label: 'Bank account number (masked; full only for claims.admin)', kind: 'CODE' },
};
/** Financial fields shown in full only to claims.admin (N12); everyone else sees them masked. */
export const TPA_BANK_FIELDS: readonly TpaClaimField[] = ['bankAccount'];
/** Fields whose values never appear in issues, history or error reports. */
export const TPA_PRIVATE_FIELDS: readonly TpaClaimField[] = [
  'diagnosis',
  'icdCode',
  'rejectionReason',
  'bankAccount',
];
/** Fields only users who process claims see (claims.process): diagnosis details. */
export const TPA_SENSITIVE_FIELDS = TPA_CLAIM_FIELDS.filter(
  (field) => TPA_FIELD_INFO[field].sensitive,
);

/**
 * The claim statuses, defined once (N10 A): each TPA record is in exactly one. A source status
 * is classified only by its format's status map; an unmapped status is a row error.
 */
export const TPA_CLAIM_STATUSES = ['SETTLED', 'OUTSTANDING', 'REJECTED', 'WITHDRAWN'] as const;
export type TpaClaimStatus = (typeof TPA_CLAIM_STATUSES)[number];
export const TpaClaimStatusSchema = z.enum(TPA_CLAIM_STATUSES);
export const TPA_CLAIM_STATUS_LABELS: Record<TpaClaimStatus, string> = {
  SETTLED: 'Settled (paid)',
  OUTSTANDING: 'Outstanding',
  REJECTED: 'Rejected / repudiated',
  WITHDRAWN: 'Withdrawn / closed without payment',
};

export const TPA_REQUEST_TYPES = ['MAIN', 'PRE_AUTH', 'PRE_POST'] as const;
export type TpaRequestType = (typeof TPA_REQUEST_TYPES)[number];
export const TpaRequestTypeSchema = z.enum(TPA_REQUEST_TYPES);
export const TPA_REQUEST_TYPE_LABELS: Record<TpaRequestType, string> = {
  MAIN: 'Main claim',
  PRE_AUTH: 'Pre-authorisation',
  PRE_POST: 'Pre / post-hospitalisation',
};

export const TPA_CLAIM_TYPES = ['CASHLESS', 'REIMBURSEMENT'] as const;
export type TpaClaimType = (typeof TPA_CLAIM_TYPES)[number];
export const TpaClaimTypeSchema = z.enum(TPA_CLAIM_TYPES);

/** The client's examples for the board (N11), offered as starting values; a format uses only what it saves. */
export const TPA_SUGGESTED_BOARD_MAP: ReadonlyArray<{ source: string; boardStatus: ClaimStatus }> =
  [
    { source: 'Registration', boardStatus: 'SUBMITTED' },
    { source: 'For Investigation', boardStatus: 'INVESTIGATION' },
    { source: 'Settled', boardStatus: 'APPROVED' },
  ];

/**
 * The board column for a TPA status (N11 1): the company's override, else the format's map, else
 * null (unmapped: no board claim is moved or added).
 */
export function boardStatusFor(
  rules: {
    boardStatusMap: ReadonlyArray<{ source: string; boardStatus: ClaimStatus }>;
    boardStatusOverrides: ReadonlyArray<{
      clientId: string;
      source: string;
      boardStatus: ClaimStatus;
    }>;
  },
  clientId: string,
  sourceStatus: string,
): ClaimStatus | null {
  const key = sourceKey(sourceStatus);
  const override = rules.boardStatusOverrides.find(
    (entry) => entry.clientId === clientId && sourceKey(entry.source) === key,
  );
  if (override) return override.boardStatus;
  return rules.boardStatusMap.find((entry) => sourceKey(entry.source) === key)?.boardStatus ?? null;
}

/** Typical source values, offered to fill a new format's maps; a format uses only what it saves. */
export const TPA_SUGGESTED_STATUS_MAP: ReadonlyArray<{ source: string; status: TpaClaimStatus }> = [
  { source: 'Settled', status: 'SETTLED' },
  { source: 'Paid', status: 'SETTLED' },
  { source: 'Outstanding', status: 'OUTSTANDING' },
  { source: 'Under Process', status: 'OUTSTANDING' },
  { source: 'Query Raised', status: 'OUTSTANDING' },
  { source: 'Approved', status: 'OUTSTANDING' },
  { source: 'Rejected', status: 'REJECTED' },
  { source: 'Repudiated', status: 'REJECTED' },
  { source: 'Withdrawn', status: 'WITHDRAWN' },
  { source: 'Closed', status: 'WITHDRAWN' },
];
export const TPA_DEFAULT_REQUEST_TYPES: ReadonlyArray<{
  source: string;
  requestType: TpaRequestType;
}> = [
  { source: 'Main', requestType: 'MAIN' },
  { source: 'Claim', requestType: 'MAIN' },
  { source: 'Main Claim', requestType: 'MAIN' },
  { source: 'Pre Auth', requestType: 'PRE_AUTH' },
  { source: 'Preauth', requestType: 'PRE_AUTH' },
  { source: 'Pre Authorisation', requestType: 'PRE_AUTH' },
  { source: 'Pre Authorization', requestType: 'PRE_AUTH' },
  { source: 'Pre Post', requestType: 'PRE_POST' },
  { source: 'Pre Hospitalisation', requestType: 'PRE_POST' },
  { source: 'Post Hospitalisation', requestType: 'PRE_POST' },
];
export const TPA_DEFAULT_CLAIM_TYPES: ReadonlyArray<{ source: string; claimType: TpaClaimType }> = [
  { source: 'Cashless', claimType: 'CASHLESS' },
  { source: 'CL', claimType: 'CASHLESS' },
  { source: 'Reimbursement', claimType: 'REIMBURSEMENT' },
  { source: 'RI', claimType: 'REIMBURSEMENT' },
  { source: 'Reimb', claimType: 'REIMBURSEMENT' },
];

/** A source value as compared: case, spaces, dots, dashes and underscores ignored. */
export const sourceKey = (text: string) => text.toLowerCase().replace(/[\s._\-/]+/g, '');

// Formats

const Source = z.string().trim().min(1, 'Enter the value as the TPA writes it').max(100);

function uniqueSources(
  entries: readonly { source: string }[],
  context: z.RefinementCtx,
  path: string,
) {
  const seen = new Map<string, number>();
  entries.forEach((entry, index) => {
    const key = sourceKey(entry.source);
    const first = seen.get(key);
    if (first !== undefined) {
      context.addIssue({
        code: 'custom',
        path: [path, index, 'source'],
        message: `"${entry.source}" is already mapped on line ${first + 1}`,
      });
    } else seen.set(key, index);
  });
}

export const TpaFormatInputSchema = z
  .strictObject({
    name: z.string().trim().min(1, 'Name the format').max(80, 'Use at most 80 characters'),
    /** The TPA's code: part of every claim's key, so it never changes once claims are imported. */
    tpaCode: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9_-]{2,20}$/, 'Use 2 to 20 letters, digits, - or _'),
    description: z.string().trim().max(500).nullable().default(null),
    /** The sheet holding the claims; null: the first sheet. */
    sheetName: z.string().trim().max(31).nullable().default(null),
    /** The row with the column headers (1 for the first row). */
    headerRow: z.number().int().min(1).max(50).default(1),
    mappings: z
      .array(
        z.strictObject({
          field: TpaClaimFieldSchema,
          header: z.string().trim().min(1, 'Enter the column header').max(200),
          required: z.boolean(),
        }),
      )
      .min(1, 'Map at least the TPA claim ID and the status')
      .max(TPA_CLAIM_FIELDS.length),
    statusMap: z
      .array(z.strictObject({ source: Source, status: TpaClaimStatusSchema }))
      .min(1, 'Map at least one status')
      .max(100),
    requestTypeMap: z
      .array(z.strictObject({ source: Source, requestType: TpaRequestTypeSchema }))
      .max(50)
      .default([]),
    claimTypeMap: z
      .array(z.strictObject({ source: Source, claimType: TpaClaimTypeSchema }))
      .max(50)
      .default([]),
    relationshipMap: z
      .array(z.strictObject({ source: Source, relationship: GhiRelationshipSchema }))
      .max(50)
      .default([]),
    /** Extra source columns kept with each claim for traceability (not sensitive ones). */
    keepColumns: z.array(z.string().trim().min(1).max(200)).max(30).default([]),
    /** A row whose employee or patient cannot be found in the census is refused (else a warning). */
    requireMemberMatch: z.boolean().default(false),
    /**
     * N11: the board column each TPA status puts a claim in. A status not listed moves no board
     * claim and is reported as unmapped; it is never put in a column by guess.
     */
    boardStatusMap: z
      .array(z.strictObject({ source: Source, boardStatus: ClaimStatusSchema }))
      .max(100)
      .default([]),
    /** N11: a company's own board column for a TPA status, over the map above. */
    boardStatusOverrides: z
      .array(
        z.strictObject({
          clientId: ObjectIdSchema,
          source: Source,
          boardStatus: ClaimStatusSchema,
        }),
      )
      .max(200)
      .default([]),
    /** N11: whether an import moves a board claim (only to a later column) or never. */
    boardUpdate: z.enum(['FORWARD_ONLY', 'NEVER']).default('FORWARD_ONLY'),
    /** N11: add a matched GMC claim that is not on the board yet. */
    createBoardClaims: z.boolean().default(true),
  })
  .superRefine((input, context) => {
    const fields = new Map<string, number>();
    const headers = new Map<string, number>();
    input.mappings.forEach((mapping, index) => {
      const first = fields.get(mapping.field);
      if (first !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['mappings', index, 'field'],
          message: 'This field is already mapped',
        });
      } else fields.set(mapping.field, index);
      const header = headerKey(mapping.header);
      const other = headers.get(header);
      if (other !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['mappings', index, 'header'],
          message: `Column "${mapping.header}" is already mapped on line ${other + 1}`,
        });
      } else headers.set(header, index);
    });
    for (const field of ['tpaClaimId', 'status'] as const) {
      const mapping = input.mappings.find((item) => item.field === field);
      if (!mapping || !mapping.required) {
        context.addIssue({
          code: 'custom',
          path: ['mappings'],
          message: `Map the ${TPA_FIELD_INFO[field].label} as a required column`,
        });
      }
    }
    uniqueSources(input.statusMap, context, 'statusMap');
    uniqueSources(input.requestTypeMap, context, 'requestTypeMap');
    uniqueSources(input.claimTypeMap, context, 'claimTypeMap');
    uniqueSources(input.relationshipMap, context, 'relationshipMap');
    uniqueSources(input.boardStatusMap, context, 'boardStatusMap');
    const overrides = new Map<string, number>();
    input.boardStatusOverrides.forEach((entry, index) => {
      const key = `${entry.clientId}|${sourceKey(entry.source)}`;
      const first = overrides.get(key);
      if (first !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['boardStatusOverrides', index, 'source'],
          message: `Already set for this company on line ${first + 1}`,
        });
      } else overrides.set(key, index);
    });
    for (const [index, column] of input.keepColumns.entries()) {
      if (headers.has(headerKey(column))) {
        context.addIssue({
          code: 'custom',
          path: ['keepColumns', index],
          message: 'This column is already mapped to a field',
        });
      }
    }
  });
export type TpaFormatInput = z.infer<typeof TpaFormatInputSchema>;
export type TpaFormatFormValues = z.input<typeof TpaFormatInputSchema>;

export const TpaFormatSchema = z.object({
  id: ObjectIdSchema,
  name: z.string(),
  tpaCode: z.string(),
  description: z.string().nullable(),
  sheetName: z.string().nullable(),
  headerRow: z.number().int(),
  mappings: z.array(
    z.object({ field: TpaClaimFieldSchema, header: z.string(), required: z.boolean() }),
  ),
  statusMap: z.array(z.object({ source: z.string(), status: TpaClaimStatusSchema })),
  requestTypeMap: z.array(z.object({ source: z.string(), requestType: TpaRequestTypeSchema })),
  claimTypeMap: z.array(z.object({ source: z.string(), claimType: TpaClaimTypeSchema })),
  relationshipMap: z.array(z.object({ source: z.string(), relationship: GhiRelationshipSchema })),
  keepColumns: z.array(z.string()),
  requireMemberMatch: z.boolean(),
  boardStatusMap: z.array(z.object({ source: z.string(), boardStatus: ClaimStatusSchema })),
  boardStatusOverrides: z.array(
    z.object({ clientId: ObjectIdSchema, source: z.string(), boardStatus: ClaimStatusSchema }),
  ),
  boardUpdate: z.enum(['FORWARD_ONLY', 'NEVER']),
  createBoardClaims: z.boolean(),
  active: z.boolean(),
  revision: z.number().int(),
  updatedAt: IsoDateTimeSchema,
  updatedBy: z.string(),
});
export type TpaFormat = z.infer<typeof TpaFormatSchema>;
export const TpaFormatListResponseSchema = z.object({ items: z.array(TpaFormatSchema) });
export const TpaFormatParamsSchema = z.strictObject({ formatId: ObjectIdSchema });

// Rows

/** A cell as the importer reads it: text, or a date an Excel cell held as a date. */
export type TpaCell = string | { date: string };

export interface TpaRowIssue {
  field: TpaClaimField | null;
  /** The value as read, only for fields that are not sensitive. */
  value: string | null;
  message: string;
  severity: 'ERROR' | 'WARNING';
  code: string;
}

/** A row's normalised values (amounts in rupees with paise as text). */
export interface TpaNormalisedRow {
  tpaClaimId: string;
  claimKey: string;
  parentClaimId: string | null;
  requestType: TpaRequestType;
  sourceRequestType: string | null;
  employeeId: string | null;
  memberName: string | null;
  tpaMemberId: string | null;
  relationship: GhiRelationship | null;
  sourceRelationship: string | null;
  gender: 'MALE' | 'FEMALE' | 'OTHER' | null;
  dateOfBirth: string | null;
  age: number | null;
  admissionDate: string | null;
  dischargeDate: string | null;
  diagnosis: string | null;
  icdCode: string | null;
  claimType: TpaClaimType | null;
  sourceClaimType: string | null;
  hospital: string | null;
  hospitalCity: string | null;
  claimedAmount: string | null;
  sanctionedAmount: string | null;
  settledAmount: string | null;
  disallowedAmount: string | null;
  status: TpaClaimStatus;
  sourceStatus: string;
  rejectionReason: string | null;
  settlementDate: string | null;
  bankAccount: string | null;
}

/** The claim ID as compared: trimmed, upper case, inner spaces removed. */
export const claimKeyOf = (id: string) => id.trim().toUpperCase().replace(/\s+/g, '');

const TIME_SUFFIX = /\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?$/i;

/** A TPA date: an Excel date, or text as the census reads it (day first), time of day ignored. */
export function parseTpaDate(
  cell: TpaCell,
): { ok: true; date: string | null } | { ok: false; message: string } {
  if (typeof cell !== 'string') return { ok: true, date: cell.date };
  const text = cell.trim().replace(TIME_SUFFIX, '');
  if (!text) return { ok: true, date: null };
  const parsed = parseCensusDate(text);
  return parsed.ok ? { ok: true, date: parsed.date } : { ok: false, message: parsed.message };
}

/** Rupees with at most 2 decimals; blank is no amount. Negative amounts are refused. */
export function parseTpaAmount(
  text: string,
): { ok: true; amount: string | null } | { ok: false; message: string } {
  const cleaned = text.replace(/[₹,\s]/g, '').replace(/^(rs\.?|inr)/i, '');
  if (cleaned === '' || cleaned === '-') return { ok: true, amount: null };
  if (/^\(.*\)$/.test(cleaned) || cleaned.startsWith('-')) {
    return { ok: false, message: 'Amounts cannot be negative' };
  }
  const match = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return { ok: false, message: 'Not an amount in rupees (at most 2 decimals)' };
  const whole = match[1]!.replace(/^0+(?=\d)/, '');
  return { ok: true, amount: `${whole}.${(match[2] ?? '').padEnd(2, '0')}` };
}

export interface TpaFormatRules {
  mappings: ReadonlyArray<{ field: TpaClaimField; required: boolean }>;
  statusMap: ReadonlyArray<{ source: string; status: TpaClaimStatus }>;
  requestTypeMap: ReadonlyArray<{ source: string; requestType: TpaRequestType }>;
  claimTypeMap: ReadonlyArray<{ source: string; claimType: TpaClaimType }>;
  relationshipMap: ReadonlyArray<{ source: string; relationship: GhiRelationship }>;
}

function lookup<T>(
  entries: ReadonlyArray<{ source: string } & Record<string, unknown>>,
  key: string,
  target: string,
  fallback: ReadonlyArray<{ source: string } & Record<string, unknown>> = [],
) {
  const wanted = sourceKey(key);
  const found =
    entries.find((entry) => sourceKey(entry.source) === wanted) ??
    fallback.find((entry) => sourceKey(entry.source) === wanted);
  return found ? (found[target] as T) : null;
}

/**
 * Reads one row of a TPA export into normalised values (N9 2): every problem is reported on its
 * field, with the value as read for fields that are not sensitive. Returns null values when the
 * row cannot be imported (an ERROR issue).
 */
export function parseTpaRow(
  cells: Partial<Record<TpaClaimField, TpaCell>>,
  rules: TpaFormatRules,
): { row: TpaNormalisedRow | null; issues: TpaRowIssue[] } {
  const issues: TpaRowIssue[] = [];
  const text = (field: TpaClaimField) => {
    const cell = cells[field];
    if (cell === undefined) return '';
    return typeof cell === 'string' ? cell.trim().replace(/\s+/g, ' ') : cell.date;
  };
  const issue = (
    field: TpaClaimField | null,
    message: string,
    code: string,
    severity: 'ERROR' | 'WARNING' = 'ERROR',
  ) =>
    issues.push({
      field,
      value: field && !TPA_PRIVATE_FIELDS.includes(field) ? text(field) || null : null,
      message,
      severity,
      code,
    });
  for (const mapping of rules.mappings) {
    if (mapping.required && text(mapping.field) === '') {
      issue(
        mapping.field,
        `${TPA_FIELD_INFO[mapping.field].label} is required by this format and is blank`,
        'REQUIRED',
      );
    }
  }
  const tpaClaimId = text('tpaClaimId');
  if (!tpaClaimId) {
    if (!issues.some((item) => item.field === 'tpaClaimId'))
      issue('tpaClaimId', 'The TPA claim ID is blank', 'REQUIRED');
  } else if (tpaClaimId.length > 60)
    issue('tpaClaimId', 'The TPA claim ID is longer than 60 characters', 'INVALID');

  const dates: Partial<Record<TpaClaimField, string | null>> = {};
  for (const field of [
    'dateOfBirth',
    'admissionDate',
    'dischargeDate',
    'settlementDate',
  ] as const) {
    const cell = cells[field];
    if (cell === undefined) {
      dates[field] = null;
      continue;
    }
    const parsed = parseTpaDate(cell);
    if (parsed.ok) dates[field] = parsed.date;
    else issue(field, `${TPA_FIELD_INFO[field].label}: ${parsed.message}`, 'DATE');
  }
  if (dates.admissionDate && dates.dischargeDate && dates.dischargeDate < dates.admissionDate) {
    issue('dischargeDate', 'The discharge date is before the admission date', 'DATES');
  }
  const amounts: Partial<Record<TpaClaimField, string | null>> = {};
  for (const field of [
    'claimedAmount',
    'sanctionedAmount',
    'settledAmount',
    'disallowedAmount',
  ] as const) {
    const parsed = parseTpaAmount(text(field));
    if (parsed.ok) amounts[field] = parsed.amount;
    else issue(field, `${TPA_FIELD_INFO[field].label}: ${parsed.message}`, 'AMOUNT');
  }
  let age: number | null = null;
  const ageText = text('age');
  if (ageText) {
    const match = /^(\d{1,3})(?:\s*(?:y|yr|yrs|years?))?$/i.exec(ageText);
    if (!match || Number(match[1]) > 120)
      issue('age', 'The age must be a whole number of years, 0 to 120', 'INVALID');
    else age = Number(match[1]);
  }

  const sourceStatus = text('status');
  const status = sourceStatus
    ? lookup<TpaClaimStatus>(rules.statusMap, sourceStatus, 'status')
    : null;
  if (sourceStatus && !status) {
    issue(
      'status',
      `"${sourceStatus}" is not a status this format maps: add it to the format's statuses`,
      'UNSUPPORTED_STATUS',
    );
  } else if (!sourceStatus && !issues.some((item) => item.field === 'status')) {
    issue('status', 'The claim status is blank', 'REQUIRED');
  }
  const sourceRequestType = text('requestType') || null;
  const requestType = sourceRequestType
    ? lookup<TpaRequestType>(
        rules.requestTypeMap,
        sourceRequestType,
        'requestType',
        TPA_DEFAULT_REQUEST_TYPES,
      )
    : 'MAIN';
  if (!requestType)
    issue(
      'requestType',
      `"${sourceRequestType}" is not a request type this format maps`,
      'UNSUPPORTED_REQUEST_TYPE',
    );
  const sourceClaimType = text('claimType') || null;
  const claimType = sourceClaimType
    ? lookup<TpaClaimType>(
        rules.claimTypeMap,
        sourceClaimType,
        'claimType',
        TPA_DEFAULT_CLAIM_TYPES,
      )
    : null;
  if (sourceClaimType && !claimType)
    issue(
      'claimType',
      `"${sourceClaimType}" is neither cashless nor reimbursement in this format`,
      'UNSUPPORTED_CLAIM_TYPE',
    );
  const sourceRelationship = text('relationship') || null;
  const relationship = sourceRelationship
    ? (lookup<GhiRelationship>(rules.relationshipMap, sourceRelationship, 'relationship') ??
      parseRelationship(sourceRelationship))
    : null;
  if (sourceRelationship && !relationship)
    issue(
      'relationship',
      `"${sourceRelationship}" is not a relationship: map it in the format`,
      'INVALID_RELATIONSHIP',
    );
  const genderText = text('gender');
  const gender = genderText ? parseGender(genderText) : null;
  if (genderText && !gender)
    issue('gender', `"${genderText}" is not a gender`, 'INVALID', 'WARNING');
  const parentClaimId = text('parentClaimId') || null;
  if (parentClaimId && tpaClaimId && claimKeyOf(parentClaimId) === claimKeyOf(tpaClaimId)) {
    issue('parentClaimId', 'A record cannot be its own main claim', 'INVALID');
  }
  if (requestType === 'MAIN' && parentClaimId) {
    issue(
      'parentClaimId',
      'A main claim names a main claim: check the request type',
      'INVALID',
      'WARNING',
    );
  }

  const bankText = text('bankAccount').replace(/[\s-]+/g, '');
  if (bankText && !/^[A-Za-z0-9]{6,34}$/.test(bankText)) {
    issue(
      'bankAccount',
      'The bank account number is not 6 to 34 letters or digits: it is not kept',
      'INVALID',
      'WARNING',
    );
  }
  const icd = primaryIcdCode(text('icdCode'));
  if (icd && !icdChapterOf(icd))
    issue(
      'icdCode',
      'The ICD code is not a valid ICD-10 code: the claim is counted as unclassified',
      'ICD',
      'WARNING',
    );

  if (issues.some((item) => item.severity === 'ERROR') || !status || !requestType || !tpaClaimId)
    return { row: null, issues };
  const optional = (field: TpaClaimField, max = 300) => {
    const value = text(field);
    return value ? value.slice(0, max) : null;
  };
  return {
    row: {
      tpaClaimId,
      claimKey: claimKeyOf(tpaClaimId),
      parentClaimId,
      requestType,
      sourceRequestType,
      employeeId: optional('employeeId', 40),
      memberName: optional('memberName', 120),
      tpaMemberId: optional('tpaMemberId', 60),
      relationship,
      sourceRelationship,
      gender,
      dateOfBirth: dates.dateOfBirth ?? null,
      age,
      admissionDate: dates.admissionDate ?? null,
      dischargeDate: dates.dischargeDate ?? null,
      diagnosis: optional('diagnosis', 500),
      icdCode: icd,
      claimType,
      sourceClaimType,
      hospital: optional('hospital', 200),
      hospitalCity: optional('hospitalCity', 100),
      claimedAmount: amounts.claimedAmount ?? null,
      sanctionedAmount: amounts.sanctionedAmount ?? null,
      settledAmount: amounts.settledAmount ?? null,
      disallowedAmount: amounts.disallowedAmount ?? null,
      status,
      sourceStatus,
      rejectionReason: optional('rejectionReason', 500),
      settlementDate: dates.settlementDate ?? null,
      bankAccount: bankText && /^[A-Za-z0-9]{6,34}$/.test(bankText) ? bankText.toUpperCase() : null,
    },
    issues,
  };
}

/** The fields compared on a re-import: a record changes only when one of these does. */
export const TPA_COMPARED_FIELDS = [
  'parentClaimId',
  'requestType',
  'employeeId',
  'memberName',
  'tpaMemberId',
  'relationship',
  'gender',
  'dateOfBirth',
  'age',
  'admissionDate',
  'dischargeDate',
  'diagnosis',
  'icdCode',
  'claimType',
  'hospital',
  'hospitalCity',
  'claimedAmount',
  'sanctionedAmount',
  'settledAmount',
  'disallowedAmount',
  'status',
  'sourceStatus',
  'rejectionReason',
  'settlementDate',
  'bankAccount',
] as const satisfies readonly (keyof TpaNormalisedRow)[];

/** The fields of a record that differ from a row (null and missing are equal). */
export function changedTpaFields(
  stored: Partial<Record<(typeof TPA_COMPARED_FIELDS)[number], unknown>>,
  row: TpaNormalisedRow,
): Array<(typeof TPA_COMPARED_FIELDS)[number]> {
  return TPA_COMPARED_FIELDS.filter((field) => (stored[field] ?? null) !== (row[field] ?? null));
}

// Imports and records as the API returns them

export const TPA_IMPORT_STATUSES = [
  'VALIDATED',
  'IMPORTING',
  'IMPORTED',
  'DISCARDED',
  'FAILED',
] as const;
export type TpaImportStatus = (typeof TPA_IMPORT_STATUSES)[number];
export const TPA_ROW_ACTIONS = ['CREATE', 'UPDATE', 'UNCHANGED', 'INVALID'] as const;
export type TpaRowAction = (typeof TPA_ROW_ACTIONS)[number];
export const TPA_IMPORT_POLICIES = ['ALL_VALID', 'VALID_ONLY'] as const;
export type TpaImportPolicy = (typeof TPA_IMPORT_POLICIES)[number];

export const TpaRowIssueSchema = z.object({
  field: TpaClaimFieldSchema.nullable(),
  value: z.string().nullable(),
  message: z.string(),
  severity: z.enum(['ERROR', 'WARNING']),
  code: z.string(),
});

export const TpaImportSchema = z.object({
  id: ObjectIdSchema,
  caseId: ObjectIdSchema,
  caseReference: z.string(),
  formatId: ObjectIdSchema,
  formatName: z.string(),
  formatRevision: z.number().int(),
  tpaCode: z.string(),
  fileName: z.string(),
  status: z.enum(TPA_IMPORT_STATUSES),
  fileIssues: z.array(z.string()),
  counts: z.object({
    rows: z.number().int(),
    valid: z.number().int(),
    invalid: z.number().int(),
    warnings: z.number().int(),
    create: z.number().int(),
    update: z.number().int(),
    unchanged: z.number().int(),
  }),
  result: z
    .object({
      created: z.number().int(),
      updated: z.number().int(),
      unchanged: z.number().int(),
      skipped: z.number().int(),
      failed: z.number().int(),
      failures: z.array(z.object({ row: z.number().int(), message: z.string() })),
      /** N11: what the import did to the claims board. */
      board: z
        .object({
          created: z.number().int(),
          moved: z.number().int(),
          settlementUpdated: z.number().int(),
          unchanged: z.number().int(),
          notMapped: z.number().int(),
          review: z.number().int(),
          failed: z.number().int(),
          emailsQueued: z.number().int(),
        })
        .optional(),
      /** N11: TPA statuses with no board column, for an Admin to map. */
      unmappedBoardStatuses: z
        .array(z.object({ source: z.string(), rows: z.number().int() }))
        .optional(),
    })
    .nullable(),
  policy: z.enum(TPA_IMPORT_POLICIES).nullable(),
  uploadedAt: IsoDateTimeSchema,
  uploadedBy: z.string(),
  importedAt: IsoDateTimeSchema.nullable(),
  importedBy: z.string().nullable(),
});
export type TpaImport = z.infer<typeof TpaImportSchema>;
export const TpaImportListResponseSchema = z.object({ items: z.array(TpaImportSchema) });

export const TpaImportRowSchema = z.object({
  row: z.number().int(),
  tpaClaimId: z.string().nullable(),
  action: z.enum(TPA_ROW_ACTIONS),
  issues: z.array(TpaRowIssueSchema),
  /** Normalised values for display; diagnosis details only for users who process claims. */
  values: z.record(z.string(), z.string().nullable()),
});
export type TpaImportRow = z.infer<typeof TpaImportRowSchema>;
export const TpaImportRowsResponseSchema = z.object({
  items: z.array(TpaImportRowSchema),
  total: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
});
export const TpaImportRowsQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  only: z.enum(['ALL', 'ERRORS', 'WARNINGS']).default('ALL'),
});
export const TpaUploadQuerySchema = z.strictObject({
  caseId: ObjectIdSchema,
  formatId: ObjectIdSchema,
  fileName: z.string().trim().min(1).max(200),
});
export const TpaInspectQuerySchema = z.strictObject({
  formatId: ObjectIdSchema.optional(),
  sheetName: z.string().trim().max(31).optional(),
  headerRow: z.coerce.number().int().min(1).max(50).optional(),
  fileName: z.string().trim().min(1).max(200),
});
export const TpaInspectResponseSchema = z.object({
  sheets: z.array(z.string()),
  sheet: z.string(),
  headers: z.array(z.string()),
  /** For each mapped field, the column it found (null: not in the file). */
  found: z.array(
    z.object({
      field: TpaClaimFieldSchema,
      header: z.string(),
      column: z.number().int().nullable(),
    }),
  ),
  /** Suggested headers for unmapped fields, by name similarity (never applied without saving). */
  suggestions: z.array(z.object({ field: TpaClaimFieldSchema, header: z.string() })),
  sample: z.array(
    z.object({
      row: z.number().int(),
      values: z.record(z.string(), z.string().nullable()),
      issues: z.array(TpaRowIssueSchema),
    }),
  ),
  /** The values of the status column across the file (at most 100), to map each one. */
  statusValues: z.array(z.object({ value: z.string(), rows: z.number().int() })),
});
export type TpaInspectResponse = z.infer<typeof TpaInspectResponseSchema>;
export const CommitTpaImportRequestSchema = z.strictObject({ policy: z.enum(TPA_IMPORT_POLICIES) });
export const TpaImportParamsSchema = z.strictObject({ importId: ObjectIdSchema });

export const TPA_MEMBER_MATCHES = ['MATCHED', 'NOT_FOUND', 'AMBIGUOUS', 'NO_EMPLOYEE_ID'] as const;
export type TpaMemberMatch = (typeof TPA_MEMBER_MATCHES)[number];
export const TPA_PARENT_LINKS = ['NONE', 'LINKED', 'NOT_FOUND', 'MANUAL'] as const;
export type TpaParentLink = (typeof TPA_PARENT_LINKS)[number];
export const TPA_BOARD_LINKS = ['NONE', 'LINKED', 'AMBIGUOUS', 'MANUAL'] as const;
export type TpaBoardLink = (typeof TPA_BOARD_LINKS)[number];

export const TpaClaimRecordSchema = z.object({
  id: ObjectIdSchema,
  caseId: ObjectIdSchema,
  product: EbProductSchema,
  tpaCode: z.string(),
  tpaClaimId: z.string(),
  requestType: TpaRequestTypeSchema,
  parentClaimId: z.string().nullable(),
  parent: z.object({ state: z.enum(TPA_PARENT_LINKS), id: ObjectIdSchema.nullable() }),
  member: z.object({
    match: z.enum(TPA_MEMBER_MATCHES),
    memberId: ObjectIdSchema.nullable(),
    employeeId: z.string().nullable(),
    name: z.string().nullable(),
    relationship: GhiRelationshipSchema.nullable(),
    gender: z.enum(['MALE', 'FEMALE', 'OTHER']).nullable(),
    dateOfBirth: z.iso.date().nullable(),
  }),
  board: z.object({
    state: z.enum(TPA_BOARD_LINKS),
    claimId: ObjectIdSchema.nullable(),
    claimNumber: z.string().nullable(),
  }),
  admissionDate: z.iso.date().nullable(),
  dischargeDate: z.iso.date().nullable(),
  claimType: TpaClaimTypeSchema.nullable(),
  hospital: z.string().nullable(),
  claimedAmount: z.string().nullable(),
  sanctionedAmount: z.string().nullable(),
  settledAmount: z.string().nullable(),
  disallowedAmount: z.string().nullable(),
  status: TpaClaimStatusSchema,
  sourceStatus: z.string(),
  icdChapter: z.string(),
  /** Only for users who process claims (claims.process); null otherwise. */
  diagnosis: z.string().nullable(),
  icdCode: z.string().nullable(),
  rejectionReason: z.string().nullable(),
  /** N12: masked (XXXXXXXX9012) unless the user is claims.admin. */
  bankAccount: z.string().nullable(),
  /** N11: why the claim is not on the board, when it is not. */
  boardNote: z.string().nullable(),
  reviewNote: z.string().nullable(),
  lastImportId: ObjectIdSchema.nullable(),
  importedAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type TpaClaimRecord = z.infer<typeof TpaClaimRecordSchema>;
export const TpaClaimListResponseSchema = z.object({
  items: z.array(TpaClaimRecordSchema),
  total: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
});
export const TpaClaimParamsSchema = z.strictObject({ claimId: ObjectIdSchema });
export const LinkTpaClaimRequestSchema = z.strictObject({
  /** The main claim's TPA record (same policy and TPA), or null to clear a manual link. */
  parentId: ObjectIdSchema.nullable().optional(),
  /** A board claim of the same policy, or null to clear. */
  boardClaimId: ObjectIdSchema.nullable().optional(),
  reviewNote: z.string().trim().max(500).nullable().optional(),
});

export const TpaClaimListQuerySchema = z.strictObject({
  caseId: ObjectIdSchema,
  status: TpaClaimStatusSchema.optional(),
  /** Only records that need a person: member not matched, main claim not found, board link ambiguous. */
  review: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const TpaImportListQuerySchema = z.strictObject({ caseId: ObjectIdSchema });
export const TpaClaimHistorySchema = z.object({
  items: z.array(
    z.object({
      type: z.enum(['CREATED', 'UPDATED', 'LINKED', 'NOTE']),
      at: IsoDateTimeSchema,
      importId: ObjectIdSchema.nullable(),
      fromStatus: TpaClaimStatusSchema.nullable(),
      toStatus: TpaClaimStatusSchema.nullable(),
      changes: z.array(
        z.object({
          field: z.string(),
          before: z.string().nullable(),
          after: z.string().nullable(),
        }),
      ),
    }),
  ),
});

/** A placed policy, for choosing where TPA claims and analyses belong. */
export const InsuredPolicySchema = z.object({
  caseId: ObjectIdSchema,
  clientId: ObjectIdSchema,
  clientName: z.string(),
  product: EbProductSchema,
  reference: z.string(),
  policyNumber: z.string().nullable(),
  insurerId: ObjectIdSchema,
  insurerName: z.string(),
  policyStart: z.iso.date(),
  policyEnd: z.iso.date(),
  basePremium: z.string().nullable(),
  gst: z.string().nullable(),
  totalPremium: z.string().nullable(),
});
export type InsuredPolicyView = z.infer<typeof InsuredPolicySchema>;
export const InsuredPolicyListResponseSchema = z.object({ items: z.array(InsuredPolicySchema) });
export const InsuredPolicyQuerySchema = z.strictObject({
  clientId: ObjectIdSchema.optional(),
  product: EbProductSchema.optional(),
});
