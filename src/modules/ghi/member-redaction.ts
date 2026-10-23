import {
  hasPermission,
  type EbEmployee,
  type EbMember,
  type GhiMember,
  type MemberPrivateField,
  type Permission,
} from '../../shared/index.ts';
import type { Request } from 'express';
import { currentUser, requirePermission } from '../../middleware/require-permission.ts';

// Personal census and employee fields (dates of birth, salaries, nominees) are withheld by the API
// from users whose roles lack employees.view_dob, employees.view_salary or employees.view_nominee.
// Lists are redacted field by field; routes that return or write raw census rows (import previews,
// uploads, corrections, member edits) require the permissions outright, so nobody edits a field
// they cannot see. The error report needs census.export.

const FIELD_PERMISSION: Record<MemberPrivateField, Permission> = {
  dateOfBirth: 'employees.view_dob',
  salary: 'employees.view_salary',
  nominee: 'employees.view_nominee',
};

/** The private fields this user may not see. */
export function hiddenFields(req: Request): MemberPrivateField[] {
  const permissions = currentUser(req).permissions;
  return (Object.keys(FIELD_PERMISSION) as MemberPrivateField[]).filter(
    (field) => !hasPermission(permissions, FIELD_PERMISSION[field]),
  );
}

/** Guards for GMC routes that return or write raw census rows: GMC rows carry dates of birth. */
export const gmcRawCensus = () => [requirePermission('employees.view_dob')];

/** Guards for GPA and GTLI routes that return or write raw census rows. */
export const ebRawCensus = () => [
  requirePermission('employees.view_dob'),
  requirePermission('employees.view_salary'),
  requirePermission('employees.view_nominee'),
];

export function redactGhiMember(
  member: GhiMember,
  hidden: readonly MemberPrivateField[],
): GhiMember {
  if (!hidden.includes('dateOfBirth')) return member;
  return { ...member, dateOfBirth: null, hidden: ['dateOfBirth'] };
}

export function redactEbMember(member: EbMember, hidden: readonly MemberPrivateField[]): EbMember {
  if (hidden.length === 0) return member;
  return {
    ...member,
    dateOfBirth: hidden.includes('dateOfBirth') ? null : member.dateOfBirth,
    annualSalary: hidden.includes('salary') ? null : member.annualSalary,
    monthlySalary: hidden.includes('salary') ? null : member.monthlySalary,
    nominee: hidden.includes('nominee') ? null : member.nominee,
    hidden: [...hidden],
  };
}

export function redactEmployee(
  employee: EbEmployee,
  hidden: readonly MemberPrivateField[],
): EbEmployee {
  if (!hidden.includes('dateOfBirth')) return employee;
  return {
    ...employee,
    dateOfBirth: null,
    variants: employee.variants.map((variant) => ({ ...variant, dateOfBirth: null })),
    hidden: ['dateOfBirth'],
  };
}
