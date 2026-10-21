import { formatIndianNumber } from './format.ts';
import {
  GHI_MAX_CHILDREN,
  type GhiAgeGroup,
  type GhiCoverageType,
  type GhiParentCover,
} from './ghi.ts';
import {
  GHI_CENSUS_FIELD_LABELS,
  GHI_GENDER_ALIASES,
  GHI_RELATIONSHIP_ALIASES,
  GHI_RELATIONSHIP_LABELS,
  type GhiCensusField,
  type GhiCensusIssue,
  type GhiCensusRowValues,
  type GhiGender,
  type GhiMemberInput,
  type GhiRelationship,
} from './ghi-census.ts';

// The census rules (G3), pure so they can be tested on their own. A row is first read field by
// field, then checked against the case's Data Sheet (family definition, coverage type, sums
// insured, age limits) and against its family: the members already in the census and the other
// rows of the same file, in row order. Every message names the field and says what to do.

export interface CensusSettings {
  familyDefinition: { spouse: boolean; maxChildren: number; parents: GhiParentCover };
  coverageType: GhiCoverageType | null;
  /** Whole rupees; empty: any amount. */
  sumInsuredOptions: readonly string[];
  ageLimits: Record<GhiAgeGroup, { min: number | null; max: number | null }>;
  /** Ages are completed years on this date (YYYY-MM-DD). */
  referenceDate: string;
  /** Today in India (YYYY-MM-DD): no date of birth or joining may be after it. */
  today: string;
}

/** A member as the rules see it: every field read and normalised. */
export interface CensusMember {
  employeeId: string;
  employeeKey: string;
  name: string;
  nameKey: string;
  gender: GhiGender;
  dateOfBirth: string;
  relationship: GhiRelationship;
  dateOfJoining: string | null;
  /** Whole rupees, or null when not given. */
  sumInsured: string | null;
}

/** A row or member being added: its own read problems, and how to refer to it in messages. */
export interface Candidate {
  key: string;
  /** For example "row 7"; used when another row refers to this one. */
  label: string;
  member: CensusMember | null;
  issues: GhiCensusIssue[];
}

export function employeeKeyOf(employeeId: string): string {
  return employeeId.replace(/\s+/g, '').toUpperCase();
}

