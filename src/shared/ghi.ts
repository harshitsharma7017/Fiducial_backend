import { z } from 'zod';
import { AgeBandSelectionSchema } from './age-bands.ts';
import { EmailSchema } from './auth.ts';
import { IsoDateTimeSchema, ObjectIdSchema, blankAsNull } from './common.ts';
import { SearchTextSchema } from './clients.ts';
import { EbPlanAssignmentSchema } from './eb-plan.ts';
import { EbProductSchema } from './eb-products.ts';
import { MAIL_RESULTS } from './mail.ts';

// Group Health Insurance (GHI): a second line of business beside Property. A GHI case has its own
// collections and API (/api/v1/ghi) and never changes a Property proposal. Sums insured are whole
// rupees as digit strings; premiums are rupees with paise as decimal strings; counts are numbers.

/** New business, or the renewal of the group's existing policy. */
export const GHI_CASE_TYPES = ['NEW', 'RENEWAL'] as const;
export const GhiCaseTypeSchema = z.enum(GHI_CASE_TYPES);
export type GhiCaseType = z.infer<typeof GhiCaseTypeSchema>;
export const GHI_CASE_TYPE_LABELS: Record<GhiCaseType, string> = {
  NEW: 'New business',
  RENEWAL: 'Renewal',
};

/**
 * The stages of a GHI case, in order (G1). Each one is reached by the work itself: saving the
 * Data Sheet, generating the RFQ, recording a quote, submitting the QCR, the client's acceptance,
 * the final QCR and the premium received. A case can be closed (lost) before its policy is recorded.
 */
export const GHI_STAGES = [
  'CREATED',
  'DATA_SHEET',
  'RFQ',
  'QCR',
  'APPROVAL',
  'FINAL_QCR',
  'PAYMENT',
  'PLACEMENT_SLIP',
  'CLOSED',
] as const;
export const GhiStageSchema = z.enum(GHI_STAGES);
export type GhiStage = z.infer<typeof GhiStageSchema>;
export const GHI_STAGE_LABELS: Record<GhiStage, string> = {
  CREATED: 'New / Renewal',
  DATA_SHEET: 'Data Sheet',
  RFQ: 'RFQ',
  QCR: 'QCR',
  APPROVAL: 'Approval',
  FINAL_QCR: 'Final QCR',
  PAYMENT: 'Payment',
  PLACEMENT_SLIP: 'Placement Slip',
  CLOSED: 'Closed',
};
/** The first stage's label for a case of this type. */
export function ghiStageLabel(stage: GhiStage, type: GhiCaseType): string {
  return stage === 'CREATED' ? GHI_CASE_TYPE_LABELS[type] : GHI_STAGE_LABELS[stage];
}

/** At most this many insurers per case, as on a Property case and the QCR (G6). */
export const MAX_GHI_INSURERS = 5;

// Shared field schemas

const OptionalText = (max: number) => blankAsNull(z.string().trim().max(max, 'This is too long'));
export const GhiRupeesSchema = z
  .string()
  .trim()
  .regex(/^\d{1,13}$/, 'Enter whole rupees, digits only');
const OptionalRupees = blankAsNull(GhiRupeesSchema);
/** Rupees with paise at most (premiums). */
export const GhiAmountSchema = z
  .string()
  .trim()
  .regex(/^\d{1,13}(\.\d{1,2})?$/, 'Enter rupees, with paise at most (for example 125000.50)');
export const GhiPercentSchema = z
  .string()
  .trim()
  .regex(/^\d{1,3}(\.\d{1,2})?$/, 'Enter a percentage, for example 10 or 12.5')
  .refine((value) => Number(value) <= 100, 'Enter 0 to 100');
const OptionalPercent = blankAsNull(GhiPercentSchema);
const Count = (max: number) => z.number().int('Enter a whole number').min(0).max(max);

// Requirements (G2): the GHI Data Sheet

/**
 * Who a family may include besides the employee (G2): the spouse, up to three children, and either
 * the employee's parents or parents-in-law. EITHER lets each employee choose one pair, never both.
 */
