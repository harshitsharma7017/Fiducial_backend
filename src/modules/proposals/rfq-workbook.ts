import {
  ADDON_LIST_LABELS,
  BURGLARY_BASIS_LABELS,
  DEFAULT_FIRE_COVERS,
  FIRE_GROUP_LABELS,
  ANNEXURE_SECTIONS,
  FIRE_ITEM_HEADINGS,
  FIRE_ITEMS,
  HYPOTHECATION_LABEL,
  OPEN_STOCK_LABEL,
  RISK_DETAIL_FIELDS,
  SECTION_LINES,
  SUM_INSURED_LINE,
  annexureColumnLabel,
  isAnnexureSection,
  isSectionShown,
  rfqAttributionRows,
  type AnnexureColumn,
  type AnnexureSection,
  type RfqAttribution,
  type SectionWithLines,
  formatDate,
  productRangeText,
  quoteOptionsOf,
  type CatalogItem,
  type Cover,
  type ProposalRecord,
} from '../../shared/index.ts';
import ExcelJS from 'exceljs';
import type { ClientDoc } from '../clients/client.model.ts';
import {
  COVER_TICK,
  COVER_TICK_ARGB,
  SECTION_HEADING_FILL_ARGB,
  TABLE_HEADER_FILL_ARGB,
} from '../documents/document-theme.ts';
import { cellText, frameSheet, isCovered, restyle } from '../documents/excel-template.ts';

// The RFQ in the client's layout (document 07): premium details for the insurer to fill in,
// the schedule, Fire by location, risk details and claim details. Amounts are whole rupees.
// Products, section add-ons and notes come from the product and cover masters; until those are
// uploaded, the wording of the client's RFQ format is used.

/** The masters the RFQ prints from. */
export interface RfqMasters {
  gstRatePercent: string;
  products: readonly CatalogItem<'products'>[];
  sections: readonly CatalogItem<'sections'>[];
  notes: readonly CatalogItem<'notes'>[];
  /** The clause library; without it the template's own clauses are kept. */
  clauses?: readonly CatalogItem<'clauses'>[];
}

const DEFAULT_PRODUCT_LINES = [
  'Upto 5 Cr sum insured: Bharat Sookshma Udyam Suraksha (BSUS)',
  'Above 5 Cr & Upto 50 Cr sum insured: Bharat Laghu Udyam Suraksha (BLUS)',
  'Above 50 Cr sum insured: Standard Fire & Special Perils Policy (SFSP)',
  'Above 5 Cr sum insured: Property All Risk (PAR)',
];

/** Indian digit grouping (1,23,45,678) for whole rupees. */
export const RUPEES = '[>=10000000]##\\,##\\,##\\,##0;[>=100000]##\\,##\\,##0;##,##0';
// The header tint is the shared document theme's table-header colour (one source for Q2), so the
// workbook-derived PDFs and the directly-drawn Coverage Confirmation Letter match.
const HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: TABLE_HEADER_FILL_ARGB },
};

const amount = (value: string | null) => (value === null ? null : Number(value));

/** A figure worth printing: documents leave out what is blank or zero. */
export const filled = (value: string | null | undefined): value is string =>
  value !== null && value !== undefined && value.trim() !== '' && Number(value) !== 0;

// Headings are dark and sub-headings light (client review, 28 Oct 2026): the title and the column
// headings are white on navy; a section heading within a table is navy on the light-blue tint.
const HEADING_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: SECTION_HEADING_FILL_ARGB },
};
const WHITE = { argb: 'FFFFFFFF' };
const NAVY = { argb: SECTION_HEADING_FILL_ARGB };

/** A sub-heading row across the table: navy bold text on the light tint, centred. */
export function sectionHeading(sheet: ExcelJS.Worksheet, text: string, span: number) {
  const row = sheet.addRow([text]);
  if (span > 1) sheet.mergeCells(row.number, 1, row.number, span);
  const cell = row.getCell(1);
  cell.fill = HEADER_FILL;
  cell.font = { bold: true, color: NAVY };
  cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  row.height = 18;
  return row;
}

