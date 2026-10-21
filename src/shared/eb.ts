import { z } from 'zod';
import { IsoDateTimeSchema, ObjectIdSchema } from './common.ts';
import { EB_PRODUCTS, EbProductSchema, type EbProduct } from './eb-products.ts';
import {
  GpaRequirementsInputSchema,
  GtliRequirementsInputSchema,
  type MissingItem,
} from './eb-requirements.ts';
import { EbPlanAssignmentSchema } from './eb-plan.ts';
import {
  CloseGhiCaseRequestSchema,
  CreateGhiCaseRequestSchema,
  GHI_CASE_TYPE_LABELS,
  GHI_STAGE_LABELS,
  GhiCaseListItemSchema,
  GhiCaseRecordSchema,
  GhiCaseTypeSchema,
  GhiClaimYearSchema,
  GhiStageSchema,
  UpdateGhiCaseRequestSchema,
  type GhiCaseType,
  type GhiStage,
} from './ghi.ts';

// Employee Benefits cases (N1): GMC (the existing GHI cases), GPA and GTLI. A GPA or GTLI case
// moves through its own stages (Requirement 3): no Final QCR and no policy step; the client's
// decision is recorded within Approval and the placement slip places the case.

export const EB_STAGES = [
  'CREATED',
  'DATA_SHEET',
  'RFQ',
  'QCR',
  'APPROVAL',
  'PAYMENT',
  'PLACEMENT_SLIP',
  'CLOSED',
] as const satisfies readonly GhiStage[];
export type EbStage = (typeof EB_STAGES)[number];
export const EbStageSchema = z.enum(EB_STAGES);

export function ebStageLabel(stage: EbStage, type: GhiCaseType): string {
  return stage === 'CREATED' ? GHI_CASE_TYPE_LABELS[type] : GHI_STAGE_LABELS[stage];
}

/**
 * The stage a GPA/GTLI case is at once work reaching `reached` is saved: forward only, never out
 * of Closed (Requirement 3.2). The one backward move (Approval → QCR) is not made here.
 */
export function ebStageAfter(current: EbStage, reached: EbStage): EbStage {
  if (current === 'CLOSED' || reached === 'CLOSED') return current;
  return EB_STAGES.indexOf(reached) > EB_STAGES.indexOf(current) ? reached : current;
}

/** The backward moves the rules allow: a rejected QCR or a client's rejection at Approval. */
export function ebReturnAllowed(from: EbStage, to: EbStage): boolean {
  return from === 'APPROVAL' && to === 'QCR';
}

const NEXT_STEPS: Record<EbStage, string | null> = {
  CREATED: 'Next: fill and save the Data Sheet.',
  DATA_SHEET:
    'Next: complete the Data Sheet, assign a family plan and add the census, then generate the RFQ.',
  RFQ: 'Next: approve the RFQ, send it to the insurers and record their quotes.',
  QCR: 'Next: prepare the QCR from the insurers’ recorded quotes and submit it for approval.',
  APPROVAL:
    'Next: approve the QCR, send it to the client and record the client’s decision (chosen insurer and agreed premium).',
  PAYMENT: 'Next: record the premium received; it must cover the agreed premium.',
  PLACEMENT_SLIP: 'Next: issue the placement slip, which places the case.',
  CLOSED: null,
};

/** The next step for a GPA/GTLI case; none when placed or Closed (Requirement 3.6). */
export function nextStepOf(
  stage: EbStage,
  options: { placed: boolean; missing: readonly MissingItem[]; planAssigned: boolean },
): string | null {
  if (options.placed || stage === 'CLOSED') return null;
  if (stage === 'CREATED' || stage === 'DATA_SHEET') {
    const needs: string[] = [];
    if (options.missing.length > 0) {
      needs.push(
        `complete the Data Sheet (${options.missing.length} item${options.missing.length === 1 ? '' : 's'} missing)`,
      );
    }
    if (!options.planAssigned) needs.push('assign a family plan');
    if (stage === 'DATA_SHEET' && needs.length > 0) {
      return `Next: ${needs.join(', ')}, add the census, then generate the RFQ.`;
    }
  }
  return NEXT_STEPS[stage];
}

// Requests

/** Search text: 1 to 100 characters after trimming; blank is no search (Requirement 2.3). */
const ListSearchSchema = z
  .string()
  .trim()
  .max(100, 'Search text is too long (at most 100 characters)')
  .transform((value) => (value === '' ? undefined : value));