export const GHI_PARENT_COVERS = ['NONE', 'PARENTS', 'PARENTS_IN_LAW', 'EITHER'] as const;
export type GhiParentCover = (typeof GHI_PARENT_COVERS)[number];
export const GHI_PARENT_COVER_LABELS: Record<GhiParentCover, string> = {
  NONE: 'No parents',
  PARENTS: 'Parents only',
  PARENTS_IN_LAW: 'Parents-in-law only',
  EITHER: 'Parents or parents-in-law (not both)',
};
export const GHI_MAX_CHILDREN = 3;

/** Family floater (one sum insured shared by the family) or individual sums insured. */
export const GHI_COVERAGE_TYPES = ['FLOATER', 'INDIVIDUAL'] as const;
export const GhiCoverageTypeSchema = z.enum(GHI_COVERAGE_TYPES);
export type GhiCoverageType = z.infer<typeof GhiCoverageTypeSchema>;
export const GHI_COVERAGE_TYPE_LABELS: Record<GhiCoverageType, string> = {
  FLOATER: 'Family floater',
  INDIVIDUAL: 'Individual',
};

/** How the room rent is limited: not at all, a % of the sum insured, or rupees per day. */
export const GHI_ROOM_RENT_KINDS = ['NO_LIMIT', 'PERCENT_OF_SI', 'FIXED_AMOUNT'] as const;
export type GhiRoomRentKind = (typeof GHI_ROOM_RENT_KINDS)[number];
export const GHI_ROOM_RENT_KIND_LABELS: Record<GhiRoomRentKind, string> = {
  NO_LIMIT: 'No capping',
  PERCENT_OF_SI: '% of sum insured per day',
  FIXED_AMOUNT: '₹ per day',
};

/** The waiting-period waivers asked for (G2) and offered (G6). */
export const GHI_WAIVERS = [
  'initialWaitingPeriod',
  'firstYearExclusions',
  'twoYearExclusions',
  'preExistingWaitingPeriod',
] as const;
export type GhiWaiver = (typeof GHI_WAIVERS)[number];
export const GHI_WAIVER_LABELS: Record<GhiWaiver, string> = {
  initialWaitingPeriod: '30-day initial waiting period waived',
  firstYearExclusions: 'First-year exclusions waived',
  twoYearExclusions: 'Two-year exclusions waived',
  preExistingWaitingPeriod: 'Pre-existing disease waiting period waived',
};

/** The census relationship groups whose age limits are set per case (G3). */
export const GHI_AGE_GROUPS = ['employee', 'spouse', 'child', 'parent'] as const;
export type GhiAgeGroup = (typeof GHI_AGE_GROUPS)[number];
export const GHI_AGE_GROUP_LABELS: Record<GhiAgeGroup, string> = {
  employee: 'Employee',
  spouse: 'Spouse',
  child: 'Children',
  parent: 'Parents / parents-in-law',
};

const AgeLimitSchema = z
  .strictObject({ min: Count(120).nullable(), max: Count(120).nullable() })
  .refine((limit) => limit.min === null || limit.max === null || limit.min <= limit.max, {
    path: ['max'],
    message: 'The maximum age must not be below the minimum',
  });

/** One year of the group's previous policy (G2). */
export const GhiClaimYearInputSchema = z.strictObject({
  /** The policy year, for example 2025-26. */
  policyYear: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}$/, 'Enter the policy year as 2025-26'),
  insurer: OptionalText(200),
  livesCovered: Count(1_000_000).nullable(),
  premium: blankAsNull(GhiAmountSchema),
  claimsPaid: blankAsNull(GhiAmountSchema),
  claimsOutstanding: blankAsNull(GhiAmountSchema),
  claimCount: Count(1_000_000).nullable(),
});
export type GhiClaimYearInput = z.infer<typeof GhiClaimYearInputSchema>;
export const GHI_CLAIM_YEARS = 3;

