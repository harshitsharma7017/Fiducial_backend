# Tech (backend)

## Stack (pinned exact versions)

- Node.js 24 LTS (`.nvmrc`), TypeScript 6.0 (`strict`), ESM.
- Express 5, Zod 4, Mongoose 9 on MongoDB 7 (single-node replica set), pino + pino-http, helmet, cors,
  express-rate-limit, argon2, jose (JWT), decimal.js, exceljs, nodemailer, zod-to-openapi + Swagger UI.
- Tests: Vitest 5, Supertest, `MongoMemoryReplSet` (mongodb-memory-server).
- Tooling: ESLint 10 (flat config, type-aware), Prettier, Husky + lint-staged, GitHub Actions.

## Commands

`npm run dev` · `npm run lint` · `npm run typecheck` · `npm test` · `npm run build` · `npm run seed:admin` ·
`npm run import:masters -- <file> [--activate]` (operators; masters are normally uploaded in the app)

## Conventions

- **Money and rates are never floats.** Use `Decimal` from `src/lib/decimal.ts` (ROUND_HALF_UP) and `Decimal128` in
  MongoDB. They travel in JSON as strings; amounts have 2 decimals.
- **Validate every input with strict Zod schemas** via `route({ params, query, body }, handler)` in
  `src/middleware/validate.ts`. Never pass `req.body` or `req.query` into a Mongo filter.
- **Contracts live in `src/shared/`** and are the source of truth for the frontend's copy. Add request and response
  schemas there, not inline. After changing them, run `npm run shared:sync` in Fiducial_frontend.
- **Errors** are `{ message, code, details? }`; throw the `AppError` helpers from `src/lib/errors.ts`.
- **Document every endpoint** with `documentRoute()` next to the route (OpenAPI at `/api/docs`).
- **Permissions**: guard every non-public route with `requirePermission('<area>.<action>')` after `authenticate()`.
  Roles map to permissions only in `src/shared/permissions.ts`; never check a role code in a route.
- **Audit** every create, edit, approve, send and export with `writeAudit()`; pass the transaction session so the
  change and its audit entry commit together. Add the action to `src/shared/audit.ts` with a kind and a label, and
  snapshot the same fields in `before` and `after` (null `before` for a create) so the log shows each field's old and
  new value. Never put secrets (password hashes, tokens) in a snapshot. `audit_logs` is append-only.
- **Masters**: read through `getActiveVersion()`; rows change only by an Admin's audited correction
  of the ACTIVE version (`master-rows.service.ts`: old and new values in the audit log) or by uploading a new version;
  never edit a DRAFT's or SUPERSEDED version's rows.
- **Mail**: send only through the `MailTransport` passed to `createApp()` (`src/modules/mail/transport.ts`); tests
  inject `FakeTransport` (`test/helpers/mail.ts`) and never reach an SMTP server. One mail per insurer, To its own
  addresses from the insurer master only: never Cc or Bcc, never an address typed by a user. Header values go through
  `headerValue()`; SMTP errors become a reason without credentials. Log every mail in `mail_log` (append-only).
- **Runtime**: Node runs the TypeScript directly (type stripping), so use erasable syntax only (no enums or
  namespaces), `import type` for types and `.ts` extensions in relative imports.
