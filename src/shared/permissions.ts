import { z } from 'zod';
import type { LegacyRole } from './roles.ts';

/**
 * The permission catalog: every permission the application understands, grouped for the role
 * editor. Roles are stored in the database (the `roles` collection) and hold a subset of this
 * catalog; an administrator chooses which. A permission that is not listed here cannot be stored
 * on a role or checked by a route. Adding one means adding it here, guarding the routes that use
 * it, and saying which legacy permission it was split from (LEGACY_SOURCE) so migrated roles keep
 * their access.
 */

/** Every permission, in catalog order. */
export const PERMISSIONS = [
  'users.view',
  'users.create',
  'users.update',
  'users.deactivate',
  'users.assign_roles',
  'roles.view',
  'roles.create',
  'roles.update',
  'roles.assign_permissions',
  'roles.deactivate',
  'audit.view',
  'settings.view',
  'clients.view',
  'clients.create',
  'clients.update',
  'clients.import',
  'insurers.view',
  'insurers.manage',
  'insurers.import',
  'masters.view',
  'masters.manage',
  'catalog.view',
  'catalog.manage',
  'templates.view',
  'templates.manage',
  'email_templates.view',
  'email_templates.manage',
  'family_plans.view',
  'family_plans.manage',
  'age_bands.view',
  'age_bands.manage',
  'property.view',
  'property.create',
  'property.edit',
  'property.send',
  'property.approve',
  'property.export',
  'property.delete',
  'gmc.view',
  'gmc.create',
  'gmc.edit',
  'gmc.send',
  'gmc.approve',
  'gmc.export',
  'gpa.view',
  'gpa.create',
  'gpa.edit',
  'gpa.send',
  'gpa.approve',
  'gpa.export',
  'gtli.view',
  'gtli.create',
  'gtli.edit',
  'gtli.send',
  'gtli.approve',
  'gtli.export',
  'employees.view',
  'employees.update',
  'employees.view_dob',
  'employees.view_salary',
  'employees.view_nominee',
  'census.export',
  'claims.view',
  'claims.view_documents',
  'claims.view_personal',
  'claims.view_diagnosis',
  'claims.view_bank',
  'claims.create',
  'claims.process',
  'claims.manage_all',
  'claims.assign',
  'claims.links',
  'claims.retry_notifications',
  'claims.settings',
  'claims.tpa_import',
  'claims.tpa_manage',
  'claims_analysis.view',
  'claims_analysis.export',
  'claims_analysis.manage_premiums',
  'renewal_analysis.view',
  'renewal_analysis.export',
  'renewal_analysis.manage',
] as const;
/** A permission from the catalog. */
export type Permission = (typeof PERMISSIONS)[number];

export const PermissionSchema = z.enum(PERMISSIONS);

export interface PermissionInfo {
  key: Permission;
  label: string;
  description: string;
  /** Grants access to personal, medical or financial data, approvals, exports or administration. */
  sensitive?: true;
  /** Permissions the screens using this one also need (shown as a hint; never granted silently). */
  requires?: readonly Permission[];
}

export interface PermissionGroup {
  key: string;
  label: string;
  description: string;
  permissions: readonly PermissionInfo[];
}

type CasePrefix = 'property' | 'gmc' | 'gpa' | 'gtli';
const p = (value: string) => value as Permission;

const caseActions = (prefix: CasePrefix, product: string): PermissionInfo[] => [
  {
    key: p(`${prefix}.view`),
    label: 'View cases',
    description: `See ${product} cases, their Data Sheet, census, RFQ, quotes, QCR, payments and placement.`,
  },
  {
    key: p(`${prefix}.create`),
    label: 'Create cases',
    description: `Start new ${product} cases (and choose who owns them).`,
    requires: [p(`${prefix}.view`), 'clients.view'],
  },
  {
    key: p(`${prefix}.edit`),
    label: 'Edit cases',
    description: `Change ${product} cases: Data Sheet, census uploads and members, insurers, RFQ drafts and submission, quotes, QCR, client decision, payments, placement, closing and owner.`,
    requires: [p(`${prefix}.view`)],
  },
  {
    key: p(`${prefix}.send`),
    label: 'Send to insurers and clients',
    description: `Email ${product} RFQs, reminders, QCRs and placement slips, or mark them sent.`,
    requires: [p(`${prefix}.view`)],
  },
  {
    key: p(`${prefix}.approve`),
    label: 'Approve or return',
    description: `Approve or return ${product} RFQs and QCRs. No rule yet stops someone approving work they submitted (open item GHI-03).`,
    sensitive: true,
    requires: [p(`${prefix}.view`)],
  },
  {
    key: p(`${prefix}.export`),
    label: 'Download documents',
    description: `Download ${product} RFQ, QCR, placement slip, selection summary and mail attachments.`,
    sensitive: true,
    requires: [p(`${prefix}.view`)],
  },
];