export const GhiRequirementsInputSchema = z
  .strictObject({
    company: z.strictObject({
      natureOfBusiness: OptionalText(200),
      contactName: OptionalText(120),
      contactEmail: blankAsNull(EmailSchema),
      contactPhone: blankAsNull(
        z
          .string()
          .trim()
          .regex(/^[0-9+\-() ]{6,20}$/, 'Enter a phone number'),
      ),
      /** The cities or sites the employees work at. */
      locations: OptionalText(500),
    }),
    /** Employees to be covered, as the company declares them. */
    employeeCount: z.number().int('Enter a whole number').min(1).max(1_000_000).nullable(),
    familyDefinition: z.strictObject({
      spouse: z.boolean(),
      maxChildren: z.number().int().min(0).max(GHI_MAX_CHILDREN),
      parents: z.enum(GHI_PARENT_COVERS),
    }),
    coverageType: GhiCoverageTypeSchema.nullable(),
    /** The sums insured on offer; each census member's sum insured must be one of them. */
    sumInsuredOptions: z
      .array(GhiRupeesSchema.refine((value) => BigInt(value) > 0n, 'Enter an amount above 0'))
      .max(10, 'Offer at most 10 sums insured')
      .refine((values) => new Set(values).size === values.length, 'Each sum insured once'),
    maternity: z.strictObject({
      covered: z.boolean().nullable(),
      normalLimit: OptionalRupees,
      cesareanLimit: OptionalRupees,
      newbornCovered: z.boolean().nullable(),
      nineMonthWaiver: z.boolean().nullable(),
    }),
    preExistingDiseases: z.strictObject({
      covered: z.boolean().nullable(),
      note: OptionalText(500),
    }),
    waivers: z.strictObject(
      Object.fromEntries(GHI_WAIVERS.map((key) => [key, z.boolean().nullable()])) as Record<
        GhiWaiver,
        z.ZodNullable<z.ZodBoolean>
      >,
    ),
    roomRent: z.strictObject({
      kind: z.enum(GHI_ROOM_RENT_KINDS).nullable(),
      /** % of the sum insured, or rupees per day, by kind. */
      normal: blankAsNull(GhiAmountSchema),
      icu: blankAsNull(GhiAmountSchema),
    }),
    parentsCoPayPercent: OptionalPercent,
    corporateBuffer: z.strictObject({
      amount: OptionalRupees,
      perFamilyLimit: OptionalRupees,
      note: OptionalText(500),
    }),
    claims: z
      .array(GhiClaimYearInputSchema)
      .max(GHI_CLAIM_YEARS, `Enter at most ${GHI_CLAIM_YEARS} years`),
    /** Age limits per relationship group, in completed years; null is no limit. */
    ageLimits: z.strictObject(
      Object.fromEntries(GHI_AGE_GROUPS.map((group) => [group, AgeLimitSchema])) as Record<
        GhiAgeGroup,
        typeof AgeLimitSchema
      >,
    ),
    /** The date ages are worked out on; blank: the policy start, else the day the case was created. */
    ageReferenceDate: blankAsNull(z.iso.date({ error: 'Enter a date' })),
    otherRequirements: OptionalText(2000),
  })
  .superRefine((input, context) => {
    const years = input.claims.map((claim) => claim.policyYear);
    if (new Set(years).size !== years.length) {
      context.addIssue({ code: 'custom', path: ['claims'], message: 'Each policy year once' });
    }
    const kind = input.roomRent.kind;
    if (kind === 'NO_LIMIT' && (input.roomRent.normal || input.roomRent.icu)) {
      context.addIssue({
        code: 'custom',
        path: ['roomRent', 'normal'],
        message: 'No capping takes no limit',
      });
    }
    if (kind === 'PERCENT_OF_SI') {
      for (const key of ['normal', 'icu'] as const) {
        const value = input.roomRent[key];
        if (value !== null && Number(value) > 100) {
          context.addIssue({
            code: 'custom',
            path: ['roomRent', key],
            message: 'Enter a percentage up to 100',
          });
        }
      }
    }
    if (input.maternity.covered === false) {
      for (const key of ['normalLimit', 'cesareanLimit'] as const) {
        if (input.maternity[key] !== null) {
          context.addIssue({
            code: 'custom',
            path: ['maternity', key],
            message: 'Maternity is not covered: leave its limits blank',
          });
        }
      }
    }
    // "Parents are not covered: leave the co-payment blank" is checked by the API, which knows
    // whether the case's plan covers parents (design D6): same field, message and 400.
  });
export type GhiRequirementsInput = z.infer<typeof GhiRequirementsInputSchema>;
export type GhiRequirementsFormValues = z.input<typeof GhiRequirementsInputSchema>;

