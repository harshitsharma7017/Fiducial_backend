import {
  ageGroupOf,
  ageOn,
  checkCensus,
  employeeKeyOf,
  nameKeyOf,
  parseCensusDate,
  parseCensusRupees,
  parseGender,
  parseRelationship,
  readCensusRow,
  type Candidate,
  type CensusMember,
  type CensusSettings,
} from './census-rules.ts';
import {
  EB_CENSUS_FIELD_LABELS,
  ghiFieldOf,
  type EbCensusField,
  type EbCensusIssue,
  type EbCensusRowValues,
  type FamilyShortfall,
  type IssueSeverity,
} from './eb-census.ts';
import { annualFromMonthly } from './eb-money.ts';
import {
  MAX_NOMINEE_AGE,
  NOMINEE_RELATIONSHIP_LABELS,
  nomineeRequiredFor,
  parseNomineeRelationship,
  type Nominee,
  type NomineeRequirement,
} from './eb-nominees.ts';
import type { EbProduct } from './eb-products.ts';
import {
  dependantRuleOf,
  salaryInputOf,
  type DependantBasis,
  type DependantRule,
  type SumInsuredBasis,
} from './eb-requirements.ts';
import { IN_LAW_RELATIONSHIPS, PARENT_RELATIONSHIPS, type PlanSlot } from './family-plans.ts';
import { formatIndianNumber } from './format.ts';
import type { GhiAgeGroup, GhiCoverageType } from './ghi.ts';
import {
  GHI_GENDER_LABELS,
  GHI_RELATIONSHIP_LABELS,
  type GhiCensusIssue,
  type GhiGender,
  type GhiRelationship,
} from './ghi-census.ts';

// The Census_Validator (N2, N3): one pure module for every product, used by the API on every
// census write (import, correction, manual add or edit) and by the web app while typing.
//
// LEGACY mode is a GMC case without a plan: it runs the GMC rules of census-rules.ts unchanged
// (Requirement 16.3). PLAN mode checks families against the slots copied on the case's plan
// assignment (Requirement 18). Every issue names the row, employee, member, relationship and
// field, the value as read, what is wrong and what to change (18.7).

/** The plan rules a case's census is checked against: the copy on its plan assignment. */
export interface PlanRules {
  code: string;
  name: string;
  versionNumber: number;
  slots: readonly PlanSlot[];
  parentsAndInLawsMixed: boolean;
}

export type FamilyRules =
  { mode: 'LEGACY'; settings: CensusSettings } | { mode: 'PLAN'; plan: PlanRules };

/** How sums insured are checked, by product. */
export type MemberRules =
  | { product: 'GMC'; coverageType: GhiCoverageType | null; sumInsuredOptions: readonly string[] }
  | {
      product: 'GPA';
      basis: SumInsuredBasis | null;
      dependantBasis: DependantBasis | null;
      /** Who needs a nominee (N5); missing: nominees are not checked. */
      nominees?: NomineeRequirement;
    }
  | {
      product: 'GTLI';
      basis: SumInsuredBasis | null;
      freeCoverLimit: string | null;
      /** Who needs a nominee (N6); missing: nominees are not checked. */
      nominees?: NomineeRequirement;
    };

/** The details of an employee identity that a Self row must agree with (17.5). */
export interface IdentityDetails {
  employeeId: string;
  name: string;
  nameKey: string;
  gender: GhiGender;
  dateOfBirth: string;
}

export interface EbCensusContext {
  product: EbProduct;
  family: FamilyRules;
  members: MemberRules;
  ageLimits: Record<GhiAgeGroup, { min: number | null; max: number | null }>;
  /** Ages are completed years on this date (YYYY-MM-DD). */
  referenceDate: string;
  /** Today in India (YYYY-MM-DD). */
  today: string;
  /** The company's employee identities by employee key. */
  identities: ReadonlyMap<string, IdentityDetails>;
  /** Employee keys of the company that are unresolved, with the case references to resolve. */
  unresolvedKeys: ReadonlyMap<string, readonly string[]>;
  /** salary × multiplier, half up to the rupee, capped (Decimal in the API, BigInt in the web app). */
  deriveSumInsured(annualSalary: string, multiplier: string, maximum: string | null): string;
  /** sumInsured × percent / 100, half up to the rupee. */
  percentOf(sumInsured: string, percent: string): string;
  /** monthly × 12 (N6); the shared BigInt function when not given. */
  annualOf?(monthlySalary: string): string;
  /** Whether Self rows are checked against the company's identities (design D7). */
  identityChecks: boolean;
}

/** A member as the validator sees it: GMC's member plus the annual salary. */
export interface EbCensusMember extends CensusMember {
  annualSalary: string | null;
  /** Whole rupees a month (N6); missing on members stored before it. */
  monthlySalary?: string | null;
  /** GPA and GTLI (N5, N6): at most one nominee. */
  nominee?: Nominee | null;
}

/** A file row or a typed member being checked. */
export interface EbCandidate {
  key: string;
  /** The Excel row number; null for a member typed on screen. */
  row: number | null;
  /** How other rows refer to it, for example "row 7". */
  label: string;
  member: EbCensusMember | null;
  /** Problems reading the row. */
  issues: EbCensusIssue[];
  /** The values as read (text), for the issues' "value as read". */
  values: EbCensusRowValues | null;
  /** The GMC legacy reader's issues (legacy mode only). */
  legacyIssues?: GhiCensusIssue[];
}

const rupees = (value: string) => `₹${formatIndianNumber(value, 0)}`;
const relationshipLabel = (relationship: GhiRelationship) => GHI_RELATIONSHIP_LABELS[relationship];
const memberWord = (relationship: GhiRelationship) =>
  relationship === 'SELF' ? 'employee' : relationshipLabel(relationship).toLowerCase();

