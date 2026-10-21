import {
  GHI_RELATIONSHIPS,
  STANDARD_AGE_BANDS,
  bandIndexOf,
  completedAge,
  type AgeBand,
  type GhiCensusSummary,
  type GhiCoverageType,
  type GhiRelationship,
} from '../../shared/index.ts';
import { Decimal } from '../../lib/decimal.ts';

// The census summary (G4), worked out from the members every time it is read, so it can never
// lag a change. Ages are completed years on the case's one age reference date.

export interface SummaryMember {
  employeeKey: string;
  relationship: GhiRelationship;
  dateOfBirth: string;
  /** Whole rupees as entered; null when not given. */
  sumInsured: string | null;
}

export interface SummaryOptions {
  coverageType: GhiCoverageType | null;
  referenceDate: string;
  declaredEmployees: number | null;
  revision: number;
  /** N4: the case's age bands (missing: the standard bands, as before N4). */
  bands?: readonly AgeBand[];
  /** N4: which set the bands come from, for the screen; null for the standard bands. */
  ageBands?: { name: string; revision: number } | null;
}

/** A band's key: "19-35", or "66+" for an open last band (the keys used before N4). */
export const bandKeyOf = (band: Pick<AgeBand, 'min' | 'max'>) =>
  band.max === null ? `${band.min}+` : `${band.min}-${band.max}`;

/** The standard band key of an age in completed years. */
export function ageBandOf(age: number): string {
  const index = bandIndexOf(age, STANDARD_AGE_BANDS) ?? STANDARD_AGE_BANDS.length - 1;
  return bandKeyOf(STANDARD_AGE_BANDS[index]!);
}

/**
 * The sum insured that covers a member: in a family floater the employee's (shared by the
 * family), otherwise the member's own.
 */
export function effectiveSumInsured(
  member: SummaryMember,
  familySumInsured: ReadonlyMap<string, string | null>,
  coverageType: GhiCoverageType | null,
): string | null {
  if (coverageType === 'FLOATER') return familySumInsured.get(member.employeeKey) ?? null;
  return member.sumInsured;
}

export function summarizeCensus(
  members: readonly SummaryMember[],
  options: SummaryOptions,
): GhiCensusSummary {
  const byRelationship = Object.fromEntries(GHI_RELATIONSHIPS.map((key) => [key, 0])) as Record<
    GhiRelationship,
    number
  >;
  const bandList = options.bands ?? STANDARD_AGE_BANDS;
  const bands = bandList.map(() => 0);
  let outside = 0;
  let unknown = 0;
  const familySumInsured = new Map<string, string | null>();
  for (const member of members) {
    if (member.relationship === 'SELF') familySumInsured.set(member.employeeKey, member.sumInsured);
  }

  let totalAge = new Decimal(0);
  let missing = 0;
  let total = new Decimal(0);
  const bySumInsured = new Map<string, { families: number; lives: number }>();
  for (const member of members) {
    byRelationship[member.relationship] += 1;
    const age = completedAge(member.dateOfBirth, options.referenceDate);
    if (age === null) unknown += 1;
    else {
      totalAge = totalAge.plus(age);
      const band = bandIndexOf(age, bandList);
      if (band === null) outside += 1;
      else bands[band]! += 1;
    }

    const sumInsured = effectiveSumInsured(member, familySumInsured, options.coverageType);
    if (options.coverageType !== null && sumInsured === null) missing += 1;
    if (sumInsured !== null) {
      const entry = bySumInsured.get(sumInsured) ?? { families: 0, lives: 0 };
      entry.lives += 1;
      if (member.relationship === 'SELF') entry.families += 1;
      bySumInsured.set(sumInsured, entry);
    }
    // Floater: one sum insured per family (the employee's); individual: one per member.
    if (options.coverageType === 'FLOATER' && member.relationship === 'SELF' && sumInsured) {
      total = total.plus(sumInsured);
    }
    if (options.coverageType === 'INDIVIDUAL' && sumInsured) total = total.plus(sumInsured);
  }

  return {
    employees: byRelationship.SELF,
    lives: members.length,
    byRelationship,
    byAgeBand: bandList.map((band, index) => ({
      band: bandKeyOf(band),
      label: band.label,
      lives: bands[index]!,
    })),
    bySumInsured: [...bySumInsured.entries()]
      .sort(([a], [b]) => new Decimal(a).comparedTo(b))
      .map(([sumInsured, counts]) => ({ sumInsured, ...counts })),
    totalSumInsured: options.coverageType === null ? null : total.toFixed(0),
    coverageType: options.coverageType,
    ageReferenceDate: options.referenceDate,
    averageAge:
      members.length - unknown === 0
        ? null
        : totalAge.dividedBy(members.length - unknown).toFixed(1),
    declaredEmployees: options.declaredEmployees,
    missingSumInsured: missing,
    revision: options.revision,
    // N4: only when bands are given, so a summary without them reads exactly as before.
    ...(options.bands
      ? { ageBands: options.ageBands ?? null, outsideAgeBands: outside, ageUnknown: unknown }
      : {}),
  };
}
