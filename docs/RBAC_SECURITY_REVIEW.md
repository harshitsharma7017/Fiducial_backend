# RBAC Pre-Deployment Security Review

|                      |                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Date                 | 23 Oct 2026                                                                                                                                                                                                                                                                                                                                                                   |
| Scope                | The database-driven RBAC as committed: Fiducial_backend `9e74f91`, Fiducial_frontend `b8d78fb`, fiducial-ghi-frontend `d107f58` (all on `main`, clean before and after the review).                                                                                                                                                                                           |
| References           | [RBAC.md](RBAC.md) (design and implementation), [RBAC_AUDIT_REPORT.md](RBAC_AUDIT_REPORT.md) (original findings)                                                                                                                                                                                                                                                              |
| Method               | Source review of middleware, role and user services, routes, migration and both frontends; dynamic probes against disposable in-memory MongoDB databases; the full suites; a cross-frontend end-to-end run against production builds. No production system, data or configuration was touched. No source file was changed by this review; this report is the only file added. |
| Note on independence | The implementation was written in an earlier session by the same assistant. Every claim of [RBAC.md](RBAC.md) was treated as unverified and re-tested here.                                                                                                                                                                                                                   |

**Evidence labels**

- **Confirmed (dynamic)**: observed by requests against a disposable database.
- **Confirmed (source)**: established by reading the code path end to end.
- **Suspected**: plausible from the source, not reproduced.
- **Policy**: behaviour that matches the documented decisions and awaits the business.

## 1. Summary

The core controls hold under direct API attack:

- Unauthorized permission grants are refused when creating and editing roles.
- Escalation through role assignment, including self-assignment, is refused.
- Unknown permissions are rejected.
- Protected fields cannot be set through the user-update endpoint.
- Inactive roles grant nothing.
- Multiple roles combine as a union.
- The last active Administrator cannot be removed, including under concurrency (10/10 races resolved correctly) and
  with case-variant ids.
- Every route carries an explicit policy, and both frontends behave identically against the shared backend, in both
  directions.

**No Critical or High finding.** Three Medium findings. Each affects only configurations that use custom roles, not
the five migrated roles:

| ID   | Finding                                                                                 |
| ---- | --------------------------------------------------------------------------------------- |
| R-01 | A delegated role manager can strip permissions from roles more powerful than themselves |
| R-02 | `audit.view` exposes the employee personal fields that `employees.view_*` protect       |
| R-03 | The claim-creation pickers return dates of birth without `employees.view_dob`           |

There is also one CI-reliability defect in new tests (R-04).

**Recommendation: ready for staging after R-04 is fixed. Not ready for production until R-01 to R-03 and R-05 are
fixed and the deployment order (Section 6) is followed.**

## 2. Findings by severity

### R-01 Role editors can remove permissions from roles beyond their own access (Medium, Confirmed dynamic)

- **Evidence:** `src/modules/roles/roles.service.ts:323-348`. `updateRole` checks only that _added_ permissions are
  held by the editor (`assertWithinActor(actor, added)`, line 348). Nothing compares the role's _current_ permissions
  with the editor's. By contrast, users beyond the actor's access cannot be managed (`users.service.ts`,
  `assertWithinActor` on the target).
- **Observed:** a delegate holding `roles.assign_permissions` and only `gpa.view` among business permissions:
  - reduced the system **Approver** role to `gpa.view` (200);
  - emptied a custom claims role holding `claims.view` and `claims.process` (200).
- **Impact:** integrity and availability, not confidentiality. A delegated administrator can silently take away access
  from colleagues more privileged than themselves, for example remove approvals from every Approver. The change is
  audited. With the migrated roles only Admins hold `roles.assign_permissions`, so the risk exists only once custom
  delegated-admin roles are created.
- **Minimal fix:**
  - In `updateRole`, also call `assertWithinActor(actor, before.permissions)` (an editor may change only roles whose
    whole permission set is within their own).
  - Apply the same rule in `setRoleActive` for activation, which today has no check (R-08).