const DEFAULT_FIX: Record<EbCensusField, string> = {
  employeeId: 'Use the employee’s ID: up to 40 letters, digits, / _ . or -.',
  name: 'Enter the member’s full name, up to 120 characters.',
  gender: 'Use Male, Female or Other.',
  dateOfBirth: 'Write the date as DD/MM/YYYY (day first), for example 03/04/1990, not after today.',
  relationship: 'Use one of the relationships the template lists.',
  dateOfJoining: 'Write the date as DD/MM/YYYY (day first), not after today, or leave it blank.',
  sumInsured: 'Enter the sum insured in whole rupees, as the case’s Data Sheet allows.',
  annualSalary: 'Enter the annual salary in whole rupees, for example 600000.',
  monthlySalary: 'Enter the monthly salary in whole rupees, for example 50000.',
  nomineeName: 'Enter the nominee’s full name, up to 120 characters.',
  nomineeRelationship:
    'Use Spouse, Son, Daughter, Father, Mother, Brother, Sister or Other for the nominee.',
  nomineeDateOfBirth:
    'Write the nominee’s date of birth as DD/MM/YYYY (day first), not after today, or give the age.',
  nomineeAge: `Enter the nominee’s age in whole years, 0 to ${MAX_NOMINEE_AGE}, or give the date of birth.`,
};

function valueOf(candidate: Pick<EbCandidate, 'values' | 'member'>, field: EbCensusField | null) {
  if (!field) return null;
  if (candidate.values) return candidate.values[field] || null;
  const member = candidate.member;
  if (!member) return null;
  switch (field) {
    case 'relationship':
      return relationshipLabel(member.relationship);
    case 'gender':
      return GHI_GENDER_LABELS[member.gender];
    case 'nomineeName':
      return member.nominee?.name ?? null;
    case 'nomineeRelationship':
      return member.nominee ? NOMINEE_RELATIONSHIP_LABELS[member.nominee.relationship] : null;
    case 'nomineeDateOfBirth':
      return member.nominee?.dateOfBirth ?? null;
    case 'nomineeAge':
      return member.nominee?.age === null || member.nominee?.age === undefined
        ? null
        : String(member.nominee.age);
    default: {
      const value = member[field];
      return value === null || value === undefined ? null : String(value);
    }
  }
}

function makeIssue(
  candidate: Pick<EbCandidate, 'row' | 'values' | 'member'>,
  field: EbCensusField | null,
  message: string,
  fix: string,
  code: string,
  severity: IssueSeverity = 'ERROR',
): EbCensusIssue {
  const member = candidate.member;
  const values = candidate.values;
  const relationship =
    member?.relationship ??
    (values?.relationship ? parseRelationship(values.relationship) : null) ??
    null;
  return {
    row: candidate.row,
    employeeId: member?.employeeId ?? (values?.employeeId.trim() || null),
    name: member?.name ?? (values?.name.trim().replace(/\s+/g, ' ') || null),
    relationship,
    field,
    value: valueOf(candidate, field),
    message,
    fix,
    severity,
    code,
  };
}

/** The issue as one sentence, for messages and the error report (Requirement 18.7). */
export function issueSentence(issue: EbCensusIssue): string {
  const where = [
    issue.row === null ? null : `Row ${issue.row}`,
    issue.employeeId ? `employee ${issue.employeeId}` : null,
    issue.name
      ? `${issue.name}${issue.relationship ? ` (${GHI_RELATIONSHIP_LABELS[issue.relationship].replace(' (employee)', '')})` : ''}`
      : null,
  ].filter(Boolean);
  return `${where.length > 0 ? `${where.join(', ')}: ` : ''}${issue.message} ${issue.fix}`.trim();
}

/** The field label an issue belongs to. */
export function ebIssueText(issue: EbCensusIssue): string {
  return issue.field ? `${EB_CENSUS_FIELD_LABELS[issue.field]}: ${issue.message}` : issue.message;
}

export const isError = (issue: EbCensusIssue) => issue.severity === 'ERROR';

// Reading a row

/**
 * Reads one row in plan mode: the GMC reader's checks, the annual salary, and dates of birth or
 * joining after today (Requirement 20.7). Without a Relationship column and with a plan that
 * accepts only Self, every row is the employee.
 */
export function readEbCensusRow(
  values: EbCensusRowValues,
  options: { row: number | null; today: string; assumeSelf: boolean },
): { member: EbCensusMember | null; issues: EbCensusIssue[] } {
  const readValues =
    options.assumeSelf && !values.relationship.trim()
      ? { ...values, relationship: 'Self' }
      : values;
  const read = readCensusRow({
    employeeId: readValues.employeeId,
    name: readValues.name,
    gender: readValues.gender,
    dateOfBirth: readValues.dateOfBirth,
    relationship: readValues.relationship,
    dateOfJoining: readValues.dateOfJoining,
    sumInsured: readValues.sumInsured,
  });
  const context = { row: options.row, values: readValues, member: null };
  const issues = read.issues.map((item) =>
    makeIssue(context, item.field, item.message, DEFAULT_FIX[item.field ?? 'employeeId'], 'FIELD'),
  );
  let annualSalary: string | null = null;
  if (values.annualSalary.trim()) {
    const parsed = parseCensusRupees(values.annualSalary);
    if (parsed.ok) annualSalary = parsed.value;
    else {
      issues.push(
        makeIssue(
          context,
          'annualSalary',
          'The annual salary is not a positive whole number of rupees',
          DEFAULT_FIX.annualSalary,
          'FIELD',
        ),
      );
    }
  }
  let monthlySalary: string | null = null;
  const monthlyText = values.monthlySalary ?? '';
  if (monthlyText.trim()) {
    const parsed = parseCensusRupees(monthlyText);
    if (parsed.ok) monthlySalary = parsed.value;
    else {
      issues.push(
        makeIssue(
          context,
          'monthlySalary',
          'The monthly salary is not a positive whole number of rupees',
          DEFAULT_FIX.monthlySalary,
          'FIELD',
        ),
      );
    }
  }
  const nominee = readNominee(readValues, context, options.today, issues);
  if (read.member) {
    if (read.member.dateOfBirth > options.today) {
      issues.push(
        makeIssue(
          context,
          'dateOfBirth',
          'The date of birth is after today',
          DEFAULT_FIX.dateOfBirth,
          'FUTURE_DATE',
        ),
      );
    }
    if (read.member.dateOfJoining && read.member.dateOfJoining > options.today) {
      issues.push(
        makeIssue(
          context,
          'dateOfJoining',
          'The date of joining is after today',
          DEFAULT_FIX.dateOfJoining,
          'FUTURE_DATE',
        ),
      );
    }
  }
  const member =
    read.member && issues.length === 0
      ? { ...read.member, annualSalary, monthlySalary, nominee }
      : null;
  return { member, issues };
}