/** The Data Sheet of a new case: nothing answered, employee-only family, no age limits. */
export function emptyGhiRequirements(): GhiRequirementsInput {
  const noLimit = { min: null, max: null };
  return {
    company: {
      natureOfBusiness: null,
      contactName: null,
      contactEmail: null,
      contactPhone: null,
      locations: null,
    },
    employeeCount: null,
    familyDefinition: { spouse: false, maxChildren: 0, parents: 'NONE' },
    coverageType: null,
    sumInsuredOptions: [],
    maternity: {
      covered: null,
      normalLimit: null,
      cesareanLimit: null,
      newbornCovered: null,
      nineMonthWaiver: null,
    },
    preExistingDiseases: { covered: null, note: null },
    waivers: {
      initialWaitingPeriod: null,
      firstYearExclusions: null,
      twoYearExclusions: null,
      preExistingWaitingPeriod: null,
    },
    roomRent: { kind: null, normal: null, icu: null },
    parentsCoPayPercent: null,
    corporateBuffer: { amount: null, perFamilyLimit: null, note: null },
    claims: [],
    ageLimits: { employee: noLimit, spouse: noLimit, child: noLimit, parent: noLimit },
    ageReferenceDate: null,
    otherRequirements: null,
  };
}

/** A previous year with its claims ratio (claims paid and outstanding over premium), worked out by the API. */
export const GhiClaimYearSchema = GhiClaimYearInputSchema.extend({
  claimsRatioPercent: z.string().nullable(),
});

export const GhiRequirementsSchema = GhiRequirementsInputSchema.safeExtend({
  claims: z.array(GhiClaimYearSchema),
});
export type GhiRequirements = z.infer<typeof GhiRequirementsSchema>;

// Cases (G1)

export const CreateGhiCaseRequestSchema = z
  .strictObject({
    type: GhiCaseTypeSchema,
    clientId: ObjectIdSchema,
    /** Assigned staff; the creator when left out. */
    ownerId: ObjectIdSchema.optional(),
    policyStart: blankAsNull(z.iso.date({ error: 'Enter a date' })).default(null),
    policyEnd: blankAsNull(z.iso.date({ error: 'Enter a date' })).default(null),
    dueDate: z.iso.date({ error: 'Enter the date quotes are needed by' }),
    /** Renewals: the expiring policy. */
    existingInsurer: OptionalText(200).default(null),
    existingPolicyNumber: OptionalText(100).default(null),
  })
  .superRefine((body, context) => {
    if (body.policyEnd && !body.policyStart) {
      context.addIssue({
        code: 'custom',
        path: ['policyStart'],
        message: 'Enter the start of the policy period',
      });
    }
    if (body.policyStart && body.policyEnd && body.policyEnd <= body.policyStart) {
      context.addIssue({
        code: 'custom',
        path: ['policyEnd'],
        message: 'The policy period must end after it starts',
      });
    }
    if (body.type === 'RENEWAL') {
      if (!body.policyStart || !body.policyEnd) {
        context.addIssue({
          code: 'custom',
          path: [body.policyStart ? 'policyEnd' : 'policyStart'],
          message: 'A renewal needs its policy period',
        });
      }
      if (!body.existingInsurer) {
        context.addIssue({
          code: 'custom',
          path: ['existingInsurer'],
          message: 'Enter the expiring policy’s insurer',
        });
      }
    }
  });
export type CreateGhiCaseRequest = z.infer<typeof CreateGhiCaseRequestSchema>;
export type CreateGhiCaseFormValues = z.input<typeof CreateGhiCaseRequestSchema>;

/** Changes the case's dates and staff (G1); the type and client stay as created. */
export const UpdateGhiCaseRequestSchema = z.strictObject({
  ownerId: ObjectIdSchema,
  policyStart: blankAsNull(z.iso.date({ error: 'Enter a date' })),
  policyEnd: blankAsNull(z.iso.date({ error: 'Enter a date' })),
  dueDate: z.iso.date({ error: 'Enter the date quotes are needed by' }),
  existingInsurer: OptionalText(200),
  existingPolicyNumber: OptionalText(100),
});
export type UpdateGhiCaseRequest = z.infer<typeof UpdateGhiCaseRequestSchema>;

