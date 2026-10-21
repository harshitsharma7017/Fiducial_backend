import { z } from 'zod';
import { IsoDateTimeSchema, ObjectIdSchema } from './common.ts';
import { EbProductSchema, type EbProduct } from './eb-products.ts';
import { PlanSlotSchema } from './eb-plan.ts';
import { GHI_RELATIONSHIPS, GHI_RELATIONSHIP_LABELS, type GhiRelationship } from './ghi-census.ts';

// The Family Plan Master (N2): who a family may include, per product, as versioned data. A plan
// version is Draft until activated; an Active version's slots, limits and start date never
// change (only its end date, set once, and the client's confirmation, No to Yes). One schema
// holds the configuration rules (Requirement 13) for the API and the web app's form alike.

/** Technical bounds, not client rules (Requirements 13.2 and 13.5). */
export const MAX_PLAN_SLOTS = 7;
export const MAX_SLOT_NAME = 50;
export const MAX_SLOT_MEMBERS = 10;

/** Relationships of which a family has at most one (Self, Spouse: open question 8; parents). */
export const SINGLE_RELATIONSHIPS: readonly GhiRelationship[] = [
  'SELF',
  'SPOUSE',
  'FATHER',
  'MOTHER',
  'FATHER_IN_LAW',
  'MOTHER_IN_LAW',
];
export const PARENT_RELATIONSHIPS: readonly GhiRelationship[] = ['FATHER', 'MOTHER'];
export const IN_LAW_RELATIONSHIPS: readonly GhiRelationship[] = ['FATHER_IN_LAW', 'MOTHER_IN_LAW'];

export const PLAN_VERSION_STATUSES = ['DRAFT', 'ACTIVE'] as const;
export type PlanVersionStatus = (typeof PLAN_VERSION_STATUSES)[number];
export const PLAN_VERSION_STATUS_LABELS: Record<PlanVersionStatus, string> = {
  DRAFT: 'Draft',
  ACTIVE: 'Active',
};

export interface PlanSlot {
  name: string;
  min: number;
  max: number;
  relationships: Array<{ relationship: GhiRelationship; max: number }>;
}

export interface PlanVersionInput {
  effectiveFrom: string;
  effectiveTo: string | null;
  parentsAndInLawsMixed: boolean;
  slots: PlanSlot[];
}

/** What a slot looks like before the rules are checked (any value of the right JSON type). */
const RawSlotSchema = z.strictObject({
  name: z.string(),
  min: z.number(),
  max: z.number(),
  relationships: z.array(
    z.strictObject({ relationship: z.string(), max: z.number().nullable().optional() }),
  ),
});

const isIsoDate = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) && z.iso.date().safeParse(value).success;
const isWhole = (value: number, min: number, max: number) =>
  Number.isInteger(value) && value >= min && value <= max;

type RawVersion = {
  effectiveFrom: string;
  effectiveTo?: string | null;
  parentsAndInLawsMixed?: boolean | null;
  slots: Array<z.infer<typeof RawSlotSchema>>;
};

export interface PlanVersionIssue {
  path: (string | number)[];
  message: string;
}

const slotLabel = (index: number, name: string) =>
  `Slot ${index + 1}${name.trim() ? ` (${name.trim()})` : ''}`;
const relationshipLabel = (relationship: string) =>
  (GHI_RELATIONSHIP_LABELS as Record<string, string>)[relationship] ?? relationship;

/**
 * Every rule of Requirements 13.2 to 13.7 and the dates of 12.2, checked at once (13.9): each
 * issue names the slot by position and name, and the relationship where one is involved.
 */