/** The nominee columns of a row: none when all four are blank (N5, N6). */
function readNominee(
  values: EbCensusRowValues,
  context: Pick<EbCandidate, 'row' | 'values' | 'member'>,
  today: string,
  issues: EbCensusIssue[],
): Nominee | null {
  const text = (
    field: 'nomineeName' | 'nomineeRelationship' | 'nomineeDateOfBirth' | 'nomineeAge',
  ) => (values[field] ?? '').trim();
  const name = text('nomineeName').replace(/\s+/g, ' ');
  const relationshipText = text('nomineeRelationship');
  const birthText = text('nomineeDateOfBirth');
  const ageText = text('nomineeAge');
  if (!name && !relationshipText && !birthText && !ageText) return null;
  const add = (field: EbCensusField, message: string) =>
    issues.push(makeIssue(context, field, message, DEFAULT_FIX[field], 'NOMINEE'));
  const before = issues.length;
  if (!name) add('nomineeName', 'Enter the nominee’s name');
  else if (name.length > 120) add('nomineeName', 'Shorten the nominee’s name to 120 characters');
  const relationship = relationshipText ? parseNomineeRelationship(relationshipText) : null;
  if (!relationshipText)
    add('nomineeRelationship', 'Enter the nominee’s relationship to the insured');
  else if (!relationship) {
    add('nomineeRelationship', `"${relationshipText}" is not a nominee relationship`);
  }
  let dateOfBirth: string | null = null;
  if (birthText) {
    const parsed = parseCensusDate(birthText);
    if (!parsed.ok) add('nomineeDateOfBirth', parsed.message);
    else if (parsed.date > today)
      add('nomineeDateOfBirth', 'The nominee’s date of birth is after today');
    else dateOfBirth = parsed.date;
  }
  let age: number | null = null;
  if (ageText) {
    const value = Number(ageText);
    if (!/^\d{1,3}$/.test(ageText) || value > MAX_NOMINEE_AGE) {
      add('nomineeAge', `The nominee’s age must be a whole number from 0 to ${MAX_NOMINEE_AGE}`);
    } else age = value;
  }
  if (!birthText && !ageText) add('nomineeDateOfBirth', 'Enter the nominee’s date of birth or age');
  if (issues.length > before || !relationship) return null;
  return { name, relationship, dateOfBirth, age };
}

/** A census file row as a candidate, read the way the case's mode reads it. */
export function candidateFromRow(
  row: number,
  values: EbCensusRowValues,
  context: Pick<EbCensusContext, 'family' | 'today'>,
): EbCandidate {
  const base = { key: String(row), row, label: `row ${row}`, values };
  if (context.family.mode === 'LEGACY') {
    const read = readCensusRow({
      employeeId: values.employeeId,
      name: values.name,
      gender: values.gender,
      dateOfBirth: values.dateOfBirth,
      relationship: values.relationship,
      dateOfJoining: values.dateOfJoining,
      sumInsured: values.sumInsured,
    });
    return {
      ...base,
      member: read.member ? { ...read.member, annualSalary: null } : null,
      issues: [],
      legacyIssues: read.issues,
    };
  }
  const slots = context.family.plan.slots;
  const onlySelf = slots.every((slot) =>
    slot.relationships.every((item) => item.relationship === 'SELF'),
  );
  const read = readEbCensusRow(values, { row, today: context.today, assumeSelf: onlySelf });
  return { ...base, member: read.member, issues: read.issues };
}

/** A member typed on screen (already checked by its schema) as a candidate. */
export function candidateFromMember(
  key: string,
  member: EbCensusMember,
  label = 'this member',
): EbCandidate {
  return { key, row: null, label, member, issues: [], values: null };
}

/** A typed member, normalised as the census stores it. */
export function ebMemberFromInput(input: {
  employeeId: string;
  name: string;
  gender: GhiGender;
  dateOfBirth: string;
  relationship: GhiRelationship;
  dateOfJoining: string | null;
  sumInsured: string | null;
  annualSalary?: string | null;
  monthlySalary?: string | null;
  nominee?: Nominee | null;
}): EbCensusMember {
  const strip = (value: string | null | undefined) =>
    value === null || value === undefined ? null : value.replace(/^0+(?=\d)/, '');
  return {
    employeeId: input.employeeId.trim(),
    employeeKey: employeeKeyOf(input.employeeId),
    name: input.name.trim().replace(/\s+/g, ' '),
    nameKey: nameKeyOf(input.name),
    gender: input.gender,
    dateOfBirth: input.dateOfBirth,
    relationship: input.relationship,
    dateOfJoining: input.dateOfJoining,
    sumInsured: strip(input.sumInsured),
    annualSalary: strip(input.annualSalary),
    monthlySalary: strip(input.monthlySalary),
    nominee: input.nominee
      ? { ...input.nominee, name: input.nominee.name.trim().replace(/\s+/g, ' ') }
      : null,
  };
}

// Identity (Requirement 17.5)

export interface IdentityMismatch {
  field: 'name' | 'gender' | 'dateOfBirth';
  identityValue: string;
  rowValue: string;
}

/** The fields among name, gender and date of birth that differ; never the date of joining. */
export function identityMismatches(
  identity: Pick<IdentityDetails, 'name' | 'nameKey' | 'gender' | 'dateOfBirth'>,
  row: Pick<EbCensusMember, 'name' | 'gender' | 'dateOfBirth'>,
): IdentityMismatch[] {
  const mismatches: IdentityMismatch[] = [];
  if (nameKeyOf(identity.name) !== nameKeyOf(row.name)) {
    mismatches.push({ field: 'name', identityValue: identity.name, rowValue: row.name });
  }
  if (identity.gender !== row.gender) {
    mismatches.push({
      field: 'gender',
      identityValue: GHI_GENDER_LABELS[identity.gender],
      rowValue: GHI_GENDER_LABELS[row.gender],
    });
  }
  if (identity.dateOfBirth !== row.dateOfBirth) {
    mismatches.push({
      field: 'dateOfBirth',
      identityValue: identity.dateOfBirth,
      rowValue: row.dateOfBirth,
    });
  }
  return mismatches;
}

