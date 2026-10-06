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
