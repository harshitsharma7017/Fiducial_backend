import {
  FIRE_GROUPS,
  FIRE_ITEM_HEADINGS,
  FIRE_ITEMS,
  HYPOTHECATION_LABEL,
  OPEN_STOCK_LABEL,
  formatIndianNumber,
  type FireGroup,
  type ProposalRecord,
} from '../../shared/index.ts';
import { Decimal } from '../../lib/decimal.ts';

/**
 * A row of the Data Sheet's "Fire & Burglary" table as the RFQ prints it under Burglary.
 * `heading`: items 1 and 5, with the sum of their sub-items; `item`: a numbered item; `sub`: a
 * sub-item or a building, indented under its item; `total`: a total; `text`: hypothecation or
 * stock in the open, with what the Data Sheet says.
 */
export interface BreakdownRow {
  kind: 'heading' | 'item' | 'sub' | 'total' | 'text';
  /** The Data Sheet's number ("1", "a"); null for a building or a total. */
  number: string | null;
  label: string;
  existing: string | null;
  proposed1: string | null;
  proposed2: string | null;
}

/** The template's and the built-in layout's wording of Burglary's contents row. */
export const BURGLARY_CONTENTS_LABEL = 'All the contents as per Fire section except building';
export const FIRE_TOTAL_ROW_LABEL = 'Total sum insured';
export const STOCK_TOTAL_LABEL = 'Total - All types of stock (6 and 6a)';

const isFilled = (value: string | null | undefined): value is string =>
  value !== null && value !== undefined && value.trim() !== '' && !new Decimal(value).isZero();
const sumOf = (values: readonly string[]) =>
  values.reduce((total, value) => total.plus(value), new Decimal(0));
const grouped = (value: string) => formatIndianNumber(value, value.includes('.') ? 2 : 0);
/** "(10,500 sq ft × ₹1,500 per sq ft)" when both are given. */
const measure = (sqFt: string | null, rate: string | null) =>
  sqFt && rate ? ` (${grouped(sqFt)} sq ft × ₹${grouped(rate)} per sq ft)` : '';

/**
 * The Data Sheet's "Fire & Burglary" table for the case, every item in its order and numbering
 * (1 to 7, with the buildings and sub-items under 1, 5 and 6), the total, then hypothecation and
 * stock in the open: printed under Burglary on the RFQ when its sum insured is the Fire contents
 * (a basis is chosen, C-3). Empty when Burglary is typed or not on the case.
 *
 * Option 1 is per item, from the locations (added up when the case has several; each building is
 * listed, with its location when there are several). Existing and Option 2 are entered per Fire
 * line, not per item, so they sit on the row that stands for the whole line: items 1 and 5 (the
 * headings), the single-item lines 2, 3, 4 and 7, and item 6, or a stock total when 6a has a
 * figure too. Area and rate are shown with a measured item when one location gives them.
 */