export function planVersionIssues(version: RawVersion): PlanVersionIssue[] {
  const issues: PlanVersionIssue[] = [];
  const add = (path: (string | number)[], message: string) => issues.push({ path, message });

  if (!isIsoDate(version.effectiveFrom)) {
    add(['effectiveFrom'], 'Enter the date the version takes effect');
  }
  const to = version.effectiveTo ?? null;
  if (to !== null) {
    if (!isIsoDate(to)) add(['effectiveTo'], 'Enter a valid end date or leave it blank');
    else if (isIsoDate(version.effectiveFrom) && to < version.effectiveFrom) {
      add(['effectiveTo'], 'The end date must be on or after the start date');
    }
  }
  if (version.parentsAndInLawsMixed === null || version.parentsAndInLawsMixed === undefined) {
    add(
      ['parentsAndInLawsMixed'],
      'State whether parents and parents-in-law may be in one family (Yes or No)',
    );
  }

  const slots = version.slots;
  if (slots.length < 1 || slots.length > MAX_PLAN_SLOTS) {
    add(['slots'], `Give the version 1 to ${MAX_PLAN_SLOTS} slots`);
  }
  const names = new Map<string, number>();
  const seen = new Map<string, number>();
  const selfSlots: number[] = [];

  slots.forEach((slot, index) => {
    const label = slotLabel(index, slot.name);
    const name = slot.name.trim();
    if (!name) add(['slots', index, 'name'], `${label}: name the slot`);
    else if (name.length > MAX_SLOT_NAME) {
      add(['slots', index, 'name'], `${label}: use at most ${MAX_SLOT_NAME} characters`);
    } else {
      const key = name.toLowerCase();
      const first = names.get(key);
      if (first !== undefined) {
        add(
          ['slots', index, 'name'],
          `${label}: slot ${first + 1} already has this name; give each slot its own name`,
        );
      } else names.set(key, index);
    }
    const minOk = isWhole(slot.min, 0, MAX_SLOT_MEMBERS);
    const maxOk = isWhole(slot.max, 1, MAX_SLOT_MEMBERS);
    if (!minOk) {
      add(['slots', index, 'min'], `${label}: the minimum must be a whole number from 0 to 10`);
    }
    if (!maxOk) {
      add(['slots', index, 'max'], `${label}: the maximum must be a whole number from 1 to 10`);
    }
    if (minOk && maxOk && slot.min > slot.max) {
      add(['slots', index, 'min'], `${label}: the minimum must not be above the maximum`);
    }
    if (slot.relationships.length === 0) {
      add(['slots', index, 'relationships'], `${label}: choose at least one relationship`);
    }
    const inSlot = new Set<string>();
    let sumOfMaximums = 0;
    let everyMaximumKnown = true;
    slot.relationships.forEach((item, position) => {
      const path = ['slots', index, 'relationships', position];
      const known = (GHI_RELATIONSHIPS as readonly string[]).includes(item.relationship);
      if (!known) {
        add(
          [...path, 'relationship'],
          `${label}: "${item.relationship}" is not a census relationship`,
        );
        everyMaximumKnown = false;
        return;
      }
      const name = relationshipLabel(item.relationship);
      if (item.relationship === 'SELF') selfSlots.push(index);
      if (inSlot.has(item.relationship)) {
        add([...path, 'relationship'], `${label}: ${name} is listed twice; list it once`);
      } else {
        inSlot.add(item.relationship);
        const earlier = seen.get(item.relationship);
        if (earlier !== undefined && earlier !== index) {
          add(
            [...path, 'relationship'],
            `${label}: ${name} is already in ${slotLabel(earlier, slots[earlier]?.name ?? '')}; a relationship belongs to one slot`,
          );
        } else seen.set(item.relationship, index);
      }
      const max = item.max ?? null;
      const slotMax = maxOk ? slot.max : MAX_SLOT_MEMBERS;
      if (max === null || !isWhole(max, 1, slotMax)) {
        add(
          [...path, 'max'],
          `${label}, ${name}: the maximum must be a whole number from 1 to ${slotMax}`,
        );
        everyMaximumKnown = false;
      } else {
        sumOfMaximums += max;
        if (SINGLE_RELATIONSHIPS.includes(item.relationship as GhiRelationship) && max > 1) {
          add([...path, 'max'], `${label}, ${name}: at most 1 per family`);
        }
      }
    });
    if (everyMaximumKnown && minOk && slot.relationships.length > 0 && slot.min > sumOfMaximums) {
      add(
        ['slots', index, 'min'],
        `${label}: the minimum (${slot.min}) is above what its relationships allow together (${sumOfMaximums})`,
      );
    }
  });

  if (selfSlots.length === 0 && slots.length > 0) {
    add(['slots'], 'Add a slot for the employee (Self) with a minimum and maximum of 1');
  }
  const selfSlot = selfSlots[0];
  if (selfSlot !== undefined) {
    const slot = slots[selfSlot]!;
    const label = slotLabel(selfSlot, slot.name);
    if (slot.relationships.some((item) => item.relationship !== 'SELF')) {
      add(
        ['slots', selfSlot, 'relationships'],
        `${label}: the employee's slot holds only Self; move the other relationships to another slot`,
      );
    }
    if (slot.min !== 1 || slot.max !== 1) {
      add(
        ['slots', selfSlot, 'min'],
        `${label}: the employee's slot needs a minimum and maximum of 1`,
      );
    }
  }
  return issues;
}