- **Regression test:** a delegate without `property.approve` gets 403 when editing the Approver role.

### R-02 Audit log reveals dates of birth, salaries and nominees to `audit.view` holders (Medium, Confirmed dynamic)

- **Evidence:** member and employee changes are audited with full values:
  - `src/modules/ghi/census.service.ts:450-457` (GMC member: `toCensusMember`);
  - `src/modules/ghi/eb-members.service.ts:306-318,468-476` (`memberAudit`: `dateOfBirth`, `annualSalary`,
    `monthlySalary`, nominee name and relationship);
  - `src/modules/employees/employees.service.ts:209-217,518` (`identityAudit`: `dateOfBirth`).
    `GET /api/v1/audit` needs only `audit.view` (`src/modules/audit/audit.routes.ts:12`) and returns each change's old
    and new value.
- **Observed:** a custom role with only `audit.view` read the audit log (200), and it contained the member's date of
  birth and salary.
- **Impact:** `audit.view` silently implies `employees.view_dob`, `employees.view_salary` and `employees.view_nominee`.
  Today only Admin holds `audit.view`, and Admin holds everything.
- **Minimal fix (choose one):**
  - redact those fields in `toAuditLogEntry` unless the reader holds the matching `employees.view_*` permission
    (preferred: field rule in one place); or
  - stop writing the values for members (log "changed" as the claims audit already does for diagnoses).
    Until then, mark `audit.view` in the catalog as including employee personal data.
- **Regression test:** a reader with `audit.view` only sees member changes without dates of birth, salary or nominee.

### R-03 Claim-creation pickers return members' dates of birth without `employees.view_dob` (Medium, Confirmed source; guard behaviour dynamic)

- **Evidence:**
  - `GET /api/v1/claims/policies/:caseId/employees` and `/employees/:memberId/family` require only `claims.create`
    (`src/modules/claims/claims.routes.ts:184,194`).
  - `policyEmployees` (`src/modules/claims/claims.service.ts:767-779`) returns `ClaimMember` objects, which include
    `dateOfBirth` (`src/shared/claims.ts:464-470`).
  - No redaction applies.
- **Observed:** a role with `claims.view` and `claims.create`, but no employee field permissions, passes the guard and
  reaches the service (400 from `placedPolicy` because the probe case was not placed). A placed policy's members are
  returned with dates of birth.
- **Impact:** an alternate path to `employees.view_dob` data for custom claims roles. The migrated claims processors
  hold `employees.view_dob`, so they are unaffected.
- **Minimal fix:**
  - Redact `dateOfBirth` in these two responses unless the caller holds `employees.view_dob`, and make the field
    nullable in `ClaimMemberSchema`; or
  - decide that `claims.create` legitimately includes it, and document the dependency in the catalog.
- **Regression test:** a claims creator without `employees.view_dob` gets members with `dateOfBirth: null`.

### R-04 New role-management UI tests time out under parallel load (Low security / blocks CI, Confirmed dynamic)

- **Evidence:** `src/components/roles/roles.test.tsx:149` ("creates a role with the chosen permissions") in both
  frontends.
- **Observed:**
  - Full-suite runs failed it with "Test timed out in 20000ms" in 2 of 2 runs in each app, at load averages of 7–14 on
    10 cores.
  - In isolation it passes (13/13 in 14.5 s).
  - `getByRole` name lookups over the 82-checkbox editor are slow in jsdom.
  - Under the same load, other long tests also timed out (`proposal-workspace.test.tsx` is the flaky test already
    recorded in the original baseline).
- **Impact:** an unreliable CI signal, not a product defect.
- **Minimal fix:** scope queries to the permission group (`within(getByRole('group', { name: /…/ }))`) and use
  `getByLabelText` for the checkboxes, or split the test. Do not only raise the timeout.

### R-05 A system-role name collision stops the API from starting (Low, Confirmed dynamic)

- **Evidence:** `ensureSystemRoles` upserts missing system roles (`roles.service.ts:472` onwards). `normalizedName` is
  unique. `src/server.ts:42` runs it at start, and any error there is logged as "Could not connect to MongoDB"
  (line 59) before `exit(1)`.
