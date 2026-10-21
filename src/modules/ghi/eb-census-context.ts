import {
  ERROR_CODES,
  nomineeRequirementOf,
  type EbCensusContext,
  type EbCensusMember,
  type GpaRequirementsInput,
  type GtliRequirementsInput,
  type PlanRules,
} from '../../shared/index.ts';
import type { mongo } from 'mongoose';
import { toDecimal128 } from '../../lib/decimal.ts';
import { conflict } from '../../lib/errors.ts';
import { istDay } from '../../lib/ist-day.ts';
import { identityContext } from '../employees/employees.service.ts';
import { annualFromMonthly, percentOfSumInsured, salaryMultipleSumInsured } from './eb-calc.ts';
import type { GhiCaseDoc } from './ghi-case.model.ts';
import type { GhiMemberDoc } from './ghi-census.model.ts';
import { censusSettingsOf, referenceDateOf } from './ghi-common.ts';
import { productOf } from './products/profile.ts';

// The Census_Validator's context for one case (design D5, D7, D9): legacy mode for a GMC case
// without a plan, plan mode from the slots copied on the case's plan assignment otherwise; the
// case's Data Sheet; the company's employee identities; and the API's Decimal arithmetic.

export function planRulesOf(doc: GhiCaseDoc): PlanRules | null {
  const plan = doc.planAssignment;
  if (!plan) return null;
  return {
    code: plan.code,
    name: plan.name,
    versionNumber: plan.versionNumber,
    slots: plan.slots,
    parentsAndInLawsMixed: plan.parentsAndInLawsMixed,
  };
}

export const planRequired = () =>
  conflict(
    ERROR_CODES.EB_PLAN_REQUIRED,
    'Assign a family plan to the case first: its census is checked against the plan.',
  );

export function gpaRequirementsOf(doc: GhiCaseDoc): GpaRequirementsInput {
  return doc.requirements as unknown as GpaRequirementsInput;
}
export function gtliRequirementsOf(doc: GhiCaseDoc): GtliRequirementsInput {
  return doc.requirements as unknown as GtliRequirementsInput;
}

export async function buildCensusContext(
  doc: GhiCaseDoc,
  options: { session?: mongo.ClientSession; identityChecks?: boolean } = {},
): Promise<EbCensusContext> {
  const product = productOf(doc);
  const plan = planRulesOf(doc);
  if (!plan && product !== 'GMC') throw planRequired();
  const identities = await identityContext(doc.clientId, options.session);
  const requirements = doc.requirements;
  return {
    product,
    family: plan ? { mode: 'PLAN', plan } : { mode: 'LEGACY', settings: censusSettingsOf(doc) },
    members:
      product === 'GMC'
        ? {
            product,
            coverageType: requirements.coverageType,
            sumInsuredOptions: requirements.sumInsuredOptions,
          }
        : product === 'GPA'
          ? {
              product,
              basis: gpaRequirementsOf(doc).sumInsuredBasis,
              dependantBasis: gpaRequirementsOf(doc).dependantBasis,
              nominees: nomineeRequirementOf(gpaRequirementsOf(doc)),
            }
          : {
              product,
              basis: gtliRequirementsOf(doc).sumInsuredBasis,
              freeCoverLimit: gtliRequirementsOf(doc).freeCoverLimit,
              nominees: nomineeRequirementOf(gtliRequirementsOf(doc)),
            },
    ageLimits: requirements.ageLimits,
    referenceDate: referenceDateOf(doc),
    today: istDay(new Date()),
    identities: identities.identities,
    unresolvedKeys: identities.unresolvedKeys,
    deriveSumInsured: salaryMultipleSumInsured,
    percentOf: percentOfSumInsured,
    annualOf: annualFromMonthly,
    identityChecks: options.identityChecks ?? true,
  };
}

/** A stored member as the validator sees it. */
export function toEbCensusMember(
  doc: GhiMemberDoc,
): EbCensusMember & { id: string; employeeIdentityId: string | null } {
  return {
    id: doc._id.toHexString(),
    employeeId: doc.employeeId,
    employeeKey: doc.employeeKey,
    name: doc.name,
    nameKey: doc.nameKey,
    gender: doc.gender,
    dateOfBirth: doc.dateOfBirth,
    relationship: doc.relationship,
    dateOfJoining: doc.dateOfJoining,
    sumInsured: doc.sumInsured?.toString() ?? null,
    annualSalary: doc.annualSalary?.toString() ?? null,
    monthlySalary: doc.monthlySalary?.toString() ?? null,
    nominee: doc.nominee
      ? {
          name: doc.nominee.name,
          relationship: doc.nominee.relationship,
          dateOfBirth: doc.nominee.dateOfBirth,
          age: doc.nominee.age,
        }
      : null,
    employeeIdentityId: doc.employeeIdentityId?.toHexString() ?? null,
  };
}

/** The salary and nominee fields of a member as stored (N5, N6). */
export function storedExtras(
  member: Pick<EbCensusMember, 'annualSalary' | 'monthlySalary' | 'nominee'>,
) {
  return {
    annualSalary: member.annualSalary === null ? null : toDecimal128(member.annualSalary),
    monthlySalary:
      member.monthlySalary === null || member.monthlySalary === undefined
        ? null
        : toDecimal128(member.monthlySalary),
    nominee: member.nominee ?? null,
  };
}