function identityIssues(candidate: EbCandidate, context: EbCensusContext): EbCensusIssue[] {
  const member = candidate.member;
  if (!context.identityChecks || !member || member.relationship !== 'SELF') return [];
  const unresolved = context.unresolvedKeys.get(member.employeeKey);
  if (unresolved) {
    return [
      makeIssue(
        candidate,
        'employeeId',
        `Employee ${member.employeeId} is unresolved: the members on case${unresolved.length === 1 ? '' : 's'} ${unresolved.join(', ')} disagree on the name, gender or date of birth`,
        'Resolve the employee on the company page first, then check the row again.',
        'EMPLOYEE_UNRESOLVED',
      ),
    ];
  }
  const identity = context.identities.get(member.employeeKey);
  if (!identity) return [];
  return identityMismatches(identity, member).map((mismatch) =>
    makeIssue(
      candidate,
      mismatch.field,
      `The ${mismatch.field === 'dateOfBirth' ? 'date of birth' : mismatch.field} differs from the company’s record of employee ${member.employeeId}: "${mismatch.identityValue}" there, "${mismatch.rowValue}" here`,
      'Correct the row, or update the employee on the company page if the company’s record is wrong.',
      'IDENTITY_MISMATCH',
    ),
  );
}

// Member checks (plan mode)

function ageIssues(candidate: EbCandidate, member: EbCensusMember, context: EbCensusContext) {
  const issues: EbCensusIssue[] = [];
  if (member.dateOfBirth > context.today) return issues;
  const age = ageOn(member.dateOfBirth, context.referenceDate);
  const limit = context.ageLimits[ageGroupOf(member.relationship)];
  const word = memberWord(member.relationship);
  if (limit.min !== null && age < limit.min) {
    issues.push(
      makeIssue(
        candidate,
        'dateOfBirth',
        `Age ${age} is below the minimum of ${limit.min} for ${word} members`,
        'Check the date of birth, or the age limits on the Data Sheet.',
        'AGE_LIMIT',
      ),
    );
  }
  if (limit.max !== null && age > limit.max) {
    issues.push(
      makeIssue(
        candidate,
        'dateOfBirth',
        `Age ${age} is above the maximum of ${limit.max} for ${word} members`,
        'Check the date of birth, or the age limits on the Data Sheet.',
        'AGE_LIMIT',
      ),
    );
  }
  return issues;
}

const MALE_ONLY: readonly GhiRelationship[] = ['FATHER', 'FATHER_IN_LAW'];
const FEMALE_ONLY: readonly GhiRelationship[] = ['MOTHER', 'MOTHER_IN_LAW'];

function genderIssues(candidate: EbCandidate, member: EbCensusMember): EbCensusIssue[] {
  const label = relationshipLabel(member.relationship).toLowerCase();
  if (MALE_ONLY.includes(member.relationship) && member.gender === 'FEMALE') {
    return [
      makeIssue(
        candidate,
        'gender',
        `A ${label} cannot be Female`,
        'Check the gender or the relationship.',
        'GENDER',
      ),
    ];
  }
  if (FEMALE_ONLY.includes(member.relationship) && member.gender === 'MALE') {
    return [
      makeIssue(
        candidate,
        'gender',
        `A ${label} cannot be Male`,
        'Check the gender or the relationship.',
        'GENDER',
      ),
    ];
  }
  return [];
}