/** The sheet's title: a larger heading, white on navy. */
export function title(sheet: ExcelJS.Worksheet, text: string, span: number) {
  const row = sectionHeading(sheet, text, span);
  const cell = row.getCell(1);
  cell.fill = HEADING_FILL;
  cell.font = { bold: true, size: 12, color: WHITE };
  row.height = 22;
}

/** A table's column headings: white bold text on navy, centred. */
export function header(sheet: ExcelJS.Worksheet, values: (string | null)[]) {
  const row = sheet.addRow(values);
  row.font = { bold: true, color: WHITE };
  row.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.fill = HEADING_FILL;
  });
  return row;
}

const isHeaderRow = (row: ExcelJS.Row) => {
  const { fill, isMerged } = row.getCell(1);
  return fill?.type === 'pattern' && fill.fgColor?.argb === SECTION_HEADING_FILL_ARGB && !isMerged;
};

const isFigure = (cell: ExcelJS.Cell) =>
  typeof cell.value === 'number' ||
  (typeof cell.value === 'object' && cell.value !== null && 'formula' in cell.value) ||
  cellText(cell).trim() === COVER_TICK;

/**
 * Centres a sheet's tables (client review, 28 Oct 2026): the S No column, and every column holding
 * figures or ticks, so amounts and ticks line up down each column. Text columns (a description, a
 * section name) stay left, as long lines read better so. Each table runs from its column headings
 * to the next; rows above the first (the insured's details) are left as they are.
 */
export function centreTables(sheet: ExcelJS.Worksheet, columns: number): void {
  const tables: { from: number; to: number; numbered: boolean }[] = [];
  sheet.eachRow((row) => {
    if (isHeaderRow(row)) {
      const last = tables.at(-1);
      if (last) last.to = row.number - 1;
      tables.push({
        from: row.number + 1,
        to: sheet.rowCount,
        numbered: cellText(row.getCell(1)).trim() === 'S No',
      });
    }
  });
  for (const table of tables) {
    const centred = new Set<number>(table.numbered ? [1] : []);
    for (let number = table.from; number <= table.to; number += 1) {
      for (let column = 1; column <= columns; column += 1) {
        if (isFigure(sheet.getCell(number, column))) centred.add(column);
      }
    }
    for (let number = table.from; number <= table.to; number += 1) {
      for (const column of centred) {
        const cell = sheet.getCell(number, column);
        // A heading or line of text merged across columns (a recommendation, a remark) keeps its
        // own alignment; a merged total is still a figure.
        if (isCovered(cell) || cellText(cell) === '' || (cell.isMerged && !isFigure(cell))) {
          continue;
        }
        restyle(cell, {
          alignment: { ...cell.alignment, horizontal: 'center', vertical: 'middle' },
        });
      }
    }
  }
}

/** A label and its value; nothing is printed when the value is blank. */
export function labelled(sheet: ExcelJS.Worksheet, label: string, value: string, span: number) {
  if (!value.trim()) return;
  const row = sheet.addRow([label, value]);
  row.getCell(1).font = { bold: true };
  row.getCell(2).alignment = { wrapText: true, vertical: 'top' };
  if (span > 2) sheet.mergeCells(row.number, 2, row.number, span);
}

export function money(row: ExcelJS.Row, columns: number[]) {
  for (const column of columns) row.getCell(column).numFmt = RUPEES;
}

function addressLine(location: NonNullable<ProposalRecord['locations'][number]['location']>) {
  const { address } = location;
  return [address.line1, address.line2, address.city, `${address.state} ${address.pincode}`]
    .filter(Boolean)
    .join(', ');
}

