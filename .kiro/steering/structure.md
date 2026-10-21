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
    claims/              group health claims (C1 to C4): claims, documents, append-only events, status moves
                         with remarks, email outbox and worker (claim-notifications.ts), templates, HR contacts,
                         employee submission links (public routes in claim-links.routes.ts)
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
    ghi/                 group health insurance (G1 to G7), beside Property: cases and Data Sheet, census
                         (census-rules.ts and census-summary.ts, pure), census template and import, RFQ versions
                         and mails, quotes and QCR (ghi-quote-calc.ts, pure), final QCR, payments, placement slip,
                         policy; documents described once (ghi-sheet.ts) for Excel, PDF and preview
                         Employee Benefits beside it: products/ (CaseScope for GMC, GPA, GTLI; gmc.ts), eb-*.service.ts
                         (GPA/GTLI cases, quotes, QCR, client decision, payments, placement and snapshots), the
                         Census_Validator wiring (eb-census-context.ts), eb-census-import.service.ts and
                         eb-census-template.ts (seven provisional templates, error report), eb-product.routes.ts
                         (/eb/gpa, /eb/gtli) and eb.routes.ts (/eb lists, templates, company employees, defaults)
                         N7: selection-summary.service.ts and selection-summary-document.ts (the RFQ Selection
                         Summary Sheet), case-configuration.routes.ts (age bands and summary on every product)
    age-bands/           Age Band Master (N4): sets, default sets at startup, case-bands.ts (a case's copy)
    tpa/                 TPA claims (N9, N11): formats, streamed workbook reading (tpa-workbook.ts), imports with
                         per-row checks and batched commit, tpa_claims and their events, board sync
                         (tpa-board.service.ts) and import email settings, /tpa routes
    insured-policies/    a placed policy's facts for reports (GMC policy and final quote; GPA/GTLI snapshot)
    claims-analysis/     claims analysis (N10) and its Excel/PDF, endorsement premiums; analysis.routes.ts also
                         mounts the renewal routes
    renewal/             renewal benefit and cost analysis (N8): recorded years, saved reports, Excel/PDF
    family-plans/        Family Plan Master (N2): versioned plans, default plans at startup (default-plans.ts),
                         company default plans, /family-plans routes
    employees/           shared employee identity (N1/N3): identities per company and employee key, linking at
                         startup (employee-link.ts), update and resolve
    imports/             Excel templates, sample rows, per-row preview and import of chosen valid rows
    rating/              calculateFire() (pure), extension points, POST /rating/fire
    health/
  scripts/               seed-admin.ts, import-masters.ts, write-import-samples.ts
  shared/                Zod schemas, enums, types, formatters (copied to Fiducial_frontend); Employee Benefits:
                         eb*.ts (products, Data Sheets, quotes, workflow, census, eb-census-rules.ts the pure
                         Census_Validator, eb-import-plan.ts, eb-money.ts BigInt money), family-plans.ts,
                         age-bands.ts, eb-nominees.ts, rfq-summary.ts (N4 to N7); tpa-claims.ts, icd.ts,
                         claims-analysis.ts, renewal-analysis.ts, masking.ts (N8 to N12)
test/                    Supertest integration tests and helpers (setup/ starts the in-memory replica set)
data/client-formats/     the client's blank Excel formats (reference only; no data is kept in the repo)
docs/                    project PDFs and OPEN_ITEMS.md
```

- A feature is a folder under `src/modules/` with its model, service, routes (plus OpenAPI registration) and mapper.
- Unit tests sit next to the code (`*.test.ts`); API integration tests are in `test/`.
