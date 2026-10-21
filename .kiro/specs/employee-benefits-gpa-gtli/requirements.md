# Requirements Document

Employee Benefits (GPA and GTLI), Family Plan Master and product census templates.

## Introduction

Fiducial places one employee-benefits product today: group health (GHI, also called GMC), in its own module
(`src/modules/ghi/`, routes `/api/v1/ghi`). A GHI case has a Data Sheet, a census of insured lives, RFQ versions
with approval, quotes, a QCR with approval and the client's decision, a final QCR, payments, a placement slip and
a policy. Its family rules live on the case's Data Sheet (`familyDefinition`) and are checked in `census-rules.ts`.
Census members are stored per case (`ghi_members`); the same employee on two cases is two unrelated records.

This spec adds three things:

- **N1**: two more Employee Benefits products, Group Personal Accident (**GPA**) and Group Term Life Insurance
  (**GTLI**), beside GMC. Each has its own cases and workflow (Data Sheet → RFQ → QCR → Approval → Payment →
  Placement Slip), built on the GHI infrastructure but with its own business rules. One company employee is one
  identity across GMC, GPA and GTLI; what each product covers stays separate.
- **N2**: a **Family Plan Master**: who a family may include, kept as versioned data in the database rather than in
  code. Four default plans (Self only, 1+3, 1+5, 1+7), configurable per product and assigned to a company, a case
  and, once placed, frozen with the policy.
- **N3**: seven product census templates (GMC Self, GMC 1+3, GMC 1+5, GMC 1+7, GPA Self Only, GPA 1+3, GTLI), with
  upload, row-level preview, corrections, an Excel error report and a safe import and re-import.

The client has not supplied GMC, GPA or GTLI census formats, nor the GPA and GTLI business rules. The repository's
client formats (`data/client-formats/`) are Property only. So the seven templates are **provisional**, built from
the existing census columns, and every GPA and GTLI rule the client has not given is a setting or an open question.
Nothing is invented.

The spec changes both repositories. It lives in Fiducial_backend because the contracts start in its `src/shared`.
The Fiducial_frontend tasks are in the same task list.

Sources: the client request N1, N2 and N3; the GHI module and its decisions in `docs/OPEN_ITEMS.md` (GHI-01 to
GHI-08); the claims module, which reads GHI census members (`claims`, `claim_links`).

Out of scope:

- pricing GPA or GTLI premiums in the app (premiums come from insurers' quotes, as for GMC)
- endorsements after the RFQ is sent or the policy is placed (GHI-02 stays open for every product)
- claims on GPA or GTLI policies (claims stay on placed GMC policies only)
- the client's own GPA and GTLI RFQ, QCR and placement slip layouts (not received; built-in layouts are used)
- any change to Property proposals, their routes, screens or records

## Glossary

| Term                   | Meaning                                                                                                                                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API                    | The Fiducial_backend Express API.                                                                                                                                                                           |
| Web_App                | The Fiducial_frontend Next.js app and its BFF routes.                                                                                                                                                       |
| Employee Benefits      | The line of business beside Property that holds GMC, GPA and GTLI.                                                                                                                                          |
| Product                | One Employee Benefits product: `GMC` (group health, the existing GHI), `GPA` or `GTLI`.                                                                                                                     |
| EB case                | One placement of one product for one company and one policy period. Existing GHI cases are GMC EB cases.                                                                                                    |
| Company                | The client in the client master (`clients`) that an EB case is for.                                                                                                                                         |
| Employee identity      | One employee of one company, held once for every product: the company, the employee ID and the employee's own details (name, gender, date of birth, date of joining).                                       |
| Employee key           | The employee ID upper-cased without spaces, as GHI computes it today. Unique per company, not across companies.                                                                                             |
| Insured member         | One insured life on one EB case: the employee or a dependant, with that product's coverage (sum insured, salary where used).                                                                                |
| Enrollment             | An employee identity's insured members on one EB case. The same identity can have one enrollment per case.                                                                                                  |
| Family plan            | A named definition of who a family may include for one product, for example "GMC 1+3".                                                                                                                      |
| Plan version           | One numbered, dated version of a family plan. A plan version is Draft until activated; an activated version's slots and limits never change.                                                                |
| Slot                   | One part of a plan version: the relationships it accepts, its minimum and maximum members, and a maximum per relationship. For example "Children: Child, 0 to 3".                                           |
| Plan assignment        | The plan version an EB case uses, with a copy of its slots taken when assigned.                                                                                                                             |
| Policy snapshot        | The census, plan version and slots stored with a placed EB case. It never changes.                                                                                                                          |
| Family_Plan_Master     | The API and screens that keep family plans and their versions.                                                                                                                                              |
| Census_Validator       | The shared, pure census rules: reads a row, checks it against the case's Data Sheet and plan, and against its family. Used by the API for imports and manual entry, and by the Web_App for typing feedback. |
| Template_Builder       | The API code that builds a census template and an error report as Excel workbooks (exceljs).                                                                                                                |
| Import_Service         | The API code that reads an uploaded census, keeps it as a preview, applies corrections and imports it.                                                                                                      |
| Provisional template   | A census template built by Fiducial because the client's format has not been received. Marked as such in the file and on screen.                                                                            |
| Sum insured basis      | How a member's sum insured is set: one flat amount, one of several offered amounts (graded), or a multiple of annual salary.                                                                                |
| Free cover limit (FCL) | For GTLI, the sum insured up to which an insurer accepts members without medical evidence. Recorded, not enforced.                                                                                          |
| Lock                   | The point after which a case's Data Sheet, plan assignment and census cannot change: the first insurer sent the RFQ, as on GHI today.                                                                       |

## Requirements

### Requirement 1: Choosing the product when a case is created

**User Story:** As a Relationship Manager, I want to choose GMC, GPA or GTLI when I create an Employee Benefits
case, so that each case follows its own product's workflow.

#### Acceptance criteria

1. WHEN a user opens New proposal, THE Web_App SHALL offer exactly two lines of business, Property and Employee
   Benefits, with neither preselected.
2. WHEN a user chooses Employee Benefits, THE Web_App SHALL ask for the product from exactly three choices: GMC
   (Group Health), GPA (Group Personal Accident) and GTLI (Group Term Life Insurance). No product SHALL be
   preselected, and THE Web_App SHALL not send the create request until a product is chosen.
3. THE Web_App SHALL show New proposal and the product choice only to users whose roles hold `proposals.create`.
4. WHEN a user with `proposals.create` creates an EB case, THE API SHALL require the product, the case type (New
   business or Renewal), the company from the client master and the quote due date. For a renewal it SHALL also
   require the policy period and the expiring insurer. It SHALL accept an optional policy period for new business
   and optional assigned staff (the creator when left out), as GHI does today.
5. WHEN an EB case is created, THE API SHALL store its product on the case and SHALL return the product on the case
   and on every list item.
6. WHEN an EB case is created, THE API SHALL give it a reference of the form `<prefix>-<year>-<sequence>`. The prefix
   SHALL be GHI for GMC (the existing GHI series continues), GPA for GPA and GTLI for GTLI. The year SHALL be the
   IST calendar year of creation. The sequence SHALL be at least 4 digits, start at 0001 each year, and count each
   product separately, so no two EB cases share a reference.
7. THE API SHALL read and return every existing GHI case stored without a product as a GMC case, keeping its
   reference, and SHALL not write a product field to the stored record.
8. WHEN a user chooses Property, THE Web_App SHALL show the Property form with the same fields, validation and
   result as before this spec.
9. IF a create request has no product, names a product other than GMC, GPA or GTLI, names a company not in the
   client master, names staff who are not active or cannot edit cases, or is a renewal without its policy period or
   expiring insurer, THEN THE API SHALL refuse it (400) naming each field at fault, SHALL create no case and no audit
   entry, and SHALL not use up a reference number.
10. IF a user without `proposals.create` sends a create request, THEN THE API SHALL refuse it (403) and create
    nothing.
11. IF a request to edit an EB case names a product, THEN THE API SHALL refuse it (400) and leave the case unchanged.
12. WHEN an EB case is created, THE API SHALL write an audit entry in the same transaction, with a null `before` and
    an `after` that holds the product, reference, case type, company, policy period, quote due date and assigned
    staff.

### Requirement 2: Product-aware cases

**User Story:** As anyone working on Employee Benefits, I want cases listed, opened and edited by product, so that I
can find and work a GPA or GTLI case as easily as a GMC case.

#### Acceptance criteria

1. THE Web_App SHALL show Employee Benefits in the navigation, with one entry per product in the order GMC, GPA,
   GTLI, only to users with `proposals.view`.
2. WHEN a user opens `/ghi`, `/ghi/new` or `/ghi/{id}`, THE Web_App SHALL open the GMC case list, the new case form
   with GMC chosen, or that GMC case, as it does today.
3. WHEN a user with `proposals.view` lists EB cases, THE API SHALL return them most recently changed first, filtered
   by any combination of product, stage, type (New business or Renewal), company and search text. The search text
   SHALL be 1 to 100 characters after trimming and SHALL match, ignoring case, part of the case reference or the
   company name. Blank search text SHALL count as no search. THE API SHALL return a page of 1 to 100 cases (default
   20), with the page number (default 1), the page size, the total number of matching cases and the product on every
   item.
4. WHEN a user opens an EB case, THE Web_App SHALL show the product's name, that product's stages in order with the
   current stage marked, and only that product's tabs and actions (for example no Final QCR tab on a GPA or GTLI
   case, Requirement 9.4). Each action SHALL show only to users with the permission it needs (Requirement 24.1).
5. WHEN a user with `proposals.edit` saves an edit to an EB case, THE API SHALL accept only the policy start and end
   dates, the quote due date, the assigned staff and the expiring insurer and policy number, as GHI does today. THE
   API SHALL refuse (400) a request that also names the type, product or company, and SHALL change nothing. A
   successful edit SHALL be audited with the fields before and after.
6. WHEN a user opens a stage tab, THE Web_App SHALL show the data last saved by the API for that stage, also after
   the user leaves the page, reloads it or signs in again.
7. THE Web_App SHALL give every EB data view a loading state, an empty state with an action, and an error state with
   a retry, using `src/components/states.tsx`.
8. WHEN the API accepts a save, THE Web_App SHALL show a success message and SHALL display the values the API
   returned.
9. IF a request names an EB case id that does not exist, or a case of a product other than the one the route serves,
   THEN THE API SHALL answer 404 with the same response in both cases, without the case's product or any other of its
   data, and SHALL change nothing.
10. IF a list request names an unknown product, stage or type, a search text above 100 characters after trimming, a
    page size outside 1 to 100, or a page outside 1 to 10,000, THEN THE API SHALL refuse it (400), naming each field
    at fault, and return no cases.
11. IF a signed-in user without the permission an EB route needs (Requirement 24.1) calls it, THEN THE API SHALL
    refuse it (403) and return or change nothing.
12. IF the API refuses a save, THEN THE Web_App SHALL show the API's message on the field it names (or above the form
    when it names no field) and SHALL keep the values the user entered.

### Requirement 3: GPA and GTLI stages

**User Story:** As the placement team, I want GPA and GTLI cases to move through their stages as the work is done,
so that the case shows where it stands.

#### Acceptance criteria

1. THE API SHALL give GPA and GTLI cases exactly these stages, in this order: New / Renewal, Data Sheet, RFQ, QCR,
   Approval, Payment, Placement Slip, and Closed. WHEN a GPA or GTLI case is created, THE API SHALL set its stage to
   New / Renewal, labelled New for new business and Renewal for a renewal.
