# Fiducial RBAC Audit Report

|        |                                                                                                                                                                                                                                                                                                                 |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Date   | 22 Oct 2026                                                                                                                                                                                                                                                                                                     |
| Scope  | Fiducial_backend `6616c0d`, Fiducial_frontend `dc18060`, fiducial-ghi-frontend `84ccf05` (all on `main`, clean working trees before the audit; afterwards the only change is this new file)                                                                                                                     |
| Type   | Read-only audit. No source, schema, user, role, configuration or environment was changed. One report file was added (this one).                                                                                                                                                                                 |
| Method | Source tracing of every router, middleware and service on the authorization path; a generated inventory of all 306 API endpoints (Appendix A); the existing test suites; and four scratch probes run against the backend's in-memory test database (Section J). Nothing was run against a deployed environment. |

**Evidence labels used below**

- **Confirmed (dynamic)**: observed by a request against the in-memory test database.
- **Confirmed (source)**: established by reading the code path end to end; not exercised by a request.
- **Design decision**: behaviour that matches the documented assumptions but may not match the business rule; marked with the open item that decides it.
- **Recommendation**: future behaviour; not implemented.

---

## A. Executive summary

**How it works.** Fiducial has a single, central RBAC model shared by all three repositories. Five roles
(`ADMIN`, `MANAGER`, `ACCOUNT_MANAGER`, `PLACEMENT_EXEC`, `READ_ONLY`) map to seventeen permissions in one table,
`src/shared/permissions.ts`, which the frontends copy byte for byte (`npm run shared:check`). A user stores only role
codes. The backend signs a JWT carrying only the user id. On **every** request it re-reads the user's roles and
`active` flag from MongoDB, so role changes and deactivation take effect on the next request. Each API route declares
one permission with `requirePermission()` or the audited `requireClaimPermission()`.

**Is it enforced centrally?** Yes, at the role-permission level. All 306 endpoints were inventoried (Appendix A). Every
endpoint either has an explicit permission guard, checks the permission inside the handler (imports), is scoped to the
caller (notifications, `auth/me`, logout), or is deliberately public (login, health, the employee claim link). No
endpoint was found that authenticates without then authorizing, and no endpoint trusts a role or permission sent by the
client. The frontends hide screens and actions with the same table, but the API is the boundary. Both frontends talk
to it only through a server-side BFF that keeps the token in an httpOnly cookie.

**Most important concerns.** No Critical finding was found.

1. **There is no resource-level scoping for cases, clients or claim reads** (F-02). Any user whose role holds
   `proposals.edit` can change, close or reassign any Property, GHI, GPA or GTLI case of any client, whoever owns
   it. Any `proposals.view` holder, including Read-only, can read all of them. Confirmed (dynamic). The `ownerId` field
   exists, but it is used only for display and notifications. Claims enforce assignment for writes, but not for reads.
2. **Employee PII is readable by Read-only users** (F-03). Census members include date of birth, annual and monthly
   salary and nominee details. The claims API, by contrast, masks the patient's date of birth from non-processors.
   Confirmed (source).
3. **Medical documents are downloadable by Approvers** (F-04). The diagnosis text is restricted to `claims.process`,
   but the underlying claim documents are not. Confirmed (source).
4. **The same user can submit and approve their own RFQ** (F-05), and by the same code shape their QCR and placement
   slip. Confirmed (dynamic) for the RFQ. Documented as an assumption in OPEN_ITEMS GHI-03.
5. **The Admin self-protection can be bypassed** with an upper-case id (F-01). This allows an Admin to remove their own
   Admin role or deactivate themselves, and so reach a state with no active Admin. Confirmed (dynamic).
6. **There is no password change, reset or rotation, and no token revocation on logout** (F-06).

**Ready for a refactor?** Yes. The model is small, centralised and consistently applied, with 1,038 passing backend
tests and a role × endpoint matrix test to build on. The refactor work is mostly additive:

- resource scoping (owner, assignment, client);
- separation-of-duties rules;
- field-level data minimisation for PII;
- a guard-coverage test so that no future route can ship without a permission.

Several decisions belong to the business first (Section M).

---

## B. Current architecture

### B.1 Authentication flow

```mermaid
sequenceDiagram
  participant B as Browser
  participant F as Frontend BFF (Next.js server)
  participant A as Fiducial_backend (Express)
  participant D as MongoDB
  B->>F: POST /api/auth/login {email, password}
  F->>A: POST /api/v1/auth/login
  A->>D: find user (+passwordHash); argon2id verify; lockout counters
  A-->>F: {accessToken (JWT sub=userId), expiresIn, user}
  F-->>B: Set-Cookie erp_session / __Host-erp_session (httpOnly, SameSite=Lax) + {user}
  B->>F: GET /api/proxy/<area>/... (cookie)
  F->>F: allowlist check, same-origin check for writes
  F->>A: /api/v1/<area>/... Authorization: Bearer <JWT>
  A->>A: verify HS256, iss, aud, exp
  A->>D: re-read user {roles, active}
  A->>A: requirePermission(p) → can(roles, p)
  A->>A: service: state machine, assignment (claims), masking
  A-->>F: response (401 → BFF clears cookie)
  F-->>B: response
```

| Step                     | Behaviour                                                                                                                                                                                                                               | Evidence                                                                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Password storage         | argon2id; dummy hash for unknown, inactive or locked accounts so timing reveals nothing                                                                                                                                                 | `src/modules/auth/password.ts:3-26`, `auth.service.ts:48-59`                                                                                |
| Login                    | Same 401 for unknown, inactive, locked and wrong password. Five failures lock the account for 15 minutes. Per-IP limiter (in memory). Every outcome is audited.                                                                         | `auth.service.ts:35-93,95-140`, `auth.routes.ts:30-54`                                                                                      |
| Token                    | HS256 JWT, `sub` = user id, `iss` `property-erp-api`, `aud` `property-erp`, `jti`. Lifetime `JWT_EXPIRES_IN_SECONDS` (300–86,400; examples use 28,800 = 8 h). Secret ≥ 32 characters, and a `dev-only` secret is refused in production. | `src/modules/auth/token.ts:11-40`, `src/config/env.ts:63-64,124-127`, `.env.example:13`                                                     |
| Request authentication   | Bearer header only. The user is re-read per request. An inactive or missing user gets 401. Roles come from the database, never from the token or the request.                                                                           | `src/middleware/auth.ts:19-46`                                                                                                              |
| Authorization            | `requirePermission(p)` → `can(user.roles, p)` → 403. The claims variant also writes `CLAIM_ACCESS_DENIED` to the audit log.                                                                                                             | `src/middleware/require-permission.ts:10-47`                                                                                                |
| Logout                   | The API only audits the event; tokens are stateless. The BFF clears the cookie even if the API is down.                                                                                                                                 | `auth.service.ts:142-151`, `auth.routes.ts:66-73`, frontend `src/app/api/auth/logout/route.ts:19-33`                                        |
| Expired or invalid token | `verifyAccessToken` returns null → 401. The BFF clears the cookie on any upstream 401, and the client redirects to `/login?next=`.                                                                                                      | `token.ts:28-40`, frontend `api/proxy/[...path]/route.ts:97`, `src/lib/api-client.ts:100,49-52`                                             |
| Disabled account         | `active=false` → 401 on the next request and at login. There is no delete endpoint (users are never deleted).                                                                                                                           | `auth.ts:36`, `auth.service.ts:45`                                                                                                          |
| Locked account           | Lock affects login only. An existing token keeps working until it expires.                                                                                                                                                              | `auth.ts:30-36` (no `lockedUntil` check)                                                                                                    |
| Password reset or change | **Not implemented** in the API. The `/forgot-password` page says "Contact your administrator". The seed script only creates accounts.                                                                                                   | `src/shared/users.ts:14-31` (no password field on update), `src/scripts/seed-admin.ts:46-57`, frontend `(auth)/forgot-password/page.tsx:17` |
| CORS                     | The `CORS_ORIGIN` allowlist. It is not involved in normal operation because the BFF calls the API server to server.                                                                                                                     | `src/app.ts:116-124`                                                                                                                        |

### B.2 Answers to the authentication questions

| #   | Question                                      | Answer (evidence)                                                                                                                                                                                                                                                                                                                    |
| --- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | How does a user authenticate?                 | Email + password at `POST /api/v1/auth/login` via the BFF. The JWT goes into an httpOnly cookie, and the BFF forwards it as a bearer token (B.1).                                                                                                                                                                                    |
| 2   | Where are roles stored?                       | `users.roles`, an array of the `ROLES` enum, at least one, schema `strict: 'throw'` (`user.model.ts:25-33,39`).                                                                                                                                                                                                                      |
| 3   | Where are permissions stored?                 | In code only, in `ROLE_PERMISSIONS` (`src/shared/permissions.ts:43-76`). There are no per-user permission overrides and no permission collection.                                                                                                                                                                                    |
| 4   | How does the backend identify the user?       | JWT `sub` → `UserModel.findById` (`auth.ts:26-43`).                                                                                                                                                                                                                                                                                  |
| 5   | How are roles and permissions loaded?         | Roles from MongoDB per request; permissions are derived with `can()` (`permissions.ts:79-81`).                                                                                                                                                                                                                                       |
| 6   | Does the backend trust client-supplied roles? | No. The token carries no roles, and request bodies cannot set roles except `users.manage` on `/users` (`users.routes.ts:18`).                                                                                                                                                                                                        |
| 7   | Are permissions from a trusted source?        | Yes: the database plus a compiled table.                                                                                                                                                                                                                                                                                             |
| 8   | Do role changes apply immediately?            | Yes, on the next request (Confirmed dynamic: probe P2 got 403 on `/users` right after the demotion). The **UI** may show old permissions for up to 5 minutes (`use-current-user.ts:13`, `staleTime`).                                                                                                                                |
| 9   | How does logout invalidate state?             | Only the BFF cookie is cleared. The JWT stays valid until `exp` (F-06).                                                                                                                                                                                                                                                              |
| 10  | Same session across both frontends?           | In production each app has its own host and `__Host-erp_session` cookie, so sessions are separate but equivalent (same backend user and token type). On one host (for example localhost) both apps read the same `erp_session` cookie, so they share the session and signing out of one signs out of both (`src/lib/session.ts:11`). |
| 11  | Differences between the apps?                 | The auth code is identical. Differences: the BFF allowlists differ (`src/lib/server/proxy-paths.ts`), the home page differs, and only the GHI app exposes the public `/claim` page and `/api/public/claim-link` BFF.                                                                                                                 |
| 12  | Expired or invalid token?                     | 401 from the API → the BFF clears the cookie → the client redirects to sign-in.                                                                                                                                                                                                                                                      |
| 13  | Disabled, suspended or deleted accounts?      | Disabled: rejected on the next request. Suspended (locked): login only. Deleted: no API exists.                                                                                                                                                                                                                                      |

### B.3 Frontend and backend responsibilities

| Concern        | Backend                                                         | Frontends (both)                                                                                                                                   |
| -------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication | JWT verification and user re-read                               | BFF holds the cookie and adds the bearer header. `src/proxy.ts` sends visitors with no cookie to `/login` (it checks only that the cookie exists). |
| Authorization  | `requirePermission` per route, plus service-level checks (C, E) | `PageGate` and `usePermission()` hide pages and actions using the same `can()` table. Not a security control.                                      |
| Area allowlist | n/a                                                             | `/api/proxy/<area>` restricted per app (defence in depth only)                                                                                     |
| Data masking   | Server-side (DOB, phone, diagnosis, bank account)               | Displays what the API sends                                                                                                                        |

---

## C. Existing roles

The roles are defined in `src/shared/roles.ts:7-24` and their permissions in `src/shared/permissions.ts:43-76`. Both
files are copied unchanged into both frontends. No other role names exist in the code, tests, seeds or documents.
There is no Super Admin, Staff or Viewer role.

| Role code         | UI label                 | Assignment                                   | Who edits it                 | Permissions                                                                                                         | Admin powers                                                          | Insurance access                                                                                       | Data scope                               |
| ----------------- | ------------------------ | -------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| `ADMIN`           | Admin                    | `POST /users` (Admin) or `seed:admin` script | Admin via `PATCH /users/:id` | **All 17** (`ADMIN: PERMISSIONS`)                                                                                   | Users, roles, masters, settings, audit, claims admin, the deleted bin | All products and claims                                                                                | Global                                   |
| `MANAGER`         | **Approver**             | Admin                                        | Admin                        | proposals.view, proposals.approve, proposals.export, clients.view, masters.view, claims.view                        | None                                                                  | View and approve all products; view claims (DOB and phone masked, diagnosis hidden, documents visible) | Global                                   |
| `ACCOUNT_MANAGER` | **Relationship Manager** | Admin                                        | Admin                        | proposals.view, create, edit, send, export; clients.view, clients.manage; masters.view; claims.view, claims.process | None                                                                  | Create and edit all products; manage clients; process **assigned** claims                              | Global, except claim writes (assignment) |
| `PLACEMENT_EXEC`  | Underwriting / Placement | Admin                                        | Admin                        | proposals.view, edit, send, export; clients.view; masters.view; claims.view, claims.process                         | None                                                                  | Edit all products; process assigned claims                                                             | Global, except claim writes              |
| `READ_ONLY`       | Read-only                | Admin                                        | Admin                        | proposals.view, clients.view, masters.view                                                                          | None                                                                  | View all Property and EB cases, including census PII (F-03); no claims                                 | Global                                   |

**Backend enforcement:** `requirePermission` on each route (Appendix A). **Frontend enforcement:** `nav-config.ts`
(`visibleGroups`, `pagePermission`), `PageGate`, and `usePermission` in both apps.

**Observations**

- **No role is defined but unused.** Every role holds permissions and is tested in `test/permissions.test.ts`.
- **The codes and labels disagree.** `MANAGER` is shown as "Approver", and `ACCOUNT_MANAGER` as "Relationship
  Manager"; the demo user `demo.manager@example.com` is a Relationship Manager. That makes misassignment likely
  (F-12).
- **Multiple roles combine.** A user may hold several roles and gets the union (`can()` uses `some`), so
  `ACCOUNT_MANAGER` + `MANAGER` yields both edit and approve (relevant to F-05).
- **One role is unrestricted.** `ADMIN` holds every permission, and no permission is withheld even from Admin
  (relevant to F-05).
- **Implicit assignment** happens only in `seed-admin.ts:55` (`['ADMIN']`). A new user's roles are required, with at
  least one and enum-validated (`src/shared/users.ts:14-19`). There is no default role.
