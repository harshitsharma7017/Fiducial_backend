import {
  BURGLARY_BASIS_PERCENT,
  FIRE_GROUPS,
  FIRE_ITEMS,
  OTHER_SECTION_LABELS,
  PROPOSAL_STAGES,
  SECTION_LINES,
  SUM_INSURED_LINES,
  isAnnexureSection,
  type BurglaryBasis,
  type FireGroup,
  type FireItemKey,
  type OtherSection,
  type ProposalStage,
} from '../../shared/index.ts';
import { Decimal } from '../../lib/decimal.ts';

// The Data Sheet's arithmetic and completeness, kept pure so it is tested without a database.
// As in the client's Excel: area × rate is exact (it may carry paise) and totals add the exact
// amounts; only display rounds to the rupee.

const ITEM_BY_KEY = new Map(FIRE_ITEMS.map((item) => [item.key, item]));

export interface FireItemValues {
  key: FireItemKey;
  sqFt: string | null;
  ratePerSqFt: string | null;
  amount: string | null;
}

/** D1: a building's figures; its sum insured is the typed amount, else area × rate (exact). */
export interface BuildingValues {
  sqFt: string | null;
  ratePerSqFt: string | null;
  amount: string | null;
}

/** An item's sum insured: the typed amount, else area × rate (exact) for a measured item. */
export function itemSumInsured(item: FireItemValues): Decimal {
  if (item.amount !== null) return new Decimal(item.amount);
  const measured = ITEM_BY_KEY.get(item.key)?.measured ?? false;
  if (measured && item.sqFt !== null && item.ratePerSqFt !== null) {
    return new Decimal(item.sqFt).times(item.ratePerSqFt);
  }
  return new Decimal(0);
}

/** A building's sum insured: the typed amount, else area × rate (exact), like a measured item. */
export function buildingSumInsured(building: BuildingValues): Decimal {
  if (building.amount !== null) return new Decimal(building.amount);
  if (building.sqFt !== null && building.ratePerSqFt !== null) {
    return new Decimal(building.sqFt).times(building.ratePerSqFt);
  }
  return new Decimal(0);
}

export function sumOf(values: readonly Decimal[]): Decimal {
  return values.reduce((total, value) => total.plus(value), new Decimal(0));
}

export interface LocationValues {
  name: string;
  /** D1: the location's buildings, all in the Fire BUILDING line. */
  buildings?: readonly BuildingValues[];
  fire: readonly FireItemValues[];
}

/** The total sum insured of a location's buildings (D1). */
export function buildingsTotal(location: LocationValues): Decimal {
  return sumOf((location.buildings ?? []).map(buildingSumInsured));
}

export interface FireTotals {
  groups: Array<{ group: FireGroup; proposed1: Decimal; proposed2: Decimal | null }>;
  proposed1: Decimal;
  /** Null when no line has a second option. */
  proposed2: Decimal | null;
}

/**
 * The RFQ's Fire lines: Option 1 adds up every location's items in the line; Option 2 is the
 * amount entered for the line, if any.
 */
export function fireTotals(
  locations: readonly LocationValues[],
  option2: ReadonlyMap<FireGroup, string | null>,
): FireTotals {
  const groups = FIRE_GROUPS.map((group) => {
    const items = sumOf(
      locations.flatMap((location) =>
        location.fire
          .filter((item) => ITEM_BY_KEY.get(item.key)?.group === group)
          .map(itemSumInsured),
      ),
    );
    // D1: buildings add to the BUILDING line, alongside the fixed civil-structure sub-items.
    const buildings = group === 'BUILDING' ? sumOf(locations.map(buildingsTotal)) : new Decimal(0);
    const proposed1 = items.plus(buildings);
    const second = option2.get(group) ?? null;
    return { group, proposed1, proposed2: second === null ? null : new Decimal(second) };
  });
  const seconds = groups.flatMap((line) => (line.proposed2 === null ? [] : [line.proposed2]));
  return {
    groups,
    proposed1: sumOf(groups.map((line) => line.proposed1)),
    proposed2: seconds.length > 0 ? sumOf(seconds) : null,
  };
}

/**
 * The contents Burglary covers (C-3, D3). The client confirmed **Option A**:
 *
 *   Burglary Sum Insured = Total Fire Sum Insured − Building Sum Insured
 *
 * where "Building Sum Insured" is the dynamic buildings only (D1). The civil-structure sub-items of
 * the Building line — Compound wall, False ceiling and **Plinth & Foundation** — are NOT deducted;
 * they stay in the Burglary base. So contents = every Fire group's sum insured minus just the
 * buildings. Option 2 does the same for the second figure when one is entered (buildings never
 * carry an Option 2, so only the typed line figures contribute).
 *
 * `buildingsTotal` is the aggregate sum insured of every building across every location, passed in
 * so the deduction is applied exactly once.
 */
