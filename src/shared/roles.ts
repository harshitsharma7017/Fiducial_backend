import { z } from 'zod';

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
  MANAGER: 'Manager',
  ACCOUNT_MANAGER: 'Account Manager',
  PLACEMENT_EXEC: 'Placement Executive',
  READ_ONLY: 'Read-only',
};

/** True when the user holds any of the allowed roles. ADMIN passes every check. */
export function hasRole(userRoles: readonly Role[], ...allowed: readonly Role[]): boolean {
  if (userRoles.includes('ADMIN')) return true;
  return allowed.some((role) => userRoles.includes(role));
}