function premiumDetails(
  workbook: ExcelJS.Workbook,
  record: ProposalRecord,
  gstRate: number,
  heading?: string,
  attribution?: RfqAttribution,
) {
  const sheet = workbook.addWorksheet('premium details');
  sheet.columns = [{ width: 34 }, { width: 20 }, { width: 22 }, { width: 22 }];
  const renewal = record.type === 'EXISTING';
  title(
    sheet,
    heading ??
      (renewal
        ? 'RFQ FOR RENEWAL — PROPERTY INSURANCE'
        : 'RFQ FOR NEW BUSINESS — PROPERTY INSURANCE'),
    4,
  );
  labelled(sheet, 'Insured Name:', record.client.name, 4);
  labelled(sheet, 'Reference:', record.reference, 4);
  // A2: who approved the RFQ. Reflects the actual records, not whoever exports it.
  if (attribution) {
    for (const [label, value] of rfqAttributionRows(attribution)) {
      labelled(sheet, `${label}:`, value, 4);
    }
  }
  if (renewal && record.existing) {
    const existing = record.existing;
    labelled(
      sheet,
      'Existing policy:',
      `${existing.policyNumber ? `${existing.policyNumber} with ` : ''}${existing.insurer}`,
      4,
    );
    const premium = record.existingPolicy?.totalPremium ?? null;
    if (premium) {
      const row = sheet.addRow(['Existing premium:', amount(premium)]);
      row.getCell(1).font = { bold: true };
      money(row, [2]);
    }
  }
  labelled(sheet, 'Quotes needed by:', formatDate(record.dueDate), 4);
  const asked = quoteOptionsOf(record);

  for (const [option, number] of [
    ['P1', 1],
    ['P2', 2],
    ['P3', 3],
  ] as const) {
    if (!asked.includes(option)) continue;
    sheet.addRow([]);
    sectionHeading(sheet, `Quote Option ${number}: For Proposed Sum Insured Option ${number}`, 4);
    header(sheet, [
      'Coverage Section',
      'Sum Insured',
      'Premium with terrorism',
      'Premium without terrorism',
    ]);
    const first = sheet.rowCount + 1;
    const fire =
      option === 'P1'
        ? record.fire.proposed1
        : option === 'P2'
          ? record.fire.proposed2
          : record.fire.proposed3;
    if (filled(fire)) money(sheet.addRow(['Fire', amount(fire)]), [2, 3, 4]);
    // B5: only sections marked required appear; Not-required ones are omitted entirely, and so
    // is a section with no sum insured for this option. Option 3 is Fire's: the other sections
    // are quoted at their Option 1 figures in it.
    for (const section of record.sections.filter(isSectionShown)) {
      const value = option === 'P2' ? section.proposed2 : section.proposed1;
      if (!filled(value)) continue;
      const row = sheet.addRow([section.name, amount(value)]);
      money(row, [2, 3, 4]);
    }
    terrorismTotals(sheet, { first, last: sheet.rowCount }, gstRate);
  }
}

/**
 * The totals of a quote block as the client reads them (27 Oct 2026): "With Terrorism" then
 * "Without Terrorism", each with its Net Value, GST and Total across the two premium columns,
 * as formulas over the premiums the insurer fills in.
 */
function terrorismTotals(
  sheet: ExcelJS.Worksheet,
  sections: { first: number; last: number },
  gstRate: number,
) {
  for (const [label, column] of [
    ['With Terrorism', 'C'],
    ['Without Terrorism', 'D'],
  ] as const) {
    const heading = sheet.addRow([label]);
    sheet.mergeCells(heading.number, 1, heading.number, 4);
    heading.font = { bold: true };
    heading.getCell(1).fill = HEADER_FILL;
    const at = sheet.rowCount + 1;
    const rows = [
      sheet.addRow([
        'Net Value',
        null,
        { formula: `SUM(${column}${sections.first}:${column}${sections.last})` },
      ]),
      sheet.addRow([`GST ${gstRate}%`, null, { formula: `ROUND(C${at}*${gstRate / 100},2)` }]),
      sheet.addRow(['Total', null, { formula: `C${at}+C${at + 1}` }]),
    ];
    for (const row of rows) {
      sheet.mergeCells(row.number, 3, row.number, 4);
      money(row, [3]);
    }
    rows[2]!.font = { bold: true };
  }
}