- **Unknown roles fail closed.** A role outside the enum is rejected by Zod and Mongoose. If one ever reached `can()`,
  `ROLE_PERMISSIONS[role]` would be undefined and throw, giving a 500, never a grant.

---

## D. Permission matrix

### D.1 Permissions by role (source: `permissions.ts:43-76`)

| Permission        | ADMIN | MANAGER (Approver) | ACCOUNT_MANAGER (RM) | PLACEMENT_EXEC | READ_ONLY |
| ----------------- | ----- | ------------------ | -------------------- | -------------- | --------- |
| proposals.view    | ✓     | ✓                  | ✓                    | ✓              | ✓         |
| proposals.create  | ✓     | –                  | ✓                    | –              | –         |
| proposals.edit    | ✓     | –                  | ✓                    | ✓              | –         |
| proposals.approve | ✓     | ✓                  | –                    | –              | –         |
| proposals.send    | ✓     | –                  | ✓                    | ✓              | –         |
| proposals.export  | ✓     | ✓                  | ✓                    | ✓              | –         |
| proposals.delete  | ✓     | –                  | –                    | –              | –         |
| clients.view      | ✓     | ✓                  | ✓                    | ✓              | ✓         |
| clients.manage    | ✓     | –                  | ✓                    | –              | –         |
| masters.view      | ✓     | ✓                  | ✓                    | ✓              | ✓         |
| masters.manage    | ✓     | –                  | –                    | –              | –         |
| users.manage      | ✓     | –                  | –                    | –              | –         |
| settings.view     | ✓     | –                  | –                    | –              | –         |
| audit.view        | ✓     | –                  | –                    | –              | –         |
| claims.view       | ✓     | ✓                  | ✓                    | ✓              | –         |
| claims.process    | ✓     | –                  | ✓                    | ✓              | –         |
| claims.admin      | ✓     | –                  | –                    | –              | –         |

### D.2 Role × module × action (backend, from the route inventory)

Legend:

- **A** Allowed
- **D** Denied (403)
- **C** Conditionally allowed (condition in the notes)
- **NI** Not implemented

"All" in the notes means no client, owner or assignment scope (F-02).