2. WHEN the work in this table is saved on a GPA or GTLI case whose stage comes before the stage reached, THE API
   SHALL move the case forward to that stage in the same save and SHALL add the new stage to the case's activity:

   | Stage reached  | By                                                                                    |
   | -------------- | ------------------------------------------------------------------------------------- |
   | Data Sheet     | the first save of the Data Sheet                                                      |
   | RFQ            | the first RFQ version generated, which needs a complete Data Sheet, a plan and census |
   | QCR            | the first recorded quote (a draft quote does not count)                               |
   | Approval       | the QCR submitted for approval                                                        |
   | Payment        | the QCR approved and the client's decision recorded (see Requirement 9)               |
   | Placement Slip | RECEIVED payments whose sum is equal to or above the agreed total premium             |

   IF the save fails, THEN THE API SHALL leave the stage unchanged. WHEN the same work is saved again on a case that
   is at or past that stage (for example a second RFQ version), THE API SHALL leave the stage unchanged.

3. IF a request asks for an action that the case's stage does not allow (for example recording a payment before
   the client's decision), THEN THE API SHALL refuse it (409) with a message naming what is missing, and change
   nothing, including the stage.
4. WHEN an approver rejects the QCR, or the client's decision rejects every insurer, on a case at Approval, THE API
   SHALL move the case back to QCR, keep its quotes, its QCR and the rejection with its reason, and add the move to
   the case's activity. THE case SHALL reach Approval again only by a new QCR submission. This SHALL be the only
   backward move of a GPA or GTLI case.
5. WHILE a GPA or GTLI case is neither placed nor Closed, WHEN a user with `proposals.edit` closes it with a reason
   of 1 to 300 characters after trimming, THE API SHALL set its stage to Closed, store the reason, add the closure
   and its reason to the case's activity, and audit it with the stage before and the stage and reason after.
6. WHEN a user opens a GPA or GTLI case, THE Web_App SHALL show its stage and the next step returned by the API,
   which names the work that reaches the next stage. IF the case is placed or Closed, THEN THE API SHALL return no
   next step, and THE Web_App SHALL show the stage and, for a Closed case, the reason.
7. THE API SHALL keep the GMC stages, their order and the moves between them as they are today, including the
   Final QCR stage and the policy step. A GPA or GTLI stage rule SHALL never apply to a GMC case.
8. THE API SHALL store each stage's data against one EB case, so it belongs to one company, one product and one
   policy period. A request on one EB case SHALL never read or change another case's stage data.
9. IF a close request has a reason that is blank or longer than 300 characters after trimming, THEN THE API SHALL
   refuse it (400) naming the reason field, and leave the case unchanged.
10. IF a close request names a placed GPA or GTLI case, THEN THE API SHALL refuse it (409) with a message that a
    placed case is complete and cannot be closed, and leave the case unchanged.
11. WHILE a GPA or GTLI case is Closed, THE API SHALL refuse with 409 every change to the case and its stage data,
    including the Data Sheet, plan assignment, census, RFQ, mails, insurer statuses, quotes, QCR, client decision,
    payments, placement slip, a second close and any stage move, and SHALL change nothing. THE API SHALL keep the
    Closed case and its data readable by users with `proposals.view`.

### Requirement 4: GPA Data Sheet

**User Story:** As a Relationship Manager, I want to record what the company asks for in its GPA cover, so that the
RFQ states it for the insurers.

#### Acceptance criteria

1. WHEN a user with `proposals.edit` saves the GPA Data Sheet of an unlocked GPA case, THE API SHALL store these
   fields: the company contact and locations, with the same fields and limits as on GMC; the declared employee count
   (optional, a whole number from 1 to 1,000,000); the sum insured basis and its values; the covers asked for; the
   dependant basis; the age limits per relationship group; the age reference date; up to 3 policy years of previous
   claims, each year once, with the same fields as on GMC; and other requirements as text of at most 2,000
   characters. The family plan is assigned to the case under Requirement 15 and is not a Data Sheet field.
2. THE API SHALL accept one of three sum insured bases (open question 7). Flat takes one amount above 0. Graded takes
   1 to 10 offered amounts, each above 0 and each listed once. Multiple of salary takes a multiplier above 0 and at
   most 100, with at most 2 decimal places, and an optional maximum above 0. THE API SHALL store only the values of
   the chosen basis.
3. WHERE the sum insured basis is Multiple of salary, THE API SHALL work out each member's sum insured as annual
   salary × multiplier, capped at the maximum when one is set, using decimal arithmetic on the server. THE API SHALL
   round the result half up to the whole rupee. This rounding is a default awaiting the client's confirmation (open
   question 9).
4. THE API SHALL record each of four covers as Required, Not required or not yet chosen: Accidental death, Permanent
   total disablement, Permanent partial disablement and Temporary total disablement. WHERE Temporary total
   disablement is Required, THE API SHALL accept an optional weekly benefit above 0 and an optional number of weeks
   from 1 to 520 (a technical bound, not a client rule). Other covers and cover limits SHALL be text of at most 1,000
   characters. THE Web_App SHALL mark the cover list on screen as awaiting the client's confirmation (open question
   10).
5. WHERE the case's assigned plan has a slot that accepts a relationship other than Self, THE API SHALL record the
   dependant basis as one of three: the employee's sum insured, the dependant's own amount from the census, or a
   percentage of the employee's sum insured. The percentage SHALL be above 0 and at most 100, with at most 2 decimal
   places, and SHALL be rounded as in criterion 4.3. THE Web_App SHALL mark this choice as awaiting the client's
   confirmation (open question 11).
6. THE API SHALL hold the age limits for four relationship groups: Employee, Spouse, Children, and Parents /
   parents-in-law. Each group has an optional minimum and an optional maximum, in whole completed years from 0 to 120. A blank limit means no limit. Limits are blank by default and are set per case, as on GMC (GHI-01, open
   question 13). WHERE the age reference date is blank, THE API SHALL work out ages on the policy start, or on the
   case's creation date when there is no policy start, as on GMC.
7. WHEN a GPA Data Sheet is saved or read, THE API SHALL keep a partly filled Data Sheet as a draft and SHALL return
   the list of items still missing before the RFQ, each item naming its field. The list SHALL hold three kinds of
   item: the sum insured basis and its values, when not chosen and filled; each of the four covers not yet marked
   Required or Not required; and the dependant basis, when criterion 4.5 applies and none is chosen. THE Data Sheet
   SHALL be complete only when the list is empty.
8. IF a GPA Data Sheet field is invalid, THEN THE API SHALL refuse the save (400) and SHALL return each invalid field
   with a message. THE previously saved Data Sheet SHALL stay unchanged. Examples of invalid fields: a maximum age
   below the minimum, a multiplier of 0 or above 100, a graded amount listed twice or more than 10 graded amounts,
   values that do not belong to the chosen basis, a Temporary total disablement benefit while that cover is not
   Required, a dependant percentage above 100, or the same claims policy year twice.
9. IF a GPA Data Sheet save arrives while the case is locked, THEN THE API SHALL refuse it (409) with a message
   saying the RFQ has been sent to an insurer. THE saved Data Sheet SHALL stay unchanged.
10. THE API SHALL accept and return every GPA Data Sheet amount as a decimal string, never as a number. Sums insured,
    the maximum and the weekly benefit are whole rupees of 1 to 13 digits. Claim premiums and claim amounts are
    rupees with at most 2 decimal places. The multiplier and the dependant percentage are decimal strings with at
    most 2 decimal places.
11. IF a GPA Data Sheet save contains a field that is not part of the GPA Data Sheet (for example a GMC field such as
    maternity or room rent), THEN THE API SHALL refuse the save (400) naming that field, and save nothing.

### Requirement 5: GTLI Data Sheet

**User Story:** As a Relationship Manager, I want to record what the company asks for in its GTLI cover, so that the
RFQ states it for the insurers.

#### Acceptance criteria

1. WHEN a user with `proposals.edit` saves the GTLI Data Sheet of an unlocked GTLI case, THE API SHALL store: the
   company contact and locations (as on GMC), the declared employee count (a whole number from 1 to 1,000,000), the
   sum insured basis and its values (criterion 5.4), the free cover limit asked for (optional, whole rupees above
   0), the age limits per relationship group (whole years from 0 to 120, blank by default meaning no limit, set per
   case as on GMC, GHI-01), the age reference date (blank means the policy start, else the day the case was
   created), the previous three years' claims (at most 3 policy years, each year once), additional benefits asked
   for (text, at most 2,000 characters) and other requirements (text, at most 2,000 characters). The family plan is
   assigned to the case under Requirement 15 and is not a Data Sheet field.
2. WHEN a GTLI case is created and its company has no active default GTLI plan, THE API SHALL assign the GTLI Self
   only plan in the version in effect on the policy start (else the creation date), marked as awaiting the client's
   confirmation (open question 6).
3. WHERE a free cover limit is entered, THE API SHALL flag in the census summary each member whose sum insured (as
   entered, or as worked out under criterion 5.4) is strictly above the limit, and SHALL give the count of flagged
   members. A member at or below the limit SHALL not be flagged. THE flag SHALL be information only: it SHALL not make
   a row invalid, block an import or block the RFQ (open question 12).
4. THE API SHALL accept one of these sum insured bases: Flat (one amount), Graded (1 to 10 distinct offered amounts),
   or Multiple of salary (a multiplier above 0 and at most 100, with at most 2 decimal places, as a technical bound
   and not a client rule, and an optional maximum), with every amount in whole rupees above 0. WHERE the basis is
   Multiple of salary, THE API SHALL work out each member's sum insured as annual salary × multiplier with decimal
   arithmetic, capped at the maximum when one is set, and rounded half up to the rupee as the default awaiting the
   client's confirmation (open question 9).
