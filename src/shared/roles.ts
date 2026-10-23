import { z } from 'zod';
import { IsoDateTimeSchema, ObjectIdSchema } from './common.ts';
import { PermissionSchema } from './permissions.ts';

/**
 * Roles are stored in the database (the `roles` collection) and hold permissions from the catalog
 * in permissions.ts. A user stores role keys. A key is a stable identifier: it never changes when
 * the role is renamed, and authorization never looks at role names.
 *
 * The five legacy codes below are the keys of the system roles the migration creates, with the
 * access they had before roles became configurable (feature F-2 labels).
 */
export const ROLES = [
  'ADMIN',
  'MANAGER',
  'ACCOUNT_MANAGER',
  'PLACEMENT_EXEC',
  'READ_ONLY',
] as const;
export const LegacyRoleSchema = z.enum(ROLES);
export type LegacyRole = z.infer<typeof LegacyRoleSchema>;

/** The system role that holds every permission and cannot be edited or deactivated. */
export const ADMIN_ROLE_KEY = 'ADMIN' satisfies LegacyRole;

export const ROLE_LABELS: Record<LegacyRole, string> = {
  ADMIN: 'Admin',
  MANAGER: 'Approver',
  ACCOUNT_MANAGER: 'Relationship Manager',
  PLACEMENT_EXEC: 'Underwriting / Placement',
  READ_ONLY: 'Read-only',
};

export const ROLE_DESCRIPTIONS: Record<LegacyRole, string> = {
  ADMIN: 'Every permission, including users, roles and settings. Cannot be edited or deactivated.',
  MANAGER: 'Approves RFQs, QCRs and placement slips; views cases and claims.',
  ACCOUNT_MANAGER: 'Creates and works cases and clients; processes assigned claims.',
  PLACEMENT_EXEC: 'Works cases (RFQs, quotes, placement); processes assigned claims.',
  READ_ONLY: 'Views cases, clients and masters.',
};

export function isLegacyRole(value: unknown): value is LegacyRole {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** A role key: upper case letters, digits and underscores, starting with a letter. */
export const RoleKeySchema = z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/, 'Not a role key');
export type RoleKey = z.infer<typeof RoleKeySchema>;
/** A role key as stored on users (legacy code or custom key). */
export const RoleSchema = RoleKeySchema;
export type Role = RoleKey;

export const ROLE_NAME_MAX = 60;
export const ROLE_DESCRIPTION_MAX = 500;

export const RoleNameSchema = z
  .string()
  .trim()
  .min(2, 'Enter a name of at least 2 characters')
  .max(ROLE_NAME_MAX, 'Name is too long')
  .regex(
    /^[\p{L}\p{N}][\p{L}\p{N} &/,.()'-]*$/u,
    "Use letters, digits, spaces and & / , . ( ) ' -",
  );

/** The uniqueness form of a role name: trimmed, single spaces, lower case. */
export function normalizeRoleName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** The key a new role gets from its name: ROLE names become ROLE_NAMES (made unique by the API). */
export function roleKeyFromName(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/[^A-Za-z0-9_]/g, '')
    .replace(/^_+|_+$/g, '')
    .toUpperCase()
    .slice(0, 32);
  return /^[A-Z]/.test(base) ? base : `ROLE_${base}`.slice(0, 32);
}

const RolePermissionsSchema = z
  .array(PermissionSchema)
  .refine(
    (permissions) => new Set(permissions).size === permissions.length,
    'Each permission once',
  );

export const RoleRecordSchema = z.object({
  id: ObjectIdSchema,
  key: RoleKeySchema,
  name: z.string(),
  description: z.string(),
  permissions: z.array(PermissionSchema),
  /** True for the Administrator system role: every permission, including future ones. */
  allPermissions: z.boolean(),
  isSystem: z.boolean(),
  /** Cannot be edited or deactivated (the Administrator role). */
  locked: z.boolean(),
  active: z.boolean(),
  /** Users holding the role (active and inactive). */
  userCount: z.number().int().nonnegative(),
  version: z.number().int().nonnegative(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type RoleRecord = z.infer<typeof RoleRecordSchema>;

export const RoleListResponseSchema = z.object({ items: z.array(RoleRecordSchema) });
export type RoleListResponse = z.infer<typeof RoleListResponseSchema>;

export const RoleKeyParamsSchema = z.strictObject({ key: RoleKeySchema });

export const CreateRoleRequestSchema = z.strictObject({
  name: RoleNameSchema,
  description: z.string().trim().max(ROLE_DESCRIPTION_MAX).default(''),
  permissions: RolePermissionsSchema,
});
export type CreateRoleRequest = z.input<typeof CreateRoleRequestSchema>;

export const UpdateRoleRequestSchema = z
  .strictObject({
    name: RoleNameSchema.optional(),
    description: z.string().trim().max(ROLE_DESCRIPTION_MAX).optional(),
    permissions: RolePermissionsSchema.optional(),
    /** The version the edit was made against; a stale edit is refused (409). */
    expectedVersion: z.number().int().nonnegative(),
  })
  .refine(
    (body) =>
      body.name !== undefined || body.description !== undefined || body.permissions !== undefined,
    'Change at least one of name, description or permissions',
  );
export type UpdateRoleRequest = z.input<typeof UpdateRoleRequestSchema>;

/**
 * One or more roles as a readable label, joined with " / " (A1/A2). Names come from `names` (the
 * roles collection) when given, else from the legacy labels; unknown keys are left out. Legacy
 * roles come first in their fixed order. Returns null when no role has a label.
 */
export function roleLabel(
  roles: readonly string[] | null | undefined,
  names?: ReadonlyMap<string, string>,
): string | null {
  if (!roles || roles.length === 0) return null;
  const legacy = ROLES.filter((role) => roles.includes(role));
  const custom = roles.filter((role) => !isLegacyRole(role));
  const labels = [...legacy, ...custom]
    .map((role) => names?.get(role) ?? (isLegacyRole(role) ? ROLE_LABELS[role] : null))
    .filter((label): label is string => Boolean(label));
  return labels.length > 0 ? labels.join(' / ') : null;
}

/** "Name, Role" for a timeline or document attribution; just the name when the role is unknown. */
export function actorLabel(
  name: string,
  roles: readonly string[] | null | undefined,
  names?: ReadonlyMap<string, string>,
): string {
  const label = roleLabel(roles, names);
  return label ? `${name}, ${label}` : name;
}
