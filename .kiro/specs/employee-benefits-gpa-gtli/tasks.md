# Implementation Plan: Employee Benefits (GPA and GTLI), Family Plan Master and product census templates

## Overview

The work makes the GHI module product-aware instead of copying it. Order: the shared pure modules and contracts in
`Fiducial_backend/src/shared` (with unit tests), the fast-check property tests in Fiducial_frontend, then the data
models, the Family Plan Master and its seed, employee identity and the startup linker, product scope and profiles,
GPA/GTLI cases and Data Sheets, plan assignment, census templates, upload and preview, import, manual entry, RFQ,
quotes, QCR, the client decision, payments and placement, then the frontend screens, the documentation and the final
verification. Every task names the repository it changes. The code is TypeScript (strict, ESM, erasable syntax only,
`.ts` extensions in relative imports), as in the design.

Constraints for every task:

- No new dependency in either repository's `package.json` or lockfile (24.7).
- No destructive migration: never drop, rename or rewrite a collection, index or stored field; only add fields (16.1,
  25.5, 25.6).
- Existing `/api/v1/ghi` routes change only additively: new request fields optional, new response fields beside the
  old ones (16.6, 16.7).
- Existing GHI, claims and Property tests keep passing with no test deleted or skipped. A task that has to change an
  expected value names that test and the requirement that changes the behaviour (26.7).
- Do not invent client business rules: open questions keep their defaults from requirements.md, and the design's
  flagged points (D6, D7, D8, D10) are built as designed and listed for confirmation.
- After any change to `Fiducial_backend/src/shared`, run `npm run shared:sync` in Fiducial_frontend before frontend
  work that uses it.
- Do not commit in either repository.

## Tasks

- [ ] 1. Shared contracts and pure rules (Fiducial_backend `src/shared`)
  - [ ] 1.1 Move the census rules into `src/shared` (Fiducial_backend)
    - Move `src/modules/ghi/census-rules.ts` to `src/shared/census-rules.ts` verbatim (legacy GMC rules, dates,
      rupees, aliases, `ageOn`, `checkCensus`); it must import only from `src/shared`
    - Replace `src/modules/ghi/census-rules.ts` with a re-export so `census-rules.test.ts` and every importer keep
      working unchanged
    - Run `census-rules.test.ts` unchanged; it must pass with no edit
    - _Requirements: 16.3, 18.11, 20.6 (design D5)_

  - [ ] 1.2 Add the audit actions, entities and error codes (Fiducial_backend)
    - In `src/shared/audit.ts`, add the entities `eb_case`, `family_plan`, `client_plan_default`, `eb_employee` and
      every `EB_*`, `FAMILY_PLAN_*`, `CLIENT_PLAN_DEFAULT_*` action of the design's Audit table, each with exactly one
      kind and a label; keep every `GHI_*` action and label unchanged
    - In `src/shared/errors.ts`, add `EB_PLACED`, `EB_STAGE`, `EB_PLAN_REQUIRED`, `EB_PLAN_CONFLICT`,
      `FAMILY_PLAN_CODE_TAKEN`, `FAMILY_PLAN_OVERLAP`, `FAMILY_PLAN_VERSION_LOCKED`, `EB_EMPLOYEE_UNRESOLVED`,
      `EB_IDENTITY_CONFLICT` and `EB_NO_ERRORS`
    - Extend `src/shared/audit.test.ts` only by adding cases (every new action has one kind and a label)
    - _Requirements: 25.1, 25.3, 3.11, 11.4, 12.1, 12.7, 15.5, 17.7, 17.12, 18.10, 21.6_

  - [ ] 1.3 Write the family plan contracts and rules in `src/shared/family-plans.ts` (Fiducial_backend)
    - `PlanSlotSchema`, `PlanVersionInputSchema` with `planVersionIssues()` reporting every failing field at once
      with slot position, name and relationship; `CreateFamilyPlanRequestSchema` and the rename, version, effective-to
      and confirm request schemas; plan, version and list response schemas
    - `DEFAULT_FAMILY_PLANS` (the seven plans of 14.2 with their open question numbers and mixing flag stored as
      `false` where there is no parent slot), `versionOn()`, `overlaps()`, `planAcceptsParents()`
    - The mixing flag has no default (13.7); Spouse and parent maximums are at most 1 (13.6, open question 8)
    - _Requirements: 12.1, 12.2, 12.3, 12.7, 12.12, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.9, 13.10, 14.2_

  - [ ] 1.4 Write the money functions and their Decimal twins (Fiducial_backend)
    - `src/shared/eb-money.ts` (BigInt fixed point): `salaryMultipleSumInsured()`, `percentOfSumInsured()`,
      `ebPremium()`, half up to the rupee or paisa, strings in and out
    - `src/modules/ghi/eb-calc.ts` (Decimal, ROUND_HALF_UP): the same three functions for the API's stored amounts
    - `src/modules/ghi/eb-calc.test.ts`: both agree over a fixed grid of salaries, multipliers, caps, percentages,
      premiums and GST rates including the .5 ties; 1,000.05 at 18% gives 180.01 and 1,180.06
    - _Requirements: 4.3, 4.5, 5.4, 7.2, 25.7 (design D9)_

  - [ ] 1.5 Write the EB case contracts in `src/shared/eb.ts` and the additive GHI fields (Fiducial_backend)
    - `EB_PRODUCTS`, `EB_PRODUCT_LABELS`, `EB_REFERENCE_PREFIX`, `EB_STAGES`, `ebStageAfter()`, `nextStepOf()`
    - `CreateEbCaseRequestSchema`, `EbCaseListQuerySchema` (search 1–100 after trim, blank as none, page 1–10,000,
      limit 1–100), `EbCaseListItemSchema`, `EbCaseCreatedSchema`, `UpdateEbCaseRequestSchema` (strict: product, type
      or company → 400), close request (reason 1–300 after trim), `EbPlanAssignmentSchema`, `EbCaseRecordSchema`
    - Additive only in `ghi.ts`, `ghi-census.ts`, `ghi-workflow.ts`: `product` and `plan` on the GHI record,
      `product` on list items, `fileWarnings`, `mode`, `result` on imports, optional `severity` on issues, optional
      `mode` on the commit request, optional `freeCoverLimit` and `aboveFreeCoverLimit` on the summary; nothing renamed
      or removed
    - _Requirements: 1.4, 1.5, 1.9, 1.11, 2.3, 2.5, 2.10, 3.1, 3.2, 3.4, 3.5, 3.6, 3.9, 16.6_

  - [ ] 1.6 Write the GPA and GTLI Data Sheets in `src/shared/eb-requirements.ts` (Fiducial_backend)
    - `SumInsuredBasisSchema` (Flat, Graded 1–10 distinct, Multiple of salary with multiplier >0 ≤100 at most 2 dp and
      optional maximum; strict variants), `CoverChoiceSchema`, `GPA_COVERS`, `DependantBasisSchema`
    - `GpaRequirementsInputSchema` and `GtliRequirementsInputSchema`: strict objects, amounts as digit strings (a
      JSON number is refused), TTD benefit and weeks only while TTD is Required, unique claim years, age limits as on
      GMC; `gpaMissing()` and `gtliMissing()` returning `{ field, label }` items
    - _Requirements: 4.1, 4.2, 4.4, 4.5, 4.6, 4.7, 4.8, 4.10, 4.11, 5.1, 5.4, 5.5, 5.6, 5.7, 25.7_

  - [ ] 1.7 Write the census contracts in `src/shared/eb-census.ts` (Fiducial_backend)
    - `EB_CENSUS_FIELDS`, `ColumnRequirement` (`ALWAYS`, `EMPLOYEE_ROW`, `NO`), `templateColumns()`,
      `relationshipValues()`, `EB_HEADER_ALIASES` (GMC aliases plus Annual Salary, CTC, Salary), `resolveHeaders()`
    - `EbCensusRowValuesSchema`, `EbMemberInputSchema` (GMC member plus `annualSalary`), `EbCensusIssueSchema`
      (severity ERROR or WARNING, code, fix), `EB_IMPORT_MODES`, `EbImportRowSchema`, `EbImportResultSchema`, the
      commit request (policy required, no default; mode optional)
    - _Requirements: 19.1, 19.2, 19.4, 19.10, 20.2, 20.3, 20.8, 22.1, 22.4, 22.11 (design D15)_

  - [ ] 1.8 Write the Census_Validator in `src/shared/eb-census-rules.ts` (Fiducial_backend)
    - `EbCensusContext` with legacy or plan family mode, product member rules, age limits, reference date, today,
      identities, unresolved keys, `deriveSumInsured`, `percentOf` and `identityChecks`
    - A row reader that adds annual salary and the future-date check on top of the moved reader; Self assumed when the
      plan accepts only Self and the file has no Relationship column
    - `checkEbCensus()` in the design's order (fields, member checks by product and basis, identity, duplicates,
      family by slot with mixing, dependants without a valid Self); legacy mode calls the moved `checkCensus()`
      unchanged; one entry per candidate; limit issues name plan code, version and limit
    - `familyShortfalls()`, `identityMismatches()` (name ignoring case and repeated spaces, gender, date of birth;
      never date of joining), `memberSumInsured()`, `freeCoverFlags()` (strictly above, WARNING)
    - _Requirements: 4.6, 5.3, 5.5, 13.8, 14.4, 14.5, 16.3, 16.4, 17.5, 17.12, 18.1–18.9, 20.5, 20.7, 23.2_

  - [ ] 1.9 Write the GPA and GTLI quote terms in `src/shared/eb-quotes.ts` (Fiducial_backend)
    - `GpaQuoteTermsSchema` (per cover Offered, Not offered or Not stated, limit as amount or text),
      `GtliQuoteTermsSchema` (FCL offered or Not stated, benefits text), other terms ≤4,000, `statedRate` as text
    - `gpaDeviations()` and `gtliDeviations()` returning DEVIATION and MISSING items with term, asked and offered;
      offered GPA limits produce neither (open question 10)
    - _Requirements: 7.1, 7.3, 7.4_

  - [ ] 1.10 Write the workflow and employee contracts (Fiducial_backend)
    - `src/shared/eb-workflow.ts`: QCR save, submit and decision schemas with the fingerprint, client decision
      (accepted or rejected, files 1–10), payments schemas reusing GMC modes and statuses, placement issue (policy
      number ≤50, optional dates, end not before start); `qcrCandidates()`, `lowestMarks()`, `paymentsSummary()`
    - `src/shared/eb-employees.ts`: identity schema, list query (search, page, 50 per page), update and resolve
      requests (reason 1–500), unresolved list item; `linkDecision()`
    - _Requirements: 7.5, 7.6, 7.7, 8.1, 8.2, 8.3, 9.1, 9.2, 10.1, 10.2, 10.4, 11.3, 11.7, 17.6, 17.10, 17.11, 17.13_

  - [ ] 1.11 Write the import plan in `src/shared/eb-import-plan.ts` (Fiducial_backend)
    - `classifyImport()` matching on employee key, relationship, name key and date of birth; SAME → unchanged;
      CHANGED → error naming field, member value and row value (Add new only) or update of sum insured, salary and
      joining date only (Add and update); NEW → `checkEbCensus` with matched rows held in place; LEGACY (GMC, no
      mode) → no matching (design D8)
    - Apply the policy: All valid refuses with the invalid count; Valid only leaves out invalid rows and dependants
      of invalid Self rows, refuses when every row is invalid; `applyImportPlan()` as the pure model of the write
    - _Requirements: 22.1, 22.2, 22.4, 22.5, 22.7, 22.9, 22.10, 17.4_

  - [ ] 1.12 Write unit tests for the plan rules and the Census_Validator (Fiducial_backend)
    - `src/shared/family-plans.test.ts`: each refusal of 13.2 to 13.7, all issues in one result, the seven defaults
      accepted, `versionOn` and `overlaps` examples
    - `src/shared/eb-census-rules.test.ts`: `03/04/1990` is 3 April 1990; `12/31/1990`, `31/02/1990`, two-digit years
      and future dates refused; the 18.7 sample message; a 1+5 family with three parents refused and a 1+7 family with
      four passing; mixing forbidden; dependant without Self; duplicates; identity mismatches; FCL warnings
    - _Requirements: 26.2, 26.5, 13.2–13.7, 14.4, 14.5, 18.1–18.7, 20.6, 20.7_

  - [ ] 1.13 Write unit tests for money, quotes, Data Sheets, stages and the import plan (Fiducial_backend)
    - `src/shared/eb-money.test.ts`, `eb-quotes.test.ts`, `eb-requirements.test.ts`, `eb.test.ts`
      (`ebStageAfter`, `nextStepOf`), `eb-import-plan.test.ts` (both modes, both policies, counts, re-import unchanged)
    - _Requirements: 26.2, 26.5, 3.2, 4.7, 5.6, 7.2, 7.4, 22.2, 22.4, 22.5, 22.9, 22.10_

  - [ ] 1.14 Export the new modules and sync the frontend copy (Fiducial_backend, Fiducial_frontend)
    - Export every new module from `Fiducial_backend/src/shared/index.ts`
    - Run `npm run typecheck` and `npm test` in Fiducial_backend; run `npm run shared:sync` then `npm run shared:check`
      and `npm run typecheck` in Fiducial_frontend
    - _Requirements: 26.1_

