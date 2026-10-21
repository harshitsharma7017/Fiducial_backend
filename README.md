# Fiducial backend

Express API for **Fiducial**, the property insurance placement platform that Spirezen Enterprises is building for
Fiducial Insurance Brokers. It will replace the Excel chain of Data Sheet → RFQ → insurer quotes → QCR → Placement
Slip.

This repository holds the **foundation**: authentication, role-based permissions, user admin, an append-only audit log with a read API, IIB
occupancy and pincode masters with a validated import, the client master with any number of risk locations per
client, the insurer master with the email addresses RFQs go to, the policy and cover masters (policies, coverage
sections, add-ons, BSUS/BLUS add-on rates, GST rates, standard notes), and new-business
proposals from creation to the RFQ (Data Sheet, RFQ workbook, insurers, emailing it or marking it sent), insurer
statuses with reminders and responses, and a mail log per case. The web app lives in the separate
**Fiducial_frontend** repository and calls this API through its own server-side routes.

Project documents are in [docs/](docs/); open questions and data issues are in
[docs/OPEN_ITEMS.md](docs/OPEN_ITEMS.md).

## Prerequisites

- Node.js 24 LTS (`nvm use` reads `.nvmrc`) and npm 11
- Docker with Compose v2, for MongoDB

## First run

```sh
nvm use
npm install
docker compose up -d          # MongoDB 7 replica set; wait for "healthy" in: docker compose ps
cp .env.example .env

# Create the first admin (refuses to run without a password; minimum 12 characters)
SEED_ADMIN_EMAIL=admin@example.com SEED_ADMIN_PASSWORD='choose a long passphrase' npm run seed:admin

npm run dev                   # http://localhost:4000
```

Then start the web app from Fiducial_frontend, sign in at http://localhost:3000 as the admin, and load the data in
the app: **Masters › Import data**.

1. **IIB master** (occupancy codes and pincodes): upload the client's IIB workbook, preview its validation report,
   **Save as new version**, then **Activate**. Lookups and client and location forms read the
   active version.
2. **Clients**, then **Risk locations**, then **Insurers**: download each template, fill it in, preview and import.

No data is kept in this repository: every master and record comes in through these uploads (or the screens), so
each change is versioned or audited. `npm run import:masters -- <file> [--activate]` still loads an IIB workbook from
the command line, for operators.

| URL                                    | What                          |
| -------------------------------------- | ----------------------------- |
| http://localhost:4000/api/v1           | API                           |
| http://localhost:4000/api/docs         | Swagger UI (OpenAPI from Zod) |
| http://localhost:4000/api/openapi.json | OpenAPI document              |
| http://localhost:4000/api/v1/health    | Health (public)               |

## Scripts

| Command                                   | Does                                                                                                                                                                                               |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev`                             | Runs the API with `node --watch` (Node runs the TypeScript directly)                                                                                                                               |
| `npm run build` / `npm start`             | Compiles to `dist/` / runs the compiled API                                                                                                                                                        |
| `npm run lint`                            | ESLint (type-aware) and a Prettier check                                                                                                                                                           |
| `npm run typecheck`                       | `tsc --noEmit`                                                                                                                                                                                     |
| `npm test`                                | Vitest; integration tests use an in-memory MongoDB replica set                                                                                                                                     |
| `npm run seed:admin`                      | Creates the first admin from `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`                                                                                                                            |
| `npm run import:masters -- <file> [opts]` | `--activate`, `--effective-from YYYY-MM-DD`, `--by EMAIL`, `--force`                                                                                                                               |
| `npm run clean:cases [-- --yes]`          | Counts, then with `--yes` deletes clients, locations, insurers, cases, quotes, QCRs, RFQ versions and the mail log; keeps users, masters, templates and the audit log                              |
| `npm run sync:stages [-- --yes]`          | Lists, then with `--yes` moves forward the open cases whose stage is behind the work recorded on them (quotes, approved QCR, client approval, slip sent, policy recorded); never moves a case back |
| `npm run format`                          | Prettier write                                                                                                                                                                                     |

The first `npm test` downloads a MongoDB 7.0.43 binary (about 70 MB) for `mongodb-memory-server`.

## Layout

```
src/
  server.ts, app.ts     HTTP server and the Express app
  config/               Zod-validated environment
  lib/                  logger, errors, decimal helpers, db, OpenAPI registry
  middleware/           request id, auth, permissions, validation, error handling
  modules/              auth, users, audit, masters (with import/), clients, insurers, imports, health,
                        proposals, documents, catalog, email-templates, mail (transport, mail log)
  scripts/              seed-admin.ts, import-masters.ts
  shared/               API contracts (Zod schemas, enums, formatters), copied to the frontend
