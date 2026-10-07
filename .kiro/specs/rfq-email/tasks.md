# Implementation plan: RFQ email, insurer tracking and mail log

The work is in six slices: four in the backend, then two in the frontend. After each task, run `npm run lint`,
`npm run typecheck` and `npm test` in the repo you changed, and fix every problem before the next task. Each slice
ends with a checkpoint that adds `npm run build`; frontend checkpoints also run `npm run shared:check`.

Install packages with exact versions (`--save-exact`), after confirming the version exists on npm. If one does not
resolve, stop and ask. Contracts change only in `Fiducial_backend/src/shared`; run `npm run shared:sync` in the
frontend afterwards. Do not commit.

- [x] 1. Shared contracts (backend)
- [x] 1.1 Mail templates and rendering
  - `src/shared/mail.ts`:
    - template kinds, merge fields and labels
    - `parseTemplate()`, `renderMail()` and `mergeValuesFor()`
    - the template, send, preview, reminder, result, mail log and mail status schemas
  - Export it from `src/shared/index.ts`.
  - _Requirements: 1.4, 1.5, 2.1-2.5, 12.2_
- [x] 1.2 Insurer statuses
  - In `src/shared/proposals.ts`:
    - add `INSURER_STATUSES`, the labels, `RESPONSE_STATUSES`, `hasRfq()`, `canMoveInsurer()` and `isOverdue()`
    - extend `ProposalInsurerSchema` (design.md, Shared: proposals.ts)
    - add `RecordInsurerResponseRequestSchema`
    - add the optional `dueDate` to `MarkRfqSentRequestSchema`
  - _Requirements: 7.2, 7.6, 8.4, 11.2_
- [x] 1.3 Audit vocabulary and error codes
  - In `src/shared/audit.ts`, add `RFQ_EMAILED`, `RFQ_REMINDER_EMAILED`, `RFQ_EMAIL_FAILED`,
    `INSURER_RESPONSE_RECORDED` and `EMAIL_TEMPLATE_UPDATED`, with kinds and labels, and the `email_template` entity.
  - Add `MAIL_DISABLED`, `RFQ_ATTACHMENT_TOO_LARGE` and `TEMPLATE_VERSION_CONFLICT` to the error codes.
  - _Requirements: 1.8, 7.4, 10.5_
- [x] 1.4 Property tests for the shared logic
  - No new dependency: generated cases come from a seeded generator in the test file, so a failure reproduces from
    its seed.
  - Write tests for properties 1, 2, 3, 4 and 8, each tagged `// Feature: rfq-email, Property N: <name>`, plus example
    tests for `mergeValuesFor()`. Cover the policy period with and without a start or end, and the empty contact name.
  - _Requirements: 2.1-2.4, 7.2, 7.6_
- [x] 1.5 Checkpoint: lint, typecheck, test and build pass in the backend.

- [x] 2. Templates and transport (backend)
- [x] 2.1 Email templates module
  - `src/modules/email-templates/`:
    - model, default wording and `ensureEmailTemplates()` (called at startup after `ensureIndexes()`)
    - service with optimistic `expectedVersion` saving, audited in the same transaction
    - routes: GET `/email-templates` (`masters.view`) and PUT `/email-templates/{kind}` (`masters.manage`), with
      OpenAPI
  - Register the model in `src/models.ts` and mount the router in `app.ts`.
  - _Requirements: 1.1-1.3, 1.5, 1.8_
- [x] 2.2 Mail settings and transport
  - Install `nodemailer@10.0.15` (exact).
  - In `src/config/env.ts`, add `MAIL_TRANSPORT`, `MAIL_FROM` and `SMTP_*`, with defaults per environment and the
    smtp requirements.
  - `src/modules/mail/transport.ts`:
    - the smtp transport, which strips headers and maps errors without credentials
    - the outbox and off transports
    - `transportFromEnv()`
  - Add `AppDependencies.mailTransport`; the server builds it and tests inject it.
  - Add `test/helpers/mail.ts` with a `FakeTransport` that captures mail and can fail chosen addresses.
  - `GET /mail/status` (`settings.view`).
  - `.env.example`.
  - _Requirements: 3.1-3.7_
- [x] 2.3 Tests for templates and transport
  - Templates:
    - seeding creates both and never overwrites an edit
    - an unknown field or a broken brace gives a 400 naming it
    - a version conflict gives a 409
    - each save is audited with before and after
    - permissions per role
  - Env:
    - smtp without host, port or From fails startup
    - production defaults to off
  - Transport:
    - the smtp transport, on nodemailer's `jsonTransport`, sends no Cc or Bcc and strips line breaks from the
      subject
    - its error reason never contains the password
  - Mail status hides the password.
  - _Requirements: 1.2, 1.5, 1.8, 3.1-3.6, 12.2_