- [ ] 2. Property tests for the shared modules (Fiducial_frontend, `src/lib/eb/`)
  - Each test is its own file `src/lib/eb/<name>.property.test.ts`, imports from `@/shared`, runs at least 100 cases
    and starts with `// Feature: employee-benefits-gpa-gtli, Property N: <property title>`. Amounts are digit strings.
  - [ ] 2.1 Write the generators and independent oracles (Fiducial_frontend)
    - `src/lib/eb/eb-arbitraries.test-utils.ts`: `arbPlanVersion()`, `arbBrokenPlanVersion()` (labelled violations),
      `arbFamily(plan)`, `arbCensusRow()` (every date form, valid and invalid variants), `arbGpaSheet()`,
      `arbGtliSheet()`, `arbQuotes()`, `arbPayments()`, `arbDigits(n)`
    - Oracles written with plain loops and BigInt rationals, independent of the implementation
    - _Requirements: 26.5_

  - [ ] 2.2 Write property test for census dates (`census-dates.property.test.ts`)
    - **Property 1: Day-first census dates read back exactly**
    - **Validates: Requirements 20.6, 26.5**

  - [ ] 2.3 Write property test for invalid census values (`census-row-fields.property.test.ts`)
    - **Property 2: Invalid census values are refused on their own field**
    - **Validates: Requirements 20.7, 26.2**

  - [ ] 2.4 Write property test for salary and percentage sums insured (`eb-sum-insured-money.property.test.ts`)
    - **Property 3: Sums insured from salary and percentage round half up and respect the cap**
    - **Validates: Requirements 4.3, 4.5, 5.4**

  - [ ] 2.5 Write property test for quote GST (`eb-premium-gst.property.test.ts`)
    - **Property 4: Quote GST and total**
    - **Validates: Requirements 7.2, 26.5**

  - [ ] 2.6 Write property test for the Data Sheet schemas (`eb-data-sheets.property.test.ts`)
    - **Property 5: GPA and GTLI Data Sheets validate exactly their own fields**
    - **Validates: Requirements 4.1, 4.2, 4.4, 4.8, 4.10, 4.11, 5.1, 5.5, 5.7, 25.7**

  - [ ] 2.7 Write property test for the missing lists (`eb-missing.property.test.ts`)
    - **Property 6: The missing list is empty exactly when the Data Sheet is complete**
    - **Validates: Requirements 4.7, 5.6**

  - [ ] 2.8 Write property test for age limits and genders (`census-age-gender.property.test.ts`)
    - **Property 7: Age limits and relationship genders decide a member's eligibility**
    - **Validates: Requirements 4.6, 18.3, 18.6**

  - [ ] 2.9 Write property test for the sum insured basis (`census-sum-insured-basis.property.test.ts`)
    - **Property 8: Sums insured follow the case's basis and dependant basis**
    - **Validates: Requirements 18.3, 4.2, 4.5**

  - [ ] 2.10 Write property test for the free cover limit (`free-cover-limit.property.test.ts`)
    - **Property 9: The free cover limit flags exactly the members above it**
    - **Validates: Requirements 5.3**

  - [ ] 2.11 Write property test for stages (`eb-stages.property.test.ts`)
    - **Property 10: Stages only move forward, except the one defined return**
    - **Validates: Requirements 3.2, 3.4**

  - [ ] 2.12 Write property test for plan version rules (`plan-version-rules.property.test.ts`)
    - **Property 11: Plan versions are accepted exactly when they meet the configuration rules**
    - **Validates: Requirements 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.9, 12.12, 14.2**

  - [ ] 2.13 Write property test for version selection (`plan-version-dates.property.test.ts`)
    - **Property 12: Version selection and overlap**
    - **Validates: Requirements 12.7, 15.2, 15.3, 19.3**

  - [ ] 2.14 Write property test for family fit (`family-fit.property.test.ts`)
    - **Property 13: A family is accepted exactly when it fits the plan**
    - **Validates: Requirements 18.1, 13.8, 14.4, 14.5, 18.8, 16.4, 26.5**

  - [ ] 2.15 Write property test for row order (`family-row-order.property.test.ts`)
    - **Property 14: Earlier rows and existing members keep their places**
    - **Validates: Requirements 18.2, 20.5, 13.8**

  - [ ] 2.16 Write property test for dependants (`dependant-employee.property.test.ts`)
    - **Property 15: Dependants need a valid employee row**
    - **Validates: Requirements 18.4**

  - [ ] 2.17 Write property test for duplicates (`census-duplicates.property.test.ts`)
    - **Property 16: Exact duplicates are refused, the first is kept**
    - **Validates: Requirements 18.5**

  - [ ] 2.18 Write property test for complete reporting (`census-every-row.property.test.ts`)
    - **Property 17: Every row is reported, with a complete issue**
    - **Validates: Requirements 18.7, 20.9, 20.8**

  - [ ] 2.19 Write property test for family shortfalls (`family-shortfalls.property.test.ts`)
    - **Property 18: Family shortfalls are exactly the slots below their minimum**
    - **Validates: Requirements 18.9, 12.3**

  - [ ] 2.20 Write property test for identity comparison (`identity-mismatch.property.test.ts`)
    - **Property 19: Identity comparison ignores case and spacing, and unresolved keys block new employees**
    - **Validates: Requirements 17.5, 17.12**

  - [ ] 2.21 Write property test for startup link decisions (`identity-link.property.test.ts`)
    - **Property 20: Startup linking links only groups that agree**
    - **Validates: Requirements 17.10, 17.11**

  - [ ] 2.22 Write property test for import counts (`import-counts.property.test.ts`)
    - **Property 21: Import counts add up and match the records written**
    - **Validates: Requirements 22.4, 22.7, 17.2, 17.4, 20.8**

  - [ ] 2.23 Write property test for import modes (`import-modes.property.test.ts`)
    - **Property 22: Matching rows by mode**
    - **Validates: Requirements 22.2, 22.9**

  - [ ] 2.24 Write property test for re-import (`import-idempotent.property.test.ts`)
    - **Property 23: Importing the same rows again changes nothing**
    - **Validates: Requirements 22.5, 26.2**

  - [ ] 2.25 Write property test for the import policy (`import-policy.property.test.ts`)
    - **Property 24: The import policy decides what is left out**
    - **Validates: Requirements 22.1, 22.10**

  - [ ] 2.26 Write property test for manual entry (`manual-entry.property.test.ts`)
    - **Property 25: Manual entry is checked exactly as the import**
    - **Validates: Requirements 23.2, 23.6**

  - [ ] 2.27 Write property test for header resolution (`census-headers.property.test.ts`)
    - **Property 26: Headers resolve in any order and with any accepted alias**
    - **Validates: Requirements 19.10, 20.2**

  - [ ] 2.28 Write property test for template columns (`template-columns.property.test.ts`)
    - **Property 27: Template columns come from the plan's slots and the basis**
    - **Validates: Requirements 19.1, 19.2**

  - [ ] 2.29 Write property test for deviations (`eb-deviations.property.test.ts`)
    - **Property 28: GPA and GTLI deviations**
    - **Validates: Requirements 7.4**

  - [ ] 2.30 Write property test for QCR candidates (`qcr-candidates.property.test.ts`)
    - **Property 29: The QCR compares each insurer's latest recorded quote and marks every lowest**
    - **Validates: Requirements 8.1, 7.5, 7.6, 7.7**

  - [ ] 2.31 Write property test for the payments summary (`payments-summary.property.test.ts`)
    - **Property 30: The payments summary counts only received payments**
    - **Validates: Requirements 10.2**

  - [ ] 2.32 Write property test for GMC legacy mode (`gmc-legacy.property.test.ts`)
    - **Property 31: A GMC case without a plan is checked exactly as today**
    - **Validates: Requirements 16.3**

