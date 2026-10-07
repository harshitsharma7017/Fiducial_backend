# Design: RFQ email, insurer tracking and mail log

## Overview

The API sends the RFQ itself: one mail per insurer, from an Admin-edited template, with the RFQ workbook attached.
It records the result per insurer, tracks each insurer's response, and keeps every mail against the case. The web
app gets:

- a send screen
- reminder and response actions
- a mail log on the case's Activity tab
- an email template page under Masters
- the new statuses on the case, the RFQ page and the dashboard

What exists and is reused:

- **Proposals** (`src/modules/proposals`): each insurer on a case is embedded in `proposals.insurers[]`, with status
  `NOT_SENT` or `SENT`. `setInsurers()` and `markRfqSent()` change them. `saveWith()` applies a change, adds an
  activity line and writes the audit entry in one transaction.
- **The RFQ file**: `rfqDocument()` builds the RFQ as xlsx or pdf on demand, from the client's template when one is
  uploaded.
- **Insurer master**: each branch has `rfqEmails` (at least 1) and `contacts` (name, designation, email or phone).
- **Audit**: SEND and EXPORT kinds already exist. `RFQ_SENT` (the manual mark) is the only SEND action today.

Decisions taken for the open questions are in requirements.md. The ones that shape the design:

- Mail goes out from the API process, with no job queue (document 04's BullMQ worker comes later).
- `nodemailer` provides SMTP.
- Development and test use an outbox that stores mails without delivering them.
- Reminders and No response are manual only.
- No approval before sending.

## Architecture

```
Web app (Next.js)                                API (Express)
──────────────────                                ─────────────
Masters › Email templates  ──/api/proxy/email-templates──▶ email-templates module
Case › Insurers and RFQ                                     (model, seed, routes)
  Email the RFQ dialog ────/api/proxy/proposals/:id/rfq/email──▶ proposals module
  Remind / Record response ─/…/insurers/:insurerId/*────────▶   rfq-mail.service.ts
Case › Activity (mail log) ─/…/proposals/:id/mails─────────▶   ├─ rfqDocument() (existing)
Settings › Mail card ──────/api/proxy/mail/status──────────▶   ├─ renderMail() (src/shared/mail.ts)
                                                           │   ├─ mail log + attachments
                                                           │   └─ MailTransport ── smtp │ outbox │ off
src/shared (synced copy) ◀──── shared:sync ──────────── src/shared/mail.ts, proposals.ts, audit.ts
```

- `src/shared/mail.ts` holds:
  - the template kinds and merge fields
  - `parseTemplate()` and `renderMail()`
  - the request and response schemas

  The web app's preview and the API's sending use the same `renderMail()` (Requirement 2.5).

- A new module, `src/modules/mail/`, holds the transport, the mail log and attachment models, and `GET /mail/status`.
- A new module, `src/modules/email-templates/`, holds the template model, the defaults and the routes.
- The proposals module adds `rfq-mail.service.ts` (send, preview, remind) and `insurer-status.ts` (status changes),
  plus the new routes in `proposals.routes.ts`.
- `createApp()` takes the transport as a dependency (`AppDependencies.mailTransport`). The server builds it from the
  environment; tests pass a fake.

## Components and interfaces

### Shared: `src/shared/mail.ts`

```ts
export const EMAIL_TEMPLATE_KINDS = ['RFQ', 'REMINDER'] as const;
export const MERGE_FIELDS = [
  'insuredName',
  'policyPeriod',
  'dueDate',
  'reference',
  'insurerName',
  'contactName',
  'senderName',
] as const;
export type MergeValues = Record<MergeField, string>;

/** Splits a template into text and fields; reports unknown fields and malformed braces. */
export function parseTemplate(
  source: string,
): { parts: TemplatePart[] } | { errors: TemplateError[] };

/** Fills a validated template: subject on one line, text body, and HTML with every value escaped. */
export function renderMail(
  template: { subject: string; body: string },
  values: MergeValues,
): { subject: string; text: string; html: string };

export function mergeValuesFor(input: {
  record: Pick<ProposalRecord, 'reference' | 'client' | 'policyStart' | 'policyEnd'>;
  insurer: { company: string; branch: string };
  contactName: string | null;
  dueDate: string;
  senderName: string;
}): MergeValues;
```

- **Placeholder syntax.** A placeholder is `{{` + optional spaces + a field name + optional spaces + `}}`.
- **Malformed placeholders.** A `{{` without its closing `}}` is an error, and so is a `}}` without an opening `{{`.
  There is no escape syntax; templates do not need literal braces.
- **HTML part.** `escapeHtml` replaces `& < > " '` and turns `\n` into `<br>`. The body is wrapped in a minimal
  `<div>` with no styles from the template, so an Admin cannot inject markup.
- **Subject.** Each run of whitespace, including line breaks, becomes one space, and the result is trimmed.
- **`policyPeriod`.** Formatted with the shared `formatDate`. With no start it reads "1 year from the date of
  payment"; with a start and no end, the end is a year less a day after the start, as the screens show it.

Schemas:

- `EmailTemplateSchema`: `kind`, `subject`, `body`, `version`, `isDefault`, `updatedBy`, `updatedAt`.
- `UpdateEmailTemplateRequestSchema`: `subject`, `body`, `expectedVersion`. It is refined with `parseTemplate()`, so
  an unknown field is a 400 that names the field and its location (subject or body).
- `RfqRecipientSchema`: `{ insurerId, to: Email[] }`, with 1 to 20 addresses, unique.
- `SendRfqRequestSchema`: `{ sendId: uuid, insurers: RfqRecipient[1..5], dueDate: iso date, format: 'xlsx'|'pdf' }`.
- `PreviewRfqRequestSchema`: the same without `sendId`, plus an optional `kind`.
- `SendReminderRequestSchema`: `{ sendId, to, attachRfq: boolean, format }`.
- `SendRfqResponseSchema`: `{ results: [{ insurerId, outcome: 'SENT'|'FAILED'|'SKIPPED', mailId|null, reason|null }], proposal: ProposalRecord }`.
  `SKIPPED` means another send to the insurer was in progress (or finished between the checks and the claim). Naming
  an insurer that already has the RFQ refuses the whole send with 409 (Requirement 4.9), unless this same `sendId`
  mailed it, in which case the result comes from the log.
- `MailSummarySchema` (the log list):
  - `id`, `kind`, `insurerId`, `insurerName`, `to`, `subject`, `sentBy` (name), `at`
  - `transport`, `result: 'DELIVERED'|'OUTBOX'|'FAILED'`, `error`
  - `attachment: { fileName, size } | null`
- `MailDetailSchema`: the summary plus `text`, `html`, `templateVersion`, `dueDate` and `messageId`.
- `MailStatusSchema`: `{ transport, from: string|null, host: string|null }`.

### Shared: `src/shared/proposals.ts` changes

```ts
export const INSURER_STATUSES = [
  'NOT_SENT',
  'SENT',
  'REMINDED',
  'QUOTED',
  'DECLINED',
  'NO_RESPONSE',
] as const;
export const INSURER_STATUS_LABELS: Record<InsurerStatus, string>; // Not sent … No response
export const RESPONSE_STATUSES = ['QUOTED', 'DECLINED', 'NO_RESPONSE'] as const;
export function hasRfq(status: InsurerStatus): boolean; // anything but NOT_SENT
export function canMoveInsurer(from: InsurerStatus, to: InsurerStatus): boolean; // requirement 7.2
export function isOverdue(
  insurer: { status: InsurerStatus; dueDate: string | null },
  todayIst: string,
): boolean;
```

`ProposalInsurerSchema` gains these fields:

| Field            | Meaning                                                                     |
| ---------------- | --------------------------------------------------------------------------- |
| `status`         | `INSURER_STATUSES`                                                          |
| `sentVia`        | `'APP' \| 'OUTSIDE' \| null`                                                |
| `dueDate`        | the quote due date (YYYY-MM-DD) or null                                     |
| `reminderCount`  | number                                                                      |
| `lastRemindedAt` | date-time or null                                                           |
| `response`       | `{ status, note, at, by } \| null`, the last one recorded                   |
| `lastMail`       | `{ id, kind, at, result } \| null`                                          |
| `contacts`       | `{ name, designation, email }[]`, the insurer's contacts that have an email |
| `overdue`        | computed by the API with today in IST                                       |

`RecordInsurerResponseRequestSchema` is `{ status: RESPONSE_STATUSES, note: string ≤ 500 | null }`.
`MarkRfqSentRequestSchema` gains an optional `dueDate`; when it is omitted, the case's due date is used.

### Shared: audit and errors

New actions, all on entity `proposal` unless stated:

| Action                      | Kind | Written when                                   |
| --------------------------- | ---- | ---------------------------------------------- |
| `RFQ_EMAILED`               | SEND | an RFQ mail is accepted (or stored, in outbox) |
| `RFQ_REMINDER_EMAILED`      | SEND | a reminder is accepted                         |
| `RFQ_EMAIL_FAILED`          | SEND | the transport rejects an RFQ or reminder       |
| `INSURER_RESPONSE_RECORDED` | EDIT | Quoted, Declined or No response is set         |
| `EMAIL_TEMPLATE_UPDATED`    | EDIT | a template is saved (entity `email_template`)  |

- The entity `email_template` is new.
- The mail entries' `after` holds `{ insurer, to, mailId, result, dueDate }`. Their `before` holds the insurer's
  previous status, so the log shows the status change.
- New error codes: `MAIL_DISABLED` (409), `RFQ_ATTACHMENT_TOO_LARGE` (422) and `TEMPLATE_VERSION_CONFLICT` (409).

### Shared: permissions

No new permission:

| Action                           | Permission         |
| -------------------------------- | ------------------ |
| send, preview, remind, mark sent | `proposals.send`   |
| record a response                | `proposals.edit`   |
| read the mail log                | `proposals.view`   |
| download an attachment           | `proposals.export` |
| read templates                   | `masters.view`     |
| edit templates                   | `masters.manage`   |
| mail status                      | `settings.view`    |

### Mail transport (`src/modules/mail/transport.ts`)

```ts
export interface OutgoingMail {
  from: string;
  replyTo: string;
  to: string[]; // no cc, no bcc: the type has no field for them
  subject: string;
  text: string;
  html: string;
  attachment: { fileName: string; contentType: string; data: Buffer } | null;
}
export type TransportResult =
  | { ok: true; result: 'DELIVERED' | 'OUTBOX'; messageId: string | null }
  | { ok: false; reason: string };
export interface MailTransport {
  readonly name: 'smtp' | 'outbox' | 'off';
  send(mail: OutgoingMail): Promise<TransportResult>;
}
export function transportFromEnv(env: Env, logger: Logger): MailTransport;
```

- **smtp.** `nodemailer.createTransport({ host, port, secure, auth })`, with a 30 s socket timeout.
  - `send()` passes only `from`, `replyTo`, `to`, `subject`, `text`, `html` and `attachments`.
  - It never passes `cc` or `bcc`.
  - Header values are stripped of `\r` and `\n` first (Requirement 12.2).
  - Errors are turned into a reason from the SMTP response code and text. The error object is never logged, because
    it can carry the auth settings.
- **outbox.** Returns `{ ok: true, result: 'OUTBOX', messageId: null }`. The mail log is the outbox.
- **off.** The services check `transport.name === 'off'` before doing any work and throw `MAIL_DISABLED`.
- **Tests.** A `FakeTransport` captures every mail and can fail chosen addresses.

### Email templates module

- **Model.** The `email_templates` collection: `kind` (unique), `subject`, `body`, `version`, `isDefault`,
  `updatedBy`, timestamps.
- **Seeding.** `ensureEmailTemplates()` runs at startup after `ensureIndexes()`. It inserts a missing kind with the
  defaults in `default-templates.ts`, using `insertOne` with the unique index, so concurrent starts are safe. It never
  overwrites an existing template.
- **Saving.** `PUT /email-templates/:kind` runs `findOneAndUpdate({ kind, version: expectedVersion })`.
  - It increments `version`, sets `isDefault: false` and writes the audit entry in the same transaction.
  - With no match it returns 409 `TEMPLATE_VERSION_CONFLICT`, carrying the current version.

Default RFQ template (neutral wording, marked "Default" until edited):

```
Subject: Request for quotation: {{insuredName}} ({{reference}})
Dear {{contactName}},
Please find attached our request for quotation for {{insuredName}} for the policy period {{policyPeriod}}.
We would be grateful to receive your quote by {{dueDate}}.
Regards,
{{senderName}}
```

The Reminder template has the same fields. Its subject is "Reminder: request for quotation: {{insuredName}}
({{reference}})".

### RFQ mail service (`src/modules/proposals/rfq-mail.service.ts`)

`sendRfq(id, input, actor, deps)`:

1. **Check.** Load the case.
   - Refuse a closed case.
   - Refuse an incomplete Data Sheet (409 `DATA_SHEET_INCOMPLETE`).
   - Refuse with the transport off (409 `MAIL_DISABLED`).
   - Refuse a due date before today in IST (400).
   - Each insurer must be on the case.
   - Each address must be in that insurer's `rfqEmails` or contacts' emails, compared in lower case. Otherwise
     return 400, naming the insurer and the address. Nothing is sent.
2. **Repeat send.** Look up mail log entries with this `sendId`. Insurers that already have one are answered from it
   and not sent again (Requirement 5.5).
3. **Attachment.** Build the RFQ once with `rfqDocument()`.
   - Refuse a file over 10 MB (`RFQ_ATTACHMENT_TOO_LARGE`).
   - Store it in `mail_attachments` keyed by SHA-256 and file name (`insertOne`, ignoring a duplicate key), so every
     mail of the send points at the same stored file.
   - No separate export audit: each `RFQ_EMAILED` entry records the file name. Downloading a mail's attachment later
     is audited as `RFQ_DOWNLOADED`.
4. **Per insurer, one after another:**
   1. **Claim.** Run `updateOne` on the proposal with an array filter that matches the insurer only when its status
      is `NOT_SENT` and it has no live `sending` claim (`sending.at` older than 10 minutes counts as stale). It sets
      `sending = { sendId, at }`. If nothing matched, answer `SKIPPED`. This stops two sends to the same insurer from
      different tabs.
   2. **Render.** Use `renderMail()` with the RFQ template and the insurer's values. `contactName` is the name of the
      first chosen address that belongs to a contact.
   3. **Send.** Call `transport.send()`.
   4. **Record.** In one transaction:
      - insert the mail log entry
      - update the insurer: on success, `status = SENT`, `sentVia = APP`, `sentAt`, `sentBy`, `dueDate`,
        `lastMail` and `sending = null`; on failure, `lastMail` (result Failed) and `sending = null`. The status change
        uses a second array filter that matches only while the status still allows the mail, so an answer recorded
        meanwhile is never overwritten.
      - push the activity line
      - write the audit entry
      - recompute the stage (the existing `saveWith` logic)
5. **Reply.** Return the per-insurer results and the updated `ProposalRecord`.

**If the server stops after the transport accepted a mail but before step 4.4 commits**, the insurer is left with a
stale `sending` claim and no log entry. The claim's 10-minute expiry lets a user retry, which could mail that insurer
a second time. The activity line written at claim time would avoid this but adds a write per insurer; this design
accepts the small risk and documents it. A job queue (document 04) removes it later.

`previewRfq(id, input, actor)` runs the checks from step 1, without the transport check, and returns the rendered
mails and the attachment's file name. It builds no file and sends nothing.

`sendReminder(id, insurerId, input, actor, deps)` follows the same steps for one insurer:

- The claim matches status `SENT` or `REMINDED`.
- It uses the Reminder template.
- The attachment is optional.
- On success it sets `status = REMINDED`, increments `reminderCount` and sets `lastRemindedAt`.

`recordResponse(id, insurerId, input, actor)` checks `canMoveInsurer()`, then uses `saveWith()` with
`INSURER_RESPONSE_RECORDED` and an activity line such as "Kavach General Insurance, Pune: Declined (note)".

### Status changes in existing code

Every check that means "the RFQ has gone to this insurer" changes from `status === 'SENT'` to `hasRfq(status)`:

| File                   | Check                                                 |
| ---------------------- | ----------------------------------------------------- |
| `proposals.mapper.ts`  | `anySent` (the `locked` flag)                         |
| `proposal-calc.ts`     | the RFQ Sent stage                                    |
| `proposals.service.ts` | the lock checks, and `setInsurers`' "cannot take off" |

`markRfqSent()` also sets `sentVia = OUTSIDE` and `dueDate`.

In the web app:

| File                         | Change                                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| `lib/rfq-status.ts`          | counts with `hasRfq`                                                                      |
| `lib/api/new-business.ts`    | the RFQ document status and the screen model's insurer status                             |
| `lib/api/dashboard-stats.ts` | Awaiting quotes = Sent or Reminded; new Overdue                                           |
| `lib/proposal-metrics.ts`    | responded = Quoted or Declined                                                            |
| `rfq/rfq-view.tsx`           | status badges                                                                             |
| `proposal-workspace.tsx`     | its sent count                                                                            |
| `types/proposal.ts`          | `QUOTE_STATUSES` is replaced by the shared `INSURER_STATUSES` (sample data adds Reminded) |

### API routes

| Method and path                                      | Permission         | Purpose                        |
| ---------------------------------------------------- | ------------------ | ------------------------------ |
| GET `/email-templates`                               | `masters.view`     | both templates                 |
| PUT `/email-templates/{kind}`                        | `masters.manage`   | save, with `expectedVersion`   |
| GET `/mail/status`                                   | `settings.view`    | transport, From, host          |
| POST `/proposals/{id}/rfq/preview`                   | `proposals.send`   | rendered mails, nothing sent   |
| POST `/proposals/{id}/rfq/email`                     | `proposals.send`   | one mail per insurer           |
| POST `/proposals/{id}/insurers/{insurerId}/reminder` | `proposals.send`   | one reminder                   |
| PUT `/proposals/{id}/insurers/{insurerId}/response`  | `proposals.edit`   | Quoted, Declined, No response  |
| POST `/proposals/{id}/rfq/sent` (existing)           | `proposals.send`   | sent outside the app, due date |
| GET `/proposals/{id}/mails?cursor=&limit=`           | `proposals.view`   | mail log, newest first         |
| GET `/proposals/{id}/mails/{mailId}`                 | `proposals.view`   | one mail with its bodies       |
| GET `/proposals/{id}/mails/{mailId}/attachment`      | `proposals.export` | the attachment, as sent        |

Every route is documented with `documentRoute()`. In the web app's proxy allowlist (`proxy-paths.ts`),
`email-templates` and `mail` are new areas; the rest sit under `proposals`.

### Web app

- **Email templates** (`app/(app)/masters/email-templates/`).
  - A nav item under Masters (`masters.view`); `pagePermission` maps the page.
  - Each kind is a card with the subject and body fields, the merge field list (selecting one inserts it at the
    cursor) and a preview pane.
  - The preview uses the shared `renderMail()`, with sample values or a case picked from a search.
  - "Default" badge, version and last change.
  - Saving shows field errors from the API. A version conflict says the template changed and offers to reload.
  - Read-only without `masters.manage`.
- **Insurers and RFQ tab.** `insurers-rfq-panel.tsx` (669 lines) is split into `components/proposals/rfq/`:
  - `insurers-card.tsx`
  - `insurer-row.tsx` (status, Overdue, due date, sent, reminders, response)
  - `choose-insurers-dialog.tsx`
  - `send-rfq-dialog.tsx`
  - `send-results.tsx`
  - `reminder-dialog.tsx`
  - `response-dialog.tsx`
  - `mark-sent-dialog.tsx`
  - `download-rfq.tsx`
- **Email the RFQ dialog.** Steps on one screen:
  1. Insurers, each with its address checkboxes.
  2. Quote due date and attachment format.
  3. Preview per insurer, as tabs.
  4. Send.

  The dialog makes a `crypto.randomUUID()` send id when it opens, and a new one for each "Try again". After sending it
  shows the results: a success line per insurer, and a destructive alert with the reason and "Try again" for each
  failure.

- **Activity tab.** Shows a "Mails" list (`useCaseMails`, newest first, "Load more") above the existing activity list.
  - Each row shows the kind badge, the insurer, To, who sent it, when, and a result badge (Delivered, Outbox, Failed).
  - Selecting a row opens a sheet with the subject, the text body and "Download attachment" (`proposals.export`).
- **Drawer and full case page.** The insurers section shows the shared status labels, Overdue and the due date.
- **Dashboard.** "Awaiting quotes" counts Sent and Reminded. A new KPI card, "Overdue responses", links to
  `/rfq?filter=overdue`. The table's Insurers column has a tooltip with the count per status.
- **Settings.** A "Mail" card shows the transport, From and host. Outbox and off each get an explanation.
- **Demo mode.** The mock BFF answers 503 `DEMO_MODE` for the new paths. The dialogs are hidden, and the mail log
  shows the demo-mode state.

## Data models

### `proposals.insurers[]` (embedded, extended)

```
insurerId       ObjectId  ref Insurer
status          'NOT_SENT'|'SENT'|'REMINDED'|'QUOTED'|'DECLINED'|'NO_RESPONSE'
sentVia         'APP'|'OUTSIDE'|null
sentAt, sentBy  Date|null, ObjectId|null
dueDate         'YYYY-MM-DD'|null           quote due date for this insurer
reminderCount   Number (default 0)
lastRemindedAt  Date|null
response        { status, note|null, at, by } | null
lastMail        { id, kind, at, result } | null   the last mail (id refs mail_log)
sending         { sendId, at } | null       claim while a mail is in flight
```

Existing documents hold only `NOT_SENT` and `SENT` with sentAt and sentBy, so no migration is needed. The new fields
default when they are missing, and the mapper reads a missing field as null or 0.

### `mail_log` (new, append-only)

```
_id, proposalId, insurerId, kind 'RFQ'|'REMINDER', sendId (uuid)
from, replyTo, to[]                         lower case
subject, text, html, templateVersion
attachmentId ObjectId|null                  ref mail_attachments
dueDate 'YYYY-MM-DD'|null
sentBy ObjectId, at Date
transport 'smtp'|'outbox', result 'DELIVERED'|'OUTBOX'|'FAILED'
messageId String|null, error String|null
```

- Indexes: `{ proposalId: 1, at: -1 }` for the case's log, and `{ sendId: 1, insurerId: 1, kind: 1 }` (unique) for
  repeated sends.
- It uses the same pre-hooks as `audit_logs`, so any update or delete throws.
- Bodies average a few kB; 5 insurers × several rounds per case is small.

### `mail_attachments` (new, insert-only)

```
_id, sha256, fileName ({sha256, fileName} unique), contentType, size, data Buffer, createdAt
```

Files are stored like document templates (a Buffer in MongoDB, at most 10 MB), so there is no new storage service.
Moving them to object storage later changes only this module.

### `email_templates` (new)

```
_id, kind 'RFQ'|'REMINDER' (unique), subject, body, version Number, isDefault Boolean, updatedBy ObjectId|null, timestamps
```

### Environment (`src/config/env.ts`)

| Variable         | Rule                                                                    |
| ---------------- | ----------------------------------------------------------------------- |
| `MAIL_TRANSPORT` | `smtp` \| `outbox` \| `off`; default `outbox`, but `off` in production  |
| `MAIL_FROM`      | email; required for smtp (outbox falls back to `rfq@outbox.invalid`)    |
| `SMTP_HOST`      | required for smtp                                                       |
| `SMTP_PORT`      | 1 to 65535; required for smtp                                           |
| `SMTP_SECURE`    | `true` \| `false`, default `false` (STARTTLS when the server offers it) |
| `SMTP_USER`      | optional                                                                |
| `SMTP_PASSWORD`  | optional; only with `SMTP_USER`                                         |

`.env.example` documents them with `MAIL_TRANSPORT=outbox`.

## Correctness properties

Each property is tested with generated cases from a seeded generator in the test file (no fast-check in the
backend) or a table of cases (API flows).

1. **Rendering fills every field.**
   - For any values, `renderMail()`'s subject and text contain no `{{`.
   - The text equals the template with each placeholder replaced by its value.
2. **Rendering is safe.**
   - For any values (including `<`, `&`, quotes and line breaks), the HTML part contains no character from a value
     that is not escaped, and is the escaped text with `<br>` for line breaks.
   - The subject contains no `\r` or `\n`.
3. **Template validation is exact.** `parseTemplate()` accepts a template exactly when every `{{…}}` names a known
   field and no brace is unmatched.
4. **Status changes follow the table.**
   - `canMoveInsurer(from, to)` holds exactly for the pairs in Requirement 7.2.
   - No sequence of allowed changes returns an insurer to `NOT_SENT`.
5. **One mail per insurer.**
   - For any send of k insurers with chosen addresses, the transport receives k mails.
   - Each mail's To is exactly that insurer's chosen addresses, all from its master record.
   - No mail has Cc or Bcc.
6. **Repeated sends mail no one twice.** Sending the same request again with the same `sendId` adds no mail to the
   transport, and returns the same results.
7. **Failures stay retryable.** For any subset of insurers whose mail fails:
   - those stay `NOT_SENT`
   - the others become `SENT`
   - the log holds exactly one entry per insurer attempted
8. **Overdue follows the due date.** `isOverdue` is true exactly when the status is Sent or Reminded and the due date
   is before today (IST).
9. **Unknown addresses send nothing.** A send naming any address outside its insurer's master record is refused, and
   the transport receives no mail.

## Error handling

| Case                                               | Response                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------- |
| transport `off`                                    | 409 `MAIL_DISABLED`; the web app hides the actions                  |
| Data Sheet incomplete                              | 409 `DATA_SHEET_INCOMPLETE` with `missing`                          |
| address not in the master, insurer not on the case | 400 with the insurer and address in `details`                       |
| due date before today                              | 400 on `dueDate`                                                    |
| status change not allowed                          | 409 `CONFLICT` naming the current status                            |
| template with an unknown or broken field           | 400 naming the field and where it is                                |
| template changed meanwhile                         | 409 `TEMPLATE_VERSION_CONFLICT` with the current version            |
| RFQ file over 10 MB                                | 422 `RFQ_ATTACHMENT_TOO_LARGE`                                      |
| SMTP rejects or times out for one insurer          | 200 with that insurer `FAILED` and the reason; others unaffected    |
| case closed                                        | 409 (existing `closed()`)                                           |
| demo mode                                          | 503 `DEMO_MODE` from the BFF; the web app shows the demo-mode state |

## Testing strategy

Backend:

- Unit tests for `src/shared/mail.ts` and the status helpers, including properties 1 to 4 and 8. They also run in
  the frontend, through the synced copy.
- Integration tests (Supertest, in-memory replica set, `FakeTransport`) for:
  - one mail per insurer and its To (property 5)
  - repeated `sendId` (property 6)
  - partial failure (property 7)
  - unknown address (property 9)
  - outbox and off
  - reminders and responses with their audit and activity
  - the mail log list, detail and attachment
  - permissions per role (added to `test/permissions.test.ts`)
  - template save, conflict and seeding
  - the existing proposals tests, which must still pass with the new statuses
- No test reaches a real SMTP server. The smtp transport's mapping of nodemailer results is tested with nodemailer's
  `jsonTransport`.

Frontend (Vitest and Testing Library):

- the template editor (insert field, preview, unknown field error, conflict)
- the send dialog (default ticks, addresses only from the master, one preview per insurer, results with retry)
- the reminder and response dialogs (allowed statuses only)
- the mail log list and detail
- the dashboard's Awaiting quotes and Overdue figures
- the RFQ page counts
- the status badges
- the demo-mode states

End-to-end verification: against a local MongoDB with `MAIL_TRANSPORT=outbox`, as each role, sending to two
insurers, reminding one and recording a response for the other. The checks: the mail log, the statuses, the
dashboard and the audit entries.

## Dependencies

| Package      | Version (verified on npm, 6 Oct 2026) | Repo    | Why            |
| ------------ | ------------------------------------- | ------- | -------------- |
| `nodemailer` | 10.0.15 (ships its own types)         | backend | SMTP transport |

The property tests for the shared logic generate their cases with a seeded generator inside the test files, so the
backend needs no property-testing library. No Redis, queue or object storage is added.
