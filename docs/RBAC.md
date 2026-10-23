# Fiducial RBAC: database-driven roles and permissions

This document is the design, migration plan and reference for Fiducial's role-based access control. The findings that
led to it are in [RBAC_AUDIT_REPORT.md](RBAC_AUDIT_REPORT.md), which is kept unchanged. Section 10 below records which
findings this work fixed.

## 1. Before this change (as inspected)

- Five fixed role codes (`ADMIN`, `MANAGER`, `ACCOUNT_MANAGER`, `PLACEMENT_EXEC`, `READ_ONLY`) in
  `src/shared/roles.ts`, mapped in code to 17 permissions (`src/shared/permissions.ts`).
- `users.roles`: an array of those codes (Mongoose enum). The JWT carries only the user id. `authenticate()` re-reads
  `roles` and `active` on every request.
- Routes call `requirePermission(p)` (or `requireClaimPermission(p)`), which evaluates `can(roles, p)` against the
  table. Several services also call `can()` on role codes (claim assignment, masking, owner and recipient
  eligibility).
- Both frontends hold a byte-identical copy of `src/shared` and gate screens with the same `can(roles, p)`.

## 2. Design

### 2.1 Relationships

```
User.roles: [roleKey] ──► Role { key, name, permissions[], allPermissions, active } ──► Permission catalog (code)
Effective permissions = union of permissions of the user's ACTIVE roles (allPermissions → whole catalog)
```

- **Role keys** are stable identifiers. The legacy codes are the keys of the five system roles. A custom role's key is
  derived from its name when it is created and never changes on rename. Authorization never uses role names.
- **Permissions** come only from the application's catalog (`PERMISSION_CATALOG` in `src/shared/permissions.ts`).
  Unknown strings are rejected by Zod and by the Mongoose enum. There are no per-user overrides.
- **Multiple roles per user** remain supported (the existing model). Permissions are additive.

### 2.2 Role schema (`roles` collection)

| Field                                | Notes                                                                                                    |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `key`                                | Unique, immutable, `^[A-Z][A-Z0-9_]{1,39}$`                                                              |
| `name`, `normalizedName`             | Display name; `normalizedName` (trimmed, collapsed spaces, lower case) is unique                         |
| `description`                        | Up to 500 characters                                                                                     |
| `permissions`                        | Catalog entries only, unique                                                                             |
| `allPermissions`                     | True only for the system Administrator role; grants the whole catalog, including permissions added later |
| `isSystem`                           | Seeded by the migration. System roles cannot be renamed or have their key changed.                       |
| `locked`                             | Administrator only: cannot be edited or deactivated                                                      |
| `active`                             | An inactive role grants nothing                                                                          |
| `version`                            | Optimistic concurrency for edits                                                                         |
| `createdBy`, `updatedBy`, timestamps | Attribution                                                                                              |

### 2.3 Request authorization

1. `authenticate()` verifies the JWT and re-reads the user (`roles`, `active`).
2. It resolves the user's **active** roles from MongoDB on every request (no cache, so changes apply to the next
   request) and computes the effective permission set.
3. Each route declares its access policy (2.4); the permission is checked against that set.
4. Services apply resource rules (claim assignment, masking, state machines) using the same set.

### 2.4 Deny by default

Every route must declare exactly how it is reached, using a tagged middleware from `src/middleware/require-permission.ts`:

- `requirePermission(p)`, `requireAnyPermission([...])`: permission-protected.
- `authenticatedAccess(reason)`: any signed-in user, with the reason documented (own notifications, own profile,
  sign-out). Resource-scoped checks then happen in the service.
- `publicAccess(reason)`: no sign-in (sign-in, health, the employee claim link, which is token-checked).

There are two layers of enforcement:

- **At runtime**, `route()` refuses to run a handler unless a policy middleware has granted the request. A handler
  whose guard was forgotten answers 403 instead of running.
- **In CI**, `test/access-policy.test.ts` walks the Express router stack and fails if any route has no policy.

### 2.5 Safeguards

- **Last administrator:** at least one active user must hold the active system Administrator role. Every user and role
  change is checked inside its transaction.
- **No escalation:** an actor can add to a role, or assign through roles, only permissions they hold themselves.
- **Self-protection:** you cannot deactivate yourself or remove your own Administrator role. Ids are compared as
  ObjectIds, which fixes audit F-01.
- **Assigned roles** cannot be deactivated. Assignments must name existing, active roles.
- Every role create, update, activate and deactivate, and every user role change, is audited with before and after
  values.

## 3. Permission catalog

82 permissions. The full list with descriptions and migrated holders is in Section 13; the source is `PERMISSIONS` and `PERMISSION_GROUPS` in `src/shared/permissions.ts`.

The full catalog with descriptions is generated in Section 11. It is grouped as:

| Group                          | Permissions                                                                                                                                                                                                                                                                                     |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Administration                 | `users.view`, `users.create`, `users.update`, `users.deactivate`, `users.assign_roles`, `roles.view`, `roles.create`, `roles.update`, `roles.assign_permissions`, `roles.deactivate`, `audit.view`, `settings.view`                                                                             |
| Clients                        | `clients.view`, `clients.create`, `clients.update`, `clients.import`                                                                                                                                                                                                                            |
| Insurers                       | `insurers.view`, `insurers.manage`, `insurers.import`                                                                                                                                                                                                                                           |
| Property masters and templates | `masters.view`, `masters.manage`, `catalog.view`, `catalog.manage`, `templates.view`, `templates.manage`, `email_templates.view`, `email_templates.manage`                                                                                                                                      |
| Employee Benefits masters      | `family_plans.view`, `family_plans.manage`, `age_bands.view`, `age_bands.manage`                                                                                                                                                                                                                |
| Property, Fire and Burglary    | `property.view`, `.create`, `.edit`, `.send`, `.approve`, `.export`, `.delete`                                                                                                                                                                                                                  |
| GMC / GHI, GPA, GTLI           | `gmc.*`, `gpa.*`, `gtli.*`: `view`, `create`, `edit`, `send`, `approve`, `export`                                                                                                                                                                                                               |
| Employees and census           | `employees.view`, `employees.update`, `employees.view_dob`, `employees.view_salary`, `employees.view_nominee`, `census.export`                                                                                                                                                                  |
| Claims                         | `claims.view`, `claims.view_documents`, `claims.view_personal`, `claims.view_diagnosis`, `claims.view_bank`, `claims.create`, `claims.process`, `claims.manage_all`, `claims.assign`, `claims.links`, `claims.retry_notifications`, `claims.settings`, `claims.tpa_import`, `claims.tpa_manage` |
| Reports                        | `claims_analysis.view`, `claims_analysis.export`, `claims_analysis.manage_premiums`, `renewal_analysis.view`, `renewal_analysis.export`, `renewal_analysis.manage`                                                                                                                              |

**Not split, deliberately:**

- **Fire and Burglary** are sections of one Property proposal (the same Data Sheet, RFQ, QCR and slip). There is no
  separate Fire or Burglary case, route or record to protect, so `property.*` covers them. Separate permissions would
  have nothing to enforce.
- **Submit** and **reject (return)** are part of `*.edit` and `*.approve` respectively, as today.
- **No `*.delete`** for Employee Benefits, clients or users: those operations do not exist.

## 4. Migration of the five legacy roles

- `ensureSystemRoles()` runs at API start and from `npm run roles:migrate`. It creates any missing system role with the
  permissions derived from the legacy table:
  - Each catalog permission lists the legacy permission it was split from (`LEGACY_SOURCE`).
  - A legacy role receives a new permission exactly when it held that source.
  - So every route a user could call before, they can still call, and no more.
- It is **idempotent**: an existing role (matched by `key`) is never modified, so an administrator's customisation
  survives restarts.
- **Users are not changed**: their `roles` arrays already hold the keys.
- `npm run roles:migrate -- --check` reports, without writing:
  - roles to be created;
  - users whose role keys do not exist;
  - users holding custom roles (relevant to rollback).

## 5. Backward compatibility

- **Route paths and payloads** are unchanged, except:
  - `/auth/me` adds `permissions` and `roleNames`;
  - user DTOs add `roleNames`;
  - `/proposals/owners` accepts an optional `product`;
  - census and employee members may return `null` for fields the caller may not see.
- **Shared contracts:** `can()` and the legacy table stay in `src/shared/permissions.ts` (`LEGACY_PERMISSIONS`,
  `LEGACY_ROLE_PERMISSIONS`). They are used only by the migration and tests.
- **Both frontends** use `user.permissions` from `/auth/me`. Neither contains a list of roles.

## 6. Tests

- `test/roles.test.ts`: role CRUD, validation, uniqueness, unknown permissions, escalation, deactivation rules, last
  administrator, audit.
- `test/user-roles.test.ts`: assignment, multiple roles, inactive or unknown roles, self rules, effective permissions,
  immediate effect.
- `test/access-policy.test.ts`: every route has a policy; unguarded routes are refused at runtime; the public routes
  are exactly the expected list.
- `test/role-migration.test.ts`: idempotency, legacy permission equivalence, no overwrite of customised roles.
- `test/sensitive-fields.test.ts`: census PII masking, census export, claim documents, by permission.
- The existing suites, including the role × endpoint matrix in `test/permissions.test.ts`, run unchanged against the
  migrated roles. That is the regression proof that legacy access is preserved.

## 7. Rollback

- The change is additive in the database (a new `roles` collection; users untouched).
- To roll back the code:
  1. Run `npm run roles:migrate -- --check` and reassign any user who holds a **custom** role to a legacy role. The
     previous code accepts only the five legacy codes.
  2. Deploy the previous tags of all three repositories together (the shared contracts must match).
  3. The `roles` collection can stay (ignored by old code) or be dropped.

## 8. Outstanding business decisions (unchanged by this work)

From audit Section M:

- Client, owner and portfolio scoping of cases (F-02).
- Separation of duties on approvals (F-05; OPEN_ITEMS GHI-03).
- Which roles may see employee PII (F-03).
- Whether Approvers may open medical documents (F-04).
- The password policy (F-06).

The new permissions make each of these a configuration choice for an Administrator (for example removing
`employees.view_salary` from Read-only), but the migrated roles keep today's access until the business decides.