function sumInsuredIssues(
  candidate: EbCandidate,
  member: EbCensusMember,
  context: EbCensusContext,
): EbCensusIssue[] {
  const rules = context.members;
  const issue = (field: EbCensusField, message: string, fix: string) =>
    makeIssue(candidate, field, message, fix, 'SUM_INSURED');
  if (rules.product === 'GMC') {
    if (member.sumInsured === null) {
      if (member.relationship === 'SELF') {
        return [
          issue(
            'sumInsured',
            'The employee’s sum insured is missing',
            'Enter the employee’s sum insured in whole rupees.',
          ),
        ];
      }
      if (rules.coverageType === 'INDIVIDUAL') {
        return [
          issue(
            'sumInsured',
            'Individual cover: this member’s own sum insured is missing',
            'Enter the member’s own sum insured in whole rupees.',
          ),
        ];
      }
      return [];
    }
    if (
      rules.sumInsuredOptions.length > 0 &&
      !rules.sumInsuredOptions.includes(member.sumInsured)
    ) {
      return [
        issue(
          'sumInsured',
          `${rupees(member.sumInsured)} is not offered (Data Sheet: sums insured)`,
          `Use one of ${rules.sumInsuredOptions.map(rupees).join(', ')}.`,
        ),
      ];
    }
    return [];
  }
  if (member.relationship !== 'SELF') {
    if (rules.product !== 'GPA') return [];
    const rule = dependantRuleOf(rules.dependantBasis, member.relationship);
    // A relationship the plan does not cover is refused by the plan check, not here.
    const planCovers =
      context.family.mode !== 'PLAN' ||
      context.family.plan.slots.some((slot) =>
        slot.relationships.some((item) => item.relationship === member.relationship),
      );
    if (rules.dependantBasis?.kind === 'BY_RELATIONSHIP' && rule === null && planCovers) {
      return [
        issue(
          'relationship',
          `The Data Sheet has no cover rule for a ${relationshipLabel(member.relationship).toLowerCase()}`,
          'Add a rule for this relationship on the Data Sheet, or remove the row.',
        ),
      ];
    }
    if (rule?.kind === 'OWN_AMOUNT' && member.sumInsured === null) {
      return [
        issue(
          'sumInsured',
          'Dependants have their own sum insured on this case, and this one is missing',
          'Enter the dependant’s sum insured in whole rupees.',
        ),
      ];
    }
    // Equal to the employee's (or a percentage of it): checked once the family is known.
    return [];
  }
  const basis = rules.basis;
  if (basis === null) return [];
  switch (basis.kind) {
    case 'FLAT':
      if (member.sumInsured !== basis.amount) {
        return [
          issue(
            'sumInsured',
            member.sumInsured === null
              ? 'The employee’s sum insured is missing'
              : `${rupees(member.sumInsured)} is not the flat sum insured of ${rupees(basis.amount)}`,
            `Enter ${rupees(basis.amount)} (Data Sheet: flat sum insured).`,
          ),
        ];
      }
      return [];
    case 'GRADED':
      if (member.sumInsured === null || !basis.amounts.includes(member.sumInsured)) {
        return [
          issue(
            'sumInsured',
            member.sumInsured === null
              ? 'The employee’s sum insured is missing'
              : `${rupees(member.sumInsured)} is not one of the graded sums insured`,
            `Use one of ${basis.amounts.map(rupees).join(', ')} (Data Sheet: graded sums insured).`,
          ),
        ];
      }
      return [];
    case 'SALARY_MULTIPLE': {
      const monthly = salaryInputOf(basis) === 'MONTHLY';
      if (monthly && (member.monthlySalary ?? null) === null) {
        return [
          issue(
            'monthlySalary',
            'The monthly salary is missing: the sum assured is worked out from it (annual CTC = monthly × 12)',
            'Enter the employee’s monthly salary in whole rupees.',
          ),
        ];
      }
      if (!monthly && member.annualSalary === null) {
        return [
          issue(
            'annualSalary',
            'The annual salary is missing: the sum insured is a multiple of salary',
            'Enter the employee’s annual salary in whole rupees.',
          ),
        ];
      }
      const annual = annualSalaryOf(member, basis, context)!;
      if (BigInt(annual) === 0n) {
        const field = monthly ? 'monthlySalary' : 'annualSalary';
        return [
          issue(
            field,
            `The ${monthly ? 'monthly' : 'annual'} salary must be above 0`,
            `Enter the employee’s ${monthly ? 'monthly' : 'annual'} salary in whole rupees.`,
          ),
        ];
      }
      if (monthly && member.annualSalary !== null && member.annualSalary !== annual) {
        return [
          issue(
            'annualSalary',
            `${rupees(member.annualSalary)} is not 12 × the monthly salary (${rupees(annual)})`,
            `Leave the annual salary blank or enter ${rupees(annual)}.`,
          ),
        ];
      }
      const derived = context.deriveSumInsured(annual, basis.multiplier, basis.maximum);
      if (member.sumInsured !== null && member.sumInsured !== derived) {
        return [
          issue(
            'sumInsured',
            `${rupees(member.sumInsured)} is not ${basis.multiplier} × the annual ${monthly ? 'CTC' : 'salary'} (${rupees(derived)}${basis.maximum ? `, at most ${rupees(basis.maximum)}` : ''})`,
            `Leave the sum insured blank or enter ${rupees(derived)}.`,
          ),
        ];
      }
      return [];
    }
  }
}

/** Checks of a member on its own against the Data Sheet (plan mode). */
function memberIssues(
  candidate: EbCandidate,
  member: EbCensusMember,
  context: EbCensusContext,
): EbCensusIssue[] {
  const issues: EbCensusIssue[] = [];
  if (
    member.dateOfBirth > context.today &&
    !candidate.issues.some((item) => item.code === 'FUTURE_DATE')
  ) {
    issues.push(
      makeIssue(
        candidate,
        'dateOfBirth',
        'The date of birth is after today',
        DEFAULT_FIX.dateOfBirth,
        'FUTURE_DATE',
      ),
    );
  }
  if (
    member.dateOfJoining &&
    member.dateOfJoining > context.today &&
    !candidate.issues.some((item) => item.code === 'FUTURE_DATE' && item.field === 'dateOfJoining')
  ) {
    issues.push(
      makeIssue(
        candidate,
        'dateOfJoining',
        'The date of joining is after today',
        DEFAULT_FIX.dateOfJoining,
        'FUTURE_DATE',
      ),
    );
  }
  if (
    member.relationship === 'SELF' &&
    member.dateOfJoining &&
    member.dateOfJoining < member.dateOfBirth
  ) {
    issues.push(
      makeIssue(
        candidate,
        'dateOfJoining',
        'The date of joining is before the date of birth',
        'Check both dates.',
        'DATES',
      ),
    );
  }
  issues.push(...genderIssues(candidate, member));
  issues.push(...ageIssues(candidate, member, context));
  issues.push(...sumInsuredIssues(candidate, member, context));
  issues.push(...nomineeIssues(candidate, member, context));
  return issues;
}

/** A nominee where the Data Sheet asks for one (N5, N6); GMC never asks. */
function nomineeIssues(
  candidate: EbCandidate,
  member: EbCensusMember,
  context: EbCensusContext,
): EbCensusIssue[] {
  const rules = context.members;
  if (rules.product === 'GMC' || !rules.nominees) return [];
  if (!nomineeRequiredFor(rules.nominees, member.relationship) || member.nominee) return [];
  return [
    makeIssue(
      candidate,
      'nomineeName',
      `A nominee is required for ${rules.nominees === 'EVERY_MEMBER' ? 'every insured member' : 'each employee'} on this case, and this ${memberWord(member.relationship)} has none`,
      'Enter the nominee’s name, relationship to the insured, and date of birth or age.',
      'NOMINEE_REQUIRED',
    ),
  ];
}

// Families (plan mode)

interface PlanFamily {
  self: { label: string; member: EbCensusMember } | null;
  members: Array<{ label: string; member: EbCensusMember }>;
  seen: Map<string, string>;
}

function duplicateKey(member: EbCensusMember): string {
  return `${member.relationship}|${member.nameKey}|${member.dateOfBirth}`;
}

const PLURAL: Record<GhiRelationship, [string, string]> = {
  SELF: ['employee (Self) row', 'employee (Self) rows'],
  SPOUSE: ['spouse', 'spouses'],
  CHILD: ['child', 'children'],
  FATHER: ['father', 'fathers'],
  MOTHER: ['mother', 'mothers'],
  FATHER_IN_LAW: ['father-in-law', 'fathers-in-law'],
  MOTHER_IN_LAW: ['mother-in-law', 'mothers-in-law'],
};
const countOf = (count: number, relationship: GhiRelationship) =>
  `${count} ${PLURAL[relationship][count === 1 ? 0 : 1]}`;
