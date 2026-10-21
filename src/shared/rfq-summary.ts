import { z } from 'zod';
import { ObjectIdSchema } from './common.ts';
import {
  AgeBandSchema,
  bandIndexOf,
  bandRangeText,
  completedAge,
  type AgeBand,
} from './age-bands.ts';
import { EbProductSchema, type EbProduct } from './eb-products.ts';
import {
  GHI_GENDERS,
  GHI_RELATIONSHIPS,
  type GhiGender,
  type GhiRelationship,
} from './ghi-census.ts';

// The RFQ Selection Summary Sheet (N7): employees and lives by sum insured (GTLI: sum assured),
// the age band × sum insured matrix, gender and relationship counts and the cover by
// relationship, all worked out from the census as stored and the case's age bands. Pure, so the
// API, the documents and the screens show the same figures, and the tests can check them against
// an independent count. A floater (GMC) counts each family's sum insured once; nothing mixes the
// products' measures.

export interface SelectionMember {
  employeeKey: string;
  relationship: GhiRelationship;
  gender: GhiGender;
  /** YYYY-MM-DD; a missing or impossible date is reported, never given an age. */
  dateOfBirth: string | null;
  /** Whole rupees that cover this life (a floater family's shared amount); null if unknown. */
  cover: string | null;
}

export interface SelectionSummaryInput {
  product: EbProduct;
  /** GMC family floater: one sum insured per family. */
  floater: boolean;
  bands: readonly AgeBand[];
  referenceDate: string;
  members: readonly SelectionMember[];
}

export const SELECTION_MEASURES = ['SUM_INSURED', 'SUM_ASSURED'] as const;
export type SelectionMeasure = (typeof SELECTION_MEASURES)[number];
export const SELECTION_MEASURE_LABELS: Record<SelectionMeasure, string> = {
  SUM_INSURED: 'Sum insured',
  SUM_ASSURED: 'Sum assured',
};
/** GTLI covers a life for a sum assured; GMC and GPA for a sum insured. */
export const measureOf = (product: EbProduct): SelectionMeasure =>
  product === 'GTLI' ? 'SUM_ASSURED' : 'SUM_INSURED';

export const SELECTION_PROBLEM_CODES = [
  'NO_MEMBERS',
  'NO_COVER',
  'AGE_UNKNOWN',
  'OUTSIDE_BANDS',
] as const;

const Count = z.number().int();
const Amount = z.string();

export const RfqSelectionSummarySchema = z.object({
  product: EbProductSchema,
  measure: z.enum(SELECTION_MEASURES),
  floater: z.boolean(),
  referenceDate: z.iso.date(),
  bands: z.array(AgeBandSchema),
  /** The cover amounts found, lowest first: the columns of the matrix. */
  categories: z.array(Amount),
  /** A. Employees and lives by the employee's cover. */
  coverage: z.object({
    rows: z.array(z.object({ amount: Amount, employees: Count, lives: Count, total: Amount })),
    employees: Count,
    lives: Count,
    total: Amount,
  }),
  /** B. Lives in each age band by cover; totals of cover where each life has its own. */
  matrix: z.object({
    rows: z.array(
      z.object({
        label: z.string(),
        range: z.string(),
        kind: z.enum(['BAND', 'OUTSIDE', 'UNKNOWN']),
        lives: z.array(Count),
        totalLives: Count,
        /** Null for a floater: a family's sum insured is not split by age. */
        totalCover: Amount.nullable(),
      }),
    ),
    totals: z.object({
      lives: z.array(Count),
      cover: z.array(Amount.nullable()),
      totalLives: Count,
      totalCover: Amount.nullable(),
    }),
  }),
  /** C. Demographics. */
  genders: z.record(z.enum(GHI_GENDERS), Count),
  relationships: z.record(z.enum(GHI_RELATIONSHIPS), Count),
  groups: z.object({ children: Count, parents: Count, parentsInLaw: Count }),
  /** D. Cover by relationship (lives and total; floater: dependants share the family's). */
  byRelationship: z.array(
    z.object({
      relationship: z.enum(GHI_RELATIONSHIPS),
      lives: Count,
      total: Amount.nullable(),
    }),
  ),
  /** Members the figures cannot place: the summary is not complete while any is listed. */
  problems: z.array(
    z.object({ code: z.enum(SELECTION_PROBLEM_CODES), count: Count, message: z.string() }),
  ),
  /** Every count and total adds up to the census (always true when there is no problem). */
  reconciled: z.boolean(),
});
export type RfqSelectionSummary = z.infer<typeof RfqSelectionSummarySchema>;