- **Observed:** with `MANAGER` deleted out of band and a custom role named "Approver" present, `ensureSystemRoles`
  throws E11000.
- **Impact:** a restart loop with a misleading message. It only occurs after manual database edits.
- **Minimal fix:** catch the duplicate in `ensureSystemRoles`, report it (as `roles:migrate --check` does), and start
  without creating that role. Also give the startup failure its own log message.

### R-06 Role resolution trusts stored data more than the API does (Low, Confirmed dynamic)

- **Evidence:** `resolvePermissions` (`roles.service.ts:44-58`):
  - honours `allPermissions` on any role (line 55), not just the locked system Administrator role;
  - copies unknown strings into the permission set (line 57).
- **Observed:**
  - A role inserted directly with `allPermissions: true` and `isSystem: false` granted the whole catalog.
  - An unknown string was present in the resolved set; it is filtered out of `/auth/me` and matches no route, so it is
    harmless today.
- **Impact:** defence in depth only. The API cannot create either state; both need direct database writes.
- **Minimal fix:** honour `allPermissions` only when `isSystem && locked`, and intersect stored permissions with the
  catalog.

### R-07 User creation does not take the administration lock (Low, Suspected)

- **Evidence:** `createUser` (`users.service.ts:68-73`) validates roles but does not call `lockAdministration`;
  `updateUser` (line 153) and `setRoleActive` do.
- **Risk:** write skew. Creating a user with role R concurrently with deactivating R could leave a user holding an
  inactive role. Combined with R-08, that role could later be reactivated by someone who lacks its permissions.
- **Observed:** not reproduced in 15 concurrent attempts.
- **Minimal fix:** call `lockAdministration(session)` in `createUser`.

### R-08 Activating a role has no escalation check (Informational, Confirmed dynamic)

A delegate reactivated a role granting `audit.view`, which they lack (200), but could not assign it (403). The role had
no holders, so nothing was granted. It matters only together with R-07. Fixed by R-01's activation check.

### R-09 Frontends offer actions the API will refuse to some custom roles (Low, usability)

- **GHI:** census upload, member edit and RFQ/placement downloads are gated on `<product>.edit` / `.export` only
  (`src/components/eb/eb-census-panel.tsx:53-55`, `src/components/ghi/census-panel.tsx:53-54`,
  `src/components/ghi/rfq-panel.tsx:78,132`). The API also requires `employees.view_*`, so the user gets 403.
- **Users page:** shows "Roles" and "Deactivate" on rows the actor may not manage (the API refuses).
- **Impact:** usability, not security. The error message is shown.

### R-10 Route-coverage test limitations (Informational)

`test/access-policy.test.ts` proves that every route layer has a policy, that every handler is a `route()` handler
(runtime deny by default), and that the public and self-scoped route lists are exactly as expected. It does not prove:

- **Adequacy.** A write guarded by a read permission would pass. A probe walk found **no** non-GET route relying only on
  a router-level permission today, and all seven any-of routes re-check the specific permission in the handler
  (`eb.routes.ts:53-76`, `roles.routes.ts:56-78`, `imports.routes.ts:31`, `users.routes.ts:56-58`,
  `proposals.routes.ts:129`; claim work by `mayEdit`/`mayMove`).
- **Middleware endpoints.** `/api/docs` (Swagger UI, mounted with `app.use`) is public and outside the test (audit
  F-09).
- **Mount paths.** Express 5 does not expose them, so failures name routes by method and local path.

Recommended addition: a test that every non-GET route has a route-level permission policy.

### R-11 Design notes (Informational, Policy)

- A patient's date of birth on claims is governed by `claims.view_personal`, while the same person's date of birth in
  the census is governed by `employees.view_dob`. Two permissions guard the same data in two contexts. Document it, or
  unify.