- [ ] 3. Checkpoint: shared modules and property tests
  - Ensure all tests pass in both repositories (`npm test`), and `npm run shared:check` passes in Fiducial_frontend;
    ask the user if questions arise.

- [ ] 4. Data models and additive fields (Fiducial_backend)
  - [ ] 4.1 Add the new fields to the GHI models and the import twin (Fiducial_backend)
    - `ghi_cases`: optional `product`, `planAssignment`, `placement`; indexes `{ product, updatedAt, _id }` and
      `{ 'planAssignment.planId', stage }`; the GHI mapper returns `product: 'GMC'` for a missing product and `plan`
      (null when none) without writing to the stored case
    - `ghi_members`: optional `annualSalary` (Decimal128) and `employeeIdentityId` with the partial index;
      `ghi_quotes.statedRate`; `ghi_qcrs.fingerprint` and `clientDecision.agreedPremium`, `quoteVersion`;
      `ghi_census_imports`: `mode`, `columns`, `fileWarnings`, `marker`, `result`
    - New model `eb_census_imports` with the same schema, index `{ caseId, _id }` and no unique fingerprint index
      (design D4); register it in `models.ts`; no existing index changes
    - _Requirements: 1.5, 1.7, 16.1, 16.2, 16.6, 22.5, 22.8, 25.5, 25.6, 25.7_

  - [ ] 4.2 Add the new collections (Fiducial_backend)
    - `src/modules/family-plans/family-plan.model.ts` (`family_plans`, unique `{ product, code }`,
      `{ product, active, code }`, embedded versions, optimistic `__v`), `client-plan-default.model.ts`
      (`eb_client_plan_defaults`, unique `{ clientId, product }`, `{ planId }`)
    - `src/modules/employees/employee.model.ts` (`eb_employees`, unique `{ clientId, employeeKey }`,
      `{ clientId, nameKey }`, no coverage fields)
    - `src/modules/ghi/eb-placement.model.ts` (`eb_policy_snapshots` with unique `{ caseId }`,
      `eb_policy_snapshot_members` with `{ snapshotId, employeeKey }`), both append-only with update and delete hooks
      that throw, as `ghi_dispatches` does; register all in `models.ts`
    - _Requirements: 11.2, 11.4, 12.1, 12.2, 12.10, 15.1, 17.1, 17.8, 25.5 (design D14)_

  - [ ] 4.3 Write data safety integration tests (Fiducial_backend, `test/eb-data-safety.test.ts`)
    - `ensureIndexes()` on a database seeded with GHI data creates the new indexes and drops none
    - A stored GHI case without `product` lists, opens and edits as GMC through `/api/v1/ghi` and its stored document
      is unchanged; the existing `ghi.test.ts` and `claims.test.ts` pass unchanged
    - _Requirements: 1.7, 16.1, 16.2, 16.6, 25.5, 25.6, 26.7_

- [ ] 5. Family Plan Master (Fiducial_backend)
  - [ ] 5.1 Implement `src/modules/family-plans/family-plans.service.ts` (Fiducial_backend)
    - `listPlans`, `getPlan`, `createPlan` (with a first Draft), `renamePlan`, `setPlanActive`, `createVersion`
      (number = versions + 1, guarded by `__v`), `updateDraftVersion`, `activateVersion`, `setEffectiveTo`,
      `confirmVersion`, `openCasesUsing`
    - Active versions accept only the two changes of 12.11; overlap and code checks inside the transaction; no
      delete; every change audited with the same fields before and after in the same session
    - _Requirements: 12.1, 12.2, 12.6, 12.7, 12.8, 12.9, 12.10, 12.11, 12.12, 13.1, 13.9_

  - [ ] 5.2 Implement the default plan seed (Fiducial_backend)
    - `src/modules/family-plans/default-plans.ts` `ensureDefaultFamilyPlans()`: per default plan, a transaction that
      upserts on `{ product, code }` with `$setOnInsert` (version 1 Active from 2000-01-01, not confirmed) and writes a
      system audit entry (`userId: null`) only when it inserted; an existing plan is left untouched, also when
      deactivated
    - Call it in `server.ts` after `ensureIndexes()`, beside `ensureEmailTemplates()`
    - _Requirements: 14.1, 14.2, 14.3, 14.7, 14.8_

  - [ ] 5.3 Add the family plan routes (Fiducial_backend)
    - `src/modules/family-plans/family-plans.routes.ts` with every route of the design's table (`masters.view` to
      read, `masters.manage` for writes and `open-cases`), strict Zod via `route()`, `documentRoute()` for each;
      mount at `/api/v1/family-plans` in `app.ts`
    - _Requirements: 12.4, 12.5, 12.8, 12.13, 24.1, 24.9, 24.10_

  - [ ] 5.4 Write integration tests for family plans (Fiducial_backend, `test/family-plans.test.ts`)
    - Seven defaults created once; two concurrent `ensureDefaultFamilyPlans()` still give one each; a second start
      writes nothing (also for a deactivated default); system audit entries
    - Create, Draft edit, activation, refused re-activation, overlap, effective-to once, confirm No → Yes only, code
      taken, no delete route; GMC 1+3 versioned leaves GPA 1+3 unchanged
    - Per route: success, 401, the five roles per `permissions.ts`, invalid input with nothing written
    - _Requirements: 12.1–12.13, 13.1–13.9, 14.1, 14.3, 14.7, 14.8, 26.2, 26.6_

