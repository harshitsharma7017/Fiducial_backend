# Product

**Fiducial**: the property insurance placement platform for Fiducial Insurance Brokers, built by Spirezen
Enterprises. The product is called Fiducial everywhere it is shown (not "Property ERP"). It replaces an
Excel chain: Data Sheet → RFQ → insurer quotes → QCR (quote comparison report) → Placement Slip. A risk is entered
once, rated from versioned master data, sent to insurers, compared and placed, with an audit trail.

Two repositories: **Fiducial_backend** (this one: Express API, MongoDB, master data, rating) and
**Fiducial_frontend** (Next.js web app). Source documents are in `docs/` (01 PRD to 07 format analysis); client
formats are in `data/client-formats/` (reference only). No master or record data is kept in the repository: it is
uploaded in the app (Import data page) and versioned or audited there.

## Users and roles

| Role code         | Label                    | Who                                                             |
| ----------------- | ------------------------ | --------------------------------------------------------------- |
| `ADMIN`           | Admin                    | Operations / admin: users, master data. Holds every permission. |
| `MANAGER`         | Approver                 | Reviews and approves RFQs and placements                        |
| `ACCOUNT_MANAGER` | Relationship Manager     | Owns the client; creates risks, sends RFQs, reviews the QCR     |
| `PLACEMENT_EXEC`  | Underwriting / Placement | Prepares RFQs, chases and enters insurer quotes                 |
| `READ_ONLY`       | Read-only                | Views only                                                      |

What each role may do is one table, `src/shared/permissions.ts` (also in the README). Routes check a permission,
never a role. The table follows the PRD personas and waits for the client's confirmation (`docs/OPEN_ITEMS.md`, Q12).

## Domain terms

- **IIB master**: occupancy rate master. Each **TAC code** (text, for example `1001_2`) has a risk grade (RG1 to
  RG9), an IIB rate, a Fire risk type, a Terrorism risk type, a minimum STFI rate and minimum EQ rates for Zone I to IV.
- **Pincode master**: pincode → state, district, AIFT earthquake zone (1 to 4) and EQ rates by risk type. Zone 1 is
  "Zone I", the highest EQ rates.
- **Risk types**: `RESIDENTIAL`, `NON_INDUSTRIAL` (the sheet writes "N Industrial"), `INDUSTRIAL`.
- **Per mille (‰)**: all rates are per thousand of sum insured. Premium = sum insured × rate / 1000.
- **STFI**: storm, tempest, flood, inundation. **EQ**: earthquake. **SI**: sum insured.
- **Products**: BSUS / BLUS (Bharat Sookshma / Laghu Udyam Suraksha), SFSP, PAR. Thresholds are TBC.
- **GSTIN**: 15-character GST registration number: state code, the holder's PAN, a registration number, "Z" and a
  check character. Validated in `src/shared/gst.ts`; unique per client.
- **Risk location**: an insured site of a client; its pincode (from the master) gives the state, district and EQ zone.
- **Insurer status**: per insurer on a case. Not sent → Sent (emailed or marked sent outside the app) → Reminded →
  Quoted, Declined or No response (set by a user, correctable). Rules in `canMoveInsurer()` (`src/shared/proposals.ts`).
- **Master version**: each import is a `DRAFT`; an admin activates it (`ACTIVE`); the previous one becomes
  `SUPERSEDED`. Lookups and ratings always read the ACTIVE version; old versions are kept.

## Current phase: foundation

Built: auth with lockout, roles and permissions, user admin, append-only audit with a read API (who, when, old and
new values), master import with a validation report, occupancy and pincode lookups, the Fire rating check, the client
master with GSTIN validation and any number of risk locations per client (M-1, M-2), the insurer master with RFQ
email addresses (M-3), the web app shell, and new-business proposals to the RFQ: the Data Sheet, up to five
insurers, the RFQ workbook and marking it sent (emailed by the user; sending locks the Data Sheet), and the product
and cover masters (M-4 to M-9: products with ranges, coverage sections, add-on lists, BSUS/BLUS add-on rates, GST
with effective dates, standard notes), loaded from one Excel workbook and edited on screen.

RFQ (R-1, R-2, R-5): generated from the case, previewed with its own fields edited in place, kept as v1, v2,
v3, submitted and approved or returned with comments; only an approved, current version is sent.

QCR (QC-1 to QC-6): existing policy and up to five insurers per option from the latest quotes, lowest total
marked, coverage differences, recommendation / remarks / payment in favour of, approval of exactly what is shown,
export in the client's QCR layout (Excel and A4 PDF), and the approved QCR mailed to the insured.

Quotes (Q-1 to Q-5): per insurer and option, the premium of each section (Fire with and without terrorism), net,
GST and total; the insurer's terms with deviations from the RFQ flagged; its mail or PDF required; revised versions
with reasons; declines with reasons, left out of the QCR (which uses each latest version).

Case options (C-1 to C-6): product suggested from the Fire sum insured with an override and its reason; Existing,
Option 1 and Option 2 for every schedule line; Burglary on 100% or first loss from the Fire contents; add-ons from
the product's lists with favourites per client; Required / Not required per section add-on cover. All print on the
RFQ.

Cases (D-1, D-2): new business and renewals, 9 stages, assigned staff; a renewal copies last year's policy from the
policy software's public API (existing-policy-source.ts).

Document engine (R-3, R-4): Admins upload the client's Excel templates; the RFQ downloads as that template filled
(Excel) or as an A4 PDF with the broker's letterhead. QCR and Placement Slip templates are stored, not yet filled.

RFQ email (E-2, E-3, E-4, E-6): Admin-edited email templates with merge fields; the API emails the RFQ, one mail per
insurer with the RFQ attached and a quote due date; reminders; insurer statuses (Not sent, Sent, Reminded, Quoted,
Declined, No response; Overdue shown after the due date); a mail log per case. Mail is `outbox` in development and
`off` in production until SMTP is configured (Q14).

Not built yet: quotes, QCR, placement slips, other documents.

## Rules

- Do not invent client business rules. Anything TBC stays unimplemented and is listed in `docs/OPEN_ITEMS.md`.
- Missing or blank master values are data errors, never silent defaults.