- Claims analysis and TPA claim lists show each claim's ICD _chapter_ next to the patient's name without
  `claims.view_diagnosis` (`claims-analysis.service.ts:262`). This behaviour predates RBAC (N10); it is a partial
  diagnosis disclosure for the business to accept or restrict.

## 3. Review results by area

| Review                   | Result                                           | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Permission escalation | Pass, except R-01                                | All of the following refused: role with an unheld permission → 403 `PERMISSION_ESCALATION`; adding one → 403; assigning Approver (more privileged) → 403; assigning ADMIN to self → 403; `permissions` / `allPermissions` in a user PATCH → 400; self-deactivation → 409. Self-assigning a role within one's own permissions → 200 with no gain. Two roles give the union; after one is made inactive, only the other's permissions remain and its product returns 403. Unknown permission → 400.                                                                                          |
| 2. Last Administrator    | Pass                                             | Case-variant id: 409 (also end to end). Self-demotion and self-deactivation: 409. Concurrent mutual demotion of the last two Admins: 10/10 runs `200/409`, never zero Admins. Concurrent mutual deactivation: `200/409`, one Admin left. No user delete endpoint (404). ADMIN role edit or deactivation: 409 `ROLE_LOCKED`. System roles keep their names.                                                                                                                                                                                                                                 |
| 3. Sensitive data        | Pass on the primary paths; R-02, R-03 alternates | Field redaction (members, issues, company employees) and raw-row, upload, error-report and annexure guards verified by `test/sensitive-fields.test.ts`. Unaffected and verified: TPA rows and preview (`claimAccessOf`), TPA error report (private fields blanked for everyone, `tpa-import.service.ts:602`), claim record (no bank or diagnosis), claim cards, claims analysis (age not DOB; ICD code and diagnosis gated), census templates (no members), census import lists (no rows), QCR documents (no member annexure), claim documents (`claims.view_documents`, refusal audited). |
| 4. Route policies        | Pass (see R-10)                                  | Missing policy → 403 before the handler runs (runtime), and the CI test fails. Unknown permission strings cannot compile (`Permission` type); at runtime they grant nothing. Public routes are exactly: login, health, the three claim-link routes, the OpenAPI JSON. Self-scoped routes: notifications (recipient-scoped), `/auth/me`, logout.                                                                                                                                                                                                                                            |
| 5. Migration             | Pass, except R-05                                | Five system roles with exactly the legacy access (shared test per role and permission; the role × endpoint matrix unchanged and passing). Idempotent; never overwrites edited roles. Custom roles survive a restart. Concurrent first start of two instances: both succeed, five roles. Unknown role keys grant nothing; tampered data → R-06.                                                                                                                                                                                                                                             |
| 6. Cross-frontend        | Pass                                             | End to end on committed production builds and a fresh disposable database: 21/21 (role created in the Property app, assigned and edited in the GHI app). The reverse direction: a role created in GHI and assigned in Property; reader lists proposals 200; narrowed in GHI; same Property session 403; `/auth/me` reflects it. Both BFF allowlists include `roles` and `users`. Forbidden operations return 403 with a message.                                                                                                                                                           |
| 7. Business workflows    | Pass                                             | All existing feature suites pass: Property proposals, RFQ, quotes, QCR, placement, renewals, masters; GMC, GPA and GTLI cases, census imports, claims board, transitions, notifications, TPA, analyses and exports. No calculation code was changed.                                                                                                                                                                                                                                                                                                                                       |
| 8. Policy decisions      | Open                                             | Section 5.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## 4. Tests executed (23 Oct 2026)

