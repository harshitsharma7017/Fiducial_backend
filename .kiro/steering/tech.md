# Tech (backend)

## Stack (pinned exact versions)

- Node.js 24 LTS (`.nvmrc`), TypeScript 6.0 (`strict`), ESM.
- Express 5, Zod 4, Mongoose 9 on MongoDB 7 (single-node replica set), pino + pino-http, helmet, cors,
  express-rate-limit, argon2, jose (JWT), decimal.js, exceljs, zod-to-openapi + Swagger UI.
- Tests: Vitest 5, Supertest, `MongoMemoryReplSet` (mongodb-memory-server).
- Tooling: ESLint 10 (flat config, type-aware), Prettier, Husky + lint-staged, GitHub Actions.

## Commands

`npm run dev` · `npm run lint` · `npm run typecheck` · `npm test` · `npm run build` · `npm run seed:admin` ·
`npm run import:masters -- <file> [--activate]`

## Conventions

- **Money and rates are never floats.** Use `Decimal` from `src/lib/decimal.ts` (ROUND_HALF_UP) and `Decimal128` in
  MongoDB. They travel in JSON as strings; amounts have 2 decimals.
- **Validate every input with strict Zod schemas** via `route({ params, query, body }, handler)` in
  `src/middleware/validate.ts`. Never pass `req.body` or `req.query` into a Mongo filter.
- **Contracts live in `src/shared/`** and are the source of truth for the frontend's copy. Add request and response
  schemas there, not inline. After changing them, run `npm run shared:sync` in Fiducial_frontend.
- **Errors** are `{ message, code, details? }`; throw the `AppError` helpers from `src/lib/errors.ts`.
- **Document every endpoint** with `documentRoute()` next to the route (OpenAPI at `/api/docs`).
- **Audit** with `writeAudit()`; pass the transaction session so the change and its audit entry commit together.
  `audit_logs` is append-only.
- **Masters**: read through `getActiveVersion()`; never modify an imported version's rows.
- **Runtime**: Node runs the TypeScript directly (type stripping), so use erasable syntax only (no enums or
  namespaces), `import type` for types and `.ts` extensions in relative imports.
