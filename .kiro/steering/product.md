# Product

Property Insurance Placement ERP for **Fiducial**, an insurance broker, built by Spirezen Enterprises. It replaces an
Excel chain: Data Sheet → RFQ → insurer quotes → QCR (quote comparison report) → Placement Slip. A risk is entered
once, rated from versioned master data, sent to insurers, compared and placed, with an audit trail.

Two repositories: **Fiducial_backend** (this one: Express API, MongoDB, master data, rating) and
**Fiducial_frontend** (Next.js web app). Source documents are in `docs/` (01 PRD to 07 format analysis); client
workbooks are in `data/` (read-only inputs).

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
- **Master version**: each import is a `DRAFT`; an admin activates it (`ACTIVE`); the previous one becomes
  `SUPERSEDED`. Lookups and ratings always read the ACTIVE version; old versions are kept.

## Current phase: foundation

Built: auth with lockout, roles and permissions, user admin, append-only audit with a read API (who, when, old and
new values), master import with a validation report, occupancy and pincode lookups, the Fire rating check, and the
web app shell.

Not built yet: clients, risks, Data Sheet, RFQ, quotes, QCR, placement slips, document generation, email.

## Rules

- Do not invent client business rules. Anything TBC stays unimplemented and is listed in `docs/OPEN_ITEMS.md`.
- Missing or blank master values are data errors, never silent defaults.