test/                   Supertest integration tests and helpers
data/client-formats/    The client's blank Excel formats (reference only; nothing reads them)
docs/                   Project documents and OPEN_ITEMS.md
```

## Shared contracts

`src/shared/` holds the request and response schemas, enums, types and formatters that both repos use. This repo is
the source of truth; Fiducial_frontend keeps an identical copy in its own `src/shared/`. After changing a file here,
run `npm run shared:sync` in Fiducial_frontend (with the two repos side by side), and commit the change in both repos.
`npm run shared:check` in the frontend reports any difference; the frontend's CI runs it against this repo's `main`, so
it fails there until the frontend is synced.

## Conventions

- **No floating point for money or rates.** Use `decimal.js` (ROUND_HALF_UP) and MongoDB `Decimal128`; JSON carries
  them as strings. Rates are per mille; amounts have 2 decimals.
- **Every input is validated** with strict Zod schemas through `route({ params, query, body }, handler)`. Unknown
  fields are rejected, and request values never reach a Mongo filter unparsed.
- **Errors** always have the shape `{ message, code, details? }`; every response has an `X-Request-Id`.
- **Master data is versioned.** Imports create DRAFT versions; activation supersedes the previous version in one
  transaction. Lookups read only the ACTIVE version.
- **Audit**: sign-ins (success and failure), sign-outs, user creates and edits, client, risk location and insurer
  creates and edits, master imports, activations and the versions they supersede are written to the append-only `audit_logs` collection, in the same transaction as the
  change. Each entry keeps the record's fields before and after, so `GET /api/v1/audit` (Admin) can show who changed
  what, when, and each field's old and new value. It filters by kind (sign-in, create, edit, approve, send, export),
  by record and by who acted. Proposals are audited too: each RFQ download is an export (`RFQ_DOWNLOADED`) and
  marking the RFQ sent is a send (`RFQ_SENT`).
- **Roles and permissions**: each route needs one permission (`requirePermission()`), and
  `src/shared/permissions.ts` maps roles to permissions for both repos:

  | Permission                                                      | Admin | Approver | Relationship Manager | Underwriting / Placement | Read-only |
  | --------------------------------------------------------------- | ----- | -------- | -------------------- | ------------------------ | --------- |
  | `proposals.view`, `clients.view`, `masters.view`                | yes   | yes      | yes                  | yes                      | yes       |
  | `proposals.export`                                              | yes   | yes      | yes                  | yes                      |           |
  | `proposals.edit`, `proposals.send`                              | yes   |          | yes                  | yes                      |           |
  | `proposals.create`, `clients.manage`                            | yes   |          | yes                  |                          |           |
  | `proposals.approve`                                             | yes   | yes      |                      |                          |           |
  | `masters.manage`, `users.manage`, `settings.view`, `audit.view` | yes   |          |                      |                          |           |
  | `claims.view`                                                   | yes   | yes      | yes                  | yes                      |           |
  | `claims.process` (moves only claims assigned to the user)       | yes   |          | yes                  | yes                      |           |
  | `claims.admin` (any claim, reassign, templates, HR contacts)    | yes   |          |                      |                          |           |

  The role codes are `ADMIN`, `MANAGER` (Approver), `ACCOUNT_MANAGER` (Relationship Manager), `PLACEMENT_EXEC`
  (Underwriting / Placement) and `READ_ONLY`. A user with several roles holds the union. The proposals API uses
  `proposals.create`, `.edit`, `.export` and `.send` as described below. The client still has to confirm the table (see
  `docs/OPEN_ITEMS.md`).

- Every endpoint is documented with `documentRoute()` next to its route.

## Clients, risk locations and insurers

- **Clients** (`/api/v1/clients`, plan item M-1): insured name, GSTIN, communication address, contacts, nature of
  business and occupancy. The GSTIN is upper-cased, stripped of spaces and checked for its format, a real GST state
  code and its check character (`src/shared/gst.ts`). A GSTIN belongs to one client only (`409 GSTIN_TAKEN`, also
  enforced by a unique index); clients without GST registration leave it empty. The occupancy code must be in the
  active occupancy master; its description is stored with the client, so a later master version does not change it.
- **Risk locations** (`/api/v1/clients/{id}/locations`, M-2): any number per client, in their own collection. The
  pincode must be in the active pincode master, which supplies the state, district and EQ zone; a location without
  its own occupancy has the client's.
- **Insurers** (`/api/v1/insurers`, M-3): one record per company branch, with contact persons and the RFQ email
  addresses (at least one). Every role can read them, because the RFQ screen takes its recipients from here
  (`GET /api/v1/insurers?active=true`); only Admins (`masters.manage`) change them. Insurers are deactivated, never
  deleted. Company and branch together are unique, ignoring case and extra spaces (`409 INSURER_EXISTS`).
- Clients, locations and insurers are edited with `PATCH` (only the fields sent change) and never deleted.

## Cases: new business and renewals (to the RFQ)

`/api/v1/proposals` serves every case, new business (`NEW`) and renewals (`EXISTING`), from creation to the RFQ.

- **Create** (D-1): type, client, risk locations, policy period (`policyStart`, `policyEnd`; a renewal needs both,
  new business may leave both blank for "1 year from the date of payment"), assigned staff (`ownerId`; any active
  user who may edit proposals, from `GET /proposals/owners`; the creator by default) and the date quotes are needed
  by. Numbered `PRP-<year>-<n>`; starts at stage 1, Draft.
- **9 stages** on every case: Draft, Data Sheet, RFQ Sent, Quotes Received, QCR, Client Approval, Placement Slip,
  Placed, Closed. The first three follow the Data Sheet and the RFQ; from RFQ Sent the team moves the case one stage
  at a time (`POST /{id}/stage`, `nextStage` says which) up to Placed; a case can be closed before Placed, with a
  reason, which locks it. Each move is audited (`PROPOSAL_STAGE_CHANGED`) and on the case's activity.
- **Renewals** (D-2): last year's policy comes from the policy administration software's public API
  (`src/modules/proposals/existing-policy-source.ts`, configured by `EXISTING_POLICY_API_URL`, `_KEY`,
  `_TIMEOUT_MS` and `EXISTING_POLICY_SOURCE_NAME`). `GET /proposals/last-policy?clientId=` shows it before creating;
  creating a renewal copies it onto the case as `existingPolicy` (insurer, policy number, period, sum insured and
  premium per section, Fire lines, totals): the Existing column of the Data Sheet and the RFQ schedule. The other
  sections it had start included, with last year's sum insured as Proposed 1. If the software has no policy, is down
  or is not configured, the renewal is still created and `existingPolicyLookup` says why;
  `POST /{id}/existing-policy` fetches it again until the RFQ is sent. Tests use a fake source; the HTTP adapter is
  tested against a local server.

- **Create** (`POST`, `proposals.create`): a client from the client master, any of its risk locations and the date
  quotes are needed by. Numbered `PRP-<year>-<n>` from a per-year counter. Starts as Draft.
- **Data Sheet** (`PUT /{id}/data-sheet`, `proposals.edit`): saved as a whole. Per location, the client's "Fire &
  Burglary" block (D-3): 7 numbered items with sub-items (1a–1f buildings, 5a–5d plant and machinery, 6a third-party
  stock), worded as the client's Data Sheet (`FIRE_ITEMS` in `src/shared/proposals.ts`). Buildings are priced as
  sq ft × rate unless an amount is typed; as in Excel, the product is kept exact (it can carry paise) and totals add
  the exact amounts, so the rounded figures match the client's sheet for the same inputs. Hypothecation and stock in
  open space (D-7) print on the RFQ schedule and its "fire by location" sheet, which follows the Data Sheet layout. Also hypothecation, stock in the open and the nine risk details. For the
  proposal: an optional Option 2 per Fire line, the 13 other sections (included or not, Proposed 1 and 2), up to
  three years of claims and notes. Amounts are whole rupees.
- **Other sections** (D-4, D-5): each of the 13 can be included or marked not required. FLOP, Money, Fidelity and
  Public Liability carry the Data Sheet's lines (`SECTION_LINES`: annual gross profit; cash in safe and in transit;
  employees and limits; accident and aggregate limits). Plate Glass, Neon Sign, All Risk, EEI, MBD and Boiler carry
  an annexure grid in the client's Annexure columns (`ANNEXURE_SECTIONS`, up to 200 rows). On save the rows' total
  becomes the section's Proposed 1, and so do the lines a section's sum insured is made of, once entered
  (`SUM_INSURED_LINES`): FLOP's annual gross profit, Money's cash in safe + single carrying limit (and Option 2 from its
  Option 2 lines), Fidelity's limit per policy period and Public Liability's aggregate limit; the RFQ schedule prints the lines,
  and an "Annexure" sheet lists every item with its total.
- **Deleted bin** (`DELETE /{id}` and `POST /{id}/restore`, `proposals.delete`, Admins only): deleting moves a case to
  the bin (`deleted: { at, by }`); nothing is erased. The case model leaves binned cases out of every query unless the
  query names `deleted` (`proposal.model.ts`), so lists, worklists and dashboards drop them, and `liveCaseOnly()`
  answers 404 on every `/proposals/{id}/…` route (quotes, QCR, approval, slip, mail) except restore. `GET /?deleted=true`
  lists the bin. Both moves are in the case's activity and the audit log (`PROPOSAL_DELETED`, `PROPOSAL_RESTORED`).
- **Data Sheet import** (DS-08, `POST /{id}/data-sheet/import?fileName=`, `proposals.edit`, body the .xlsx, up to
  5 MB): reads the client's own Data Sheet workbook (`data/client-formats/Fiducial_Property_data sheet.xlsx` format)
  and returns the values, without saving (`src/modules/proposals/data-sheet-import.ts`). Each sheet titled "DATA SHEET
  FOR PROPERTY INSURANCE" is one location: its Fire lines (sq ft × rate for buildings), hypothecation, stock in the
  open and the 14 risk features folded into the nine risk details, with the case location it most likely is (by name
  or address, else by order). The other sections' lines and the Annexure sheet's rows come back by section. Doubts
  (paise rounded, another insured's name or GSTIN, more sheets than locations) come back as `warnings`. A closed or
  locked case is refused (409); a workbook with no Data Sheet is a 400.
- **Completeness**: every response lists in `missing` what the Data Sheet still needs before the RFQ (at least one
  location, Fire sums insured for every location, Proposed 1 for every included section). The stage is Data Sheet
  once nothing is missing.
- **Insurers** (`PUT /{id}/insurers`, `proposals.edit`): up to five active insurers from the insurer master. One the
  RFQ was sent to cannot be taken off.
- **Product** (C-1): the record's `product` is the one chosen on the Data Sheet, else the first the Fire sum insured
  suggests (`SUGGESTED`). A suggested product is `CHOSEN`; one outside the suggestion is `OVERRIDE` and needs
  `product.reason` (400 otherwise). Before any Fire sum insured, any product may be chosen.
- **Three options** (C-2): every schedule line has Existing, Option 1 and Option 2 — Fire lines, section sums insured
  and the section lines (`lines`, `lines2`, `existingLines`). A renewal's Existing column starts as the policy
  software's copy (`existingPolicy`, kept as fetched); figures typed on the Data Sheet replace it (`existing.source`
  `DATA_SHEET`), and Fetch again goes back to the copy.
- **Burglary basis** (C-3): 100% or first loss 25/50/75% (`basis`, Burglary and Burglary Floater). With a basis,
  Burglary's sum insured is the Fire contents (all items but buildings; Option 2 the contents lines given a second
  figure), worked out on every read; `basisAmounts` is the share per option. Older cases with a typed amount and no
  basis are unchanged.
- **Add-ons** (C-4): chosen from the product's add-on lists (the product master's "Add-on lists", else the list named
  like the product), checked against the add-on master. Favourites per client: `GET/PUT