- [ ] 6. Employee identity and startup linking (Fiducial_backend)
  - [ ] 6.1 Implement the identity core in `src/modules/employees/employees.service.ts` (Fiducial_backend)
    - `identityContext(clientId, keys, session)` (identities and unresolved keys with case references),
      `ensureSelfIdentities(clientId, rows, session)` (bulk upsert with `$setOnInsert`, created and reused counts,
      re-read and 409 when a concurrent identity disagrees), `listEmployees(clientId, query)` (unresolved first, 50 per
      page, products and case references, derived unresolved state per design D12)
    - Never links a member to another company's identity; never stores coverage on the identity
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.8, 17.9, 17.13_

  - [ ] 6.2 Implement the startup linker `src/modules/employees/employee-link.ts` (Fiducial_backend)
    - `linkEmployeeIdentities(logger)`: group Self members without a reference by (client via `ghi_cases.clientId`,
      key) in batches of 500; `linkDecision()` decides; upsert the identity (ID text and joining date from the most
      recent case) and `updateMany({ _id: { $in }, employeeIdentityId: null }, …, { timestamps: false })`; log counts
      only, never names; system audit entries
    - Call it in `server.ts` after `ensureDefaultFamilyPlans()`
    - _Requirements: 16.1, 16.9, 17.10, 17.11, 24.4, 25.6_

  - [ ] 6.3 Write integration tests for linking (Fiducial_backend, `test/eb-employees.test.ts`)
    - Agreeing groups linked; a second run links nothing and creates nothing; `updatedAt` and every other member field
      unchanged; disagreeing groups stay unlinked and are listed as unresolved; claims still find those members
    - _Requirements: 16.9, 17.10, 17.11, 26.2_

- [ ] 7. Product scope and profiles (Fiducial_backend)
  - [ ] 7.1 Add the product scope to the GHI services (Fiducial_backend)
    - `src/modules/ghi/products/profile.ts` (`EbProduct`, `CaseScope`, `ProductProfile`, `productFilter()`, registry)
      and `gmc.ts` returning today's behaviour
    - `loadCase(id, session?, scope = GMC_SCOPE)` filters by product (404 otherwise); `assertWritable(doc, scope)`
      extends `assertOpen` with `placement != null → 409 EB_PLACED`
    - The existing services (`ghi-cases`, `census`, `ghi-rfq`, `ghi-mail`, `ghi-quotes`, `ghi-qcr`, `ghi-files`,
      `ghi-placement`) take an optional `scope` defaulting to GMC; `/ghi` routes keep their behaviour
    - _Requirements: 2.9, 3.7, 3.8, 3.11, 11.4, 16.6, 16.7, 24.2 (design D1, D2, D3)_

  - [ ] 7.2 Implement `gmcFamilyCover()` for GMC cases with a plan (Fiducial_backend)
    - One helper answers "parents covered?" from `familyDefinition.parents !== 'NONE'` without a plan and from
      `planAcceptsParents()` with one; used in `compareTerms()`, `missingRequirements()`, `ghi-documents.ts` and the
      service-side co-payment check moved out of the Data Sheet schema's `superRefine` (same path, message and 400)
    - The schema change is in `src/shared/ghi.ts`: run `npm run shared:sync` in Fiducial_frontend; if a frontend test
      relied on the schema refinement for the co-payment error, name it in this task and keep it passing through the
      API's 400
    - _Requirements: 16.4, 16.6, 16.7, 7.4 (design D6)_

  - [ ] 7.3 Implement the GPA and GTLI profiles (Fiducial_backend)
    - `src/modules/ghi/products/gpa.ts` and `gtli.ts`: requirements schema and empty value, missing items, census
      settings (plan mode only; no plan → `EB_PLAN_REQUIRED`), `EB_STAGES`, `afterAcceptance: PAYMENT`, agreed premium
      from the accepted decision, quote terms schema and deviations, template columns, `eb_case` entity and `EB_*`
      actions; register both in `profile.ts`
    - _Requirements: 3.1, 4.1, 4.7, 5.1, 5.5, 5.6, 7.3, 7.4, 18.8, 18.10_

  - [ ] 7.4 Implement the census context builder (Fiducial_backend)
    - `src/modules/ghi/eb-census-context.ts` `buildCensusContext(scope, caseDoc, session)`: legacy mode for GMC
      without a plan, plan mode from the stored plan copy otherwise; Data Sheet basis and age limits; reference date
      rule; IST today; the company's identities and unresolved keys; `deriveSumInsured` and `percentOf` from
      `eb-calc.ts`; `identityChecks: true` on every product (design D7, flagged for confirmation)
    - _Requirements: 4.6, 16.3, 16.4, 17.5, 17.12, 18.3, 18.8, 18.11 (design D7, D9)_

  - [ ] 7.5 Write tests for the profiles and GMC regression (Fiducial_backend)
    - `src/modules/ghi/products/gmc.test.ts`: co-payment asked or not with no plan, with a plan with a parent slot and
      with one without
    - Run the existing `test/ghi.test.ts`, `test/claims.test.ts` and `census-rules.test.ts` unchanged
    - _Requirements: 16.3, 16.4, 16.7, 26.2, 26.7_

- [ ] 8. GPA and GTLI cases and Data Sheets (Fiducial_backend)
  - [ ] 8.1 Implement `src/modules/ghi/eb-cases.service.ts` (Fiducial_backend)
    - `createEbCase(input, actor)`: validation and client and staff checks before the transaction (no reference used
      on refusal); counters `ghi-<year>`, `gpa-<year>`, `gtli-<year>` (IST year, 4 digits); stage CREATED; plan from
      the company's active default on the plan date, else the GTLI Self only plan for GTLI, else none; audit the case
      and the automatic assignment in the same transaction
    - `listEbCases(query)` across products with the filters and paging of 2.3
    - New GMC cases created through `/ghi` also store `product: 'GMC'` (old ones are never written to)
    - _Requirements: 1.4, 1.5, 1.6, 1.9, 1.12, 2.3, 5.2, 15.2, 15.7, 15.8, 16.5, 16.8 (design D1)_

  - [ ] 8.2 Add the EB routers (Fiducial_backend)
    - `src/modules/ghi/eb.routes.ts` at `/api/v1/eb`: `GET` and `POST /cases`
    - `src/modules/ghi/eb-product.routes.ts` `createEbProductRouter(scope)` mounted at `/eb/gpa` and `/eb/gtli`: case
      read and edit (refusing product, type or company), close (refused when placed, 409 when Closed), requirements
      save (draft with missing list, stage to Data Sheet on the first save, 409 when locked); `documentRoute()` for each
    - Mount both in `app.ts`; every route `authenticate()` then one `requirePermission()`
    - _Requirements: 1.10, 1.11, 2.5, 2.9, 2.10, 2.11, 3.1, 3.2, 3.3, 3.5, 3.6, 3.9, 3.10, 3.11, 4.7, 4.9, 5.6, 5.8, 24.1_

  - [ ] 8.3 Write integration tests for cases (Fiducial_backend, `test/eb-cases.test.ts`)
    - GMC, GPA and GTLI created with their prefixes and separate sequences; refused creates take no reference and write
      no audit; another product refused; list filters, search, paging and 400s; edit and close; cross-product id → 404
      with the same body; per route 401, five roles, invalid input with nothing written; Property routes unchanged
    - _Requirements: 1.4–1.12, 2.3, 2.5, 2.9, 2.10, 2.11, 3.5, 3.9, 3.10, 26.2, 26.6_

  - [ ] 8.4 Write integration tests for Data Sheets and early stages (Fiducial_backend)
    - `test/eb-requirements.test.ts`: GPA and GTLI saves, missing lists, foreign fields 400, JSON numbers 400, locked
      409 with the saved sheet unchanged
    - `test/eb-stages.test.ts` (first part): CREATED → DATA_SHEET on the first save only, unchanged on failure, Closed
      refuses every change and stays readable
    - _Requirements: 3.2, 3.11, 4.1–4.11, 5.1–5.8, 25.7, 26.2_