export function schedule(
  workbook: ExcelJS.Workbook,
  record: ProposalRecord,
  client: ClientDoc,
  masters: RfqMasters,
  document: 'RFQ' | 'QCR' = 'RFQ',
) {
  const sectionMaster = new Map(masters.sections.map((section) => [section.code, section]));
  // The client format's "Existing Sum Insured" column, for the policy in force (last year's on a
  // renewal, the client's current policy on new business); left out when there is none.
  const withExisting = record.existing !== null;
  const existing = record.existing;
  const copy = record.existingPolicy;
  // Option 3 is a Fire figure: its column is there only when a Fire line has one.
  const withOption3 = record.fire.proposed3 !== null;
  const span = (withExisting ? 5 : 4) + (withOption3 ? 1 : 0);
  const amountColumns = Array.from({ length: span - 2 }, (_, index) => index + 3);
  const figures = (
    existingValue: string | null | undefined,
    p1: string | null | undefined,
    p2: string | null | undefined,
    p3: string | null | undefined = null,
  ) => [
    ...(withExisting ? [amount(existingValue ?? null)] : []),
    amount(p1 ?? null),
    amount(p2 ?? null),
    ...(withOption3 ? [amount(p3 ?? null)] : []),
  ];
  // The S No column is centred (client review, 27 Oct 2026).
  const numbered = (row: ExcelJS.Row) => {
    row.getCell(1).alignment = { horizontal: 'center', vertical: 'top' };
    return row;
  };
  // C-6: the add-on covers asked for, a green tick in each option column; those not required, or
  // not answered, are left out.
  const covers = (list: readonly Cover[], option2: boolean, option3 = false) => {
    list
      .filter((cover) => cover.required === true)
      .forEach((cover, index) => {
        const row = sheet.addRow([
          index === 0 ? 'Addon coverages' : null,
          cover.name,
          ...(withExisting ? [null] : []),
          COVER_TICK,
          option2 ? COVER_TICK : null,
          ...(withOption3 ? [option3 ? COVER_TICK : null] : []),
        ]);
        row.eachCell((cell) => {
          if (cell.value !== COVER_TICK) return;
          cell.font = { bold: true, color: { argb: COVER_TICK_ARGB } };
          cell.alignment = { horizontal: 'center' };
        });
      });
  };
  const sheet = workbook.addWorksheet('schedule');
  // The description is narrower than the client's sheet so the PDF keeps a readable size.
  sheet.columns = [
    { width: 16 },
    { width: 52 },
    { width: 20 },
    { width: 20 },
    { width: 20 },
    { width: 20 },
  ].slice(0, span);
  if (withExisting && existing?.policyNumber) {
    sheet.addRow([`Policy No: ${existing.policyNumber}`]).font = { bold: true };
  }
  title(
    sheet,
    document === 'QCR'
      ? 'QUOTE COMPARISON - SCHEDULE FOR PROPERTY INSURANCE'
      : 'RFQ - SCHEDULE FOR PROPERTY INSURANCE',
    span,
  );
  labelled(sheet, 'Insured Name', client.name, span);
  labelled(sheet, 'Insured GST No', client.gstin ?? '', span);
  const { address } = client;
  labelled(
    sheet,
    'Communication Address',
    [address.line1, address.line2, address.city, `${address.state} ${address.pincode}`]
      .filter(Boolean)
      .join(', '),
    span,
  );
  record.locations.forEach((location, index) => {
    const text = location.location
      ? `${location.location.name}: ${addressLine(location.location)}`
      : location.locationId;
    labelled(sheet, index === 0 ? 'Risk Location' : '', text, span);
  });
  labelled(
    sheet,
    'Policy Period',
    record.policyStart && record.policyEnd
      ? `${formatDate(record.policyStart)} to ${formatDate(record.policyEnd)}`
      : record.policyStart
        ? `For 1 year from ${formatDate(record.policyStart)}`
        : 'For 1 year from date of payment',
    span,
  );
  if (withExisting && existing) {
    labelled(
      sheet,
      'Existing Policy',
      [
        `${existing.policyNumber ? `${existing.policyNumber} with ` : ''}${existing.insurer}`,
        copy?.periodStart && copy.periodEnd
          ? `${formatDate(copy.periodStart)} to ${formatDate(copy.periodEnd)}`
          : null,
        copy?.totalPremium ? `premium ${copy.totalPremium}` : null,
      ]
        .filter(Boolean)
        .join(', '),
      span,
    );
  }
  labelled(sheet, 'Nature of business', client.natureOfBusiness, span);
  labelled(
    sheet,
    'Occupancy',
    `${client.occupancy.tacCode} — ${client.occupancy.description}`,
    span,
  );

  sheet.addRow([]);
  header(sheet, [
    'S No',
    'Description',
    ...(withExisting ? ['Existing Sum Insured'] : []),
    'Proposed Sum Insured - Option 1',
    'Proposed Sum Insured - Option 2',
    ...(withOption3 ? ['Proposed Sum Insured - Option 3'] : []),
  ]);
  sectionHeading(sheet, 'Fire & Allied Perils', span);
  // Lines with no figure are left out; the others are numbered in order.
  let fireNumber = 0;
  for (const line of record.fire.groups) {
    if (![line.existing, line.proposed1, line.proposed2, line.proposed3].some(filled)) continue;
    fireNumber += 1;
    const row = numbered(
      sheet.addRow([
        fireNumber,
        FIRE_GROUP_LABELS[line.group],
        ...figures(line.existing, line.proposed1, line.proposed2, line.proposed3),
      ]),
    );
    row.getCell(2).alignment = { wrapText: true };
    money(row, amountColumns);
  }
  const total = sheet.addRow([
    null,
    'Total Sum Insured - Fire & Allied Perils',
    ...figures(
      record.fire.existing,
      record.fire.proposed1,
      record.fire.proposed2,
      record.fire.proposed3,
    ),
  ]);
  total.font = { bold: true };
  money(total, amountColumns);
  const fire = sectionMaster.get('FIRE');
  covers(
    record.fire.covers.length > 0
      ? record.fire.covers
      : (fire ? fire.addons : DEFAULT_FIRE_COVERS).map((name) => ({ name, required: null })),
    record.fire.proposed2 !== null,
    withOption3,
  );
  // C-1: the product the case chose, else every product with its range.
  const decided = record.product && record.product.source !== 'SUGGESTED' ? record.product : null;
  const products = masters.products.filter((product) => product.active);
  const chosenProduct = decided
    ? masters.products.find((product) => product.code === decided.code)
    : undefined;
  const productLines = decided
    ? [
        chosenProduct
          ? `${productRangeText(chosenProduct)} sum insured: ${chosenProduct.name}`
          : decided.name,
      ]
    : products.length > 0
      ? products.map((product) => `${productRangeText(product)} sum insured: ${product.name}`)
      : DEFAULT_PRODUCT_LINES;
  productLines.forEach((line, index) => {
    sheet.addRow([index === 0 ? (decided ? 'Policy' : 'Policy to be chosen') : null, line]);
  });
  if (record.addons.length > 0) {
    sheet.addRow(['Additional Addon cover', 'Details as per attached list of addons']);
  }
  for (const location of record.locations) {
    const name = location.location?.name ?? location.locationId;
    if (location.hypothecation)
      sheet.addRow(['Hypothecation', `${name}: ${location.hypothecation}`]);
    if (location.openStock)
      sheet.addRow(['Stock kept at open space', `${name}: ${location.openStock}`]);
  }

  const included = record.sections.filter(isSectionShown);
  for (const section of included) {
    // The Data Sheet's lines for the section (D-4), then its sum insured; blank lines are left
    // out, and so is a section with nothing in it.
    const lines = (SECTION_LINES[section.code as SectionWithLines] ?? []).filter(
      (line) =>
        SUM_INSURED_LINE[section.code] !== line.key &&
        [section.existingLines[line.key], section.lines[line.key], section.lines2[line.key]].some(
          filled,
        ),
    );
    const annexureItems = isAnnexureSection(section.code) ? section.annexure.length : 0;
    const sumInsured =
      [section.existing, section.proposed1, section.proposed2].some(filled) || annexureItems > 0;
    const asked = section.covers.some((cover) => cover.required === true);
    if (lines.length === 0 && !sumInsured && !asked) continue;
    sheet.addRow([]);
    sectionHeading(sheet, section.name, span);
    let number = 1;
    for (const line of lines) {
      const row = numbered(
        sheet.addRow([
          number,
          line.label,
          ...figures(
            section.existingLines[line.key],
            section.lines[line.key],
            section.lines2[line.key],
          ),
        ]),
      );
      if (line.kind === 'rupees') money(row, amountColumns);
      number += 1;
    }
    if (sumInsured) {
      const sumInsuredLine = SECTION_LINES[section.code as SectionWithLines]?.find(
        (line) => line.key === SUM_INSURED_LINE[section.code],
      );
      money(
        numbered(
          sheet.addRow([
            number,
            isAnnexureSection(section.code)
              ? `As per Annexure${annexureItems > 0 ? ` (${annexureItems} ${annexureItems === 1 ? 'item' : 'items'})` : ''}`
              : (sumInsuredLine?.label ?? 'Sum insured'),
            ...figures(section.existing, section.proposed1, section.proposed2),
          ]),
        ),
        amountColumns,
      );
    }
    // C-3: the sum insured on the chosen basis (100% or first loss).
    if (
      section.basis &&
      section.basisAmounts &&
      [section.basisAmounts.proposed1, section.basisAmounts.proposed2].some(filled)
    ) {
      money(
        sheet.addRow([
          null,
          `Total Sum Insured - Burglary on ${BURGLARY_BASIS_LABELS[section.basis]}`,
          ...figures(null, section.basisAmounts.proposed1, section.basisAmounts.proposed2),
        ]),
        amountColumns,
      );
    }
    covers(section.covers, section.proposed2 !== null);
  }
  // B5: the "Not required: …" line is removed; Not-required sections are simply omitted. The
  // notes are not on the schedule (client review, 27 Oct 2026): the RFQ has none, the QCR shows
  // them on its premium comparison.
}