const add = (a: bigint, b: string) => a + BigInt(b);

/** Builds the summary from the members as stored (N7 A to D). */
export function buildSelectionSummary(input: SelectionSummaryInput): RfqSelectionSummary {
  const { members, bands, floater } = input;
  const measure = measureOf(input.product);
  const categories = [
    ...new Set(members.flatMap((member) => (member.cover === null ? [] : [member.cover]))),
  ].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
  const column = new Map(categories.map((amount, index) => [amount, index]));

  // A. Employees and lives by the employee's (family's) cover.
  const byCategory = categories.map(() => ({ employees: 0, lives: 0, total: 0n }));
  let total = 0n;
  for (const member of members) {
    if (member.cover === null) continue;
    const row = byCategory[column.get(member.cover)!]!;
    row.lives += 1;
    if (member.relationship === 'SELF') row.employees += 1;
    // A floater family's sum insured counts once, on the employee's row.
    if (!floater || member.relationship === 'SELF') {
      row.total = add(row.total, member.cover);
      total = add(total, member.cover);
    }
  }

  // B. The age band matrix; members outside the bands or of unknown age get their own rows.
  type Row = { lives: number[]; totalLives: number; totalCover: bigint };
  const blank = (): Row => ({ lives: categories.map(() => 0), totalLives: 0, totalCover: 0n });
  const bandRows = bands.map(blank);
  const outside = blank();
  const unknown = blank();
  const columnLives = categories.map(() => 0);
  const columnCover = categories.map(() => 0n);
  let noCover = 0;
  for (const member of members) {
    const age = completedAge(member.dateOfBirth, input.referenceDate);
    const index = age === null ? null : bandIndexOf(age, bands);
    const row = age === null ? unknown : index === null ? outside : bandRows[index]!;
    row.totalLives += 1;
    if (member.cover === null) {
      noCover += 1;
      continue;
    }
    const at = column.get(member.cover)!;
    row.lives[at]! += 1;
    columnLives[at]! += 1;
    row.totalCover = add(row.totalCover, member.cover);
    columnCover[at] = add(columnCover[at]!, member.cover);
  }
  const cover = (value: bigint) => (floater ? null : value.toString());
  const matrixRows: RfqSelectionSummary['matrix']['rows'] = bands.map((band, index) => ({
    label: band.label,
    range: bandRangeText(band),
    kind: 'BAND' as const,
    lives: bandRows[index]!.lives,
    totalLives: bandRows[index]!.totalLives,
    totalCover: cover(bandRows[index]!.totalCover),
  }));
  if (outside.totalLives > 0) {
    matrixRows.push({
      label: 'Outside the age bands',
      range: '',
      kind: 'OUTSIDE',
      lives: outside.lives,
      totalLives: outside.totalLives,
      totalCover: cover(outside.totalCover),
    });
  }
  if (unknown.totalLives > 0) {
    matrixRows.push({
      label: 'Age unknown',
      range: '',
      kind: 'UNKNOWN',
      lives: unknown.lives,
      totalLives: unknown.totalLives,
      totalCover: cover(unknown.totalCover),
    });
  }

  // C. Demographics; D. cover by relationship.
  const genders = Object.fromEntries(GHI_GENDERS.map((gender) => [gender, 0])) as Record<
    GhiGender,
    number
  >;
  const relationships = Object.fromEntries(GHI_RELATIONSHIPS.map((key) => [key, 0])) as Record<
    GhiRelationship,
    number
  >;
  const relationshipCover = new Map<GhiRelationship, bigint>();
  for (const member of members) {
    genders[member.gender] += 1;
    relationships[member.relationship] += 1;
    if (member.cover !== null && (!floater || member.relationship === 'SELF')) {
      relationshipCover.set(
        member.relationship,
        add(relationshipCover.get(member.relationship) ?? 0n, member.cover),
      );
    }
  }

  const problems: RfqSelectionSummary['problems'] = [];
  if (members.length === 0) {
    problems.push({ code: 'NO_MEMBERS', count: 0, message: 'The census has no members yet.' });
  }
  if (noCover > 0) {
    problems.push({
      code: 'NO_COVER',
      count: noCover,
      message: `${noCover} member${noCover === 1 ? ' has' : 's have'} no ${SELECTION_MEASURE_LABELS[measure].toLowerCase()} that can be worked out: complete the census or the Data Sheet.`,
    });
  }
  if (unknown.totalLives > 0) {
    problems.push({
      code: 'AGE_UNKNOWN',
      count: unknown.totalLives,
      message: `${unknown.totalLives} member${unknown.totalLives === 1 ? ' has' : 's have'} no valid date of birth, so no age band.`,
    });
  }
  if (outside.totalLives > 0) {
    problems.push({
      code: 'OUTSIDE_BANDS',
      count: outside.totalLives,
      message: `${outside.totalLives} member${outside.totalLives === 1 ? ' is' : 's are'} outside the age bands (${bands.length > 0 ? `${bandRangeText({ min: bands[0]!.min, max: bands[bands.length - 1]!.max })}` : 'none'}) on the reference date: choose age bands that cover them.`,
    });
  }

  const employees = relationships.SELF;
  const coverageRows = categories.map((amount, index) => ({
    amount,
    employees: byCategory[index]!.employees,
    lives: byCategory[index]!.lives,
    total: byCategory[index]!.total.toString(),
  }));
  const matrixLives = matrixRows.reduce((sum, row) => sum + row.totalLives, 0);
  const coveredLives = columnLives.reduce((sum, value) => sum + value, 0);
  const categoryTotal = byCategory.reduce((sum, row) => sum + row.total, 0n);
  const reconciled =
    matrixLives === members.length &&
    coveredLives + noCover === members.length &&
    coverageRows.reduce((sum, row) => sum + row.lives, 0) === coveredLives &&
    categoryTotal === total &&
    (floater || columnCover.reduce((sum, value) => sum + value, 0n) === total);

  return {
    product: input.product,
    measure,
    floater,
    referenceDate: input.referenceDate,
    bands: bands.map((band) => ({ ...band })),
    categories,
    coverage: {
      rows: coverageRows,
      employees,
      lives: members.length,
      total: total.toString(),
    },
    matrix: {
      rows: matrixRows,
      totals: {
        lives: columnLives,
        cover: columnCover.map((value) => cover(value)),
        totalLives: matrixLives,
        totalCover: cover(columnCover.reduce((sum, value) => sum + value, 0n)),
      },
    },
    genders,
    relationships,
    groups: {
      children: relationships.CHILD,
      parents: relationships.FATHER + relationships.MOTHER,
      parentsInLaw: relationships.FATHER_IN_LAW + relationships.MOTHER_IN_LAW,
    },
    byRelationship: GHI_RELATIONSHIPS.filter((relationship) => relationships[relationship] > 0).map(
      (relationship) => ({
        relationship,
        lives: relationships[relationship],
        total:
          floater && relationship !== 'SELF'
            ? null
            : (relationshipCover.get(relationship) ?? 0n).toString(),
      }),
    ),
    problems,
    reconciled,
  };
}

