import { z } from 'zod';

/**
 * Role codes as stored on users. The codes stay stable; the labels follow the names in the plan
 * (feature F-2). What each role may do is defined once, in permissions.ts.
 */
export const ROLES = [
  'ADMIN',
  'MANAGER',
  'ACCOUNT_MANAGER',
  'PLACEMENT_EXEC',
  'READ_ONLY',
] as const;

export const RoleSchema = z.enum(ROLES);
export type Role = z.infer<typeof RoleSchema>;

export const ROLE_LABELS: Record<Role, string> = {
  ADMIN: 'Admin',
  MANAGER: 'Approver',
  ACCOUNT_MANAGER: 'Relationship Manager',
  PLACEMENT_EXEC: 'Underwriting / Placement',
  READ_ONLY: 'Read-only',
};

/**
 * One or more roles as a readable label, in the fixed ROLES order, joined with " / " (A1/A2).
 * A user may hold several roles, so a timeline or an RFQ attribution shows each role's label.
 * Returns null when there are no roles, so callers can omit the role rather than show a blank.
 */
export function roleLabel(roles: readonly Role[] | null | undefined): string | null {
  if (!roles || roles.length === 0) return null;
  const ordered = ROLES.filter((role) => roles.includes(role));
  return ordered.length > 0 ? ordered.map((role) => ROLE_LABELS[role]).join(' / ') : null;
}

/** "Name, Role" for a timeline or document attribution; just the name when the role is unknown. */
export function actorLabel(name: string, roles: readonly Role[] | null | undefined): string {
  const label = roleLabel(roles);
  return label ? `${name}, ${label}` : name;
}