function versionSchema() {
  return z
    .strictObject({
      effectiveFrom: z.string({ error: 'Enter the date the version takes effect' }),
      effectiveTo: z.string().nullable().default(null),
      /** Required: no default (Requirement 13.7). */
      parentsAndInLawsMixed: z.boolean().nullable().optional(),
      slots: z.array(RawSlotSchema),
    })
    .superRefine((version, context) => {
      for (const issue of planVersionIssues(version)) {
        context.addIssue({ code: 'custom', path: issue.path, message: issue.message });
      }
    })
    .transform((version): PlanVersionInput => ({
      effectiveFrom: version.effectiveFrom,
      effectiveTo: version.effectiveTo,
      parentsAndInLawsMixed: version.parentsAndInLawsMixed === true,
      slots: version.slots.map((slot) => ({
        name: slot.name.trim(),
        min: slot.min,
        max: slot.max,
        relationships: slot.relationships.map((item) => ({
          relationship: item.relationship as GhiRelationship,
          max: item.max ?? 0,
        })),
      })),
    }));
}

/** A plan version as created or edited (Draft), with every rule of Requirement 13. */
export const PlanVersionInputSchema = versionSchema();
export type PlanVersionFormValues = z.input<typeof PlanVersionInputSchema>;

export const FAMILY_PLAN_CODE_PATTERN = /^[A-Za-z0-9+-]{1,20}$/;
export const FamilyPlanCodeSchema = z
  .string()
  .trim()
  .regex(FAMILY_PLAN_CODE_PATTERN, 'Use 1 to 20 letters, digits, + or -');
export const FamilyPlanNameSchema = z
  .string()
  .trim()
  .min(1, 'Name the plan')
  .max(80, 'Use at most 80 characters');

export const CreateFamilyPlanRequestSchema = z.strictObject({
  product: EbProductSchema,
  code: FamilyPlanCodeSchema,
  name: FamilyPlanNameSchema,
  firstVersion: PlanVersionInputSchema,
});
export type CreateFamilyPlanRequest = z.infer<typeof CreateFamilyPlanRequestSchema>;

export const RenameFamilyPlanRequestSchema = z.strictObject({ name: FamilyPlanNameSchema });
export const SetPlanVersionEndRequestSchema = z.strictObject({
  effectiveTo: z.iso.date({ error: 'Enter the end date' }),
});
export const FamilyPlanParamsSchema = z.strictObject({ planId: ObjectIdSchema });
export const FamilyPlanVersionParamsSchema = z.strictObject({
  planId: ObjectIdSchema,
  number: z.coerce.number().int().min(1).max(100_000),
});
export const FamilyPlanListQuerySchema = z.strictObject({
  product: EbProductSchema.optional(),
});

export const FamilyPlanVersionSchema = z.object({
  number: z.number().int(),
  status: z.enum(PLAN_VERSION_STATUSES),
  effectiveFrom: z.iso.date(),
  effectiveTo: z.iso.date().nullable(),
  clientConfirmed: z.boolean(),
  parentsAndInLawsMixed: z.boolean(),
  slots: z.array(PlanSlotSchema),
  createdAt: IsoDateTimeSchema,
  createdBy: z.string(),
  activatedAt: IsoDateTimeSchema.nullable(),
  activatedBy: z.string().nullable(),
});
export type FamilyPlanVersion = z.infer<typeof FamilyPlanVersionSchema>;

export const FamilyPlanSchema = z.object({
  id: ObjectIdSchema,
  product: EbProductSchema,
  code: z.string(),
  name: z.string(),
  active: z.boolean(),
  isDefault: z.boolean(),
  /** The open questions the client has to answer for this plan (defaults of Requirement 14.2). */
  openQuestions: z.array(z.number().int()),
  /** The version in effect today (IST), if any. */
  inEffect: z.number().int().nullable(),
  versions: z.array(FamilyPlanVersionSchema),
  updatedAt: IsoDateTimeSchema,
});
export type FamilyPlan = z.infer<typeof FamilyPlanSchema>;