export const CloseGhiCaseRequestSchema = z.strictObject({
  reason: z.string().trim().min(1, 'Say why the case is closed').max(300, 'This is too long'),
});

/** Where an insurer on a case stands: Not sent until the RFQ goes, then Quoted or Declined. */
export const GHI_INSURER_STATUSES = ['NOT_SENT', 'SENT', 'QUOTED', 'DECLINED'] as const;
export type GhiInsurerStatus = (typeof GHI_INSURER_STATUSES)[number];
export const GHI_INSURER_STATUS_LABELS: Record<GhiInsurerStatus, string> = {
  NOT_SENT: 'Not sent',
  SENT: 'Sent',
  QUOTED: 'Quoted',
  DECLINED: 'Declined',
};

export const GhiCaseInsurerSchema = z.object({
  insurerId: ObjectIdSchema,
  company: z.string(),
  branch: z.string(),
  rfqEmails: z.array(z.string()),
  active: z.boolean(),
  status: z.enum(GHI_INSURER_STATUSES),
  /** APP: emailed from the app; OUTSIDE: marked as sent by a user. */
  sentVia: z.enum(['APP', 'OUTSIDE']).nullable(),
  sentAt: IsoDateTimeSchema.nullable(),
  sentBy: z.string().nullable(),
  dueDate: z.iso.date().nullable(),
  /** The last RFQ mail tried for this insurer and its result. */
  lastDispatch: z
    .object({ at: IsoDateTimeSchema, result: z.enum(MAIL_RESULTS), error: z.string().nullable() })
    .nullable(),
  declineReason: z.string().nullable(),
});
export type GhiCaseInsurer = z.infer<typeof GhiCaseInsurerSchema>;

/** The policy the insurer issued (G7), linked to the company, case, insurer and census. */
export const GhiPolicySchema = z.object({
  policyNumber: z.string(),
  issuedOn: z.iso.date(),
  policyStart: z.iso.date(),
  policyEnd: z.iso.date(),
  renewalDate: z.iso.date(),
  insurerId: ObjectIdSchema,
  insurerName: z.string(),
  quoteId: ObjectIdSchema,
  qcrId: ObjectIdSchema,
  file: z.object({ id: ObjectIdSchema, fileName: z.string() }),
  /** The census the policy insures, as it stood when recorded. */
  census: z.object({
    employees: z.number().int(),
    lives: z.number().int(),
    totalSumInsured: z.string(),
    revision: z.number().int(),
  }),
  recordedAt: IsoDateTimeSchema,
  recordedBy: z.string(),
});
export type GhiPolicy = z.infer<typeof GhiPolicySchema>;