- [x] 2.4 Checkpoint: lint, typecheck, test and build pass in the backend.

- [x] 3. Statuses, sending and the mail log (backend)
- [x] 3.1 New insurer statuses in the proposals module
  - Extend the embedded insurer schema and `ProposalInsurerDoc` (design.md, Data models).
  - Mapper: the new fields, `contacts` with an email, and `overdue` with today in IST.
  - Replace every `status === 'SENT'` check with `hasRfq()`: mapper `locked`, `proposal-calc` stage, and the service
    lock and remove checks.
  - `markRfqSent()` sets `sentVia = OUTSIDE` and the due date.
  - Existing proposals tests must pass unchanged.
  - _Requirements: 5.6, 8.1, 11.2_
- [x] 3.2 Recording responses
  - `PUT /proposals/{id}/insurers/{insurerId}/response` (`proposals.edit`).
  - Check the change with `canMoveInsurer()` and save through `saveWith()` with `INSURER_RESPONSE_RECORDED` and an
    activity line.
  - _Requirements: 7.1-7.5_
- [x] 3.3 Mail log and attachments
  - `src/modules/mail/`:
    - the `mail_log` model (append-only hooks, the indexes in design.md)
    - the `mail_attachments` model (unique SHA-256)
    - a mapper to the summary and detail schemas
  - Register both in `src/models.ts`.
  - _Requirements: 10.1, 10.2_
- [x] 3.4 Sending the RFQ
  - `rfq-mail.service.ts`: `previewRfq()` and `sendRfq()`, following design.md steps 1 to 5:
    - checks, with addresses only from the master
    - repeated `sendId`
    - one attachment per send, at most 10 MB
    - per-insurer claim, render, send and record in one transaction, with activity and audit
    - per-insurer results
  - Routes: POST `/proposals/{id}/rfq/preview` and `/rfq/email` (`proposals.send`), with OpenAPI.
  - _Requirements: 4.6-4.10, 5.1-5.6, 10.1, 10.5, 12.1, 12.3, 12.4_
- [x] 3.5 Reminders
  - `sendReminder()` and POST `/proposals/{id}/insurers/{insurerId}/reminder` (`proposals.send`).
  - Use the Reminder template; the attachment is optional; set Reminded, the count and the time.
  - _Requirements: 6.1-6.5, 7.3_
- [x] 3.6 Reading the mail log
  - GET `/proposals/{id}/mails` (paginated, newest first) and `/mails/{mailId}` (`proposals.view`).
  - GET `/mails/{mailId}/attachment` (`proposals.export`, sends the stored bytes and file name).
  - _Requirements: 10.3, 10.4, 10.6, 12.5_
- [x] 3.7 Integration tests for sending
  - Use `FakeTransport` and the outbox to test:
    - properties 5, 6, 7 and 9
    - an insurer already sent is skipped
    - two concurrent sends to one insurer mail it once
    - off gives 409 and sends nothing
    - an incomplete Data Sheet, a past due date, an over-size attachment
    - outbox stores and does not deliver
    - reminders, and refused reminders after a response
    - response changes, allowed and refused
    - activity lines and audit entries with before and after statuses
    - the mail log list, detail and attachment bytes
    - permissions per role for every new route
    - `test/health.test.ts`'s list of documented endpoints
  - _Requirements: 4.8, 4.9, 5.1-5.5, 6.1-6.4, 7.1-7.4, 10.1-10.6, 12.1, 12.3, 12.4, 13.2_
- [x] 3.8 Checkpoint: lint, typecheck, test and build pass in the backend.

- [x] 4. Backend documentation
- [x] 4.1 Docs and steering
  - `docs/OPEN_ITEMS.md`:
    - replace the decision "the app does not send email"
    - add the open questions from requirements.md (Q14, wording, contacts, reminders, approval, Acknowledged)
  - README: mail settings, statuses, mail log and the new routes.
  - Steering (product phase, structure: mail and email-templates modules; tech: transport and the "never Cc or Bcc"
    rule).
  - _Requirements: 13.3, 13.4_
- [x] 4.2 Checkpoint: lint, typecheck, test and build pass in the backend.

