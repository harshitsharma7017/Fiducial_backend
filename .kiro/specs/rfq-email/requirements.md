# Requirements: RFQ email, insurer tracking and mail log

## Introduction

Today the team downloads the RFQ workbook, emails it to each insurer from their own mailbox and then marks it as
sent in the app (`docs/OPEN_ITEMS.md`, "Proposals (new business, to the RFQ)"). Each insurer on a proposal is only
Not sent or Sent. This spec lets the app send the RFQ itself and track every insurer's answer. It covers four tasks
from the plan:

- **E-2**: email templates with merge fields (insured name, policy period, due date) that an Admin edits without a
  developer.
- **E-3**: a send screen. The user picks insurers and contacts, attaches the RFQ and sets the quote due date. Each
  insurer gets its own mail, so no insurer sees another.
- **E-4**: per-insurer tracking (Sent, Reminded, Quoted, Declined, No response), shown on the case and the dashboard.
- **E-6**: every mail logged against the case. The case timeline shows who was mailed and when.

The spec changes both repositories. It lives in Fiducial_backend because the contracts start in its `src/shared`.
The Fiducial_frontend tasks are in the same task list.

Sources: plan tasks E-2, E-3, E-4 and E-6; documents 02 (RFQ-01 to RFQ-06, AUD-01), 03 (M3; the client provides
the insurer contact emails and an SMTP account in week 10), 04 (Amazon SES or client SMTP) and 06 (Q14).

Out of scope:

- automatic reminders (RFQ-05 is a Should for R2)
- manager approval before sending (RFQ-06; who approves is Q12)
- recording the quote figures (that is the quote-capture task)
- reading insurers' replies from a mailbox
- a background job queue

## Glossary

| Term              | Meaning                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| Case              | A proposal (new business or renewal).                                                                     |
| Insurer on a case | One of the up to 5 insurers chosen for the case, from the insurer master (one record per company branch). |
| RFQ addresses     | The insurer branch's `rfqEmails` in the insurer master.                                                   |
| Contact           | A named contact of the insurer branch with an email, from the insurer master.                             |
| Send              | One user action that mails the RFQ to one or more insurers: one mail per insurer.                         |
| Reminder          | A follow-up mail to an insurer that has the RFQ and has not answered.                                     |
| Quote due date    | The date an insurer is asked to quote by. Set per insurer when the RFQ is sent.                           |
| Response status   | The insurer's status on the case: Not sent, Sent, Reminded, Quoted, Declined or No response.              |
| Overdue           | Sent or Reminded, and the quote due date has passed (IST). A flag shown on screen, not a status.          |
| Mail transport    | How mail leaves the API: `smtp` (delivered), `outbox` (stored, never delivered) or `off` (no sending).    |
| Mail log          | The stored record of every mail the app sent or tried to send for a case.                                 |

## Requirements

### Requirement 1: Email templates (E-2)

**User story:** As an Admin, I want to edit the RFQ and reminder emails myself, so that the wording can change
without a developer.

#### Acceptance criteria

1. The app SHALL keep two email templates, **RFQ** and **Reminder**. Each has a subject (at most 200 characters) and
   a plain-text body (at most 10,000 characters).
2. WHEN the API starts and a template does not exist THEN it SHALL create it with neutral default wording. The
   wording SHALL be marked on screen as the default, for the client to replace.
3. A user with `masters.manage` (Admin) SHALL be able to edit both templates on a "Email templates" page under
   Masters. Users with `masters.view` SHALL see them read-only.
4. Templates SHALL support these merge fields, written as `{{name}}`:

   | Field          | Value                                                                          |
   | -------------- | ------------------------------------------------------------------------------ |
   | `insuredName`  | the case's client name                                                         |
   | `policyPeriod` | "DD MMM YYYY to DD MMM YYYY"; with no start, "1 year from the date of payment" |
   | `dueDate`      | the insurer's quote due date, DD MMM YYYY                                      |
   | `reference`    | the case reference                                                             |
   | `insurerName`  | the insurer company and branch                                                 |
   | `contactName`  | the first chosen contact's name, else empty                                    |
   | `senderName`   | the name of the user who sends the mail                                        |