/**
 * Fire & Burglary per location in the client's Data Sheet layout: the 7 numbered items with their
 * sub-items (headings 1, 2 and 5 show the sum of theirs), sq ft and rate for buildings, the total,
 * then hypothecation and stock in open space.
 */
function fireByLocation(workbook: ExcelJS.Workbook, record: ProposalRecord) {
  const sheet = workbook.addWorksheet('fire by location');
  sheet.columns = [{ width: 6 }, { width: 70 }, { width: 14 }, { width: 18 }, { width: 22 }];
  title(sheet, 'FIRE & BURGLARY — SUM INSURED BY LOCATION (OPTION 1)', 5);
  for (const location of record.locations) {
    sheet.addRow([]);
    const place = location.location;
    sectionHeading(sheet, place?.name ?? location.locationId, 5);
    if (place) {
      sheet.addRow([addressLine(place)]);
      sheet.addRow([
        [
          place.district ? `District ${place.district}` : null,
          place.eqZone ? `EQ zone ${place.eqZone}` : null,
          `Occupancy ${place.occupancy.tacCode} — ${place.occupancy.description}`,
        ]
          .filter(Boolean)
          .join(' · '),
      ]);
    }
    header(sheet, [
      'S No',
      'Description',
      'Sq. Feet (total builtup area)',
      'Rate / sq ft (construction cost per sq ft)',
      'Sum Insured',
    ]);
    const saved = new Map(location.fire.map((item) => [item.key, item]));
    // Items with no area, rate or sum insured are left out, and so is a heading with nothing under it.
    const itemFilled = (key: string) => {
      const values = saved.get(key as never);
      return Boolean(
        values &&
        [values.sqFt, values.ratePerSqFt, values.sumInsured].some((value) => filled(value)),
      );
    };
    const buildings = location.buildings.filter((building) => filled(building.sumInsured));
    const headed = new Set<string>();
    for (const item of FIRE_ITEMS) {
      const groupFilled =
        FIRE_ITEMS.some((other) => other.group === item.group && itemFilled(other.key)) ||
        (item.group === 'BUILDING' && buildings.length > 0);
      if (!groupFilled) continue;
      const heading = FIRE_ITEM_HEADINGS[item.group];
      if (heading && !headed.has(item.group)) {
        headed.add(item.group);
        // D1: the Building heading's subtotal is its civil-structure sub-items plus the buildings.
        const itemsSubtotal = FIRE_ITEMS.filter((other) => other.group === item.group)
          .map((other) => saved.get(other.key)?.sumInsured ?? '0')
          .reduce((total, value) => total + Number(value), 0);
        const buildingsSubtotal = item.group === 'BUILDING' ? Number(location.buildingsTotal) : 0;
        const subtotal = itemsSubtotal + buildingsSubtotal;
        const row = sheet.addRow([heading.number, heading.label, null, null, subtotal || null]);
        row.font = { bold: true };
        row.getCell(1).alignment = { horizontal: 'center' };
        row.getCell(2).alignment = { wrapText: true };
        money(row, [5]);
        // D1: list each building under the Building heading, with its area, rate and sum insured.
        if (item.group === 'BUILDING') {
          buildings.forEach((building, index) => {
            const buildingRow = sheet.addRow([
              null,
              building.name ?? `Building ${index + 1}`,
              building.sqFt == null ? null : Number(building.sqFt),
              amount(building.ratePerSqFt),
              amount(building.sumInsured) || null,
            ]);
            buildingRow.getCell(2).alignment = { wrapText: true, indent: 2 };
            money(buildingRow, [4, 5]);
          });
        }
      }
      // An item's own line stays, without figures, when only its sub-items are filled (6 over 6a).
      const parent = heading === undefined && item.number.length === 1;
      if (!itemFilled(item.key) && !parent) continue;
      const values = saved.get(item.key);
      const sub = heading !== undefined || item.number.length > 1;
      const row = sheet.addRow([
        sub ? item.number.slice(-1) : item.number,
        item.label,
        values?.sqFt == null ? null : Number(values.sqFt),
        amount(values?.ratePerSqFt ?? null),
        values ? amount(values.sumInsured) || null : null,
      ]);
      // The S No is centred; a sub-item's description is indented under its heading.
      row.getCell(1).alignment = { horizontal: 'center' };
      row.getCell(2).alignment = { wrapText: true, indent: sub ? 2 : 0 };
      money(row, [4, 5]);
    }
    const total = sheet.addRow([null, 'Total sum insured', null, null, amount(location.fireTotal)]);
    total.font = { bold: true };
    money(total, [5]);
    const extras = [
      [HYPOTHECATION_LABEL, location.hypothecation],
      [OPEN_STOCK_LABEL, location.openStock],
    ] as const;
    for (const [index, [label, value]] of extras.filter(([, text]) => text?.trim()).entries()) {
      const row = sheet.addRow([String(index + 1), label, value]);
      row.getCell(1).alignment = { horizontal: 'center' };
      sheet.mergeCells(row.number, 3, row.number, 5);
      row.getCell(3).alignment = { wrapText: true, vertical: 'top' };
    }
  }
}