export const FamilyPlanListItemSchema = FamilyPlanSchema.omit({ versions: true }).extend({
  versionCount: z.number().int(),
  current: FamilyPlanVersionSchema.nullable(),
});
export type FamilyPlanListItem = z.infer<typeof FamilyPlanListItemSchema>;
export const FamilyPlanListResponseSchema = z.object({ items: z.array(FamilyPlanListItemSchema) });
export type FamilyPlanListResponse = z.infer<typeof FamilyPlanListResponseSchema>;

export const FamilyPlanOpenCasesResponseSchema = z.object({
  items: z.array(
    z.object({
      id: ObjectIdSchema,
      product: EbProductSchema,
      reference: z.string(),
      clientName: z.string(),
      stage: z.string(),
      versionNumber: z.number().int(),
    }),
  ),
});
export type FamilyPlanOpenCasesResponse = z.infer<typeof FamilyPlanOpenCasesResponseSchema>;

// Pure helpers

export interface DateRange {
  effectiveFrom: string;
  effectiveTo: string | null;
}

/** True when the two ranges share at least one day; a blank end has no end (12.7). */
export function overlaps(a: DateRange, b: DateRange): boolean {
  const aEndsBeforeB = a.effectiveTo !== null && a.effectiveTo < b.effectiveFrom;
  const bEndsBeforeA = b.effectiveTo !== null && b.effectiveTo < a.effectiveFrom;
  return !aEndsBeforeB && !bEndsBeforeA;
}

export interface PlanVersionLike extends DateRange {
  number: number;
  status: PlanVersionStatus;
}

/** The Active version whose dates hold the day (YYYY-MM-DD), or null; never a Draft. */
export function versionOn<V extends PlanVersionLike>(
  plan: { versions: readonly V[] },
  date: string,
): V | null {
  let found: V | null = null;
  for (const version of plan.versions) {
    if (version.status !== 'ACTIVE') continue;
    if (version.effectiveFrom > date) continue;
    if (version.effectiveTo !== null && version.effectiveTo < date) continue;
    if (!found || version.number > found.number) found = version;
  }
  return found;
}

/** Whether a slot of the plan accepts a parent or parent-in-law (GMC's "parents covered", D6). */
export function planAcceptsParents(slots: readonly Pick<PlanSlot, 'relationships'>[]): boolean {
  return slots.some((slot) =>
    slot.relationships.some(
      (item) =>
        PARENT_RELATIONSHIPS.includes(item.relationship) ||
        IN_LAW_RELATIONSHIPS.includes(item.relationship),
    ),
  );
}

/** Whether the plan accepts anyone besides the employee. */
export function planHasDependants(slots: readonly Pick<PlanSlot, 'relationships'>[]): boolean {
  return slots.some((slot) => slot.relationships.some((item) => item.relationship !== 'SELF'));
}

/** Every relationship the plan's slots accept, in the census order. */
export function planRelationships(
  slots: readonly Pick<PlanSlot, 'relationships'>[],
): GhiRelationship[] {
  const accepted = new Set(
    slots.flatMap((slot) => slot.relationships.map((item) => item.relationship)),
  );
  return GHI_RELATIONSHIPS.filter((relationship) => accepted.has(relationship));
}

/** One line per slot, for instructions, documents and screens. */
export function slotText(slot: PlanSlot): string {
  const range = slot.min === slot.max ? `${slot.min}` : `${slot.min} to ${slot.max}`;
  const each = slot.relationships
    .map((item) => {
      const name = GHI_RELATIONSHIP_LABELS[item.relationship];
      return slot.relationships.length > 1 || item.max !== slot.max
        ? `${name} (at most ${item.max})`
        : name;
    })
    .join(', ');
  return `${slot.name}: ${each}; ${range} member${slot.max === 1 ? '' : 's'}`;
}