/api/v1/clients/{id}/addon-favourites` (`proposals.view` / `proposals.edit`, audited `ADDON_FAVOURITES_UPDATED`).
- **Covers** (C-6): each section's add-on covers from the coverage section master (Earthquake, STFI, Terrorism,
  Floater clause...) are answered Required or Not required (`fireCovers`, `sections[].covers`); unanswered is null.
- The RFQ prints all of these: the three columns, the basis row (a 75% row is added to the client's template), the
  covers' answers, the chosen product only, and the chosen add-ons on the product's sheet (other products' add-on
  sheets are hidden). The QCR and Placement Slip will read the same fields.
- **RFQ** (`GET /{id}/rfq?format=xlsx|pdf`, `proposals.export`): the RFQ as Excel (default) or as an A4 PDF with
  the broker's letterhead. When the client's RFQ template is uploaded (see Document templates) the workbook is that
  file, filled; otherwise a built-in layout (premium details, schedule, Fire by location, Annexure, risk details,
  claim details). The `X-Document-Layout` header says which (`template` or `built-in`). `409
DATA_SHEET_INCOMPLETE` until nothing is missing. The product (BSUS, BLUS, SFSP or PAR) is listed for the insurer
  and chosen at the QCR. Each download is audited with its format.
- **Sent outside the app** (`POST /{id}/rfq/sent`, `proposals.send`): for an RFQ sent another way, records for which
  insurers it went, who and when, and the quote due date (`dueDate`, else the case's). No mail is logged.
- Once the first insurer has the RFQ (emailed or marked sent) the proposal moves to RFQ Sent and its Data Sheet locks
  (`409 PROPOSAL_LOCKED`), so every insurer quotes on the same figures.
- Client, location and insurer details are read live from the masters, so a corrected address shows on the next
  RFQ. Every change is audited with before and after values.

## RFQ email, insurer statuses and the mail log (E-2 to E-6)

- **Email templates** (`/api/v1/email-templates`; read `masters.view`, edit `masters.manage`): the RFQ and Reminder
  mails' subject and body, seeded with neutral wording at startup. Merge fields are `{{insuredName}}`,
  `{{policyPeriod}}`, `{{dueDate}}`, `{{reference}}`, `{{insurerName}}`, `{{contactName}}` and `{{senderName}}`; an
  unknown field or a stray `{{` or `}}` is a 400 naming it. Saving sends `expectedVersion` and fails with
  `409 TEMPLATE_VERSION_CONFLICT` when someone saved meanwhile. `renderMail()` in `src/shared/mail.ts` fills them for
  both the API and the web app's preview: values are escaped in the HTML part and the subject is one line.
- **Sending** (`POST /proposals/{id}/rfq/email`, `proposals.send`): `{ sendId, insurers: [{ insurerId, to }], dueDate,
format }`. One mail per insurer, To its chosen addresses only (its RFQ addresses and contacts' emails in the insurer
  master; anything else is a 400 and nothing is sent), never Cc or Bcc, Reply-To the sender, with the RFQ attached
  (xlsx or pdf, at most 10 MB, `422 RFQ_ATTACHMENT_TOO_LARGE`). Each insurer gets `SENT`, `FAILED` (with the reason;
  it stays Not sent, to try again) or `SKIPPED` (another send to it was in progress). Naming an insurer that already
  has the RFQ is a 409. Repeating a `sendId` mails nobody again and returns the first results.
  `POST /{id}/rfq/preview` returns the mails without sending.
- **Reminders** (`POST /{id}/insurers/{insurerId}/reminder`, `proposals.send`): the Reminder template to an insurer
  that is Sent or Reminded, the RFQ attached when `attachRfq`; it becomes Reminded and its count goes up. Manual
  only.
- **Responses** (`PUT /{id}/insurers/{insurerId}/response`, `proposals.edit`): Quoted, Declined or No response with an
  optional note. `canMoveInsurer()` in `src/shared/proposals.ts` holds the allowed changes; nothing goes back to Not
  sent. Each insurer also carries its due date, `overdue` (Sent or Reminded after the due date, India time), reminder
  count, last response and last mail.
- **Mail log** (`GET /{id}/mails`, `/mails/{mailId}`, `proposals.view`; `/mails/{mailId}/attachment`,
  `proposals.export`): every mail sent, kept in the outbox or failed, with To, subject, both bodies, the template
  version, the attachment (stored once in `mail_attachments` by SHA-256), the sender, the transport and the result.
  `mail_log` is append-only. Each mail also adds an activity line and an audit entry (`RFQ_EMAILED`,
  `RFQ_REMINDER_EMAILED` or `RFQ_EMAIL_FAILED`, with the insurer's status before and after).
- **Mail settings** (`GET /mail/status`, `settings.view`, never shows credentials):

  | Variable                     | Meaning                                                                                                                               |
  | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
  | `MAIL_TRANSPORT`             | `smtp` delivers; `outbox` keeps mails in the log only; `off` refuses (`409 MAIL_DISABLED`). Unset: `outbox`, but `off` in production. |
  | `MAIL_FROM`                  | The From address; required for smtp (outbox uses `rfq@outbox.invalid`).                                                               |
  | `SMTP_HOST`, `SMTP_PORT`     | Required for smtp.                                                                                                                    |
  | `SMTP_SECURE`                | `true` for TLS from the start (port 465); `false` (default) uses STARTTLS when offered.                                               |
  | `SMTP_USER`, `SMTP_PASSWORD` | Optional; the password needs the user. Never logged or returned.                                                                      |

  Mail goes out from the API process, one insurer after another, with no job queue. If the server stops after the
  mail server accepted a mail but before it was recorded, that insurer's claim expires after 10 minutes and a retry
  could mail it twice. Tests use a fake transport and never reach an SMTP server.

## The RFQ: versions and approval (R-1, R-2, R-5)

`/api/v1/proposals/{id}/rfq/...` (module `src/modules/rfq/`, contracts in `src/shared/rfq.ts`).

- **From the case** (R-1): premium details, schedule, risk details, claims, annexure and add-ons all come from the
  Data Sheet. In the client's template the schedule also carries each location's sum insured (several locations),
  hypothecation, stock kept in the open and the notes for insurers, under NOTE.
- **Edits** (R-2, `PUT /{id}/rfq/edits`, `proposals.edit`): the heading, the notes for insurers, risk details per
  location and the claims table can be changed on the RFQ only; the Data Sheet is untouched. `applyRfqEdits()` and
  `rfqTitleOf()` (shared) apply them the same way in the preview and the files.
- **Versions** (R-2, `POST /{id}/rfq/versions`): each generation is the next version (v1, v2, v3), keeping the Excel
  and PDF made then and the case as it was (`GET /{id}/rfq/versions/{v}`, `/file?format=`). A version whose case or
  edits changed since is "stale".
- **Approval** (R-5): the latest version is submitted (`proposals.edit`), then approved or returned with comments
  (`proposals.approve`); every step is kept with its comment, audited and on the case's activity.
- **Sending**: emailing the RFQ, marking it sent outside the app, and reminders that attach it need the latest
  version approved and not stale (409 `RFQ_NOT_APPROVED` otherwise); mails attach that version's stored file
  (`RFQ-PRP-2026-0001-v2.pdf`). `GET /{id}/rfq?format=` still downloads the RFQ as it is now, with the edits.

## Insurers' quotes (Q-1 to Q-5)

`/api/v1/proposals/{id}/quotes` and the routes under it (module `src/modules/quotes/`, contracts in
`src/shared/quotes.ts`). Reading needs `proposals.view`; recording `proposals.edit`.

- **Options**: an insurer quotes each option the RFQ asked for — a renewal's existing sum insured, Proposed Option 1,
  and Option 2 when the case has one (the RFQ's premium details blocks).
- **Entry** (Q-1, `POST /{id}/insurers/{insurerId}/quotes`): the premium of Fire (with and without terrorism) and of
  every other section included, optionally the sum insured the insurer quoted on. Net, GST at the case's own rate
  (kept from its creation) and total are worked out exactly to the paisa, with terrorism and, when Fire was quoted
  without it, without (`quoteTotals()`, shared with the web app).
- **Terms and deviations** (Q-2): each add-on and cover the RFQ asked for accepted or declined, deductibles,
  capacity %, conditions and validity date. `quoteDeviations()` lists where the quote departs from the RFQ: a section
  not quoted, a different sum insured, an add-on declined or not answered, capacity under 100%, validity ending
  before the policy starts.
- **Proof** (Q-3): the insurer's mail (.eml, .msg), a PDF or a picture of it is uploaded first
  (`POST /{id}/insurers/{insurerId}/quote-attachments?fileName=`, raw body up to 10 MB, type checked from the
  content; kept in `quote_attachments`), and every quote needs at least one attachment of its own insurer (400
  otherwise). `GET /{id}/quote-attachments/{attachmentId}` downloads one.
- **Versions** (Q-4): each save is a new, unchangeable version (collection `quotes`, unique per insurer, option and
  version); from the second on the reason is required. Every version is listed, newest first.
- **Declined** (Q-5): `PUT /{id}/insurers/{insurerId}/response` with `DECLINED` now needs the reason (`note`).
- **For the QCR**: `qcr` in the quotes response is each option's latest version from the insurers that have not
  declined. Recording a quote moves the insurer to Quoted. Every quote and upload is audited (`QUOTE_RECORDED`,
  `QUOTE_ATTACHMENT_UPLOADED`).

## The QCR (QC-1 to QC-6)

`/api/v1/proposals/{id}/qcr` (module `src/modules/qcr/`, contracts in `src/shared/qcr.ts`).

- **Comparison** (QC-1, QC-2): built each time from the case and the latest version of every quote: per option
  (a renewal's existing sum insured, Option 1, Option 2), the existing policy (last year's sums insured and the policy
  software's premiums) and up to five insurers that have not declined. As in the client's QCR, premiums compare Fire
  without terrorism (with terrorism when that is all an insurer quoted); net, GST at the case's rate and total come
  from the quote entries exactly. The lowest total of each option is marked (ties all marked); `differences` lists
  the topics where insurers differ (sections quoted, add-ons accepted, capacity, validity, deductibles, conditions).
- **Broker's part** (QC-3, `PUT /{id}/qcr`, `proposals.edit`): recommended insurer and option, recommendation,
  remarks, cheque / payment in favour of.
- **Approval** (QC-6, `POST /{id}/qcr/approve`, `proposals.approve`): approves the fingerprint the approver saw (409
  `QCR_CHANGED` if it changed, `QCR_INCOMPLETE` while a quote, the recommendation or the payment is missing). A new
  quote version or an edit afterwards voids it.
- **Export** (QC-4, QC-5, `GET /{id}/qcr/document?format=xlsx|pdf`, `proposals.export`): the client's QCR template
  (Masters → Document templates) filled in place — premium details as the comparison with net, GST and total as
  formulas carrying their values and the lowest total highlighted; payment, recommendation, remarks and coverage
  differences below; the terrorism note with the extra premium of the recommended quote; the schedule, annexure,
  risk details and add-on sheets as on the RFQ, plus each insurer's deductibles and conditions under Warranties /
  Conditions. Options no insurer quoted are hidden. Without the template, a built-in layout.
- **Send** (QC-6, `POST /{id}/qcr/email`, `proposals.send`): only an approved QCR unchanged since approval (409
  `QCR_NOT_APPROVED`), as one mail to the chosen addresses from the QCR email template (Email templates), with the
  QCR attached; logged in the case's mail log ("The insured") and audited.

## Client approval

`/api/v1/proposals/{id}/client-approval` (module `src/modules/client-approval/`, contracts in
`src/shared/client-approval.ts`).

- **Read** (`GET`, `proposals.view`): the approval recorded (null until then) with the premium kept and whether the
  accepted quote has a newer version since (`quoteCurrent`); the quotes the client can accept (each insurer and option
  the QCR compares, totals with and without terrorism, the QCR's recommendation and lowest marked); the files
  uploaded; the client's contacts; and `blocked`, why it cannot be recorded now.
- **Record** (`PUT`, `proposals.edit`): an insurer and option compared in the QCR; Fire with or without terrorism when
  it was quoted both ways; the date (not in the future); who confirmed; at least one file uploaded for it (the client's
  mail or signed letter, `POST /{id}/client-approval/files`, typed from its content like quote attachments). 409 until
  the QCR has gone to the insured, and once the case is placed or closed. The premium is kept as the quote stands.
  Moves the case to Client Approval when it is before it; it can be corrected (recorded again) until the case is
  placed. Audited (`CLIENT_APPROVAL_RECORDED`) with an activity line.
- **Stage**: Client Approval cannot be set with `POST /{id}/stage` until the approval is recorded.

## Placement slip

`/api/v1/proposals/{id}/placement-slip` (module `src/modules/placement-slip/`, contracts in
`src/shared/placement-slip.ts`).

- **Read** (`GET`, `proposals.view`): built each time from the quote the client accepted (the version and premium the
  client approval kept): the sections placed with the option's sum insured and the insurer's premium (Fire with or
  without terrorism as accepted), net, GST and total, capacity, deductibles and conditions; the broker's remarks; the
  approval; what still stops approval (the client approval, the client's Placement Slip format); the mails to the
  insurer; the policy or cover note recorded.
- **Remarks** (`PUT`, `proposals.edit`) and **approval** (`POST /approve`, `proposals.approve`): as the QCR — approval
  is for the fingerprint seen (409 `PLACEMENT_SLIP_CHANGED`, `PLACEMENT_SLIP_INCOMPLETE`); a change afterwards voids it.
- **Document** (`GET /document?format=xlsx|pdf`, `proposals.export`): the client's Placement Slip format (Masters →
  Document templates) filled in place: premium details for the insurer accepted (rows added for sections the format
  does not list, the others hidden), the schedule for the option accepted with the product placed, the agreed bank
  from the Data Sheet's hypothecation, the insurer's conditions and deductibles, the standard notes marked for the
  Placement Slip, and the annexure. The print areas are extended to the remarks and to the last schedule row.
- **Send** (`POST /email`, `proposals.send`): only an approved slip unchanged since (409
  `PLACEMENT_SLIP_NOT_APPROVED`), to the accepted insurer's chosen addresses from the Placement slip email template,
  logged in the mail log; moves the case to Placement Slip.
- **Placed** (`PUT /placed`, `proposals.edit`): the policy or cover note — kind, number, date, file(s) uploaded with
  `POST /files` — once the slip has gone to the insurer; moves the case to Placed; can be corrected.
- **Stage**: Placement Slip and Placed cannot be set with `POST /{id}/stage` until the slip is sent and the policy or
  cover note recorded.

## Lists across cases

`GET /api/v1/qcrs` and `GET /api/v1/placement-slips` (module `src/modules/worklists/`, `proposals.view`) back the
Quotes and QCR and Placement Slips pages: one row per open case, from the same QCR and placement slip its tabs show.

## Policy and cover masters (M-4 to M-9)

`/api/v1/catalog` holds eight masters, all data, none of it in the code. Their layouts (columns, rules) are in
`src/shared/catalog.ts`; rows are stored in the `catalog_items` collection, amounts and percentages as Decimal128. Screens, sheets and documents call the
`products` master **Policies**; its workbook sheet is "Policies", and a sheet still named "Products" (a workbook
downloaded before the rename) is read the same. The RFQ, QCR and placement slip print the client template's
"Product to be choosen" row as "Policy to be chosen", or "Policy" once one is chosen.

| Master (`{master}`)                             | What it holds                                                                            | Used by                                                                                                   |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Policies (`products`)                           | BSUS, BLUS, SFSP, PAR: sum insured above (exclusive) and up to (inclusive), add-on lists | Each proposal's suggested policies; the RFQ's policy lines; the add-on picker                             |
| Coverage sections (`sections`)                  | The 14 sections: name, order, on/off, schedule lines, add-on covers                      | Data Sheet and RFQ order and wording; RFQ add-on lines                                                    |
| Add-on covers (`addons`)                        | The Fire additional, PAR, SFSP and BSUS & BLUS lists; BSUS/BLUS type and limit           | Searchable reference                                                                                      |
| BSUS & BLUS rates (`addon-rules`)               | The 15 paid add-ons: limit and cap per scheme, calculation, rate factor and base         | `addon-premium.ts` (pure, not yet in a screen)                                                            |
| Tax rates (`tax-rates`)                         | GST rates with effective dates                                                           | Proposals (rate kept at creation), RFQ                                                                    |
| Standard notes (`notes`)                        | NOTE and disclaimer text, which documents print it, order                                | The RFQ export (notes marked "On RFQ")                                                                    |
| Clauses (`clauses`)                             | The clause library: heading, wording, sections it applies to, documents, order           | "Clauses to be attached" on the RFQ, QCR and Placement Slip (the template's own clauses until one exists) |
| Occupancy cover defaults (`occupancy-defaults`) | Per IIB TAC code: the sections to tick and the Fire add-ons Required / Not required      | New cases: the covers they start with (union over the case's occupancies)                                 |

- **Workbook**: `GET /catalog/workbook` returns every master in one .xlsx (an Instructions sheet, then a sheet per master
  with drop-downs). `POST /catalog/import` checks an upload (dry run by default); with `dryRun=false`, each sheet in the
  file replaces its master as a whole, in one transaction, only when every sheet passes. A sheet left out of the file
  leaves its master alone. Downloading and uploading unchanged gives the same rows.
- **On screen**: `GET /catalog/{master}` (any role), `POST` to add a row, `PUT /{master}/{id}` to edit,
  `PUT /{master}/order` to reorder products, sections and notes (Admins, `masters.manage`). Every change is audited
  (`CATALOG_IMPORTED`, `CATALOG_ITEM_CREATED`, `CATALOG_ITEM_UPDATED`) with old and new values.
- **Rules**: the 14 section codes are fixed (no adding, no code changes) and Fire is always on and first. A product's
  upper limit must be above its lower limit. Rows are unique by product code, section code, list + add-on name,
  add-on S No, tax + effective date and note code.
- **GST**: a proposal stores the rate in force (India date) when it is created and keeps it. Proposals created before
  the tax master read the rate in force on their creation date. Without any tax rate, `GST_RATE_PERCENT` is used.
- **Until uploaded**: proposals and the RFQ fall back to the client's RFQ wording (built-in section names and order,
  the four product lines, Fire add-ons) and suggest no product.

## Document templates (R-3, R-4)

The document engine fills the client's own Excel templates and draws them as PDF. The app ships no template: an
Admin uploads each one on the Document templates page (the copy in `data/client-formats/` is used only by tests).

- `GET /api/v1/templates` lists the documents (RFQ, QCR, Placement Slip) and the template stored for each;
  `GET /templates/{kind}/file` downloads it (`masters.view`). `POST /templates/{kind}?fileName=` uploads an .xlsx as
  the request body (`masters.manage`, up to 5 MB). An RFQ template is checked first: its sheets (premium details,
  schedule, risk details, claim details, Annexure) and the labels the filler looks for. A failed check returns the
  problems and stores nothing. Each upload replaces the last and is audited (`TEMPLATE_UPLOADED`).
- **Excel** (R-3): the uploaded file is filled in place with exceljs (`modules/documents/excel-template.ts`). Cells
  are found by the labels a person sees, not by address, so moving rows in the template still works. Sheet names,
  merged cells, formulas, column widths, print areas and the logo are kept; rows are added only where the case needs
  them (a seventh Fire line, more annexure items or products, the standard notes), and merges and print areas move
  with them. Excel recalculates the formulas when the file opens. The RFQ filler is
  `modules/proposals/rfq-template.ts`.
- **PDF** (R-4): `modules/documents/sheet-pdf.ts` draws each sheet's print area as a table with pdfmake (merges,
  borders, fills, alignment, Indian digit grouping) on A4 portrait. The letterhead is the template's logo and the
  broker's address; each page has a footer with the case number and "Page x of y".
- The QCR and Placement Slip templates are filled the same way (see their sections).

## Excel import

Clients, risk locations and insurers can be loaded from Excel (`/api/v1/imports`, the web app's Import data page).

- `GET /api/v1/imports/{entity}/template` returns the template: an Instructions sheet and the data sheet, with a note
  on each header, a State drop-down and text-formatted code columns. `?sample=true` fills it with fictional rows
  that pass the import. `entity` is `clients`, `client-locations` or `insurers`.
- `POST /api/v1/imports/{entity}` takes the filled-in .xlsx as the request body (up to 5 MB, 1,000 rows). By default
  it is a dry run (the preview) that returns every row with its values, Valid or Invalid, and its problems by
  column. With `?dryRun=false&rows=2,3,7` the chosen rows are saved in one transaction, each with its own audit
  entry (without `rows`, every valid row). Rows with problems are never saved; choosing one stops the import, so
  what is saved is exactly what the preview showed.
- Rows go through the same checks as the screens, plus duplicates: a GSTIN or company branch twice in the file or
  already saved, a client without a GSTIN whose name already exists, and a location name the client already has.
  So importing the same file twice saves nothing the second time.
- Risk locations find their client by GSTIN, or by exact name for a client without one. Import clients first.
- Files saved by other tools (Numbers, openpyxl, LibreOffice) are accepted: columns are found by header text, and
  cell notes are ignored, because exceljs cannot load notes some tools write. When a file still cannot be read,
  the API logs the underlying error with the request id.
- Templates and sample files are built on request (`GET /api/v1/imports/{entity}/template[?sample=true]`); none are
  kept in the repository. Sample names, people and emails are fictional; GSTINs use the placeholder PAN `ZZZZZ`,
  which no real taxpayer has, and the occupancy codes and pincodes are real entries of the IIB master.

## IIB master upload and download

The occupancy and pincode masters are versioned and edited in Excel, never in place:

- `POST /api/v1/masters/import` (Admin) takes the IIB workbook (sheets "IIB Code" and "Pincode", up to 20 MB). By
  default it is a dry run that returns the validation report. With `?dryRun=false` it saves both masters as new
  DRAFT versions (audited); `POST /api/v1/masters/versions/{id}/activate` makes them active and supersedes the
  previous ones, which are kept.
- `GET /api/v1/masters/workbook` returns the active masters in the same layout, to edit and upload as the next
  version (`?template=true` gives the headers only). The client's 299 occupancies and 20,606 pincodes round-trip
  unchanged.
- Admins can also correct the active master on screen: `POST /api/v1/masters/occupancies`,
  `PATCH /api/v1/masters/occupancies/{tacCode}`, `POST /api/v1/masters/pincodes` and
  `PATCH /api/v1/masters/pincodes/{pincode}`. Each change applies at once and is audited with every field's old and
  new value. `GET /api/v1/masters/pincodes` lists pincodes (search by pincode prefix, district or state).
- The same file uploaded again creates nothing while its versions are draft or active; once superseded it uploads
  as a new draft, which is how an older master is restored.

## Employee Benefits: GMC, GPA and GTLI (N1 to N3)

GMC is the existing group health case (`/api/v1/ghi`, unchanged apart from optional additions). GPA and GTLI cases
use the same collections with a `product` field and their own routes, `/api/v1/eb/gpa/...` and
`/api/v1/eb/gtli/...`, whose paths mirror the GHI ones. Their stages are Data Sheet → RFQ → QCR → Approval (the
client's decision is recorded here) → Payment → Placement Slip; issuing the slip places the case and freezes its
census, plan copy and agreed premium in an append-only snapshot. An id of another product or company answers 404.

- **Data Sheets** (`src/shared/eb-requirements.ts`): GPA asks the sum insured basis (flat, graded or a multiple of
  salary with an optional cap), the four covers (Required / Not required), temporary total disablement terms and how
  dependants' sums insured are set; GTLI asks the employee count, the basis and the free cover limit (flagged, not
  enforced). Strict objects: a field of GMC or of the other product is refused.
- **Family Plan Master** (`/api/v1/family-plans`, `src/modules/family-plans/`): plans per product with Draft and
  Active versions (slots, relationships, maximums, required minimums, the parents / parents-in-law mixing rule, dates
  that never overlap). Every rule is checked at once by `PlanVersionInputSchema`. Plans are never deleted; a plan can
  be deactivated after the open cases using it are listed. Seven default plans are created at startup, each awaiting
  client confirmation. A case keeps a copy of its plan version (`PUT .../cases/:id/plan`), so later versions never
  change it; a company can set a default plan per product.
- **Shared employee identity** (`src/modules/employees/`): one identity per company and employee ID, shared by the
  company's GMC, GPA and GTLI Self members; a row that disagrees with it is refused, and members of one ID that
  disagree are "unresolved" until a user resolves them on the company page.
- **Census** (`src/shared/eb-census-rules.ts`, the pure Census_Validator): families are checked against the case's
  plan (slots, relationship maximums, mixing, a dependant needs its Self row, duplicates), ages, genders and sums
  insured against the Data Sheet. Seven provisional templates (`GET /api/v1/eb/census-templates`); upload, preview by
  mode, row corrections, an error report, and an import by policy (All valid / Valid only) and mode (Add new only /
  Add and update) in one transaction. Re-importing the same rows changes nothing. Manual members get the same checks.
  Dates are day first (DD/MM/YYYY) or Excel dates.

| Routes                                                                       | Permission          |
| ---------------------------------------------------------------------------- | ------------------- |
| `GET /eb/cases`, `GET /eb/{gpa,gtli}/cases/:id` and every case read          | `proposals.view`    |
| `GET /eb/census-templates`, `GET /eb/companies/:clientId/employees`          | `proposals.view`    |
| `POST /eb/cases`                                                             | `proposals.create`  |
| Case edits: Data Sheet, plan, insurers, members, imports, quotes, QCR drafts | `proposals.edit`    |
| Client decision, payments, issuing the placement slip, files                 | `proposals.edit`    |
| `POST /eb/companies/:clientId/employees/resolve`, `PUT .../employees/:id`    | `proposals.edit`    |
| RFQ and QCR decisions                                                        | `proposals.approve` |
| RFQ and QCR mail, marking the RFQ sent                                       | `proposals.send`    |
| RFQ, QCR and placement slip documents                                        | `proposals.export`  |
| `GET /family-plans`, `GET /family-plans/:planId`                             | `masters.view`      |
| Every family plan change, `GET /family-plans/:planId/open-cases`             | `masters.manage`    |
| `GET /eb/companies/:clientId/plan-defaults`                                  | `clients.view`      |
| `PUT /eb/companies/:clientId/plan-defaults/:product`                         | `clients.manage`    |

The open questions, the provisional templates, the default plans and the design points to confirm are in
`docs/OPEN_ITEMS.md` (Employee Benefits).

## Age bands, GPA rules, GTLI sum assured and the RFQ selection summary (N4 to N7)

- **Age Band Master** (`/api/v1/age-bands`, `src/modules/age-bands/`): named sets of bands checked by
  `AgeBandSetInputSchema` (increasing, no overlap, no gap). A case takes a copy of a set (`PUT …/cases/{id}/age-bands`);
  the census summary, the RFQ and the selection summary follow it. Ages are completed years on the case's reference
  date; members outside the bands or without a valid date of birth are reported, never put in a band.
- **GPA cover by relationship** (`BY_RELATIONSHIP` dependant basis): a percentage, a fixed amount, the employee's
  amount or the member's own, per relationship; worked out by the Census_Validator (`memberCoverage`), with the basis
  shown beside each amount.
- **GTLI (and GPA) salary input**: annual salary, or monthly salary with annual CTC = monthly × 12; sum assured =
  annual CTC × multiplier, half up, capped at the optional maximum (Decimal in the API, BigInt in the web app).
- **Nominees**: one per member (name, relationship, date of birth or age), required as the Data Sheet says.
- **RFQ Selection Summary Sheet** (`src/shared/rfq-summary.ts`, `selection-summary.service.ts`): employees and lives
  by cover, the age band × cover matrix, gender and relationship counts, cover by relationship. Preview, Excel and
  PDF; added to each RFQ version, which keeps its copy.

| Routes                                                                             | Permission         |
| ---------------------------------------------------------------------------------- | ------------------ |
| `GET /age-bands`, `GET /age-bands/:setId`, `GET /age-bands/:setId/cases`           | `masters.view`     |
| `POST /age-bands`, `PUT /age-bands/:setId`, `POST …/activate`, `…/deactivate`      | `masters.manage`   |
| `PUT /{ghi,eb/gpa,eb/gtli}/cases/:id/age-bands`                                    | `proposals.edit`   |
| `GET …/cases/:id/rfq/selection-summary`, `…/rfq/versions/:rfqId/selection-summary` | `proposals.view`   |
| `GET …/cases/:id/rfq/selection-summary/document`                                   | `proposals.export` |

Open questions and decisions: `docs/OPEN_ITEMS.md` (N4 to N7).

## TPA claims, claims board, claims analysis and renewal analysis (N8 to N12)

- **TPA formats** (`/api/v1/tpa/formats`, `src/modules/tpa/`): per TPA layout, the column of each field, how each
  TPA status counts (an unmapped status is a row error, never a guess), and which board column each status puts a
  claim in (per company over it; forward-only by default).
- **Imports**: upload (`POST /tpa/imports`, raw `.xlsx` body, at most 25 MB and 50,000 rows) checks every row and keeps
  the result per row; the preview, the problems report and the import (all rows, or the valid rows only) follow. Claims
  are keyed by policy, TPA code and claim ID: re-importing updates them and records each change in
  `tpa_claim_events`; unchanged rows write nothing. One import per policy and TPA at a time (unique partial index).
  Workbooks are read row by row with ExcelJS after `tpa-workbook.ts` puts the parts in a safe order.
- **Claims board** (`tpa-board.service.ts`): an import links each claim to the board claim of the same patient and
  admission date, moves it forward to the mapped column, records the TPA settlement apart from the column, and adds a
  placed GMC claim that is not on the board. Import emails are off until the client approves (`/tpa/settings`).
- **Claims analysis** (`src/modules/claims-analysis/`, `src/shared/claims-analysis.ts`): status, members, gender,
  relationship, age bands, claim type, ICD-10 chapters, and the ICR on the prorated and the total premium (placed
  premium ± endorsements). Money is BigInt paise, rounded half up.
- **Renewal analysis** (`src/modules/renewal/`, `src/shared/renewal-analysis.ts`): up to three policy years (placed in
  the app, or recorded by hand), changes between years, the coming year's quotes; saved reports never change.
- **Sensitive data**: diagnosis, ICD code and rejection reason only for `claims.process`; full bank accounts only for
  `claims.admin` (masked otherwise); board claims hide the patient's date of birth and the phone from users without
  `claims.process`. Views and downloads of claim data are audited, refusals too (`CLAIM_ACCESS_DENIED`); no audit
  entry holds a diagnosis, bank account or phone number.

| Routes                                                                                                     | Permission         |
| ---------------------------------------------------------------------------------------------------------- | ------------------ |
| `GET /tpa/policies`, `GET /tpa/claims`, `GET /tpa/claims/:claimId`, `…/history`                            | `claims.view`      |
| `GET /tpa/formats`, `GET /tpa/formats/:formatId`, `POST /tpa/inspect`                                      | `claims.process`   |
| `GET/POST /tpa/imports`, `GET /tpa/imports/:importId`, `…/rows`, `…/error-report`, `…/commit`, `…/discard` | `claims.process`   |
| `PUT /tpa/claims/:claimId/link`                                                                            | `claims.process`   |
| `POST/PUT /tpa/formats…`, `…/activate`, `…/deactivate`, `GET/PUT /tpa/settings`                            | `claims.admin`     |
| `GET /claims-analysis`, `GET /claims-analysis/document`, `GET /claims-analysis/premium/:caseId`            | `claims.view`      |
| `POST /claims-analysis/premium/:caseId`, `…/:adjustmentId/void`                                            | `proposals.edit`   |
| `GET /renewal/options`, `POST /renewal/analysis`, `GET /renewal/years`, `GET /renewal/reports…`            | `proposals.view`   |
| `POST/PUT /renewal/years…`, `POST /renewal/reports`                                                        | `proposals.edit`   |
| `POST /renewal/analysis/document`, `GET /renewal/reports/:reportId/document`                               | `proposals.export` |

Open questions, decisions and what is BLOCKED on client files: `docs/OPEN_ITEMS.md` (N8 to N13).

## Security notes

- Passwords are hashed with argon2id (12-character minimum). Every sign-in failure returns the same error; 5 failures
  lock the account for 15 minutes; there is also a per-IP rate limit (in memory, so use a shared store if you run
  several instances).
- The user is re-read on every request, so deactivation and role changes apply immediately. Tokens are stateless (no
  refresh tokens yet) and last `JWT_EXPIRES_IN_SECONDS`.
- Browsers never call this API with a token they can read: the frontend keeps the JWT in an httpOnly cookie and adds
  it server-side. Keep `CORS_ORIGIN` to the frontend's origin.
- `/api/docs`, `/api/openapi.json` and `/api/v1/health` are public. Restrict them at the edge in production if needed.
- The Docker MongoDB has no authentication and listens on 127.0.0.1 only. Use authenticated MongoDB (for example
  Atlas in ap-south-1) outside local development.
- Behind a proxy or the frontend server, set `TRUST_PROXY` so the per-IP limit sees the real client address.

## Troubleshooting

- `npm install` fails with `EACCES` under `~/.npm`: the npm cache has root-owned files. Fix it once with
  `sudo chown -R "$(id -u):$(id -g)" ~/.npm`.
- "Invalid environment configuration": the message lists each missing or invalid variable; compare with
  `.env.example`.
- "Transaction numbers are only allowed on a replica set member": MongoDB is not running as a replica set. Use
  `docker compose up -d` and wait until the container is healthy.