export function contentsTotals(
  totals: FireTotals,
  buildingsTotal: Decimal,
): {
  proposed1: Decimal;
  proposed2: Decimal | null;
} {
  // Option A: Total Fire minus the buildings. Compound wall / False ceiling / Plinth & Foundation
  // (the Building group's fixed civil-structure items) remain in the Burglary base.
  const proposed1 = totals.proposed1.minus(buildingsTotal);
  // Option 2 is entered per Fire line, not per item: the BUILDING line's Option 2 is one typed
  // figure that represents the whole building line (buildings included) and cannot be split into a
  // buildings-only part, so it stays excluded from the Burglary base — the same as before D3.
  // Burglary Option 2 therefore sums the second figures of the non-building lines only.
  const seconds = totals.groups.flatMap((line) =>
    line.group !== 'BUILDING' && line.proposed2 !== null ? [line.proposed2] : [],
  );
  return {
    proposed1,
    proposed2: seconds.length > 0 ? sumOf(seconds) : null,
  };
}

/** The sum insured on a basis: 100%, or the first-loss share (exact; shown to the rupee). */
export function onBasis(value: Decimal | null, basis: BurglaryBasis): Decimal | null {
  return value === null ? null : value.times(BURGLARY_BASIS_PERCENT[basis]).dividedBy(100);
}

export interface SheetValues {
  locations: readonly LocationValues[];
  fireProposed1: Decimal;
  sections: ReadonlyArray<{
    code: OtherSection;
    /** The master's wording; the built-in label when not given. */
    name?: string;
    included: boolean;
    proposed1: string | null;
    basis?: BurglaryBasis | null;
  }>;
  /** The product (C-1), when there is one. */
  product?: {
    name: string;
    source: 'SUGGESTED' | 'CHOSEN' | 'OVERRIDE';
    reason: string | null;
  } | null;
}

/** The lines a section's sum insured is made of, by their Data Sheet labels. */
function sumInsuredLineLabels(code: OtherSection): string {
  const lines: readonly { key: string; label: string }[] =
    SECTION_LINES[code as keyof typeof SECTION_LINES] ?? [];
  return (SUM_INSURED_LINES[code] ?? [])
    .map((key) => lines.find((line) => line.key === key)?.label ?? key)
    .join(' or ');
}

/** What the Data Sheet still needs before an RFQ can go out; empty when it is complete. */
export function missingForRfq(sheet: SheetValues): string[] {
  const missing: string[] = [];
  if (sheet.locations.length === 0) missing.push('Add at least one risk location.');
  for (const location of sheet.locations) {
    const items = sumOf(location.fire.map(itemSumInsured));
    if (items.plus(buildingsTotal(location)).isZero()) {
      missing.push(`Enter the Fire sums insured for ${location.name}.`);
    }
  }
  if (sheet.locations.length > 0 && sheet.fireProposed1.isZero() && missing.length === 0) {
    missing.push('Enter the Fire sums insured.');
  }
  for (const section of sheet.sections) {
    if (
      section.included &&
      (section.proposed1 === null || new Decimal(section.proposed1).isZero())
    ) {
      const name = section.name ?? OTHER_SECTION_LABELS[section.code];
      missing.push(
        isAnnexureSection(section.code)
          ? `${name}: add its annexure items, or leave the section out.`
          : section.code === 'BURGLARY' && section.basis
            ? `${name}: its sum insured is the Fire contents (all items but buildings); enter them, or leave the section out.`
            : SUM_INSURED_LINES[section.code]
              ? `${name}: enter ${sumInsuredLineLabels(section.code)}, or leave the section out.`
              : `${name}: enter the Proposed 1 sum insured, or leave the section out.`,
      );
    }
  }
  // A product outside the suggestion needs the reason (the ranges may change after it was chosen).
  if (sheet.product?.source === 'OVERRIDE' && !sheet.product.reason) {
    missing.push(
      `Policy: ${sheet.product.name} is not suggested for this Fire sum insured; give the reason or choose a suggested policy.`,
    );
  }
  return missing;
}

/**
 * Where the case stands: the stage the team set (Quotes Received onwards, or Closed); else RFQ
 * Sent once any insurer has the RFQ; else Data Sheet when it is complete; else Draft.
 */
export function stageOf(
  missing: readonly string[],
  anySent: boolean,
  override: ProposalStage | null = null,
): ProposalStage {
  if (override) return override;
  if (anySent) return 'RFQ_SENT';
  return missing.length === 0 ? 'DATA_SHEET' : 'DRAFT';
}

/** The stage the team can move to next: from RFQ Sent up to Placed, one step at a time. */
export function nextStageOf(stage: ProposalStage): ProposalStage | null {
  const order = PROPOSAL_STAGES.indexOf(stage);
  if (order < PROPOSAL_STAGES.indexOf('RFQ_SENT') || order >= PROPOSAL_STAGES.indexOf('PLACED')) {
    return null;
  }
  return PROPOSAL_STAGES[order + 1] ?? null;
}