export const GhiCaseRecordSchema = z.object({
  id: ObjectIdSchema,
  /** Employee Benefits product (N1): a GHI case is a GMC case. */
  product: z.literal('GMC'),
  reference: z.string(),
  type: GhiCaseTypeSchema,
  stage: GhiStageSchema,
  closedReason: z.string().nullable(),
  /** The policy is recorded: the case is complete. */
  placed: z.boolean(),
  client: z.object({
    id: ObjectIdSchema,
    name: z.string(),
    gstin: z.string().nullable(),
    address: z.string(),
    city: z.string(),
    state: z.string(),
    natureOfBusiness: z.string(),
    /** The client's contacts that have an email: the QCR goes only to these. */
    contacts: z.array(z.object({ name: z.string(), email: z.string() })),
  }),
  owner: z.object({ id: ObjectIdSchema, name: z.string() }),
  policyStart: z.iso.date().nullable(),
  policyEnd: z.iso.date().nullable(),
  dueDate: z.iso.date(),
  existingInsurer: z.string().nullable(),
  existingPolicyNumber: z.string().nullable(),
  /** GST % from the tax master when the case was created; quotes use it. */
  gstRatePercent: z.string(),
  requirements: GhiRequirementsSchema,
  /** What the Data Sheet still needs before the RFQ; empty when complete. */
  missing: z.array(z.string()),
  /** The date ages are worked out on (the Data Sheet's, else the policy start, else creation). */
  ageReferenceDate: z.iso.date(),
  /** The Data Sheet and census can no longer change: the RFQ has gone to an insurer. */
  locked: z.boolean(),
  /** Go up by one at each change, so an approved RFQ knows when it is out of date. */
  requirementsRevision: z.number().int(),
  censusRevision: z.number().int(),
  insurers: z.array(GhiCaseInsurerSchema),
  finalQcr: z
    .object({
      quoteId: ObjectIdSchema,
      qcrId: ObjectIdSchema,
      insurerId: ObjectIdSchema,
      recordedAt: IsoDateTimeSchema,
      recordedBy: z.string(),
    })
    .nullable(),
  policy: GhiPolicySchema.nullable(),
  /** The family plan assigned to the case (N2); null: the Data Sheet's family definition applies. */
  plan: EbPlanAssignmentSchema.nullable(),
  /** N4: the case's copy of its age band set; null: the standard bands. */
  ageBands: AgeBandSelectionSchema.nullable().optional(),
  /** What the case needs to reach its next stage; empty when nothing (or closed). */
  nextStep: z.string().nullable(),
  activity: z.array(z.object({ at: IsoDateTimeSchema, actor: z.string(), message: z.string() })),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type GhiCaseRecord = z.infer<typeof GhiCaseRecordSchema>;

export const GhiCaseListQuerySchema = z.strictObject({
  q: SearchTextSchema.optional(),
  stage: GhiStageSchema.optional(),
  type: GhiCaseTypeSchema.optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type GhiCaseListQuery = z.infer<typeof GhiCaseListQuerySchema>;

export const GhiCaseListItemSchema = z.object({
  id: ObjectIdSchema,
  /** Employee Benefits product (N1). */
  product: EbProductSchema,
  reference: z.string(),
  type: GhiCaseTypeSchema,
  stage: GhiStageSchema,
  placed: z.boolean(),
  client: z.object({ id: ObjectIdSchema, name: z.string() }),
  owner: z.string(),
  policyStart: z.iso.date().nullable(),
  dueDate: z.iso.date(),
  employees: z.number().int(),
  lives: z.number().int(),
  updatedAt: IsoDateTimeSchema,
});
export type GhiCaseListItem = z.infer<typeof GhiCaseListItemSchema>;

export const GhiCaseListResponseSchema = z.object({
  items: z.array(GhiCaseListItemSchema),
  total: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
});
export type GhiCaseListResponse = z.infer<typeof GhiCaseListResponseSchema>;

export const GhiCaseParamsSchema = z.strictObject({ id: ObjectIdSchema });

// Files kept on a case: quotes, the client's decision, payment proofs and the policy copy.

export const GHI_FILE_PURPOSES = [
  'QUOTE',
  'CLIENT_DECISION',
  'PAYMENT',
  'POLICY',
  'OTHER',
] as const;
export type GhiFilePurpose = (typeof GHI_FILE_PURPOSES)[number];
export const GHI_FILE_PURPOSE_LABELS: Record<GhiFilePurpose, string> = {
  QUOTE: 'Insurer’s quote',
  CLIENT_DECISION: 'Client’s decision',
  PAYMENT: 'Payment proof',
  POLICY: 'Policy copy',
  OTHER: 'Other',
};

export const GhiFileUploadQuerySchema = z.strictObject({
  purpose: z.enum(GHI_FILE_PURPOSES),
  fileName: z
    .string()
    .trim()
    .min(1, 'Name the file')
    .max(200, 'The file name is too long')
    .regex(/^[^\\/:*?"<>|\r\n]+$/, 'The file name has characters that are not allowed'),
});

export const GhiFileSchema = z.object({
  id: ObjectIdSchema,
  purpose: z.enum(GHI_FILE_PURPOSES),
  fileName: z.string(),
  contentType: z.string(),
  size: z.number().int(),
  uploadedAt: IsoDateTimeSchema,
  uploadedBy: z.string(),
});
export type GhiFile = z.infer<typeof GhiFileSchema>;
export const GhiFileListResponseSchema = z.object({ items: z.array(GhiFileSchema) });

export const GhiFileParamsSchema = z.strictObject({ id: ObjectIdSchema, fileId: ObjectIdSchema });
