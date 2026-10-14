import {
  GHI_AGE_BANDS,
  GHI_RELATIONSHIPS,
  type GhiCensusSummary,
  type GhiCoverageType,
  type GhiRelationship,
} from '../../shared/index.ts';
import { Decimal } from '../../lib/decimal.ts';
import { ageOn } from './census-rules.ts';

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
}

/** The age band (GHI_AGE_BANDS key) of an age in completed years. */
export function ageBandOf(age: number): string {
  const band = GHI_AGE_BANDS.find(
    (item) => age >= item.min && (item.max === null || age <= item.max),
  );
  return (band ?? GHI_AGE_BANDS[GHI_AGE_BANDS.length - 1]!).key;
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
  const bands = new Map<string, number>(GHI_AGE_BANDS.map((band) => [band.key, 0]));
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
    const age = ageOn(member.dateOfBirth, options.referenceDate);
    totalAge = totalAge.plus(age);
    const band = ageBandOf(age);
    bands.set(band, (bands.get(band) ?? 0) + 1);

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
    byAgeBand: GHI_AGE_BANDS.map((band) => ({
      band: band.key,
      label: band.label,
      lives: bands.get(band.key) ?? 0,
    })),
    bySumInsured: [...bySumInsured.entries()]
      .sort(([a], [b]) => new Decimal(a).comparedTo(b))
      .map(([sumInsured, counts]) => ({ sumInsured, ...counts })),
    totalSumInsured: options.coverageType === null ? null : total.toFixed(0),
    coverageType: options.coverageType,
    ageReferenceDate: options.referenceDate,
    averageAge: members.length === 0 ? null : totalAge.dividedBy(members.length).toFixed(1),
    declaredEmployees: options.declaredEmployees,
    missingSumInsured: missing,
    revision: options.revision,
  };
}