export function nameKeyOf(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

const issue = (field: GhiCensusField | null, message: string): GhiCensusIssue => ({
  field,
  message,
});

function aliasKey(text: string): string {
  return text.toLowerCase().replace(/[\s._-]+/g, '');
}

const RELATIONSHIP_BY_ALIAS = new Map<string, GhiRelationship>(
  Object.entries(GHI_RELATIONSHIP_ALIASES).flatMap(([relationship, aliases]) =>
    aliases.map((alias) => [aliasKey(alias), relationship as GhiRelationship] as const),
  ),
);
const GENDER_BY_ALIAS = new Map<string, GhiGender>(
  Object.entries(GHI_GENDER_ALIASES).flatMap(([gender, aliases]) =>
    aliases.map((alias) => [aliasKey(alias), gender as GhiGender] as const),
  ),
);

export function parseRelationship(text: string): GhiRelationship | null {
  return RELATIONSHIP_BY_ALIAS.get(aliasKey(text)) ?? null;
}

export function parseGender(text: string): GhiGender | null {
  return GENDER_BY_ALIAS.get(aliasKey(text)) ?? null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function isRealDate(year: number, month: number, day: number): boolean {
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function iso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export type DateResult = { ok: true; date: string } | { ok: false; message: string };

/**
 * Reads a date as HR files write it: 2026-04-01, 01/04/2026, 01-04-2026, 01.04.2026,
 * 01-Apr-2026, 1 April 2026, or an Excel date serial. Day before month, as in India; a two-digit
 * year is refused rather than guessed.
 */
export function parseCensusDate(text: string): DateResult {
  const value = text.trim();
  const fail = (message = 'Enter the date as DD/MM/YYYY') => ({ ok: false as const, message });
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:T00:00:00(?:\.000)?Z?)?$/.exec(value);
  if (match) {
    const [, y, m, d] = match.map(Number) as [number, number, number, number];
    return isRealDate(y, m, d)
      ? { ok: true, date: iso(y, m, d) }
      : fail('This date does not exist');
  }
  match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(value);
  if (match) {
    const [, d, m, y] = match.map(Number) as [number, number, number, number];
    if ((match[3] ?? '').length !== 4) return fail('Write the year in full, for example 1988');
    return isRealDate(y, m, d)
      ? { ok: true, date: iso(y, m, d) }
      : fail('This date does not exist');
  }
  match = /^(\d{1,2})[\s/.-]*([A-Za-z]{3,9})[\s/.,-]*(\d{2,4})$/.exec(value);
  if (match) {
    const month = MONTHS.indexOf((match[2] ?? '').slice(0, 3).toLowerCase()) + 1;
    if (month === 0) return fail();
    if ((match[3] ?? '').length !== 4) return fail('Write the year in full, for example 1988');
    const d = Number(match[1]);
    const y = Number(match[3]);
    return isRealDate(y, month, d)
      ? { ok: true, date: iso(y, month, d) }
      : fail('This date does not exist');
  }
  // An Excel serial number (days since 30 Dec 1899) in a cell not formatted as a date.
  if (/^\d{4,5}$/.test(value)) {
    const serial = Number(value);
    if (serial >= 1 && serial <= 109_573) {
      const date = new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000);
      return { ok: true, date: date.toISOString().slice(0, 10) };
    }
  }
  return fail();
}

/** Whole rupees as typed in a sheet: 5,00,000 or ₹500000 or 500000.00. */
export function parseCensusRupees(text: string): { ok: true; value: string } | { ok: false } {
  const cleaned = text.replace(/[₹,\s]/g, '').replace(/^rs\.?/i, '');
  const match = /^(\d{1,13})(?:\.0+)?$/.exec(cleaned);
  if (!match?.[1]) return { ok: false };
  const value = match[1].replace(/^0+(?=\d)/, '');
  return value === '0' ? { ok: false } : { ok: true, value };
}

/** Completed years on the reference date (0 for someone born after it). */
export function ageOn(dateOfBirth: string, referenceDate: string): number {
  const [by, bm, bd] = dateOfBirth.split('-').map(Number) as [number, number, number];
  const [ry, rm, rd] = referenceDate.split('-').map(Number) as [number, number, number];
  let age = ry - by;
  if (rm < bm || (rm === bm && rd < bd)) age -= 1;
  return Math.max(0, age);
}

export function ageGroupOf(relationship: GhiRelationship): GhiAgeGroup {
  switch (relationship) {
    case 'SELF':
      return 'employee';
    case 'SPOUSE':
      return 'spouse';
    case 'CHILD':
      return 'child';
    default:
      return 'parent';
  }
}

const EMPLOYEE_ID = /^[A-Za-z0-9][A-Za-z0-9/_.-]*$/;

/** Reads one census row's text, field by field. Null member when a required field fails. */
export function readCensusRow(values: GhiCensusRowValues): {
  member: CensusMember | null;
  issues: GhiCensusIssue[];
} {
  const issues: GhiCensusIssue[] = [];
  const employeeId = values.employeeId.trim();
  if (!employeeId) issues.push(issue('employeeId', 'Enter the employee ID'));
  else if (employeeId.length > 40 || !EMPLOYEE_ID.test(employeeId)) {
    issues.push(issue('employeeId', 'Use up to 40 letters, digits, / _ . or - in the employee ID'));
  }
  const name = values.name.trim().replace(/\s+/g, ' ');
  if (!name) issues.push(issue('name', 'Enter the member’s name'));
  else if (name.length > 120) issues.push(issue('name', 'Shorten the name to 120 characters'));

  const gender = values.gender.trim() ? parseGender(values.gender) : null;
  if (!values.gender.trim())
    issues.push(issue('gender', 'Enter the gender: Male, Female or Other'));
  else if (!gender) {
    issues.push(issue('gender', `"${values.gender}" is not a gender: use Male, Female or Other`));
  }

  const relationship = values.relationship.trim() ? parseRelationship(values.relationship) : null;
  if (!values.relationship.trim()) {
    issues.push(issue('relationship', 'Enter the relationship to the employee'));
  } else if (!relationship) {
    issues.push(
      issue(
        'relationship',
        `"${values.relationship}" is not a relationship: use Self, Spouse, Child, Father, Mother, Father-in-law or Mother-in-law`,
      ),
    );
  }

  let dateOfBirth: string | null = null;
  if (!values.dateOfBirth.trim()) issues.push(issue('dateOfBirth', 'Enter the date of birth'));
  else {
    const parsed = parseCensusDate(values.dateOfBirth);
    if (parsed.ok) dateOfBirth = parsed.date;
    else issues.push(issue('dateOfBirth', parsed.message));
  }

  let dateOfJoining: string | null = null;
  if (values.dateOfJoining.trim()) {
    const parsed = parseCensusDate(values.dateOfJoining);
    if (parsed.ok) dateOfJoining = parsed.date;
    else issues.push(issue('dateOfJoining', parsed.message));
  }

  let sumInsured: string | null = null;
  if (values.sumInsured.trim()) {
    const parsed = parseCensusRupees(values.sumInsured);
    if (parsed.ok) sumInsured = parsed.value;
    else {
      issues.push(issue('sumInsured', 'Enter the sum insured in whole rupees, for example 500000'));
    }
  }

  const member =
    employeeId && name && gender && relationship && dateOfBirth && issues.length === 0
      ? {
          employeeId,
          employeeKey: employeeKeyOf(employeeId),
          name,
          nameKey: nameKeyOf(name),
          gender,
          dateOfBirth,
          relationship,
          dateOfJoining,
          sumInsured,
        }
      : null;
  return { member, issues };
}

/** A member typed on screen (already checked by GhiMemberInputSchema). */
export function memberFromInput(input: GhiMemberInput): CensusMember {
  return {
    employeeId: input.employeeId,
    employeeKey: employeeKeyOf(input.employeeId),
    name: input.name.replace(/\s+/g, ' '),
    nameKey: nameKeyOf(input.name),
    gender: input.gender,
    dateOfBirth: input.dateOfBirth,
    relationship: input.relationship,
    dateOfJoining: input.dateOfJoining,
    sumInsured: input.sumInsured === null ? null : input.sumInsured.replace(/^0+(?=\d)/, ''),
  };
}

const rupees = (value: string) => `₹${formatIndianNumber(value, 0)}`;
const PARENTS: readonly GhiRelationship[] = ['FATHER', 'MOTHER'];
const IN_LAWS: readonly GhiRelationship[] = ['FATHER_IN_LAW', 'MOTHER_IN_LAW'];
const MALE_ONLY: readonly GhiRelationship[] = ['FATHER', 'FATHER_IN_LAW'];
const FEMALE_ONLY: readonly GhiRelationship[] = ['MOTHER', 'MOTHER_IN_LAW'];

/** Checks of a member on its own against the Data Sheet: dates, ages, eligibility, sum insured. */
function ownIssues(member: CensusMember, settings: CensusSettings): GhiCensusIssue[] {
  const issues: GhiCensusIssue[] = [];
  const label = GHI_RELATIONSHIP_LABELS[member.relationship];
  if (member.dateOfBirth > settings.today) {
    issues.push(issue('dateOfBirth', 'The date of birth is in the future'));
  }
  // The date of joining is the employee's; HR files often repeat it on the dependants' rows.
  if (member.dateOfJoining && member.relationship === 'SELF') {
    if (member.dateOfJoining < member.dateOfBirth) {
      issues.push(issue('dateOfJoining', 'The date of joining is before the date of birth'));
    }
  }
  if (MALE_ONLY.includes(member.relationship) && member.gender === 'FEMALE') {
    issues.push(
      issue(
        'gender',
        `A ${label.toLowerCase()} cannot be Female: check the gender or the relationship`,
      ),
    );
  }
  if (FEMALE_ONLY.includes(member.relationship) && member.gender === 'MALE') {
    issues.push(
      issue(
        'gender',
        `A ${label.toLowerCase()} cannot be Male: check the gender or the relationship`,
      ),
    );
  }

  // Who the policy covers (Data Sheet, family definition).
  const family = settings.familyDefinition;
  if (member.relationship === 'SPOUSE' && !family.spouse) {
    issues.push(
      issue('relationship', 'The policy does not cover spouses (Data Sheet: family definition)'),
    );
  }
  if (member.relationship === 'CHILD' && family.maxChildren === 0) {
    issues.push(
      issue('relationship', 'The policy does not cover children (Data Sheet: family definition)'),
    );
  }
  if (PARENTS.includes(member.relationship) && !['PARENTS', 'EITHER'].includes(family.parents)) {
    issues.push(
      issue('relationship', 'The policy does not cover parents (Data Sheet: family definition)'),
    );
  }
  if (
    IN_LAWS.includes(member.relationship) &&
    !['PARENTS_IN_LAW', 'EITHER'].includes(family.parents)
  ) {
    issues.push(
      issue(
        'relationship',
        'The policy does not cover parents-in-law (Data Sheet: family definition)',
      ),
    );
  }

  // Age limits, in completed years on the reference date.
  if (member.dateOfBirth <= settings.today) {
    const age = ageOn(member.dateOfBirth, settings.referenceDate);
    const group = ageGroupOf(member.relationship);
    const limit = settings.ageLimits[group];
    if (limit.min !== null && age < limit.min) {
      issues.push(
        issue(
          'dateOfBirth',
          `Age ${age} is below the minimum of ${limit.min} for ${label.toLowerCase()} members`,
        ),
      );
    }
    if (limit.max !== null && age > limit.max) {
      issues.push(
        issue(
          'dateOfBirth',
          `Age ${age} is above the maximum of ${limit.max} for ${label.toLowerCase()} members`,
        ),
      );
    }
  }

  // Sum insured: the employee always gives it; with individual cover every member does.
  if (member.sumInsured === null) {
    if (member.relationship === 'SELF') {
      issues.push(issue('sumInsured', 'Enter the employee’s sum insured'));
    } else if (settings.coverageType === 'INDIVIDUAL') {
      issues.push(issue('sumInsured', 'Individual cover: enter this member’s own sum insured'));
    }
  } else if (
    settings.sumInsuredOptions.length > 0 &&
    !settings.sumInsuredOptions.includes(member.sumInsured)
  ) {
    issues.push(
      issue(
        'sumInsured',
        `${rupees(member.sumInsured)} is not offered: use ${settings.sumInsuredOptions.map(rupees).join(', ')} (Data Sheet: sums insured)`,
      ),
    );
  }
  return issues;
}

interface Family {
  self: { label: string; sumInsured: string | null } | null;
  spouse: string | null;
  children: string[];
  roles: Map<GhiRelationship, string>;
  seen: Map<string, string>;
}

function emptyFamily(): Family {
  return { self: null, spouse: null, children: [], roles: new Map(), seen: new Map() };
}

function duplicateKey(member: CensusMember): string {
  return `${member.relationship}|${member.nameKey}|${member.dateOfBirth}`;
}

/**
 * Takes a member into its family, or says why it cannot join: a second employee row, spouse or
 * parent, a child beyond the limit, parents mixed with parents-in-law, or an exact duplicate.
 */
function familyIssues(
  family: Family,
  member: CensusMember,
  label: string,
  settings: CensusSettings,
): GhiCensusIssue[] {
  const where = (other: string) =>
    other === 'census' ? 'is already in the census' : `is on ${other}`;
  const earlier = family.seen.get(duplicateKey(member));
  if (earlier) {
    return [
      issue(
        'name',
        `Duplicate: ${member.name} (${GHI_RELATIONSHIP_LABELS[member.relationship]}, born ${member.dateOfBirth}) ${where(earlier)}`,
      ),
    ];
  }
  const id = member.employeeId;
  switch (member.relationship) {
    case 'SELF':
      if (family.self) {
        return [
          issue(
            'relationship',
            `Employee ${id} already has an employee (Self) row that ${where(family.self.label)}`,
          ),
        ];
      }
      break;
    case 'SPOUSE':
      if (family.spouse) {
        return [
          issue(
            'relationship',
            `Employee ${id} already has a spouse that ${where(family.spouse)}: one spouse per employee`,
          ),
        ];
      }
      break;
    case 'CHILD': {
      const limit = Math.min(settings.familyDefinition.maxChildren, GHI_MAX_CHILDREN);
      if (family.children.length >= limit) {
        return [
          issue(
            'relationship',
            `Employee ${id} already has ${family.children.length} children: at most ${limit} per employee`,
          ),
        ];
      }
      break;
    }
    default: {
      const role = family.roles.get(member.relationship);
      if (role) {
        return [
          issue(
            'relationship',
            `Employee ${id} already has a ${GHI_RELATIONSHIP_LABELS[member.relationship].toLowerCase()} that ${where(role)}`,
          ),
        ];
      }
      const otherSide = PARENTS.includes(member.relationship) ? IN_LAWS : PARENTS;
      const mixed = otherSide.find((relationship) => family.roles.has(relationship));
      if (mixed) {
        return [
          issue(
            'relationship',
            `Employee ${id} already covers a ${GHI_RELATIONSHIP_LABELS[mixed].toLowerCase()}: cover either parents or parents-in-law, not both`,
          ),
        ];
      }
    }
  }
  return [];
}

function join(family: Family, member: CensusMember, label: string): void {
  family.seen.set(duplicateKey(member), label);
  switch (member.relationship) {
    case 'SELF':
      family.self = { label, sumInsured: member.sumInsured };
      break;
    case 'SPOUSE':
      family.spouse = label;
      break;
    case 'CHILD':
      family.children.push(label);
      break;
    default:
      family.roles.set(member.relationship, label);
  }
}

/**
 * Checks rows against the Data Sheet, the census and each other. Members already in the census
 * hold their places; rows are taken in order, so the first of two spouses is kept and the second
 * gets the error. A dependant needs its employee's row, valid, in the census or the same file.
 * Returns every row's problems by key; a row with none can be imported.
 */
export function checkCensus(
  candidates: readonly Candidate[],
  existing: readonly CensusMember[],
  settings: CensusSettings,
): Map<string, GhiCensusIssue[]> {
  const families = new Map<string, Family>();
  const familyOf = (key: string) => {
    let family = families.get(key);
    if (!family) {
      family = emptyFamily();
      families.set(key, family);
    }
    return family;
  };
  for (const member of existing) join(familyOf(member.employeeKey), member, 'census');

  const result = new Map<string, GhiCensusIssue[]>();
  const invalidSelf = new Map<string, string>();
  for (const candidate of candidates) {
    const issues = [...candidate.issues];
    const member = candidate.member;
    if (member) {
      issues.push(...ownIssues(member, settings));
      if (issues.length === 0) {
        const family = familyOf(member.employeeKey);
        issues.push(...familyIssues(family, member, candidate.label, settings));
        if (issues.length === 0) join(family, member, candidate.label);
      }
      if (issues.length > 0 && member.relationship === 'SELF') {
        invalidSelf.set(member.employeeKey, candidate.label);
      }
    }
    result.set(candidate.key, issues);
  }

  // Dependants need their employee, and in a family floater share the employee's sum insured.
  for (const candidate of candidates) {
    const member = candidate.member;
    const issues = result.get(candidate.key) ?? [];
    if (!member || member.relationship === 'SELF' || issues.length > 0) continue;
    const family = families.get(member.employeeKey);
    if (!family?.self) {
      const failed = invalidSelf.get(member.employeeKey);
      issues.push(
        issue(
          'employeeId',
          failed
            ? `The employee’s own row (${failed}) has errors: fix it first`
            : `No employee (Self) row for employee ID ${member.employeeId}: add the employee first`,
        ),
      );
    } else if (
      settings.coverageType === 'FLOATER' &&
      member.sumInsured !== null &&
      family.self.sumInsured !== null &&
      member.sumInsured !== family.self.sumInsured
    ) {
      issues.push(
        issue(
          'sumInsured',
          `Family floater: dependants share the employee’s sum insured (${rupees(family.self.sumInsured)}); leave it blank or enter the same amount`,
        ),
      );
    }
    result.set(candidate.key, issues);
  }
  return result;
}

/** The field label an issue belongs to, for messages outside a table. */
export function issueText(item: GhiCensusIssue): string {
  return item.field ? `${GHI_CENSUS_FIELD_LABELS[item.field]}: ${item.message}` : item.message;
}