const planTitle = (plan: PlanRules) => `the plan ${plan.name} v${plan.versionNumber}`;
const where = (label: string) =>
  label === 'census' ? 'is already in the census' : `is on ${label}`;

function planFamilyIssues(
  family: PlanFamily,
  candidate: EbCandidate,
  member: EbCensusMember,
  plan: PlanRules,
): EbCensusIssue[] {
  const id = member.employeeId;
  const earlier = family.seen.get(duplicateKey(member));
  if (earlier) {
    return [
      makeIssue(
        candidate,
        'name',
        `Duplicate: ${member.name} (${relationshipLabel(member.relationship)}, born ${member.dateOfBirth}) ${where(earlier)}`,
        'Remove the repeated row.',
        'DUPLICATE',
      ),
    ];
  }
  const slotIndex = plan.slots.findIndex((slot) =>
    slot.relationships.some((item) => item.relationship === member.relationship),
  );
  const slot = plan.slots[slotIndex];
  if (!slot) {
    return [
      makeIssue(
        candidate,
        'relationship',
        `${planTitle(plan)} does not cover a ${relationshipLabel(member.relationship).toLowerCase()}`,
        'Remove the row or assign a plan that covers this relationship.',
        'RELATIONSHIP_NOT_COVERED',
      ),
    ];
  }
  if (member.relationship === 'SELF' && family.self) {
    return [
      makeIssue(
        candidate,
        'relationship',
        `Employee ${id} already has an employee (Self) row that ${where(family.self.label)}`,
        'Remove the row, or give it the right relationship or employee ID.',
        'SECOND_SELF',
      ),
    ];
  }
  const limit = slot.relationships.find((item) => item.relationship === member.relationship)!;
  const sameRelationship = family.members.filter(
    (item) => item.member.relationship === member.relationship,
  ).length;
  if (sameRelationship >= limit.max) {
    return [
      makeIssue(
        candidate,
        'relationship',
        `employee ${id} already has ${countOf(sameRelationship, member.relationship)}; ${planTitle(plan)} allows at most ${limit.max}.`,
        'Remove the row or change the plan.',
        'RELATIONSHIP_LIMIT',
      ),
    ];
  }
  const inSlot = family.members.filter((item) =>
    slot.relationships.some((accepted) => accepted.relationship === item.member.relationship),
  ).length;
  if (inSlot >= slot.max) {
    return [
      makeIssue(
        candidate,
        'relationship',
        `employee ${id} already has ${inSlot} member${inSlot === 1 ? '' : 's'} in the ${slot.name} slot; ${planTitle(plan)} allows at most ${slot.max}.`,
        'Remove the row or change the plan.',
        'SLOT_LIMIT',
      ),
    ];
  }
  if (!plan.parentsAndInLawsMixed) {
    const otherSide = PARENT_RELATIONSHIPS.includes(member.relationship)
      ? IN_LAW_RELATIONSHIPS
      : IN_LAW_RELATIONSHIPS.includes(member.relationship)
        ? PARENT_RELATIONSHIPS
        : [];
    const mixed = family.members.find((item) => otherSide.includes(item.member.relationship));
    if (mixed) {
      return [
        makeIssue(
          candidate,
          'relationship',
          `employee ${id} already covers a ${relationshipLabel(mixed.member.relationship).toLowerCase()}; ${planTitle(plan)} does not allow parents and parents-in-law in one family.`,
          'Cover either parents or parents-in-law: remove the row or change the plan.',
          'PARENTS_MIXED',
        ),
      ];
    }
  }
  return [];
}

function joinPlanFamily(family: PlanFamily, member: EbCensusMember, label: string): void {
  family.seen.set(duplicateKey(member), label);
  family.members.push({ label, member });
  if (member.relationship === 'SELF') family.self = { label, member };
}

/** The cover of a member and how it is worked out (N5, N6), for screens and documents. */
export interface MemberCoverage {
  /** Whole rupees; null when it cannot be worked out. */
  amount: string | null;
  /** For example "₹50,000 a month × 12 = ₹6,00,000 annual CTC × 4 = ₹24,00,000". */
  basis: string;
}

type CoverageContext = Pick<
  EbCensusContext,
  'members' | 'deriveSumInsured' | 'percentOf' | 'annualOf'
>;

/** The employee's annual salary as the basis reads it: as given, or monthly × 12 (N6). */
function annualSalaryOf(
  row: EbCensusMember,
  basis: Extract<SumInsuredBasis, { kind: 'SALARY_MULTIPLE' }>,
  context: CoverageContext,
): string | null {
  if (salaryInputOf(basis) !== 'MONTHLY') return row.annualSalary;
  const monthly = row.monthlySalary ?? null;
  return monthly === null ? null : (context.annualOf ?? annualFromMonthly)(monthly);
}

function employeeCoverage(row: EbCensusMember | null, context: CoverageContext): MemberCoverage {
  if (!row) return { amount: null, basis: 'The employee’s own row is missing' };
  const rules = context.members;
  if (rules.product === 'GMC') return { amount: row.sumInsured, basis: 'As entered' };
  const basis = rules.basis;
  if (basis?.kind === 'SALARY_MULTIPLE') {
    const monthly = salaryInputOf(basis) === 'MONTHLY';
    const annual = annualSalaryOf(row, basis, context);
    if (annual === null) {
      return {
        amount: row.sumInsured,
        basis: `The ${monthly ? 'monthly' : 'annual'} salary is missing`,
      };
    }
    const amount = context.deriveSumInsured(annual, basis.multiplier, basis.maximum);
    const uncapped =
      basis.maximum === null ? amount : context.deriveSumInsured(annual, basis.multiplier, null);
    const salary = monthly
      ? `${rupees(row.monthlySalary!)} a month × 12 = ${rupees(annual)} annual CTC`
      : `${rupees(annual)} annual salary`;
    return {
      amount,
      basis: `${salary} × ${basis.multiplier} = ${rupees(uncapped)}${uncapped === amount ? '' : `, capped at the maximum of ${rupees(amount)}`}`,
    };
  }
  if (basis?.kind === 'FLAT') return { amount: row.sumInsured, basis: 'Flat sum insured' };
  if (basis?.kind === 'GRADED') return { amount: row.sumInsured, basis: 'Graded sum insured' };
  return { amount: row.sumInsured, basis: 'As entered' };
}

