# Fiducial backend

Express API for the Property Insurance Placement ERP that Spirezen Enterprises is building for Fiducial. The ERP will
replace the Excel chain of Data Sheet → RFQ → insurer quotes → QCR → Placement Slip.

This repository holds the **foundation**: authentication, role-based permissions, user admin, an append-only audit log with a read API, IIB
occupancy and pincode masters with a validated import, and the Fire rating check. The web app lives in the separate
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

# Import the IIB workbook, print the validation report and activate it
npm run import:masters -- data/IIB_Code_Master.xlsx --activate

npm run dev                   # http://localhost:4000
```

Then start the web app from Fiducial_frontend and sign in at http://localhost:3000.

Without `--activate`, the import creates DRAFT versions that an admin activates later
(`POST /api/v1/masters/versions/{id}/activate`). Running the same file again does nothing unless you pass `--force`.

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
  modules/              auth, users, audit, masters (with import/), rating, health
  scripts/              seed-admin.ts, import-masters.ts
  shared/               API contracts (Zod schemas, enums, formatters), copied to the frontend
test/                   Supertest integration tests and helpers
data/                   IIB workbook and the client's Excel formats (read-only inputs)
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
- **Audit**: sign-ins (success and failure), sign-outs, user creates and edits, master imports, activations and the
  versions they supersede are written to the append-only `audit_logs` collection, in the same transaction as the
  change. Each entry keeps the record's fields before and after, so `GET /api/v1/audit` (Admin) can show who changed
  what, when, and each field's old and new value. It filters by kind (sign-in, create, edit, approve, send, export),
  by record and by who acted. Nothing is sent or exported yet; those entries arrive with RFQ email and document
  export.
- **Roles and permissions**: each route needs one permission (`requirePermission()`), and
  `src/shared/permissions.ts` maps roles to permissions for both repos:

  | Permission                                                      | Admin | Approver | Relationship Manager | Underwriting / Placement | Read-only |
  | --------------------------------------------------------------- | ----- | -------- | -------------------- | ------------------------ | --------- |
  | `proposals.view`, `masters.view`                                | yes   | yes      | yes                  | yes                      | yes       |
  | `rating.use`, `proposals.export`                                | yes   | yes      | yes                  | yes                      |           |
  | `proposals.edit`, `proposals.send`                              | yes   |          | yes                  | yes                      |           |
  | `proposals.create`                                              | yes   |          | yes                  |                          |           |
  | `proposals.approve`                                             | yes   | yes      |                      |                          |           |
  | `masters.manage`, `users.manage`, `settings.view`, `audit.view` | yes   |          |                      |                          |           |

  The role codes are `ADMIN`, `MANAGER` (Approver), `ACCOUNT_MANAGER` (Relationship Manager), `PLACEMENT_EXEC`
  (Underwriting / Placement) and `READ_ONLY`. A user with several roles holds the union. The proposal permissions
  guard the web app's screens until the proposals API exists. The client still has to confirm the table (see
  `docs/OPEN_ITEMS.md`).

- Every endpoint is documented with `documentRoute()` next to its route.

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