| Module / action                                                                                      | ADMIN     | Approver     | RM                  | Placement  | Read-only | Route permission and notes                                                                                                     |
| ---------------------------------------------------------------------------------------------------- | --------- | ------------ | ------------------- | ---------- | --------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Property proposals**: list and read                                                                | A         | A            | A                   | A          | A         | proposals.view; all cases                                                                                                      |
| Create a case or renewal                                                                             | A         | D            | A                   | D          | D         | proposals.create (`proposals.routes.ts:105-130`)                                                                               |
| Data Sheet, insurers, existing policy, stage, close                                                  | A         | D            | A                   | A          | D         | proposals.edit; any case (dynamic probe P3). Stage moves are checked against recorded work (`proposals.service.ts:993-1050`).  |
| RFQ: generate, edit, submit                                                                          | A         | D            | A                   | A          | D         | proposals.edit                                                                                                                 |
| RFQ: approve or return                                                                               | A         | A            | D                   | D          | D         | proposals.approve; no check that the approver ≠ the submitter (F-05)                                                           |
| RFQ: email, remind, mark sent                                                                        | A         | D            | A                   | A          | D         | proposals.send                                                                                                                 |
| RFQ, QCR, slip, mail attachment downloads                                                            | A         | A            | A                   | A          | D         | proposals.export                                                                                                               |
| Quotes: enter, revise, attachments                                                                   | A         | D            | A                   | A          | D         | proposals.edit                                                                                                                 |
| QCR: edit / approve / send                                                                           | A / A / A | D / A / D    | A / D / A           | A / D / A  | D         | edit / approve / send                                                                                                          |
| Client approval, coverage confirmation                                                               | A         | D            | A                   | A          | D         | edit (send for the email)                                                                                                      |
| Placement slip: edit, approve, email, mark placed                                                    | A         | approve only | edit, email, placed | same as RM | D         | edit / approve / send / edit                                                                                                   |
| Delete case, restore, deleted bin                                                                    | A         | D            | D                   | D          | D         | proposals.delete (`proposals.routes.ts:100,180-190`)                                                                           |
| **Masters** (occupancy, pincodes, catalog, templates, notes): read                                   | A         | A            | A                   | A          | A         | masters.view                                                                                                                   |
| Masters: import, activate, edit                                                                      | A         | D            | D                   | D          | D         | masters.manage                                                                                                                 |
| Import data: clients and locations                                                                   | A         | D            | A                   | D          | D         | clients.manage, checked in the handler (`imports.routes.ts:28-30`)                                                             |
| Import data: insurers                                                                                | A         | D            | D                   | D          | D         | masters.manage, checked in the handler                                                                                         |
| **Clients**: read                                                                                    | A         | A            | A                   | A          | A         | clients.view; all clients                                                                                                      |
| Clients: create and edit, locations                                                                  | A         | D            | A                   | D          | D         | clients.manage                                                                                                                 |
| **Insurers**: read / manage                                                                          | A / A     | A / D        | A / D               | A / D      | A / D     | masters.view / masters.manage                                                                                                  |
| **GHI, GPA, GTLI cases**: list and read, including census members, salaries, nominees, error reports | A         | A            | A                   | A          | A         | proposals.view (F-03)                                                                                                          |
| EB create                                                                                            | A         | D            | A                   | D          | D         | proposals.create                                                                                                               |
| EB edit: census, members, quotes, payments, placement, policy, close                                 | A         | D            | A                   | A          | D         | proposals.edit; any case (F-02)                                                                                                |
| EB RFQ and QCR decision                                                                              | A         | A            | D                   | D          | D         | proposals.approve                                                                                                              |
| EB client decision (records the client's acceptance)                                                 | A         | D            | A                   | A          | D         | proposals.edit                                                                                                                 |
| Company employees: read / update                                                                     | A         | A / D        | A                   | A          | A / D     | proposals.view / proposals.edit                                                                                                |
| Company default plans: change                                                                        | A         | D            | A                   | D          | D         | clients.manage                                                                                                                 |
| **Family plans, age bands**: read / manage                                                           | A / A     | A / D        | A / D               | A / D      | A / D     | masters.view / masters.manage                                                                                                  |
| **Claims**: board, list, detail                                                                      | A         | A            | A                   | A          | D         | claims.view; all claims; DOB and phone masked unless claims.process (`claim-common.ts:274`)                                    |
| Claim documents: download                                                                            | A         | A            | A                   | A          | D         | claims.view (F-04)                                                                                                             |
| Create a claim, issue a link, pick policies and employees                                            | A         | D            | A                   | A          | D         | claims.process                                                                                                                 |
| Edit, move, remark, upload on a claim                                                                | A         | D            | C                   | C          | D         | claims.process **and** assignee, or claims.admin (`claim-common.ts:50-58`, `claims.service.ts:324,427,528,689`)                |
| Revoke a link, retry a claim email                                                                   | A         | D            | A                   | A          | D         | claims.process; **not** assignment-scoped (F-07)                                                                               |
| Reassign a claim, claim email templates, HR contacts (write)                                         | A         | D            | D                   | D          | D         | claims.admin                                                                                                                   |
| **TPA**: claims list / import / formats and settings                                                 | A / A / A | A / D / D    | A / A / D           | A / A / D  | D         | claims.view / claims.process / claims.admin; diagnosis to claims.process, bank account to claims.admin (`tpa.routes.ts:73-79`) |
| **Claims analysis**: view, download                                                                  | A         | A            | A                   | A          | D         | claims.view; diagnosis columns only for claims.process                                                                         |
| Endorsement premiums (write)                                                                         | A         | D            | A                   | A          | D         | proposals.edit                                                                                                                 |
| **Renewal analysis**: view / download / record years and reports                                     | A         | A / A / D    | A / A / A           | A / A / A  | A / D / D | proposals.view / export / edit; claim aggregates only (F-11)                                                                   |
| **Users**: list, create, edit roles, deactivate                                                      | A         | D            | D                   | D          | D         | users.manage; self-protection is bypassable (F-01)                                                                             |
| Delete a user                                                                                        | NI        | NI           | NI                  | NI         | NI        | No endpoint                                                                                                                    |
| Change your own password / reset a password                                                          | NI        | NI           | NI                  | NI         | NI        | F-06                                                                                                                           |
| Self-service profile update                                                                          | NI        | NI           | NI                  | NI         | NI        | `/profile` is read-only; no API                                                                                                |
| **Email templates** (RFQ, QCR, slip, coverage)                                                       | A (edit)  | read         | read                | read       | read      | masters.view / masters.manage                                                                                                  |
| **Audit log**                                                                                        | A         | D            | D                   | D          | D         | audit.view                                                                                                                     |
| **Settings**: mail status                                                                            | A         | D            | D                   | D          | D         | settings.view (`mail.routes.ts:12`)                                                                                            |
| Notifications: own                                                                                   | A         | A            | A                   | A          | A         | Recipient-scoped (`notifications.routes.ts:57-64`)                                                                             |

### D.3 The two frontends against the backend

For the shared screens, the page and nav permissions are identical in both apps. Both read the same
`permissions.ts`:

| Screen                           | Property app                            | GHI app     | Backend                                               |
| -------------------------------- | --------------------------------------- | ----------- | ----------------------------------------------------- |
| Users, Audit log, Settings       | users.manage, audit.view, settings.view | same        | same                                                  |
| Clients, client page             | clients.view (edit: clients.manage)     | same        | same                                                  |
| Insurers                         | masters.view (edit: masters.manage)     | same        | same                                                  |
| Email templates                  | masters.view (edit: masters.manage)     | same        | same                                                  |
| Import data                      | clients.manage (page)                   | not present | per entity                                            |
| Deleted bin `/proposals/deleted` | page gate proposals.view                | n/a         | proposals.delete (handler). Cosmetic mismatch (F-10). |

---

## E. Backend API authorization inventory

**Coverage: 32 router files, 359 route registrations, 306 unique endpoints (GPA and GTLI share one router), all
reviewed.** Appendix A lists every endpoint with its file and line. The generator is described in Section J.

### E.1 Summary by protection

| Protection                              | Endpoints (registrations) | Notes                                                                                                                                                                                                                                                                                                               |
| --------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Explicit route or router permission     | 346                       | proposals.edit 109, proposals.view 79, claims.process 23, proposals.export 20, masters.view 19, proposals.send 16, masters.manage 28, claims.view 12, proposals.approve 10, claims.admin 9, clients.manage 5, proposals.create 5, clients.view 4, users.manage 3, proposals.delete 2, audit.view 1, settings.view 1 |
| Permission checked inside the handler   | 2                         | `/imports/:entity/template`, `POST /imports/:entity`: `assertMayImport` (`imports.routes.ts:28-30,41,60`)                                                                                                                                                                                                           |
| Scoped to the caller only               | 6                         | `/notifications/*` (recipient), `/auth/me`, `/auth/logout`                                                                                                                                                                                                                                                          |
| Public by design                        | 5                         | `POST /auth/login`, `GET /health`, 3 × `/claim-links/current*` (link token)                                                                                                                                                                                                                                         |
| **Authenticated without authorization** | **0**                     | None found                                                                                                                                                                                                                                                                                                          |

### E.2 Resource-level and state checks that exist

| Check                                                                                               | Where                                                                                                                    |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Claim writes need the assignee or claims.admin                                                      | `claim-common.ts:50-58`; `claims.service.ts:324-326,426-430,528,689`                                                     |
| Claim links: token hash lookup, expiry, revocation, one placed policy and employee, own claims only | `claim-links.service.ts:43-47,105-117,191,348`                                                                           |
| Notifications: recipient only, others return 404                                                    | `notifications.routes.ts:57-64`, `notifications.service.ts:135,169`                                                      |
| Deleted cases return 404 on every `/proposals/:id` route; the bin needs proposals.delete            | `proposals.routes.ts:345-346,100`                                                                                        |
| Users: no self-deactivation, no self-removal of Admin (bypassable, F-01)                            | `users.service.ts:97-104`                                                                                                |
| Server-side state machines: RFQ steps, claim transitions, proposal stages, placement preconditions  | `rfq.service.ts:296-311`; `claims.service.ts:327-340`; `proposals.service.ts:1000-1050`; `eb-placement.service.ts:72-73` |
| Server-side masking: patient DOB and phone, TPA diagnosis, bank account                             | `claim-common.ts:272-309`; `tpa.routes.ts:73-79`; `tpa-claims.service.ts:93-97`; `analysis.routes.ts:93-94,119-122`      |
| Optimistic concurrency on status changes                                                            | `rfq.service.ts:322-332`; `claims.service.ts:327-333`                                                                    |

### E.3 Checklist results (prompt items A–L)

| Item                              | Result                                                                                                                                                                                                                                                                                  |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Missing authorization          | None found (E.1).                                                                                                                                                                                                                                                                       |
| B. Authentication-only protection | Only the caller-scoped routes (notifications, me, logout), which is correct.                                                                                                                                                                                                            |
| C. Inconsistent middleware        | Claims denials are audited (`requireClaimPermission`); others are not (F-13). Placement slips have an approval step on Property but not on GHI/EB (approval sits upstream on the QCR, so not a bypass; F-14).                                                                           |
| D. Direct object access           | **Yes for cases, clients and claim reads**: any holder of the permission can address any id (F-02). Not possible for notifications or claim links.                                                                                                                                      |
| E. Client-controlled permissions  | None. Roles come only from the database. The frontend role state affects the UI only.                                                                                                                                                                                                   |
| F. Privilege escalation           | None for non-Admins: only `users.manage` (Admin) can change roles, and there is no self-service profile endpoint. Admins can escalate others by design.                                                                                                                                 |
| G. Mass assignment                | Not possible: strict Zod schemas reject unknown keys (`validate.ts:25-28`), `UpdateUserRequestSchema` allows only name, roles and active (`users.ts:22-31`), and the user schema is `strict: 'throw'`. A case `ownerId` can be changed by any editor (F-02).                            |
| H. Delete, import, export, bulk   | Delete and restore: Admin only. Imports: per-entity permission. Exports use `proposals.export`, **except census error reports, which use proposals.view** (F-03).                                                                                                                       |
| I. Status transitions             | Enforced by server-side state machines (E.2). Self-approval is possible (F-05).                                                                                                                                                                                                         |
| J. Administrative operations      | Users (users.manage), audit (audit.view), settings (settings.view), email templates (masters.manage), claim templates (claims.admin), TPA settings (claims.admin) are all Admin-only.                                                                                                   |
| K. Information leakage            | Census PII (F-03); medical documents (F-04); unauthenticated OpenAPI document (F-09). Error responses are generic: `error-handler.ts:63-66` logs detail and returns a fixed message.                                                                                                    |
| L. Default behaviour              | A route with no guard is **allowed for any authenticated user** (routers apply `authenticate`, then each route opts into a permission). There is no deny-by-default, so coverage depends on every route declaring its guard. Today all of them do (F-08). An unknown role fails closed. |

---

## F. Frontend protection inventory

The two apps share the same mechanisms; the files are identical unless noted.

| Mechanism                         | Behaviour                                                                                                                                                                                                                                  | Evidence                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Route protection (`src/proxy.ts`) | A visitor without a session cookie is redirected to `/login?next=`. It checks only that the cookie exists. Public pages: `/login`, `/forgot-password`, and in the GHI app `/claim`.                                                        | Property `src/proxy.ts:12`; GHI `src/proxy.ts:11`                       |
| Navigation                        | Items are filtered by `can(roles, item.permission)`. While the user loads, only items every role may see are shown.                                                                                                                        | `src/components/layout/nav-config.ts` (`visibleGroups`)                 |
| Page gate                         | `PageGate` maps the path to a permission with `pagePermission()` (longest prefix). Without that permission it shows "You do not have access" and the page never renders or fetches. **A path not mapped is open to any signed-in user.**   | `src/components/layout/page-gate.tsx:23-28`                             |
| Actions                           | `usePermission(p)` hides or disables buttons. It returns false while the user loads.                                                                                                                                                       | `src/hooks/use-permission.ts:11-14`                                     |
| Current user                      | `GET /auth/me` with a 5-minute `staleTime`. The UI may reflect old roles for up to 5 minutes; the API is current.                                                                                                                          | `src/hooks/use-current-user.ts:13`                                      |
| API errors                        | 401 → redirect to sign-in; 403 → error state with the API message.                                                                                                                                                                         | `src/lib/api-client.ts:100`                                             |
| BFF allowlist                     | Property: no `ghi`, `eb`, `family-plans`, `age-bands`, `claims`, `tpa`, `claims-analysis`, `renewal`. GHI: no `imports`, `catalog`, `templates`, `qcrs`, `placement-slips`. Unknown areas return 404.                                      | `src/lib/server/proxy-paths.ts` (each app)                              |
| CSRF                              | SameSite=Lax cookie, plus an Origin check on non-GET BFF calls                                                                                                                                                                             | `src/lib/server/bff.ts` (`isSameOrigin`), proxy `route.ts:56`           |
| Token exposure                    | The JWT never reaches browser JavaScript (httpOnly cookie; login returns only the user)                                                                                                                                                    | `src/lib/session.ts:11-27`, `api/auth/login/route.ts`                   |
| Mock mode                         | `USE_MOCK_API=true` signs in five demo users with a published password. The proxy then answers 503 for every API path except `auth/me`, so no backend data is reachable. `.env.example` ships `true`; the production example uses `false`. | `src/lib/server/mock-mode.ts`, proxy `route.ts:63`, login `route.ts:71` |

### F.1 Sensitive pages

Every page below fetches nothing before the gate passes, and the API enforces the same permission independently.

| Page                                                 | App      | Hidden in nav?    | Direct URL by an unauthorized user                         | Backend enforces? |
| ---------------------------------------------------- | -------- | ----------------- | ---------------------------------------------------------- | ----------------- |
| `/users`, `/audit`, `/settings`                      | both     | yes               | Access denied (gate)                                       | yes               |
| `/masters/import`                                    | Property | yes               | Access denied                                              | yes (handler)     |
| `/proposals/new`                                     | Property | not in nav        | Access denied (proposals.create)                           | yes               |
| `/proposals/deleted`                                 | Property | not in nav        | **Renders**; the API returns 403, shown as an error (F-10) | yes               |
| `/ghi/new`                                           | GHI      | not in nav        | Access denied                                              | yes               |
| `/claims*`, `/claims-analysis`                       | GHI      | yes (claims.view) | Access denied                                              | yes               |
| `/claims/settings`, `/claims/tpa/formats`            | GHI      | not in nav        | Access denied (claims.admin)                               | yes               |
| `/claims/new`, `/claims/links`, `/claims/tpa/import` | GHI      | not in nav        | Access denied (claims.process)                             | yes               |
| `/masters/family-plans`, `/masters/age-bands`        | GHI      | yes               | open (masters.view, every role)                            | yes               |
| `/claim` (employee)                                  | GHI      | public            | token-gated by the API                                     | yes               |

**Consistency between apps:** the same user sees the same permissions for the shared screens in both apps,
because both apps use one table. A Property-app user who also opens the GHI app gets exactly the access their roles
give; the per-app allowlist is not an authorization boundary.

---

## G. Insurance-specific access

### G.1 Property, Fire and Burglary

- **Who can do what** depends only on role: proposals, Data Sheet, RFQ, quotes, QCR, client approval, placement
  slip, coverage confirmation, renewals and exports (D.2).
- **No client, owner or product scoping.** `ownerId` is set at creation (`proposals.service.ts:482-528`) and used
  only for display and notification recipients (`proposal-notifications.ts:110`).
- **Approvals** need `proposals.approve` and follow the recorded state, but the submitter is not excluded (F-05).
- **Rating masters** (occupancy, pincodes, catalog, tax rates, add-ons, notes, clauses, document templates) are
  readable by all roles and managed by Admins only.
- **Imports:** clients and locations need `clients.manage`; insurers and masters need `masters.manage`.
- **Delete** is a soft delete to the bin, Admin only. Deleted cases return 404 on every case route.

### G.2 GHI, GPA and GTLI

- **Cases, census, RFQ, quotes, QCR, payments, placement and policy** use the same `proposals.*` permissions as
  Property, again with no owner or client scoping. Any editor can reassign the owner: `ghi-cases.service.ts:324-331`
  checks only that the new owner is active staff who may edit (`:77-85`).
- **Census and employees:** read with `proposals.view`. The data includes date of birth, salaries and nominees (F-03).
  Error-report downloads also need only `proposals.view`.
- **Family plans and age bands:** `masters.view` to read, `masters.manage` to change.
- **Claims board and details:** `claims.view` sees **every** claim of every client. Writes are assignment-scoped
  (`mayMove`/`mayEdit`) unless the user holds `claims.admin`; reassigning needs `claims.admin`.
  - Assignment **is enforced by the backend**, not just the UI (`claim-common.ts:50-58`, covered by `test/claims.test.ts:395,521,923`).
  - Not assignment-scoped: link revoke and email retry (F-07), and reads, including documents (F-04).
- **Claim remarks and timeline:** remarks need the assignee or an Admin. The timeline records the actor and time.
- **Claim notifications:** email templates and HR contacts need `claims.admin`. Notification history is part of the
  claim detail (claims.view). Retry needs claims.process (F-07).
- **TPA:** claims.view to read, claims.process to import, claims.admin for formats and settings. Diagnosis and bank
  masking happen server-side and are tested (`test/tpa-claims.test.ts:777,810,824`).
- **Claims analysis:** claims.view; diagnosis columns only for claims.process (tested `:925`).
- **Renewal analysis:** proposals.view, so Read-only users see claim aggregates per policy year (F-11). This is
  documented in the README role table as intended.
- **Employee claim link** (public): a 32-byte random token, stored only as a SHA-256 hash; expiry; revocation; one
  policy and employee; documents only for the link's own claims while the claim is in Form; per-IP rate limit; the
  token travels in a header.

---

## H. User and role administration

| Question                                                 | Answer                                                                                                                                                                                                                      |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Who can create users?                                    | Admins (`users.manage`), plus anyone with database access via `seed:admin`.                                                                                                                                                 |
| Who can assign roles, or change another user's role?     | Admins, via `PATCH /users/:id {roles}`.                                                                                                                                                                                     |
| Can users modify their own roles?                        | Non-Admins: no (403). Admins: they can add roles to themselves. Removing their own Admin role is blocked only for a lower-case id (F-01).                                                                                   |
| Can an Admin accidentally remove their own admin access? | Not through the UI. Through a crafted request with an upper-case id, yes: confirmed (dynamic) by probe P1/P2.                                                                                                               |
| Can the last privileged account be disabled?             | There is no last-Admin check. Admin A can demote or deactivate Admin B, and with F-01 an Admin can demote themselves, so zero active Admins is reachable. Recovery needs server access (`seed:admin` with a **new** email). |
| Are role changes audited?                                | Yes: `USER_UPDATED` with before and after `{email, name, roles, active}` (`users.service.ts:124-134`, `user.mapper.ts:34-36`); `USER_CREATED` likewise. Tested (`test/users.test.ts:148`).                                  |
| Are tokens or caches invalidated on a role change?       | Not needed for the API: roles are re-read per request. The UI cache lags up to 5 minutes.                                                                                                                                   |
| Safe defaults for new users?                             | No implicit role; roles are required and validated. Passwords need at least 12 characters.                                                                                                                                  |
| Roles vs individual overrides?                           | Roles only. There are no per-user permission overrides.                                                                                                                                                                     |
| Deletion                                                 | Not implemented (deactivation only, which preserves the audit history).                                                                                                                                                     |
| Password reset                                           | Not implemented (F-06).                                                                                                                                                                                                     |

---

## I. Findings and risk classification

Severity follows the rubric in the request. **No Critical findings.** No High finding is a confirmed vulnerability
against the documented rules. F-02 and F-03 become High if the business confirms the scoping and PII rules in
Section M.

### F-01 Admin self-protection bypass via upper-case ObjectId (Medium, Confirmed dynamic)

- **Repository:** Fiducial_backend.
- **Affected:** `PATCH /api/v1/users/:id`.
- **Evidence:** `users.service.ts:97-104` compares `id === actor.id` as strings. `ObjectIdSchema` accepts `[a-fA-F]`
  (`src/shared/common.ts:4-6`). Mongoose casts hex case-insensitively, so `findByIdAndUpdate` targets the same user.
- **Observed** (probe P1/P2, in-memory DB):
  - PATCH with the lower-case own id and `{active:false}` → **409**.
  - PATCH with the upper-case own id and `{roles:['READ_ONLY']}` → **200**.
  - The next `GET /users` → **403**.
- **Expected:** self-deactivation and self-removal of Admin refused for any spelling of the id, and the last active
  Admin never demoted or deactivated.
- **Impact:** an Admin (only Admins reach the route) can lock themselves out, or leave the system with no active Admin.
  User management, masters, settings and the audit log then stay unavailable until someone with server access runs
  `seed:admin`. This affects availability only; there is no privilege gain.
- **Remediation:**
  - Compare `ObjectId`s, not strings, or normalise the id to lower case in `ObjectIdSchema` and the users route.
  - Add a transactional "at least one active Admin" check to `updateUser`.
- **Regression test:**
  - PATCH self with an upper-case id returns 409.
  - Demoting or deactivating the last active Admin returns 409.
  - Two Admins demoting each other concurrently leave one Admin.

### F-02 No resource-level scoping: any editor can change any client's case; every viewer can read every case (Medium, design weakness; Confirmed dynamic)

- **Repository:** Fiducial_backend.
- **Affected:** every `/proposals/:id/*`, `/ghi/cases/:id/*`, `/eb/{gpa,gtli}/cases/:id/*`, `/clients/*` and claim
  **read** route.
- **Evidence:** guards check only the permission (Appendix A). `ownerId` is never compared with the caller
  (`proposals.service.ts:482-528`, `ghi-cases.service.ts:153,324-331`), and no list query filters by user or client.
- **Observed:**
  - Probe P3: a Relationship Manager who does not own the case `PUT /proposals/:id/insurers` → **200**.
  - A Read-only user `GET /proposals/:id` → **200**.
- **Expected:** if the business requires portfolios, a user edits (and possibly sees) only cases they own or are
  assigned to, or that belong to their clients. Admins and Approvers see all.
- **Impact:** any RM or Placement user can alter, close, re-insure, record payments on, or reassign any client's case
  (Property and EB), and any user reads every case. All of this is audited, which limits but does not prevent misuse.
- **Status:** the intended rule is undecided (OPEN_ITEMS OI-08 / Q12), hence Medium.
- **Remediation:** see K.3. Add a case access policy (owner, team or client assignment) enforced in a shared
  `loadCaseFor(actor, id)` used by every case route; filter list queries the same way.
- **Regression test:** a non-owner editor receives 403 or 404 on each write family; lists exclude others' cases; an
  Admin passes.

### F-03 Employee PII (date of birth, salary, nominee) readable and downloadable by Read-only users (Medium, Confirmed source)

- **Repository:** Fiducial_backend.
- **Affected:**
  - `GET /ghi/cases/:id/members` (`ghi.routes.ts:202`) and `GET /eb/{gpa,gtli}/cases/:id/members` (`eb-product.routes.ts:221`).
  - Census issues and imports.
  - `.../census/imports/:importId/error-report` (`ghi.routes.ts:289`, `eb-product.routes.ts:341`).
  - `GET /eb/companies/:clientId/employees` (`eb.routes.ts:63`).
- **Evidence:** all of these need only `proposals.view`. `EbMemberSchema` returns `dateOfBirth`, `annualSalary`,
  `monthlySalary` and `nominee` (`src/shared/eb-census.ts:521-548`). The GHI member returns `dateOfBirth`
  (`census.service.ts:85,98`). By contrast, the claims API masks the patient's DOB and phone for anyone without
  `claims.process` (`claim-common.ts:274,301,309`), and exports elsewhere need `proposals.export`.
- **Expected:** a consistent data-minimisation rule: PII fields visible only to roles that work the census, and
  census downloads behind `proposals.export`.
- **Impact:** Read-only and Approver users can read and download employees' dates of birth, salaries and nominee
  details for every company.
- **Remediation:** apply field masking in the member mappers (as claims do), and move the error-report route to
  `proposals.export`.
- **Regression test:** a Read-only user receives masked DOB, salary and nominee, and 403 on the error report.

### F-04 Medical claim documents downloadable by Approvers although diagnosis details are withheld from them (Medium, Confirmed source)

- **Repository:** Fiducial_backend.
- **Affected:** `GET /api/v1/claims/:id/documents/:fileId` (`claims.routes.ts:322`; `claims.service.ts:696-712`).
- **Evidence:** the route needs `claims.view` (held by `MANAGER`) and performs no further check, though downloads are
  audited. Diagnosis, ICD code and rejection reason go only to `claims.process` (`tpa.routes.ts:73-79`; tested
  `tpa-claims.test.ts:777`). Claim reads are global (no assignment or client scope).
- **Expected:** document access follows the same rule as diagnosis details (claims.process, and possibly the
  assignee).
- **Impact:** Approvers can download discharge summaries and bills, which reveal what the diagnosis masking hides.
  Every claims viewer can read every claim of every client.
- **Remediation:** require `claims.process` (or the assignee or `claims.admin`) for document download. Decide whether
  claim reads should be client- or assignment-scoped (M).
- **Regression test:** an Approver gets 403 (audited) on a document download; a processor gets 200.

### F-05 No separation of duties on approvals (Medium, design decision; Confirmed dynamic for the RFQ)

- **Repository:** Fiducial_backend.
- **Affected:**
  - `POST /proposals/:id/rfq/versions/:v/approve|return` (`rfq.routes.ts:104,114`).
  - `/proposals/:id/qcr/approve` (`qcr.routes.ts:58`).
  - `/proposals/:id/placement-slip/approve` (`placement-slip.routes.ts:78`).
  - `/ghi|eb/.../rfq/decision` and `.../qcrs/:id/decision`.
- **Evidence:** `moveRfq` checks only the state (`rfq.service.ts:285-311`). No submitter or preparer comparison
  exists in any approval service.
- **Observed:** probe P4, one Admin generated (201), submitted (200) and approved (200) the same RFQ version.
- **Context:** documented as the current assumption in `docs/OPEN_ITEMS.md` GHI-03 ("An approver may approve work
  they submitted"). The QCR and placement slip paths share the shape but were not exercised.
- **Impact:** Admins, and any user holding edit and approve through multiple roles, can approve their own RFQ, QCR or
  placement slip, defeating the four-eyes intent of the approval step.
- **Remediation:** when the business confirms it, refuse approval by the submitter or preparer, and decide whether
  Admins are exempt.
- **Regression test:** the same user submits and then approves, getting 409 or 403; a different approver gets 200.

### F-06 No password change, reset or rotation; logout does not revoke the token (Medium, Confirmed source)

- **Repository:** Fiducial_backend (and both frontends' `/forgot-password`).
- **Evidence:** there is no password field on any update schema (`src/shared/users.ts:22-31`) and no reset route
  (Appendix A). Logout only audits (`auth.service.ts:142-151`). The token lives until `exp` (8 h in the examples).
  The account lock does not end live sessions (`auth.ts:30-36`).
- **Impact:**
  - A user cannot change a known or compromised password.
  - An Admin cannot reset one.
  - The only response is deactivation, and recovery needs database access.
  - A token copied before logout stays valid for its lifetime. The httpOnly cookie makes theft from the browser hard,
    which limits this part.
- **Remediation:**
  - Admin-initiated password reset and self-service password change, both audited.
  - A `passwordChangedAt` / `tokenVersion` on the user, checked in `authenticate()` (the re-read already happens),
    so that changing a password, deactivating, or "sign out everywhere" revokes existing tokens.
- **Regression test:** after a password change or reset, the old token returns 401.

### F-07 Claim link revoke and claim email retry are not assignment-scoped (Low, Confirmed source)

- **Repository:** Fiducial_backend.
- **Affected:** `POST /claims/links/:linkId/revoke` (`claim-links.service.ts:155-175`) and
  `POST /claims/:id/notifications/:notificationId/retry` (`claim-notifications.ts:304-324`).
- **Evidence:** both need only `claims.process`. Unlike other claim writes, no `mayEdit`/`mayMove` check is made.
- **Impact:** any processor can revoke another staff member's employee links (blocking submissions) or re-send
  failed claim emails on claims assigned to others. Both actions are audited.
- **Remediation:** require the link's issuer or the claim's assignee, or `claims.admin`.
- **Regression test:** a non-assignee processor gets 403 on both.

### F-08 Authorization is opt-in per route, not deny-by-default (Low, design weakness)

- **Evidence:** routers apply only `authenticate`, and each route adds `requirePermission` (for example
  `ghi.routes.ts:99-101`). A future route without a guard would be open to every signed-in user.
- **Current state:** 0 such routes (E.1). `test/permissions.test.ts` covers 45 of the 306 endpoints.
- **Remediation:** a route-registration helper that requires a permission (or an explicit `public`/`self` marker),
  plus a test that walks the Express router stack and fails on any unguarded route.
- **Regression test:** the guard-coverage test itself.

### F-09 OpenAPI document and Swagger UI served without authentication (Low, Confirmed source)

- **Affected:** `GET /api/openapi.json`, `/api/docs` (`app.ts:217-225`).
- **Impact:** discloses the full API surface and permission descriptions to anyone who can reach the API. In the
  documented deployment the API listens on 127.0.0.1:5001 behind the BFF, which reduces exposure. Whether Nginx
  exposes it is not visible in the repository.
- **Remediation:** disable in production, or put behind authentication or the network boundary.

### F-10 Frontend page gate is default-allow for unmapped paths; the deleted bin is gated too loosely (Low, Confirmed source)

- **Repositories:** both frontends.
- **Evidence:** `pagePermission()` returns null for unmapped paths and `PageGate` then renders
  (`page-gate.tsx:25`). `/proposals/deleted` maps to `proposals.view`, while the API requires `proposals.delete`
  (`proposals.routes.ts:100`).
- **Impact:** UI only. The API still refuses, but users see an error instead of "no access", and a future unmapped
  page would render for everyone.
- **Remediation:** an explicit page-permission table with default deny; map `/proposals/deleted` to
  `proposals.delete`.

### F-11 Read-only users see claim aggregates in the renewal analysis (Informational)

`POST /renewal/analysis` and `/renewal/years` need `proposals.view` and return paid, outstanding and count per policy
year (`src/shared/renewal-analysis.ts:30-38`). This is documented as intended (README role table, "Renewal analysis
(view): Read-only yes") and contains no medical detail. Listed for the business to confirm alongside F-04.

### F-12 Role codes and labels disagree (Informational)

`MANAGER` is labelled "Approver" and `ACCOUNT_MANAGER` "Relationship Manager" (`roles.ts:18-24`). The demo account
`demo.manager@` is an RM. This risks wrong assignments by Admins and wrong rules in future code. Rename the codes
during the refactor with a data migration, or document the mapping prominently.

### F-13 Denials are audited for claims only (Informational)

`requireClaimPermission` writes `CLAIM_ACCESS_DENIED` (`require-permission.ts:23-47`); `requirePermission` writes
nothing. Consider auditing, or at least rate-logging, 403s on admin, user and PII routes.

### F-14 Per-account lockout can be used to lock out a known user (Low)

Five wrong passwords lock any account for 15 minutes (`auth.service.ts:114-121`). The per-IP limiter is in memory
(`auth.routes.ts:28-41`), so it resets on restart and is per instance. Consider a progressive delay, or a lockout per
account and IP pair, and a shared limiter store.

### F-15 Mock mode ships enabled in `.env.example` (Informational)

Both frontends' `.env.example` set `USE_MOCK_API=true`. If copied to a server, anyone can sign in to the UI as the
demo Admin. No backend data is reachable (the proxy returns 503 for everything but `auth/me`), so the impact is
limited to a misleading UI. Default it to false, and refuse `true` when `NODE_ENV=production`.

### F-16 Placement approval differs between products (Informational)

Property has an explicit placement-slip approval (`proposals.approve`). GHI and EB placement needs `proposals.edit`
but requires an approved QCR **and** the client's recorded acceptance (`eb-placement.service.ts:72-73`). This is not a
bypass; document it as a product rule.

---

## J. Test coverage

### J.1 Tests executed during this audit (all local, nothing deployed)

| Suite                                                                                                                                          | Command                                                                                     | Result                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Fiducial_backend, full                                                                                                                         | `npx vitest run` (in-memory MongoDB replica set)                                            | **79 files, 1,038 passed, 1 skipped, 0 failed** (154 s)   |
| Fiducial_frontend, auth-related                                                                                                                | `vitest run page-gate nav-config proxy api-client permissions sidebar mock-mode route.test` | **12 files, 146 passed**                                  |
| fiducial-ghi-frontend, auth-related (plus `claim-link-paths`)                                                                                  | same filters                                                                                | **13 files, 162 passed**                                  |
| Scratch probes (outside the repos, `rbac-probe.test.ts` in the session scratchpad) using the backend's own test helpers and in-memory database | P1–P4                                                                                       | 3 tests ran; observations recorded in F-01, F-02 and F-05 |

**Probe observations (dynamic):**

| Probe                                          | Status          |
| ---------------------------------------------- | --------------- |
| Self-deactivate, lower-case id                 | 409             |
| Self-demote, upper-case id                     | 200             |
| `GET /users` right after                       | 403             |
| `GET /auth/me` right after                     | 200             |
| Non-owner RM edits insurers                    | 200             |
| Read-only reads case                           | 200             |
| One Admin: generate / submit / approve own RFQ | 201 / 200 / 200 |

**The route inventory** (Appendix A) was generated by a static script that parses every `router.<method>()` call and
`router.use()` guard and resolves aliases such as `const view = requirePermission(...)`. It reads source only.

### J.2 What the existing tests cover

| Area                                                                               | Covered?                | Evidence                                                                                                                                                     |
| ---------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unauthenticated access                                                             | Yes                     | `permissions.test.ts` (401 per endpoint), `users.test.ts:40`, `auth.test.ts:148`                                                                             |
| Authenticated but unauthorized                                                     | Partly                  | Matrix over **45 of 306** endpoints × 5 roles (`permissions.test.ts:27-140`); feature tests add 403 checks in 31 files (claims, TPA, EB, deleted bin, users) |
| Token tampering / other secret                                                     | Yes                     | `auth.test.ts:165`                                                                                                                                           |
| Expired token                                                                      | **No** dedicated test   | —                                                                                                                                                            |
| Disabled account (live session ends)                                               | Yes                     | `auth.test.ts:177`, `users.test.ts:165`                                                                                                                      |
| Role change during a session                                                       | Partly                  | `users.test.ts:148` (audit), `:165` (deactivation); no explicit "demoted user gets 403 next request" (probe P2 shows it works)                               |
| Self-protection                                                                    | Yes for lower-case ids  | `users.test.ts:182`; **upper-case bypass not covered** (F-01)                                                                                                |
| Last-Admin protection                                                              | **No**                  | —                                                                                                                                                            |
| Claim assignment enforcement                                                       | Yes                     | `claims.test.ts:395,521,923`                                                                                                                                 |
| Claim masking (DOB, phone, diagnosis, bank) and audit of views and denials         | Yes                     | `tpa-claims.test.ts:536,777,810,824,925`                                                                                                                     |
| Read-only sees no claims                                                           | Yes                     | `claims.test.ts:228`                                                                                                                                         |
| Cross-client / non-owner case access                                               | **No** (no rule exists) | —                                                                                                                                                            |
| Self-approval                                                                      | **No**                  | —                                                                                                                                                            |
| Census PII by role                                                                 | **No**                  | —                                                                                                                                                            |
| Import permissions                                                                 | Yes                     | `imports.test.ts`                                                                                                                                            |
| Mass assignment / strict input                                                     | Yes                     | `auth.test.ts:111`, `users.test.ts:124,196`                                                                                                                  |
| Frontend page gate, navigation by role, route protection, BFF allowlist, mock mode | Yes                     | both apps: `page-gate.test`, `nav-config.test`, `sidebar.test`, `proxy.test`, `proxy-paths.test`, `mock-mode.test`, `route.test`                             |
| Both frontends against one backend (end to end)                                    | **No**                  | Playwright smoke tests run in mock mode only                                                                                                                 |
| Guard coverage of every route                                                      | **No**                  | (F-08)                                                                                                                                                       |

---

## K. Recommended RBAC design (not implemented)

It fits the current code: keep `permissions.ts` as the single table, and add policy layers rather than replacing it.

1. **Deny by default.**
   - Replace `router.<method>(path, guard, handler)` with a small `secureRoute(router, {method, path, permission | 'public' | 'self'})`
     that refuses registration without a declared access mode.
   - Add a test that walks every router stack and fails on any route without a guard (F-08).
2. **Explicit, normalised roles.**
   - Keep the codes stable but add a label map test; or migrate `MANAGER` → `APPROVER` and `ACCOUNT_MANAGER` →
     `RELATIONSHIP_MANAGER` with a one-off data migration and a compatibility alias for one release (F-12).
   - Optionally split `ADMIN` into "system admin" (users, settings, audit) and "business admin" (masters, claims
     admin) if separation is wanted.
3. **Resource policies** (`src/modules/access/`), one function per resource family, called by the existing
   `loadDoc`/`loadCase`/`loadClaim`:
   - `canReadCase(actor, case)` and `canEditCase(actor, case)`: the owner, members of the case team, or holders of an
     "all cases" permission (for example a new `proposals.all`) for Admins and Approvers.
   - `canReadClaim` and `canDownloadClaimDocument`: assignee, `claims.admin`, or a client-scoped claims viewer.
   - List queries get the same filter (`ownerId ∈ …` or `clientId ∈ …`), so lists and details agree.
4. **Field-level data minimisation.** A shared `redact(record, actor)` per DTO family (census members, employees,
   claims, TPA), driven by permissions such as `pii.view` and `claims.medical`. It replaces today's scattered
   `personal`/`diagnosisVisible` booleans, and is applied to both JSON and generated files.
5. **Separation of duties.** `assertNotSelfApproval(actor, submittedBy | preparedBy)` in RFQ, QCR, placement slip and
   the EB decisions, with an explicit, audited Admin override if the business wants one.
6. **Controlled administration.**
   - Compare `ObjectId`s.
   - Enforce an invariant of at least one active Admin.
   - Add password reset and change with `tokenVersion` revocation.
   - Optionally require a second Admin to grant `ADMIN`.
   - Audit 403s on admin and PII routes.
7. **Prompt permission changes.**
   - The API already re-reads roles.
   - Add `tokenVersion` for revocation.
   - In the frontends, lower `/auth/me` `staleTime`, or invalidate it on any 403.
8. **Consistent frontend helpers.**
   - Default-deny `pagePermission`.
   - Have the API return the caller's effective permissions (and, per record, the allowed actions, as `allowedMoves`
     does for claims), so buttons reflect resource rules, not just roles.
9. **Backward compatibility.** Ship the new policies behind the existing permissions first: "all cases" is granted to
   every current role, so behaviour is unchanged. Then narrow the grants once the business confirms the rules (M). Both
   frontends keep working because the contracts change only additively.

---

## L. Phased remediation plan

| Phase                                | Work                                                                                                                                                                                                                                           | Repositories                                           | Dependencies and risks                                                                                                 | Acceptance criteria                                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 1. Critical security fixes           | No Critical findings. Do the cheap, safe fixes now: F-01 (ObjectId comparison and last-Admin invariant), F-04 (document download behind claims.process), F-03 (error-report download behind `proposals.export`), F-15 (mock-mode default).     | backend; both frontends (F-15)                         | Low risk; F-04 changes Approver access (confirm with the business)                                                     | New regression tests in F-01, F-03, F-04 pass; the full suites stay green                           |
| 2. Backend enforcement               | `secureRoute` with deny-by-default; guard-coverage test; audit 403s on admin and PII routes (F-08, F-13); disable public OpenAPI in production (F-09)                                                                                          | backend                                                | Touches every router file mechanically; do it in one PR with the coverage test                                         | The coverage test fails on an unguarded route; 0 unguarded routes; all tests pass                   |
| 3. Role and permission normalisation | Decide label vs code (F-12); add any new permissions needed by phases 4 and 5 (`proposals.all`, `pii.view`, `claims.medical`), initially granted so behaviour is unchanged                                                                     | backend `src/shared` → `shared:sync` to both frontends | `src/shared` must stay identical in three repos; data migration if codes change                                        | `shared:check` is green in both frontends; the permission matrix test is updated                    |
| 4. Resource-level access control     | Case access policy and list filters (F-02); claim read and link scoping (F-04, F-07); PII redaction (F-03); separation of duties (F-05)                                                                                                        | backend                                                | **Needs the business decisions in M.** Risk of hiding data users need, so roll out behind permissions that start broad | Non-owner, cross-client and self-approval tests deny; existing workflows pass for owners and Admins |
| 5. Frontend consistency              | Default-deny page gate; `/proposals/deleted` → proposals.delete (F-10); use per-record allowed actions from the API; refresh `/auth/me` on 403                                                                                                 | both frontends                                         | Keep the two apps identical where shared                                                                               | Page-gate tests for every route in both apps                                                        |
| 6. User and role administration      | Password reset and change, `tokenVersion` revocation, "sign out everywhere" (F-06); optional second-Admin approval to grant ADMIN; lockout tuning (F-14)                                                                                       | backend + both frontends (`/forgot-password`, profile) | Mail delivery for reset links; secure token design                                                                     | Old tokens get 401 after a password change, reset or deactivation; reset flows audited              |
| 7. Automated authorization tests     | Extend `permissions.test.ts` from 45 endpoints to all endpoints (generated from the route registry); add negative tests for resource policies, PII and self-approval; a two-frontend end-to-end smoke test against a seeded backend            | all three                                              | CI time; a seeded backend for end to end                                                                               | Every endpoint × role is covered; end-to-end sign-in and role-denial in both apps                   |
| 8. Regression validation             | Full suites, plus a manual walk-through per role in both apps on staging data                                                                                                                                                                  | all three                                              | Staging environment and seeded users per role                                                                          | No unexpected 403s for documented workflows; the matrix (D.2) is re-generated and reviewed          |
| 9. Deployment and rollback           | Ship phases separately; permission grants are the feature flags (phase 3 grants all, phase 4 narrows). Data migrations (role codes, `tokenVersion`) are additive with a down path. Re-sync `src/shared` in both frontends in the same release. | all three                                              | Mixed versions if the frontends lag the backend: keep contracts additive                                               | Rollback = revert grants or deploy the previous tag, without data loss                              |

---

## M. Unresolved questions (for the business; not answerable from code)

1. **Portfolio scoping (F-02).** Should Relationship Managers and Placement staff see or edit only cases they own,
   their team's, or their clients'? Should Read-only users be scoped? (OPEN_ITEMS OI-08/Q12 decides roles but not scope.)
2. **Separation of duties (F-05, GHI-03).** May anyone, including an Admin, approve an RFQ, QCR or placement slip
   they prepared or submitted?
3. **Census PII (F-03).** Which roles may see employee date of birth, salary and nominee details? Must Read-only and
   Approvers see them?
4. **Medical documents (F-04).** Should Approvers (who see claims but not diagnoses) download claim documents?
   Should claim reads be limited to the assignee or the client team?
5. **Admin model.** Is a single all-powerful `ADMIN` acceptable, or should system administration (users, settings,
   audit) be separated from business administration (masters, claims admin)?
6. **Credential policy (F-06).** Who may reset passwords, and how (email link or Admin-set temporary password)?
   What session lifetime is acceptable? Is "sign out everywhere" required?
7. **Deployment exposure (F-09).** Is the API reachable from outside the VPS, or only via the BFFs on 127.0.0.1?
   Nginx configuration is not in the repositories.
8. **Production data.** The actual users and role assignments in production were not inspected (read-only audit, no
   database access). Whether any multi-role users (for example RM + Approver) exist affects F-05.

---

## Appendix A. Backend endpoint inventory (306 unique endpoints)

Generated from source (Section J). "Permission" is the route or router guard; "(audited)" marks
`requireClaimPermission`, which audits denials. Service-level conditions (assignment, masking, state) are in E.2 and
are not repeated per row. GPA and GTLI share one router (`eb-product.routes.ts`) and are listed once as `{gpa,gtli}`.

| Method | Path                                                                    | Auth | Permission (route guard)     | Notes                                                                            | Source                                                   |
| ------ | ----------------------------------------------------------------------- | ---- | ---------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------- |
| GET    | `/api/v1/age-bands`                                                     | yes  | masters.view                 |                                                                                  | age-bands/age-bands.routes.ts:50                         |
| POST   | `/api/v1/age-bands`                                                     | yes  | masters.manage               |                                                                                  | age-bands/age-bands.routes.ts:57                         |
| GET    | `/api/v1/age-bands/:setId`                                              | yes  | masters.view                 |                                                                                  | age-bands/age-bands.routes.ts:64                         |
| PUT    | `/api/v1/age-bands/:setId`                                              | yes  | masters.manage               |                                                                                  | age-bands/age-bands.routes.ts:71                         |
| POST   | `/api/v1/age-bands/:setId/activate`                                     | yes  | masters.manage               |                                                                                  | age-bands/age-bands.routes.ts:81                         |
| POST   | `/api/v1/age-bands/:setId/deactivate`                                   | yes  | masters.manage               |                                                                                  | age-bands/age-bands.routes.ts:88                         |
| GET    | `/api/v1/age-bands/:setId/cases`                                        | yes  | masters.view                 |                                                                                  | age-bands/age-bands.routes.ts:95                         |
| GET    | `/api/v1/audit`                                                         | yes  | audit.view                   |                                                                                  | audit/audit.routes.ts:14                                 |
| POST   | `/api/v1/auth/login`                                                    | no   | —                            | Public: per-IP limiter + per-account lockout                                     | auth/auth.routes.ts:43                                   |
| GET    | `/api/v1/auth/me`                                                       | yes  | —                            | Any active user                                                                  | auth/auth.routes.ts:58                                   |
| POST   | `/api/v1/auth/logout`                                                   | yes  | —                            | Any active user                                                                  | auth/auth.routes.ts:66                                   |
| GET    | `/api/v1/catalog/workbook`                                              | yes  | masters.view                 |                                                                                  | catalog/catalog.routes.ts:51                             |
| POST   | `/api/v1/catalog/import`                                                | yes  | masters.view, masters.manage |                                                                                  | catalog/catalog.routes.ts:61                             |
| GET    | `/api/v1/catalog/products/suggest`                                      | yes  | masters.view                 |                                                                                  | catalog/catalog.routes.ts:83                             |
| GET    | `/api/v1/catalog/:master`                                               | yes  | masters.view                 |                                                                                  | catalog/catalog.routes.ts:98                             |
| POST   | `/api/v1/catalog/:master`                                               | yes  | masters.view, masters.manage |                                                                                  | catalog/catalog.routes.ts:108                            |
| PUT    | `/api/v1/catalog/:master/order`                                         | yes  | masters.view, masters.manage |                                                                                  | catalog/catalog.routes.ts:119                            |
| PUT    | `/api/v1/catalog/:master/:id`                                           | yes  | masters.view, masters.manage |                                                                                  | catalog/catalog.routes.ts:130                            |
| GET    | `/api/v1/claim-links/current`                                           | no   | —                            | Public: link token (SHA-256 lookup), per-IP rate limit                           | claims/claim-links.routes.ts:61                          |
| POST   | `/api/v1/claim-links/current/claims`                                    | no   | —                            | Public: link token (SHA-256 lookup), per-IP rate limit                           | claims/claim-links.routes.ts:68                          |
| POST   | `/api/v1/claim-links/current/claims/:claimNumber/documents`             | no   | —                            | Public: link token (SHA-256 lookup), per-IP rate limit                           | claims/claim-links.routes.ts:74                          |
| GET    | `/api/v1/claims`                                                        | yes  | claims.view (audited)        |                                                                                  | claims/claims.routes.ts:134                              |
| GET    | `/api/v1/claims/board`                                                  | yes  | claims.view (audited)        |                                                                                  | claims/claims.routes.ts:147                              |
| POST   | `/api/v1/claims`                                                        | yes  | claims.process (audited)     |                                                                                  | claims/claims.routes.ts:159                              |
| GET    | `/api/v1/claims/policies`                                               | yes  | claims.process (audited)     |                                                                                  | claims/claims.routes.ts:168                              |
| GET    | `/api/v1/claims/policies/:caseId/employees`                             | yes  | claims.process (audited)     |                                                                                  | claims/claims.routes.ts:175                              |
| GET    | `/api/v1/claims/policies/:caseId/employees/:memberId/family`            | yes  | claims.process (audited)     |                                                                                  | claims/claims.routes.ts:185                              |
| GET    | `/api/v1/claims/links`                                                  | yes  | claims.process (audited)     |                                                                                  | claims/claims.routes.ts:192                              |
| POST   | `/api/v1/claims/links`                                                  | yes  | claims.process (audited)     |                                                                                  | claims/claims.routes.ts:199                              |
| POST   | `/api/v1/claims/links/:linkId/revoke`                                   | yes  | claims.process (audited)     |                                                                                  | claims/claims.routes.ts:206                              |
| GET    | `/api/v1/claims/email-templates`                                        | yes  | claims.admin (audited)       |                                                                                  | claims/claims.routes.ts:213                              |
| PUT    | `/api/v1/claims/email-templates/:status/:audience`                      | yes  | claims.admin (audited)       |                                                                                  | claims/claims.routes.ts:220                              |
| GET    | `/api/v1/claims/hr-contacts/:clientId`                                  | yes  | claims.view (audited)        |                                                                                  | claims/claims.routes.ts:230                              |
| PUT    | `/api/v1/claims/hr-contacts/:clientId`                                  | yes  | claims.admin (audited)       |                                                                                  | claims/claims.routes.ts:237                              |
| GET    | `/api/v1/claims/:id`                                                    | yes  | claims.view (audited)        |                                                                                  | claims/claims.routes.ts:248                              |
| PUT    | `/api/v1/claims/:id`                                                    | yes  | claims.process (audited)     |                                                                                  | claims/claims.routes.ts:260                              |
| POST   | `/api/v1/claims/:id/transitions`                                        | yes  | claims.process (audited)     |                                                                                  | claims/claims.routes.ts:270                              |
| POST   | `/api/v1/claims/:id/remarks`                                            | yes  | claims.process (audited)     |                                                                                  | claims/claims.routes.ts:280                              |
| PUT    | `/api/v1/claims/:id/assignee`                                           | yes  | claims.admin (audited)       |                                                                                  | claims/claims.routes.ts:290                              |
| POST   | `/api/v1/claims/:id/documents`                                          | yes  | claims.process (audited)     |                                                                                  | claims/claims.routes.ts:300                              |
| GET    | `/api/v1/claims/:id/documents/:fileId`                                  | yes  | claims.view (audited)        |                                                                                  | claims/claims.routes.ts:322                              |
| POST   | `/api/v1/claims/:id/notifications/:notificationId/retry`                | yes  | claims.process (audited)     |                                                                                  | claims/claims.routes.ts:336                              |
| GET    | `/api/v1/claims-analysis`                                               | yes  | claims.view (audited)        |                                                                                  | claims-analysis/analysis.routes.ts:88                    |
| GET    | `/api/v1/claims-analysis/document`                                      | yes  | claims.view (audited)        |                                                                                  | claims-analysis/analysis.routes.ts:114                   |
| GET    | `/api/v1/claims-analysis/premium/:caseId`                               | yes  | claims.view (audited)        |                                                                                  | claims-analysis/analysis.routes.ts:144                   |
| POST   | `/api/v1/claims-analysis/premium/:caseId`                               | yes  | proposals.edit               |                                                                                  | claims-analysis/analysis.routes.ts:152                   |
| POST   | `/api/v1/claims-analysis/premium/:caseId/:adjustmentId/void`            | yes  | proposals.edit               |                                                                                  | claims-analysis/analysis.routes.ts:163                   |
| GET    | `/api/v1/renewal/options`                                               | yes  | proposals.view               |                                                                                  | claims-analysis/analysis.routes.ts:173                   |
| POST   | `/api/v1/renewal/analysis`                                              | yes  | proposals.view               |                                                                                  | claims-analysis/analysis.routes.ts:181                   |
| POST   | `/api/v1/renewal/analysis/document`                                     | yes  | proposals.export             |                                                                                  | claims-analysis/analysis.routes.ts:189                   |
| GET    | `/api/v1/renewal/years`                                                 | yes  | proposals.view               |                                                                                  | claims-analysis/analysis.routes.ts:211                   |
| POST   | `/api/v1/renewal/years`                                                 | yes  | proposals.edit               |                                                                                  | claims-analysis/analysis.routes.ts:219                   |
| PUT    | `/api/v1/renewal/years/:yearId`                                         | yes  | proposals.edit               |                                                                                  | claims-analysis/analysis.routes.ts:227                   |
| GET    | `/api/v1/renewal/reports`                                               | yes  | proposals.view               |                                                                                  | claims-analysis/analysis.routes.ts:238                   |
| POST   | `/api/v1/renewal/reports`                                               | yes  | proposals.edit               |                                                                                  | claims-analysis/analysis.routes.ts:249                   |
| GET    | `/api/v1/renewal/reports/:reportId`                                     | yes  | proposals.view               |                                                                                  | claims-analysis/analysis.routes.ts:257                   |
| GET    | `/api/v1/renewal/reports/:reportId/document`                            | yes  | proposals.export             |                                                                                  | claims-analysis/analysis.routes.ts:265                   |
| GET    | `/api/v1/proposals/:id/client-approval`                                 | yes  | proposals.view               |                                                                                  | client-approval/client-approval.routes.ts:47             |
| PUT    | `/api/v1/proposals/:id/client-approval`                                 | yes  | proposals.edit               |                                                                                  | client-approval/client-approval.routes.ts:55             |
| POST   | `/api/v1/proposals/:id/client-approval/files`                           | yes  | proposals.edit               |                                                                                  | client-approval/client-approval.routes.ts:66             |
| GET    | `/api/v1/proposals/:id/client-approval/files/:fileId`                   | yes  | proposals.view               |                                                                                  | client-approval/client-approval.routes.ts:87             |
| GET    | `/api/v1/clients`                                                       | yes  | clients.view                 |                                                                                  | clients/clients.routes.ts:44                             |
| POST   | `/api/v1/clients`                                                       | yes  | clients.manage               |                                                                                  | clients/clients.routes.ts:52                             |
| GET    | `/api/v1/clients/:id`                                                   | yes  | clients.view                 |                                                                                  | clients/clients.routes.ts:60                             |
| PATCH  | `/api/v1/clients/:id`                                                   | yes  | clients.manage               |                                                                                  | clients/clients.routes.ts:68                             |
| GET    | `/api/v1/clients/:id/locations`                                         | yes  | clients.view                 |                                                                                  | clients/clients.routes.ts:79                             |
| POST   | `/api/v1/clients/:id/locations`                                         | yes  | clients.manage               |                                                                                  | clients/clients.routes.ts:90                             |
| PATCH  | `/api/v1/clients/:id/locations/:locationId`                             | yes  | clients.manage               |                                                                                  | clients/clients.routes.ts:101                            |
| GET    | `/api/v1/clients/:id/addon-favourites`                                  | yes  | proposals.view               |                                                                                  | clients/clients.routes.ts:113                            |
| PUT    | `/api/v1/clients/:id/addon-favourites`                                  | yes  | proposals.edit               |                                                                                  | clients/clients.routes.ts:121                            |
| GET    | `/api/v1/proposals/:id/coverage-confirmation`                           | yes  | proposals.view               |                                                                                  | coverage-confirmation/coverage-confirmation.routes.ts:42 |
| PUT    | `/api/v1/proposals/:id/coverage-confirmation`                           | yes  | proposals.edit               |                                                                                  | coverage-confirmation/coverage-confirmation.routes.ts:50 |
| GET    | `/api/v1/proposals/:id/coverage-confirmation/document`                  | yes  | proposals.export             |                                                                                  | coverage-confirmation/coverage-confirmation.routes.ts:61 |
| POST   | `/api/v1/proposals/:id/coverage-confirmation/email`                     | yes  | proposals.send               |                                                                                  | coverage-confirmation/coverage-confirmation.routes.ts:72 |
| GET    | `/api/v1/templates`                                                     | yes  | masters.view                 |                                                                                  | documents/templates.routes.ts:32                         |
| GET    | `/api/v1/templates/:kind/file`                                          | yes  | masters.view                 |                                                                                  | documents/templates.routes.ts:36                         |
| POST   | `/api/v1/templates/:kind`                                               | yes  | masters.view, masters.manage |                                                                                  | documents/templates.routes.ts:50                         |
| GET    | `/api/v1/email-templates`                                               | yes  | masters.view                 |                                                                                  | email-templates/email-templates.routes.ts:23             |
| PUT    | `/api/v1/email-templates/:kind`                                         | yes  | masters.view, masters.manage |                                                                                  | email-templates/email-templates.routes.ts:27             |
| GET    | `/api/v1/family-plans`                                                  | yes  | masters.view                 |                                                                                  | family-plans/family-plans.routes.ts:42                   |
| POST   | `/api/v1/family-plans`                                                  | yes  | masters.manage               |                                                                                  | family-plans/family-plans.routes.ts:49                   |
| GET    | `/api/v1/family-plans/:planId`                                          | yes  | masters.view                 |                                                                                  | family-plans/family-plans.routes.ts:56                   |
| PUT    | `/api/v1/family-plans/:planId`                                          | yes  | masters.manage               |                                                                                  | family-plans/family-plans.routes.ts:63                   |
| POST   | `/api/v1/family-plans/:planId/activate`                                 | yes  | masters.manage               |                                                                                  | family-plans/family-plans.routes.ts:73                   |
| POST   | `/api/v1/family-plans/:planId/deactivate`                               | yes  | masters.manage               |                                                                                  | family-plans/family-plans.routes.ts:80                   |
| GET    | `/api/v1/family-plans/:planId/open-cases`                               | yes  | masters.manage               |                                                                                  | family-plans/family-plans.routes.ts:87                   |
| POST   | `/api/v1/family-plans/:planId/versions`                                 | yes  | masters.manage               |                                                                                  | family-plans/family-plans.routes.ts:94                   |
| PUT    | `/api/v1/family-plans/:planId/versions/:number`                         | yes  | masters.manage               |                                                                                  | family-plans/family-plans.routes.ts:104                  |
| POST   | `/api/v1/family-plans/:planId/versions/:number/activate`                | yes  | masters.manage               |                                                                                  | family-plans/family-plans.routes.ts:114                  |
| PUT    | `/api/v1/family-plans/:planId/versions/:number/effective-to`            | yes  | masters.manage               |                                                                                  | family-plans/family-plans.routes.ts:121                  |
| POST   | `/api/v1/family-plans/:planId/versions/:number/confirm`                 | yes  | masters.manage               |                                                                                  | family-plans/family-plans.routes.ts:133                  |
| PUT    | `/api/v1/ghi/cases/:id/age-bands`                                       | yes  | proposals.edit               |                                                                                  | ghi/case-configuration.routes.ts:41                      |
| PUT    | `/api/v1/eb/{gpa,gtli}/cases/:id/age-bands`                             | yes  | proposals.edit               |                                                                                  | ghi/case-configuration.routes.ts:41                      |
| GET    | `/api/v1/ghi/cases/:id/rfq/selection-summary`                           | yes  | proposals.view               |                                                                                  | ghi/case-configuration.routes.ts:49                      |
| GET    | `/api/v1/eb/{gpa,gtli}/cases/:id/rfq/selection-summary`                 | yes  | proposals.view               |                                                                                  | ghi/case-configuration.routes.ts:49                      |
| GET    | `/api/v1/ghi/cases/:id/rfq/selection-summary/document`                  | yes  | proposals.export             |                                                                                  | ghi/case-configuration.routes.ts:56                      |
| GET    | `/api/v1/eb/{gpa,gtli}/cases/:id/rfq/selection-summary/document`        | yes  | proposals.export             |                                                                                  | ghi/case-configuration.routes.ts:56                      |
| GET    | `/api/v1/ghi/cases/:id/rfq/versions/:rfqId/selection-summary`           | yes  | proposals.view               |                                                                                  | ghi/case-configuration.routes.ts:75                      |
| GET    | `/api/v1/eb/{gpa,gtli}/cases/:id/rfq/versions/:rfqId/selection-summary` | yes  | proposals.view               |                                                                                  | ghi/case-configuration.routes.ts:75                      |
| GET    | `/api/v1/eb/{gpa,gtli}/cases/:id`                                       | yes  | proposals.view               |                                                                                  | ghi/eb-product.routes.ts:162                             |
| PUT    | `/api/v1/eb/{gpa,gtli}/cases/:id`                                       | yes  | proposals.edit               |                                                                                  | ghi/eb-product.routes.ts:169                             |
| POST   | `/api/v1/eb/{gpa,gtli}/cases/:id/close`                                 | yes  | proposals.edit               |                                                                                  | ghi/eb-product.routes.ts:177                             |
| PUT    | `/api/v1/eb/{gpa,gtli}/cases/:id/requirements`                          | yes  | proposals.edit               |                                                                                  | ghi/eb-product.routes.ts:185                             |
| PUT    | `/api/v1/eb/{gpa,gtli}/cases/:id/plan`                                  | yes  | proposals.edit               |                                                                                  | ghi/eb-product.routes.ts:192                             |
| PUT    | `/api/v1/eb/{gpa,gtli}/cases/:id/insurers`                              | yes  | proposals.edit               |                                                                                  | ghi/eb-product.routes.ts:200                             |
| POST   | `/api/v1/eb/{gpa,gtli}/cases/:id/insurers/:insurerId/decline`           | yes  | proposals.edit               |                                                                                  | ghi/eb-product.routes.ts:208                             |
| GET    | `/api/v1/eb/{gpa,gtli}/cases/:id/members`                               | yes  | proposals.view               |                                                                                  | ghi/eb-product.routes.ts:221                             |
| POST   | `/api/v1/eb/{gpa,gtli}/cases/:id/members`                               | yes  | proposals.edit               |                                                                                  | ghi/eb-product.routes.ts:228                             |
| PUT    | `/api/v1/eb/{gpa,gtli}/cases/:id/members/:memberId`                     | yes  | proposals.edit               |                                                                                  | ghi/eb-product.routes.ts:235                             |
| DELETE | `/api/v1/eb/{gpa,gtli}/cases/:id/members/:memberId`                     | yes  | proposals.edit               |                                                                                  | ghi/eb-product.routes.ts:245                             |
| GET    | `/api/v1/eb/{gpa,gtli}/cases/:id/census/summary`                        | yes  | proposals.view               |                                                                                  | ghi/eb-product.routes.ts:253                             |
| GET    | `/api/v1/eb/{gpa,gtli}/cases/:id/census/issues`                         | yes  | proposals.view               |                                                                                  | ghi/eb-product.routes.ts:260                             |
| GET    | `/api/v1/eb/{gpa,gtli}/cases/:id/census/imports`                        | yes  | proposals.view               |                                                                                  | ghi/eb-product.routes.ts:267                             |
| POST   | `/api/v1/eb/{gpa,gtli}/cases/:id/census/imports`                        | yes  | proposals.edit               |                                                                                  | ghi/eb-product.routes.ts:274                             |
| GET    | `/api/v1/eb/{gpa,gtli}/cases/:id/census/imports/:importId`              | yes  | proposals.view               |                                                                                  | ghi/eb-product.routes.ts:294                             |
| PUT    | `/api/v1/eb/{gpa,gtli}/cases/:id/census/imports/:importId/rows/:row`    | yes  | proposals.edit               |                                                                                  | ghi/eb-product.routes.ts:304                             |
| POST   | `/api/v1/eb/{gpa,gtli}/cases/:id/census/imports/:importId/commit`       | yes  | proposals.edit               |                                                                                  | ghi/eb-product.routes.ts:324                             |
| POST   | `/api/v1/eb/{gpa,gtli}/cases/:id/census/imports/:importId/discard`      | yes  | proposals.edit               |                                                                                  | ghi/eb-product.routes.ts:334                             |
| GET    | `/api/v1/eb/{gpa,gtli}/cases/:id/census/imports/:importId/error-report` | yes  | proposals.view               |                                                                                  | ghi/eb-product.routes.ts:341                             |
| GET    | `/api/v1/eb/{gpa,gtli}/cases/:id/files`                                 | yes  | proposals.view               |                                                                                  | ghi/eb-product.routes.ts:361                             |
| POST   | `/api/v1/eb/{gpa,gtli}/cases/:id/files`                                 | yes  | proposals.edit               |                                                                                  | ghi/eb-product.routes.ts:368                             |
| GET    | `/api/v1/eb/{gpa,gtli}/cases/:id/files/:fileId`                         | yes  | proposals.view               |                                                                                  | ghi/eb-product.routes.ts:390                             |
| GET    | `/api/v1/eb/{gpa,gtli}/cases/:id/rfq`                                   | yes  | proposals.view               |                                                                                  | ghi/eb-product.routes.ts:399                             |
| GET    | `/api/v1/eb/{gpa,gtli}/cases/:id/rfq/preview`                           | yes  | proposals.view               |                                                                                  | ghi/eb-product.routes.ts:406                             |
| POST   | `/api/v1/eb/{gpa,gtli}/cases/:id/rfq/generate`                          | yes  | proposals.edit               |                                                                                  | ghi/eb-product.routes.ts:413                             |
| POST   | `/api/v1/eb/{gpa,gtli}/cases/:id/rfq/submit`                            | yes  | proposals.edit               |                                                                                  | ghi/eb-product.routes.ts:420                             |
| POST   | `/api/v1/eb/{gpa,gtli}/cases/:id/rfq/decision`                          | yes  | proposals.approve            |                                                                                  | ghi/eb-product.routes.ts:427                             |
| GET    | `/api/v1/eb/{gpa,gtli}/cases/:id/rfq/document`                          | yes  | proposals.export             |                                                                                  | ghi/eb-product.routes.ts:434                             |
| POST   | `/api/v1/eb/{gpa,gtli}/cases/:id/rfq/email`                             | yes  | proposals.send               |                                                                                  | ghi/eb-product.routes.ts:441                             |
| POST   | `/api/v1/eb/{gpa,gtli}/cases/:id/rfq/sent`                              | yes  | proposals.send               |                                                                                  | ghi/eb-product.routes.ts:449                             |
| GET    | `/api/v1/eb/{gpa,gtli}/cases/:id/quotes`                                | yes  | proposals.view               |                                                                                  | ghi/eb-product.routes.ts:459                             |
| POST   | `/api/v1/eb/{gpa,gtli}/cases/:id/quotes`                                | yes  | proposals.edit               |                                                                                  | ghi/eb-product.routes.ts:466                             |
| PUT    | `/api/v1/eb/{gpa,gtli}/cases/:id/quotes/:quoteId`                       | yes  | proposals.edit               |                                                                                  | ghi/eb-product.routes.ts:473                             |
| DELETE | `/api/v1/eb/{gpa,gtli}/cases/:id/quotes/:quoteId`                       | yes  | proposals.edit               |                                                                                  | ghi/eb-product.routes.ts:483                             |
| GET    | `/api/v1/eb/{gpa,gtli}/cases/:id/qcrs`                                  | yes  | proposals.view               |                                                                                  | ghi/eb-product.routes.ts:493                             |
| POST   | `/api/v1/eb/{gpa,gtli}/cases/:id/qcrs`                                  | yes  | proposals.edit               |                                                                                  | ghi/eb-product.routes.ts:500                             |
| PUT    | `/api/v1/eb/{gpa,gtli}/cases/:id/qcrs/:qcrId`                           | yes  | proposals.edit               |                                                                                  | ghi/eb-product.routes.ts:507                             |
| POST   | `/api/v1/eb/{gpa,gtli}/cases/:id/qcrs/:qcrId/submit`                    | yes  | proposals.edit               |                                                                                  | ghi/eb-product.routes.ts:517                             |
| POST   | `/api/v1/eb/{gpa,gtli}/cases/:id/qcrs/:qcrId/decision`                  | yes  | proposals.approve            |                                                                                  | ghi/eb-product.routes.ts:524                             |
| GET    | `/api/v1/eb/{gpa,gtli}/cases/:id/qcrs/:qcrId/document`                  | yes  | proposals.export             |                                                                                  | ghi/eb-product.routes.ts:534                             |
| POST   | `/api/v1/eb/{gpa,gtli}/cases/:id/qcrs/:qcrId/email`                     | yes  | proposals.send               |                                                                                  | ghi/eb-product.routes.ts:544                             |
| POST   | `/api/v1/eb/{gpa,gtli}/cases/:id/qcrs/:qcrId/client-decision`           | yes  | proposals.edit               |                                                                                  | ghi/eb-product.routes.ts:554                             |
| GET    | `/api/v1/eb/{gpa,gtli}/cases/:id/payments`                              | yes  | proposals.view               |                                                                                  | ghi/eb-product.routes.ts:566                             |
| POST   | `/api/v1/eb/{gpa,gtli}/cases/:id/payments`                              | yes  | proposals.edit               |                                                                                  | ghi/eb-product.routes.ts:573                             |
| PUT    | `/api/v1/eb/{gpa,gtli}/cases/:id/payments/:paymentId`                   | yes  | proposals.edit               |                                                                                  | ghi/eb-product.routes.ts:580                             |
| GET    | `/api/v1/eb/{gpa,gtli}/cases/:id/placement`                             | yes  | proposals.view               |                                                                                  | ghi/eb-product.routes.ts:590                             |
| GET    | `/api/v1/eb/{gpa,gtli}/cases/:id/placement-slip`                        | yes  | proposals.export             |                                                                                  | ghi/eb-product.routes.ts:597                             |
| POST   | `/api/v1/eb/{gpa,gtli}/cases/:id/placement`                             | yes  | proposals.edit               |                                                                                  | ghi/eb-product.routes.ts:604                             |
| GET    | `/api/v1/eb/cases`                                                      | yes  | proposals.view               |                                                                                  | ghi/eb.routes.ts:38                                      |
| POST   | `/api/v1/eb/cases`                                                      | yes  | proposals.create             |                                                                                  | ghi/eb.routes.ts:45                                      |
| GET    | `/api/v1/eb/census-templates`                                           | yes  | proposals.view               |                                                                                  | ghi/eb.routes.ts:56                                      |
| GET    | `/api/v1/eb/companies/:clientId/employees`                              | yes  | proposals.view               |                                                                                  | ghi/eb.routes.ts:63                                      |
| POST   | `/api/v1/eb/companies/:clientId/employees/resolve`                      | yes  | proposals.edit               |                                                                                  | ghi/eb.routes.ts:73                                      |
| PUT    | `/api/v1/eb/companies/:clientId/employees/:employeeId`                  | yes  | proposals.edit               |                                                                                  | ghi/eb.routes.ts:83                                      |
| GET    | `/api/v1/eb/companies/:clientId/plan-defaults`                          | yes  | clients.view                 |                                                                                  | ghi/eb.routes.ts:93                                      |
| PUT    | `/api/v1/eb/companies/:clientId/plan-defaults/:product`                 | yes  | clients.manage               |                                                                                  | ghi/eb.routes.ts:100                                     |
| GET    | `/api/v1/ghi/cases/:id/rfq`                                             | yes  | proposals.view               |                                                                                  | ghi/ghi-workflow.routes.ts:91                            |
| GET    | `/api/v1/ghi/cases/:id/rfq/preview`                                     | yes  | proposals.view               |                                                                                  | ghi/ghi-workflow.routes.ts:98                            |
| POST   | `/api/v1/ghi/cases/:id/rfq/generate`                                    | yes  | proposals.edit               |                                                                                  | ghi/ghi-workflow.routes.ts:105                           |
| POST   | `/api/v1/ghi/cases/:id/rfq/submit`                                      | yes  | proposals.edit               |                                                                                  | ghi/ghi-workflow.routes.ts:112                           |
| POST   | `/api/v1/ghi/cases/:id/rfq/decision`                                    | yes  | proposals.approve            |                                                                                  | ghi/ghi-workflow.routes.ts:119                           |
| GET    | `/api/v1/ghi/cases/:id/rfq/document`                                    | yes  | proposals.export             |                                                                                  | ghi/ghi-workflow.routes.ts:126                           |
| POST   | `/api/v1/ghi/cases/:id/rfq/email`                                       | yes  | proposals.send               |                                                                                  | ghi/ghi-workflow.routes.ts:133                           |
| POST   | `/api/v1/ghi/cases/:id/rfq/sent`                                        | yes  | proposals.send               |                                                                                  | ghi/ghi-workflow.routes.ts:140                           |
| GET    | `/api/v1/ghi/cases/:id/quotes`                                          | yes  | proposals.view               |                                                                                  | ghi/ghi-workflow.routes.ts:149                           |
| POST   | `/api/v1/ghi/cases/:id/quotes`                                          | yes  | proposals.edit               |                                                                                  | ghi/ghi-workflow.routes.ts:156                           |
| PUT    | `/api/v1/ghi/cases/:id/quotes/:quoteId`                                 | yes  | proposals.edit               |                                                                                  | ghi/ghi-workflow.routes.ts:163                           |
| DELETE | `/api/v1/ghi/cases/:id/quotes/:quoteId`                                 | yes  | proposals.edit               |                                                                                  | ghi/ghi-workflow.routes.ts:173                           |
| GET    | `/api/v1/ghi/cases/:id/qcrs`                                            | yes  | proposals.view               |                                                                                  | ghi/ghi-workflow.routes.ts:183                           |
| POST   | `/api/v1/ghi/cases/:id/qcrs`                                            | yes  | proposals.edit               |                                                                                  | ghi/ghi-workflow.routes.ts:190                           |
| PUT    | `/api/v1/ghi/cases/:id/qcrs/:qcrId`                                     | yes  | proposals.edit               |                                                                                  | ghi/ghi-workflow.routes.ts:197                           |
| POST   | `/api/v1/ghi/cases/:id/qcrs/:qcrId/submit`                              | yes  | proposals.edit               |                                                                                  | ghi/ghi-workflow.routes.ts:207                           |
| POST   | `/api/v1/ghi/cases/:id/qcrs/:qcrId/decision`                            | yes  | proposals.approve            |                                                                                  | ghi/ghi-workflow.routes.ts:214                           |
| GET    | `/api/v1/ghi/cases/:id/qcrs/:qcrId/document`                            | yes  | proposals.export             |                                                                                  | ghi/ghi-workflow.routes.ts:224                           |
| POST   | `/api/v1/ghi/cases/:id/qcrs/:qcrId/email`                               | yes  | proposals.send               |                                                                                  | ghi/ghi-workflow.routes.ts:234                           |
| POST   | `/api/v1/ghi/cases/:id/qcrs/:qcrId/client-decision`                     | yes  | proposals.edit               |                                                                                  | ghi/ghi-workflow.routes.ts:244                           |
| GET    | `/api/v1/ghi/cases/:id/final-qcr`                                       | yes  | proposals.view               |                                                                                  | ghi/ghi-workflow.routes.ts:256                           |
| POST   | `/api/v1/ghi/cases/:id/final-qcr`                                       | yes  | proposals.edit               |                                                                                  | ghi/ghi-workflow.routes.ts:263                           |
| GET    | `/api/v1/ghi/cases/:id/payments`                                        | yes  | proposals.view               |                                                                                  | ghi/ghi-workflow.routes.ts:273                           |
| POST   | `/api/v1/ghi/cases/:id/payments`                                        | yes  | proposals.edit               |                                                                                  | ghi/ghi-workflow.routes.ts:280                           |
| PUT    | `/api/v1/ghi/cases/:id/payments/:paymentId`                             | yes  | proposals.edit               |                                                                                  | ghi/ghi-workflow.routes.ts:287                           |
| GET    | `/api/v1/ghi/cases/:id/placement`                                       | yes  | proposals.view               |                                                                                  | ghi/ghi-workflow.routes.ts:297                           |
| GET    | `/api/v1/ghi/cases/:id/placement-slip`                                  | yes  | proposals.export             |                                                                                  | ghi/ghi-workflow.routes.ts:304                           |
| PUT    | `/api/v1/ghi/cases/:id/policy`                                          | yes  | proposals.edit               |                                                                                  | ghi/ghi-workflow.routes.ts:311                           |
| GET    | `/api/v1/ghi/cases`                                                     | yes  | proposals.view               |                                                                                  | ghi/ghi.routes.ts:103                                    |
| POST   | `/api/v1/ghi/cases`                                                     | yes  | proposals.create             |                                                                                  | ghi/ghi.routes.ts:110                                    |
| GET    | `/api/v1/ghi/cases/:id`                                                 | yes  | proposals.view               |                                                                                  | ghi/ghi.routes.ts:121                                    |
| PUT    | `/api/v1/ghi/cases/:id`                                                 | yes  | proposals.edit               |                                                                                  | ghi/ghi.routes.ts:128                                    |
| POST   | `/api/v1/ghi/cases/:id/close`                                           | yes  | proposals.edit               |                                                                                  | ghi/ghi.routes.ts:138                                    |
| PUT    | `/api/v1/ghi/cases/:id/requirements`                                    | yes  | proposals.edit               |                                                                                  | ghi/ghi.routes.ts:148                                    |
| PUT    | `/api/v1/ghi/cases/:id/plan`                                            | yes  | proposals.edit               |                                                                                  | ghi/ghi.routes.ts:158                                    |
| PUT    | `/api/v1/ghi/cases/:id/insurers`                                        | yes  | proposals.edit               |                                                                                  | ghi/ghi.routes.ts:169                                    |
| POST   | `/api/v1/ghi/cases/:id/insurers/:insurerId/decline`                     | yes  | proposals.edit               |                                                                                  | ghi/ghi.routes.ts:179                                    |
| GET    | `/api/v1/ghi/census-template`                                           | yes  | proposals.view               |                                                                                  | ghi/ghi.routes.ts:191                                    |
| GET    | `/api/v1/ghi/cases/:id/members`                                         | yes  | proposals.view               |                                                                                  | ghi/ghi.routes.ts:202                                    |
| POST   | `/api/v1/ghi/cases/:id/members`                                         | yes  | proposals.edit               |                                                                                  | ghi/ghi.routes.ts:212                                    |
| PUT    | `/api/v1/ghi/cases/:id/members/:memberId`                               | yes  | proposals.edit               |                                                                                  | ghi/ghi.routes.ts:222                                    |
| DELETE | `/api/v1/ghi/cases/:id/members/:memberId`                               | yes  | proposals.edit               |                                                                                  | ghi/ghi.routes.ts:232                                    |
| GET    | `/api/v1/ghi/cases/:id/census/summary`                                  | yes  | proposals.view               |                                                                                  | ghi/ghi.routes.ts:240                                    |
| GET    | `/api/v1/ghi/cases/:id/census/issues`                                   | yes  | proposals.view               |                                                                                  | ghi/ghi.routes.ts:247                                    |
| GET    | `/api/v1/ghi/cases/:id/census/imports`                                  | yes  | proposals.view               |                                                                                  | ghi/ghi.routes.ts:254                                    |
| POST   | `/api/v1/ghi/cases/:id/census/imports`                                  | yes  | proposals.edit               |                                                                                  | ghi/ghi.routes.ts:261                                    |
| GET    | `/api/v1/ghi/cases/:id/census/imports/:importId`                        | yes  | proposals.view               |                                                                                  | ghi/ghi.routes.ts:279                                    |
| GET    | `/api/v1/ghi/cases/:id/census/imports/:importId/error-report`           | yes  | proposals.view               |                                                                                  | ghi/ghi.routes.ts:289                                    |
| PUT    | `/api/v1/ghi/cases/:id/census/imports/:importId/rows/:row`              | yes  | proposals.edit               |                                                                                  | ghi/ghi.routes.ts:301                                    |
| POST   | `/api/v1/ghi/cases/:id/census/imports/:importId/commit`                 | yes  | proposals.edit               |                                                                                  | ghi/ghi.routes.ts:313                                    |
| POST   | `/api/v1/ghi/cases/:id/census/imports/:importId/discard`                | yes  | proposals.edit               |                                                                                  | ghi/ghi.routes.ts:325                                    |
| GET    | `/api/v1/ghi/cases/:id/files`                                           | yes  | proposals.view               |                                                                                  | ghi/ghi.routes.ts:334                                    |
| POST   | `/api/v1/ghi/cases/:id/files`                                           | yes  | proposals.edit               |                                                                                  | ghi/ghi.routes.ts:341                                    |
| GET    | `/api/v1/ghi/cases/:id/files/:fileId`                                   | yes  | proposals.view               |                                                                                  | ghi/ghi.routes.ts:361                                    |
| GET    | `/api/v1/health`                                                        | no   | —                            | Public: status, db up/down, version, uptime                                      | health/health.routes.ts:11                               |
| GET    | `/api/v1/imports/:entity/template`                                      | yes  | —                            | Permission checked in handler: assertMayImport (clients.manage / masters.manage) | imports/imports.routes.ts:36                             |
| POST   | `/api/v1/imports/:entity`                                               | yes  | —                            | Permission checked in handler: assertMayImport (clients.manage / masters.manage) | imports/imports.routes.ts:54                             |
| GET    | `/api/v1/insurers`                                                      | yes  | masters.view                 |                                                                                  | insurers/insurers.routes.ts:23                           |
| POST   | `/api/v1/insurers`                                                      | yes  | masters.view, masters.manage |                                                                                  | insurers/insurers.routes.ts:30                           |
| GET    | `/api/v1/insurers/:id`                                                  | yes  | masters.view                 |                                                                                  | insurers/insurers.routes.ts:39                           |
| PATCH  | `/api/v1/insurers/:id`                                                  | yes  | masters.view, masters.manage |                                                                                  | insurers/insurers.routes.ts:46                           |
| GET    | `/api/v1/mail/status`                                                   | yes  | settings.view                |                                                                                  | mail/mail.routes.ts:12                                   |
| GET    | `/api/v1/masters/occupancies`                                           | yes  | masters.view                 |                                                                                  | masters/masters.routes.ts:51                             |
| GET    | `/api/v1/masters/occupancies/:tacCode`                                  | yes  | masters.view                 |                                                                                  | masters/masters.routes.ts:58                             |
| GET    | `/api/v1/masters/pincodes/:pincode`                                     | yes  | masters.view                 |                                                                                  | masters/masters.routes.ts:65                             |
| GET    | `/api/v1/masters/versions`                                              | yes  | masters.view                 |                                                                                  | masters/masters.routes.ts:72                             |
| POST   | `/api/v1/masters/versions/:id/activate`                                 | yes  | masters.view, masters.manage |                                                                                  | masters/masters.routes.ts:79                             |
| GET    | `/api/v1/masters/pincodes`                                              | yes  | masters.view                 |                                                                                  | masters/masters.routes.ts:95                             |
| POST   | `/api/v1/masters/occupancies`                                           | yes  | masters.view, masters.manage |                                                                                  | masters/masters.routes.ts:105                            |
| PATCH  | `/api/v1/masters/occupancies/:tacCode`                                  | yes  | masters.view, masters.manage |                                                                                  | masters/masters.routes.ts:113                            |
| POST   | `/api/v1/masters/pincodes`                                              | yes  | masters.view, masters.manage |                                                                                  | masters/masters.routes.ts:124                            |
| PATCH  | `/api/v1/masters/pincodes/:pincode`                                     | yes  | masters.view, masters.manage |                                                                                  | masters/masters.routes.ts:132                            |
| GET    | `/api/v1/masters/workbook`                                              | yes  | masters.view                 |                                                                                  | masters/masters.routes.ts:143                            |
| POST   | `/api/v1/masters/import`                                                | yes  | masters.view, masters.manage |                                                                                  | masters/masters.routes.ts:156                            |
| GET    | `/api/v1/notifications`                                                 | yes  | —                            | Scoped to recipientId = caller                                                   | notifications/notifications.routes.ts:36                 |
| GET    | `/api/v1/notifications/unread-count`                                    | yes  | —                            | Scoped to recipientId = caller                                                   | notifications/notifications.routes.ts:43                 |
| POST   | `/api/v1/notifications/read-all`                                        | yes  | —                            | Scoped to recipientId = caller                                                   | notifications/notifications.routes.ts:50                 |
| POST   | `/api/v1/notifications/:id/read`                                        | yes  | —                            | Scoped to recipientId = caller                                                   | notifications/notifications.routes.ts:57                 |
| GET    | `/api/v1/proposals/:id/placement-slip`                                  | yes  | proposals.view               |                                                                                  | placement-slip/placement-slip.routes.ts:59               |
| PUT    | `/api/v1/proposals/:id/placement-slip`                                  | yes  | proposals.edit               |                                                                                  | placement-slip/placement-slip.routes.ts:67               |
| POST   | `/api/v1/proposals/:id/placement-slip/approve`                          | yes  | proposals.approve            |                                                                                  | placement-slip/placement-slip.routes.ts:78               |
| GET    | `/api/v1/proposals/:id/placement-slip/document`                         | yes  | proposals.export             |                                                                                  | placement-slip/placement-slip.routes.ts:89               |
| POST   | `/api/v1/proposals/:id/placement-slip/email`                            | yes  | proposals.send               |                                                                                  | placement-slip/placement-slip.routes.ts:104              |
| POST   | `/api/v1/proposals/:id/placement-slip/files`                            | yes  | proposals.edit               |                                                                                  | placement-slip/placement-slip.routes.ts:115              |
| GET    | `/api/v1/proposals/:id/placement-slip/files/:fileId`                    | yes  | proposals.view               |                                                                                  | placement-slip/placement-slip.routes.ts:132              |
| PUT    | `/api/v1/proposals/:id/placement-slip/placed`                           | yes  | proposals.edit               |                                                                                  | placement-slip/placement-slip.routes.ts:146              |
| GET    | `/api/v1/proposals`                                                     | yes  | proposals.view               |                                                                                  | proposals/proposals.routes.ts:95                         |
| POST   | `/api/v1/proposals`                                                     | yes  | proposals.create             |                                                                                  | proposals/proposals.routes.ts:105                        |
| GET    | `/api/v1/proposals/owners`                                              | yes  | proposals.create             |                                                                                  | proposals/proposals.routes.ts:118                        |
| GET    | `/api/v1/proposals/last-policy`                                         | yes  | proposals.create             |                                                                                  | proposals/proposals.routes.ts:126                        |
| GET    | `/api/v1/proposals/:id`                                                 | yes  | proposals.view               |                                                                                  | proposals/proposals.routes.ts:134                        |
| PUT    | `/api/v1/proposals/:id/data-sheet`                                      | yes  | proposals.edit               |                                                                                  | proposals/proposals.routes.ts:142                        |
| POST   | `/api/v1/proposals/:id/data-sheet/import`                               | yes  | proposals.edit               |                                                                                  | proposals/proposals.routes.ts:153                        |
| POST   | `/api/v1/proposals/:id/existing-policy`                                 | yes  | proposals.edit               |                                                                                  | proposals/proposals.routes.ts:172                        |
| DELETE | `/api/v1/proposals/:id`                                                 | yes  | proposals.delete             |                                                                                  | proposals/proposals.routes.ts:180                        |
| POST   | `/api/v1/proposals/:id/restore`                                         | yes  | proposals.delete             |                                                                                  | proposals/proposals.routes.ts:188                        |
| POST   | `/api/v1/proposals/:id/stage`                                           | yes  | proposals.edit               |                                                                                  | proposals/proposals.routes.ts:196                        |
| PUT    | `/api/v1/proposals/:id/insurers`                                        | yes  | proposals.edit               |                                                                                  | proposals/proposals.routes.ts:207                        |
| GET    | `/api/v1/proposals/:id/rfq`                                             | yes  | proposals.export             |                                                                                  | proposals/proposals.routes.ts:218                        |
| POST   | `/api/v1/proposals/:id/rfq/sent`                                        | yes  | proposals.send               |                                                                                  | proposals/proposals.routes.ts:234                        |
| POST   | `/api/v1/proposals/:id/rfq/preview`                                     | yes  | proposals.send               |                                                                                  | proposals/proposals.routes.ts:245                        |
| POST   | `/api/v1/proposals/:id/rfq/email`                                       | yes  | proposals.send               |                                                                                  | proposals/proposals.routes.ts:256                        |
| POST   | `/api/v1/proposals/:id/insurers/:insurerId/reminder`                    | yes  | proposals.send               |                                                                                  | proposals/proposals.routes.ts:267                        |
| PUT    | `/api/v1/proposals/:id/insurers/:insurerId/response`                    | yes  | proposals.edit               |                                                                                  | proposals/proposals.routes.ts:278                        |
| GET    | `/api/v1/proposals/:id/mails`                                           | yes  | proposals.view               |                                                                                  | proposals/proposals.routes.ts:289                        |
| GET    | `/api/v1/proposals/:id/mails/:mailId`                                   | yes  | proposals.view               |                                                                                  | proposals/proposals.routes.ts:301                        |
| GET    | `/api/v1/proposals/:id/mails/:mailId/attachment`                        | yes  | proposals.export             |                                                                                  | proposals/proposals.routes.ts:309                        |
| GET    | `/api/v1/proposals/:id/qcr`                                             | yes  | proposals.view               |                                                                                  | qcr/qcr.routes.ts:39                                     |
| PUT    | `/api/v1/proposals/:id/qcr`                                             | yes  | proposals.edit               |                                                                                  | qcr/qcr.routes.ts:47                                     |
| POST   | `/api/v1/proposals/:id/qcr/approve`                                     | yes  | proposals.approve            |                                                                                  | qcr/qcr.routes.ts:58                                     |
| GET    | `/api/v1/proposals/:id/qcr/document`                                    | yes  | proposals.export             |                                                                                  | qcr/qcr.routes.ts:69                                     |
| POST   | `/api/v1/proposals/:id/qcr/email`                                       | yes  | proposals.send               |                                                                                  | qcr/qcr.routes.ts:84                                     |
| GET    | `/api/v1/proposals/:id/quotes`                                          | yes  | proposals.view               |                                                                                  | quotes/quotes.routes.ts:52                               |
| POST   | `/api/v1/proposals/:id/insurers/:insurerId/quotes`                      | yes  | proposals.edit               |                                                                                  | quotes/quotes.routes.ts:60                               |
| POST   | `/api/v1/proposals/:id/insurers/:insurerId/quote-attachments`           | yes  | proposals.edit               |                                                                                  | quotes/quotes.routes.ts:81                               |
| POST   | `/api/v1/proposals/:id/quote-attachments/:attachmentId/read`            | yes  | proposals.edit               |                                                                                  | quotes/quotes.routes.ts:110                              |
| GET    | `/api/v1/proposals/:id/quote-attachments/:attachmentId`                 | yes  | proposals.view               |                                                                                  | quotes/quotes.routes.ts:125                              |
| GET    | `/api/v1/proposals/:id/rfq/versions`                                    | yes  | proposals.view               |                                                                                  | rfq/rfq.routes.ts:44                                     |
| PUT    | `/api/v1/proposals/:id/rfq/edits`                                       | yes  | proposals.edit               |                                                                                  | rfq/rfq.routes.ts:51                                     |
| POST   | `/api/v1/proposals/:id/rfq/versions`                                    | yes  | proposals.edit               |                                                                                  | rfq/rfq.routes.ts:61                                     |
| GET    | `/api/v1/proposals/:id/rfq/versions/:version`                           | yes  | proposals.view               |                                                                                  | rfq/rfq.routes.ts:68                                     |
| GET    | `/api/v1/proposals/:id/rfq/versions/:version/file`                      | yes  | proposals.export             |                                                                                  | rfq/rfq.routes.ts:75                                     |
| POST   | `/api/v1/proposals/:id/rfq/versions/:version/submit`                    | yes  | proposals.edit               |                                                                                  | rfq/rfq.routes.ts:94                                     |
| POST   | `/api/v1/proposals/:id/rfq/versions/:version/approve`                   | yes  | proposals.approve            |                                                                                  | rfq/rfq.routes.ts:104                                    |
| POST   | `/api/v1/proposals/:id/rfq/versions/:version/return`                    | yes  | proposals.approve            |                                                                                  | rfq/rfq.routes.ts:114                                    |
| GET    | `/api/v1/tpa/settings`                                                  | yes  | claims.admin (audited)       |                                                                                  | tpa/tpa.routes.ts:117                                    |
| PUT    | `/api/v1/tpa/settings`                                                  | yes  | claims.admin (audited)       |                                                                                  | tpa/tpa.routes.ts:124                                    |
| GET    | `/api/v1/tpa/policies`                                                  | yes  | claims.view (audited)        |                                                                                  | tpa/tpa.routes.ts:132                                    |
| GET    | `/api/v1/tpa/formats`                                                   | yes  | claims.process (audited)     |                                                                                  | tpa/tpa.routes.ts:141                                    |
| POST   | `/api/v1/tpa/formats`                                                   | yes  | claims.admin (audited)       |                                                                                  | tpa/tpa.routes.ts:148                                    |
| GET    | `/api/v1/tpa/formats/:formatId`                                         | yes  | claims.process (audited)     |                                                                                  | tpa/tpa.routes.ts:155                                    |
| PUT    | `/api/v1/tpa/formats/:formatId`                                         | yes  | claims.admin (audited)       |                                                                                  | tpa/tpa.routes.ts:162                                    |
| POST   | `/api/v1/tpa/formats/:formatId/${path}`                                 | yes  | claims.admin (audited)       |                                                                                  | tpa/tpa.routes.ts:176                                    |
| POST   | `/api/v1/tpa/inspect`                                                   | yes  | claims.process (audited)     |                                                                                  | tpa/tpa.routes.ts:184                                    |
| GET    | `/api/v1/tpa/imports`                                                   | yes  | claims.process (audited)     |                                                                                  | tpa/tpa.routes.ts:194                                    |
| POST   | `/api/v1/tpa/imports`                                                   | yes  | claims.process (audited)     |                                                                                  | tpa/tpa.routes.ts:201                                    |
| GET    | `/api/v1/tpa/imports/:importId`                                         | yes  | claims.process (audited)     |                                                                                  | tpa/tpa.routes.ts:209                                    |
| GET    | `/api/v1/tpa/imports/:importId/rows`                                    | yes  | claims.process (audited)     |                                                                                  | tpa/tpa.routes.ts:216                                    |
| GET    | `/api/v1/tpa/imports/:importId/error-report`                            | yes  | claims.process (audited)     |                                                                                  | tpa/tpa.routes.ts:235                                    |
| POST   | `/api/v1/tpa/imports/:importId/commit`                                  | yes  | claims.process (audited)     |                                                                                  | tpa/tpa.routes.ts:249                                    |
| POST   | `/api/v1/tpa/imports/:importId/discard`                                 | yes  | claims.process (audited)     |                                                                                  | tpa/tpa.routes.ts:266                                    |
| GET    | `/api/v1/tpa/claims`                                                    | yes  | claims.view (audited)        |                                                                                  | tpa/tpa.routes.ts:275                                    |
| GET    | `/api/v1/tpa/claims/:claimId`                                           | yes  | claims.view (audited)        |                                                                                  | tpa/tpa.routes.ts:296                                    |
| GET    | `/api/v1/tpa/claims/:claimId/history`                                   | yes  | claims.view (audited)        |                                                                                  | tpa/tpa.routes.ts:310                                    |
| PUT    | `/api/v1/tpa/claims/:claimId/link`                                      | yes  | claims.process (audited)     |                                                                                  | tpa/tpa.routes.ts:322                                    |
| GET    | `/api/v1/users`                                                         | yes  | users.manage                 |                                                                                  | users/users.routes.ts:20                                 |
| POST   | `/api/v1/users`                                                         | yes  | users.manage                 |                                                                                  | users/users.routes.ts:27                                 |
| PATCH  | `/api/v1/users/:id`                                                     | yes  | users.manage                 |                                                                                  | users/users.routes.ts:35                                 |
| GET    | `/api/v1/qcrs`                                                          | yes  | proposals.view               |                                                                                  | worklists/worklists.routes.ts:23                         |
| GET    | `/api/v1/placement-slips`                                               | yes  | proposals.view               |                                                                                  | worklists/worklists.routes.ts:31                         |
