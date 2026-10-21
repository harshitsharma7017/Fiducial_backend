import { z } from 'zod';
import { IsoDateTimeSchema, ObjectIdSchema } from './common.ts';
import { EbProductSchema } from './eb-products.ts';

// A case's plan assignment (Requirement 15): the plan version and a copy of its slots, taken when
// assigned and kept until a user assigns again. Kept apart from family-plans.ts so the GHI case
// contract (ghi.ts) can carry it without an import cycle.

/** The census relationships, in census order (the same values as GHI_RELATIONSHIPS). */
export const PLAN_RELATIONSHIPS = [
  'SELF',
  'SPOUSE',
  'CHILD',
  'FATHER',
  'MOTHER',
  'FATHER_IN_LAW',
  'MOTHER_IN_LAW',
] as const;

export const PlanSlotSchema = z.object({
  name: z.string(),
  min: z.number().int(),
  max: z.number().int(),
  relationships: z.array(
    z.object({ relationship: z.enum(PLAN_RELATIONSHIPS), max: z.number().int() }),
  ),
});
export type PlanSlotRecord = z.infer<typeof PlanSlotSchema>;

export const PLAN_ASSIGNMENT_SOURCES = ['COMPANY_DEFAULT', 'GTLI_DEFAULT', 'USER'] as const;
export type PlanAssignmentSource = (typeof PLAN_ASSIGNMENT_SOURCES)[number];
export const PLAN_ASSIGNMENT_SOURCE_LABELS: Record<PlanAssignmentSource, string> = {
  COMPANY_DEFAULT: 'The company’s default plan',
  GTLI_DEFAULT: 'GTLI Self only (no company default)',
  USER: 'Chosen on the case',
};

export const EbPlanAssignmentSchema = z.object({
  planId: ObjectIdSchema,
  code: z.string(),
  name: z.string(),
  product: EbProductSchema,
  versionNumber: z.number().int(),
  effectiveFrom: z.iso.date(),
  slots: z.array(PlanSlotSchema),
  parentsAndInLawsMixed: z.boolean(),
  /** The plan version's confirmation today (it can change after the assignment). */
  clientConfirmed: z.boolean(),
  openQuestions: z.array(z.number().int()),
  source: z.enum(PLAN_ASSIGNMENT_SOURCES),
  assignedAt: IsoDateTimeSchema,
  assignedBy: z.string(),
});
export type EbPlanAssignment = z.infer<typeof EbPlanAssignmentSchema>;