export function burglaryContentsLines(record: ProposalRecord): BreakdownRow[] {
  const burglary = record.sections.find((section) => section.code === 'BURGLARY');
  if (!burglary || burglary.basis === null) return [];
  const many = record.locations.length > 1;
  const placeName = (location: ProposalRecord['locations'][number], index: number) =>
    location.location?.name ?? `Location ${index + 1}`;
  const lineOf = new Map(record.fire.groups.map((line) => [line.group, line]));

  // Each item across the locations: its sum insured, and its area and rate when one location
  // gives them.
  const itemOf = (key: string) => {
    const entries = record.locations.flatMap((location) =>
      location.fire.filter((item) => item.key === key),
    );
    const given = entries.filter(
      (item) => isFilled(item.sumInsured) || Boolean(item.sqFt) || Boolean(item.ratePerSqFt),
    );
    const only = given.length === 1 ? given[0] : undefined;
    return {
      filled: given.length > 0,
      sumInsured: sumOf(entries.map((item) => item.sumInsured)).toFixed(),
      detail: only ? measure(only.sqFt, only.ratePerSqFt) : '',
    };
  };
  const buildings = record.locations.flatMap((location, index) =>
    location.buildings
      .map((building, number) => ({
        label: `${many ? `${placeName(location, index)}: ` : ''}${building.name?.trim() || `Building ${number + 1}`}${measure(building.sqFt, building.ratePerSqFt)}`,
        sumInsured: building.sumInsured,
      }))
      .filter((building) => isFilled(building.sumInsured)),
  );

  const rows: BreakdownRow[] = [];
  const blank = { existing: null, proposed1: null, proposed2: null };
  const lineFigures = (group: FireGroup, proposed1: string | null) => {
    const line = lineOf.get(group);
    return { existing: line?.existing ?? null, proposed1, proposed2: line?.proposed2 ?? null };
  };
  for (const group of FIRE_GROUPS) {
    const items = FIRE_ITEMS.filter((item) => item.group === group);
    const filledItems = items.filter((item) => itemOf(item.key).filled);
    const groupBuildings = group === 'BUILDING' ? buildings : [];
    const line = lineOf.get(group);
    const lineGiven = [line?.existing, line?.proposed2].some(isFilled);
    if (filledItems.length === 0 && groupBuildings.length === 0 && !lineGiven) continue;
    const heading = FIRE_ITEM_HEADINGS[group];
    if (heading) {
      // Items 1 and 5: the line's figures on the heading, the items beneath with their Option 1.
      rows.push({
        kind: 'heading',
        number: heading.number,
        label: heading.label,
        ...lineFigures(group, line?.proposed1 ?? null),
      });
      for (const building of groupBuildings) {
        rows.push({
          kind: 'sub',
          number: null,
          label: building.label,
          ...blank,
          proposed1: building.sumInsured,
        });
      }
      for (const item of filledItems) {
        const value = itemOf(item.key);
        rows.push({
          kind: 'sub',
          number: item.number.slice(-1),
          label: `${item.label}${value.detail}`,
          ...blank,
          proposed1: value.sumInsured,
        });
      }
      continue;
    }
    // The other lines: the line's own item (2, 3, 4, 6, 7) and its sub-items (6a).
    const [own, ...subs] = items;
    if (!own) continue;
    const shownSubs = subs.filter((item) => itemOf(item.key).filled);
    const ownValue = itemOf(own.key);
    const ownFigure = ownValue.filled ? ownValue.sumInsured : null;
    rows.push({
      kind: 'item',
      number: own.number,
      label: `${own.label}${ownValue.detail}`,
      ...(shownSubs.length === 0
        ? lineFigures(group, ownFigure)
        : { ...blank, proposed1: ownFigure }),
    });
    for (const item of shownSubs) {
      const value = itemOf(item.key);
      rows.push({
        kind: 'sub',
        number: item.number.slice(-1),
        label: `${item.label}${value.detail}`,
        ...blank,
        proposed1: value.sumInsured,
      });
    }
    // With 6a, the line's Existing and Option 2 are for 6 and 6a together: on a total of their own.
    if (shownSubs.length > 0 && lineGiven) {
      rows.push({
        kind: 'total',
        number: null,
        label: STOCK_TOTAL_LABEL,
        ...lineFigures(group, line?.proposed1 ?? null),
      });
    }
  }
  if (rows.length === 0) return [];
  rows.push({
    kind: 'total',
    number: null,
    label: FIRE_TOTAL_ROW_LABEL,
    existing: record.fire.existing,
    proposed1: record.fire.proposed1,
    proposed2: record.fire.proposed2,
  });
  // Hypothecation and stock in the open, numbered 1 and 2 as on the Data Sheet.
  const said = (pick: (location: ProposalRecord['locations'][number]) => string | null) =>
    record.locations
      .flatMap((location, index) => {
        const text = pick(location)?.trim();
        return text ? [many ? `${placeName(location, index)}: ${text}` : text] : [];
      })
      .join('; ');
  const extras = [
    [HYPOTHECATION_LABEL, said((location) => location.hypothecation)],
    [OPEN_STOCK_LABEL, said((location) => location.openStock)],
  ].filter(([, text]) => text);
  extras.forEach(([label, text], index) => {
    rows.push({ kind: 'text', number: String(index + 1), label: `${label}: ${text}`, ...blank });
  });
  return rows;
}