/** Creates a GMC, GPA or GTLI case: the product, then the GHI case fields (Requirement 1.4). */
export const CreateEbCaseRequestSchema = CreateGhiCaseRequestSchema.extend({
  product: EbProductSchema,
});
export type CreateEbCaseRequest = z.infer<typeof CreateEbCaseRequestSchema>;
export type CreateEbCaseFormValues = z.input<typeof CreateEbCaseRequestSchema>;

export const EbCaseCreatedSchema = z.object({
  id: ObjectIdSchema,
  product: EbProductSchema,
  reference: z.string(),
});
export type EbCaseCreated = z.infer<typeof EbCaseCreatedSchema>;

export const EbCaseListQuerySchema = z.strictObject({
  product: EbProductSchema.optional(),
  stage: GhiStageSchema.optional(),
  type: GhiCaseTypeSchema.optional(),
  clientId: ObjectIdSchema.optional(),
  q: ListSearchSchema.optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type EbCaseListQuery = z.infer<typeof EbCaseListQuerySchema>;

export const EbCaseListItemSchema = GhiCaseListItemSchema.extend({ product: EbProductSchema });
export type EbCaseListItem = z.infer<typeof EbCaseListItemSchema>;
export const EbCaseListResponseSchema = z.object({
  items: z.array(EbCaseListItemSchema),
  total: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
});
export type EbCaseListResponse = z.infer<typeof EbCaseListResponseSchema>;

/** Edits only dates, due date, staff and the expiring policy; product, type or company → 400. */
export const UpdateEbCaseRequestSchema = UpdateGhiCaseRequestSchema;
export type UpdateEbCaseRequest = z.infer<typeof UpdateEbCaseRequestSchema>;
export const CloseEbCaseRequestSchema = CloseGhiCaseRequestSchema;

// Plan assignment

export const AssignEbPlanRequestSchema = z.strictObject({ planId: ObjectIdSchema });
export type AssignEbPlanRequest = z.infer<typeof AssignEbPlanRequestSchema>;

/** A family that would break the new plan (no names: Requirement 24.4). */
export const EbPlanConflictSchema = z.object({
  families: z.array(z.object({ employeeId: z.string(), rules: z.array(z.string()) })),
});

// The GPA/GTLI case record

const MissingItemSchema = z.object({ field: z.string(), label: z.string() });

export const EbPlacementSchema = z.object({
  snapshotId: ObjectIdSchema,
  issuedAt: IsoDateTimeSchema,
  issuedBy: z.string(),
  policyNumber: z.string().nullable(),
  policyStart: z.iso.date().nullable(),
  policyEnd: z.iso.date().nullable(),
});
export type EbPlacement = z.infer<typeof EbPlacementSchema>;

const GpaRequirementsOutSchema = GpaRequirementsInputSchema.safeExtend({
  claims: z.array(GhiClaimYearSchema),
});
const GtliRequirementsOutSchema = GtliRequirementsInputSchema.safeExtend({
  claims: z.array(GhiClaimYearSchema),
});

const caseBase = GhiCaseRecordSchema.omit({
  requirements: true,
  finalQcr: true,
  policy: true,
  stage: true,
  product: true,
  plan: true,
});

export const EbCaseRecordSchema = z.discriminatedUnion('product', [
  caseBase.extend({
    product: z.literal('GPA'),
    stage: EbStageSchema,
    requirements: GpaRequirementsOutSchema,
    missingItems: z.array(MissingItemSchema),
    plan: EbPlanAssignmentSchema.nullable(),
    placement: EbPlacementSchema.nullable(),
  }),
  caseBase.extend({
    product: z.literal('GTLI'),
    stage: EbStageSchema,
    requirements: GtliRequirementsOutSchema,
    missingItems: z.array(MissingItemSchema),
    plan: EbPlanAssignmentSchema.nullable(),
    placement: EbPlacementSchema.nullable(),
  }),
]);
export type EbCaseRecord = z.infer<typeof EbCaseRecordSchema>;
export type GpaCaseRecord = Extract<EbCaseRecord, { product: 'GPA' }>;
export type GtliCaseRecord = Extract<EbCaseRecord, { product: 'GTLI' }>;

export const EbCaseParamsSchema = z.strictObject({ id: ObjectIdSchema });

export function isEbProduct(value: unknown): value is EbProduct {
  return typeof value === 'string' && (EB_PRODUCTS as readonly string[]).includes(value);
}