export const PERMISSION_GROUPS: readonly PermissionGroup[] = [
  {
    key: 'administration',
    label: 'Administration',
    description: 'Users, roles, the audit log and settings.',
    permissions: [
      {
        key: 'users.view',
        label: 'View users',
        description: 'List users, their roles and status.',
        sensitive: true,
      },
      {
        key: 'users.create',
        label: 'Create users',
        description: 'Add user accounts (with at least one role, which also needs Assign roles).',
        sensitive: true,
        requires: ['users.view', 'users.assign_roles'],
      },
      {
        key: 'users.update',
        label: 'Rename users',
        description: "Change a user's name.",
        sensitive: true,
        requires: ['users.view'],
      },
      {
        key: 'users.deactivate',
        label: 'Deactivate users',
        description:
          'Deactivate or reactivate accounts. A deactivated user is signed out on their next request.',
        sensitive: true,
        requires: ['users.view'],
      },
      {
        key: 'users.assign_roles',
        label: 'Assign roles',
        description:
          "Change a user's roles. Only roles whose permissions you hold yourself can be assigned.",
        sensitive: true,
        requires: ['users.view'],
      },
      {
        key: 'roles.view',
        label: 'View roles',
        description: 'See roles and the permissions they grant.',
        sensitive: true,
      },
      {
        key: 'roles.create',
        label: 'Create roles',
        description: 'Add roles.',
        sensitive: true,
        requires: ['roles.view'],
      },
      {
        key: 'roles.update',
        label: 'Rename roles',
        description: "Change a role's name and description.",
        sensitive: true,
        requires: ['roles.view'],
      },
      {
        key: 'roles.assign_permissions',
        label: 'Choose role permissions',
        description:
          'Add or remove permissions on roles. Only permissions you hold yourself can be added.',
        sensitive: true,
        requires: ['roles.view'],
      },
      {
        key: 'roles.deactivate',
        label: 'Deactivate roles',
        description:
          'Deactivate or reactivate roles. A role still assigned to a user cannot be deactivated.',
        sensitive: true,
        requires: ['roles.view'],
      },
      {
        key: 'audit.view',
        label: 'View the audit log',
        description: 'Read the audit log of every change and sign-in.',
        sensitive: true,
      },
      {
        key: 'settings.view',
        label: 'View settings',
        description: 'See the mail status and system settings.',
        sensitive: true,
      },
    ],
  },
  {
    key: 'clients',
    label: 'Clients',
    description: 'Insured companies and their risk locations.',
    permissions: [
      {
        key: 'clients.view',
        label: 'View clients',
        description: 'See clients, contacts, risk locations and default plans.',
      },
      {
        key: 'clients.create',
        label: 'Create clients',
        description: 'Add clients.',
        requires: ['clients.view'],
      },
      {
        key: 'clients.update',
        label: 'Edit clients',
        description:
          "Edit clients, add and edit risk locations, and change a company's default family plans.",
        requires: ['clients.view'],
      },
      {
        key: 'clients.import',
        label: 'Import clients',
        description: 'Import clients and risk locations from Excel.',
        requires: ['clients.view'],
      },
    ],
  },
  {
    key: 'insurers',
    label: 'Insurers',
    description: 'The insurer master used by every RFQ.',
    permissions: [
      {
        key: 'insurers.view',
        label: 'View insurers',
        description: 'See insurers, their contacts and RFQ addresses.',
      },
      {
        key: 'insurers.manage',
        label: 'Manage insurers',
        description: 'Add, edit, deactivate and reactivate insurers.',
        requires: ['insurers.view'],
      },
      {
        key: 'insurers.import',
        label: 'Import insurers',
        description: 'Import insurers from Excel.',
        requires: ['insurers.view'],
      },
    ],
  },
  {
    key: 'masters',
    label: 'Property masters and templates',
    description: 'Rating masters, policy and cover catalogs, and document and email templates.',
    permissions: [
      {
        key: 'masters.view',
        label: 'View rating masters',
        description: 'See occupancies, pincodes and master versions (IIB).',
      },
      {
        key: 'masters.manage',
        label: 'Manage rating masters',
        description: 'Import, activate and edit the occupancy and pincode masters.',
        requires: ['masters.view'],
      },
      {
        key: 'catalog.view',
        label: 'View policy catalogs',
        description:
          'See policies, coverage sections, add-on covers, tax rates, notes, clauses and occupancy cover defaults.',
      },
      {
        key: 'catalog.manage',
        label: 'Manage policy catalogs',
        description: 'Import and edit those catalogs.',
        requires: ['catalog.view'],
      },
      {
        key: 'templates.view',
        label: 'View document templates',
        description: 'See and download document templates.',
      },
      {
        key: 'templates.manage',
        label: 'Manage document templates',
        description: 'Upload new document templates.',
        requires: ['templates.view'],
      },
      {
        key: 'email_templates.view',
        label: 'View email templates',
        description: 'See the RFQ, reminder, QCR, placement slip and coverage confirmation emails.',
      },
      {
        key: 'email_templates.manage',
        label: 'Edit email templates',
        description: 'Change those emails.',
        requires: ['email_templates.view'],
      },
    ],
  },
  {
    key: 'eb_masters',
    label: 'Employee Benefits masters',
    description: 'The Family Plan and Age Band masters.',
    permissions: [
      {
        key: 'family_plans.view',
        label: 'View family plans',
        description: 'See family plans and their versions.',
      },
      {
        key: 'family_plans.manage',
        label: 'Manage family plans',
        description:
          'Create, edit, activate, confirm and deactivate family plans; see the open cases that use one.',
        requires: ['family_plans.view'],
      },
      {
        key: 'age_bands.view',
        label: 'View age bands',
        description: 'See age band sets and the cases using them.',
      },
      {
        key: 'age_bands.manage',
        label: 'Manage age bands',
        description: 'Create, edit, activate and deactivate age band sets.',
        requires: ['age_bands.view'],
      },
    ],
  },
  {
    key: 'property',
    label: 'Property, Fire and Burglary',
    description:
      'Property proposals and renewals. Fire and Burglary are sections of the same proposal, so they share these permissions.',
    permissions: [
      ...caseActions('property', 'Property'),
      {
        key: 'property.delete',
        label: 'Delete and restore cases',
        description: 'Move Property cases to the Deleted bin, restore them, and see the bin.',
        sensitive: true,
        requires: ['property.view'],
      },
    ],
  },
  {
    key: 'gmc',
    label: 'GMC / GHI (Group Health)',
    description: 'Group health cases.',
    permissions: caseActions('gmc', 'GMC'),
  },
  {
    key: 'gpa',
    label: 'GPA (Group Personal Accident)',
    description: 'Group personal accident cases.',
    permissions: caseActions('gpa', 'GPA'),
  },
  {
    key: 'gtli',
    label: 'GTLI (Group Term Life)',
    description: 'Group term life cases.',
    permissions: caseActions('gtli', 'GTLI'),
  },
  {
    key: 'employees',
    label: 'Employees and census',
    description:
      'Company employees and the personal details in census data. Each field is withheld by the API from users without its permission.',
    permissions: [
      {
        key: 'employees.view',
        label: 'View company employees',
        description: "See a company's employees shared by its GMC, GPA and GTLI cases.",
      },
      {
        key: 'employees.update',
        label: 'Edit company employees',
        description: 'Update or resolve company employees.',
        requires: ['employees.view', 'employees.view_dob'],
      },
      {
        key: 'employees.view_dob',
        label: 'See dates of birth',
        description:
          'See employees’ and dependants’ dates of birth in census members and company employees. Needed to edit members or upload a census.',
        sensitive: true,
      },
      {
        key: 'employees.view_salary',
        label: 'See salaries',
        description:
          'See annual and monthly salaries in GPA and GTLI census members. Needed to edit those members or upload their census.',
        sensitive: true,
      },
      {
        key: 'employees.view_nominee',
        label: 'See nominees',
        description:
          'See nominee names, relationships and dates of birth in GPA and GTLI census members. Needed to edit those members or upload their census.',
        sensitive: true,
      },
      {
        key: 'census.export',
        label: 'Download census error reports',
        description:
          'Download the error report of a census upload (it contains the uploaded rows).',
        sensitive: true,
      },
    ],
  },
  {
    key: 'claims',
    label: 'Claims',
    description: 'Group health claims, employee submission links and TPA claims.',
    permissions: [
      {
        key: 'claims.view',
        label: 'View claims',
        description:
          'See the claims board, claims, their timeline and emails, HR contacts and TPA claims.',
        sensitive: true,
      },
      {
        key: 'claims.view_documents',
        label: 'Open claim documents',
        description:
          'Download claim documents (medical records and bills). Each download is audited.',
        sensitive: true,
        requires: ['claims.view'],
      },
      {
        key: 'claims.view_personal',
        label: "See patients' personal details",
        description:
          "See a patient's date of birth and full phone number on claims (masked otherwise).",
        sensitive: true,
        requires: ['claims.view'],
      },
      {
        key: 'claims.view_diagnosis',
        label: 'See diagnosis details',
        description:
          'See diagnosis, ICD code and rejection reason on TPA claims and in the claims analysis.',
        sensitive: true,
        requires: ['claims.view'],
      },
      {
        key: 'claims.view_bank',
        label: 'See full bank accounts',
        description: 'See full bank account numbers on TPA claims (masked otherwise).',
        sensitive: true,
        requires: ['claims.view'],
      },
      {
        key: 'claims.create',
        label: 'Create claims',
        description:
          'Create claims for employees of placed GMC policies; see those policies’ employees and families.',
        requires: ['claims.view'],
      },
      {
        key: 'claims.process',
        label: 'Work assigned claims',
        description: 'Edit, move, remark on and add documents to the claims assigned to you.',
        requires: ['claims.view'],
      },
      {
        key: 'claims.manage_all',
        label: 'Work any claim',
        description:
          'Edit, move, remark on and add documents to any claim, whoever it is assigned to.',
        sensitive: true,
        requires: ['claims.view'],
      },
      {
        key: 'claims.assign',
        label: 'Reassign claims',
        description: 'Assign a claim to another member of claims staff.',
        sensitive: true,
        requires: ['claims.view'],
      },
      {
        key: 'claims.links',
        label: 'Manage submission links',
        description: 'Issue, list and revoke employee claim submission links.',
        requires: ['claims.view'],
      },
      {
        key: 'claims.retry_notifications',
        label: 'Retry claim emails',
        description: 'Send a failed claim status email again.',
        requires: ['claims.view'],
      },
      {
        key: 'claims.settings',
        label: 'Claims settings',
        description: 'Edit claim email templates and companies’ HR contacts.',
        sensitive: true,
        requires: ['claims.view'],
      },
      {
        key: 'claims.tpa_import',
        label: 'Import TPA files',
        description: 'Check and import TPA claim files, and see TPA formats.',
        requires: ['claims.view'],
      },
      {
        key: 'claims.tpa_manage',
        label: 'Manage TPA formats and settings',
        description: 'Edit TPA formats and the TPA import email settings.',
        sensitive: true,
        requires: ['claims.tpa_import'],
      },
    ],
  },
  {
    key: 'reports',
    label: 'Reports',
    description: 'Claims analysis and renewal analysis.',
    permissions: [
      {
        key: 'claims_analysis.view',
        label: 'View claims analysis',
        description: 'See the claims analysis and endorsement premiums.',
        sensitive: true,
      },
      {
        key: 'claims_analysis.export',
        label: 'Download claims analysis',
        description: 'Download the claims analysis (Excel or PDF).',
        sensitive: true,
        requires: ['claims_analysis.view'],
      },
      {
        key: 'claims_analysis.manage_premiums',
        label: 'Record endorsement premiums',
        description: 'Add and void endorsement premiums used by the claims analysis.',
        requires: ['claims_analysis.view'],
      },
      {
        key: 'renewal_analysis.view',
        label: 'View renewal analysis',
        description:
          'See the renewal analysis (including claim totals per policy year) and saved reports.',
      },
      {
        key: 'renewal_analysis.export',
        label: 'Download renewal analysis',
        description: 'Download the renewal analysis (Excel or PDF).',
        sensitive: true,
        requires: ['renewal_analysis.view'],
      },
      {
        key: 'renewal_analysis.manage',
        label: 'Record years and save reports',
        description: 'Record past policy years and save renewal reports.',
        requires: ['renewal_analysis.view'],
      },
    ],
  },
];