/** The client's Annexure sheet (D-5): each included annexure section's items and their total. */
export function annexure(workbook: ExcelJS.Workbook, record: ProposalRecord) {
  const sections = record.sections.filter(
    (section) => section.included && isAnnexureSection(section.code) && section.annexure.length > 0,
  );
  if (sections.length === 0) return;
  const sheet = workbook.addWorksheet('Annexure');
  sheet.columns = [
    { width: 6 },
    { width: 40 },
    { width: 22 },
    { width: 22 },
    { width: 22 },
    { width: 22 },
  ];
  title(sheet, 'ANNEXURE', 6);
  for (const section of sections) {
    const code = section.code as AnnexureSection;
    const columns = ANNEXURE_SECTIONS[code].columns as readonly AnnexureColumn[];
    sheet.addRow([]);
    sectionHeading(sheet, ANNEXURE_SECTIONS[code].title, 6);
    header(sheet, [
      'S No',
      ...columns.map((column) => annexureColumnLabel(code, column)),
      'Sum Insured',
    ]);
    section.annexure.forEach((row, index) => {
      const values = columns.map((column) =>
        column === 'quantity' && row.quantity !== null ? Number(row.quantity) : row[column],
      );
      const added = sheet.addRow([index + 1, ...values, amount(row.sumInsured)]);
      added.getCell(2).alignment = { wrapText: true };
      money(added, [columns.length + 2]);
    });
    const total = sheet.addRow([
      null,
      'Total',
      ...columns.slice(1).map(() => null),
      amount(section.proposed1),
    ]);
    total.font = { bold: true };
    money(total, [columns.length + 2]);
  }
}

