import { z } from 'zod';

// Nominees (N5, N6): who receives a GPA or GTLI claim for an insured member. Each member has at
// most one nominee (the record holds one), so a member can never have duplicate nominees. Which
// members need one is a setting of the case's Data Sheet (open question NM-1): a new case starts
// with the employee's own row.

export const NOMINEE_RELATIONSHIPS = [
  'SPOUSE',
  'SON',
  'DAUGHTER',
  'FATHER',
  'MOTHER',
  'BROTHER',
  'SISTER',
  'OTHER',
] as const;
export type NomineeRelationship = (typeof NOMINEE_RELATIONSHIPS)[number];
export const NomineeRelationshipSchema = z.enum(NOMINEE_RELATIONSHIPS, {
  error: 'Choose the nominee’s relationship to the insured',
});
export const NOMINEE_RELATIONSHIP_LABELS: Record<NomineeRelationship, string> = {
  SPOUSE: 'Spouse',
  SON: 'Son',
  DAUGHTER: 'Daughter',
  FATHER: 'Father',
  MOTHER: 'Mother',
  BROTHER: 'Brother',
  SISTER: 'Sister',
  OTHER: 'Other',
};
/** What a census file may write for each relationship (case, spaces, . _ - ignored). */
export const NOMINEE_RELATIONSHIP_ALIASES: Record<NomineeRelationship, readonly string[]> = {
  SPOUSE: ['Spouse', 'Wife', 'Husband'],
  SON: ['Son'],
  DAUGHTER: ['Daughter'],
  FATHER: ['Father'],
  MOTHER: ['Mother'],
  BROTHER: ['Brother'],
  SISTER: ['Sister'],
  OTHER: ['Other'],
};

const aliasKey = (text: string) => text.toLowerCase().replace(/[\s._-]+/g, '');
const BY_ALIAS = new Map<string, NomineeRelationship>(
  Object.entries(NOMINEE_RELATIONSHIP_ALIASES).flatMap(([relationship, aliases]) =>
    aliases.map((alias) => [aliasKey(alias), relationship as NomineeRelationship] as const),
  ),
);
export function parseNomineeRelationship(text: string): NomineeRelationship | null {
  return BY_ALIAS.get(aliasKey(text)) ?? null;
}

export const NOMINEE_REQUIREMENTS = ['EMPLOYEE_ROWS', 'EVERY_MEMBER', 'NOT_REQUIRED'] as const;
export type NomineeRequirement = (typeof NOMINEE_REQUIREMENTS)[number];
export const NomineeRequirementSchema = z.enum(NOMINEE_REQUIREMENTS);
export const NOMINEE_REQUIREMENT_LABELS: Record<NomineeRequirement, string> = {
  EMPLOYEE_ROWS: 'Required on each employee’s own row',
  EVERY_MEMBER: 'Required for every insured member',
  NOT_REQUIRED: 'Not required',
};
/** What a new GPA or GTLI case starts with (open question NM-1). */
export const DEFAULT_NOMINEE_REQUIREMENT: NomineeRequirement = 'EMPLOYEE_ROWS';
/**
 * A Data Sheet without the setting (saved before N5, or by a client that leaves it out) asks for
 * no nominee, so cases already in progress are not blocked by a rule they were never given.
 */
export const nomineeRequirementOf = (sheet: {
  nominees?: NomineeRequirement;
}): NomineeRequirement => sheet.nominees ?? 'NOT_REQUIRED';

export const MAX_NOMINEE_AGE = 120;

/** A nominee: name, relationship, and the date of birth or the age (one of them). */
export interface Nominee {
  name: string;
  relationship: NomineeRelationship;
  dateOfBirth: string | null;
  age: number | null;
}

export const NomineeSchema = z
  .strictObject({
    name: z.string().trim().min(1, 'Enter the nominee’s name').max(120, 'This is too long'),
    relationship: NomineeRelationshipSchema,
    dateOfBirth: z.iso.date({ error: 'Enter a date' }).nullable().default(null),
    age: z
      .number({ error: 'Enter a whole number' })
      .int('Enter a whole number')
      .min(0, 'Enter 0 or more')
      .max(MAX_NOMINEE_AGE, `Enter at most ${MAX_NOMINEE_AGE}`)
      .nullable()
      .default(null),
  })
  .superRefine((nominee, context) => {
    if (nominee.dateOfBirth === null && nominee.age === null) {
      context.addIssue({
        code: 'custom',
        path: ['dateOfBirth'],
        message: 'Enter the nominee’s date of birth or age',
      });
    }
  });

/** Whether a member of this relationship needs a nominee under the case's setting. */
export function nomineeRequiredFor(requirement: NomineeRequirement, relationship: string): boolean {
  if (requirement === 'NOT_REQUIRED') return false;
  return requirement === 'EVERY_MEMBER' || relationship === 'SELF';
}

/** "Meera Nair (Spouse), born 03/04/1990" or "(Spouse), 34 years". */
export function nomineeText(
  nominee: Nominee | null | undefined,
  formatDate: (iso: string) => string,
): string {
  if (!nominee) return '';
  const when = nominee.dateOfBirth
    ? `born ${formatDate(nominee.dateOfBirth)}`
    : nominee.age !== null
      ? `${nominee.age} years`
      : '';
  return `${nominee.name} (${NOMINEE_RELATIONSHIP_LABELS[nominee.relationship]})${when ? `, ${when}` : ''}`;
}

export function sameNominee(a: Nominee | null | undefined, b: Nominee | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return (
    a.name === b.name &&
    a.relationship === b.relationship &&
    a.dateOfBirth === b.dateOfBirth &&
    a.age === b.age
  );
}