const INFO = new Map<string, PermissionInfo>(
  PERMISSION_GROUPS.flatMap((group) =>
    group.permissions.map((permission) => [permission.key, permission] as const),
  ),
);

/** The catalog entry of a permission. */
export function permissionInfo(permission: Permission): PermissionInfo {
  const info = INFO.get(permission);
  if (!info) throw new Error(`Unknown permission ${permission}`);
  return info;
}

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && INFO.has(value);
}

/** True when the permission set holds the permission. */
export function hasPermission(
  permissions: readonly Permission[] | ReadonlySet<Permission> | null | undefined,
  permission: Permission,
): boolean {
  if (!permissions) return false;
  return 'has' in permissions ? permissions.has(permission) : permissions.includes(permission);
}

/** True when the permission set holds at least one of the permissions. */
export function hasAnyPermission(
  permissions: readonly Permission[] | ReadonlySet<Permission> | null | undefined,
  candidates: readonly Permission[],
): boolean {
  return candidates.some((permission) => hasPermission(permissions, permission));
}

/** The case permission prefix of each line of business. */
export const CASE_PERMISSION_PREFIX = {
  PROPERTY: 'property',
  GMC: 'gmc',
  GPA: 'gpa',
  GTLI: 'gtli',
} as const;
export type CaseLine = keyof typeof CASE_PERMISSION_PREFIX;
export type CaseAction = 'view' | 'create' | 'edit' | 'send' | 'approve' | 'export';

