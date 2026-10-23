import { z } from 'zod';
import { MemberPrivateFieldSchema } from './masking.ts';
import { IsoDateTimeSchema, ObjectIdSchema } from './common.ts';
import { nameKeyOf } from './census-rules.ts';
import { EbProductSchema } from './eb-products.ts';
import { GhiGenderSchema, type GhiGender } from './ghi-census.ts';
import { GhiStageSchema } from './ghi.ts';

// Employee identity (Requirement 17): one record per company and employee key, shared by GMC,
// GPA and GTLI. It holds only the employee's own details; each product's coverage stays on the
// member of that case. Members of one key that disagree are "unresolved" until a user resolves.

export const EMPLOYEES_PAGE_SIZE = 50;

export const EbEmployeeListQuerySchema = z.strictObject({
  q: z
    .string()
    .trim()
    .max(100, 'Search text is too long')
    .transform((value) => (value === '' ? undefined : value))
    .optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});
export type EbEmployeeListQuery = z.infer<typeof EbEmployeeListQuerySchema>;

export const EbEnrollmentSchema = z.object({
  caseId: ObjectIdSchema,
  product: EbProductSchema,
  reference: z.string(),
  stage: GhiStageSchema,
});

export const EbEmployeeSchema = z.object({
  /** Null for an unresolved employee (no identity yet). */
  id: ObjectIdSchema.nullable(),
  employeeKey: z.string(),
  employeeId: z.string(),
  name: z.string(),
  gender: GhiGenderSchema,
  /** Null when withheld (see `hidden`). */
  dateOfBirth: z.iso.date().nullable(),
  dateOfJoining: z.iso.date().nullable(),
  unresolved: z.boolean(),
  enrollments: z.array(EbEnrollmentSchema),
  /** Unresolved only: what each case's Self member says, so a user can choose. */
  variants: z.array(
    z.object({
      caseId: ObjectIdSchema,
      reference: z.string(),
      product: EbProductSchema,
      name: z.string(),
      gender: GhiGenderSchema,
      dateOfBirth: z.iso.date().nullable(),
    }),
  ),
  updatedAt: IsoDateTimeSchema.nullable(),
  /** Fields withheld from this user (no permission to see them). */
  hidden: z.array(MemberPrivateFieldSchema).optional(),
});
export type EbEmployee = z.infer<typeof EbEmployeeSchema>;

export const EbEmployeeListResponseSchema = z.object({
  items: z.array(EbEmployeeSchema),
  total: z.number().int(),
  unresolved: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
});
export type EbEmployeeListResponse = z.infer<typeof EbEmployeeListResponseSchema>;

const IdentityFields = {
  name: z.string().trim().min(1, 'Enter the name').max(120, 'This is too long'),
  gender: GhiGenderSchema,
  dateOfBirth: z.iso.date({ error: 'Enter the date of birth' }),
  reason: z.string().trim().min(1, 'Say why the details change').max(500, 'This is too long'),
};

export const UpdateEbEmployeeRequestSchema = z.strictObject(IdentityFields);
export type UpdateEbEmployeeRequest = z.infer<typeof UpdateEbEmployeeRequestSchema>;

export const ResolveEbEmployeeRequestSchema = z.strictObject({
  employeeKey: z.string().trim().min(1).max(40),
  ...IdentityFields,
});
export type ResolveEbEmployeeRequest = z.infer<typeof ResolveEbEmployeeRequestSchema>;

export const EbEmployeeParamsSchema = z.strictObject({
  clientId: ObjectIdSchema,
  employeeId: ObjectIdSchema,
});
export const EbCompanyParamsSchema = z.strictObject({ clientId: ObjectIdSchema });

/** The result of an update or resolution: the identity and the cases whose members changed. */
export const EbEmployeeChangeResponseSchema = z.object({
  employee: EbEmployeeSchema,
  casesChanged: z.array(z.object({ caseId: ObjectIdSchema, reference: z.string() })),
});

export interface LinkCandidate {
  name: string;
  gender: GhiGender;
  dateOfBirth: string;
}

/**
 * Whether a company's Self members of one employee key can be linked to one identity (17.10,
 * 17.11): only when every member's name (ignoring case and repeated spaces), gender and date of
 * birth agree with each other and with the existing identity.
 */
export function linkDecision(
  members: readonly LinkCandidate[],
  identity: LinkCandidate | null,
): 'LINK' | 'UNRESOLVED' {
  const all = identity ? [identity, ...members] : [...members];
  if (all.length === 0) return 'LINK';
  const first = all[0]!;
  const key = (item: LinkCandidate) => `${nameKeyOf(item.name)}|${item.gender}|${item.dateOfBirth}`;
  return all.every((item) => key(item) === key(first)) ? 'LINK' : 'UNRESOLVED';
}

/** Company default plans per product (Requirement 15.1). */
export const EbPlanDefaultsResponseSchema = z.object({
  items: z.array(
    z.object({
      product: EbProductSchema,
      planId: ObjectIdSchema.nullable(),
      code: z.string().nullable(),
      name: z.string().nullable(),
      active: z.boolean().nullable(),
      setAt: IsoDateTimeSchema.nullable(),
      setBy: z.string().nullable(),
    }),
  ),
});
export type EbPlanDefaultsResponse = z.infer<typeof EbPlanDefaultsResponseSchema>;
export const SetEbPlanDefaultRequestSchema = z.strictObject({ planId: ObjectIdSchema.nullable() });
export const EbPlanDefaultParamsSchema = z.strictObject({
  clientId: ObjectIdSchema,
  product: EbProductSchema,
});