/** How the mixing setting reads: not applicable when no slot accepts parents. */
export function mixingText(version: {
  parentsAndInLawsMixed: boolean;
  slots: readonly Pick<PlanSlot, 'relationships'>[];
}) {
  if (!planAcceptsParents(version.slots)) return 'Not applicable (no parent slot)';
  return version.parentsAndInLawsMixed
    ? 'Allowed (parents and parents-in-law may be in one family)'
    : 'Not allowed (parents or parents-in-law, not both)';
}

export const AWAITING_CLIENT_CONFIRMATION = 'Awaiting client confirmation';

export function awaitingText(openQuestions: readonly number[]): string {
  return openQuestions.length > 0
    ? `${AWAITING_CLIENT_CONFIRMATION} (open question${openQuestions.length === 1 ? '' : 's'} ${openQuestions.join(', ')})`
    : AWAITING_CLIENT_CONFIRMATION;
}

// Default plans (Requirement 14.2), each awaiting the client's confirmation.

export interface DefaultFamilyPlan {
  product: EbProduct;
  code: string;
  name: string;
  /** The census template's name (Requirement 19.1). */
  templateName: string;
  openQuestions: number[];
  version: PlanVersionInput;
}

const self: PlanSlot = {
  name: 'Self',
  min: 1,
  max: 1,
  relationships: [{ relationship: 'SELF', max: 1 }],
};
const spouse: PlanSlot = {
  name: 'Spouse',
  min: 0,
  max: 1,
  relationships: [{ relationship: 'SPOUSE', max: 1 }],
};
const children: PlanSlot = {
  name: 'Children',
  min: 0,
  max: 3,
  relationships: [{ relationship: 'CHILD', max: 3 }],
};
const parents = (max: number): PlanSlot => ({
  name: 'Parents',
  min: 0,
  max,
  relationships: [
    { relationship: 'FATHER', max: 1 },
    { relationship: 'MOTHER', max: 1 },
    { relationship: 'FATHER_IN_LAW', max: 1 },
    { relationship: 'MOTHER_IN_LAW', max: 1 },
  ],
});
/** A technical date so that every policy start falls in version 1 (not a client rule). */
export const DEFAULT_PLAN_EFFECTIVE_FROM = '2000-01-01';
const version = (slots: PlanSlot[], mixed: boolean): PlanVersionInput => ({
  effectiveFrom: DEFAULT_PLAN_EFFECTIVE_FROM,
  effectiveTo: null,
  parentsAndInLawsMixed: mixed,
  slots,
});

export const DEFAULT_FAMILY_PLANS: readonly DefaultFamilyPlan[] = [
  {
    product: 'GMC',
    code: 'SELF',
    name: 'GMC Self only',
    templateName: 'GMC Self',
    openQuestions: [16],
    version: version([self], false),
  },
  {
    product: 'GMC',
    code: '1+3',
    name: 'GMC 1+3',
    templateName: 'GMC 1+3',
    openQuestions: [3, 8, 16],
    version: version([self, spouse, children], false),
  },
  {
    product: 'GMC',
    code: '1+5',
    name: 'GMC 1+5',
    templateName: 'GMC 1+5',
    openQuestions: [3, 4, 8, 16],
    version: version([self, spouse, children, parents(2)], true),
  },
  {
    product: 'GMC',
    code: '1+7',
    name: 'GMC 1+7',
    templateName: 'GMC 1+7',
    openQuestions: [3, 4, 8, 16],
    version: version([self, spouse, children, parents(4)], true),
  },
  {
    product: 'GPA',
    code: 'SELF',
    name: 'GPA Self only',
    templateName: 'GPA Self Only',
    openQuestions: [16],
    version: version([self], false),
  },
  {
    product: 'GPA',
    code: '1+3',
    name: 'GPA 1+3',
    templateName: 'GPA 1+3',
    openQuestions: [3, 8, 16],
    version: version([self, spouse, children], false),
  },
  {
    product: 'GTLI',
    code: 'SELF',
    name: 'GTLI Self only',
    templateName: 'GTLI',
    openQuestions: [6, 16],
    version: version([self], false),
  },
];

/** The template name of a plan: the default's (Requirement 19.1), else product and code. */
export function templateNameOf(plan: { product: EbProduct; code: string }): string {
  return (
    DEFAULT_FAMILY_PLANS.find((item) => item.product === plan.product && item.code === plan.code)
      ?.templateName ?? `${plan.product} ${plan.code}`
  );
}
