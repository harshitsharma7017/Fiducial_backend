import type { Role } from './roles.ts';

/**
 * What a signed-in user may do. Each API route checks one permission (requirePermission in the
 * backend) and the web app shows a screen or an action only to users who hold its permission,
 * so both repos read the same table.
 */
export const PERMISSIONS = [
  'proposals.view',
  'proposals.create',
  'proposals.edit',
  'proposals.approve',
  'proposals.send',
  'proposals.export',
  /** Move a case to the Deleted bin, restore it, and see the bin. Admins only. */
  'proposals.delete',
  'clients.view',
  'clients.manage',
  'masters.view',
  'masters.manage',
  'users.manage',
  'settings.view',
  'audit.view',
  /** Group health claims: see the board, claims, their documents and timeline. */
  'claims.view',
  /** Create claims, issue employee submission links, and work the claims assigned to you. */
  'claims.process',
  /** Move or reassign any claim, edit the claim email templates and HR contacts. */
  'claims.admin',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/**
 * The permissions of each role, taken from the personas in document 01 (PRD, section 4):
 * Relationship Managers create risks and send RFQs, Underwriting / Placement staff prepare RFQs
 * and quotes, Approvers sign off, Admins run users and masters, Read-only users only view. The
 * Relationship Manager owns the client, so clients.manage goes to them; the insurer master is
 * master data (masters.manage). Who approves RFQs and placements, and who else may edit clients,
 * is still to be confirmed by the client (document 06, Q12; see docs/OPEN_ITEMS.md). Claims hold
 * medical information, so Read-only users do not see them; who processes claims is CLM-01 there. ADMIN holds
 * every permission; a user with several roles holds the union.
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  ADMIN: PERMISSIONS,
  MANAGER: [
    'proposals.view',
    'proposals.approve',
    'proposals.export',
    'clients.view',
    'masters.view',
    'claims.view',
  ],
  ACCOUNT_MANAGER: [
    'proposals.view',
    'proposals.create',
    'proposals.edit',
    'proposals.send',
    'proposals.export',
    'clients.view',
    'clients.manage',
    'masters.view',
    'claims.view',
    'claims.process',
  ],
  PLACEMENT_EXEC: [
    'proposals.view',
    'proposals.edit',
    'proposals.send',
    'proposals.export',
    'clients.view',
    'masters.view',
    'claims.view',
    'claims.process',
  ],
  READ_ONLY: ['proposals.view', 'clients.view', 'masters.view'],
};

/** True when any of the roles holds the permission. */
export function can(roles: readonly Role[], permission: Permission): boolean {
  return roles.some((role) => ROLE_PERMISSIONS[role].includes(permission));
}