/** The case permission of a line of business and action, for example casePermission('GPA', 'edit'). */
export function casePermission(line: CaseLine, action: CaseAction): Permission {
  return `${CASE_PERMISSION_PREFIX[line]}.${action}` as Permission;
}

// ---------------------------------------------------------------------------------------------
// Legacy model (before database-driven roles). Kept for the migration and its tests: the five
// system roles are created with exactly the access these 17 permissions gave.

export const LEGACY_PERMISSIONS = [
  'proposals.view',
  'proposals.create',
  'proposals.edit',
  'proposals.approve',
  'proposals.send',
  'proposals.export',
  'proposals.delete',
  'clients.view',
  'clients.manage',
  'masters.view',
  'masters.manage',
  'users.manage',
  'settings.view',
  'audit.view',
  'claims.view',
  'claims.process',
  'claims.admin',
] as const;
export type LegacyPermission = (typeof LEGACY_PERMISSIONS)[number];

/** The legacy role table (personas of document 01; Q12 in document 06). */
export const LEGACY_ROLE_PERMISSIONS: Record<LegacyRole, readonly LegacyPermission[]> = {
  ADMIN: LEGACY_PERMISSIONS,
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

/** True when any of the legacy roles held the legacy permission. */
export function can(roles: readonly LegacyRole[], permission: LegacyPermission): boolean {
  return roles.some((role) => LEGACY_ROLE_PERMISSIONS[role].includes(permission));
}

/** The case actions as they were in the legacy model (one set for every line of business). */
const LEGACY_CASE_SOURCE: Record<CaseAction, LegacyPermission> = {
  view: 'proposals.view',
  create: 'proposals.create',
  edit: 'proposals.edit',
  send: 'proposals.send',
  approve: 'proposals.approve',
  export: 'proposals.export',
};

/**
 * The legacy permission each catalog permission was split from: a route guarded by the new
 * permission was guarded by this one. Field-level permissions follow who saw the field before.
 */
export const LEGACY_SOURCE: Record<Permission, LegacyPermission> = {
  'users.view': 'users.manage',
  'users.create': 'users.manage',
  'users.update': 'users.manage',
  'users.deactivate': 'users.manage',
  'users.assign_roles': 'users.manage',
  'roles.view': 'users.manage',
  'roles.create': 'users.manage',
  'roles.update': 'users.manage',
  'roles.assign_permissions': 'users.manage',
  'roles.deactivate': 'users.manage',
  'audit.view': 'audit.view',
  'settings.view': 'settings.view',
  'clients.view': 'clients.view',
  'clients.create': 'clients.manage',
  'clients.update': 'clients.manage',
  'clients.import': 'clients.manage',
  'insurers.view': 'masters.view',
  'insurers.manage': 'masters.manage',
  'insurers.import': 'masters.manage',
  'masters.view': 'masters.view',
  'masters.manage': 'masters.manage',
  'catalog.view': 'masters.view',
  'catalog.manage': 'masters.manage',
  'templates.view': 'masters.view',
  'templates.manage': 'masters.manage',
  'email_templates.view': 'masters.view',
  'email_templates.manage': 'masters.manage',
  'family_plans.view': 'masters.view',
  'family_plans.manage': 'masters.manage',
  'age_bands.view': 'masters.view',
  'age_bands.manage': 'masters.manage',
  ...(Object.fromEntries(
    (['property', 'gmc', 'gpa', 'gtli'] as const satisfies readonly CasePrefix[]).flatMap(
      (prefix) =>
        (Object.keys(LEGACY_CASE_SOURCE) as CaseAction[]).map((action) => [
          `${prefix}.${action}`,
          LEGACY_CASE_SOURCE[action],
        ]),
    ),
  ) as Record<`${CasePrefix}.${CaseAction}`, LegacyPermission>),
  'property.delete': 'proposals.delete',
  'employees.view': 'proposals.view',
  'employees.update': 'proposals.edit',
  // Before, every user who could view a case saw its members' details and error reports.
  'employees.view_dob': 'proposals.view',
  'employees.view_salary': 'proposals.view',
  'employees.view_nominee': 'proposals.view',
  'census.export': 'proposals.view',
  'claims.view': 'claims.view',
  // Before, every claims viewer could open claim documents.
  'claims.view_documents': 'claims.view',
  'claims.view_personal': 'claims.process',
  'claims.view_diagnosis': 'claims.process',
  'claims.view_bank': 'claims.admin',
  'claims.create': 'claims.process',
  'claims.process': 'claims.process',
  'claims.manage_all': 'claims.admin',
  'claims.assign': 'claims.admin',
  'claims.links': 'claims.process',
  'claims.retry_notifications': 'claims.process',
  'claims.settings': 'claims.admin',
  'claims.tpa_import': 'claims.process',
  'claims.tpa_manage': 'claims.admin',
  'claims_analysis.view': 'claims.view',
  'claims_analysis.export': 'claims.view',
  'claims_analysis.manage_premiums': 'proposals.edit',
  'renewal_analysis.view': 'proposals.view',
  'renewal_analysis.export': 'proposals.export',
  'renewal_analysis.manage': 'proposals.edit',
};

/** The catalog permissions a legacy role is migrated with: exactly the access it had. */
export function legacyRolePermissions(role: LegacyRole): Permission[] {
  return PERMISSIONS.filter((permission) => can([role], LEGACY_SOURCE[permission]));
}

/** Effective catalog permissions of a set of legacy roles (demo users and tests). */
export function legacyPermissionsOf(roles: readonly LegacyRole[]): Permission[] {
  return PERMISSIONS.filter((permission) => can(roles, LEGACY_SOURCE[permission]));
}