/** A member's cover, given its family's employee row (N5: GPA rules per relationship). */
export function memberCoverage(
  member: EbCensusMember,
  self: EbCensusMember | null,
  context: CoverageContext,
): MemberCoverage {
  const rules = context.members;
  if (rules.product === 'GMC') {
    if (rules.coverageType === 'FLOATER') {
      const amount = self?.sumInsured ?? null;
      return {
        amount,
        basis:
          amount === null
            ? 'The family’s sum insured is missing'
            : `Family floater: the employee’s ${rupees(amount)}`,
      };
    }
    return { amount: member.sumInsured, basis: 'Own sum insured' };
  }
  if (member.relationship === 'SELF') return employeeCoverage(member, context);
  if (rules.product !== 'GPA') return { amount: member.sumInsured, basis: 'As entered' };
  const rule = dependantRuleOf(rules.dependantBasis, member.relationship);
  const word = relationshipLabel(member.relationship).toLowerCase();
  if (rule === null) {
    return {
      amount: member.sumInsured,
      basis: rules.dependantBasis === null ? 'As entered' : `No cover rule for a ${word}`,
    };
  }
  if (rule.kind === 'OWN_AMOUNT') return { amount: member.sumInsured, basis: 'Own amount' };
  if (rule.kind === 'FIXED_AMOUNT') {
    return { amount: rule.amount, basis: `Fixed ${rupees(rule.amount)} for a ${word}` };
  }
  const employeeAmount = employeeCoverage(self, context).amount;
  if (employeeAmount === null) {
    return { amount: member.sumInsured, basis: 'The employee’s sum insured is not known' };
  }
  if (rule.kind === 'EMPLOYEE_SUM_INSURED') {
    return { amount: employeeAmount, basis: `The employee’s ${rupees(employeeAmount)}` };
  }
  return {
    amount: context.percentOf(employeeAmount, rule.percent),
    basis: `${rule.percent}% of the employee’s ${rupees(employeeAmount)}`,
  };
}

/** The sum insured that covers a member, given its family's employee row (null when unknown). */
export function memberSumInsured(
  member: EbCensusMember,
  self: EbCensusMember | null,
  context: CoverageContext,
): string | null {
  return memberCoverage(member, self, context).amount;
}

const ruleMessage = (rule: DependantRule, relationship: GhiRelationship, expected: string) => {
  switch (rule.kind) {
    case 'EMPLOYEE_SUM_INSURED':
      return `Dependants take the employee’s sum insured (${rupees(expected)}) on this case`;
    case 'PERCENT_OF_EMPLOYEE':
      return `Dependants take ${rule.percent}% of the employee’s sum insured (${rupees(expected)}) on this case`;
    default:
      return `A ${relationshipLabel(relationship).toLowerCase()} is covered for a fixed ${rupees(expected)} on this case`;
  }
};

function dependantAmountIssues(
  candidate: EbCandidate,
  member: EbCensusMember,
  self: EbCensusMember,
  context: EbCensusContext,
): EbCensusIssue[] {
  const rules = context.members;
  if (rules.product === 'GMC') {
    if (
      rules.coverageType === 'FLOATER' &&
      member.sumInsured !== null &&
      self.sumInsured !== null &&
      member.sumInsured !== self.sumInsured
    ) {
      return [
        makeIssue(
          candidate,
          'sumInsured',
          `Family floater: dependants share the employee’s sum insured (${rupees(self.sumInsured)})`,
          'Leave it blank or enter the same amount.',
          'SUM_INSURED',
        ),
      ];
    }
    return [];
  }
  if (rules.product !== 'GPA' || member.sumInsured === null) return [];
  const rule = dependantRuleOf(rules.dependantBasis, member.relationship);
  if (rule === null || rule.kind === 'OWN_AMOUNT') return [];
  const expected = memberSumInsured(member, self, context);
  if (expected === null || expected === member.sumInsured) return [];
  return [
    makeIssue(
      candidate,
      'sumInsured',
      ruleMessage(rule, member.relationship, expected),
      `Leave it blank or enter ${rupees(expected)}.`,
      'SUM_INSURED',
    ),
  ];
}

/** GTLI members whose sum insured is strictly above the free cover limit (Requirement 5.3). */
export function freeCoverFlags(
  members: ReadonlyArray<{ key: string; sumInsured: string | null }>,
  limit: string | null,
): { flagged: string[]; count: number } {
  if (limit === null) return { flagged: [], count: 0 };
  const big = (value: string) => BigInt(value);
  const flagged = members
    .filter((member) => member.sumInsured !== null && big(member.sumInsured) > big(limit))
    .map((member) => member.key);
  return { flagged, count: flagged.length };
}

function legacyFix(issue: GhiCensusIssue): string {
  return DEFAULT_FIX[issue.field ?? 'employeeId'];
}

/**
 * Checks candidates (file rows in row order, or a typed member) against the case's Data Sheet,
 * plan and census. Members already in the census keep their places; of two conflicting rows the
 * earlier is kept. Returns every candidate's issues by key, none dropped (20.9).
 */