- [ ] 9. Plan assignment and company defaults (Fiducial_backend)
  - [ ] 9.1 Implement plan assignment (Fiducial_backend)
    - `src/modules/ghi/eb-plan-assignment.service.ts` `assignPlan(scope, caseId, planId, actor)`: active plan of the
      case's product with a version on the plan date (else 400), unlocked and unplaced (else 409), every family
      re-checked against the new slots (409 `EB_PLAN_CONFLICT` with employee IDs and rules, no names), copy stored,
      `requirementsRevision` raised (design D11), audited with code and version before and after
    - Routes `PUT /eb/{product}/cases/:id/plan` and additive `PUT /ghi/cases/:id/plan`
    - _Requirements: 6.4, 15.3, 15.4, 15.5, 15.6, 15.7, 15.9, 16.4, 16.6_

  - [ ] 9.2 Implement company plan defaults (Fiducial_backend)
    - `GET /eb/companies/:clientId/plan-defaults` (`clients.view`) and
      `PUT /eb/companies/:clientId/plan-defaults/:product` (`clients.manage`, `planId` or null): one per company and
      product, active plan of that product only, cases unchanged, audited
    - _Requirements: 15.1, 15.4, 15.7, 24.1_

  - [ ] 9.3 Write integration tests for plan assignment (Fiducial_backend, `test/eb-plan-assignment.test.ts`)
    - Company default used at creation; GTLI fallback; no plan when the default is inactive; assignment with the
      version on the plan date; refused change listing families; locked and placed 409; later version or deactivation
      leaves the copy unchanged; per route 401, roles, invalid input, foreign ids 404
    - _Requirements: 5.2, 15.1–15.9, 26.2, 26.6_

- [ ] 10. Checkpoint: cases, plans and identity
  - Ensure all tests pass (`npm run lint`, `npm run typecheck`, `npm test` in Fiducial_backend); ask the user if
    questions arise.

- [ ] 11. Census templates (Fiducial_backend)
  - [ ] 11.1 Implement the Template_Builder (Fiducial_backend)
    - `src/modules/ghi/eb-census-template.ts` `buildEbCensusTemplate({ product, plan, version, basis, caseReference? })`:
      Instructions (provisional notice in row 1, columns with Yes / Yes, on the employee's row / No, genders,
      relationships or "every row is the employee (Self)", DD/MM/YYYY, plan, slots, mixing, "Awaiting client
      confirmation" with open questions, 10,000 rows), Census (frozen headers with " *", formats, drop-downs on rows
      2–10,001 with `showErrorMessage: false`), `_fiducial` `veryHidden` marker sheet; file name
      `Provisional-<Template name>-v<version>.xlsx`
    - `readTemplateMarker(workbook)`
    - _Requirements: 14.9, 19.1, 19.2, 19.4, 19.5, 19.6, 19.7 (design D13, D15)_

  - [ ] 11.2 Add the template route (Fiducial_backend)
    - `GET /eb/census-templates?product=&planId=&caseId=` (`proposals.view`) in `eb.routes.ts`: version in effect on
      the IST download date, or the case's copy and basis; a GMC case without a plan gets today's
      `buildCensusTemplate()` unchanged; refusals of 19.9 with no file; audited as `EB_CENSUS_TEMPLATE_DOWNLOADED`
    - _Requirements: 19.3, 19.8, 19.9, 25.4_

  - [ ] 11.3 Write tests for templates (Fiducial_backend)
    - `src/modules/ghi/eb-census-template.test.ts`: each of the seven templates has its sheets, columns, required marks,
      drop-downs, notice, file name and marker; the marker survives sorting, inserting and deleting rows through
      exceljs; the GMC legacy template equals `buildCensusTemplate()`
    - Route tests in `test/eb-census.test.ts`: each refusal of 19.9; per route 401 and roles
    - _Requirements: 19.1–19.9, 26.2, 26.6_

- [ ] 12. Census upload, preview, corrections and error report (Fiducial_backend)
  - [ ] 12.1 Implement the upload (Fiducial_backend)
    - `src/modules/ghi/eb-census-import.service.ts` `uploadCensus(scope, …)`: raw body in memory (≤10 MB), zip magic
      and exceljs load, sheet choice, `resolveHeaders()`, required columns by level, 1–10,000 non-blank rows, marker
      match or a file warning; GPA/GTLI without a plan → `EB_PLAN_REQUIRED`; locked or placed 409; store rows, columns,
      fingerprint and file name in `eb_census_imports` (GPA/GTLI) or `ghi_census_imports` with today's fingerprint
      guard (GMC); discard and audit an open preview in the same transaction; audit the upload (name, size, hash only)
    - _Requirements: 18.10, 20.1, 20.2, 20.3, 20.4, 20.10, 20.11, 20.12, 20.13, 22.8, 24.5, 25.3 (design D4)_

  - [ ] 12.2 Implement preview, corrections and discard (Fiducial_backend)
    - `getImport(scope, …, mode)`: issues recomputed on read with `classifyImport()` against the stored census,
      identities and plan; counts of read, valid, error and warning rows; GMC with no mode is legacy (design D8)
    - `correctRow`: same field rules, corrected flag, whole preview recomputed (both families on an employee ID
      change), audited with row number and values before and after; locked, imported or discarded 409
    - `discard`: audited
    - _Requirements: 20.5, 20.8, 20.9, 20.10, 21.1, 21.2, 21.3, 21.4, 24.4_

  - [ ] 12.3 Implement the error report workbook (Fiducial_backend)
    - `buildErrorReport(import, rows)` in `eb-census-template.ts`: Census sheet (row number, uploaded headers and
      values, Errors) and Issues sheet; every cell a string with `numFmt '@'`, never a formula object
    - _Requirements: 21.5, 21.7_

  - [ ] 12.4 Add the upload, preview, correction and report routes (Fiducial_backend)
    - In `eb-product.routes.ts`: list and upload imports, preview with `?mode=`, correct a row, discard, error report
      (`proposals.view`, 409 `EB_NO_ERRORS` when no issue, `Cache-Control: no-store`, export audit with counts only)
    - Additive on `/ghi`: optional `?mode=` on the preview and the new error report route
    - _Requirements: 16.6, 16.7, 20.1, 21.5, 21.6, 21.8, 24.1, 25.4_

  - [ ] 12.5 Write integration tests for upload and preview (Fiducial_backend, `test/eb-census.test.ts`)
    - Each file problem (size, not xlsx, sheet, missing column header, no rows, 10,001 rows, marker mismatch naming
      both); missing marker warning; open preview discarded; preview per mode; corrections including an employee ID
      change; error report text cells for `=1+1`, `+1`, `-1`, `@x`, `no-store`, audit without values; a downloaded
      template filled with valid rows previews with zero invalid rows for each of the seven templates
    - Per route 401, roles, foreign import or case id 404, locked 409
    - _Requirements: 19.10, 20.1–20.13, 21.1–21.8, 24.4, 24.5, 26.2, 26.6_

- [ ] 13. Import commit (Fiducial_backend)
  - [ ] 13.1 Implement the commit for GPA, GTLI and GMC with a mode (Fiducial_backend)
    - `commit(scope, …, { policy, mode? })` in one `withTransaction`: reload and `assertWritable`, load members,
      identities and unresolved keys, `classifyImport()` and the policy (refusal before any write), identities via
      `ensureSelfIdentities()`, `insertMany` new members with `employeeIdentityId`, `bulkWrite` updates of sum insured,
      salary and joining date only, mark the import with policy, mode, result and per-row state, raise
      `censusRevision` only when something changed, `writeAudits()` for the import, each member and each identity
    - Route `POST …/imports/:importId/commit` (policy required, 400 for unknown policy or mode)
    - _Requirements: 17.2, 17.3, 17.4, 17.9, 22.1–22.7, 22.9, 22.10, 22.11, 25.1, 25.2_

  - [ ] 13.2 Keep the GMC legacy commit and add identities to it (Fiducial_backend)
    - A GMC commit without `mode` delegates to today's `census.service.ts` path (duplicates are errors, fingerprint
      guard) and adds identity linking and the identity checks of design D7
    - Run `test/ghi.test.ts`; if an existing GHI test's expected value changes because of D7 (a Self row differing from
      the company identity is refused), name that test here and change only that expectation (26.7)
    - _Requirements: 16.3, 16.7, 17.2, 17.5, 22.8, 26.7 (design D7, D8)_

  - [ ] 13.3 Write integration tests for the commit (Fiducial_backend, `test/eb-census.test.ts`)
    - Counts equal the records in the database; the same file twice creates nothing the second time, reports every row
      unchanged and leaves `censusRevision`; Add new only and Add and update on one case only; Valid only lists left-out
      rows; one employee on a GMC, a GPA and a GTLI case of one company holds one identity, two companies two; an
      injected transaction failure leaves no member, identity or audit and the preview unchanged; GMC fingerprint guard
      and the no-mode commit as today
    - _Requirements: 17.1–17.4, 22.1–22.11, 26.2, 26.6_

