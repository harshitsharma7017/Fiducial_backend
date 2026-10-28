# Open items

Items waiting on the client, and data issues found in the client's IIB workbook (`IIB_Code_Master.xlsx`, uploaded
in the app). Nothing here is implemented
from assumptions; where code needs the answer, it has a named extension point
(`src/modules/rating/extension-points.ts`). Question IDs refer to document 06 (Assumptions, Risks
and Open Questions).

## To be confirmed (TBC)

| ID    | Item                                                                                                                                                                                                           | Question               | Effect until answered                                                                                                                                                                                                                                             |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OI-01 | Add-on premium formulas for the 15 Bharat Sookshma / Laghu covers, and the four "some % on total sum insured" placeholders                                                                                     | Q02, Q28               | No add-on is priced. `calculateAddOnPremiums()` returns nothing; total before tax equals the base premium.                                                                                                                                                        |
| OI-02 | What "policy rate" means: Fire only, Fire + STFI, or Fire + STFI + EQ (+ Terrorism)                                                                                                                            | Q03                    | The rating returns the sum of the component rates it priced (Fire + STFI + EQ, plus Terrorism when entered).                                                                                                                                                      |
| OI-03 | Pricing for the 13 non-fire sections (Burglary, FLOP, Money and so on)                                                                                                                                         | Q23                    | Not priced by the engine; expected to come from insurer quotes.                                                                                                                                                                                                   |
| OI-04 | Terrorism rate source (the master has risk types but no rates)                                                                                                                                                 | Q05                    | Terrorism is priced only when the user enters a rate.                                                                                                                                                                                                             |
| OI-05 | Product thresholds (BSUS up to 5 Cr, BLUS above 5 Cr to 50 Cr, SFSP above 50 Cr, PAR above 5 Cr): total or per-location SI? When is PAR chosen over BLUS?                                                      | Q04                    | No product recommendation is made.                                                                                                                                                                                                                                |
| OI-06 | Meaning of Preferred / Referred / Declined, and which occupancies fall in each (only a legend in column V, no colours)                                                                                         | Q06, MST-08            | No occupancy status is stored or enforced.                                                                                                                                                                                                                        |
| OI-07 | Is the IIB rate a fixed rate or a benchmark insurers discount or load? The master is labelled 2019 rates; is it current?                                                                                       | Q07, Q08               | Rates are shown as in the master.                                                                                                                                                                                                                                 |
| OI-08 | Who may do what in each role, and who approves RFQs and placements                                                                                                                                             | Q12                    | `src/shared/permissions.ts` follows the PRD personas: Approvers approve; Relationship Managers create proposals and send RFQs; Underwriting / Placement staff edit and send; Read-only users only view. The table is in the README.                               |
| OI-09 | Sending the RFQ from the app (E-2 to E-6): which SMTP account (or SES) and From address; the wording of the RFQ and reminder mails; may the RFQ go to an insurer's named contacts as well as its RFQ addresses | Q14                    | Built. Production stays off (`MAIL_TRANSPORT` unset is `off`) until an SMTP account and From address are configured; the mails use neutral default wording that an Admin edits on the Email templates page; contacts receive the RFQ only when a user ticks them. |
| OI-10 | Should reminders go on a schedule and No response be set when the due date passes; should an Approver approve an RFQ before it is sent; is an "Acknowledged" status needed besides Reminded                    | RFQ-04, RFQ-05, RFQ-06 | Reminders and No response are manual only; no approval before sending; statuses are Not sent, Sent, Reminded, Quoted, Declined and No response.                                                                                                                   |

## Decisions taken in this phase (please confirm)

- When a pincode's EQ rate is below the occupancy's minimum EQ rate for that zone, the pincode rate is used and the
  response carries a warning (`EQ_RATE_BELOW_OCCUPANCY_MINIMUM`). The minimum is not applied automatically.
- A blank Fire risk type, a missing IIB or STFI rate, or a missing EQ rate stops the rating with a 422 data error.
- Rates are displayed with at least 2 decimals but never rounded for display: 0.075 and 0.225 appear in the master and
  are shown in full.
- GST is 18% by default (`GST_RATE_PERCENT`).
- The role names in the plan (F-2) are labels on the existing role codes, so stored users keep their roles: `MANAGER`
  shows as Approver, `ACCOUNT_MANAGER` as Relationship Manager and `PLACEMENT_EXEC` as Underwriting / Placement.
- Read-only users cannot run the Fire rate check (`rating.use`): it is a working tool, not a view. Every other role
  can.
- Admins hold every permission, including approve, as `ADMIN` passed every role check before. If approvals must come
  from someone other than the person who prepared the work, Admin has to lose `proposals.approve`.
- The audit log (`GET /api/v1/audit`) is for Admins only, because it holds every user's sign-in email and IP address.
- Activating a master version writes two audit entries, each with old and new values: the new version's activation
  and the previous version's supersession.
- Clients (M-1): the GSTIN is optional, for an insured without GST registration, but unique when given. Only regular
  taxpayer GSTINs are accepted (14th character "Z", checked by state code and check character); UIN, TDS and
  non-resident registrations are rejected. Each client has one occupancy, stored as the code and description chosen
  from the active master. Group and PAN (DS-01, document 05) are not captured yet.
- Who maintains clients: Admins and Relationship Managers (`clients.manage`, "owns the client" in the PRD); every
  role can view them. Underwriting / Placement staff cannot edit clients (Q12).
- Risk locations (M-2): a pincode that is not in the active pincode master cannot be used, because the location's
  state, district and EQ zone come from it. The state shown is the master's, including its spelling issues listed
  below. Construction, floors, fire protection and other per-location details (DS-03) belong to the Data Sheet and
  are not captured here.
- Insurers (M-3): one record per company branch; at least one RFQ email is required. Every role can read the insurer
  master; only Admins change it (`masters.manage`). "Supported schemes" and notes (MST-07) are not captured yet.
- Excel import: the preview checks every row; the user then imports the valid rows they tick, and rows with
  problems are left out (they can be fixed and imported from a later file). Besides the screens' checks it blocks
  a client without a GSTIN whose name already exists, and a location name the client already has, so rows already
  imported show as invalid the second time. Each import holds at most 1,000 rows; a template carries two contacts per row.
- Master corrections: an Admin can add or correct an occupancy or pincode in the active master on screen. The row
  changes in place and its audit entry keeps each field's old and new value; lookups and the Fire rate check use the
  change at once. Larger changes are made in Excel and uploaded as a new version. Risk locations keep the state,
  district and zone they were given when saved. Rows are not deleted on screen.