5. IF a template uses a field not in the list, or a malformed placeholder (for example `{{dueDate`), THEN saving SHALL
   fail with a message naming it. Nothing SHALL be saved.
6. The page SHALL list the merge fields and insert one at the cursor when selected.
7. The page SHALL preview the subject and body filled from a case the user chooses, and from sample values when no
   case is chosen.
8. Each save SHALL increase the template's version. It SHALL be audited (kind Edit) with the subject and body before
   and after.
9. Every mail SHALL record the template version it was built from.

### Requirement 2: Building a mail from a template

**User story:** As a user sending the RFQ, I want each insurer's mail filled in correctly, so that I do not edit it
by hand.

#### Acceptance criteria

1. Every merge field in the subject and body SHALL be replaced by its value. No `{{` placeholder SHALL remain.
2. The mail SHALL have a plain-text part and an HTML part. In the HTML part every value and every template character
   SHALL be HTML-escaped, and line breaks SHALL become `<br>`. A client name such as `<b>A & B</b>` SHALL appear as
   text, never as markup.
3. The subject SHALL never contain a line break; line breaks from values SHALL become single spaces.
4. A merge field with no value (for example `contactName` with no chosen contact) SHALL be replaced by an empty
   string.
5. The rendering function SHALL be shared by the API and the web app, so the preview matches the mail sent.

### Requirement 3: Mail transport

**User story:** As an operator, I want to choose whether the app really sends mail, so that development and testing
never mail real insurers.

#### Acceptance criteria

1. `MAIL_TRANSPORT` SHALL choose the transport: `smtp`, `outbox` or `off`. The default SHALL be `outbox` in
   development and test, and `off` in production.
2. WITH `smtp` the API SHALL require `SMTP_HOST`, `SMTP_PORT` and `MAIL_FROM`. `SMTP_SECURE`, `SMTP_USER` and
   `SMTP_PASSWORD` SHALL be optional. Startup SHALL fail with a readable message when a required value is missing.
3. WITH `outbox` every mail SHALL be built, stored in the mail log and marked "Not delivered (outbox)". Nothing SHALL
   leave the server.
4. WITH `off` the send and reminder actions SHALL be refused (409 `MAIL_DISABLED`), and the web app SHALL not offer
   them. Marking the RFQ as sent by hand (Requirement 11) SHALL still work.
5. The SMTP password SHALL never be logged, returned by the API or written to the audit log.
6. Settings (Admin) SHALL show the transport in use, the From address and, for `smtp`, the host. It SHALL never show
   the password.
7. Every mail SHALL be sent From `MAIL_FROM`, with Reply-To set to the sending user's email, so that insurers' replies
   reach that user.

### Requirement 4: Send screen (E-3)

**User story:** As a Relationship Manager or Underwriting / Placement user, I want to send the RFQ to the chosen
insurers in one step, so that each gets their own mail with the RFQ attached.

#### Acceptance criteria

1. On the case's "Insurers and RFQ" tab, a user with `proposals.send` SHALL be able to open "Email the RFQ" when:
   - the Data Sheet is complete
   - at least one insurer on the case is Not sent
   - the transport is not `off`
2. For each Not sent insurer the screen SHALL list its RFQ addresses and its contacts that have an email, each with a
   checkbox. The RFQ addresses SHALL start ticked and the contacts unticked. Each chosen insurer SHALL need at least
   one ticked address.
3. Addresses SHALL come only from the insurer master. The screen SHALL not accept typed addresses.
4. The user SHALL choose which insurers to send to. All Not sent insurers SHALL start chosen.
5. The user SHALL choose the attachment: the RFQ as Excel (default) or as PDF, generated from the case as the
   download is.
6. The user SHALL set the quote due date. It SHALL start at the case's due date, and SHALL not be before today (IST).
7. The screen SHALL preview each chosen insurer's mail: the To addresses, subject and body.
8. WHEN the user sends THEN the API SHALL send **one mail per chosen insurer**:
   - Its To SHALL hold only that insurer's ticked addresses.
   - It SHALL have no Cc and no Bcc.
   - It SHALL carry the RFQ attachment.
9. The API SHALL refuse a send that names:
   - an address not on that insurer's master record
   - an insurer not on the case
   - an insurer already sent
   - a due date before today

   It SHALL send nothing in that case.