- [ ] 14. Manual census entry and company employees (Fiducial_backend)
  - [ ] 14.1 Make manual member writes product-aware (Fiducial_backend)
    - Member add, edit and remove in `census.service.ts` with `scope`: plan required on GPA/GTLI, Census_Validator on
      the member and its whole family against the stored census, 400 with issues on failure, identity created or reused
      in the same transaction for Self rows, unresolved key 409, Self removal with dependants 409 naming them, locked
      or placed 409, `censusRevision` raised by one and audited
    - Routes on the product router; `/ghi` member routes keep their request and response fields
    - _Requirements: 17.3, 17.4, 17.12, 18.10, 18.11, 23.1, 23.2, 23.4, 23.5, 23.6, 23.7, 23.8_

  - [ ] 14.2 Add the census summary and whole-census issues (Fiducial_backend)
    - `GET …/census/summary` with `freeCoverLimit` and `aboveFreeCoverLimit` for GTLI; `GET …/census/issues` with
      whole-census issues and `familyShortfalls()`
    - _Requirements: 5.3, 18.9_

  - [ ] 14.3 Implement employee list, update and resolve (Fiducial_backend)
    - `updateEmployee` and `resolveEmployee` in `employees.service.ts`: reason 1–500; values applied to Self members on
      open, unlocked, unplaced cases of the company; locked, placed and closed members only linked; each affected case's
      census re-checked (409 `EB_IDENTITY_CONFLICT` with references and issues, nothing changed); `censusRevision`
      raised on changed cases; audited with before, after, reason and cases
    - Routes `GET /eb/companies/:clientId/employees` (`proposals.view`), `PUT …/employees/:employeeId` and
      `POST …/employees/resolve` (`proposals.edit`) in `eb.routes.ts`; an identity of another company → 404
    - _Requirements: 17.6, 17.7, 17.11, 17.13, 24.2_

  - [ ] 14.4 Write integration tests for manual entry and employees (Fiducial_backend)
    - `test/eb-census.test.ts` (members): add, edit, remove under the same rules as the import, 400 with issues and no
      audit, Self removal refused, revision raised once, locked and placed 409
    - `test/eb-employees.test.ts` (update and resolve): mismatch issue, update applied to open cases only, refusal when
      a case would break, snapshots unchanged, foreign company 404
    - _Requirements: 17.5, 17.6, 17.7, 23.1–23.8, 26.2, 26.6_

- [ ] 15. Checkpoint: census
  - Ensure all tests pass (`npm run lint`, `npm run typecheck`, `npm test` in Fiducial_backend); ask the user if
    questions arise.

- [ ] 16. GPA and GTLI RFQ (Fiducial_backend)
  - [ ] 16.1 Implement RFQ generation and documents (Fiducial_backend)
    - `src/modules/ghi/eb-documents.ts`: built-in RFQ model (Data Sheet fields, plan name, version, slots, census
      summary, every member; "awaiting client confirmation" for an unconfirmed version) written through `ghi-sheet.ts`
      as Excel and A4 PDF with the letterhead when uploaded
    - `ghi-rfq.service.ts` with `scope`: preconditions complete Data Sheet, plan, a member free of issues and no family
      shortfall (409 `GHI_INCOMPLETE` listing each item); new Draft version, earlier versions untouched; stage to RFQ on
      the first version; out of date on any requirements or census revision change
    - _Requirements: 3.2, 6.1, 6.2, 6.4, 6.8, 18.9_

  - [ ] 16.2 Add the RFQ approval, insurers, mail and lock routes (Fiducial_backend)
    - On the product router: RFQ state, preview, generate, submit, decision (`proposals.approve`), file
      (`proposals.export`, audited), insurers (1–5, unique), decline with reason, dispatch and mark-sent
      (`proposals.send`); mail only through the `MailTransport`, one mail per insurer to its master addresses, send id
      idempotent, failures per insurer; the first Sent locks the case
    - _Requirements: 6.3, 6.5, 6.6, 6.7, 6.9, 6.10, 7.6, 24.1_

  - [ ] 16.3 Write integration tests for the RFQ (Fiducial_backend, `test/eb-workflow.test.ts`)
    - Preconditions and their messages; versions v1, v2; out of date after a Data Sheet, plan or census change;
      approval and return; email with `FakeTransport` and mark-sent; repeated send id mails nobody twice; mail off 409;
      a failing insurer; the lock refuses Data Sheet, plan and census changes; per route 401, roles, foreign ids 404
    - _Requirements: 6.1–6.10, 26.2, 26.6_

- [ ] 17. GPA and GTLI quotes (Fiducial_backend)
  - [ ] 17.1 Make quotes product-aware (Fiducial_backend)
    - `ghi-quotes.service.ts` with `scope`: the profile's terms schema, `statedRate` kept as text, GST from
      `premiumOf()` with the case's GST rate stored, deviations from the profile against the locked Data Sheet, versions
      with reasons, one draft per insurer, declines, required file, refusals of 7.8 and 7.9; stage to QCR on the first
      recorded quote
    - Quote and file routes on the product router
    - _Requirements: 3.2, 7.1–7.9, 25.7_

  - [ ] 17.2 Write integration tests for quotes (Fiducial_backend, `test/eb-workflow.test.ts`)
    - GST 1,000.05 at 18%; GPA and GTLI deviations; revisions keep earlier versions; second draft 409; recorded edit
      409; Not sent insurer 409; missing file 400; decline then quote; per route 401, roles, foreign ids 404
    - _Requirements: 7.1–7.9, 26.2, 26.6_

- [ ] 18. GPA and GTLI QCR (Fiducial_backend)
  - [ ] 18.1 Implement the QCR build, versions and approval (Fiducial_backend)
    - `ghi-qcr.service.ts` with `scope`: `qcrCandidates()` and `lowestMarks()`, deviations beside each quote, optional
      recommendation (one of the compared insurers) and remarks, numbered versions, submit (stage to Approval),
      approve or reject with the fingerprint (409 `QCR_CHANGED`), rejection comment and return to QCR, voiding when a
      compared quote changes, approved versions immutable
    - QCR routes on the product router
    - _Requirements: 3.2, 3.4, 8.1, 8.2, 8.3, 8.4, 8.5_

  - [ ] 18.2 Implement the QCR download and mail (Fiducial_backend)
    - Built-in QCR layout in `eb-documents.ts` (Excel and A4 PDF, letterhead), download audited as export; mail to 1–10
      of the company's contacts with an email, never Cc or Bcc or typed addresses, mail log, audit, send id idempotent
    - _Requirements: 8.6, 8.7, 8.8, 25.4_

  - [ ] 18.3 Write integration tests for the QCR (Fiducial_backend, `test/eb-workflow.test.ts`)
    - Latest recorded version per non-declined insurer, every lowest marked, fingerprint refusal, voiding, rejection
      back to QCR, download audit, mail to contacts only, mail off 409; per route 401, roles, foreign ids 404
    - _Requirements: 8.1–8.8, 26.2, 26.6_

- [ ] 19. Client decision, payments and placement (Fiducial_backend)
  - [ ] 19.1 Implement the client decision (Fiducial_backend)
    - `src/modules/ghi/eb-placement.service.ts` `recordEbClientDecision`: approved latest QCR at Approval; acceptance
      sets the agreed premium from the chosen quote version (stored with it) and moves to Payment; rejection returns to
      QCR; replacement while no payment is RECEIVED, and at Payment only by an acceptance (design D10, flagged); 400 and
      409 refusals of 9.5 and 9.6; audited before and after
    - Route `POST …/qcrs/:qcrId/client-decision`
    - _Requirements: 3.2, 3.4, 9.1, 9.2, 9.4, 9.5, 9.6, 9.7, 9.8, 10.3_

  - [ ] 19.2 Make payments product-aware (Fiducial_backend)
    - `addPayment` and `updatePayment` with `profile.agreedPremium`; refused before a decision or when Closed or placed
      (409 `EB_STAGE`); validation of 10.4 and proof files of 10.5; `paymentsSummary()` in the list; stage to Placement
      Slip when RECEIVED covers the agreed premium, in the same transaction; audited
    - Payment routes on the product router
    - _Requirements: 3.2, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6_

  - [ ] 19.3 Implement the placement slip and snapshot (Fiducial_backend)
    - `issuePlacement`: in one transaction, the `placement` field and the snapshot header and members (unique
      `{ caseId }` refuses a second issue), optional policy number and dates, audited with the snapshot's fields;
      `ebPlacementState` lists what is missing; `ebPlacementSlipFile` (Excel or A4 PDF, from the snapshot once placed,
      export audit with format, insurer and quote version)
    - Add the defensive GMC product filter in `placedPolicy()` and `claimPolicies()` so claims never see GPA/GTLI cases
    - Routes `GET …/placement`, `GET …/placement/slip`, `POST …/placement`
    - _Requirements: 11.1–11.7, 16.9, 25.4 (design D14)_

  - [ ] 19.4 Write integration tests for the end of the workflow (Fiducial_backend)
    - `test/eb-workflow.test.ts`: decision (agreed premium, later revision leaves it, replacement, D10 refusal at
      Payment), payments (FAILED not counted, covered moves the stage, decision change refused once RECEIVED), placement
      (snapshot, second issue 409, every change 409 when placed, download from the snapshot, missing steps 409)
    - `test/eb-stages.test.ts` (complete): every move of the 3.2 table, repeated work leaves the stage
    - Claims regression: a placed GMC policy's claims find the same member ids and employee key
    - _Requirements: 3.2, 3.3, 3.4, 9.1–9.8, 10.1–10.6, 11.1–11.7, 16.9, 26.2, 26.6_

