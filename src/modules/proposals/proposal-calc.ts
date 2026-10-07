import {
  FIRE_GROUPS,
  FIRE_ITEMS,
  OTHER_SECTION_LABELS,
  type FireGroup,
  type FireItemKey,
  type OtherSection,
  type ProposalStage,
} from '../../shared/index.ts';
import { Decimal, ROUND_HALF_UP } from '../../lib/decimal.ts';

// The Data Sheet's arithmetic and completeness, kept pure so it is tested without a database.
// All amounts are whole rupees.

const ITEM_BY_KEY = new Map(FIRE_ITEMS.map((item) => [item.key, item]));

export interface FireItemValues {
  key: FireItemKey;
  sqFt: string | null;
  ratePerSqFt: string | null;
  amount: string | null;
}

/** An item's sum insured: the typed amount, else area × rate (to the rupee) for a measured item. */
export function itemSumInsured(item: FireItemValues): Decimal {
  if (item.amount !== null) return new Decimal(item.amount);
  const measured = ITEM_BY_KEY.get(item.key)?.measured ?? false;
  if (measured && item.sqFt !== null && item.ratePerSqFt !== null) {
    return new Decimal(item.sqFt).times(item.ratePerSqFt).toDecimalPlaces(0, ROUND_HALF_UP);
  }
  return new Decimal(0);
}

export function sumOf(values: readonly Decimal[]): Decimal {
  return values.reduce((total, value) => total.plus(value), new Decimal(0));
}

export interface LocationValues {
  name: string;
  fire: readonly FireItemValues[];
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
    const proposed1 = sumOf(
      locations.flatMap((location) =>
        location.fire
          .filter((item) => ITEM_BY_KEY.get(item.key)?.group === group)
          .map(itemSumInsured),
      ),
    );
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

export interface SheetValues {
  locations: readonly LocationValues[];
  fireProposed1: Decimal;
  sections: ReadonlyArray<{ code: OtherSection; included: boolean; proposed1: string | null }>;
}

/** What the Data Sheet still needs before an RFQ can go out; empty when it is complete. */
export function missingForRfq(sheet: SheetValues): string[] {
  const missing: string[] = [];
  if (sheet.locations.length === 0) missing.push('Add at least one risk location.');
  for (const location of sheet.locations) {
    if (sumOf(location.fire.map(itemSumInsured)).isZero()) {
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
      missing.push(
        `${OTHER_SECTION_LABELS[section.code]}: enter the Proposed 1 sum insured, or leave the section out.`,
      );
    }
  }
  return missing;
}

/** Where the proposal stands: sent once any insurer has the RFQ, else by the Data Sheet. */
export function stageOf(missing: readonly string[], anySent: boolean): ProposalStage {
  if (anySent) return 'RFQ_SENT';
  return missing.length === 0 ? 'DATA_SHEET' : 'DRAFT';
}