/** The problems as one sentence, for a refused RFQ or download. */
export function selectionProblemsText(summary: Pick<RfqSelectionSummary, 'problems'>): string {
  return summary.problems.map((problem) => problem.message).join(' ');
}

/** What the sheet is about (N7 E): company, case, product, period, date and configuration. */
export const SelectionSummaryHeaderSchema = z.object({
  company: z.string(),
  reference: z.string(),
  product: EbProductSchema,
  productName: z.string(),
  caseType: z.string(),
  policyPeriod: z.string(),
  /** Ages are completed years on this date. */
  referenceDate: z.iso.date(),
  generatedAt: z.iso.datetime(),
  ageBands: z.object({ name: z.string(), revision: z.number().int().nullable() }),
  plan: z.string().nullable(),
  /** The cover rules the amounts follow, one line each (product-specific). */
  rules: z.array(z.object({ label: z.string(), value: z.string() })),
  /** The census revision the figures were worked out from. */
  censusRevision: z.number().int(),
});
export type SelectionSummaryHeader = z.infer<typeof SelectionSummaryHeaderSchema>;

export const RfqSelectionSummaryResponseSchema = z.object({
  header: SelectionSummaryHeaderSchema,
  summary: RfqSelectionSummarySchema,
  /** From an RFQ version as generated (never recalculated), or the census as it is now. */
  source: z.enum(['CURRENT', 'RFQ_VERSION']),
  rfqVersion: z.number().int().nullable(),
});
export type RfqSelectionSummaryResponse = z.infer<typeof RfqSelectionSummaryResponseSchema>;

export const SelectionSummaryDocumentQuerySchema = z.strictObject({
  format: z.enum(['xlsx', 'pdf']).default('xlsx'),
});
export const CaseRfqVersionParamsSchema = z.strictObject({
  id: ObjectIdSchema,
  rfqId: ObjectIdSchema,
});