- Proposals (new business, to the RFQ): the app emails the RFQ itself (OI-09): one mail per insurer, To that
  insurer's chosen addresses from the insurer master only (never Cc or Bcc), with the RFQ attached (Excel or PDF, at
  most 10 MB) and a quote due date. A failed mail leaves that insurer Not sent, to try again. An RFQ sent another way
  can still be marked "Sent outside the app", with its due date. Every mail is kept in the case's mail log, which is
  never changed. The first insurer sent locks the Data Sheet. The Data Sheet captures Fire
  in detail per location and the other 13 sections by sum insured only (Proposed 1 and 2); their detailed schedules
  (stock declarations, money in transit limits, and so on) are not captured yet. The product is chosen at the QCR,
  so the RFQ lists all four for the insurers.
- RFQ Option 2: the Fire Option 2 total adds only the lines given a second figure; lines left blank are not carried
  over from Option 1. Please confirm, or say whether a blank line should count at its Option 1 figure.
- Data Sheet Fire & Burglary (D-3): the 7 items, sub-items and wording follow the client's Data Sheet. Two text
  fixes: "periperals" is spelled "peripherals" (as in the client's RFQ), and a stray "Interiors" line at the end of
  item 3 is left out. Buildings are priced as sq ft × rate exactly, as Excel does; amounts are shown to the rupee. The
  Burglary row offers the contents total (every Fire item except buildings, "all the contents as per Fire section
  except building") as its sum insured; it is not filled in automatically, since Burglary may be on first-loss basis.
- Other sections (D-4, D-5): an annexure section's sum insured is its items' total, and FLOP's is its annual gross
  profit. Money, Fidelity and Public Liability keep a typed sum insured: their lines are limits and counts, and how
  they make the section's sum insured is not stated in the formats. Fidelity follows the Data Sheet's three lines; the
  RFQ format also has "Limit Per Event", which is not captured yet.
- The Data Sheet's 14 "details of risk features" (number of floors, CCTV, paint booth and others) differ from the 9
  "risk details" of the RFQ that the app captures today; aligning them is still to do.
- Proposals cannot be deleted or reopened after the RFQ is sent, or reopened once closed.
- The 9 stages (D-1): Draft, Data Sheet, RFQ Sent, Quotes Received, QCR, Client Approval, Placement Slip, Placed,
  Closed (chosen with the client's team). Until the quote, QCR and placement screens exist, the team moves a case
  through Quotes Received to Placed by hand, one stage at a time; Closed needs a reason.
- Renewals (D-2): last year's policy comes from the policy administration software's public API. Its documentation
  has not been received, so `existing-policy-source.ts` assumes a contract (GET `/policies/latest?gstin=&name=` with a
  bearer key; insurer, policy number, period, sections with sum insured and premium, optional Fire lines and premium
  totals). Please send the API's documentation (URL, authentication, how a client is identified, the answer's
  fields) so the adapter can be matched to it. Until `EXISTING_POLICY_API_URL` is set, renewals are created without
  the Existing column. The renewal copies the policy at creation; later changes in the software are not followed
  unless someone fetches it again before the RFQ is sent.
- Product and cover masters (M-4 to M-9): all six are loaded from one Excel workbook and edited on screen by Admins.
  Each sheet uploaded replaces its master as a whole. The filled workbook was built from the client's RFQ and QCR
  workbooks (sections, add-on lists, notes) and from document 05 (add-on rates).
- Products are suggested from the proposal's total Fire sum insured (Option 1): "up to" includes the limit, "above"
  excludes it, so 5 Cr exactly suggests BSUS and 5 Cr + 1 suggests BLUS and PAR. Several products can be suggested;
  the first is used until the team chooses one on the Data Sheet (C-1). A product outside the suggestion needs a
  reason. Whether the QCR may still change it is Q04.
- Add-on lists per product (C-4): unless the product master's "Add-on lists" column says otherwise, BSUS and BLUS use
  the BSUS & BLUS list, SFSP the SFSP list and PAR the PAR list. Which product uses the "Fire-Additional Addon" list
  is not known: please say, and it is set in that column.
- RFQ approval (R-5): the latest version must be approved (by `proposals.approve`: Approvers and Admins, Q12)
  before the RFQ is emailed or marked sent; a change to the case or the RFQ's edits after approval needs a new
  version. An approver may approve a version they submitted themselves. Edits made on the RFQ (heading, notes, risk
  details, claims) do not change the Data Sheet. Please confirm.
- QCR (QC-1 to QC-6): premiums compare Fire without terrorism, as the client's QCR heads its columns; the lowest
  total is marked whatever the quote's deviations, which are listed beside it. The client's QCR has no place for the
  recommendation, remarks or coverage differences, so they are added below "Cheque / payment in favour of"; the
  terrorism note gets the recommended insurer's extra premium per option. Approval is by `proposals.approve`
  (Approvers and Admins, Q12). Please confirm, and give the QCR email's wording (Q14).
- Quotes (Q-1 to Q-5): premiums take paise; GST is worked out on the net premium at the case's rate and rounded
  half up to the paisa. Deductibles and conditions are free text, so they are not compared with the RFQ; capacity is
  the insurer's share of the risk in %. A decline is per insurer (all options), with its reason; recording a quote
  for a declined insurer moves it back to Quoted. Please confirm these, and whether GST should be on the total
  rounded to the rupee as on the client's QCR.
- Cover toggles (C-6): the toggles of each section are the add-on covers the coverage section master lists for it
  (the RFQ's "Addon coverages" rows), so a "Floater clause" toggle exists where the master lists it (Fire - Floater).
  Unanswered covers print blank on the RFQ. Please confirm this is the set of toggles wanted per section.
- Burglary basis (C-3): the RFQ format has rows for 100%, 25% and 50%; a 75% row is added when chosen. Option 2 of
  the contents adds only the contents lines given a second Fire figure, as the Fire Option 2 total does.
- Sections switched off are left out of new Data Sheets and the RFQ, but a proposal that already includes one keeps
  it. Fire cannot be switched off and is always first. Schedule lines are stored for each section but the Data Sheet
  still captures the other sections by sum insured only.
- GST: each proposal keeps the rate in force on the day it was created; the Fire rate check uses today's rate.
- Document templates (R-3, R-4): the RFQ is filled into the client's uploaded "Fiducial_RFQ format.xlsx". Where the
  template has no place for a figure the engine adds one: a seventh Fire line ("Any other items") when it has an
  amount, annexure rows beyond three, product rows and the NOTE rows above the footer. In EEI, MBD and Boiler the
  template merges "As per Annexure" across the figure columns, so the total is written into that label ("As per
  Annexure — Option 1 ₹45,00,000") rather than breaking the merge. The premium details' Option 1 block quotes the
  existing sum insured, as its heading says, so sections the last policy did not have are blank there. The client's
  red and blue text in the template is kept as they coloured it. Please confirm these choices.
- Standard notes: the Data Sheet note is marked to print on the RFQ too, as the RFQ format has no NOTE of its own.
  The Data Sheet, QCR and Placement Slip notes print once those exports exist.
- BSUS/BLUS add-on rates: the 15 rows were typed from the table in document 05, which was itself read from the two
  chart images. Please check them line by line against the Sookshma and Laghu charts. The add-on premium formula
  (rate factor % × policy rate × cover amount) reproduces document 05's worked example; "policy rate" is still Q03.
  The RFQ/QCR "BSUS & BLUS-Addon" sheet is kept as a list (12 paid, 8 inbuilt); four of its limits still read "some %
  on total sum insured" (Q28).
- Add-on lists: the PAR sheet has 125 rows numbered up to 126 (one number is skipped); the numbers are kept as given.
- Insurer statuses: an insurer that has the RFQ can be reminded (Sent or Reminded only) or given an answer (Quoted,
  Declined, No response, with a note); an answer can be corrected to another answer, and nothing goes back to Not
  sent. Overdue is shown, not stored: Sent or Reminded after the insurer's quote due date (India time).
- Without `MAIL_FROM`, the development outbox uses the placeholder From `rfq@outbox.invalid`; outbox mails are never
  delivered.
- Clients, risk locations and insurers are never deleted. Insurers can be deactivated; clients and locations cannot
  until the client confirms how records referenced by proposals should be retired.

## Group health insurance (GHI, G1 to G7)

Built beside Property, in its own collections (`ghi_cases`, `ghi_members`, `ghi_census_imports`, `ghi_rfqs`,
`ghi_quotes`, `ghi_qcrs`, `ghi_payments`, `ghi_files`, `ghi_dispatches`) and routes (`/api/v1/ghi`). No Property
collection, route or screen changed behaviour; the only Property-side UI change is the "Line of business" choice on
New proposal, which links to the GHI form. Collections and indexes are created at startup by `ensureIndexes()`; no
existing data is migrated.

### To be confirmed (GHI)

| ID     | Item                                                                                                                                        | Effect until answered                                                                                                                                                                                         |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GHI-01 | Eligibility age limits per relationship (employee, spouse, children, parents)                                                               | Configurable per case on the Data Sheet; blank (no limit) by default. Nothing is assumed.                                                                                                                     |
| GHI-02 | Endorsements: adding or removing members, or changing terms, after the RFQ has gone out or the policy is issued                             | Not built. The Data Sheet and census lock once the RFQ goes to an insurer (as Property's Data Sheet does); the screen says changes after that are endorsements.                                               |
| GHI-03 | Who approves the GHI RFQ and QCR                                                                                                            | `proposals.approve` (Approvers and Admins), as on Property (Q12). An approver may approve work they submitted.                                                                                                |
| GHI-04 | Whether the placement slip may be issued before the full premium is received (part payment, credit, CD account)                             | The case moves to Placement Slip, and the slip and policy can be recorded, only when RECEIVED payments cover the final total premium.                                                                         |
| GHI-05 | Client's GHI formats (RFQ, QCR, placement slip) and the GHI email wording                                                                   | Built-in layouts (Excel and A4 PDF through the document engine, with the RFQ template's letterhead when uploaded). Mails reuse the Admin-edited RFQ and QCR email templates.                                  |
| GHI-06 | Should dependants' sums insured be allowed to differ from the employee's in a family floater; may individual cover mix sums within a family | Floater: a dependant's sum insured must be blank or the employee's. Individual: each member gives one of the offered sums insured.                                                                            |
| GHI-07 | Waiting-period terms to compare (which waivers map to which waiting periods)                                                                | Initial 30-day ↔ initial days; two-year exclusions ↔ specific diseases months; pre-existing ↔ pre-existing months; 9-month maternity ↔ maternity months. First-year exclusions are compared as a yes/no only. |
| GHI-08 | Payment statuses and modes                                                                                                                  | Pending, Received, Failed/bounced; Cheque, NEFT, RTGS, IMPS, UPI, DD, Other.                                                                                                                                  |

### Decisions taken (please confirm)

- Permissions reuse the proposal permissions: view `proposals.view`, create `proposals.create`, Data Sheet, census,
  quotes, QCR drafts, client decision, final QCR, payments and policy `proposals.edit`, approvals `proposals.approve`,
  mails `proposals.send`, downloads `proposals.export`. Every case record, member, quote, QCR, payment and file is read
  through its own case id, so an id from one case never opens another case's record.
- Stages follow the work: New/Renewal → Data Sheet (first save) → RFQ (first version generated) → QCR (first final
  quote) → Approval (QCR submitted) → Final QCR (client accepted) → Payment (final terms recorded) → Placement Slip
  (premium covered). A rejected QCR, or a client's rejection, sends the case back to QCR. Recording the policy marks
  it placed. A case can be closed with a reason until placed.
- Ages are completed years on one reference date per case: the Data Sheet's, else the policy start, else the day the
  case was created. Age bands 0–18, 19–35, 36–45, 46–55, 56–65, 66+.
- Total sum insured: family floater adds each employee's (family) sum insured; individual adds every member's.
- Census rules: one employee row and one spouse per employee ID; at most three children (fewer if the Data Sheet
  says so); father, mother, father-in-law, mother-in-law at most once each and never parents mixed with in-laws; a
  dependant needs its employee's row; a father / father-in-law cannot be Female and a mother / mother-in-law cannot
  be Male; exact duplicates (relationship, name, date of birth) are refused. The date of joining is checked (not
  before the date of birth) on the employee's row only, as HR files repeat it on dependants' rows. Two-digit years
  are refused rather than guessed; dates are read day first.
- Import: every row is checked first with its Excel row number, field and message; rows can be corrected on screen;
  the import policy is chosen explicitly (all rows valid, or valid rows only) and runs in one transaction, checked
  again against the census at that moment. The same census content cannot be imported twice into a case (the
  fingerprint is of the rows, so re-saving the file in Excel does not get round it); rows already in the census are
  flagged as duplicates. At most 10,000 rows per file.
- Quotes: GST at the case's rate (from the tax master when the case was created, 18% by default) on the base premium,
  rounded half up to the paisa; total = base + GST; decimal arithmetic on the server only. A draft can change; a
  recorded quote never does; a revision is a new version and needs its reason. The QCR compares each insurer's latest
  recorded quote (at most five); the lowest total is marked whatever its deviations, which are listed beside it.
  Maternity not covered at all counts as a deviation on each requested maternity limit.
- An RFQ or QCR is reported as sent only when the mail transport accepted it (the development outbox says "kept in the
  outbox, not delivered"). A failed mail leaves the insurer Not sent. "Sent outside the app" is recorded as such.
- The final QCR is a new quote version (kind FINAL_AGREED) for the insurer the client chose; the earlier quotes and the
  accepted QCR are unchanged. Final terms cannot change once premium has been received against them.
- The policy record links the company (client), case, insurer, accepted QCR, final quote and a snapshot of the census
  (employees, lives, total sum insured, census revision) with the policy copy and renewal date.

## Group health claims (C1 to C4)

Built beside GHI and Property in new collections only (`claims`, `claim_files`, `claim_events` — append-only,
`claim_notifications`, `claim_links`, `claim_email_templates`, `claim_hr_contacts`), routes `/api/v1/claims` (staff)
and `/api/v1/claim-links` (the employee's link, no sign-in), and three new permissions (`claims.view`,
`claims.process`, `claims.admin`). No existing permission was changed. A background worker started by `server.ts`
sends queued claim emails and retries failed ones every 30 seconds.

### To be confirmed (claims)

| ID     | Item                                                                                                    | Effect until answered                                                                                                                                                                                                                                      |
| ------ | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLM-01 | Who processes claims and who administers them                                                           | `claims.process`: Relationship Managers and Underwriting / Placement; they move only the claims assigned to them. `claims.admin`: Admins (any claim, reassign, templates, HR contacts). Approvers view only. Read-only users see no claims (medical data). |
| CLM-02 | Further statuses (Rejected, Settled / Paid, Query raised) and backward moves                            | Not built. Only Form → Submitted → Investigation → Approved, one step forward. Adding a status means adding it to `CLAIM_STATUSES` and `CLAIM_TRANSITIONS` in `src/shared/claims.ts`; its email templates follow.                                          |
| CLM-03 | Documents required before Submitted                                                                     | Medical bills, discharge summary and ID proof, one of each (`REQUIRED_CLAIM_DOCUMENTS`).                                                                                                                                                                   |
| CLM-04 | Discharge date of a cashless claim                                                                      | A cashless claim may give a future (expected) discharge date; a reimbursement claim may not. Admission must be within the policy period and not in the future.                                                                                             |
| CLM-05 | Whether the amount claimed must be checked against the member's sum insured or the corporate buffer     | Not checked: the amount must be above 0 only.                                                                                                                                                                                                              |
| CLM-06 | Submission link defaults: how long it stays valid, how many claims it allows, and whether it is emailed | Staff choose 1–30 days (7 by default) and 1–10 claims (1 by default) and copy the link themselves; it is not emailed by the app. The employee can add documents while the claim is in Form only.                                                           |
| CLM-07 | Delivery confirmation                                                                                   | Emails show "Accepted by the mail server"; delivery to the inbox is not confirmed, as the SMTP transport gives no delivery receipts. Bounces are not read.                                                                                                 |
| CLM-08 | Wording of the claim emails                                                                             | Neutral default wording per status, for the claimant and for HR; Admins edit it (Claims → Emails and HR).                                                                                                                                                  |
| CLM-09 | Where the HR contact comes from                                                                         | Set per company on Claims → Emails and HR (name, email, on/off), off until set. Not taken from the GHI Data Sheet's HR contact automatically.                                                                                                              |
| CLM-10 | Retention of medical documents                                                                          | Kept with the claim indefinitely, in the database like other case files; nothing is deleted.                                                                                                                                                               |

### Decisions taken (please confirm)

- Claims are made on placed GHI policies only (the policy recorded on the GHI case, case not closed). The patient
  must be the employee (their Self census row) or one of their dependants in that policy's census; the company must
  be the policy's. All checked on the server for staff and for the link.
- A move needs a remark, the status the user saw (a stale board gets a 409, never a double move), the move allowed
  by `CLAIM_TRANSITIONS`, and the user to be the assignee or an Admin. Refused moves save nothing and email no one.
- The move, its timeline event and the emails it owes are written in one transaction; the emails are sent after the
  commit (outbox pattern). A failed email never undoes the move. Each email is tried up to three times automatically
  (after 1 and 5 minutes), then stays Failed with a Retry button; mail turned off fails at once without retries. Every
  try is a timeline event (append-only) and an audit entry. One email per move and address (unique index), and a
  send is taken atomically, so retries and parallel workers never email twice; a crash mid-send is retried after 10
  minutes, which can repeat an email the server had already accepted (at least once).
- The link's token is 32 random bytes, shown once, stored only as its SHA-256 hash, carried after `#` in the address
  and in the `X-Claim-Link-Token` header (never in a URL path or query, so not in server logs). Public endpoints are
  rate-limited per IP. The link can read its own policy and family, submit claims into Form, and add documents to its
  own claims while in Form; nothing else.
- Documents: PDF, PNG or JPEG (checked by content, not name), up to 10 MB, at most 30 per claim, served with
  `Cache-Control: no-store`; each opening is audited (`CLAIM_DOCUMENT_DOWNLOADED`). Audit snapshots of claims carry
  no patient names or dates of birth.
- New claims made by staff are assigned to their creator; claims from a link to the staff member who issued it.

## Employee Benefits: GPA, GTLI, family plans and census templates (N1 to N3)

Built beside GMC (the GHI cases above) and Property. GPA and GTLI cases live in the GHI collections with a `product`
field (`GMC` when absent, so existing cases read as before) under `/api/v1/eb/gpa` and `/api/v1/eb/gtli`; the lists
of every product, the census templates and a company's employees and default plans are under `/api/v1/eb`; the
Family Plan Master is under `/api/v1/family-plans`. New collections: `family_plans`, `eb_client_plan_defaults`,
`eb_employees`, `eb_census_imports`, and the append-only `eb_policy_snapshots` and `eb_policy_snapshot_members`. New fields are additive with indexes
created at startup; no existing data is migrated or rewritten. `/api/v1/ghi` keeps its routes and response shapes;
it gained only optional additions (`PUT /cases/:id/plan`, `?mode=` on the import preview, the error report, `mode` on
commit). Permissions are unchanged (`src/shared/permissions.ts`): cases and census use the proposal permissions,
family plans `masters.view` / `masters.manage`, company plan defaults `clients.view` / `clients.manage`.

### Provisional census templates

No client census format was in either repository, so the seven templates below are Fiducial's own layout, built
from the plan and the case's Data Sheet. Each says so on its Instructions sheet and beside every download, until the
client sends their formats (open question 15).

| Template      | Plan it follows | Census columns                                                                               |
| ------------- | --------------- | -------------------------------------------------------------------------------------------- |
| GMC Self      | GMC Self only   | Employee ID, Name, Gender, Date of Birth, Date of Joining, Sum Insured                       |
| GMC 1+3       | GMC 1+3         | as GMC Self, plus Relationship (Self, Spouse, Child)                                         |
| GMC 1+5       | GMC 1+5         | as GMC 1+3, with Father, Mother, Father-in-law, Mother-in-law                                |
| GMC 1+7       | GMC 1+7         | as GMC 1+5                                                                                   |
| GPA Self Only | GPA Self only   | Employee ID, Name, Gender, Date of Birth, Date of Joining, then Sum Insured or Annual Salary |
| GPA 1+3       | GPA 1+3         | as GPA Self Only, plus Relationship (Self, Spouse, Child)                                    |
| GTLI          | GTLI Self only  | as GPA Self Only                                                                             |

For GPA and GTLI, Sum Insured is the column for a flat or graded basis, Annual Salary for a multiple of salary, and
both (neither required) when the case's basis is not chosen yet. Dates are DD/MM/YYYY (day first) or Excel dates.

### Default family plans (awaiting client confirmation)

Created once at startup if missing (never changed by a later start), each with version 1 from 2000-01-01 and marked
"Awaiting client confirmation" until an Admin records the client's confirmation on the plan's page.

| Plan           | Slots (minimum to maximum)                                                                      | Parents and in-laws mixed | Open questions |
| -------------- | ----------------------------------------------------------------------------------------------- | ------------------------- | -------------- |
| GMC Self only  | Self (1)                                                                                        | n/a                       | 16             |
| GMC 1+3        | Self (1); Spouse (0 to 1); Children (0 to 3)                                                    | n/a                       | 3, 8, 16       |
| GMC 1+5        | Self (1); Spouse (0 to 1); Children (0 to 3); Parents (0 to 2: father, mother, in-laws, 1 each) | Allowed                   | 3, 4, 8, 16    |
| GMC 1+7        | as GMC 1+5 with Parents (0 to 4)                                                                | Allowed                   | 3, 4, 8, 16    |
| GPA Self only  | Self (1)                                                                                        | n/a                       | 16             |
| GPA 1+3        | Self (1); Spouse (0 to 1); Children (0 to 3)                                                    | n/a                       | 3, 8, 16       |
| GTLI Self only | Self (1)                                                                                        | n/a                       | 6, 16          |

Each product's plans are separate data: changing GMC 1+3 never changes GPA 1+3. A case keeps a copy of the version
it was given, and a placement keeps its own snapshot, so a later version changes neither.

### Open questions for the client (defaults in brackets)

| ID    | Question                                                                                                                 | Default built                                                                              |
| ----- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| EB-01 | GPA and GTLI workflow: is the client's decision recorded before payment; is a Final QCR or policy step needed as on GMC? | Client decision within Approval; no Final QCR; the placement slip places the case.         |
| EB-02 | Is the policy number and copy recorded for GPA and GTLI?                                                                 | Optional policy number and dates on the placement slip.                                    |
| EB-03 | Does 1+3 mean spouse and two children, or spouse and three children (GMC and GPA)?                                       | Three children; each product's plan can change on its own.                                 |
| EB-04 | 1+5: which two parent members, and may parents and parents-in-law be mixed? (GMC today forbids mixing.)                  | Any two of father, mother, father-in-law, mother-in-law; mixing allowed.                   |
| EB-05 | Must new GMC cases use the Family Plan Master; should existing GMC cases move to it?                                     | Optional on new GMC cases; existing cases keep their Data Sheet family definition.         |
| EB-06 | Does GTLI cover only employees?                                                                                          | Yes: GTLI Self only is the default plan.                                                   |
| EB-07 | GPA and GTLI sum insured basis (flat, graded, multiple of salary) and its cap                                            | Asked per case on the Data Sheet.                                                          |
| EB-08 | May a plan allow more than one spouse?                                                                                   | No: at most one.                                                                           |
| EB-09 | Rounding of a sum insured from a multiple of salary                                                                      | Half up to the rupee, then the cap.                                                        |
| EB-10 | Standard GPA covers (death, PTD, PPD, TTD) and how they are limited                                                      | Required / Not required per cover; limits recorded as amounts or text; TTD weekly benefit. |
| EB-11 | How a GPA dependant's sum insured is set                                                                                 | Asked per case: the employee's, the dependant's own, or a percentage of the employee's.    |
| EB-12 | GTLI free cover limit and medical evidence                                                                               | Recorded; members above it are flagged (warning, summary count); not enforced.             |
| EB-13 | Age limits per product and relationship; should they belong to the plan?                                                 | Per case on the Data Sheet, blank by default.                                              |
| EB-14 | Does GPA need an occupation or risk class per employee?                                                                  | Not captured.                                                                              |
| EB-15 | The client's GMC, GPA and GTLI census formats and RFQ, QCR and placement slip layouts                                    | Provisional Fiducial templates and built-in layouts.                                       |
| EB-16 | May an unconfirmed plan be assigned to cases and sent in an RFQ?                                                         | Yes, shown as awaiting confirmation.                                                       |

### Design points built as designed (please confirm)

- **D6, "parents covered" on GMC with a plan.** Where GMC asks whether the cover includes parents (co-payment row,
  missing items, Data Sheet check, documents), one helper answers: with no plan, the Data Sheet's family definition as
  today; with a plan, whether a slot accepts a parent or parent-in-law. The co-payment check moved from the schema
  into the service (same path, message and 400). Different co-payments for parents and in-laws are not asked.
- **D7, identity checks on GMC.** A GMC Self row whose name, gender or date of birth differs from the company's
  employee record is refused, as on GPA and GTLI. This is the one way a GMC row accepted before can now be refused.
  The alternative (no identity checks on GMC cases without a plan) is one flag (`identityChecks`).
- **D8, GMC commit without a mode.** It works as before (a row equal to a member is a duplicate error). A GMC commit
  naming a mode, and every GPA/GTLI commit, follows Add new only / Add and update.
- **D10, replacing the client's decision at Payment.** Allowed while no payment is Received, as an acceptance only; a
  rejection at Payment is refused (409) and the case can be closed instead.

### Other decisions and deviations (please confirm)

- EB routes mirror the GHI paths (`/rfq/generate`, `/qcrs/:id/client-decision`, `/placement-slip`, …) so the shared
  screens call the same paths with a product prefix.
- A GPA case whose dependants have their own amount, with a multiple-of-salary basis, gets an extra optional Sum
  Insured column for the dependants' amounts.
- The stage rule never moves a case into Closed: closing is its own action with a reason.
- Excel date serials are read when they have 4 or 5 digits (to 13 October 2173), as GMC does today; later serials are
  refused and the date can be typed as DD/MM/YYYY. Widening this would also read 6-digit text such as 010490 as a
  serial, so it was left as is.
- Placing a GPA or GTLI case freezes its census, plan copy and agreed premium in an append-only snapshot; the case is
  then read-only (409 `EB_PLACED`).

## Age bands, GPA rules and nominees, GTLI sum assured, RFQ selection summary (N4 to N7)

Built on the N1 to N3 cases, census and documents. New collection: `age_band_sets`. Additive fields (missing on
records stored before, which read as before): `ghi_cases.ageBandSelection` and `policy.ageBands`; `ghi_members.monthlySalary`
and `nominee`; `ghi_rfqs.ageBands` and `selectionSummary`; `eb_policy_snapshots.requirements` and `ageBands`;
`eb_policy_snapshot_members.monthlySalary`, `nominee` and `coverageBasis`. Nothing is migrated or rewritten.
Permissions are unchanged: the Age Band Master needs `masters.view` / `masters.manage`; choosing a case's bands
`proposals.edit`; the selection summary `proposals.view`, its download `proposals.export`.

### To be confirmed (N4 to N7)

| ID   | Item                                                                                    | Effect until answered                                                                                                                                                                                                  |
| ---- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AB-1 | Option 2's age bands: the client's example overlaps                                     | Not created. An Admin defines it on Masters → Age bands with the exact boundaries. Option 1 (0–18, 19–25, 26–35, then 36–40 … 86–90), the custom example (0–35, 36–45, 46–50) and the standard bands are created once. |
| AB-2 | Members older (or younger) than the last (first) band of the chosen set                 | Counted on their own "Outside the age bands" row, never put in the nearest band; the RFQ and the summary download wait until the set covers them.                                                                      |
| AB-3 | The age reference date                                                                  | As before: the Data Sheet's age reference date, else the policy start, else the day the case was created. A child born after it is age 0.                                                                              |
| NM-1 | Which members need a nominee (GPA, GTLI)                                                | A setting on the Data Sheet: each employee's row (what a new case starts with), every member, or not required. A Data Sheet saved before N5 (no setting) asks for none, so cases in progress are not blocked.          |
| NM-2 | A minor nominee's appointee; several nominees with shares                               | Not captured. One nominee per member (name, relationship, date of birth or age), so a member never has duplicate nominees.                                                                                             |
| NM-3 | Nominee relationships                                                                   | Spouse, Son, Daughter, Father, Mother, Brother, Sister, Other.                                                                                                                                                         |
| GP-1 | GPA cover by relationship                                                               | A rule per relationship on the Data Sheet: a percentage of the employee's sum insured, a fixed amount, the employee's amount, or the member's own. Spouse 50% and child ₹50,000 are offered as sample values only.     |
| GP-2 | Limits on dependants' amounts (for example a child's amount never above the employee's) | None applied; the amounts follow the rules exactly.                                                                                                                                                                    |
| GT-1 | The salary the GTLI (or GPA) census gives                                               | A Data Sheet choice: the annual salary, or the monthly salary with annual CTC = monthly × 12. Whole rupees above 0. Sum assured = annual CTC × multiplier, half up to the rupee (open question 9), then the maximum.   |
| GT-2 | Multiplier and maximum per company                                                      | Set per case (policy) on the Data Sheet; no company-wide default is built. The maximum is optional.                                                                                                                    |
| SS-1 | The client's layout of the RFQ Selection Summary Sheet                                  | Not in the repository: Fiducial's built-in layout (sections A to D), as its own download and as an extra sheet of every RFQ version's Excel and PDF.                                                                   |
| SS-2 | Family floater in the age band matrix                                                   | Lives only: a family's sum insured is counted once, on the employee, and is not split by age.                                                                                                                          |

### Decisions taken (please confirm)

- A case keeps a copy of the age band set it was given (like its family plan). Editing a set raises its revision and
  changes no case; choosing the set again takes the new revision. Choosing bands raises the Data Sheet revision, so an
  RFQ generated with other bands is out of date. Bands cannot change once the RFQ has gone to an insurer.
- Each RFQ version keeps the bands it was generated with and its selection summary, never recalculated
  (`GET …/rfq/versions/{rfqId}/selection-summary`). The live summary is worked out from the census as stored.
- The summary is refused for download (409 `EB_SUMMARY_INCOMPLETE`) and blocks the RFQ while members have no cover,
  no valid date of birth, or are outside the bands; the screen lists the problems. A GMC case on the standard bands is
  checked exactly as before (its own wording for an empty census or missing sums insured).
- Placing a GPA or GTLI case also freezes the Data Sheet's cover rules, the age bands and each member's cover basis;
  recording a GMC policy keeps the age bands.
- "Add and update" may now also change a member's monthly salary and nominee.
- GMC never asks for a nominee or applies GPA rules; GTLI documents and screens say "sum assured".

## TPA claims, claims board, claims analysis, renewal analysis and sensitive data (N8 to N13)

Built on the placed GMC, GPA and GTLI policies and the claims board (C1 to C4). New collections: `tpa_formats`,
`tpa_imports`, `tpa_import_rows`, `tpa_claims` (unique per policy, TPA code and claim ID), `tpa_claim_events`
(append-only), `policy_premium_adjustments` (voided, never deleted), `claim_import_settings`, `recorded_policy_years`
and `renewal_reports` (never changed once saved). Additive fields on `claims` (missing on claims stored before, which
read as before): `settlement`, `tpa`, the source value `TPA_IMPORT`, and `contactEmail` may be null for a claim a TPA
import added. One new index on `claims` (`ghiCaseId`, `patient.memberId`, `admissionDate`). Nothing is migrated,
rewritten or deleted; staff-made and link-submitted claims behave as before. Permissions are unchanged (no new role
or permission): TPA formats and import emails need `claims.admin`; checking and importing files `claims.process`;
reading imported claims and the claims analysis `claims.view`; endorsement premiums `proposals.edit`; the renewal
analysis `proposals.view`, recording years and saving reports `proposals.edit`, downloads `proposals.export`.

### Client files not available: BLOCKED

| ID    | Item                                                                                                                                  | Status and what was built                                                                                                                                                                                                                                                                       |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TPA-1 | The TPAs' claims export layouts (columns, header row, status words)                                                                   | BLOCKED. Formats are configured per TPA by an Admin (TPA claims → TPA formats), from a real file read with "Read the headers of a sample file". Tested only on synthetic layouts.                                                                                                               |
| CA-3  | The client's claims analysis layout                                                                                                   | BLOCKED. Fiducial's own layout (sections A to F, then the claims), as Excel and PDF.                                                                                                                                                                                                            |
| BC-3  | The client's benefit and cost (renewal) analysis layout                                                                               | BLOCKED. Fiducial's own layout: one column per year, the change between years, the quotes.                                                                                                                                                                                                      |
| AC-1  | The client's claims dump (61 reported, 48 settled, ₹27,33,627 settled, 10 outstanding, 3 rejected; ICR 84.96% prorated, 81.24% total) | BLOCKED. The figures cannot be checked without the dump and its premium and endorsements. They appear nowhere in the code or tests. A synthetic file of the same shape (61 / 48 / 10 / 3) is checked against figures worked out independently from its rows (`test/claims-acceptance.test.ts`). |
| CT-1  | The client's census templates                                                                                                         | BLOCKED. The provisional templates (N1 to N3) stay; they are tested on synthetic files only.                                                                                                                                                                                                    |

### To be confirmed (N8 to N13)

| ID    | Item                                                              | Effect until answered                                                                                                                                                                                                                                                                                       |
| ----- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TPA-2 | Which TPA statuses mean settled, outstanding, rejected, withdrawn | Each format maps each status word. A word not mapped makes its row an error, never a guess. The client's examples are offered as starting values only.                                                                                                                                                      |
| TPA-3 | A claim's identity across files                                   | The TPA's claim ID (spaces removed, case ignored) within the policy and TPA code. Re-importing a file updates the same record; unchanged rows write nothing. Members are matched by employee ID and relationship (then date of birth, then name within the family), never by name alone.                    |
| TPA-4 | Pre-authorisations and pre/post-hospitalisation records           | Counted once: a pre-auth or pre/post record linked to its main claim (by the main claim ID column) is part of that claim and not counted again. One whose main claim is not in the data is counted on its own, and listed for review.                                                                       |
| TPA-5 | A claim with the same patient and admission date as a board claim | Linked to that board claim. Two candidates, or a board claim another TPA record already drives, are left for a person to link by hand.                                                                                                                                                                      |
| N11-1 | "Settled" on the claims board                                     | Kept apart from the board column: a claim shows "Settled" (amount and date from the TPA) in whatever column it is in. No new board column was added, so the board's moves, emails and templates are unchanged. Adding a Settled column needs the client's decision.                                         |
| N11-2 | Emails when a TPA import changes the board                        | OFF by default (Admin setting on TPA formats: "Emails from TPA imports"). Staff moves email as before. Each import's board event records whether an email was sent and why not. No email ever carries a diagnosis, ICD code or bank account.                                                                |
| N11-3 | Which TPA statuses move a board claim, and to which column        | Per format (and per company over it): e.g. Registration → Submitted, For Investigation → Investigation, Settled → Approved, as the client's examples. A status not mapped moves nothing and is reported after the import. Moves are forward only by default (a format may say never).                       |
| N11-4 | Board claims for TPA claims not on the board                      | Added for placed GMC policies only (the board holds GMC), when the patient is matched to the census and the file gives the admission date, hospital, claim type and claimed amount. Added unassigned, with no claimant email. Others are listed with the reason.                                            |
| ICR-1 | Prorated premium                                                  | Earned by days in force, both ends included: the premium as placed × days from the policy start to the reporting date ÷ policy days, and each endorsement × days from its effective date ÷ days from that date to the policy end, each rounded to the paisa.                                                |
| ICR-2 | Outstanding claims in the ICR                                     | Reserved at the sanctioned amount, else the claimed amount (a filter offers the claimed amount instead). Rejected and withdrawn claims count nothing.                                                                                                                                                       |
| ICR-3 | Premium for the ICR                                               | Before GST: the placed premium plus additions less deletions recorded as endorsements. Without a recorded premium the ICR is not shown and the reason is given.                                                                                                                                             |
| CA-1  | Claims analysis age bands                                         | A seeded set "Claims analysis": 0–10, 11–20 … 61–70, Above 70 (age at admission); any other active set can be chosen. Age not known is its own row.                                                                                                                                                         |
| CA-2  | Disease groups                                                    | ICD-10 chapters (WHO 2019; ICD-10-CM codes of the same chapters accepted). A missing or unreadable code is "Unclassified", never guessed from the diagnosis text.                                                                                                                                           |
| BC-1  | Renewal figures for years before the app                          | Recorded by hand with their source; a missing figure stays empty and the report says why (no average or ratio from a missing or zero denominator).                                                                                                                                                          |
| BC-2  | Claims for a year placed in the app                               | From its imported TPA claims, counted to the chosen date; a year with no import shows no claims figure.                                                                                                                                                                                                     |
| SEC-1 | Who sees diagnoses and bank accounts                              | Diagnosis, ICD code and rejection reason: `claims.process` only (on screens, previews, problems reports and downloads). Full bank account: `claims.admin` only; everyone else sees XXXXXXXX9012. On board claims, the patient's date of birth and the phone are hidden from users without `claims.process`. |

### Decisions taken (please confirm)

- Every view of claim data (board, list, claim, TPA claims, import preview, claims analysis) and every download is
  audited with who, what and when, never the data; every refused request for claim data is audited too
  (`CLAIM_ACCESS_DENIED`). Audit entries never hold diagnoses, ICD codes, rejection reasons, full bank accounts or
  phone numbers.
- A TPA file is checked in full before anything is saved; importing is all rows (refused while any row has an error)
  or the valid rows only. One import per policy and TPA runs at a time. Each batch of 500 rows is saved in its own
  transaction; a failed batch is reported and the rest kept.
- Large files are read row by row (at most 25 MB and 50,000 claim rows). The reader rebuilds the workbook's parts in
  a safe order first: ExcelJS's streaming reader otherwise loses the shared strings or styles of some files.
- A TPA format's TPA code cannot change once claims are imported under it; another layout of the same TPA is another
  format with the same code.
- Saved renewal reports keep their figures as saved; a later correction of a recorded year changes only new analyses.

## Quote PDF auto-fill (Q1)

On the property quote form, "Fill the form from this PDF" reads a kept PDF (`POST /proposals/{id}/quote-attachments/{attachmentId}/read`, `proposals.edit`) with `pdfjs-dist` 4.10.38 (the one package added; it needs Node 20 or later) and puts candidate premiums (Fire with and without terrorism, other sections) and the valid-until date in the form. Nothing is saved: each value is listed with the line it came from and how sure the reader was, and the quote cannot be saved until the person ticks that they checked the values. The PDF's net, GST and total are shown for comparison, and any mismatch is reported but never corrected. Each read is audited (`QUOTE_PDF_READ`, without the text). With `OCR_PROVIDER=gemini` the file is read by Google's Gemini API instead (text PDFs as their text; scanned PDFs and pictures as the file): see [QUOTE_OCR_GEMINI.md](QUOTE_OCR_GEMINI.md).

| ID   | Item                                      | Effect until answered                                                                                                                                                                                    |
| ---- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| QA-1 | Real insurers' quote layouts              | UNVERIFIED. Tested on a synthetic layout only. A line with two amounts (for example sum insured and premium) takes the last and is marked "check"; a section not found is left empty.                    |
| QA-2 | Scanned PDFs, pictures and mails          | With `OCR_PROVIDER=none`: not read, the screen says so. With `OCR_PROVIDER=gemini`: scanned PDFs and PNG/JPEG are read by Gemini (values always "check"); mails are never read. See QUOTE_OCR_GEMINI.md. |
| QA-3 | Sum insured, terms, deductibles, capacity | Not filled; only premiums and the valid-until date are.                                                                                                                                                  |

## Client review of 27 Oct 2026 (decisions taken, please confirm)

Built: policy period typed in full (no end date worked out from the start); a third proposed Fire
option; add-on covers added on the case; the QCR's policy name, highlighted notes under the payment and
recommendation, "Prepared By" and in-order, centred S No with highlighted headings and one font size; the
RFQ's totals with and then without terrorism; no note section on the RFQ or placement slip; a green tick
for each add-on cover asked for; documents saved to an S3 bucket only on "Save to cloud". The internal
chat was left out on request.

- **Option 3 is a Fire figure.** The other sections have no third figure: they are quoted at their Option 1
  figures in Option 3 (as a section without an Option 2 figure is in Option 2), and the schedule's Option 3
  column carries Fire only. Confirm, or say which sections need their own Option 3.
- **"Policy name"** on the QCR's first page is the case's product (for example Bharat Laghu Udyam Suraksha).
- **"Prepared By"** on the QCR's last page is the user who last saved the broker's part of the QCR, else the
  case's assigned staff.
- **"Note section"** of the QCR: the terrorism note, the case's notes (hypothecation, stock in the open, notes
  for the insurers) and the standard notes marked "On QCR" (the template's own notes when there are none).
- **Removing the RFQ's note section** also removes the Data Sheet's "Notes for the insurers" and "Stock kept
  at open space" from the RFQ (they were only in that section). The bank of a hypothecation still prints in
  the Agreed Bank Clause. Confirm, or say which lines insurers must still see.
- **Policy period**: a renewal's start is still the day after last year's policy ends (a copy, not a
  calculation); its end is typed.
- **Cloud storage**: "data stored locally by default" is the app's own database (MongoDB), as before. The RFQ
  (latest version), QCR and placement slip can be saved to the bucket, as PDF or Excel; quote files, policy
  documents and other uploads are not offered for the cloud yet.

## Data issues found during import

Counts are from the import report for `IIB_Code_Master.xlsx` (299 occupancies; 20,611 pincode rows, 20,606 after
de-duplication). The import reports these; it does not correct them.

### Occupancy sheet ("IIB Code")

- **2075** Engineering Workshop: Terrorism risk type is blank.
- **2191** Tiny sector: the IIB rate cell holds text ("As per existing rate built in SME Pre UW Product"); STFI and
  all minimum EQ rates are blank. Rating this code returns a data error.
- **2215** Pilot Plants: the IIB rate cell holds text ("To be rated as per the manufacturing facility"); STFI, minimum
  EQ rates and risk grade are blank.
- Six rows are highlighted yellow with no stated meaning: **2229** Multiplex Theatre Complexes / Shopping Malls, and
  **3006, 3007, 3008, 3011, 3012** (transmission lines, pipelines, railway tracks, roads).
- Those five (3006 to 3012) have minimum EQ rates of 0.225 for Zone III and Zone IV, against 0.1 and 0.05 for every
  other industrial occupancy. Rating them in zones 3 and 4 raises the "below minimum" warning.

### Pincode sheet

- Five pincodes appear twice with identical values; the first row is kept: 207001, 302013, 400062, 686654, 742184.
- Six pincodes do not belong to their state's postal region:
  100000 Gujarat / Kachchh (not a valid pincode), 121705 Uttar Pradesh / Mau, 134151 Rajasthan / Nagaur,
  586109 Chattisgarh / Bijapur (586xxx is Bijapur, Karnataka), 680320 Karnataka / Belgaum (680xxx is Kerala),
  922119 Jharkhand / Latehar.
- State values that are not a current state or union territory: "Mumbai" (89 rows, including 400001), and former
  names or misspellings: Orissa (956 rows), Chattisgarh (265), Anurachal Pradesh (47), Andaman & Nicobar (26),
  Pondicherry (25), Daman & Diu (6), Dadra & nagar haveli (1). Telangana and Ladakh do not appear.
- The same state is written in different cases: PUNJAB, GUJARAT, MAHARASHTRA, KARNATAKA, KERALA, ORISSA,
  Jammu & kashmir.
- Cross-check: 361 pincodes carry EQ rates of a different zone than the one they are assigned:

  | Assigned zone | Non-industrial / industrial rate in the sheet | Expected for the zone | Pincodes | Example |
  | ------------- | --------------------------------------------- | --------------------- | -------- | ------- |
  | Zone II       | 0.25 / 0.5 (Zone I rates)                     | 0.15 / 0.25           | 66       | 800001  |
  | Zone III      | 0.15 / 0.25 (Zone II rates)                   | 0.1 / 0.1             | 138      | 741101  |
  | Zone III      | 0.05 / 0.05 (Zone IV rates)                   | 0.1 / 0.1             | 19       | 768201  |
  | Zone IV       | 0.1 / 0.1 (Zone III rates)                    | 0.05 / 0.05           | 138      | 500001  |

  Either the zone or the rates are wrong for these rows (Q10).