export function riskDetails(workbook: ExcelJS.Workbook, record: ProposalRecord) {
  // Questions no location answered are left out; with none answered there is no sheet.
  const answered = RISK_DETAIL_FIELDS.filter((field) =>
    record.locations.some((location) => location.risk[field.key]?.trim()),
  );
  if (answered.length === 0) return;
  const sheet = workbook.addWorksheet('risk details');
  sheet.columns = [{ width: 6 }, { width: 40 }, ...record.locations.map(() => ({ width: 32 }))];
  header(sheet, [
    null,
    null,
    ...record.locations.map((l, i) => l.location?.name ?? `Location ${i + 1}`),
  ]);
  answered.forEach((field, index) => {
    const row = sheet.addRow([
      index + 1,
      field.label,
      ...record.locations.map((l) => l.risk[field.key] ?? ''),
    ]);
    row.alignment = { wrapText: true, vertical: 'top' };
  });
}

function claimDetails(workbook: ExcelJS.Workbook, record: ProposalRecord) {
  // No claims, no sheet.
  if (record.claims.length === 0) return;
  const sheet = workbook.addWorksheet('claim details');
  sheet.columns = [
    { width: 14 },
    { width: 18 },
    { width: 18 },
    { width: 18 },
    { width: 18 },
    { width: 36 },
    { width: 28 },
  ];
  sheet.addRow(['Past 3 years claim details:']).font = { bold: true };
  header(sheet, [
    'Policy Period',
    'Policy Type',
    'Sum Insured',
    'Premium before tax',
    'Claimed Amount',
    'Claim Remarks',
    'Insurer',
  ]);
  for (const claim of record.claims) {
    const row = sheet.addRow([
      claim.period,
      claim.policyType,
      amount(claim.sumInsured),
      amount(claim.premium),
      amount(claim.claimedAmount),
      claim.remarks,
      claim.insurer,
    ]);
    money(row, [3, 4, 5]);
  }
}