export function checkEbCensus(
  candidates: readonly EbCandidate[],
  existing: readonly EbCensusMember[],
  context: EbCensusContext,
): Map<string, EbCensusIssue[]> {
  if (context.family.mode === 'LEGACY') return checkLegacy(candidates, existing, context);
  const plan = context.family.plan;
  const families = new Map<string, PlanFamily>();
  const familyOf = (key: string) => {
    let family = families.get(key);
    if (!family) {
      family = { self: null, members: [], seen: new Map() };
      families.set(key, family);
    }
    return family;
  };
  for (const member of existing) joinPlanFamily(familyOf(member.employeeKey), member, 'census');

  const result = new Map<string, EbCensusIssue[]>();
  const invalidSelf = new Map<string, string>();
  for (const candidate of candidates) {
    const issues = [...candidate.issues];
    const member = candidate.member;
    if (member) {
      issues.push(...memberIssues(candidate, member, context));
      issues.push(...identityIssues(candidate, context));
      if (!issues.some(isError)) {
        const family = familyOf(member.employeeKey);
        issues.push(...planFamilyIssues(family, candidate, member, plan));
        if (!issues.some(isError)) joinPlanFamily(family, member, candidate.label);
      }
      if (issues.some(isError) && member.relationship === 'SELF') {
        invalidSelf.set(member.employeeKey, candidate.label);
      }
    } else if (candidate.values?.employeeId.trim()) {
      // An unreadable employee row is still the row its dependants wait for (18.4).
      const relationship = candidate.values.relationship.trim()
        ? parseRelationship(candidate.values.relationship)
        : plan.slots.every((slot) =>
              slot.relationships.every((item) => item.relationship === 'SELF'),
            )
          ? 'SELF'
          : null;
      if (relationship === 'SELF') {
        const key = employeeKeyOf(candidate.values.employeeId);
        if (!invalidSelf.has(key)) invalidSelf.set(key, candidate.label);
      }
    }
    result.set(candidate.key, issues);
  }

  // Dependants need their employee (18.4); their amounts follow the employee's.
  for (const candidate of candidates) {
    const member = candidate.member;
    const issues = result.get(candidate.key) ?? [];
    if (!member || issues.some(isError)) continue;
    if (member.relationship !== 'SELF') {
      const self = families.get(member.employeeKey)?.self;
      if (!self) {
        const failed = invalidSelf.get(member.employeeKey);
        issues.push(
          makeIssue(
            candidate,
            'employeeId',
            failed
              ? `The employee’s own row (${failed}) has errors`
              : `No employee (Self) row for employee ID ${member.employeeId}`,
            failed ? `Fix ${failed} first.` : 'Add the employee’s own row (Self) first.',
            'NO_EMPLOYEE',
          ),
        );
        // A dependant without its employee is not part of the family.
        const family = families.get(member.employeeKey);
        if (family) {
          family.members = family.members.filter((item) => item.label !== candidate.label);
          family.seen.delete(duplicateKey(member));
        }
      } else issues.push(...dependantAmountIssues(candidate, member, self.member, context));
    }
    // GTLI: above the free cover limit is a warning only (5.3).
    if (context.members.product === 'GTLI' && !issues.some(isError)) {
      const self =
        member.relationship === 'SELF'
          ? member
          : (families.get(member.employeeKey)?.self?.member ?? null);
      const amount = memberSumInsured(member, self, context);
      const limit = context.members.freeCoverLimit;
      if (limit !== null && amount !== null && BigInt(amount) > BigInt(limit)) {
        issues.push(
          makeIssue(
            candidate,
            'sumInsured',
            `${rupees(amount)} is above the free cover limit of ${rupees(limit)}: the insurer may ask for medical evidence`,
            'No change needed; this is for information (open question 12).',
            'ABOVE_FREE_COVER_LIMIT',
            'WARNING',
          ),
        );
      }
    }
    result.set(candidate.key, issues);
  }
  return result;
}

/** GMC without a plan: today's rules unchanged (16.3), plus the identity checks of design D7. */
function checkLegacy(
  candidates: readonly EbCandidate[],
  existing: readonly EbCensusMember[],
  context: EbCensusContext,
): Map<string, EbCensusIssue[]> {
  if (context.family.mode !== 'LEGACY') throw new Error('Legacy mode only');
  const rich = new Map<GhiCensusIssue, EbCensusIssue>();
  const legacy: Candidate[] = candidates.map((candidate) => {
    const read =
      candidate.legacyIssues ??
      candidate.issues.map((item) => {
        const plain = {
          field: ghiFieldOf(item.field),
          message: item.message,
        };
        rich.set(plain, item);
        return plain;
      });
    const extra = identityIssues(candidate, context).map((item) => {
      const plain = {
        field: ghiFieldOf(item.field),
        message: item.message,
      };
      rich.set(plain, item);
      return plain;
    });
    return {
      key: candidate.key,
      label: candidate.label,
      member: candidate.member,
      issues: read.length > 0 ? read : extra,
    };
  });
  const checked = checkCensus(legacy, existing, context.family.settings);
  const byKey = new Map(candidates.map((candidate) => [candidate.key, candidate]));
  const result = new Map<string, EbCensusIssue[]>();
  for (const [key, issues] of checked) {
    const candidate = byKey.get(key)!;
    result.set(
      key,
      issues.map(
        (item) =>
          rich.get(item) ??
          makeIssue(candidate, item.field, item.message, legacyFix(item), 'GMC_RULE'),
      ),
    );
  }
  return result;
}

/**
 * Families with fewer members in a slot than its minimum (Requirement 18.9), for each family
 * that has its employee row. Information for the whole census: no single row is refused for it.
 */
export function familyShortfalls(
  members: readonly EbCensusMember[],
  plan: PlanRules,
): FamilyShortfall[] {
  const families = new Map<string, EbCensusMember[]>();
  for (const member of members) {
    const list = families.get(member.employeeKey) ?? [];
    list.push(member);
    families.set(member.employeeKey, list);
  }
  const shortfalls: FamilyShortfall[] = [];
  for (const [employeeKey, family] of families) {
    const self = family.find((member) => member.relationship === 'SELF');
    if (!self) continue;
    for (const slot of plan.slots) {
      if (slot.min === 0) continue;
      const count = family.filter((member) =>
        slot.relationships.some((item) => item.relationship === member.relationship),
      ).length;
      if (count < slot.min) {
        shortfalls.push({
          employeeId: self.employeeId,
          employeeKey,
          slot: slot.name,
          count,
          min: slot.min,
          message: `Employee ${self.employeeId} has ${count} in the ${slot.name} slot; ${planTitle(plan)} needs at least ${slot.min}.`,
        });
      }
    }
  }
  return shortfalls;
}

/** Reads a gender or relationship value as the template accepts it (exported for the web app). */
export { parseGender as parseEbGender, parseRelationship as parseEbRelationship };
