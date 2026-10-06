# Fiducial backend

Express API for **Fiducial**, the property insurance placement platform that Spirezen Enterprises is building for
Fiducial Insurance Brokers. It will replace the Excel chain of Data Sheet → RFQ → insurer quotes → QCR → Placement
Slip.

This repository holds the **foundation**: authentication, role-based permissions, user admin, an append-only audit log with a read API, IIB
occupancy and pincode masters with a validated import, the client master with any number of risk locations per
client, the insurer master with the email addresses RFQs go to, and the Fire rating check. The web app lives in the separate
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
   **Save as new version**, then **Activate**. Lookups, client and location forms and the Fire rate check read the
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

| Command                                   | Does                                                                    |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| `npm run dev`                             | Runs the API with `node --watch` (Node runs the TypeScript directly)    |
| `npm run build` / `npm start`             | Compiles to `dist/` / runs the compiled API                             |
| `npm run lint`                            | ESLint (type-aware) and a Prettier check                                |
| `npm run typecheck`                       | `tsc --noEmit`                                                          |
| `npm test`                                | Vitest; integration tests use an in-memory MongoDB replica set          |
| `npm run seed:admin`                      | Creates the first admin from `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` |
| `npm run import:masters -- <file> [opts]` | `--activate`, `--effective-from YYYY-MM-DD`, `--by EMAIL`, `--force`    |
| `npm run format`                          | Prettier write                                                          |

The first `npm test` downloads a MongoDB 7.0.43 binary (about 70 MB) for `mongodb-memory-server`.

## Layout

```
src/
  server.ts, app.ts     HTTP server and the Express app
  config/               Zod-validated environment
  lib/                  logger, errors, decimal helpers, db, OpenAPI registry
  middleware/           request id, auth, permissions, validation, error handling
  modules/              auth, users, audit, masters (with import/), clients, insurers, imports, rating, health
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
  transaction. Lookups and ratings read only the ACTIVE version, and each rating returns the versions and values used.
- **Audit**: sign-ins (success and failure), sign-outs, user creates and edits, client, risk location and insurer
  creates and edits, master imports, activations and the versions they supersede are written to the append-only `audit_logs` collection, in the same transaction as the
  change. Each entry keeps the record's fields before and after, so `GET /api/v1/audit` (Admin) can show who changed
  what, when, and each field's old and new value. It filters by kind (sign-in, create, edit, approve, send, export),
  by record and by who acted. Nothing is sent or exported yet; those entries arrive with RFQ email and document
  export.
- **Roles and permissions**: each route needs one permission (`requirePermission()`), and
  `src/shared/permissions.ts` maps roles to permissions for both repos:

  | Permission                                                      | Admin | Approver | Relationship Manager | Underwriting / Placement | Read-only |
  | --------------------------------------------------------------- | ----- | -------- | -------------------- | ------------------------ | --------- |
  | `proposals.view`, `clients.view`, `masters.view`                | yes   | yes      | yes                  | yes                      | yes       |
  | `rating.use`, `proposals.export`                                | yes   | yes      | yes                  | yes                      |           |
  | `proposals.edit`, `proposals.send`                              | yes   |          | yes                  | yes                      |           |
  | `proposals.create`, `clients.manage`                            | yes   |          | yes                  |                          |           |
  | `proposals.approve`                                             | yes   | yes      |                      |                          |           |
  | `masters.manage`, `users.manage`, `settings.view`, `audit.view` | yes   |          |                      |                          |           |

  The role codes are `ADMIN`, `MANAGER` (Approver), `ACCOUNT_MANAGER` (Relationship Manager), `PLACEMENT_EXEC`
  (Underwriting / Placement) and `READ_ONLY`. A user with several roles holds the union. The proposal permissions
  guard the web app's screens until the proposals API exists. The client still has to confirm the table (see
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