/** The add-on covers chosen on the case (C-4), with their limits where the master gives them. */
export function addonCovers(
  workbook: ExcelJS.Workbook,
  record: ProposalRecord,
  addons: readonly CatalogItem<'addons'>[],
) {
  if (record.addons.length === 0) return;
  const limitOf = (addon: (typeof record.addons)[number]) =>
    addons.find(
      (item) => item.list === addon.list && item.name.toLowerCase() === addon.name.toLowerCase(),
    )?.limit ?? null;
  // The limit column only when some cover has a limit.
  const limits = record.addons.some((addon) => limitOf(addon));
  const span = limits ? 4 : 3;
  const sheet = workbook.addWorksheet('add-on covers');
  sheet.columns = [{ width: 6 }, { width: 18 }, { width: 60 }, { width: 50 }].slice(0, span);
  title(sheet, `ADD-ON COVERS${record.product ? ` — ${record.product.name}` : ''}`, span);
  header(sheet, ['S No', 'List', 'Addon cover', ...(limits ? ['Sum insured limit'] : [])]);
  record.addons.forEach((addon, index) => {
    const row = sheet.addRow([
      index + 1,
      ADDON_LIST_LABELS[addon.list],
      addon.name,
      ...(limits ? [limitOf(addon)] : []),
    ]);
    row.alignment = { wrapText: true, vertical: 'top' };
  });
}

/** The built-in RFQ layout, used until the client's RFQ template is uploaded. */
export function buildRfqWorkbookDocument(
  record: ProposalRecord,
  client: ClientDoc,
  masters: RfqMasters & { addons?: readonly CatalogItem<'addons'>[] },
  options: { title?: string; attribution?: RfqAttribution } = {},
): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Fiducial';
  premiumDetails(
    workbook,
    record,
    Number(masters.gstRatePercent),
    options.title,
    options.attribution,
  );
  schedule(workbook, record, client, masters);
  fireByLocation(workbook, record);
  annexure(workbook, record);
  riskDetails(workbook, record);
  claimDetails(workbook, record);
  addonCovers(workbook, record, masters.addons ?? []);
  frameWorkbook(workbook);
  return workbook;
}

/** Boxes every sheet of a built-in document across its own columns (as the client's formats). */
export function frameWorkbook(workbook: ExcelJS.Workbook): void {
  for (const sheet of workbook.worksheets) {
    centreTables(sheet, sheet.columns.length);
    frameSheet(sheet, sheet.columns.length);
  }
}

export async function buildRfqWorkbook(
  record: ProposalRecord,
  client: ClientDoc,
  masters: RfqMasters,
): Promise<Buffer> {
  return Buffer.from(await buildRfqWorkbookDocument(record, client, masters).xlsx.writeBuffer());
}
