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
    proposals/           new business to the RFQ: Data Sheet, completeness (proposal-calc.ts, pure), insurers,
                         RFQ workbook (rfq-workbook.ts built-in, rfq-template.ts fills the client's template,
                         rfq-document.ts picks one and the format), marking it sent; per-year reference counter;
                         rfq-mail.service.ts (preview, send, remind), insurer-status.ts (responses)
    rfq/                 the RFQ's edits, versions (files and case kept per version) and approval;
                         rfq-approval.ts decides whether it may be sent
    qcr/                 the QCR (QC-1 to QC-6): qcr-build.ts (comparison, pure), qcr-template.ts (fills the
                         client's QCR), qcr-workbook.ts (built-in), approval by fingerprint, mail to the insured
    quotes/              insurers' quotes (Q-1 to Q-5): versions per insurer and option, attachments (mail or PDF
                         as proof), totals and deviations from shared/quotes.ts, what the QCR takes
    documents/           document engine: uploaded templates (one per kind), excel-template.ts (find by label,
                         insert rows keeping merges and print areas), sheet-pdf.ts (sheet to A4 PDF, letterhead)
    email-templates/     RFQ and Reminder email templates: model, default wording (seeded at startup), routes
    mail/                transport.ts (smtp via nodemailer, outbox, off), mail_log (append-only) and
                         mail_attachments models, the mail log reads, GET /mail/status
    catalog/             product and cover masters (M-4 to M-9): one collection, a workbook of a sheet per
                         master, row edits and reorder; addon-premium.ts prices BSUS/BLUS add-ons (pure)
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
