# Open items

Items waiting on the client, and data issues found in the client's IIB workbook (`IIB_Code_Master.xlsx`, uploaded
in the app). Nothing here is implemented
from assumptions; where code needs the answer, it has a named extension point
(`src/modules/rating/extension-points.ts`). Question IDs refer to document 06 (Assumptions, Risks
and Open Questions).

## To be confirmed (TBC)

| ID    | Item                                                                                                                                                      | Question    | Effect until answered                                                                                                                                                                                                               |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OI-01 | Add-on premium formulas for the 15 Bharat Sookshma / Laghu covers, and the four "some % on total sum insured" placeholders                                | Q02, Q28    | No add-on is priced. `calculateAddOnPremiums()` returns nothing; total before tax equals the base premium.                                                                                                                          |
| OI-02 | What "policy rate" means: Fire only, Fire + STFI, or Fire + STFI + EQ (+ Terrorism)                                                                       | Q03         | The rating returns the sum of the component rates it priced (Fire + STFI + EQ, plus Terrorism when entered).                                                                                                                        |
| OI-03 | Pricing for the 13 non-fire sections (Burglary, FLOP, Money and so on)                                                                                    | Q23         | Not priced by the engine; expected to come from insurer quotes.                                                                                                                                                                     |
| OI-04 | Terrorism rate source (the master has risk types but no rates)                                                                                            | Q05         | Terrorism is priced only when the user enters a rate.                                                                                                                                                                               |
| OI-05 | Product thresholds (BSUS up to 5 Cr, BLUS above 5 Cr to 50 Cr, SFSP above 50 Cr, PAR above 5 Cr): total or per-location SI? When is PAR chosen over BLUS? | Q04         | No product recommendation is made.                                                                                                                                                                                                  |
| OI-06 | Meaning of Preferred / Referred / Declined, and which occupancies fall in each (only a legend in column V, no colours)                                    | Q06, MST-08 | No occupancy status is stored or enforced.                                                                                                                                                                                          |
| OI-07 | Is the IIB rate a fixed rate or a benchmark insurers discount or load? The master is labelled 2019 rates; is it current?                                  | Q07, Q08    | Rates are shown as in the master.                                                                                                                                                                                                   |
| OI-08 | Who may do what in each role, and who approves RFQs and placements                                                                                        | Q12         | `src/shared/permissions.ts` follows the PRD personas: Approvers approve; Relationship Managers create proposals and send RFQs; Underwriting / Placement staff edit and send; Read-only users only view. The table is in the README. |

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