## 9. Implementation reference

### 9.1 Role-management API (`src/modules/roles/roles.routes.ts`)

| Method and path                                    | Permission                                                                          | Notes                                                                                                                                |
| -------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/v1/roles`                                | `roles.view` or `users.assign_roles`                                                | Every role with permissions (the whole catalog for Administrator), status, user count and version                                    |
| `GET /api/v1/roles/{key}`                          | `roles.view` or `users.assign_roles`                                                | One role                                                                                                                             |
| `POST /api/v1/roles`                               | `roles.create` (+ `roles.assign_permissions` when permissions are given)            | 409 `ROLE_NAME_TAKEN`; 403 `PERMISSION_ESCALATION`; key derived from the name, never changes                                         |
| `PATCH /api/v1/roles/{key}`                        | `roles.update` for name and description, `roles.assign_permissions` for permissions | `expectedVersion` required (409 `ROLE_VERSION_CONFLICT`); system roles keep their names; Administrator is locked (409 `ROLE_LOCKED`) |
| `POST /api/v1/roles/{key}/activate`, `/deactivate` | `roles.deactivate`                                                                  | A role assigned to any user cannot be deactivated (409 `ROLE_IN_USE`)                                                                |

User administration (`src/modules/users/users.routes.ts`):

| Method and path            | Permission                                                                       | Notes                                                                    |
| -------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `GET /api/v1/users`        | `users.view`                                                                     | Each user lists role keys and `roleNames`                                |
| `POST /api/v1/users`       | `users.create` and `users.assign_roles`                                          | Roles must exist, be active and grant only permissions the creator holds |
| `PATCH /api/v1/users/{id}` | `users.update` (name), `users.assign_roles` (roles), `users.deactivate` (active) | Checked per field sent; see 2.5 for the safeguards                       |

`GET /api/v1/auth/me` returns the user with `permissions` (resolved for that request) and `roleNames`.
`GET /api/v1/proposals/owners?product=PROPERTY|GMC|GPA|GTLI` lists staff who may edit that product's cases.

### 9.2 Authorization middleware

- `src/middleware/auth.ts` (`authenticate`): verifies the JWT, re-reads the user, resolves permissions from the active
  roles (`resolvePermissions` in `src/modules/roles/roles.service.ts`), and sets `req.user.permissions`.
- `src/middleware/require-permission.ts`: `requirePermission`, `requireAnyPermission`, `requireClaimPermission` (also
  any-of; audits refusals), `authenticatedAccess(reason)` and `publicAccess(reason)`. Each is tagged as a policy;
  `assertPermission` and `userCan` serve checks that depend on the request body (product of a new case, entity of an
  import, fields of a user or role edit).
- `src/middleware/validate.ts` (`route()`): refuses (403, logged) any request no policy granted.
- Resource and field rules keep their place in the services, now expressed in permissions:
  - claim assignment: `claims.process` on the assignee, or `claims.manage_all` (`claim-common.ts`);
  - patient DOB and phone: `claims.view_personal`;
  - TPA diagnosis: `claims.view_diagnosis`;
  - full bank account: `claims.view_bank`;
  - census and employee fields: `src/modules/ghi/member-redaction.ts`.
- "Who can be chosen" lists come from roles holding a permission (`usersWithPermission`):
  - case owners: `<product>.edit`;
  - claim assignees: `claims.process`;
  - approval notifications: `property.approve`.

### 9.3 Files

| Area                                                                | Files                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared contract (copied to both frontends by `npm run shared:sync`) | `src/shared/permissions.ts` (catalog, legacy table, migration mapping), `src/shared/roles.ts` (keys, schemas, labels), `auth.ts` (`CurrentUserSchema`), `users.ts`, `masking.ts` (`MEMBER_PRIVATE_FIELDS`), `ghi-census.ts`, `eb-census.ts`, `eb-employees.ts` (redactable fields), `proposals.ts` (`ProposalOwnersQuerySchema`), `audit.ts` (role events), `errors.ts` (role error codes), `imports.ts` |
| Backend                                                             | `src/modules/roles/` (model, service, routes), `src/middleware/`, `src/modules/users/`, `src/modules/ghi/member-redaction.ts`, every `*.routes.ts` (permissions), `src/scripts/migrate-roles.ts`, `src/scripts/seed-admin.ts`, `src/server.ts` (runs the migration on start), `src/models.ts`                                                                                                            |
| Frontends (identical in both)                                       | `src/app/(app)/roles/`, `src/components/roles/`, `src/lib/api/roles.ts`, `src/components/users/`, `src/app/(app)/users/users-view.tsx`, `src/hooks/use-current-user.ts`, `src/hooks/use-permission.ts`, `src/components/layout/page-gate.tsx`, `src/lib/server/mock-mode.ts`                                                                                                                             |
| Frontends (per app)                                                 | `src/components/layout/nav-config.ts`, `src/lib/server/proxy-paths.ts` (`roles` area), every screen's `usePermission`                                                                                                                                                                                                                                                                                    |

### 9.4 Configuration

No new environment variable. The migration runs on every start (idempotent) and as `npm run roles:migrate`
(`roles:migrate:prod` for the built `dist`). `USE_MOCK_API=true` in the frontends still signs in demo users; their
permissions are the migrated permissions of their legacy role.

## 10. Administrative UI (both frontends)

Both frontends have **Admin › Roles** (`/roles`, `roles.view`) with identical code:

- The list shows search, name, description, permission count, user count, status and last update. A locked or system
  role is marked.
- Actions appear only with the matching permission: New role (`roles.create`); Edit (`roles.update` or
  `roles.assign_permissions`, otherwise View); Activate and Deactivate (`roles.deactivate`). Deactivate is disabled
  while the role has users.
- The role editor (a side sheet) has:
  - the name and description;
  - permissions grouped as in the catalog, with search, select all and clear per group;
  - the selected count, each permission's description and key, and a **Sensitive** mark;
  - "Its screens also need: …" hints, which are never added silently;
  - the API's refusals (a taken name, escalation, a stale version) shown in place.
- On **Admin › Users** the role selector lists the roles from the API, so new roles appear automatically. Each role's
  description and permission count is shown. Inactive roles cannot be chosen.
- The user form shows the **effective permissions** of the chosen roles. Actions are gated per permission:
  `users.create` + `users.assign_roles` to create, `users.assign_roles` to change roles, `users.deactivate` to
  deactivate.
- Navigation, pages (`PageGate`) and actions use the `permissions` from `/auth/me`. No screen looks at role names.
- The GHI app checks product permissions (`gmc.*`, `gpa.*`, `gtli.*`) per screen and offers only the products the user
  may create.
- Census and employee screens show **Hidden** where the API withheld a field. Claim documents show only with
  `claims.view_documents`.

## 11. Status of the audit findings

The findings themselves are unchanged in [RBAC_AUDIT_REPORT.md](RBAC_AUDIT_REPORT.md). This table records what this
work changed.

| Finding                                                 | Status after this work                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-01 Admin self-protection bypass (upper-case id)       | **Fixed.** Ids are compared as ObjectIds, and a global "at least one active Administrator" check runs in every user and role transaction, serialised so concurrent changes cannot both pass. Tested (`test/user-roles.test.ts`, end to end).                                                                    |
| F-02 No resource-level scoping of cases                 | **Open: business decision.** Still role-based; product-specific permissions now let an administrator confine a role to one line of business. Owner, client or portfolio scoping is not invented (Section 8).                                                                                                    |
| F-03 Census PII readable by Read-only                   | **Mechanism added; default unchanged.** `employees.view_dob`, `employees.view_salary`, `employees.view_nominee` and `census.export` are enforced by the API (redaction, raw-row and download guards). The migrated Read-only role keeps them, as before; an administrator can remove them without code changes. |
| F-04 Medical documents for Approvers                    | **Mechanism added; default unchanged.** `claims.view_documents` is enforced and audited on refusal. The migrated Approver keeps it until the business decides.                                                                                                                                                  |
| F-05 No separation of duties                            | **Open: business decision** (OPEN_ITEMS GHI-03). `*.approve` is now product-specific and grantable separately; self-approval is still possible for anyone holding both edit and approve.                                                                                                                        |
| F-06 No password reset or rotation, no token revocation | **Open.** Out of scope; role and permission changes and deactivation still apply on the next request.                                                                                                                                                                                                           |
| F-07 Link revoke and email retry not assignment-scoped  | **Partly addressed.** Now separate permissions (`claims.links`, `claims.retry_notifications`) that can be withheld; still not assignment-scoped.                                                                                                                                                                |
| F-08 Authorization opt-in per route                     | **Fixed.** Deny by default, at runtime (`route()`) and in CI (`test/access-policy.test.ts`).                                                                                                                                                                                                                    |
| F-09 Public OpenAPI document                            | **Open.** Now an explicit, tested public policy.                                                                                                                                                                                                                                                                |
| F-10 Frontend page gate default-allow; deleted bin      | **Partly fixed.** `/proposals/deleted` now needs `property.delete`; pages with no mapped permission (such as `/profile`) still render.                                                                                                                                                                          |
| F-11 Renewal claim aggregates for Read-only             | **Unchanged** (documented as intended); now its own permission (`renewal_analysis.view`).                                                                                                                                                                                                                       |
| F-12 Role codes and labels disagree                     | **Mitigated.** Screens show role names from the database; keys stay stable (`MANAGER` is named "Approver").                                                                                                                                                                                                     |
| F-13 Denials audited for claims only                    | **Unchanged.**                                                                                                                                                                                                                                                                                                  |
| F-14 Account lockout                                    | **Unchanged.**                                                                                                                                                                                                                                                                                                  |
| F-15 Mock mode default                                  | **Unchanged.**                                                                                                                                                                                                                                                                                                  |
| F-16 Placement approval differs by product              | **Unchanged** (product rule).                                                                                                                                                                                                                                                                                   |

## 12. Tests and results (22 Oct 2026)

| Suite                                                                                                   | Result                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend, all (`npx vitest run`)                                                                         | 84 files, 1,106 passed, 1 skipped, 0 failed (was 79 files, 1,038 passed, 1 skipped)                                                                                          |
| Backend new: `roles`, `user-roles`, `access-policy`, `role-migration`, `sensitive-fields`               | 18 + 13 + 7 + 6 + 11 tests                                                                                                                                                   |
| Backend lint, typecheck, build                                                                          | Pass                                                                                                                                                                         |
| Fiducial_frontend: lint, typecheck, `shared:check`, unit tests, build, Playwright                       | Pass; 83 files, 727 tests; Playwright 2/2                                                                                                                                    |
| fiducial-ghi-frontend: lint, typecheck, `shared:check`, unit tests, build, Playwright                   | Pass; 64 files, 652 tests; Playwright 4/4                                                                                                                                    |
| End to end (local): backend + both production builds on a throwaway in-memory MongoDB, through each BFF | 21/21. A role created in one app is assignable in the other; access follows the role; widening a role applies to the same session; the safeguards hold; changes are audited. |

The existing role × endpoint matrix (`test/permissions.test.ts`) and every feature suite run unchanged against the
migrated roles. That is the regression proof that legacy access is preserved. The matrix's expectations still come
from the legacy table.

## 13. Permission catalog (generated from `src/shared/permissions.ts`)

| Group                          | Permission                        | What it allows                                                                                                                                                            | Sensitive | Split from (legacy) | Migrated roles holding it                                  |
| ------------------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------- | ---------------------------------------------------------- |
| Administration                 | `users.view`                      | List users, their roles and status.                                                                                                                                       | yes       | `users.manage`      | ADMIN                                                      |
| Administration                 | `users.create`                    | Add user accounts (with at least one role, which also needs Assign roles).                                                                                                | yes       | `users.manage`      | ADMIN                                                      |
| Administration                 | `users.update`                    | Change a user's name.                                                                                                                                                     | yes       | `users.manage`      | ADMIN                                                      |
| Administration                 | `users.deactivate`                | Deactivate or reactivate accounts. A deactivated user is signed out on their next request.                                                                                | yes       | `users.manage`      | ADMIN                                                      |
| Administration                 | `users.assign_roles`              | Change a user's roles. Only roles whose permissions you hold yourself can be assigned.                                                                                    | yes       | `users.manage`      | ADMIN                                                      |
| Administration                 | `roles.view`                      | See roles and the permissions they grant.                                                                                                                                 | yes       | `users.manage`      | ADMIN                                                      |
| Administration                 | `roles.create`                    | Add roles.                                                                                                                                                                | yes       | `users.manage`      | ADMIN                                                      |
| Administration                 | `roles.update`                    | Change a role's name and description.                                                                                                                                     | yes       | `users.manage`      | ADMIN                                                      |
| Administration                 | `roles.assign_permissions`        | Add or remove permissions on roles. Only permissions you hold yourself can be added.                                                                                      | yes       | `users.manage`      | ADMIN                                                      |
| Administration                 | `roles.deactivate`                | Deactivate or reactivate roles. A role still assigned to a user cannot be deactivated.                                                                                    | yes       | `users.manage`      | ADMIN                                                      |
| Administration                 | `audit.view`                      | Read the audit log of every change and sign-in.                                                                                                                           | yes       | `audit.view`        | ADMIN                                                      |
| Administration                 | `settings.view`                   | See the mail status and system settings.                                                                                                                                  | yes       | `settings.view`     | ADMIN                                                      |
| Clients                        | `clients.view`                    | See clients, contacts, risk locations and default plans.                                                                                                                  |           | `clients.view`      | ADMIN, MANAGER, ACCOUNT_MANAGER, PLACEMENT_EXEC, READ_ONLY |
| Clients                        | `clients.create`                  | Add clients.                                                                                                                                                              |           | `clients.manage`    | ADMIN, ACCOUNT_MANAGER                                     |
| Clients                        | `clients.update`                  | Edit clients, add and edit risk locations, and change a company's default family plans.                                                                                   |           | `clients.manage`    | ADMIN, ACCOUNT_MANAGER                                     |
| Clients                        | `clients.import`                  | Import clients and risk locations from Excel.                                                                                                                             |           | `clients.manage`    | ADMIN, ACCOUNT_MANAGER                                     |
| Insurers                       | `insurers.view`                   | See insurers, their contacts and RFQ addresses.                                                                                                                           |           | `masters.view`      | ADMIN, MANAGER, ACCOUNT_MANAGER, PLACEMENT_EXEC, READ_ONLY |
| Insurers                       | `insurers.manage`                 | Add, edit, deactivate and reactivate insurers.                                                                                                                            |           | `masters.manage`    | ADMIN                                                      |
| Insurers                       | `insurers.import`                 | Import insurers from Excel.                                                                                                                                               |           | `masters.manage`    | ADMIN                                                      |
| Property masters and templates | `masters.view`                    | See occupancies, pincodes and master versions (IIB).                                                                                                                      |           | `masters.view`      | ADMIN, MANAGER, ACCOUNT_MANAGER, PLACEMENT_EXEC, READ_ONLY |
| Property masters and templates | `masters.manage`                  | Import, activate and edit the occupancy and pincode masters.                                                                                                              |           | `masters.manage`    | ADMIN                                                      |
| Property masters and templates | `catalog.view`                    | See policies, coverage sections, add-on covers, tax rates, notes, clauses and occupancy cover defaults.                                                                   |           | `masters.view`      | ADMIN, MANAGER, ACCOUNT_MANAGER, PLACEMENT_EXEC, READ_ONLY |
| Property masters and templates | `catalog.manage`                  | Import and edit those catalogs.                                                                                                                                           |           | `masters.manage`    | ADMIN                                                      |
| Property masters and templates | `templates.view`                  | See and download document templates.                                                                                                                                      |           | `masters.view`      | ADMIN, MANAGER, ACCOUNT_MANAGER, PLACEMENT_EXEC, READ_ONLY |
| Property masters and templates | `templates.manage`                | Upload new document templates.                                                                                                                                            |           | `masters.manage`    | ADMIN                                                      |
| Property masters and templates | `email_templates.view`            | See the RFQ, reminder, QCR, placement slip and coverage confirmation emails.                                                                                              |           | `masters.view`      | ADMIN, MANAGER, ACCOUNT_MANAGER, PLACEMENT_EXEC, READ_ONLY |
| Property masters and templates | `email_templates.manage`          | Change those emails.                                                                                                                                                      |           | `masters.manage`    | ADMIN                                                      |
| Employee Benefits masters      | `family_plans.view`               | See family plans and their versions.                                                                                                                                      |           | `masters.view`      | ADMIN, MANAGER, ACCOUNT_MANAGER, PLACEMENT_EXEC, READ_ONLY |
| Employee Benefits masters      | `family_plans.manage`             | Create, edit, activate, confirm and deactivate family plans; see the open cases that use one.                                                                             |           | `masters.manage`    | ADMIN                                                      |
| Employee Benefits masters      | `age_bands.view`                  | See age band sets and the cases using them.                                                                                                                               |           | `masters.view`      | ADMIN, MANAGER, ACCOUNT_MANAGER, PLACEMENT_EXEC, READ_ONLY |
| Employee Benefits masters      | `age_bands.manage`                | Create, edit, activate and deactivate age band sets.                                                                                                                      |           | `masters.manage`    | ADMIN                                                      |
| Property, Fire and Burglary    | `property.view`                   | See Property cases, their Data Sheet, census, RFQ, quotes, QCR, payments and placement.                                                                                   |           | `proposals.view`    | ADMIN, MANAGER, ACCOUNT_MANAGER, PLACEMENT_EXEC, READ_ONLY |
| Property, Fire and Burglary    | `property.create`                 | Start new Property cases (and choose who owns them).                                                                                                                      |           | `proposals.create`  | ADMIN, ACCOUNT_MANAGER                                     |
| Property, Fire and Burglary    | `property.edit`                   | Change Property cases: Data Sheet, census uploads and members, insurers, RFQ drafts and submission, quotes, QCR, client decision, payments, placement, closing and owner. |           | `proposals.edit`    | ADMIN, ACCOUNT_MANAGER, PLACEMENT_EXEC                     |
| Property, Fire and Burglary    | `property.send`                   | Email Property RFQs, reminders, QCRs and placement slips, or mark them sent.                                                                                              |           | `proposals.send`    | ADMIN, ACCOUNT_MANAGER, PLACEMENT_EXEC                     |
| Property, Fire and Burglary    | `property.approve`                | Approve or return Property RFQs and QCRs. No rule yet stops someone approving work they submitted (open item GHI-03).                                                     | yes       | `proposals.approve` | ADMIN, MANAGER                                             |
| Property, Fire and Burglary    | `property.export`                 | Download Property RFQ, QCR, placement slip, selection summary and mail attachments.                                                                                       | yes       | `proposals.export`  | ADMIN, MANAGER, ACCOUNT_MANAGER, PLACEMENT_EXEC            |
| Property, Fire and Burglary    | `property.delete`                 | Move Property cases to the Deleted bin, restore them, and see the bin.                                                                                                    | yes       | `proposals.delete`  | ADMIN                                                      |
| GMC / GHI (Group Health)       | `gmc.view`                        | See GMC cases, their Data Sheet, census, RFQ, quotes, QCR, payments and placement.                                                                                        |           | `proposals.view`    | ADMIN, MANAGER, ACCOUNT_MANAGER, PLACEMENT_EXEC, READ_ONLY |
| GMC / GHI (Group Health)       | `gmc.create`                      | Start new GMC cases (and choose who owns them).                                                                                                                           |           | `proposals.create`  | ADMIN, ACCOUNT_MANAGER                                     |
| GMC / GHI (Group Health)       | `gmc.edit`                        | Change GMC cases: Data Sheet, census uploads and members, insurers, RFQ drafts and submission, quotes, QCR, client decision, payments, placement, closing and owner.      |           | `proposals.edit`    | ADMIN, ACCOUNT_MANAGER, PLACEMENT_EXEC                     |
| GMC / GHI (Group Health)       | `gmc.send`                        | Email GMC RFQs, reminders, QCRs and placement slips, or mark them sent.                                                                                                   |           | `proposals.send`    | ADMIN, ACCOUNT_MANAGER, PLACEMENT_EXEC                     |
| GMC / GHI (Group Health)       | `gmc.approve`                     | Approve or return GMC RFQs and QCRs. No rule yet stops someone approving work they submitted (open item GHI-03).                                                          | yes       | `proposals.approve` | ADMIN, MANAGER                                             |
| GMC / GHI (Group Health)       | `gmc.export`                      | Download GMC RFQ, QCR, placement slip, selection summary and mail attachments.                                                                                            | yes       | `proposals.export`  | ADMIN, MANAGER, ACCOUNT_MANAGER, PLACEMENT_EXEC            |
| GPA (Group Personal Accident)  | `gpa.view`                        | See GPA cases, their Data Sheet, census, RFQ, quotes, QCR, payments and placement.                                                                                        |           | `proposals.view`    | ADMIN, MANAGER, ACCOUNT_MANAGER, PLACEMENT_EXEC, READ_ONLY |
| GPA (Group Personal Accident)  | `gpa.create`                      | Start new GPA cases (and choose who owns them).                                                                                                                           |           | `proposals.create`  | ADMIN, ACCOUNT_MANAGER                                     |
| GPA (Group Personal Accident)  | `gpa.edit`                        | Change GPA cases: Data Sheet, census uploads and members, insurers, RFQ drafts and submission, quotes, QCR, client decision, payments, placement, closing and owner.      |           | `proposals.edit`    | ADMIN, ACCOUNT_MANAGER, PLACEMENT_EXEC                     |
| GPA (Group Personal Accident)  | `gpa.send`                        | Email GPA RFQs, reminders, QCRs and placement slips, or mark them sent.                                                                                                   |           | `proposals.send`    | ADMIN, ACCOUNT_MANAGER, PLACEMENT_EXEC                     |
| GPA (Group Personal Accident)  | `gpa.approve`                     | Approve or return GPA RFQs and QCRs. No rule yet stops someone approving work they submitted (open item GHI-03).                                                          | yes       | `proposals.approve` | ADMIN, MANAGER                                             |
| GPA (Group Personal Accident)  | `gpa.export`                      | Download GPA RFQ, QCR, placement slip, selection summary and mail attachments.                                                                                            | yes       | `proposals.export`  | ADMIN, MANAGER, ACCOUNT_MANAGER, PLACEMENT_EXEC            |
| GTLI (Group Term Life)         | `gtli.view`                       | See GTLI cases, their Data Sheet, census, RFQ, quotes, QCR, payments and placement.                                                                                       |           | `proposals.view`    | ADMIN, MANAGER, ACCOUNT_MANAGER, PLACEMENT_EXEC, READ_ONLY |
| GTLI (Group Term Life)         | `gtli.create`                     | Start new GTLI cases (and choose who owns them).                                                                                                                          |           | `proposals.create`  | ADMIN, ACCOUNT_MANAGER                                     |
| GTLI (Group Term Life)         | `gtli.edit`                       | Change GTLI cases: Data Sheet, census uploads and members, insurers, RFQ drafts and submission, quotes, QCR, client decision, payments, placement, closing and owner.     |           | `proposals.edit`    | ADMIN, ACCOUNT_MANAGER, PLACEMENT_EXEC                     |
| GTLI (Group Term Life)         | `gtli.send`                       | Email GTLI RFQs, reminders, QCRs and placement slips, or mark them sent.                                                                                                  |           | `proposals.send`    | ADMIN, ACCOUNT_MANAGER, PLACEMENT_EXEC                     |
| GTLI (Group Term Life)         | `gtli.approve`                    | Approve or return GTLI RFQs and QCRs. No rule yet stops someone approving work they submitted (open item GHI-03).                                                         | yes       | `proposals.approve` | ADMIN, MANAGER                                             |
| GTLI (Group Term Life)         | `gtli.export`                     | Download GTLI RFQ, QCR, placement slip, selection summary and mail attachments.                                                                                           | yes       | `proposals.export`  | ADMIN, MANAGER, ACCOUNT_MANAGER, PLACEMENT_EXEC            |
| Employees and census           | `employees.view`                  | See a company's employees shared by its GMC, GPA and GTLI cases.                                                                                                          |           | `proposals.view`    | ADMIN, MANAGER, ACCOUNT_MANAGER, PLACEMENT_EXEC, READ_ONLY |
| Employees and census           | `employees.update`                | Update or resolve company employees.                                                                                                                                      |           | `proposals.edit`    | ADMIN, ACCOUNT_MANAGER, PLACEMENT_EXEC                     |
| Employees and census           | `employees.view_dob`              | See employees’ and dependants’ dates of birth in census members and company employees. Needed to edit members or upload a census.                                         | yes       | `proposals.view`    | ADMIN, MANAGER, ACCOUNT_MANAGER, PLACEMENT_EXEC, READ_ONLY |
| Employees and census           | `employees.view_salary`           | See annual and monthly salaries in GPA and GTLI census members. Needed to edit those members or upload their census.                                                      | yes       | `proposals.view`    | ADMIN, MANAGER, ACCOUNT_MANAGER, PLACEMENT_EXEC, READ_ONLY |
| Employees and census           | `employees.view_nominee`          | See nominee names, relationships and dates of birth in GPA and GTLI census members. Needed to edit those members or upload their census.                                  | yes       | `proposals.view`    | ADMIN, MANAGER, ACCOUNT_MANAGER, PLACEMENT_EXEC, READ_ONLY |
| Employees and census           | `census.export`                   | Download the error report of a census upload (it contains the uploaded rows).                                                                                             | yes       | `proposals.view`    | ADMIN, MANAGER, ACCOUNT_MANAGER, PLACEMENT_EXEC, READ_ONLY |
| Claims                         | `claims.view`                     | See the claims board, claims, their timeline and emails, HR contacts and TPA claims.                                                                                      | yes       | `claims.view`       | ADMIN, MANAGER, ACCOUNT_MANAGER, PLACEMENT_EXEC            |
| Claims                         | `claims.view_documents`           | Download claim documents (medical records and bills). Each download is audited.                                                                                           | yes       | `claims.view`       | ADMIN, MANAGER, ACCOUNT_MANAGER, PLACEMENT_EXEC            |
| Claims                         | `claims.view_personal`            | See a patient's date of birth and full phone number on claims (masked otherwise).                                                                                         | yes       | `claims.process`    | ADMIN, ACCOUNT_MANAGER, PLACEMENT_EXEC                     |
| Claims                         | `claims.view_diagnosis`           | See diagnosis, ICD code and rejection reason on TPA claims and in the claims analysis.                                                                                    | yes       | `claims.process`    | ADMIN, ACCOUNT_MANAGER, PLACEMENT_EXEC                     |
| Claims                         | `claims.view_bank`                | See full bank account numbers on TPA claims (masked otherwise).                                                                                                           | yes       | `claims.admin`      | ADMIN                                                      |
| Claims                         | `claims.create`                   | Create claims for employees of placed GMC policies; see those policies’ employees and families.                                                                           |           | `claims.process`    | ADMIN, ACCOUNT_MANAGER, PLACEMENT_EXEC                     |
| Claims                         | `claims.process`                  | Edit, move, remark on and add documents to the claims assigned to you.                                                                                                    |           | `claims.process`    | ADMIN, ACCOUNT_MANAGER, PLACEMENT_EXEC                     |
| Claims                         | `claims.manage_all`               | Edit, move, remark on and add documents to any claim, whoever it is assigned to.                                                                                          | yes       | `claims.admin`      | ADMIN                                                      |
| Claims                         | `claims.assign`                   | Assign a claim to another member of claims staff.                                                                                                                         | yes       | `claims.admin`      | ADMIN                                                      |
| Claims                         | `claims.links`                    | Issue, list and revoke employee claim submission links.                                                                                                                   |           | `claims.process`    | ADMIN, ACCOUNT_MANAGER, PLACEMENT_EXEC                     |
| Claims                         | `claims.retry_notifications`      | Send a failed claim status email again.                                                                                                                                   |           | `claims.process`    | ADMIN, ACCOUNT_MANAGER, PLACEMENT_EXEC                     |
| Claims                         | `claims.settings`                 | Edit claim email templates and companies’ HR contacts.                                                                                                                    | yes       | `claims.admin`      | ADMIN                                                      |
| Claims                         | `claims.tpa_import`               | Check and import TPA claim files, and see TPA formats.                                                                                                                    |           | `claims.process`    | ADMIN, ACCOUNT_MANAGER, PLACEMENT_EXEC                     |
| Claims                         | `claims.tpa_manage`               | Edit TPA formats and the TPA import email settings.                                                                                                                       | yes       | `claims.admin`      | ADMIN                                                      |
| Reports                        | `claims_analysis.view`            | See the claims analysis and endorsement premiums.                                                                                                                         | yes       | `claims.view`       | ADMIN, MANAGER, ACCOUNT_MANAGER, PLACEMENT_EXEC            |
| Reports                        | `claims_analysis.export`          | Download the claims analysis (Excel or PDF).                                                                                                                              | yes       | `claims.view`       | ADMIN, MANAGER, ACCOUNT_MANAGER, PLACEMENT_EXEC            |
| Reports                        | `claims_analysis.manage_premiums` | Add and void endorsement premiums used by the claims analysis.                                                                                                            |           | `proposals.edit`    | ADMIN, ACCOUNT_MANAGER, PLACEMENT_EXEC                     |
| Reports                        | `renewal_analysis.view`           | See the renewal analysis (including claim totals per policy year) and saved reports.                                                                                      |           | `proposals.view`    | ADMIN, MANAGER, ACCOUNT_MANAGER, PLACEMENT_EXEC, READ_ONLY |
| Reports                        | `renewal_analysis.export`         | Download the renewal analysis (Excel or PDF).                                                                                                                             | yes       | `proposals.export`  | ADMIN, MANAGER, ACCOUNT_MANAGER, PLACEMENT_EXEC            |
| Reports                        | `renewal_analysis.manage`         | Record past policy years and save renewal reports.                                                                                                                        |           | `proposals.edit`    | ADMIN, ACCOUNT_MANAGER, PLACEMENT_EXEC                     |