| Suite                                                                            | Result                                                                                                                                          |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend lint, typecheck, build                                                   | Pass                                                                                                                                            |
| Backend tests (`npx vitest run`)                                                 | 84 files, 1,106 passed, 1 skipped, 0 failed                                                                                                     |
| Fiducial_frontend lint, typecheck, `shared:check`, build                         | Pass                                                                                                                                            |
| Fiducial_frontend tests                                                          | Full runs under load: 716/727 and 724/727 (timeouts; R-04 and the known baseline flake). The failing files in isolation: 6 files, 51/51 passed. |
| fiducial-ghi-frontend lint, typecheck, `shared:check`, build                     | Pass                                                                                                                                            |
| fiducial-ghi-frontend tests                                                      | Full runs under load: 651/652 twice (R-04). In isolation: 13/13.                                                                                |
| Review probes (scratch, outside the repos; backend helpers; disposable database) | 7 probe groups run; observations as quoted in Sections 2–3                                                                                      |
| End to end, committed builds, fresh disposable database                          | 21/21, plus 7 reverse-direction checks (one initial failure was the probe's own invalid query, `type=new`; re-run with a valid request passed)  |

Not executed: Playwright smoke tests (run 22 Oct, 2/2 and 4/4; no UI change since), load or performance tests, and
tests against a real MongoDB server version.

## 5. Remaining policy decisions (not technical defects)

| Topic                                 | Today                                                                               | Decision needed                               |
| ------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------- |
| Client or case ownership (audit F-02) | Product-level only; any holder of `<product>.edit` edits every case of that product | Portfolio, owner or client scoping            |
| Self-approval (F-05, GHI-03)          | Possible for anyone holding both edit and approve                                   | Whether the submitter may approve             |
| Employee personal data (F-03)         | Migrated Read-only and Approver roles keep DOB, salary, nominee                     | Remove from those roles? (configuration only) |
| Medical documents (F-04)              | Migrated Approver keeps `claims.view_documents`                                     | Remove? (configuration only)                  |
| Password reset (F-06)                 | Not implemented                                                                     | Policy and design                             |
| Token revocation (F-06)               | Not implemented; role changes and deactivation still apply on the next request      | Policy and design                             |
| ICD chapter per claim (R-11)          | Visible to claims viewers and analysts                                              | Accept or restrict                            |

## 6. Migration, deployment and rollback risks

- **Deploy the backend first, then both frontends.** New frontends parse `/auth/me` with `CurrentUserSchema`, which
  requires `permissions`; against the old backend they would treat every user as having no access. Old frontends work
  against the new backend for users holding the five legacy roles.
- **Create no custom role until both frontends are updated.** The old frontends' schemas accept only the five legacy
  role keys, so a user holding a custom role cannot use an old frontend.
- **Rollback is practical but ordered:**
  1. Run `npm run roles:migrate -- --check` and move every user on a custom role to a legacy role. With old code those
     users get 500 on every request: `can()` with an unknown role throws, which fails closed. Their records also fail
     the old enum validation on save.
  2. Redeploy the previous tags of all three repositories.
  3. The `roles` collection can stay.
     Data loss on rollback: only the custom role definitions (kept in the collection) and any per-role permission edits.
- **Startup coupling:** the migration runs on every start, so R-05 can block a start after manual database edits.

## 7. Required fixes before staging

1. **R-04:** make the role-editor UI tests reliable in full parallel runs in both frontends, so CI is a trustworthy
   gate.
2. Follow the deployment order in Section 6.

## 8. Required fixes before production

1. **R-01:** role editors limited to roles within their own permissions, including activation (also closes R-08).
2. **R-02:** field-level redaction of employee personal data in the audit log (or not logging the values).
3. **R-03:** redact or explicitly document dates of birth in the claim-creation pickers.
4. **R-05:** a system-role name collision must not prevent startup; a clear startup error message.
5. **Recommended:** R-06 (trust `allPermissions` only on the locked system role; intersect with the catalog), R-07 (lock
   in `createUser`), R-09 (gate the GHI actions on the field permissions too), and R-10's non-GET adequacy test.
6. The business decisions of Section 5 for anything that should differ from the migrated defaults.

## 9. Final recommendation

**Ready for staging after R-04 is fixed and the deployment order is followed.** The migrated roles behave exactly as
before, the backend enforces the new model on every route, and no Critical or High issue was found.

**Not ready for production** until R-01, R-02, R-03 and R-05 are fixed. They matter as soon as administrators start
creating custom delegated or partial roles, which is the purpose of the feature.