- [ ] 20. Checkpoint: backend complete
  - Ensure all tests pass (`npm run lint`, `npm run typecheck`, `npm test`, `npm run build` in Fiducial_backend) and
    every new route appears in the OpenAPI document; ask the user if questions arise.

- [ ] 21. Frontend foundation (Fiducial_frontend)
  - [ ] 21.1 Sync the contracts and allow the new API areas (Fiducial_frontend)
    - Run `npm run shared:sync`; add `eb` and `family-plans` to `src/lib/server/proxy-paths.ts`
    - Extend `proxy-paths.test.ts` by adding cases: `eb/cases` and `family-plans` forwarded, `ebx` and `family` not
    - _Requirements: 24.6, 26.1_

  - [ ] 21.2 Add the navigation and page permissions (Fiducial_frontend)
    - `nav-config.ts`: an "Employee Benefits" group with GMC (`/ghi`), GPA (`/eb/gpa`), GTLI (`/eb/gtli`), each
      `proposals.view`; "Family plans" under Masters (`masters.view`); `OTHER_PAGES` entries for the case pages
    - `nav-config.test.ts` changes its expected navigation because of 2.1: name the changed expectations in the change
    - _Requirements: 2.1, 12.4, 24.3, 26.7_

  - [ ] 21.3 Write the EB data layer (Fiducial_frontend)
    - `src/lib/eb/`: query keys and fetchers through `apiFetch({ schema })` for cases, Data Sheets, plans, census,
      imports, templates, RFQ, quotes, QCR, decisions, payments, placement, family plans, plan defaults and employees;
      every query of a case under one key so one invalidation refreshes it
    - _Requirements: 2.6, 2.8, 24.3_