- [x] 5. Statuses and templates (frontend)
- [x] 5.1 Shared sync and one status vocabulary
  - Run `npm run shared:sync`.
  - Replace `QUOTE_STATUSES` in `types/proposal.ts` with the shared `INSURER_STATUSES`, and give the sample data
    Reminded and due dates.
  - Update badges, `new-business.ts` (status, due date, overdue), `rfq-status.ts` (`hasRfq`), `rfq-view.tsx`, the
    workspace's sent count, `proposal-metrics.ts` and `dashboard-stats.ts`.
  - Add the proxy areas `email-templates` and `mail`, with mock-mode 503.
  - _Requirements: 8.3, 8.4, 9.1, 12.6_
- [x] 5.2 Email templates page
  - `app/(app)/masters/email-templates/`:
    - nav item (`masters.view`) and page permission
    - a card per kind, with the merge field list that inserts at the cursor
    - a preview with the shared `renderMail()` (sample values or a chosen case)
    - "Default" badge and version
    - field errors and the version conflict
    - read-only without `masters.manage`
  - _Requirements: 1.1-1.7_
- [x] 5.3 Tests for statuses and templates
  - badges for every status
  - RFQ page counts
  - Awaiting quotes and Overdue figures
  - template editor: insert field, preview, unknown field error, conflict, read-only
  - _Requirements: 1.3, 1.5-1.7, 8.3, 9.1, 9.2_
- [x] 5.4 Checkpoint: lint, typecheck, test, build and shared:check pass in the frontend.

- [x] 6. Sending, tracking and the mail log (frontend)
- [x] 6.1 Split the RFQ panel
  - Move `insurers-rfq-panel.tsx` into `components/proposals/rfq/` (files listed in design.md), each under about 250
    lines.
  - Keep the current choose, download and mark-sent behaviour; mark-sent becomes "Sent outside the app" with a due
    date.
  - _Requirements: 11.1, 11.2_
- [x] 6.2 Email the RFQ dialog
  - Insurers with address checkboxes (RFQ addresses ticked, contacts not), the due date (no earlier than today) and
    the format.
  - A preview per insurer from the API.
  - A send id per open, and results with "Try again" per failure.
  - Shown only with `proposals.send`, a complete Data Sheet, a Not sent insurer and the transport not off (from GET
    `mail/status` when the user may read it, otherwise from a 409 `MAIL_DISABLED`).
  - _Requirements: 4.1-4.8, 5.1-5.4_
- [x] 6.3 Reminders and responses
  - Each insurer row shows status, Overdue, due date, sent, reminders and response note.
  - The reminder dialog (addresses, attach the RFQ) and the response dialog (allowed statuses only, note).
  - _Requirements: 6.1-6.3, 7.1-7.3, 7.6, 8.1_
- [x] 6.4 Mail log, case views, dashboard and settings
  - Activity tab: a mail list (`useCaseMails`, Load more) and a detail sheet with the subject, body and attachment
    download (`proposals.export`).
  - The drawer's and the full page's insurer section, with the shared labels, Overdue and the due date.
  - Dashboard: the Overdue responses KPI linking to `/rfq?filter=overdue`, and the Insurers column tooltip.
  - The Settings mail card.
  - Demo-mode states.
  - _Requirements: 8.2, 9.2, 9.3, 10.3, 10.4, 3.6, 12.6_
- [x] 6.5 Tests for sending and the mail log
  - the send dialog: default ticks, no typed addresses, one preview per insurer, results with retry using a new send
    id
  - reminder and response dialogs
  - mail log list and detail
  - Overdue flag
  - the RFQ page's `?filter=overdue`
  - demo mode
  - _Requirements: 4.2-4.8, 5.3, 6.2, 7.2, 9.2, 10.3, 12.6, 13.2_
- [x] 6.6 Frontend documentation
  - README: sending, statuses, the mail log, email templates and demo mode.
  - Steering: structure and tech.
  - _Requirements: 13.4_
- [x] 6.7 Checkpoint and end-to-end verification
  - Lint, typecheck, test, build and shared:check in the frontend; lint, typecheck, test and build in the backend.
  - Against a local MongoDB (never the cloud database) with `MAIL_TRANSPORT=outbox`:
    - as a Relationship Manager, send to two insurers
    - as Underwriting / Placement, remind one and record Declined for the other
    - check the mail log, statuses, Overdue, dashboard, RFQ page and audit entries, in both themes
    - check Read-only and Approver cannot send
  - Report what was verified and what was not (no real SMTP delivery).
  - _Requirements: 13.1_
