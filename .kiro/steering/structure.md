# Structure (backend)

```
src/
  server.ts              starts HTTP server and DB, graceful shutdown
  app.ts                 builds the Express app (used by tests without listening)
  config/env.ts          Zod-validated environment
  lib/                   logger, errors (AppError), decimal, db, openapi
  middleware/            requestId, auth, requireRole, validate (route helper), errorHandler, notFound
  modules/
    auth/                login, me, logout, lockout, JWT, argon2
    users/               admin user management
    audit/               append-only audit model and writeAudit()
    masters/             versions, occupancies, pincodes; import/ parses and validates the IIB workbook
    rating/              calculateFire() (pure), extension points, POST /rating/fire
    health/
  scripts/               seed-admin.ts, import-masters.ts
  shared/                Zod schemas, enums, types, formatters (copied to Fiducial_frontend)
test/                    Supertest integration tests and helpers (setup/ starts the in-memory replica set)
data/                    IIB workbook and client formats (read-only inputs)
docs/                    project PDFs and OPEN_ITEMS.md
```

- A feature is a folder under `src/modules/` with its model, service, routes (plus OpenAPI registration) and mapper.
- Unit tests sit next to the code (`*.test.ts`); API integration tests are in `test/`.