- [ ] 22. Frontend cases and Data Sheets (Fiducial_frontend)
  - [ ] 22.1 Build the product choice and the new case form (Fiducial_frontend)
    - `line-of-business.tsx`: two radio cards, Property and Employee Benefits, none selected; `eb/product-choice.tsx`:
      GMC, GPA, GTLI, none selected; `eb/new-eb-case-form.tsx` with the shared resolver, no submit before a product,
      routes to `/ghi/{id}` or `/eb/{product}/{id}`; `/ghi/new` opens it with GMC chosen; Property form unchanged
    - Only for `proposals.create`; API field errors through `form-errors.ts`, input kept
    - _Requirements: 1.1, 1.2, 1.3, 1.8, 2.2, 2.12_

  - [ ] 22.2 Build the GPA and GTLI case lists (Fiducial_frontend)
    - `src/app/(app)/eb/[product]/page.tsx` and `eb-list-view.tsx`: the GHI list table with stage, type, company and
      search filters in the URL, loading, empty and error states, `DemoModeGate` in mock mode
    - _Requirements: 2.3, 2.7_

  - [ ] 22.3 Build the case workspace (Fiducial_frontend)
    - `src/app/(app)/eb/[product]/[id]/page.tsx`, `eb-case-view.tsx`, `components/eb/eb-workspace.tsx` and
      `eb-tabs.tsx`: product name, stage stepper with `aria-current`, next step from the API, close dialog with reason,
      Closed reason, tabs of the product only (no Final QCR or Policy), actions through `usePermission()`
    - _Requirements: 2.4, 2.6, 2.7, 2.8, 3.5, 3.6_

  - [ ] 22.4 Build the GPA and GTLI Data Sheet forms (Fiducial_frontend)
    - `gpa-requirements-form.tsx`, `gtli-requirements-form.tsx`, `sum-insured-basis-fields.tsx`,
      `gpa-covers-fields.tsx` with the shared schemas, the covers marked awaiting confirmation (Q10), the dependant basis
      only when the plan has dependants (Q11), the missing list from the API, the locked state; plug into `eb-tabs.tsx`
    - _Requirements: 4.1–4.11, 5.1–5.8, 2.12_

  - [ ] 22.5 Build the plan card and assign dialog (Fiducial_frontend)
    - `plan-card.tsx` (name, version, slots, "Awaiting client confirmation" with open questions, "Plan needed before
      the RFQ"), `assign-plan-dialog.tsx` (active plans of the product, 409 families listed); on GPA/GTLI workspaces and
      on the GMC workspace, where the family definition shows as taken from the plan
    - _Requirements: 14.6, 15.3, 15.5, 15.8, 15.9, 16.4_

  - [ ] 22.6 Write component tests for cases (Fiducial_frontend)
    - Product choice (none preselected, no submit before a choice, Property unchanged), list states, workspace tabs per
      product and actions per permission, Data Sheet field errors from the schema and the API, plan card and dialog
    - _Requirements: 1.1–1.3, 2.4, 2.7, 2.12, 4.8, 15.5, 26.2_

- [ ] 23. Frontend census (Fiducial_frontend)
  - [ ] 23.1 Make the census panel and member dialog product-aware (Fiducial_frontend)
    - `ghi/census-panel.tsx` and `member-dialog.tsx` take a `product` prop (split below about 250 lines where touched):
      Annual Salary column when the basis uses it, `checkEbCensus` on typing with the BigInt `deriveSumInsured`, API
      issues on their fields, input kept; plug into `eb-tabs.tsx`
    - _Requirements: 18.1–18.9, 23.3, 23.6_

  - [ ] 23.2 Extend the import panel (Fiducial_frontend)
    - `ghi/census-import.tsx` with `product`: mode select, policy radio with no default, warnings beside errors, file
      warnings, row corrections, `error-report-button.tsx`, result counts and left-out rows
    - _Requirements: 20.8, 20.13, 21.1–21.5, 22.1, 22.2, 22.4, 22.7, 22.9_

  - [ ] 23.3 Build the template download dialog (Fiducial_frontend)
    - `eb/template-download-dialog.tsx` and `provisional-notice.tsx`: product, active plan, optional case of that
      product, the provisional notice beside the button, "Awaiting client confirmation" for an unconfirmed version,
      file download through the proxy; opened from the census panel
    - _Requirements: 14.6, 19.3, 19.5_

  - [ ] 23.4 Write component tests for the census screens (Fiducial_frontend)
    - Member dialog issues on typing; import panel mode, policy without default, warnings and counts; template dialog
      notice and confirmation label
    - _Requirements: 19.5, 20.8, 22.1, 23.3, 26.2_

- [ ] 24. Frontend RFQ, quotes, QCR, payments and placement (Fiducial_frontend)
  - [ ] 24.1 Make the RFQ panel product-aware (Fiducial_frontend)
    - `ghi/rfq-panel.tsx` and `rfq-insurers.tsx` take `product`: missing items, versions, approval, email with
      checkboxes from the insurer master, mark sent, send ids, mail off fallback; plug into `eb-tabs.tsx`
    - _Requirements: 6.1–6.10_

  - [ ] 24.2 Build the GPA and GTLI quote form (Fiducial_frontend)
    - `eb/eb-quote-form.tsx`, `gpa-terms-fields.tsx`, `gtli-terms-fields.tsx`: base premium, stated rate, terms, files
      (at least one), revision reason; GST, totals and deviations shown from the API only
    - _Requirements: 7.1–7.9_

  - [ ] 24.3 Build the QCR and client decision panels (Fiducial_frontend)
    - `eb/eb-qcr-panel.tsx` reusing `qcr-table.tsx`: submit, approve or reject with the fingerprint, download, send to
      the company's contacts by checkbox; `client-decision-panel.tsx` labelled as awaiting the client's confirmation of
      the workflow (Q1), record action for `proposals.edit` only
    - _Requirements: 8.1–8.8, 9.1–9.8_

  - [ ] 24.4 Build the payments and placement panels (Fiducial_frontend)
    - `ghi/payments-panel.tsx` with `product`: agreed, received, pending and outstanding from the API;
      `eb/eb-placement-panel.tsx`: missing steps, slip download, issue dialog with optional policy number and dates
      marked awaiting confirmation (Q2), placed state
    - _Requirements: 10.1–10.6, 11.1–11.7_

  - [ ] 24.5 Write component tests for the workflow screens (Fiducial_frontend)
    - Quote form shows API totals only; QCR approval sends the fingerprint; client decision label and permission;
      payments figures from the API; placement missing steps and the confirmation labels
    - _Requirements: 7.2, 8.3, 9.3, 10.2, 11.3, 26.2_

- [ ] 25. Frontend Family Plan Master and company page (Fiducial_frontend)
  - [ ] 25.1 Build the family plan pages (Fiducial_frontend)
    - `src/app/(app)/masters/family-plans/` list (filter by product, code, name, active, version in effect,
      confirmation badge) and `[id]` plan page; `components/family-plans/` plan table, plan form sheet,
      `version-editor.tsx` (`useFieldArray` slots, relationship checkboxes with maximums, mixing Yes/No with no default,
      schema errors before saving, no send while any is shown), version card, version actions (activate, end, confirm),
      deactivate dialog listing open cases; write actions for `masters.manage` only
    - _Requirements: 12.4, 12.5, 12.8, 13.10, 14.6_

  - [ ] 25.2 Build the company page cards (Fiducial_frontend)
    - `clients/employees-card.tsx` (search, 50 per page, unresolved first with a label, products and case references;
      shown with `clients.view` and `proposals.view`), `employee-dialog.tsx` (update and resolve with a reason, for
      `proposals.edit`), `plan-defaults-card.tsx` (for `clients.manage`)
    - _Requirements: 15.1, 17.6, 17.11, 17.13_

  - [ ] 25.3 Write component tests for family plans and the company page (Fiducial_frontend)
    - Version editor errors before saving and no send; deactivation lists open cases; actions by permission; employees
      card order and actions by permission
    - _Requirements: 12.5, 12.8, 13.10, 17.13, 26.2_

  - [ ] 25.4 Extend the smoke test (Fiducial_frontend)
    - `e2e/smoke.spec.ts` opens `/eb/gpa` in mock mode and sees the demo-mode state
    - _Requirements: 2.7, 26.1_

- [ ] 26. Checkpoint: frontend complete
  - Ensure all tests pass (`npm run lint`, `npm run typecheck`, `npm test` in Fiducial_frontend); ask the user if
    questions arise.

- [ ] 27. Documentation (both repositories)
  - [ ] 27.1 Add the Employee Benefits section to `docs/OPEN_ITEMS.md` (Fiducial_backend)
    - The seven provisional templates; each default plan awaiting client confirmation with its open questions; the 16
      open questions with their defaults; the design points D6, D7, D8 and D10 for confirmation
    - _Requirements: 26.3_

  - [ ] 27.2 Update the backend README and steering files (Fiducial_backend)
    - README (products, Family Plan Master, identity, templates; permissions table with each new route), and
      `.kiro/steering/product.md`, `structure.md`, `tech.md` (built list, new module folders `family-plans/`,
      `employees/`, `ghi/products/`)
    - _Requirements: 26.4_

  - [ ] 27.3 Update the frontend README and steering files (Fiducial_frontend)
    - README permissions per new screen, and `.kiro/steering/product.md`, `structure.md`, `tech.md` (built list,
      `components/eb/`, `components/family-plans/`, `src/lib/eb/`, the `eb` and `family-plans` proxy areas)
    - _Requirements: 26.4_

- [ ] 28. Final verification (both repositories)
  - [ ] 28.1 Verify Fiducial_backend
    - `npm run lint` (zero warnings), `npm run typecheck`, `npm test`, `npm run build`; `git diff` shows no change to
      `src/shared/permissions.ts`, `package.json` or `package-lock.json`; existing tests none deleted or skipped
    - _Requirements: 24.1, 24.7, 26.1, 26.7_

  - [ ] 28.2 Verify Fiducial_frontend
    - `npm run shared:sync` then `npm run shared:check`, `npm run lint` (zero warnings), `npm run typecheck`,
      `npm test`, `npm run build`, `npm run test:e2e`; no change to `package.json` or `package-lock.json`
    - _Requirements: 24.7, 26.1, 26.7_

- [ ] 29. Final checkpoint
  - Ensure all tests pass in both repositories, ask the user if questions arise.

## Notes

- Test sub-tasks are not marked optional: Requirement 26 makes the unit, property and integration tests part of the
  feature (26.2, 26.5, 26.6).
- Property tests run only in Fiducial_frontend with fast-check 4.10.2, already a dev dependency; the backend pins its
  Decimal twins to the shared BigInt functions with `eb-calc.test.ts` (design D9).
- The flagged design points are built as designed and listed in OPEN_ITEMS for confirmation: D6 (`gmcFamilyCover`),
  D7 (identity checks on GMC), D8 (GMC no-mode commit), D10 (decision replaced at Payment).
- Any later backend task that touches `src/shared` is followed by `npm run shared:sync` before the frontend uses it;
  task 21.1 syncs once more before the screens.
- Nothing is committed in either repository.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3", "1.4"] },
    { "id": 1, "tasks": ["1.5", "1.6", "1.7"] },
    { "id": 2, "tasks": ["1.8", "1.9", "1.10"] },
    { "id": 3, "tasks": ["1.11"] },
    { "id": 4, "tasks": ["1.12", "1.13", "1.14"] },
    { "id": 5, "tasks": ["2.1", "4.1"] },
    {
      "id": 6,
      "tasks": [
        "2.2",
        "2.3",
        "2.4",
        "2.5",
        "2.6",
        "2.7",
        "2.8",
        "2.9",
        "2.10",
        "2.11",
        "2.12",
        "2.13",
        "2.14",
        "2.15",
        "2.16",
        "2.17",
        "2.18",
        "2.19",
        "2.20",
        "2.21",
        "2.22",
        "2.23",
        "2.24",
        "2.25",
        "2.26",
        "2.27",
        "2.28",
        "2.29",
        "2.30",
        "2.31",
        "2.32",
        "4.2"
      ]
    },
    { "id": 7, "tasks": ["4.3", "5.1", "6.1"] },
    { "id": 8, "tasks": ["5.2", "5.3"] },
    { "id": 9, "tasks": ["5.4", "6.2"] },
    { "id": 10, "tasks": ["6.3", "7.1"] },
    { "id": 11, "tasks": ["7.2", "7.3"] },
    { "id": 12, "tasks": ["7.4"] },
    { "id": 13, "tasks": ["7.5", "8.1"] },
    { "id": 14, "tasks": ["8.2"] },
    { "id": 15, "tasks": ["8.3", "8.4", "9.1"] },
    { "id": 16, "tasks": ["9.2"] },
    { "id": 17, "tasks": ["9.3", "11.1"] },
    { "id": 18, "tasks": ["11.2"] },
    { "id": 19, "tasks": ["11.3", "12.1"] },
    { "id": 20, "tasks": ["12.2", "12.3"] },
    { "id": 21, "tasks": ["12.4"] },
    { "id": 22, "tasks": ["12.5", "13.1"] },
    { "id": 23, "tasks": ["13.2"] },
    { "id": 24, "tasks": ["13.3", "14.1"] },
    { "id": 25, "tasks": ["14.2"] },
    { "id": 26, "tasks": ["14.3"] },
    { "id": 27, "tasks": ["14.4", "16.1"] },
    { "id": 28, "tasks": ["16.2"] },
    { "id": 29, "tasks": ["16.3", "17.1"] },
    { "id": 30, "tasks": ["17.2", "18.1"] },
    { "id": 31, "tasks": ["18.2"] },
    { "id": 32, "tasks": ["18.3", "19.1"] },
    { "id": 33, "tasks": ["19.2"] },
    { "id": 34, "tasks": ["19.3"] },
    { "id": 35, "tasks": ["19.4", "21.1"] },
    { "id": 36, "tasks": ["21.2", "21.3"] },
    { "id": 37, "tasks": ["22.1", "22.2", "22.3", "25.1"] },
    { "id": 38, "tasks": ["22.4", "22.5", "25.2"] },
    { "id": 39, "tasks": ["22.6", "23.1", "25.3"] },
    { "id": 40, "tasks": ["23.2", "23.3"] },
    { "id": 41, "tasks": ["23.4", "24.1"] },
    { "id": 42, "tasks": ["24.2"] },
    { "id": 43, "tasks": ["24.3"] },
    { "id": 44, "tasks": ["24.4"] },
    { "id": 45, "tasks": ["24.5", "25.4"] },
    { "id": 46, "tasks": ["27.1", "27.2", "27.3"] },
    { "id": 47, "tasks": ["28.1", "28.2"] }
  ]
}
```
