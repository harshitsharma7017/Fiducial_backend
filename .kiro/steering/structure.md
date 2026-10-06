# Structure (backend)

```
src/
  server.ts              starts HTTP server and DB, graceful shutdown
  app.ts                 builds the Express app (used by tests without listening)
  config/env.ts          Zod-validated environment
  lib/                   logger, errors (AppError), decimal, db, openapi, text (regex escaping, sort keys)
  middleware/            requestId, auth, requirePermission, validate (route helper), errorHandler, notFound
  modules/
    auth/                login, me, logout, lockout, JWT, argon2
    users/               admin user management
    audit/               append-only audit model, writeAudit() and GET /audit (field-level changes)
    masters/             versions, occupancies, pincodes; import/ parses and validates the IIB workbook and
                         writes it back out (iib-export.ts); upload and download in master-workbook.service.ts
    clients/             client master (M-1) and risk locations (M-2, own collection)
    insurers/            insurer master (M-3): branches, contacts, RFQ emails
    imports/             Excel templates, sample rows, per-row preview and import of chosen valid rows
    rating/              calculateFire() (pure), extension points, POST /rating/fire
    health/
  scripts/               seed-admin.ts, import-masters.ts, write-import-samples.ts
  shared/                Zod schemas, enums, types, formatters (copied to Fiducial_frontend)
test/                    Supertest integration tests and helpers (setup/ starts the in-memory replica set)
data/client-formats/     the client's blank Excel formats (reference only; no data is kept in the repo)
docs/                    project PDFs and OPEN_ITEMS.md
```

- A feature is a folder under `src/modules/` with its model, service, routes (plus OpenAPI registration) and mapper.
- Unit tests sit next to the code (`*.test.ts`); API integration tests are in `test/`.
