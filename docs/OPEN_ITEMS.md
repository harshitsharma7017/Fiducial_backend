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