10. Sending SHALL need `proposals.send`. Previewing SHALL need `proposals.send` too.

### Requirement 5: Send results

**User story:** As the sender, I want to see which mails went and which failed, so that I can retry only the
failures.

#### Acceptance criteria

1. Each insurer's mail SHALL succeed or fail on its own. One failure SHALL not stop the others.
2. WHEN an insurer's mail is accepted by the transport (or stored, in outbox) THEN the insurer SHALL become Sent with:
   - the time and the sender
   - the quote due date
   - the mail's log entry
3. WHEN it fails THEN the insurer SHALL stay Not sent. The mail log SHALL keep the failure and its reason (the SMTP
   error text, never credentials). The screen SHALL show the reason with a "Try again" action for that insurer.
4. The API SHALL answer with a result per insurer (sent or failed, with the reason).
5. Each send SHALL carry a client-generated id. Repeating a request with the same id (a double click or a retried
   request) SHALL not mail any insurer a second time, and SHALL return the first result.
6. The first insurer becoming Sent SHALL lock the Data Sheet and move the case to RFQ Sent, as marking it sent does
   today.

### Requirement 6: Reminders

**User story:** As a user chasing quotes, I want to remind an insurer that has not answered, so that I can follow up
from the case.

#### Acceptance criteria

1. A user with `proposals.send` SHALL be able to send a reminder to an insurer that is Sent or Reminded.
2. The reminder SHALL use the Reminder template. It SHALL start with the same addresses as that insurer's last mail
   (changeable within the master's addresses), and attach the RFQ again unless the user unticks it.
3. WHEN the reminder is accepted THEN the insurer SHALL become Reminded. Its reminder count SHALL increase and its
   last-reminded time SHALL be set.
4. A failed reminder SHALL leave the status as it was and be logged, as in Requirement 5.
5. Reminders SHALL be sent only when a user asks. The app SHALL not send them on a schedule.

### Requirement 7: Recording responses (E-4)

**User story:** As the placement team, I want to record each insurer's answer, so that everyone sees where the RFQ
stands.

#### Acceptance criteria

1. A user with `proposals.edit` SHALL be able to set an insurer that has the RFQ to Quoted, Declined or No response,
   with an optional note (at most 500 characters).
2. The allowed changes SHALL be:

   | From                          | To                                           |
   | ----------------------------- | -------------------------------------------- |
   | Not sent                      | Sent (by sending, or by marking it sent)     |
   | Sent, Reminded                | Reminded (by a reminder)                     |
   | Sent, Reminded                | Quoted, Declined, No response                |
   | Quoted, Declined, No response | Quoted, Declined, No response (a correction) |

   Any other change SHALL be refused (409). No insurer SHALL go back to Not sent.

3. A reminder to an insurer that is Quoted, Declined or No response SHALL be refused.
4. Each change SHALL be audited (kind Edit) with the status before and after, and SHALL add a line to the case
   activity.
5. No response SHALL be set only by a user. The app SHALL not set it when the due date passes (no such rule is
   agreed).
6. An insurer that is Sent or Reminded after its quote due date (IST) SHALL be shown as Overdue, next to its status.

### Requirement 8: Status on the case

**User story:** As anyone viewing a case, I want to see each insurer's status, so that I know who still has to
answer.

#### Acceptance criteria

1. The "Insurers and RFQ" tab SHALL show for each insurer:
   - its status badge
   - the Overdue flag
   - the quote due date
   - when and by whom it was sent
   - the number of reminders
   - the last response note
2. The case drawer and the full case page SHALL show the same status per insurer.
3. The RFQ page (`/rfq`) SHALL show each insurer's status on every case. Its counts SHALL treat Sent, Reminded,
   Quoted, Declined and No response as sent.
4. Statuses SHALL use one vocabulary across the API and the web app, defined in `src/shared`. The labels SHALL be:
   Not sent, Sent, Reminded, Quoted, Declined, No response.

### Requirement 9: Status on the dashboard

**User story:** As a manager, I want the dashboard to show the state of insurer responses, so that I can see what to
chase.

#### Acceptance criteria

1. The "Awaiting quotes" figure SHALL count insurers that are Sent or Reminded, on open cases.
2. The dashboard SHALL show an "Overdue responses" figure: insurers that are Overdue, on open cases. It SHALL link to
   the RFQ page filtered to those cases.
3. The proposals table's Insurers column SHALL show how many insurers responded (Quoted or Declined) out of those
   listed. A tooltip SHALL give the count per status.

### Requirement 10: Mail log on the case (E-6)

**User story:** As anyone viewing a case, I want to see every mail sent for it, so that I know who was mailed, when
and what they received.

#### Acceptance criteria

1. Every mail the app sends or tries to send (RFQ or reminder) SHALL be stored in the mail log with:
   - the case and the insurer
   - the kind (RFQ or Reminder)
   - the To addresses
   - the subject and both bodies
   - the template version
   - the attachment (file name, type, size and SHA-256)
   - the quote due date
   - the sender and the time
   - the transport
   - the result (Delivered to the mail server, Not delivered (outbox) or Failed) with the server's message id or the
     failure reason
2. Mail log entries SHALL never be changed or deleted.
3. The case's Activity tab SHALL list the mails, newest first, with the kind, the insurer, the To addresses, who sent
   it, when, and the result. Selecting a mail SHALL show its subject and body.
4. A user with `proposals.export` SHALL be able to download the exact attachment a mail carried.
5. Each mail SHALL also add a line to the case activity ("RFQ emailed to Insurer, Branch (a@x, b@x) by Name") and an
   audit entry (kind Send) with the To addresses and the result.
6. Users with `proposals.view` SHALL see the mail log of the cases they can view.

### Requirement 11: Sending outside the app

**User story:** As a user whose mail cannot go through the app (transport off, or an insurer that must be mailed
otherwise), I want to keep recording sends by hand.

#### Acceptance criteria

1. "Mark as sent" SHALL stay available to users with `proposals.send`, for Not sent insurers. Once mail is sent from
   the app, it SHALL be a secondary action labelled "Sent outside the app".
2. Marking it sent SHALL set the quote due date (starting at the case's due date) and the insurer to Sent. It SHALL
   write the activity line "RFQ sent outside the app to …" and the existing Send audit entry. No mail log entry SHALL
   be created.

### Requirement 12: Security and limits

#### Acceptance criteria

1. Recipient addresses SHALL be checked against the insurer master on the server, whatever the client sends.
2. Subjects and addresses SHALL be stripped of line breaks before they reach the transport, so no header can be added.
3. A send SHALL cover at most 5 insurers, and each mail at most 20 addresses.
4. The attachment SHALL be at most 10 MB. A larger RFQ SHALL fail the send with a message.
5. Mail bodies and attachments SHALL be readable only through the case's permissions (Requirement 10).
6. The demo mode of the web app SHALL show sending, reminders and the mail log as not available in demo mode, and
   SHALL never call the API for them.

### Requirement 13: Quality

#### Acceptance criteria

1. Lint, typecheck, tests and the build SHALL pass in both repositories, and `npm run shared:check` SHALL pass in the
   frontend.
2. The tests SHALL cover:
   - the rendering rules (Requirement 2)
   - the status changes (Requirement 7)
   - one mail per insurer with only its own addresses (Requirement 4.8)
   - repeated sends (Requirement 5.5)
   - partial failure (Requirement 5)
   - permissions per role
   - the transports
3. `docs/OPEN_ITEMS.md` SHALL replace the decision "the app does not send email". It SHALL list the template wording,
   the SMTP account and From address, and who may receive the RFQ as open items for the client (Q14).
4. The READMEs and steering files SHALL describe the mail settings, the statuses and the mail log.

## Open questions for the client

These do not block the build. Defaults are in brackets.

1. Q14: is sending from the app wanted in R1? Which SMTP account or SES, and which From address? [Built; production
   stays `off` until configured.]
2. The wording of the RFQ and reminder emails. [Neutral defaults that an Admin replaces.]
3. May the RFQ go to an insurer's named contacts as well as its RFQ addresses? [Yes, if a user ticks them.]
4. Should No response ever be set automatically, and should reminders be scheduled? [No; manual only (RFQ-05, R2).]
5. Should a manager approve an RFQ before it is sent (RFQ-06)? [Not in this spec.]
6. Is RFQ-04's "Acknowledged" status needed besides the plan's Reminded? [Not included.]