5. IF a GTLI Data Sheet save contains a field that belongs only to the GPA or GMC Data Sheet (for example the GPA
   covers, the GPA dependant basis, or GMC's room rent, maternity or family definition), THEN THE API SHALL refuse
   the save (400) naming the field, and save nothing. THE Census_Validator SHALL check a GTLI case only against its
   own Data Sheet and plan, never against a GPA or GMC setting.
6. WHEN a user with `proposals.edit` saves a GTLI Data Sheet, THE API SHALL save it as a draft even when partly
   filled and SHALL return the list of items still missing before the RFQ, empty when complete. THE list SHALL name
   the declared employee count, the sum insured basis, each value the chosen basis needs (the flat amount, at least
   one graded amount, or the multiplier) and, for a renewal, the previous years' claims. THE free cover limit, age
   limits, age reference date and text fields SHALL never be listed as missing.
7. IF a GTLI Data Sheet field is invalid (for example a maximum age below the minimum, a multiplier of 0 or above
   100, a graded amount given twice, more than 10 graded amounts, or a policy year given twice), THEN THE API SHALL
   refuse the save (400) naming each invalid field with a message, and SHALL keep the previously saved Data Sheet
   unchanged.
8. WHILE the case is locked, THE API SHALL refuse every change to the GTLI Data Sheet (409) with a message that the
   RFQ has been sent, and SHALL keep the saved Data Sheet unchanged.

### Requirement 6: GPA and GTLI RFQ

**User Story:** As an Underwriting / Placement user, I want to generate, approve and send the GPA or GTLI RFQ as I
do for GMC, so that insurers receive the requirements and the census.

#### Acceptance criteria

1. WHEN a user with `proposals.edit` generates the RFQ of an unlocked GPA or GTLI case that has a complete Data
   Sheet (Requirement 4.7 or 5.6), an assigned plan (Requirement 15) and at least one insured member with no census
   issue, THE API SHALL keep it as a new Draft version numbered one above the case's latest version (v1, v2, …), with
   its Excel and PDF files, and SHALL never change or delete an earlier version.
2. WHEN a version is generated, THE API SHALL build it in a built-in layout (open question 15), as an Excel workbook
   and an A4 PDF, holding the product's Data Sheet fields, the plan's name, version and slots, the census summary and
   every insured member of the case at that moment. THE PDF SHALL carry the broker's letterhead when an RFQ template
   is uploaded, and an unconfirmed plan version SHALL be shown as awaiting client confirmation (open question 16).
3. WHEN a user with `proposals.edit` submits the latest version while it is Draft or Returned, THE API SHALL mark it
   Awaiting approval. WHEN a user with `proposals.approve` decides on that version, THE API SHALL mark it Approved,
   or Returned with a comment of 1 to 1,000 characters saying what needs to change, as GMC does.
4. WHEN the Data Sheet, the plan assignment or the census changes after a version is generated, THE API SHALL mark
   that version out of date, whatever its status, and SHALL require a newly generated version before submitting,
   approving or sending.
5. WHEN a user with `proposals.send` emails the RFQ to 1 to 5 insurers of the case with a quote due date, THE API
   SHALL send the latest version, Approved and not out of date, as one mail per insurer, To that insurer's RFQ
   addresses from the insurer master only, with no Cc or Bcc and the RFQ attached as Excel or PDF, and SHALL log each
   mail in the mail log. WHEN such a user marks insurers as sent outside the app with a quote due date, THE API SHALL
   mark them Sent under the same version rule and send no mail.
6. WHEN the first insurer of the case becomes Sent, by email or marked sent outside the app, THE API SHALL lock the
   case: its Data Sheet, plan assignment and census SHALL stay as sent, and a new RFQ version SHALL not be generated.
7. THE API SHALL keep 1 to 5 insurers on a case, each from the insurer master and each at most once, and SHALL refuse
   (400) a choice of more than 5 or a repeated insurer, changing nothing.
8. IF a user asks to generate the RFQ while the case is locked, or while the Data Sheet is incomplete, no plan is
   assigned or no insured member is free of census issues, THEN THE API SHALL refuse it (409) with a message naming
   each missing item, and SHALL create no version.
9. IF a submit, approval, email or mark-sent request names a version that is not the latest, is out of date, or is
   not in the status the action needs (Approved for sending), or mail is off (409 `MAIL_DISABLED`), THEN THE API SHALL
   refuse it (409) with a message naming the reason, SHALL change no version or insurer status, and SHALL mail no
   one.
10. IF an insurer chosen for an email is inactive, has no RFQ address in the insurer master, or its mail is not
    accepted, THEN THE API SHALL report that insurer as Failed with a reason, keep its status unchanged, and still
    send to the other insurers. A repeated request with the same send id SHALL mail no insurer twice.

### Requirement 7: GPA and GTLI quotes

**User Story:** As an Underwriting / Placement user, I want to record each insurer's GPA or GTLI quote, so that the
QCR compares them.

#### Acceptance criteria

1. WHEN a user with `proposals.edit` saves a quote for an insurer on a GPA or GTLI case, THE API SHALL store it
   against that case and insurer with: the base premium before GST (rupees with at most 2 decimals, above 0, at most
   13 digits before the decimal point as on GMC), the rate if the insurer states one (kept as stated and used in no
   calculation), the terms offered (criterion 7.3), up to 10 files holding the insurer's mail or PDF, a version
   number and a status of Draft or Recorded.
2. WHEN the API saves a quote that has a base premium, THE API SHALL work out GST as base premium × the case's GST
   rate / 100, rounded ROUND_HALF_UP to 2 decimals, and the total as base premium + GST, with decimal arithmetic on
   the server only, and SHALL store the GST rate used with the quote. For example, a base premium of 1,000.05 at 18%
   gives GST 180.01 and a total of 1,180.06. THE Web_App SHALL display the API's base premium, GST and total and
   SHALL not compute them.
3. THE API SHALL take a quote's terms by product. For GPA: for each cover on the Data Sheet (Requirement 4.4),
   Offered, Not offered or Not stated, with the limit offered as an amount in rupees or as text. For GTLI: the free
   cover limit offered as an amount in rupees or Not stated, and the additional benefits offered as text. Both
   products SHALL take other terms as text of at most 4,000 characters.
4. WHEN the API saves a quote, THE API SHALL compare its terms with the case's Data Sheet, which is locked once the
   RFQ is sent. It SHALL return each gap with the term, what was asked and what is offered, as one of two kinds. A
   Deviation is a cover marked Required that is Not offered, or a GTLI free cover limit offered below the one asked
   for. Missing is a cover marked Required that is Not stated, or a free cover limit asked for with none stated. A
   cover marked Not required, a free cover limit not asked for, and the limits offered on a GPA cover SHALL produce
   neither kind. Cover limits SHALL be shown as given until open question 10 is answered.
5. WHEN a user records a quote for an insurer that already has a Recorded quote, THE API SHALL keep it as that
   insurer's next version (v2, v3, …) with its reason. THE API SHALL keep every earlier version readable and
   unchanged, with its figures, terms, files and reason. THE QCR SHALL use the insurer's highest Recorded version
   (Requirement 8.1).
6. WHEN a user with `proposals.edit` records an insurer's decline with a reason of 1 to 500 characters, THE API SHALL
   set that insurer to Declined and SHALL leave it out of the QCR. A quote recorded for that insurer later SHALL set
   it to Quoted and clear the decline reason, as on GMC.
7. WHILE an insurer has a Draft quote on a case, THE API SHALL refuse a second draft for that insurer (409), SHALL
   let the user edit or delete the draft, and SHALL leave the draft out of the QCR and the deviations shown there.
8. IF a request edits or deletes a Recorded quote, or saves a quote for an insurer that is Not sent or on a case
   that is closed or placed, THEN THE API SHALL refuse it (409) with a message naming the reason, and change
   nothing.
9. IF a request records a quote without a base premium, without at least one file of the insurer's mail or PDF, or,
   for a revision, without a reason of 1 to 500 characters, THEN THE API SHALL refuse it (400), naming each missing
   field, and SHALL leave any existing draft as it was.

### Requirement 8: GPA and GTLI QCR and approval

**User Story:** As a Relationship Manager, I want a QCR of the GPA or GTLI quotes approved before the client sees
it, so that the client gets a checked comparison.

#### Acceptance criteria

1. WHEN a user with `proposals.edit` prepares the QCR, THE API SHALL compare, for each insurer of the case that has
   not declined, that insurer's latest recorded quote version (never a draft), from 1 to 5 insurers. It SHALL show
   each quote's base premium, GST, total and its deviations (Requirement 7.4) beside it. It SHALL mark as lowest
   every quote whose total equals the smallest total to the paisa. IF no insurer has a recorded, non-declined
   quote, THEN THE API SHALL refuse it (409) and create nothing.
2. WHEN a user with `proposals.edit` saves the QCR, THE API SHALL accept an optional recommended insurer, which must
   be one of the insurers compared, and optional remarks of at most 2,000 characters. It SHALL keep each QCR as a
   numbered version (v1, v2, …). WHEN the user submits a draft version, THE API SHALL mark it awaiting approval and
   move the case to Approval (Requirement 3.2).
3. WHEN a user with `proposals.approve` approves or rejects the QCR awaiting approval, THE API SHALL record the
   decision, the user and the time against the exact content shown: the insurers, each quote version and its
   figures, the deviations, the lowest marks, the recommendation and the remarks. A rejection SHALL require a comment
   of 1 to 1,000 characters and SHALL move the case back to QCR (Requirement 3.4). THE API SHALL refuse an edit of an
   approved version (409); a change SHALL be a new version.
4. IF the content of a submitted or approved QCR changes afterwards (a new recorded quote version or a decline for
   an insurer compared, or another insurer's first recorded quote), THEN THE API SHALL void the approval or
   submission, show that version as out of date, and require a new version to be submitted and approved before the
   QCR is mailed. THE out-of-date version SHALL be kept as history.
5. IF the QCR content changed between being shown to the approver and the approval request, THEN THE API SHALL
   refuse the approval (409) with a message to reload, and change nothing.
6. WHEN a user with `proposals.export` downloads the approved QCR, THE API SHALL return it as Excel or A4 PDF in a
   built-in layout, with the letterhead when the template is uploaded, holding the same content as approved, and
   SHALL audit the download as an export.
7. WHEN a user with `proposals.send` mails the approved QCR, THE API SHALL send it To 1 to 10 addresses chosen from
   the company's contacts in the client master that have an email, never Cc or Bcc and never a typed address, with
   the QCR attached as PDF or Excel, logged in the mail log and audited. A repeated send id SHALL mail nobody twice.
8. IF mail is off, the QCR is not the latest approved version, or an address is not one of the company's contacts,
   THEN THE API SHALL refuse the mail (409 `MAIL_DISABLED` when mail is off, 409 when not approved, 400 naming the
   address), send nothing and record nothing as sent.

### Requirement 9: Client decision before payment (decision needed)

**User Story:** As the placement team, I want the client's chosen insurer and agreed premium recorded before any
payment, so that the premium is paid against agreed terms.

This requirement is a default for the user and the client to confirm (open question 1). The requested workflow lists
Approval → Payment and does not name the client's decision.

#### Acceptance criteria

1. WHILE a GPA or GTLI case is in the Approval stage and its latest QCR version is approved, WHEN a user with
   `proposals.edit` records the client's decision, THE API SHALL store it on that QCR version, within the Approval
   stage, as one of: accepted, with the chosen insurer, the decision date, the name of the person who confirmed it
   (1 to 120 characters), an optional note (up to 1,000 characters) and 1 to 10 files of the client's mail or
   document; or rejected, with the decision date, the name of the person who confirmed it and a reason (1 to 1,000
   characters). THIS step SHALL be the default of open question 1.
2. WHEN an acceptance is recorded, THE API SHALL set the agreed premium to the total (base premium plus GST,
   Requirement 7.2) of the chosen insurer's quote version on the approved QCR, as a decimal string with 2 decimals,
   and SHALL store the quote version it came from. A later quote revision SHALL not change the agreed premium.
3. WHILE a GPA or GTLI case's latest QCR version is approved, THE Web_App SHALL show the client decision step on the
   Approval tab, labelled as awaiting the client's confirmation of the workflow (open question 1). THE Web_App SHALL
   show the record action only to users with `proposals.edit`, and the recorded decision, agreed premium and files
   to users with `proposals.view`.
4. WHEN an acceptance is recorded, THE API SHALL move the case from Approval to Payment in the same transaction. THE
   API SHALL not offer GMC's Final QCR stage, or any other step between the client's decision and Payment, on GPA or
   GTLI cases.
5. IF the QCR version is not approved or not the latest, the case is not in the Approval or Payment stage, or the
   QCR changed after the user loaded it, THEN THE API SHALL refuse the decision (409) with a message naming what is
   missing, and change nothing.
6. IF the chosen insurer has no recorded quote on the approved QCR (for example a declined insurer), the decision
   date is after today in IST, a file is not a client decision file of this case, or a required field is blank,
   THEN THE API SHALL refuse the decision (400) naming each field, and change nothing.
7. WHEN a rejection is recorded, THE API SHALL move the case back to QCR (Requirement 3.4), keep the rejected QCR
   version and its decision unchanged, and require a new QCR version and its approval before another decision.
8. WHILE no payment on the case is RECEIVED, WHEN a user with `proposals.edit` records a new decision on the same
   approved QCR version, THE API SHALL replace the previous decision, set the agreed premium again under criterion
   9.2, and audit the decision, insurer, agreed premium, decision date and files before and after (Requirement 10.3
   refuses the change once a payment is RECEIVED).

### Requirement 10: GPA and GTLI payment

**User Story:** As the placement team, I want to record the premium payments for a GPA or GTLI case, so that the
placement slip is issued only when the premium is covered.

#### Acceptance criteria

1. WHEN a user with `proposals.edit` records or changes a payment on a GPA or GTLI case, THE API SHALL save its
   amount, payment date, mode, reference (1 to 100 characters), status, optional payer (at most 200 characters),
   optional note (at most 1,000 characters) and 0 to 10 proof files, and SHALL return the amount with exactly 2
   decimals. THE statuses SHALL be Pending, Received and Failed / bounced, and THE modes SHALL be Cheque, NEFT, RTGS,
   IMPS, UPI, DD and Other, as GMC uses them (GHI-08, awaiting the client's confirmation). THE API SHALL audit each
   record and change in the same transaction, with the amount, date, mode, reference, status, payer and note in
   `before` and `after` (null `before` for a new payment).
2. WHEN a payment is recorded or changed and the sum of the case's Received payments is equal to or greater than the
   agreed total premium (Requirement 9.2), THE API SHALL move the case to Placement Slip in the same transaction, as
   GHI-04 does on GMC (awaiting the client's confirmation). Pending and Failed / bounced payments SHALL not count
   towards the sum. THE payments list SHALL return the agreed total premium, the amounts received and pending, the
   amount outstanding, and whether the premium is covered, all worked out by the API.
3. WHILE at least one payment of the case has the status Received, THE API SHALL refuse a change or withdrawal of
   the client's decision (409) and SHALL keep the decision and the payments unchanged.
4. IF a payment's amount is not a positive decimal string of 0.01 to 9,999,999,999,999.99 with at most 2 decimals,
   its reference is blank or longer than 100 characters, or its status is Received or Failed / bounced and its
   payment date is after today in IST, THEN THE API SHALL refuse the save (400) naming the field, and SHALL save
   nothing.
5. IF a proof file is not a PDF, a mail (.eml or .msg), a PNG or a JPEG by its content, is larger than 10 MB, or is
   not a payment proof file of the same case, THEN THE API SHALL refuse it (400) naming the file field, and SHALL
   save neither the file nor the payment.
6. IF a payment is recorded or changed before the client's decision names a chosen insurer (Requirement 9.1, open
   question 1), or on a case that is Closed or placed (Requirement 11.2), THEN THE API SHALL refuse it (409) with a
   message naming the reason, and SHALL change nothing.

### Requirement 11: GPA and GTLI placement slip

**User Story:** As the placement team, I want to issue the placement slip, so that the GPA or GTLI cover is placed
with its census and family rules frozen.

#### Acceptance criteria

1. WHILE a GPA or GTLI case is at the Placement Slip stage or placed, WHEN a user with `proposals.export` downloads
   the placement slip, THE API SHALL return it as an Excel workbook or an A4 PDF, as the user chooses, in a built-in
   layout (open question 15). The slip SHALL show the company, the product, the policy period, the chosen insurer,
   the agreed quote version with its base premium, GST and total, the RECEIVED payments, the plan version and its
   slots, the census counts per relationship, the total sum insured and the census rows as an annexure. Once the
   case is placed, the slip SHALL be built from the policy snapshot and SHALL show the policy number and dates when
   they are stored.
2. WHEN a user with `proposals.edit` issues the placement slip of a GPA or GTLI case at the Placement Slip stage,
   THE API SHALL, in one transaction, mark the case placed and store a policy snapshot. The snapshot SHALL hold the
   chosen insurer, the agreed quote version and total, the plan version and a copy of its slots, the census members
   at the current census revision, the census counts per relationship, the total sum insured, the census revision,
   and who issued it and when. THE API SHALL audit the issue with a null `before` and the snapshot's fields in
   `after`. Issuing the slip SHALL be the step that places the case, with no Final QCR or policy step, as the
   default awaiting client confirmation (open question 1).
3. WHEN a user issues the placement slip, THE API SHALL accept an optional policy number of at most 50 characters
   (a technical bound, not a client rule) and optional policy start and end dates. THE API SHALL place the case
   without them, and THE Web_App SHALL mark these fields as awaiting client confirmation (open question 2).
4. WHILE a GPA or GTLI case is placed, THE API SHALL refuse (409) every change to its census, plan assignment,
   client decision, payments and policy snapshot, and a second issue of the placement slip, and SHALL change
   nothing.
5. IF the client's decision is not recorded (Requirement 9) or the RECEIVED payments do not cover the agreed total
   premium (Requirement 10), THEN THE API SHALL refuse both the download and the issue of the placement slip (409)
   with a message naming each missing step. THE API SHALL leave the case unplaced and store no snapshot.
6. WHEN a placement slip is downloaded, THE API SHALL audit the download as an export (Requirement 25.4), recording
   the format, the insurer and the agreed quote version.
7. IF the policy number is longer than 50 characters, a policy date is not a valid date, or the policy end date is
   before the policy start date, THEN THE API SHALL refuse the issue (400) naming the field. THE API SHALL leave the
   case unplaced and store no snapshot.

### Requirement 12: Family Plan Master

**User Story:** As an Admin, I want family plans kept as configurable data per product, so that the client's
definitions can change without a developer.

#### Acceptance criteria

1. THE Family_Plan_Master SHALL keep plans per product (GMC, GPA or GTLI). Each plan SHALL have a code of 1 to 20
   characters (letters, digits, + and -), a name of 1 to 80 characters, the product, an active flag and its
   versions. THE API SHALL refuse a plan whose code another plan of the same product already uses (409), naming that
   plan, and SHALL never change a plan's code or product after creation.
2. EACH plan version SHALL have a number (1, 2, 3 and so on within its plan, in order of creation, never reused), an
   effective-from date, an optional effective-to date on or after the effective-from date, a status (Draft or
   Active), a "client confirmed" flag (Yes or No, No when the version is created), and its slots. THE dates SHALL be
   calendar dates in IST.
3. EACH slot SHALL have a name, one or more relationships (from the census relationships), a minimum and a maximum
   count of members, and a maximum per relationship, within the bounds of Requirement 13. A slot with a minimum of 1
   or more SHALL be required: a family with fewer members in it than the minimum breaks the plan.
4. THE Web_App SHALL let users with `masters.view` list plans filtered by product, with each plan's code, name,
   product, active flag and the version in effect today, and open a plan to see every version's number, slots,
   limits, dates, status and "client confirmed" flag.
5. THE Web_App SHALL show the actions to create a plan, create and edit a Draft version, activate a version, set an
   Active version's effective-to date, confirm a version, and activate or deactivate a plan only to users with
   `masters.manage`.
6. WHEN a user with `masters.manage` activates a Draft version that meets Requirement 13, THE API SHALL set it to
   Active and SHALL from then on refuse any change to its slots, limits or effective-from date (409), changing
   nothing. A later change SHALL be a new Draft version with the next number. THE API SHALL refuse to activate a
   version that is already Active (409).
7. IF activating a version, or setting an Active version's effective-to date, would make its dates overlap another
   Active version of the same plan, THEN THE API SHALL refuse it (409), naming the other version, and change
   nothing. Two versions overlap when their date ranges share at least one day; a blank effective-to date has no
   end.
8. WHEN a user with `masters.manage` deactivates a plan, THE API SHALL refuse new assignments of it (Requirement
   15.6) and SHALL keep existing assignments and policy snapshots unchanged. Before the Admin confirms, THE Web_App
   SHALL list every open case (not placed and not closed) that uses the plan.
9. THE API SHALL audit each plan create and edit, each version create and Draft edit, each activation, each
   effective-to date set, each "client confirmed" change, and each plan activation and deactivation, in the same
   transaction as the change, with the same fields in `before` and `after` (null `before` for a create).
10. THE API SHALL offer no way to delete a plan or a plan version, whether Draft or Active.
11. WHILE a version is Active, THE API SHALL accept only two changes: setting its blank effective-to date once, on
    or after its effective-from date and without overlap (criterion 12.7); and setting "client confirmed" from No
    to Yes. IF a request sets an effective-to date that is already set, or sets "client confirmed" from Yes to No,
    THEN THE API SHALL refuse it (409) and change nothing. Existing plan assignments SHALL keep their copied slots
    (Requirement 15.4).
12. IF a plan or version field is invalid (a code or name outside its length or characters, a missing
    effective-from date, an effective-to date before the effective-from date, or a slot that breaks Requirement 13),
    THEN THE API SHALL refuse the request (400) with each field and a message, and save nothing.
13. IF a user without `masters.view` reads a plan, or a user without `masters.manage` creates, edits, activates,
    deactivates or confirms a plan or a version, THEN THE API SHALL refuse it (403) and change nothing.

### Requirement 13: Family plan configuration rules

**User Story:** As an Admin, I want an invalid plan refused, so that no case is checked against impossible rules.

#### Acceptance criteria

1. WHEN a user with `masters.manage` creates a Draft plan version, edits a Draft plan version or activates a plan
   version, THE API SHALL check the whole version against criteria 13.2 to 13.7 before storing anything.
2. IF a plan version has fewer than 1 or more than 7 slots, or a slot has no name, a name longer than 50 characters,
   the same name as another slot of the version (ignoring case), no relationship, or a relationship that is not one
   of the census relationships, THEN THE API SHALL refuse it (400) naming the slot and the field. The limits of 7
   slots and 50 characters are technical bounds, not client rules.
3. IF a plan version does not have exactly one slot that accepts Self, or that slot accepts any other relationship,
   or that slot's minimum or maximum is not 1, THEN THE API SHALL refuse it (400) naming the Self slot, or the slots
   field when no slot accepts Self.
4. IF a relationship appears in more than one slot of a version, THEN THE API SHALL refuse it (400) naming the
   relationship and both slots.
5. IF a slot's minimum is not a whole number from 0 to 10, its maximum is not a whole number from 1 to 10, or its
   minimum is above its maximum, THEN THE API SHALL refuse it (400) naming the slot and the field. The bound of 10 is
   a technical bound, not a client rule.
6. IF a relationship in a slot has no maximum, a maximum that is not a whole number from 1 to its slot's maximum, or
   the slot's minimum is above the sum of its relationships' maximums, or the maximum of Self, Spouse, Father,
   Mother, Father-in-law or Mother-in-law is above 1, THEN THE API SHALL refuse it (400) naming the slot and the
   relationship. The Spouse maximum of 1 is a default awaiting the client's confirmation (open question 8).
7. IF a plan version does not state, as Yes or No, whether parents (Father, Mother) and parents-in-law
   (Father-in-law, Mother-in-law) may be mixed in one family, THEN THE API SHALL refuse it (400) naming that field.
   THE API SHALL not assume a value for it.
8. IF a case's plan version forbids mixing and a family holds at least one Father or Mother and at least one
   Father-in-law or Mother-in-law, THEN THE Census_Validator SHALL report as invalid the row, in row order, that
   brings in the second group, naming the employee ID, the member, the relationship and the plan's rule, as in
   Requirement 18.7.
9. IF any check of criteria 13.2 to 13.7 fails, THEN THE API SHALL return every failing field in one response (400),
   each with the slot's position and name, the relationship where one is involved, and a message saying what to
   change. THE API SHALL store nothing and write no audit entry: a Draft keeps its last saved values, and a version
   being activated stays Draft.
10. THE plan version contract SHALL be one Zod schema in `src/shared` that holds the rules of criteria 13.2 to 13.7
    and is used by both the API and the Web_App form. WHILE a user edits a Draft plan version, THE Web_App SHALL
    show each error that schema reports on the field it names before the user saves, SHALL not send the version
    while any error is shown, and SHALL show the API's message on the field it names when the API refuses a save.

### Requirement 14: Default family plans

**User Story:** As an Admin, I want the requested plans present from the start, so that cases can use them while
the client confirms the details.

#### Acceptance criteria

1. WHEN the API starts, THE API SHALL create each default plan of criterion 14.2 that the Family_Plan_Master does not
   hold under that product and plan code, active or not. Each created plan SHALL have one Active version 1, effective
   from 01/01/2000 (a technical date so that every policy start falls in it, not a client rule), with no
   effective-to date, "client confirmed" off, and the slots of criterion 14.2. THE API SHALL hold at most one plan per
   product and code, also when two API instances start at the same time.
2. THE default plans SHALL be as below, each awaiting the client's confirmation under the open questions listed.
   "(1)" means a slot of exactly one member. Where a plan has no parent slot, its mixing setting SHALL have no
   effect on any family. GTLI Self only SHALL be the only GTLI default plan, so a GTLI family with any dependant is
   refused until an Admin adds a plan (open question 6).

   | Product | Plan      | Slots                                                                                                                               | Parents and in-laws mixed | Open questions |
   | ------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | -------------- |
   | GMC     | Self only | Self (1)                                                                                                                            | No parent slot            | 16             |
   | GMC     | 1+3       | Self (1); Spouse (0 to 1); Children: Child (0 to 3)                                                                                 | No parent slot            | 3, 8, 16       |
   | GMC     | 1+5       | Self (1); Spouse (0 to 1); Children: Child (0 to 3); Parents: Father, Mother, Father-in-law, Mother-in-law (0 to 2, each at most 1) | Allowed                   | 3, 4, 8, 16    |
   | GMC     | 1+7       | Self (1); Spouse (0 to 1); Children: Child (0 to 3); Parents: Father, Mother, Father-in-law, Mother-in-law (0 to 4, each at most 1) | Allowed                   | 3, 4, 8, 16    |
   | GPA     | Self only | Self (1)                                                                                                                            | No parent slot            | 16             |
   | GPA     | 1+3       | Self (1); Spouse (0 to 1); Children: Child (0 to 3)                                                                                 | No parent slot            | 3, 8, 16       |
   | GTLI    | Self only | Self (1)                                                                                                                            | No parent slot            | 6, 16          |

3. THE GMC 1+3 and GPA 1+3 plans SHALL accept up to three children (Child, 0 to 3), as requested, and are pending
   the client's answer on two or three children (open question 3). THE API SHALL keep them as two separate plans: a
   new version, an activation or a deactivation of one SHALL leave the other plan's versions, and the cases assigned
   to it, unchanged.
4. THE GMC 1+5 plan SHALL accept any two of Father, Mother, Father-in-law and Mother-in-law, each at most once, with
   parents and parents-in-law mixed (for example Father and Mother-in-law), pending the client's confirmation (open
   question 4). THE Census_Validator SHALL refuse a 1+5 family with three or more parent members, or with one parent
   relationship twice.
5. THE GMC 1+7 plan SHALL accept 0 to 4 of the four parent relationships, each at most once, with mixing allowed,
   so that a family holding Father, Mother, Father-in-law and Mother-in-law passes, pending the client's
   confirmation (open question 4).
6. WHILE a plan version's "client confirmed" flag is off, THE Web_App SHALL show "Awaiting client confirmation" with
   its open question numbers on the plan in the Family Plan Master list and plan page, on each case that uses it,
   and next to the census template download for it.
7. IF a plan with a default plan's product and code already exists in the Family_Plan_Master, THEN THE API SHALL
   leave it unchanged at startup, whatever an Admin has changed: no new version, and no change to its name, versions,
   slots, flags or active flag. A deactivated default plan SHALL stay deactivated.
8. WHEN the API creates a default plan at startup, THE API SHALL write one audit entry for it in the same
   transaction, recorded as made by the system with no user, with a null `before` and the plan's code, name,
   product, active flag and version 1 fields in `after`. A start that creates no plan SHALL write no audit entry.
9. WHILE the plan version of a census template has "client confirmed" off, THE Template_Builder SHALL state on the
   template's Instructions sheet that the plan is awaiting the client's confirmation, with its open question numbers.

### Requirement 15: Assigning a plan

**User Story:** As a Relationship Manager, I want to assign a plan to the company and the case, so that the census
is checked against the right family rules.

#### Acceptance criteria

1. WHEN a user with `clients.manage` sets or clears a company's default plan for a product, THE API SHALL keep at
   most one default plan per company and product, SHALL accept only an active plan of that product, and SHALL
   leave the plans already assigned to that company's cases unchanged.
2. WHEN an EB case is created and its company has an active default plan for the case's product, THE API SHALL
   assign that plan in the version that is Active on the case's plan date: the policy start date when one is given,
   else the case's creation date.
3. WHEN a user with `proposals.edit` assigns or changes the plan of an unlocked case, THE API SHALL accept an active
   plan of the case's product, including one awaiting client confirmation (open question 16), and SHALL use its
   version that is Active on the case's plan date.
4. WHEN a plan is assigned, THE API SHALL store the plan version and a copy of its slots on the case. A later
   version of the plan, a deactivation of the plan, a change of the company's default or a change of the case's
   policy start date SHALL not change the case's assignment until a user assigns a plan again.
5. IF the plan of a case that has members would change and any family breaks the new plan, THEN THE API SHALL
   refuse the change (409), listing each family by employee ID with each rule it breaks, and SHALL keep the
   current assignment.
6. IF the plan chosen is of another product than the case, is inactive, or has no version Active on the case's
   plan date, THEN THE API SHALL refuse it (400) with a message naming the reason, and SHALL keep the current
   assignment.
7. WHEN a plan is assigned automatically at creation, assigned by a user, changed, or set or cleared as a company
   default, THE API SHALL write an audit entry in the same transaction with the plan code and version number before
   and after (null before for a first assignment).
8. IF a new EB case's company has no default plan for the product, or its default is inactive or has no version
   Active on the plan date, THEN THE API SHALL create the case with no plan assigned, except as Requirement 5.2
   provides for GTLI, and THE Web_App SHALL show on the case that a plan is needed before the RFQ.
9. WHILE an EB case is locked or placed, THE API SHALL refuse every assignment or change of its plan (409) and
   SHALL keep the stored plan version and slots unchanged.

### Requirement 16: GMC compatibility

**User Story:** As a GMC user, I want existing GHI cases, census, claims and APIs to work as before, so that nothing
already placed changes.

#### Acceptance criteria

1. THE API SHALL keep every existing GHI case, member, census import, RFQ version, quote, QCR, payment, placement
   slip, policy, claim and claim link readable and usable through the routes that serve it today. THE API SHALL not
   delete an existing document, change its `_id` or change the value of a stored field. The only change allowed is
   adding a new field, such as the employee identity reference of Requirement 17.2.
2. THE API SHALL read a stored GHI case that has no product field as a GMC case (Requirement 1.7). THE API SHALL
   not need a migration that writes a product to existing cases before they can be listed, opened, edited or
   placed.
3. WHILE a GMC case has no plan assigned, THE Census_Validator SHALL apply the Data Sheet's `familyDefinition` with
   the results `census-rules.ts` gives today. Every row accepted today SHALL be accepted. Every row refused today
   SHALL be refused, with the same field and the same reason. This includes the current rule that a family cannot
   mix parents and parents-in-law.
4. WHERE a GMC case has a plan assigned, THE Census_Validator SHALL check families against the plan assignment's
   slots and SHALL not use the Data Sheet's `familyDefinition` for family checks. THE Web_App SHALL show the family
   definition as taken from the plan, with the plan's name and version number.
5. WHEN a new GMC case is created, THE API SHALL apply Requirement 15.2. If the company has no active default GMC
   plan, THE API SHALL create the case with no plan assigned. Whether a plan becomes required on new GMC cases
   SHALL follow open question 5. [Default: optional. THE API SHALL create, lock, send and place a GMC case that has
   no plan.]
6. THE API SHALL keep every existing `/api/v1/ghi` route's path, method, permission, request fields and response
   fields, with the same names, types and meanings. A new request field SHALL be optional. A new response field
   SHALL be added beside the existing fields and SHALL not replace or rename one.
7. IF a request to an existing `/api/v1/ghi` route carries none of the new fields, THEN THE API SHALL accept or
   refuse it exactly as it does today, and give the same response fields and error codes.
8. WHEN a GMC case is created, THE API SHALL give it the next reference in the existing `GHI-<year>-<4-digit
sequence>` series, using the year in IST. THE API SHALL never change an existing case's reference. GPA and GTLI
   references SHALL not use that series.
9. THE claims module SHALL keep finding the employee and family of a placed GMC policy by the same member ids and
   employee key as today. This applies to new claims, claim links and the employee's submission page. Existing
   claims and claim links SHALL keep their stored member ids, and those ids SHALL still point to the same members.

### Requirement 17: Shared employee identity

**User Story:** As the placement team, I want one record per company employee across GMC, GPA and GTLI, so that an
employee is not entered three times and the products do not disagree.

#### Acceptance criteria

1. THE API SHALL keep at most one employee identity per company and employee key, enforced by a unique index on the
   company and the employee key. THE same employee key under two companies SHALL be two separate identities.
2. THE API SHALL store on every Self member of an EB case a reference to the employee identity of that case's
   company and employee key, and SHALL never link a member to an identity of another company.
3. WHEN a Self member is added by import or by hand and no identity exists for the company and employee key, THE API
   SHALL create the identity from the row's employee ID, name, gender, date of birth and date of joining in the same
   transaction as the member, so that both are saved or neither is.
4. WHEN a Self member is added and an identity exists for the company and employee key, including one created by a
   concurrent request, THE API SHALL link the member to it, SHALL not create a second identity, and SHALL count it as
   reused in the import result (Requirement 22.4).
5. IF a Self row's name, gender or date of birth differs from the identity's, THEN THE Census_Validator SHALL report
   the row as invalid, naming for each differing field the employee ID, the field, the identity's value and the row's
   value, and recommending to correct the row or update the employee (criterion 17.6). Names SHALL be compared
   ignoring letter case and repeated spaces, as GHI does today; dates of birth SHALL be compared as calendar dates;
   the date of joining SHALL not be compared. THE API SHALL change neither the identity nor the row.
6. WHEN a user with `proposals.edit` updates an employee identity's name, gender or date of birth, or resolves an
   unresolved employee (criterion 17.11) by choosing those values, with a reason of 1 to 500 characters, THE API
   SHALL save the values on the identity (for an unresolved employee: create it and link the listed Self members),
   apply them to that employee's Self members on unlocked cases of the same company, and leave members on locked and
   placed cases and every policy snapshot unchanged. THE API SHALL not change the employee key, and SHALL audit the
   change with the identity's values before and after, the reason and the cases changed.
7. IF an identity update or resolution would make a member on an unlocked case fail the Census_Validator (for
   example a date of birth outside that case's age limits), THEN THE API SHALL refuse the whole change (409), listing
   each case reference and issue, and SHALL change no identity and no member.
8. THE API SHALL enrol dependants per case under their employee's key, and SHALL store each product's coverage (sum
   insured, salary and plan) on the member of that case only, never on the employee identity.
9. WHEN an import or member edit is saved on one case, THE API SHALL not change an existing employee identity, nor
   another case's members, plan assignment or policy snapshot.
10. WHEN the API starts, THE API SHALL link each existing GHI Self member without an identity reference whose name,
    gender and date of birth agree, compared as in criterion 17.5, with every other Self member of the same company
    and employee key and with that key's identity when one exists. THE API SHALL create or reuse the identity and add
    only the reference, changing no other field of the member. Running the link again SHALL create no identity and
    link no member twice.
11. IF the Self members of one company and employee key disagree on name, gender or date of birth, or disagree with
    that key's identity, THEN THE API SHALL link none of them, SHALL list the employee as unresolved with each case
    reference and its values, and SHALL leave the members unchanged and usable, including by claims (Requirement
    16.9).
12. WHILE an employee of a company is unresolved, THE API SHALL refuse a new Self member with that employee key on
    any EB case of that company: THE Import_Service SHALL report such a row as invalid and THE API SHALL refuse a
    manual add (409), each naming the unresolved employee and the cases to resolve.
13. WHEN a user holding `clients.view` and `proposals.view` opens a company page, THE Web_App SHALL list the
    company's employees, at most 50 per page and searchable by employee ID or name, each with the products and case
    references it is enrolled on. Unresolved employees SHALL come first with an "Unresolved" label, and only users
    with `proposals.edit` SHALL see the resolve and update actions.

### Requirement 18: Family validation

**User Story:** As a user loading a census, I want every family checked against the case's plan, so that the
insurers receive a census that matches the cover.

#### Acceptance criteria

1. WHERE an EB case has a plan assignment, THE Census_Validator SHALL check each family (the members sharing one
   employee key) against the slots copied on the case's plan assignment. It SHALL require exactly one Self. It SHALL
   refuse a relationship that no slot accepts, a member beyond its slot's maximum, a member beyond its relationship's
   maximum, and, when the plan version forbids mixing, a parent in a family that holds a parent-in-law or the other
   way round. WHILE a GMC case has no plan assigned, Requirement 16.3 SHALL apply instead.
2. WHEN the Census_Validator checks a family, THE Census_Validator SHALL let members already in the census keep their
   places, take new rows in row order, keep the first member that reaches a limit and refuse each later one.
3. THE Census_Validator SHALL check each member against the case's Data Sheet. Age SHALL be in completed years on the
   age reference date and within the minimum and maximum of its relationship group (employee, spouse, child, parent);
   a blank limit means no limit. The sum insured SHALL follow the case's sum insured basis and dependant setting
   (Requirement 4.2 and 4.5; on GMC, the coverage type and sums insured as checked today). Every column marked
   required on the product's template (Requirement 19.4) SHALL be filled.
4. IF a dependant's employee key has no valid Self member in the census or earlier in the same file, THEN THE
   Census_Validator SHALL refuse the dependant, naming the employee ID. IF that Self row exists with errors, THEN THE
   Census_Validator SHALL name the Self row and ask for it to be fixed first.
5. IF a member has the same employee key, relationship, name (compared with case and repeated spaces ignored) and
   date of birth as a member already in the census or an earlier row of the same file, THEN THE Census_Validator
   SHALL refuse the later one as a duplicate, naming where the first one is.
6. THE Census_Validator SHALL apply the gender checks GMC applies today (a father or father-in-law cannot be Female,
   a mother or mother-in-law cannot be Male) to the census of every product.
7. EVERY issue SHALL name the row number (for an import or a preview correction), the employee ID, the member's
   name, the relationship and the field. A limit issue SHALL also name the plan, its version and the limit that was
   broken. Every issue SHALL say what to change. For example: "Row 14, employee E1023, Priya Nair (Child): employee
   E1023 already has 3 children; the plan GPA 1+3 v1 allows at most 3. Remove the row or change the plan."
8. WHERE an EB case is GPA or GTLI, THE Census_Validator SHALL use only the case's plan assignment and Data Sheet.
   It SHALL never apply a GMC Data Sheet family definition or the GMC limit of children.
9. WHEN the API checks a case's whole census (after an import, after a plan change, and when an RFQ version is
   generated), THE Census_Validator SHALL report each family with fewer members in a slot than that slot's minimum,
   naming the employee ID, the slot, the count and the minimum. Such a family SHALL not cause a single row's write to
   be refused. THE API SHALL refuse to generate an RFQ version while any family is reported, and SHALL list those
   families.
10. IF a GPA or GTLI case has no plan assigned, THEN THE API SHALL refuse every census upload, import and manual
    member change on it, with a message that a plan must be assigned first, and SHALL save nothing.
11. THE Census_Validator SHALL be a pure module in `src/shared` or the API with unit tests. WHEN the API receives any
    census write (import, preview correction, manual add, edit or remove), THE API SHALL run the Census_Validator
    against the case's plan, Data Sheet and census as stored at that moment, whatever the Web_App sent. IF any issue
    is found, THEN THE API SHALL refuse the write, return each issue and leave the census unchanged.

### Requirement 19: Product census templates

**User Story:** As a user preparing a census, I want the right template for the product and plan, so that HR fills
only the fields that apply.

#### Acceptance criteria

1. THE Template_Builder SHALL build seven templates for the default plans of Requirement 14, each with exactly these
   Census sheet columns in this order:

   | Template      | Plan           | Columns                                                                                               | Relationship values                                               |
   | ------------- | -------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
   | GMC Self      | GMC Self only  | Employee ID, Name, Gender, Date of Birth, Date of Joining, Sum Insured                                | none (every row is Self)                                          |
   | GMC 1+3       | GMC 1+3        | Employee ID, Name, Gender, Date of Birth, Relationship, Date of Joining, Sum Insured                  | Self, Spouse, Child                                               |
   | GMC 1+5       | GMC 1+5        | Employee ID, Name, Gender, Date of Birth, Relationship, Date of Joining, Sum Insured                  | Self, Spouse, Child, Father, Mother, Father-in-law, Mother-in-law |
   | GMC 1+7       | GMC 1+7        | Employee ID, Name, Gender, Date of Birth, Relationship, Date of Joining, Sum Insured                  | Self, Spouse, Child, Father, Mother, Father-in-law, Mother-in-law |
   | GPA Self Only | GPA Self only  | Employee ID, Name, Gender, Date of Birth, Date of Joining, Sum Insured or Annual Salary (19.2)        | none (every row is Self)                                          |
   | GPA 1+3       | GPA 1+3        | Employee ID, Name, Gender, Date of Birth, Relationship, Date of Joining, Sum Insured or Annual Salary | Self, Spouse, Child                                               |
   | GTLI          | GTLI Self only | Employee ID, Name, Gender, Date of Birth, Date of Joining, Sum Insured or Annual Salary (19.2)        | none (every row is Self)                                          |

   WHERE a template is built for any other plan version, THE Template_Builder SHALL take the Relationship values from
   that version's slots, and SHALL leave out the Relationship column when the slots accept only Self.

2. WHEN a user downloads a GPA or GTLI template, THE Template_Builder SHALL include only Annual Salary when the case's
   sum insured basis is Multiple of salary, only Sum Insured when it is Flat or Graded, and both columns, each marked
   not required, when no case is chosen or the case's basis is not yet chosen.
3. WHEN a user with `proposals.view` downloads a template, THE Web_App SHALL ask for the product and an active plan of
   that product, and optionally a case of that product. WHEN no case is chosen, THE Template_Builder SHALL use the
   plan's Active version in effect on the download date in IST. WHEN a case is chosen, THE Template_Builder SHALL use
   the plan version and slots stored with the case's plan assignment and the sum insured basis on its Data Sheet.
4. THE Template_Builder SHALL give each template two visible sheets, "Instructions" first and "Census" second, and
   THE Instructions sheet SHALL list: every column with Required Yes or No and what to enter; the gender values Male,
   Female and Other; the template's Relationship values, or that every row is the employee (Self) when it has none;
   the date format DD/MM/YYYY; the plan's code, name and version number; each slot with its relationships, minimum,
   maximum and maximum per relationship; whether parents and parents-in-law may be mixed; "Awaiting client
   confirmation" when the plan version is not client confirmed; and the limit of 10,000 rows per file.
5. THE Template_Builder SHALL put on the first row of the Instructions sheet of each of the seven templates a notice
   that it is a provisional Fiducial template and not the client's confirmed format, and SHALL put the word
   "Provisional", the template name and the plan version number in the file name. THE Web_App SHALL show the same
   provisional notice next to the download action.
6. THE Census sheet SHALL have its headers in row 1, frozen, with " *" after each required header; SHALL format
   Date of Birth and Date of Joining as DD/MM/YYYY dates, Employee ID as text, and Sum Insured and Annual Salary as
   whole rupees; and SHALL offer drop-downs on rows 2 to 10,001 for Gender (Male, Female, Other) and Relationship
   (only the template's Relationship values). The drop-downs SHALL accept typed values as the GMC template does
   today, so the aliases of Requirement 20.2 still import.
7. THE Template_Builder SHALL store the product, the plan code and the plan version number as hidden metadata that
   is outside both visible sheets, that Excel keeps when the file is filled and saved as .xlsx, and that typing,
   sorting, inserting or deleting rows on the Census sheet does not change. THE Import_Service SHALL read it for
   Requirement 20.4.
8. WHEN a user downloads the GMC template for a GMC case without a plan assigned, THE API SHALL serve the template
   the GHI module builds today, with its columns, Instructions text and drop-downs unchanged and without plan
   metadata.
9. IF a template request names an unknown product, a plan of another product, an inactive plan, a plan with no
   Active version in effect on the download date, a case that does not exist or is of another product, or a GPA or
   GTLI case without a plan assigned, THEN THE API SHALL refuse it with a message naming the problem and SHALL return
   no file.
10. WHEN a template downloaded for a case is filled with rows that pass the Census_Validator and uploaded to the same
    case with the same plan version, THE Import_Service SHALL find every column, read the metadata, report no file
    problem and mark every row valid.

### Requirement 20: Census upload and preview

**User Story:** As a user loading a census, I want to see every row's problems before anything is saved, so that I
can fix them first.

#### Acceptance criteria

1. WHEN a user with `proposals.edit` uploads a census file to an unlocked EB case, THE Import_Service SHALL read it,
   check every row and keep the result as a preview of that case. THE Import_Service SHALL create, change or remove
   no insured member, enrollment or employee identity until the user imports the preview (Requirement 22).
2. THE Import_Service SHALL read the sheet named Census, else the first visible sheet other than Instructions, as GMC
   does today. THE Import_Service SHALL take the headers from row 1, find each column by its header in any order,
   accept the header aliases GMC accepts today, and skip rows whose cells are all blank.
3. IF the file is larger than 10 MB, is not an .xlsx workbook by its content, has no sheet to read, lacks a column
   that the case's template marks required, has no non-blank row below the headers, or has more than 10,000
   non-blank rows, THEN THE Import_Service SHALL refuse the file with a file problem naming the cause (for a missing
   column, its header), and SHALL keep no rows and no preview.
4. IF the product, plan or plan version carried in the file (Requirement 19.7) differs from the case's, THEN THE
   Import_Service SHALL refuse the file with a file problem naming the file's and the case's product, plan and
   version, and SHALL keep no rows and no preview.
5. THE Import_Service SHALL check every row with the Census_Validator against the case's plan slots, its Data Sheet,
   its existing census and the employee identities of its company, and against the file's earlier rows in row
   order, so that of two conflicting rows the earlier is kept and the later one gets the issue.
6. THE Import_Service SHALL accept a date as an Excel date cell, an Excel date serial number, or text in one of the
   forms GMC reads today: DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY, YYYY-MM-DD, DD-Mon-YYYY and D Month YYYY. THE
   Import_Service SHALL read every text date day first, never month first or by the server's locale.
7. IF a row has a date in a form not listed in criterion 20.6, a date with a two-digit year, a date that does not
   exist (for example 31/02/1990), a date of birth or joining after the upload date in IST, a gender or relationship
   outside the accepted values and aliases, an employee ID that is blank, longer than 40 characters or holds
   characters other than letters, digits, / _ . and -, a blank name or one longer than 120 characters, or a sum
   insured or annual salary that is not a positive whole number of rupees, THEN THE Census_Validator SHALL report an
   error on that row naming the field and the accepted form.
8. THE preview SHALL show the counts of rows read, valid rows, rows with errors and rows with warnings, and SHALL
   list every row with each of its issues: the Excel row number, the employee ID, the member's name, the field, the
   value as read, the explanation and the fix. EACH issue SHALL be an error, which keeps the row out of the import,
   or a warning, which does not (for example a sum insured above the free cover limit, Requirement 5.3). Values SHALL
   be returned only under Requirement 24.4.
9. THE Import_Service SHALL never drop an invalid row: it SHALL stay in the preview until corrected, left out by the
   import policy, or the preview is discarded.
10. WHEN a user uploads, corrects a row of, imports or discards a preview, THE Import_Service SHALL write an audit
    entry in the same transaction naming the case, the file name and the counts of valid and invalid rows. THE audit
    entry of a correction SHALL also hold the row number and the row's values before and after.
11. IF the case is locked or placed, THEN THE Import_Service SHALL refuse the upload (409) with a message saying the
    census can no longer change, and SHALL keep no preview.
12. WHEN a file is uploaded to a case that has an open preview (neither imported nor discarded), THE Import_Service
    SHALL mark the earlier preview discarded, audited as a discard, and keep the new one, so that a case has at most
    one open preview, as GMC does today.
13. IF a file carries no product, plan or plan version marker, THEN THE Import_Service SHALL read it under criteria
    20.2 and 20.3, check its rows against the case's own plan, and show a file warning that the file's product and
    plan could not be confirmed.

### Requirement 21: Corrections and the error report

**User Story:** As a user loading a census, I want to fix rows on screen or download the errors, so that HR can
correct the file.

#### Acceptance criteria

1. WHEN a user with `proposals.edit` saves a correction to a preview row of an unlocked case, THE Import_Service SHALL
   check the corrected values with the same rules as an upload (Requirement 20.6 and 20.7), re-validate with the
   Census_Validator the row and every other preview row of its family (same employee key) against the case and its
   existing census, update the preview's valid and invalid counts, and mark the row corrected.
2. WHEN a correction changes a row's employee ID, THE Import_Service SHALL re-validate both the family the row
   leaves and the family it joins.
3. IF a corrected row still has an issue, THEN THE Import_Service SHALL keep the row in the preview with its corrected
   values and its current issues, and SHALL add nothing to the census.
4. IF the case is locked, or the preview has already been imported or discarded, THEN THE API SHALL refuse the
   correction (409) with a message naming the reason, and SHALL change nothing.
5. WHEN a user with `proposals.view` downloads the error report of a preview, THE Template_Builder SHALL build one
   .xlsx workbook with two sheets: a Census sheet holding each row that has at least one issue at that moment, with
   its Excel row number, its values as uploaded and an Errors column listing every current issue of that row; and an
   Issues sheet with one line per issue giving the row number, employee ID, field, value as shown in the preview,
   explanation and fix.
6. IF the preview has no row with an issue, THEN THE API SHALL refuse the error report download (409) with a message
   saying that there are no errors to report, and SHALL build no file.
7. THE Template_Builder SHALL write every cell of the error report, on both sheets, as a text cell, so that a value
   starting with `=`, `+`, `-` or `@` shows exactly as uploaded and is never run as a formula.
8. WHEN the API serves an error report, THE API SHALL send it with `Cache-Control: no-store` and SHALL audit the
   download as an export naming the case, the preview and the number of rows and issues in the file, without the
   rows' values.

### Requirement 22: Safe import and re-import

**User Story:** As a user loading a census, I want an import that never duplicates employees and never damages
another product's data, so that I can import again safely.

#### Acceptance criteria

1. WHEN a user with `proposals.edit` imports a preview, THE Import_Service SHALL apply the import policy the user
   names, with no default: "Import only if every row is valid" (all valid) or "Import the valid rows, leave the rest"
   (valid only). Under valid only, a dependant whose employee's Self row is invalid SHALL be left out with it, as GMC
   does today.
2. WHEN a user imports in "Add new only" mode, or names no mode, THE Import_Service SHALL treat a row as matching a
   member of the case when its employee key, relationship, name and date of birth equal that member's (compared as in
   Requirement 18.5). A matching row whose sum insured, annual salary and date of joining equal the member's SHALL be
   unchanged. A matching row with any of them different SHALL be invalid, with an issue naming the field, the
   member's value and the row's value, and suggesting "Add and update".
3. WHEN a user imports a preview, THE Import_Service SHALL check every row again with the Census_Validator against
   the case's plan, Data Sheet and census as they are at that moment. It SHALL then write the members, the new
   employee identities, the import's result and its audit entry in one transaction: all of them or none. IF the
   transaction fails, THEN THE Import_Service SHALL save nothing and keep the preview, its rows and its corrections
   as they were.
4. WHEN an import completes, THE Import_Service SHALL return the number of rows added, updated, unchanged and skipped
   (left out as invalid). These SHALL add up to the preview's rows. It SHALL also return the employee identities
   created and reused, which SHALL add up to the Self rows added. Each count SHALL equal the records written:
   members created, members changed and identities created. The import's audit entry SHALL carry the same counts.
5. WHEN every row of an import matches a member of the case with the same details, THE Import_Service SHALL create
   no member and no employee identity, change no member, and report every row as unchanged. It SHALL not raise the
   case's census revision, so an approved RFQ stays current.
6. THE Import_Service SHALL write only to the members of the case being imported and to new employee identities of
   its company. It SHALL never change another case's members, another product's coverage, a policy snapshot, or an
   existing employee identity's details.
7. WHEN the valid-only policy leaves rows out, THE Import_Service SHALL list each one in the result with its Excel
   row number, employee ID and issues. It SHALL also keep each one on the import record, marked not imported, with
   its values and issues.
8. WHERE the case is a GMC case, IF the file's rows (not its bytes) are the same as those of an earlier completed
   import into that case, THEN THE Import_Service SHALL refuse the upload (409) and the import (409), naming the
   earlier file, its member count and its date. It SHALL add nothing.
9. WHEN a user imports in "Add and update" mode, THE Import_Service SHALL update the sum insured, annual salary and
   date of joining of each matching member whose values differ, on this case only, once the row passes the
   Census_Validator. A matching row with the same values SHALL be unchanged. THE employee identity SHALL not change.
10. IF the case is locked (Requirement 6.6) or placed, the preview has already been imported or discarded, the
    all-valid policy is chosen and at least one row is invalid, or the valid-only policy is chosen and every row is
    invalid, THEN THE API SHALL refuse the import (409) with a message naming the reason and, for invalid rows,
    their count. It SHALL write nothing and leave the preview unchanged.
11. IF an import request names no policy, or names a policy or mode other than the two defined, THEN THE API SHALL
    refuse it (400) and change nothing.

### Requirement 23: Manual census entry

**User Story:** As a user, I want to add, edit and remove members by hand under the same rules, so that the screen
cannot be used to get round the import's checks.

#### Acceptance criteria

1. WHILE an EB case is unlocked and not placed, THE API SHALL let a user with `proposals.edit` add a member to its
   census, edit a member's fields, and remove a member.
2. WHEN a user adds or edits a member, THE API SHALL check the member and the member's whole family with the
   Census_Validator, applying the same checks as the import: the field checks of Requirement 20.7, the family and
   Data Sheet checks of Requirement 18, the duplicate check of Requirement 18.5 against the case's census, and the
   employee identity check of Requirement 17.5.
3. WHILE a user fills in the member form, THE Web_App SHALL run the same Census_Validator rules and show each issue
   on its field before saving. IF the API refuses a change, THEN THE Web_App SHALL show the API's message on the
   field it names and keep the user's input in the form.
4. IF a user removes a Self member while one or more dependants of that employee remain on the case, THEN THE API
   SHALL refuse the removal (409), name each remaining dependant by name and relationship, and remove nothing.
5. WHEN a manual add, edit or removal succeeds, THE API SHALL raise the case's census revision by one and audit the
   change in the same transaction, with the member's fields before and after (no before for an add, no after for a
   removal).
6. IF the Census_Validator reports any issue on a manual add or edit, THEN THE API SHALL refuse the change (400)
   with each issue naming the employee ID, the member's name, the relationship and the field and saying what to
   change, as in Requirement 18.7 without a row number, and SHALL save nothing, leave the census revision unchanged
   and write no audit entry.
7. IF a user adds, edits or removes a member of a locked or placed EB case, THEN THE API SHALL refuse the request
   (409), change no member, and leave the census revision unchanged.
8. WHEN a manual change succeeds, THE API SHALL change only that member on that case: a Self member added SHALL
   create or reuse the employee identity as in Requirements 17.3 and 17.4, and a removal SHALL leave the employee
   identity, the members of other cases and every policy snapshot unchanged.

### Requirement 24: Permissions and ownership

**User Story:** As an operator, I want every EB action checked on the server, so that no user reaches another
case's or company's data.

#### Acceptance criteria

1. THE API SHALL guard every EB route with `authenticate()` followed by one `requirePermission()` check: view
   `proposals.view`; create `proposals.create`; Data Sheet, plan assignment, census, quotes, QCR drafts, client
   decision, payments and placement `proposals.edit`; approvals `proposals.approve`; mails `proposals.send`;
   downloads `proposals.export` (templates and error reports `proposals.view`); family plans `masters.view` and
   `masters.manage`; company plan defaults `clients.manage`. A route SHALL check a permission and never a role code.
   This spec SHALL add no permission and SHALL change no role's permissions in `src/shared/permissions.ts`, since the
   role table waits for the client's confirmation (Q12).
2. IF a request names a member, import preview, quote, QCR, payment, plan assignment or file that does not belong to
   the EB case and product in its route, or an employee identity that does not belong to the company in its route,
   THEN THE API SHALL answer 404, change nothing, and return none of that record's fields.
3. THE Web_App SHALL show each EB page, nav item and action only to users whose roles hold the permission the API
   checks for it in criterion 24.1, through `PageGate`, `usePermission()` or `can()`, and SHALL never compare role
   codes. A hidden control SHALL not replace the API's check.
4. THE API SHALL write no employee name, date of birth or salary to its application logs. An error response SHALL
   carry these values only in the row issues of the census rows that the same request uploaded, corrected or
   edited. A 400 response for any other reason, and every 401, 403 or 404 response, SHALL carry none of them.
5. WHEN a user uploads a census, THE Import_Service SHALL read the file in memory without writing it to disk, and
   SHALL keep the original only as its rows and its hash, as GMC does today. IF the file is larger than 10 MB, or its
   content is not an .xlsx workbook whatever its name or declared type, THEN THE Import_Service SHALL refuse it with
   a file problem and keep nothing.
6. THE proxy allowlist (`src/lib/server/proxy-paths.ts`) SHALL list each new EB API area, with a test showing that a
   listed EB path is forwarded and a path outside the list is not.
7. NO new dependency SHALL be added to either repository's `package.json` or lockfile.
8. IF a request to an EB route carries no valid session, THEN THE API SHALL answer 401 and change nothing.
9. IF the signed-in user's roles do not hold the route's permission, THEN THE API SHALL answer 403 before reading any
   record, change nothing, and return no case, company or employee data.
10. IF a request's params, query or body holds a field that the route's strict Zod schema does not define, or a value
    outside that schema, THEN THE API SHALL refuse it (400), name the field, and change nothing.

### Requirement 25: Audit and data safety

**User Story:** As an Admin, I want every change of this spec audited and no existing data rewritten, so that the
history is complete and nothing already stored is lost.

#### Acceptance criteria

1. WHEN a user creates, edits, approves, sends or exports a record of this spec (an EB case, Data Sheet, family plan,
   plan version, plan assignment, company plan default, employee identity, insured member, census preview, import,
   RFQ version, quote, QCR, client decision, payment or placement slip), THE API SHALL write one audit entry with
   `writeAudit()` naming the user, the action, the record type and the record id. For an import, THE API SHALL write
   one entry for the import with its counts (Requirement 22.4) and one entry per member created or updated, with
   `writeAudits()`. Each action SHALL be listed in `src/shared/audit.ts` with exactly one kind (CREATE, EDIT,
   APPROVE, SEND or EXPORT) and a label.
2. WHEN an audited create, edit, approval or send is saved, THE API SHALL write its audit entries in the same
   transaction as the change. IF the change or any of its audit entries fails to write, THEN THE API SHALL roll back
   both, return an error, and leave every stored record and the audit log as they were before the request.
3. THE API SHALL snapshot the same fields in an entry's `before` and `after`, with `before` null for a create, so the
   audit log shows each field's old and new value. THE API SHALL never put a password hash, a session or link token,
   a mail credential or the contents of an uploaded file in a snapshot. An uploaded file SHALL appear only as its file
   name, size and hash.
4. WHEN a user downloads a file of this spec (a template, an error report, an RFQ, a QCR or a placement slip), THE API
   SHALL write an EXPORT entry with `before` null and `after` naming the case or plan, the document and its format.
5. WHEN the API starts, THE API SHALL create the new collections and indexes of this spec with `ensureIndexes()`, and
   SHALL not drop, rename or rewrite an existing collection or index, including `audit_logs`. `audit_logs` stays
   append-only: no entry is updated or deleted.
6. THE API SHALL read a document stored before this spec with each field this spec adds treated as optional or
   derived (for example a GHI case without a product reads as GMC). THE API SHALL change such a document only by
   adding a field this spec defines (for example the employee identity reference of Requirement 17.2), never by
   changing or removing a stored field, changing its `_id` or deleting the document.
7. THE API SHALL send and accept every amount of this spec as a decimal string, never as a JSON number, in the form
   its requirement gives: premiums, GST, totals and payments with exactly 2 decimals in responses; sums insured,
   salaries, maximums, free cover limits and weekly benefits as whole rupees. It SHALL store each amount as
   `Decimal128` and compute it with `Decimal` (ROUND_HALF_UP). Rates and multipliers SHALL travel as decimal strings
   and SHALL not be rounded to 2 decimals. IF a request sends an amount as a JSON number or with more decimals than
   its form allows, THEN THE API SHALL refuse it (400) naming the field, and save nothing.

### Requirement 26: Quality and documentation

**User Story:** As a developer, I want the new behaviour tested and documented, so that later changes do not break
GMC, GPA, GTLI or Property.

#### Acceptance criteria

1. WHEN this spec's last task is done, THE API and THE Web_App SHALL each pass `npm run lint` with zero errors and
   zero warnings, `npm run typecheck`, `npm test` and `npm run build`, and THE Web_App SHALL pass
   `npm run shared:check`, showing that its `src/shared` is identical to the API's.
2. THE tests SHALL cover each item below, with at least one accepted case and, where the item names a refusal, one
   refused case that writes nothing:
   - product selection: a GMC, a GPA and a GTLI case are created with their product and a reference naming it; a
     create naming another product is refused; Property create, routes and records answer as before
   - GPA and GTLI stages: each move in the Requirement 3.2 table; each stage's saved data read back after a later
     stage; a move refused before its stage's work is saved; the move back to QCR on a rejection (Requirement 3.4)
   - plan configuration: each refusal in Requirement 13.2 to 13.7; each of the seven default plans of Requirement
     14.2 created once at startup and left unchanged by a second start
   - plan independence: a new version of GMC 1+3 leaves GPA 1+3, the slots stored on every assigned case and every
     policy snapshot unchanged
   - families: one dependant more than a slot or relationship allows; a relationship the plan does not accept;
     parents and parents-in-law in one family under a plan that forbids mixing; a dependant without its Self row;
     exact duplicates within the file and against the census
   - templates: each of the seven templates downloads with an Instructions sheet, a Census sheet, the columns of
     Requirement 19.1 and the provisional marking; a filled copy of each imports with zero invalid rows
   - dates: Excel date cells and DD/MM/YYYY text accepted; 03/04/1990 read as 3 April 1990; 12/31/1990 refused;
     a two-digit year refused; a date that does not exist (for example 31/02/1990) refused; a future date of birth
     or joining refused
   - re-import: the same file imported twice creates zero members the second time and reports every row as
     unchanged; "Add new only" reports identical rows as unchanged and changed rows as invalid; "Add and update"
     changes only sum insured, salary and date of joining, on that case only
   - identity: one employee on a GMC, a GPA and a GTLI case of one company holds exactly one employee identity; the
     same employee ID at two companies holds two; a differing name, gender or date of birth is reported as in
     Requirement 17.5
   - failure and counts: an import whose transaction fails leaves no member, identity or audit entry and the preview
     unchanged; after a successful import, each count of Requirement 22.4 equals the records in the database
   - GMC regression: a GMC case without a plan checks families by its Data Sheet family definition as today; the GMC
     import and its fingerprint guard work as today; claims on a placed GMC policy find the employee and family by
     the same member ids
   - permissions: as in criterion 26.6
3. WHEN this spec's last task is done, THE API's `docs/OPEN_ITEMS.md` SHALL have an Employee Benefits section that
   lists the seven census templates as provisional, each default plan of Requirement 14.2 as awaiting client
   confirmation, and each of the 16 open questions below with its default.
4. WHEN this spec's last task is done, THE README and the product, structure and tech steering files of both
   repositories SHALL describe Employee Benefits (GMC, GPA and GTLI), the Family Plan Master and its default plans,
   the shared employee identity and the seven provisional templates. THE product files SHALL list them as built,
   THE structure files SHALL name each new module and component folder, and THE README permissions tables SHALL name
   the permission of Requirement 24.1 that guards each new route and screen.
5. THE API and THE Web_App SHALL have unit tests next to the code for each pure module of this spec: the plan
   configuration rules, the Census_Validator's family and member checks, census date parsing, the salary-multiple
   sum insured with its cap and rounding, and the quote GST and total. WHERE such a module is in `src/shared`, THE
   Web_App SHALL also test it with fast-check property tests (already its dev dependency, so Requirement 24.7
   holds), each tagged `// Feature: employee-benefits-gpa-gtli, Property N: <name>` after a Correctness Property in
   this spec's design.md, covering at least:
   - any valid day-first date written as DD/MM/YYYY reads back as the same date, and no input is read month first
   - for any base premium from 0.00 to 999,999,999.99 and GST rate from 0.00 to 100.00 percent, the total equals the
     base plus the GST rounded half up to the paisa
   - a family is accepted exactly when every slot and relationship count is within the plan's limits and the mixing
     rule holds
6. THE API SHALL have Supertest integration tests in `test/`, on the in-memory replica set with mail through
   `FakeTransport`, for every new or changed EB route. Each route's tests SHALL cover: one successful call; a
   signed-out request refused; each of the five roles allowed or refused exactly as `src/shared/permissions.ts`
   gives; an invalid input refused with nothing written; an id from another case or company answered as not found;
   and, where the route depends on the stage, the lock or placement, a request in the wrong state refused with
   nothing written.
7. WHEN this spec's last task is done, THE existing GHI, claims and Property tests of both repositories SHALL pass,
   with none deleted or skipped and no expected value changed, except where a requirement of this spec changes that
   behaviour (for example the navigation of Requirement 2.1) and the task that changes it names the test.

## Open questions for the client

These do not block the build. Defaults are in brackets.

1. GPA and GTLI workflow: is the client's decision (chosen insurer, agreed premium) recorded before payment, and is a
   Final QCR or policy record step needed as on GMC? [Client decision within Approval; no Final QCR; the placement
   slip places the case.]
2. Is the policy number and policy copy recorded for GPA and GTLI? [Optional fields on the placement slip.]
3. Does 1+3 mean the employee, spouse and two children, or spouse and three children, for GMC and for GPA? [Three
   children; each product's plan is separate data and can change on its own.]
4. 1+5: which two parent members, and may parents and parents-in-law be mixed? GMC today forbids mixing. [Any two of
   father, mother, father-in-law and mother-in-law, mixing allowed.]
5. Must new GMC cases use the Family Plan Master, and should existing GMC cases move to it? [Optional on new GMC
   cases; existing cases keep their Data Sheet family definition.]
6. Does GTLI cover only employees? [Yes: GTLI Self only is the default plan.]
7. GPA and GTLI sum insured basis: flat, graded or a multiple of salary; and the cap? [The Data Sheet asks each case.]
8. May a plan allow more than one spouse? [No: at most one, as GMC today.]
9. With a multiple of salary, how is the sum insured rounded? [Half up to the rupee.]
10. Which GPA covers are standard (accidental death, PTD, PPD, TTD) and how are they limited, for example PPD as per
    the insurer's table, TTD weekly benefit and weeks? [Required / Not required per cover; limits as text or amounts.]
11. How is a GPA dependant's sum insured set? [The Data Sheet asks: the employee's, the dependant's own, or a %.]
12. GTLI free cover limit and medical underwriting: is the limit enforced, and above what sum insured or age is
    medical evidence needed? [Recorded and flagged in the summary; not enforced.]
13. Age limits per product and relationship for GPA and GTLI; should they belong to the plan instead of the Data
    Sheet? [Per case on the Data Sheet, blank by default.]
14. Does GPA need an occupation or risk class per employee? [Not captured.]
15. The client's GMC, GPA and GTLI census formats, and their RFQ, QCR and placement slip layouts. [Provisional
    Fiducial templates and built-in layouts.]
16. May an unconfirmed plan be assigned to cases and sent in an RFQ? [Yes, shown as awaiting confirmation.]
