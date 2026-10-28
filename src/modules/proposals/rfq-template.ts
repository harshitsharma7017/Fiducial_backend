import {
  ANNEXURE_SECTIONS,
  BURGLARY_BASIS_LABELS,
  BURGLARY_BASIS_PERCENT,
  hasBasis,
  isSectionShown,
  wholeRupees,
  FIRE_GROUP_LABELS,
  FIRE_GROUPS,
  RISK_DETAIL_FIELDS,
  SECTION_LINES,
  formatDate,
  formatIndianNumber,
  productRangeText,
  quoteOptionsOf,
  rfqAttributionRows,
  type AnnexureSection,
  type CatalogItem,
  type Cover,
  sectionNamed,
  type FireGroup,
  type OtherSection,
  type ProposalRecord,
  type QuoteOption,
  type RfqAttribution,
  type SectionWithLines,
  type TemplateCheck,
} from '../../shared/index.ts';
import type ExcelJS from 'exceljs';
import {
  addColumnAfter,
  cellText,
  clearCells,
  copyColumnStyle,
  duplicateRows,
  extendPrintRows,
  findColumn,
  findRow,
  findRows,
  hideRow,
  highlightHeading,
  insertRows,
  isCovered,
  labelKey,
  markTick,
  printColumns,
  renumberRows,
  restyle,
  setValue,
  sheetNamed,
} from '../documents/excel-template.ts';
import { letterheadOf } from '../documents/sheet-pdf.ts';
import type { ClientDoc } from '../clients/client.model.ts';
import { filled, type RfqMasters } from './rfq-workbook.ts';

// The RFQ in the client's own template (R-3): the uploaded workbook is filled in place, so its
// sheets, merged cells, formulas, print areas and logo stay as the client made them. Every place
// is found by the label a person reads (Insured Name, Fire & Allied Perils, Coverage Section...),
// so rows moved in the template are still found. Rows are added only where the case needs more
// (a seventh Fire line, extra annexure items, notes); the template's sample answers are cleared.

export const SHEETS = {
  premium: 'premium details',
  schedule: 'schedule',
  risk: 'risk details',
  claims: 'claim details',
  annexure: 'Annexure',
} as const;

/** The section rows of "premium details", by their label. */
export const PREMIUM_ROWS = new Map<string, 'FIRE' | OtherSection>([
  ['fire', 'FIRE'],
  ['burglary', 'BURGLARY'],
  ['fire floater', 'FIRE_FLOATER'],
  ['burglary floater', 'BURGLARY_FLOATER'],
  ['flop', 'FIRE_LOSS_OF_PROFIT'],
  ['fire loss of profit', 'FIRE_LOSS_OF_PROFIT'],
  ['money', 'MONEY'],
  ['fidelity', 'FIDELITY_GUARANTEE'],
  ['plate glass', 'PLATE_GLASS'],
  ['neon sign', 'NEON_GLOW_SIGN'],
  ['all risk', 'ALL_RISK'],
  ['eei', 'EEI'],
  ['mbd', 'MECHANICAL_BREAKDOWN'],
  ['boiler', 'BOILER_PRESSURE_PLANT'],
  ['public liability', 'PUBLIC_LIABILITY'],
]);

/**
 * The Fire lines of a schedule, by the words their description starts with: the RFQ and the QCR
 * word and order them differently ("Office equipments and all..." / "Office Equipments
 * including...").
 */
const FIRE_LINE_WORDS: Record<FireGroup, RegExp> = {
  BUILDING: /^all building/,
  FFF: /^furniture/,
  OFFICE_EQUIPMENT: /^office equipment/,
  ELECTRICAL: /^entire power/,
  PLANT_MACHINERY: /^all types of plant and machinery/,
  STOCKS: /^all types of stock/,
  OTHER: /^any other item/,
};
/** "Total Sum Insured - Fire & Allied Perils" (RFQ), "Total Sum Insured - Fire" (QCR). */
const FIRE_TOTAL_LABEL = 'Total Sum Insured - Fire';

/** The schedule's section titles (start of the label), longest first. */
const SCHEDULE_TITLES: readonly [string, OtherSection][] = [
  ['burglary floater', 'BURGLARY_FLOATER'],
  ['fire floater', 'FIRE_FLOATER'],
  ['fire loss of profit', 'FIRE_LOSS_OF_PROFIT'],
  ['electronic equipment', 'EEI'],
  ['mechanical breakdown', 'MECHANICAL_BREAKDOWN'],
  ['public liability', 'PUBLIC_LIABILITY'],
  ['plate glass', 'PLATE_GLASS'],
  ['neon', 'NEON_GLOW_SIGN'],
  ['all risk', 'ALL_RISK'],
  ['boiler', 'BOILER_PRESSURE_PLANT'],
  ['fidelity', 'FIDELITY_GUARANTEE'],
  ['burglary', 'BURGLARY'],
  ['money', 'MONEY'],
];

/** Other wordings of the Data Sheet lines in the RFQ schedule. */
const LINE_ALIASES: Record<string, readonly string[]> = {
  limitPerEmployee: ['limit per employee'],
  limitPerPeriod: ['limit per policy period'],
};

const ANNEXURE_TITLES: Record<AnnexureSection, string> = {
  PLATE_GLASS: 'plate glass',
  NEON_GLOW_SIGN: 'neon',
  ALL_RISK: 'all risk',
  EEI: 'electronic equipment',
  MECHANICAL_BREAKDOWN: 'mechanical breakdown',
  BOILER_PRESSURE_PLANT: 'boiler',
};

const ADDON_SHEETS: readonly [string, CatalogItem<'addons'>['list']][] = [
  ['Fire-Additional Addon', 'FIRE_ADDITIONAL'],
  ['PAR-Addon', 'PAR'],
  ['SFSP-Addon', 'SFSP'],
  ['BSUS & BLUS-Addon', 'BSUS_BLUS'],
];

const SCHEDULE_LABELS = [
  'Insured Name',
  'Insured GST No',
  'Communication Address',
  'Risk Location',
  'Policy Period',
  'Nature of business',
  'Occupancy',
] as const;

export const amount = (value: string | null | undefined) =>
  value === null || value === undefined ? null : Number(value);

/** "2026-27" for a policy starting in 2026. */
export function policyYear(date: string): string {
  const year = Number(date.slice(0, 4));
  return `${year}-${String((year + 1) % 100).padStart(2, '0')}`;
}

export function dayBefore(date: string): string {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}

function scheduleTitleOf(text: string): OtherSection | null {
  const key = labelKey(text);
  return SCHEDULE_TITLES.find(([title]) => key.startsWith(title))?.[1] ?? null;
}

/** Checks that a workbook is an RFQ template the engine can fill. */
export function checkRfqTemplate(workbook: ExcelJS.Workbook): TemplateCheck {
  const problems: string[] = [];
  const premium = sheetNamed(workbook, SHEETS.premium);
  const schedule = sheetNamed(workbook, SHEETS.schedule);
  for (const name of Object.values(SHEETS)) {
    if (!sheetNamed(workbook, name)) problems.push(`The "${name}" sheet is missing.`);
  }
  if (premium) {
    if (findRows(premium, 'Coverage Section').length === 0) {
      problems.push('"premium details" has no "Coverage Section" table.');
    }
    if (!findRow(premium, 'Net Premium'))
      problems.push('"premium details" has no "Net Premium" row.');
  }
  if (schedule) {
    for (const label of SCHEDULE_LABELS) {
      if (!findRow(schedule, label)) problems.push(`"schedule" has no "${label}" row.`);
    }
    if (!findRow(schedule, 'Fire & Allied Perils')) {
      problems.push('"schedule" has no "Fire & Allied Perils" table.');
    }
    const header = findRow(schedule, 'S No');
    if (!header || !findColumn(schedule, header, 'Proposed Sum Insured - Option 1')) {
      problems.push('"schedule" has no "Proposed Sum Insured - Option 1" column.');
    }
  }
  const risk = sheetNamed(workbook, SHEETS.risk);
  if (risk && !findLocationHeader(risk))
    problems.push('"risk details" has no "Location 1" column.');
  const claims = sheetNamed(workbook, SHEETS.claims);
  if (claims && !findRow(claims, 'Policy Period'))
    problems.push('"claim details" has no "Policy Period" header.');
  const letterhead = letterheadOf(workbook);
  return {
    ok: problems.length === 0,
    problems,
    sheets: workbook.worksheets.map((sheet) => sheet.name),
    letterhead: { logo: letterhead.logo !== null, address: letterhead.address },
  };
}

export function findLocationHeader(
  sheet: ExcelJS.Worksheet,
): { row: number; column: number } | null {
  for (let row = 1; row <= Math.min(sheet.rowCount, 20); row += 1) {
    const column = findColumn(sheet, row, 'Location 1');
    if (column) return { row, column };
  }
  return null;
}

/** What every sheet filler reads. The QCR (qcr-template.ts) fills its schedule with these too. */
export interface FillContext {
  record: ProposalRecord;
  client: ClientDoc;
  masters: RfqMasters;
  renewal: boolean;
  /** The document being filled: its standard notes are those marked for it. */
  document: 'RFQ' | 'QCR' | 'PLACEMENT_SLIP';
  /** The premium details heading edited on the RFQ (R-2), if any. */
  title?: string;
  /** A2: who prepared and approved the RFQ, stamped on premium details. */
  attribution?: RfqAttribution;
  existingOf: (code: string) => { sumInsured: string | null; premium: string | null } | undefined;
}

/** The fill context of a case: the Existing column's sums and the policy software's premiums. */
export function fillContextOf(
  record: ProposalRecord,
  client: ClientDoc,
  masters: RfqMasters,
  document: FillContext['document'],
): FillContext {
  const premiums = new Map(
    record.existingPolicy?.sections.map((section) => [section.code, section.premium]) ?? [],
  );
  const sums = new Map<string, string | null>([
    ['FIRE', record.fire.existing],
    ...record.sections.map((section) => [section.code, section.existing] as const),
  ]);
  return {
    record,
    client,
    masters,
    renewal: record.type === 'EXISTING',
    document,
    existingOf: (code) => {
      const sumInsured = sums.get(code) ?? null;
      const premium = premiums.get(code as never) ?? null;
      return sumInsured === null && premium === null ? undefined : { sumInsured, premium };
    },
  };
}

function fillPremiumDetails(sheet: ExcelJS.Worksheet, context: FillContext) {
  const { record, renewal } = context;
  const start = record.policyStart ?? record.dueDate;
  const year = policyYear(start);
  const previous = policyYear(`${Number(start.slice(0, 4)) - 1}`);
  const existing = record.existing;
  const gst = Number(context.masters.gstRatePercent);
  // Last year's policy ends the day before the renewal starts, when the copy does not say.
  const expiry =
    record.existingPolicy?.periodEnd ?? (record.policyStart ? dayBefore(record.policyStart) : null);

  setValue(
    sheet,
    1,
    1,
    context.title ?? (renewal ? `RFQ FOR THE RENEWAL OF ${year}` : `RFQ FOR NEW BUSINESS ${year}`),
  );
  const insuredRow = findRow(sheet, 'Insured Name', { prefix: true });
  if (insuredRow) setValue(sheet, insuredRow, 1, `Insured Name: ${record.client.name}`);
  // A2: the "Approved by" (or approval status) row, inserted after the Insured Name row so the
  // quote blocks below are not disturbed. Reflects the actual approver of the version.
  if (context.attribution && insuredRow) {
    const rows = rfqAttributionRows(context.attribution);
    insertRows(sheet, insuredRow + 1, rows.length, insuredRow);
    rows.forEach(([label, value], offset) => {
      const row = insuredRow + 1 + offset;
      clearCells(sheet, { from: row, to: row }, { from: 1, to: printColumns(sheet).to });
      setValue(sheet, row, 1, `${label}: ${value}`);
      const cell = sheet.getCell(row, 1);
      restyle(cell, { font: { ...cell.font, bold: false, color: { argb: 'FF000000' } } });
    });
  }
  const expiryRow = findRow(sheet, 'Policy Expiry Date', { prefix: true });
  if (expiryRow) {
    setValue(
      sheet,
      expiryRow,
      1,
      renewal
        ? `Policy Expiry Date: ${expiry ? formatDate(expiry) : ''}`
        : `Quotes needed by: ${formatDate(record.dueDate)}`,
    );
  }

  // The quote blocks: a renewal quotes the existing sum insured, then Proposed 1, 2 and 3; new
  // business quotes Proposed 1, 2 and 3. A block with nothing to quote is hidden.
  const options = quoteBlocks(renewal);
  const asked = new Set(quoteOptionsOf(record));
  const blocks = quoteBlockRows(sheet, options, asked);
  // Bottom up, so the rows the totals add to a block do not move the blocks still to fill. The
  // last block shown moves down by what the blocks above it add.
  let lastShown = 0;
  let addedAbove = 0;
  blocks.toReversed().forEach((top, reversed) => {
    const index = blocks.length - 1 - reversed;
    const end = findRow(sheet, 'Total Premium', { from: top }) ?? top + 20;
    const plan = options[index];
    if (!plan || !asked.has(plan.option)) {
      for (let row = top - 1; row <= end; row += 1) sheet.getRow(row).hidden = true;
      return;
    }
    // Header: the existing policy's year and insurer, the renewal's year.
    const existingColumn = findColumn(sheet, top, 'Existing Policy', true);
    const quoteColumn = findColumn(sheet, top, 'Renewal Policy', true);
    if (existingColumn) {
      setValue(
        sheet,
        top,
        existingColumn,
        renewal ? `Existing Policy ${previous}` : 'Existing Policy (not applicable)',
      );
      const insurerRow = findRow(sheet, 'Insurer Name', {
        column: existingColumn,
        from: top,
        to: top + 3,
      });
      if (insurerRow && renewal && existing)
        setValue(sheet, insurerRow, existingColumn, existing.insurer);
    }
    if (quoteColumn)
      setValue(sheet, top, quoteColumn, `${renewal ? 'Renewal' : 'Proposed'} Policy ${year}`);
    const captionRow =
      findRow(sheet, 'Quote Option', {
        column: quoteColumn ?? 4,
        from: top,
        to: top + 4,
        prefix: true,
      }) ??
      findRow(sheet, 'Renewal Quote Option', {
        column: quoteColumn ?? 4,
        from: top,
        to: top + 4,
        prefix: true,
      });
    if (captionRow) setValue(sheet, captionRow, quoteColumn ?? 4, plan.caption);

    const sumColumn = findColumn(sheet, top + 1, 'Sum Insured') ?? 4;
    const existingSumColumn = existingColumn ? findColumn(sheet, top + 2, 'Sum Insured') : null;
    const existingPremiumColumn = existingColumn
      ? findColumn(sheet, top + 2, 'Premium', true)
      : null;
    // New business has no existing policy: its columns are left out.
    if (!renewal) {
      for (const column of [existingColumn, existingSumColumn, existingPremiumColumn]) {
        if (column) sheet.getColumn(column).hidden = true;
      }
    }
    for (let row = (captionRow ?? top + 3) + 1; row < end; row += 1) {
      const label = labelKey(cellText(sheet.getCell(row, 1)));
      if (label === 'net premium') break;
      const code = PREMIUM_ROWS.get(label);
      if (!code) continue;
      const section = code === 'FIRE' ? null : record.sections.find((s) => s.code === code);
      // B5: a section not marked required is omitted from the premium table — its row is hidden,
      // never written as "Not required" (as the schedule hides its block). The row carries no
      // figure and the Net Premium row has no formula over it, so no total changes. Fire is
      // always shown.
      if (code !== 'FIRE' && !(section && isSectionShown(section))) {
        sheet.getRow(row).hidden = true;
        continue;
      }
      const last = context.existingOf(code);
      if (renewal && existingSumColumn)
        setValue(sheet, row, existingSumColumn, amount(last?.sumInsured), { rupees: true });
      if (renewal && existingPremiumColumn)
        setValue(sheet, row, existingPremiumColumn, amount(last?.premium), { rupees: true });
      // Option 3 is a Fire figure: the other sections are quoted at their Option 1 figures in it.
      const value =
        plan.option === 'EXISTING'
          ? (last?.sumInsured ?? null)
          : code === 'FIRE'
            ? plan.option === 'P1'
              ? record.fire.proposed1
              : plan.option === 'P2'
                ? record.fire.proposed2
                : record.fire.proposed3
            : plan.option === 'P2'
              ? (section?.proposed2 ?? null)
              : (section?.proposed1 ?? null);
      // A section with no sum insured for this option, and nothing from last year, is left out.
      if (!filled(value) && !(renewal && (filled(last?.sumInsured) || filled(last?.premium)))) {
        hideRow(sheet, row);
        continue;
      }
      setValue(sheet, row, sumColumn, amount(value), { rupees: true });
    }
    // The totals, with terrorism and then without (client review, 27 Oct 2026); a template
    // without the two premium columns keeps its own rows, with GST at the proposal's rate.
    const withColumn = findColumn(sheet, top + 1, 'Premium with terrorism', true);
    const withoutColumn = findColumn(sheet, top + 1, 'Premium without terrorism', true);
    const sections = { from: (captionRow ?? top + 3) + 1, to: end - 1 };
    const blockEnd =
      withColumn && withoutColumn
        ? terrorismTotals(sheet, {
            top,
            end,
            sections,
            columns: { with: withColumn, without: withoutColumn, existing: existingPremiumColumn },
            renewal,
            gstRatePercent: context.masters.gstRatePercent,
          })
        : end;
    if (lastShown === 0) lastShown = blockEnd;
    else addedAbove += blockEnd - end;
    if (withColumn && withoutColumn) return;
    const gstRow = findRow(sheet, 'Add: GST', { from: top, to: end, prefix: true });
    if (gstRow) {
      setValue(sheet, gstRow, 1, `Add: GST ${context.masters.gstRatePercent}%`);
      sheet.getRow(gstRow).eachCell((cell) => {
        const value = cell.value;
        if (
          value &&
          typeof value === 'object' &&
          'formula' in value &&
          typeof value.formula === 'string'
        ) {
          cell.value = { formula: value.formula.replace(/\*\s*0?\.\d+\s*$/, `*${gst / 100}`) };
        }
      });
    }
  });
  // The template's print area can stop above its last blocks; the blocks quoted are printed.
  if (lastShown > 0) extendPrintRows(sheet, lastShown + addedAbove);
}

/** The quote blocks of premium details, in the template's order (RFQ and QCR alike). */
export function quoteBlocks(renewal: boolean): { caption: string; option: QuoteOption }[] {
  return renewal
    ? [
        { caption: 'Renewal Quote Option 1: For Existing Sum Insured', option: 'EXISTING' },
        { caption: 'Renewal Quote Option 2: For Proposed Sum Insured Option 1', option: 'P1' },
        { caption: 'Renewal Quote Option 3: For Proposed Sum Insured Option 2', option: 'P2' },
        { caption: 'Renewal Quote Option 4: For Proposed Sum Insured Option 3', option: 'P3' },
      ]
    : [
        { caption: 'Quote Option 1: For Proposed Sum Insured Option 1', option: 'P1' },
        { caption: 'Quote Option 2: For Proposed Sum Insured Option 2', option: 'P2' },
        { caption: 'Quote Option 3: For Proposed Sum Insured Option 3', option: 'P3' },
      ];
}

/**
 * The "Coverage Section" rows of premium details, one per quote block. A template with fewer
 * blocks than the options asked (a renewal's Option 3 is its fourth) gets its last block repeated
 * below it.
 */
export function quoteBlockRows(
  sheet: ExcelJS.Worksheet,
  options: readonly { option: QuoteOption }[],
  asked: ReadonlySet<QuoteOption>,
): number[] {
  const blocks = findRows(sheet, 'Coverage Section');
  const needed = options.reduce(
    (count, plan, index) => (asked.has(plan.option) ? index + 1 : count),
    0,
  );
  while (blocks.length > 0 && blocks.length < needed) {
    const top = blocks[blocks.length - 1] ?? 1;
    const end = findRow(sheet, 'Total Premium', { from: top }) ?? top + 20;
    // The block with the spacer row above it.
    duplicateRows(sheet, top - 1, end, end + 1);
    blocks.push(end + 2);
  }
  return blocks;
}

/**
 * The RFQ's totals of a quote block as the client reads them (27 Oct 2026): "With Terrorism"
 * then "Without Terrorism", each with its Net Value, GST and Total, one figure per row across the
 * two premium columns. The insurer's premiums fill the section rows; the totals are formulas over
 * them. A renewal's existing premium (quoted without terrorism) totals in the second group.
 * Returns the last row of the block.
 */
function terrorismTotals(
  sheet: ExcelJS.Worksheet,
  block: {
    top: number;
    end: number;
    sections: { from: number; to: number };
    columns: { with: number; without: number; existing: number | null };
    renewal: boolean;
    gstRatePercent: string;
  },
): number {
  const netRow = findRow(sheet, 'Net Premium', { from: block.top, to: block.end });
  if (!netRow) return block.end;
  const first = block.sections.from;
  const last = Math.min(block.sections.to, netRow - 1);
  // A heading row for "With Terrorism" above the totals, then the four rows repeated below.
  insertRows(sheet, netRow, 1, netRow);
  const withHeading = netRow;
  const withTotal = block.end + 1;
  duplicateRows(sheet, withHeading, withTotal, withTotal + 1);
  const printed = printColumns(sheet);
  const rate = Number(block.gstRatePercent) / 100;
  const groups = [
    { heading: withHeading, label: 'With Terrorism', column: block.columns.with, existing: false },
    {
      heading: withTotal + 1,
      label: 'Without Terrorism',
      column: block.columns.without,
      existing: block.renewal,
    },
  ];
  const left = Math.min(block.columns.with, block.columns.without);
  const right = Math.max(block.columns.with, block.columns.without);
  for (const group of groups) {
    const [net, gst, total] = [group.heading + 1, group.heading + 2, group.heading + 3];
    // The heading spans the table.
    clearCells(sheet, { from: group.heading, to: group.heading }, printed);
    mergeRow(sheet, group.heading, printed.from, printed.to);
    setValue(sheet, group.heading, printed.from, group.label);
    restyle(sheet.getCell(group.heading, printed.from), {
      alignment: { horizontal: 'left', vertical: 'middle' },
    });
    highlightHeading(sheet, group.heading, printed);
    const labels = ['Net Value', `GST ${block.gstRatePercent}%`, 'Total'];
    [net, gst, total].forEach((row, offset) => {
      clearCells(sheet, { from: row, to: row }, { from: 2, to: printed.to });
      setValue(sheet, row, 1, labels[offset] ?? null);
      // One figure across both premium columns.
      mergeRow(sheet, row, left, right);
    });
    const figure = (column: number, target: number) => {
      const letter = sheet.getColumn(column).letter;
      const at = sheet.getColumn(target).letter;
      sheet.getCell(net, target).value = { formula: `SUM(${letter}${first}:${letter}${last})` };
      sheet.getCell(gst, target).value = { formula: `ROUND(${at}${net}*${rate},2)` };
      sheet.getCell(total, target).value = { formula: `${at}${net}+${at}${gst}` };
      for (const row of [net, gst, total]) {
        restyle(sheet.getCell(row, target), {
          numFmt: '#,##0.00',
          alignment: { horizontal: 'right', vertical: 'middle' },
        });
      }
    };
    figure(group.column, left);
    if (group.existing && block.columns.existing) {
      figure(block.columns.existing, block.columns.existing);
    }
    restyle(sheet.getCell(total, 1), { font: { ...sheet.getCell(total, 1).font, bold: true } });
  }
  return withTotal + 4;
}

/** Merges a row across the given columns, taking apart any merge on that row first. */
function mergeRow(sheet: ExcelJS.Worksheet, row: number, from: number, to: number) {
  for (const address of [...((sheet.model as { merges?: string[] }).merges ?? [])]) {
    const [start = '', end = start] = address.split(':');
    const top = Number(sheet.getCell(start).row);
    const bottom = Number(sheet.getCell(end).row);
    const left = Number(sheet.getCell(start).col);
    const right = Number(sheet.getCell(end).col);
    if (top <= row && row <= bottom && left <= to && right >= from) sheet.unMergeCells(address);
  }
  if (to > from) sheet.mergeCells(row, from, row, to);
}

/** The rows of a schedule section: from its title to the next title (or the clauses). */
function scheduleBlocks(
  sheet: ExcelJS.Worksheet,
): Map<OtherSection, { title: number; end: number }> {
  const clauses = findRow(sheet, 'Clauses to be attached') ?? sheet.rowCount;
  const titles: { row: number; code: OtherSection }[] = [];
  const fire = findRow(sheet, 'Fire & Allied Perils') ?? 1;
  for (let row = fire + 1; row < clauses; row += 1) {
    const cell = sheet.getCell(row, 1);
    // A section title spans the table (a merged row); numbered and add-on rows do not.
    const merged = cell.isMerged && cell.master === cell && sheet.getCell(row, 2).master === cell;
    const code = merged ? scheduleTitleOf(cellText(cell)) : null;
    if (code) titles.push({ row, code });
  }
  return new Map(
    titles.map((title, index) => [
      title.code,
      { title: title.row, end: (titles[index + 1]?.row ?? clauses) - 1 },
    ]),
  );
}

/**
 * "Clauses to be attached" from the clause library (SEC-09): the active clauses marked for the
 * document whose sections the case quotes (or with none given), grouped under their headings in
 * the rows the template keeps for them; rows are added or hidden as needed. The Agreed Bank Clause
 * names the hypothecation of the locations. With no clause for the document the template's own
 * clauses stay.
 */
function fillClauses(sheet: ExcelJS.Worksheet, context: FillContext) {
  const { record, masters, document } = context;
  const quoted = new Set<string>([
    'FIRE',
    ...record.sections.filter((section) => section.included).map((section) => section.code),
  ]);
  let clauses = (masters.clauses ?? []).filter(
    (clause) =>
      clause.active &&
      (document === 'QCR'
        ? clause.onQcr
        : document === 'PLACEMENT_SLIP'
          ? clause.onPlacementSlip
          : clause.onRfq) &&
      (clause.sections.length === 0 ||
        clause.sections.some((name) => {
          const code = sectionNamed(name, masters.sections);
          return code !== null && quoted.has(code);
        })),
  );
  const banks = [
    ...new Set(
      record.locations.flatMap((location) =>
        location.hypothecation ? [location.hypothecation] : [],
      ),
    ),
  ];
  const bankText = `Agreed Bank Clause: ${banks.join('; ')}`;
  const title = findRow(sheet, 'Clauses to be attached');
  if (!title) return;
  if (clauses.length === 0) {
    // The template's own clauses are kept; its bank clause names the bank, or is left out.
    const bankRow = findRow(sheet, 'Agreed Bank Clause', { column: 2, from: title, prefix: true });
    if (bankRow && banks.length > 0) setValue(sheet, bankRow, 2, bankText);
    else if (bankRow) hideRow(sheet, bankRow);
    return;
  }
  // Without a bank (no hypothecation), the Agreed Bank Clause is left out.
  if (banks.length === 0) {
    clauses = clauses.filter((clause) => !/^agreed bank clause/i.test(clause.text));
  }
  const end = findRow(sheet, 'Warranties', { from: title + 1, prefix: true }) ?? title + 1;
  const printed = printColumns(sheet);
  // The format's first heading cell sets the look of every heading (rows added copy plainer ones).
  const headingFont = { ...sheet.getCell(title + 1, printed.from).font };
  let free = end - title - 1;
  // The block's merges (headings down column A, wording across) are rebuilt for the new rows.
  for (const address of [...((sheet.model as { merges?: string[] }).merges ?? [])]) {
    const [start = '', last = start] = address.split(':');
    const top = Number(sheet.getCell(start).row);
    const bottom = Number(sheet.getCell(last).row);
    if (bottom > title && top < end) sheet.unMergeCells(address);
  }
  if (clauses.length > free) {
    insertRows(sheet, title + 1 + free, clauses.length - free, title + Math.max(free, 1));
    free = clauses.length;
  }
  clauses.forEach((clause, offset) => {
    const row = title + 1 + offset;
    clearCells(sheet, { from: row, to: row }, { from: printed.from, to: printed.to });
    sheet.getRow(row).hidden = false;
    const text = /^agreed bank clause/i.test(clause.text) ? bankText : clause.text;
    setValue(sheet, row, printed.from, clause.heading);
    if (printed.to > printed.from + 1) sheet.mergeCells(row, printed.from + 1, row, printed.to);
    setValue(sheet, row, printed.from + 1, text);
    // The format colours some sample rows (the bank's "TBA"); every clause prints alike.
    const wording = sheet.getCell(row, printed.from + 1);
    restyle(wording, {
      font: { ...wording.font, color: { argb: 'FF000000' } },
      alignment: { wrapText: true, vertical: 'top', horizontal: 'left' },
    });
    sheet.getRow(row).height = Math.max(15, Math.ceil(text.length / 95) * 15);
  });
  // Headings shared by consecutive clauses span their rows, as in the client's format.
  let start = 0;
  for (let offset = 1; offset <= clauses.length; offset += 1) {
    if (clauses[offset]?.heading !== clauses[start]?.heading) {
      if (offset - start > 1) {
        sheet.mergeCells(title + 1 + start, printed.from, title + offset, printed.from);
      }
      restyle(sheet.getCell(title + 1 + start, printed.from), {
        font: headingFont,
        alignment: { wrapText: true, vertical: 'middle', horizontal: 'center' },
      });
      start = offset;
    }
  }
  for (let row = title + 1 + clauses.length; row < title + 1 + free; row += 1) {
    clearCells(sheet, { from: row, to: row }, { from: printed.from, to: printed.to });
    sheet.getRow(row).hidden = true;
  }
}

/**
 * D1: lists each building of the case as an indented sub-row beneath the schedule's "All Building…"
 * line, with its own sum insured, so the client RFQ shows the building breakdown (not only the
 * group total). Display-only: the Building line keeps the group total and the Fire total is
 * unchanged, so no sum is duplicated. Buildings are kept with their location (the name is prefixed
 * with the location when the case has more than one). A building with no sum insured is left
 * out. Nothing is inserted when the case has no buildings, so the
 * template's single Building row is left exactly as before.
 */
function itemiseBuildings(
  sheet: ExcelJS.Worksheet,
  record: ProposalRecord,
  columns: {
    buildingLine: () => number | null;
    descriptionColumn: number;
    sumInsuredColumn: number;
  },
): void {
  const multiLocation = record.locations.length > 1;
  const entries = record.locations
    .flatMap((location) =>
      location.buildings.map((building, index) => {
        const name = building.name?.trim() ? building.name.trim() : `Building ${index + 1}`;
        const label =
          multiLocation && location.location ? `${location.location.name}: ${name}` : name;
        return { label, sumInsured: building.sumInsured };
      }),
    )
    .filter((entry) => filled(entry.sumInsured));
  if (entries.length === 0) return;
  const buildingRow = columns.buildingLine();
  if (buildingRow === null) return;

  // Insert the sub-rows directly below the Building line, styled like it, then fill them.
  insertRows(sheet, buildingRow + 1, entries.length, buildingRow);
  entries.forEach((entry, offset) => {
    const row = buildingRow + 1 + offset;
    // Clear any style/merge carried from the Building line across the row's printed columns.
    const printed = printColumns(sheet);
    clearCells(sheet, { from: row, to: row }, { from: printed.from, to: printed.to });
    setValue(sheet, row, columns.descriptionColumn, entry.label);
    const description = sheet.getCell(row, columns.descriptionColumn);
    restyle(description, {
      alignment: { ...description.alignment, wrapText: true, indent: 2 },
      font: { ...description.font, bold: false },
    });
    // The building's own sum insured in the Option 1 column (buildings have no per-option figure).
    setValue(sheet, row, columns.sumInsuredColumn, amount(entry.sumInsured), { rupees: true });
  });
}

export function fillSchedule(sheet: ExcelJS.Worksheet, context: FillContext) {
  const { record, client, masters } = context;
  const existing = record.existing;
  // The Existing column: the policy in force (last year's on a renewal, the client's current
  // policy on new business); left out when there is none.
  const withExisting = existing !== null;
  // Working notes outside the printed columns are the client's, not the insurer's.
  const printed = printColumns(sheet);
  clearCells(
    sheet,
    { from: 1, to: sheet.rowCount },
    { from: printed.to + 1, to: Math.max(sheet.columnCount, printed.to + 1) },
  );

  const policyNo = findRow(sheet, 'Policy No', { prefix: true });
  if (policyNo) {
    // Only a case with the policy number of the policy in force has one to print.
    if (existing?.policyNumber) {
      setValue(sheet, policyNo, 1, `Policy No: ${existing.policyNumber}`);
    } else hideRow(sheet, policyNo);
  }
  const address = [
    client.address.line1,
    client.address.line2,
    client.address.city,
    `${client.address.state} ${client.address.pincode}`,
  ]
    .filter(Boolean)
    .join(', ');
  const locations = record.locations
    .map((location) => {
      const place = location.location;
      if (!place) return null;
      const a = place.address;
      // With several locations, each one's sum insured, as the client's template asks.
      const total =
        record.locations.length > 1
          ? ` — Fire sum insured ₹${formatIndianNumber(wholeRupees(location.fireTotal), 0)}`
          : '';
      return `${place.name}: ${[a.line1, a.line2, a.city, `${a.state} ${a.pincode}`].filter(Boolean).join(', ')}${total}`;
    })
    .filter((line): line is string => line !== null);
  const period =
    record.policyStart && record.policyEnd
      ? `${formatDate(record.policyStart)} to ${formatDate(record.policyEnd)}`
      : record.policyStart
        ? `For 1 year from ${formatDate(record.policyStart)}`
        : 'For 1 year from date of payment';
  const values: Record<(typeof SCHEDULE_LABELS)[number], string> = {
    'Insured Name': client.name,
    'Insured GST No': client.gstin ?? '',
    'Communication Address': address,
    'Risk Location': locations.join('\n'),
    'Policy Period': period,
    'Nature of business': client.natureOfBusiness,
    Occupancy: `${client.occupancy.tacCode} — ${client.occupancy.description}`,
  };
  for (const label of SCHEDULE_LABELS) {
    const row = findRow(sheet, label);
    if (!row) continue;
    if (!values[label].trim()) {
      hideRow(sheet, row);
      continue;
    }
    setValue(sheet, row, 2, values[label]);
    if (label === 'Risk Location' && locations.length > 1) {
      sheet.getRow(row).height = Math.max(15, 15 * locations.length);
    }
  }

  // The Fire table: Existing, Option 1, 2 and 3 by line.
  const header = findRow(sheet, 'S No') ?? 10;
  const existingFound = findColumn(sheet, header, 'Existing Sum Insured');
  const existingColumn = existingFound ?? 3;
  if (existingFound && !withExisting) sheet.getColumn(existingFound).hidden = true;
  // The placement slip has one column, for the option the client accepted.
  const option1Column =
    findColumn(sheet, header, 'Proposed Sum Insured - Option 1') ??
    findColumn(sheet, header, 'Proposed Sum Insured') ??
    4;
  const option2Found = findColumn(sheet, header, 'Proposed Sum Insured - Option 2');
  const option2Column = option2Found ?? 5;
  // Option 3 (Fire only) gets its own column after Option 2 when the template has none.
  let option3Column = findColumn(sheet, header, 'Proposed Sum Insured - Option 3');
  if (record.fire.proposed3 !== null && option3Column === null && option2Found !== null) {
    option3Column = addColumnAfter(sheet, option2Found);
    setValue(sheet, header, option3Column, 'Proposed Sum Insured - Option 3');
  } else if (record.fire.proposed3 === null && option3Column !== null) {
    sheet.getColumn(option3Column).hidden = true;
    option3Column = null;
  }
  const lineOf = new Map(record.fire.groups.map((line) => [line.group, line]));
  const existingLine = new Map(
    record.fire.groups.flatMap((line) => (line.existing ? [[line.group, line.existing]] : [])),
  );
  // Some rows merge the label across the figure columns ("As per Annexure" in EEI, MBD and
  // Boiler). The merge is kept: the figure joins the label instead of replacing it.
  const writeFigures = (
    row: number,
    existingValue: string | null | undefined,
    p1: string | null | undefined,
    p2: string | null | undefined,
    rupees = true,
    p3: string | null | undefined = null,
  ) => {
    type Figure = readonly [column: number, name: string, value: string | null | undefined];
    const figures: Figure[] = [
      ...(withExisting ? [[existingColumn, 'Existing', existingValue] as const] : []),
      [option1Column, 'Option 1', p1],
      [option2Column, 'Option 2', p2],
      ...(option3Column ? [[option3Column, 'Option 3', p3] as const] : []),
    ];
    const joined: string[] = [];
    let label: ExcelJS.Cell | null = null;
    for (const [column, name, value] of figures) {
      const cell = sheet.getCell(row, column);
      if (!isCovered(cell)) {
        setValue(sheet, row, column, amount(value), { rupees });
        continue;
      }
      label = cell.master;
      if (value !== null && value !== undefined && value !== '0')
        joined.push(`${name} ₹${formatIndianNumber(value, 0)}`);
    }
    if (label && joined.length > 0) label.value = `${cellText(label)} — ${joined.join(', ')}`;
  };
  const fireRow = findRow(sheet, 'Fire & Allied Perils') ?? header + 1;
  const totalRowOf = () =>
    findRow(sheet, FIRE_TOTAL_LABEL, { column: 2, from: fireRow, prefix: true }) ?? fireRow + 7;
  const findLine = (group: FireGroup) => {
    const totalRow = totalRowOf();
    for (let row = fireRow + 1; row < totalRow; row += 1) {
      if (FIRE_LINE_WORDS[group].test(labelKey(cellText(sheet.getCell(row, 2))))) return row;
    }
    return null;
  };
  // "Any other items" is not in the RFQ format; it gets its own line when it has an amount.
  const other = lineOf.get('OTHER');
  if (
    !findLine('OTHER') &&
    ((other && other.proposed1 !== '0') ||
      other?.proposed2 ||
      other?.proposed3 ||
      existingLine.get('OTHER'))
  ) {
    const after = (findLine('STOCKS') ?? totalRowOf() - 1) + 1;
    insertRows(sheet, after, 1, after - 1);
    setValue(sheet, after, 1, String(FIRE_GROUPS.length));
    setValue(sheet, after, 2, FIRE_GROUP_LABELS.OTHER);
  }
  // A line with nothing in it is left out.
  const blankZero = (value: string | null | undefined) =>
    value === undefined || value === '0' ? null : value;
  for (const group of FIRE_GROUPS) {
    const row = findLine(group);
    const line = lineOf.get(group);
    if (
      row &&
      ![existingLine.get(group), line?.proposed1, line?.proposed2, line?.proposed3].some(filled)
    ) {
      hideRow(sheet, row);
    } else if (row && line) {
      writeFigures(
        row,
        existingLine.get(group),
        blankZero(line.proposed1),
        blankZero(line.proposed2),
        true,
        blankZero(line.proposed3),
      );
    }
  }

  // D1: itemise the buildings under the "All Building…" line. The client template has one Building
  // row carrying the group total (buildings + civil-structure sub-items); the individual buildings
  // are listed as indented sub-rows beneath it, each with its own sum insured, as in the Data
  // Sheet. This representation is display-only: the Building line keeps the group total and the
  // Fire total is unchanged, so nothing is double-counted. Buildings stay tied to their location
  // (the name is prefixed with the location when the case has more than one).
  itemiseBuildings(sheet, record, {
    buildingLine: () => findLine('BUILDING'),
    descriptionColumn: 2,
    sumInsuredColumn: option1Column,
  });

  const total = findRow(sheet, FIRE_TOTAL_LABEL, { column: 2, from: fireRow, prefix: true });
  if (total)
    writeFigures(
      total,
      context.existingOf('FIRE')?.sumInsured,
      record.fire.proposed1,
      record.fire.proposed2,
      true,
      record.fire.proposed3,
    );

  // Fire's add-on covers asked for (C-6), above the products.
  // The client's templates say "Product to be choosen"; the row is printed as the policy.
  const productRowOf = () =>
    findRow(sheet, 'Policy to be', { prefix: true }) ??
    findRow(sheet, 'Product to be', { prefix: true });
  const fireTotalRow = totalRowOf();
  writeCovers(
    sheet,
    { from: fireTotalRow + 1, to: (productRowOf() ?? fireTotalRow + 4) - 1 },
    record.fire.covers,
    {
      option1: option1Column,
      option2: record.fire.proposed2 !== null ? option2Column : null,
      option3: option3Column,
    },
  );

  // Products from the product master, in the rows the template keeps for them; once the case
  // has chosen one (C-1), only that one. (Found again: covers added above may have moved it.)
  const productRow = productRowOf();
  const decided = record.product && record.product.source !== 'SUGGESTED' ? record.product : null;
  const active = masters.products.filter((product) => product.active);
  const products = decided
    ? [
        active.find((product) => product.code === decided.code) ??
          masters.products.find((product) => product.code === decided.code) ?? {
            code: decided.code,
            name: decided.name,
            aboveSi: null,
            upToSi: null,
          },
      ]
    : active;
  if (productRow && products.length > 0) {
    const block = sheet.getCell(productRow, 1);
    let rows = 1;
    while (
      sheet.getCell(productRow + rows, 1).isMerged &&
      sheet.getCell(productRow + rows, 1).master === block
    )
      rows += 1;
    if (decided && rows > 1) {
      // The label stays on the one row; the others are hidden, outside any merge.
      sheet.unMergeCells(productRow, 1, productRow + rows - 1, 1);
      for (let row = productRow + 1; row < productRow + rows; row += 1) {
        sheet.getRow(row).hidden = true;
        setValue(sheet, row, 2, null);
      }
      rows = 1;
    }
    setValue(sheet, productRow, 1, decided ? 'Policy' : 'Policy to be chosen');
    if (products.length > rows) {
      insertRows(sheet, productRow + rows - 1, products.length - rows, productRow + rows - 1);
      rows = products.length;
    }
    for (let index = 0; index < rows; index += 1) {
      const product = products[index];
      setValue(
        sheet,
        productRow + index,
        2,
        product
          ? decided && product.aboveSi === null && product.upToSi === null
            ? product.name
            : `${productRangeText(product)} sum insured: ${product.name}`
          : null,
      );
    }
  }

  // "Additional Addon cover — as per attached list" only when add-on covers were chosen.
  const additional = findRow(sheet, 'Additional Addon cover', { prefix: true });
  if (additional && record.addons.length === 0) hideRow(sheet, additional);

  // Each section: its lines, or "Not required". Blocks are found again for each section, as a
  // basis row added to one moves those below it.
  for (const section of record.sections) {
    const block = scheduleBlocks(sheet).get(section.code);
    if (!block) continue;
    const numbered: number[] = [];
    for (let row = block.title + 1; row <= block.end; row += 1) {
      if (/^\d+$/.test(cellText(sheet.getCell(row, 1)).trim())) numbered.push(row);
    }
    const first = numbered[0];
    if (first === undefined) continue;
    const last = context.existingOf(section.code);
    // B5: a section not marked required is omitted — its whole block (title, numbered lines,
    // optional basis rows and add-on rows) is hidden, never shown as "Not required".
    if (!isSectionShown(section)) {
      for (let row = block.title; row <= block.end; row += 1) sheet.getRow(row).hidden = true;
      continue;
    }
    const lines = SECTION_LINES[section.code as SectionWithLines] as
      readonly { key: string; label: string; kind: string }[] | undefined;
    if (lines && section.code !== 'FIRE_LOSS_OF_PROFIT') {
      for (const row of numbered) {
        const text = labelKey(cellText(sheet.getCell(row, 2)));
        const line = lines.find(
          (candidate) =>
            text.startsWith(labelKey(candidate.label)) ||
            (LINE_ALIASES[candidate.key] ?? []).some((alias) => text.startsWith(alias)),
        );
        if (!line) continue;
        const values = [
          section.existingLines[line.key],
          section.lines[line.key],
          section.lines2[line.key],
        ] as const;
        // A line the Data Sheet left blank is left out.
        if (!values.some(filled)) {
          hideRow(sheet, row);
          continue;
        }
        writeFigures(row, ...values, line.kind === 'rupees');
      }
    } else {
      writeFigures(first, last?.sumInsured, section.proposed1, section.proposed2);
    }
    if (hasBasis(section.code) && section.basis && section.basisAmounts) {
      const row = basisRow(sheet, block, section.basis);
      if (row)
        writeFigures(row, null, section.basisAmounts.proposed1, section.basisAmounts.proposed2);
    }
    const blockEnd = scheduleBlocks(sheet).get(section.code)?.end ?? block.end;
    // The Option 3 column is Fire's: the sections are quoted at Option 1 in it.
    writeCovers(sheet, { from: first + 1, to: blockEnd }, section.covers, {
      option1: option1Column,
      option2: section.proposed2 ? option2Column : null,
    });
    // A section with every row left out is left out too, title and all. (Found again: covers
    // added to the block move its end.)
    const title = scheduleBlocks(sheet).get(section.code)?.title ?? block.title;
    const end = scheduleBlocks(sheet).get(section.code)?.end ?? blockEnd;
    let shown = false;
    for (let row = title + 1; row <= end; row += 1) shown ||= !sheet.getRow(row).hidden;
    if (!shown) hideRow(sheet, title);
  }

  fillClauses(sheet, context);

  // The S No of each block reads 1, 2, 3… whatever was left out, centred; the column headings are
  // highlighted. The notes are not on the schedule (client review, 27 Oct 2026): the RFQ and the
  // placement slip have none, the QCR shows them on its first page (documentNotes).
  renumberSchedule(sheet, header);
  highlightHeading(sheet, header, printColumns(sheet));
  for (let column = 1; column <= printColumns(sheet).to; column += 1) {
    const cell = sheet.getCell(header, column);
    restyle(cell, { alignment: { ...cell.alignment, horizontal: 'center', wrapText: true } });
  }
}

/** Each block's numbered rows (Fire and every section), numbered again in order. */
function renumberSchedule(sheet: ExcelJS.Worksheet, header: number) {
  const end = findRow(sheet, 'Clauses to be attached') ?? sheet.rowCount + 1;
  let group: number[] = [];
  for (let row = header + 1; row < end; row += 1) {
    const cell = sheet.getCell(row, 1);
    // A block's title spans the table (a merged row): the numbering starts again under it.
    const title = cell.isMerged && cell.master === cell && sheet.getCell(row, 2).master === cell;
    if (title) {
      renumberRows(sheet, group);
      group = [];
    } else group.push(row);
  }
  renumberRows(sheet, group);
}

/**
 * The notes of a document: what the Data Sheet adds (hypothecation, stock in the open, its notes
 * for the insurers), then the standard notes marked for the document. Only the QCR prints them,
 * on its premium comparison under the recommendation (client review, 27 Oct 2026).
 */
export function documentNotes(context: FillContext): string[] {
  const { record, masters } = context;
  const name = (location: (typeof record.locations)[number]) =>
    location.location?.name ?? 'Location';
  return [
    ...record.locations.flatMap((location) =>
      location.hypothecation
        ? [`Hypothecation (${name(location)}): ${location.hypothecation}`]
        : [],
    ),
    ...record.locations.flatMap((location) =>
      location.openStock
        ? [`Stock kept at open space (${name(location)}): ${location.openStock}`]
        : [],
    ),
    ...(record.notes ? [`Notes for the insurers: ${record.notes}`] : []),
    ...masters.notes
      .filter(
        (note) =>
          note.active &&
          (context.document === 'QCR'
            ? note.onQcr
            : context.document === 'PLACEMENT_SLIP'
              ? note.onPlacementSlip
              : note.onRfq),
      )
      .map((note) => note.text),
  ];
}

/** "Total Sum Insured - Burglary on 1st loss basis 50% of sum insured", "... Burglary Floater on 100%". */
const BASIS_PREFIX = labelKey('Total Sum Insured - Burglary');

/** The percentage a basis row stands for: "on 100%" is the full value, "basis 25%" a first loss. */
function basisPercentOf(label: string): number | null {
  const match = /(?:basis|on)\s+(\d+)\b/.exec(labelKey(label));
  return match ? Number(match[1]) : null;
}

/**
 * The row of a section's basis (C-3), the template's optional rows otherwise hidden. A basis the
 * template has no row for (75%) gets one after the others.
 */
function basisRow(
  sheet: ExcelJS.Worksheet,
  block: { title: number; end: number },
  basis: keyof typeof BURGLARY_BASIS_LABELS,
): number | null {
  const rows: number[] = [];
  for (let row = block.title + 1; row <= block.end; row += 1) {
    if (labelKey(cellText(sheet.getCell(row, 2))).startsWith(BASIS_PREFIX)) rows.push(row);
  }
  const last = rows[rows.length - 1];
  if (last === undefined) return null;
  const percent = BURGLARY_BASIS_PERCENT[basis];
  let chosen = rows.find((row) => basisPercentOf(cellText(sheet.getCell(row, 2))) === percent);
  if (chosen === undefined) {
    // Worded like the template's last basis row, with this basis's percentage.
    const lastLabel = cellText(sheet.getCell(last, 2));
    const label = /\d+\s*%/.test(lastLabel)
      ? lastLabel.replace(/\d+(?=\s*%)/, String(percent))
      : `Total Sum Insured - Burglary on ${BURGLARY_BASIS_LABELS[basis]}`;
    insertRows(sheet, last + 1, 1, last);
    setValue(sheet, last + 1, 1, cellText(sheet.getCell(last, 1)));
    setValue(sheet, last + 1, 2, label);
    chosen = last + 1;
  }
  for (const row of rows) if (row !== chosen) sheet.getRow(row).hidden = true;
  return chosen;
}

/**
 * Marks the add-on cover rows of a block asked for (C-6) with a green tick in each option column;
 * a cover not required, or not answered, is left out.
 */
function writeCovers(
  sheet: ExcelJS.Worksheet,
  rows: { from: number; to: number },
  covers: readonly Cover[],
  columns: { option1: number; option2: number | null; option3?: number | null },
) {
  const asked = new Set(
    covers.flatMap((cover) => (cover.required === true ? [labelKey(cover.name)] : [])),
  );
  const tick = (row: number) => {
    for (const column of [columns.option1, columns.option2, columns.option3]) {
      if (column && !isCovered(sheet.getCell(row, column))) markTick(sheet.getCell(row, column));
    }
  };
  const marked = new Set<string>();
  let lastAddon = 0;
  for (let row = rows.from; row <= rows.to; row += 1) {
    if (labelKey(cellText(sheet.getCell(row, 1))) !== 'addon coverages') continue;
    lastAddon = row;
    if (sheet.getRow(row).hidden) continue;
    const name = labelKey(cellText(sheet.getCell(row, 2)));
    if (!asked.has(name)) {
      hideRow(sheet, row);
      continue;
    }
    marked.add(name);
    tick(row);
  }
  // Covers the template has no row for (added on the case) get rows after the block's add-ons.
  const extra = covers.filter(
    (cover) => cover.required === true && !marked.has(labelKey(cover.name)),
  );
  if (extra.length === 0) return;
  const like = lastAddon || rows.to;
  const at = like + 1;
  insertRows(sheet, at, extra.length, like);
  const printed = printColumns(sheet);
  extra.forEach((cover, offset) => {
    const row = at + offset;
    clearCells(sheet, { from: row, to: row }, { from: 2, to: printed.to });
    if (!isCovered(sheet.getCell(row, 1))) setValue(sheet, row, 1, 'Addon coverages');
    setValue(sheet, row, 2, cover.name);
    tick(row);
  });
}

export function fillRiskDetails(sheet: ExcelJS.Worksheet, record: ProposalRecord) {
  const header = findLocationHeader(sheet);
  if (!header) return;
  const lastColumn = Math.max(sheet.columnCount, header.column + record.locations.length);
  // The template's sample answers and notes go; the labels stay.
  clearCells(sheet, { from: 1, to: header.row - 1 }, { from: 1, to: lastColumn });
  clearCells(
    sheet,
    { from: header.row, to: sheet.rowCount },
    { from: header.column, to: lastColumn },
  );
  const numbered: number[] = [];
  for (let row = header.row + 1; row <= sheet.rowCount; row += 1) {
    const text = cellText(sheet.getCell(row, header.column - 2)).trim();
    if (/^\d+$/.test(text)) numbered.push(row);
  }
  record.locations.forEach((location, index) => {
    const column = header.column + index;
    if (index >= 2) copyColumnStyle(sheet, header.column + 1, column, sheet.rowCount);
    setValue(sheet, header.row, column, location.location?.name ?? `Location ${index + 1}`);
    RISK_DETAIL_FIELDS.forEach((field, fieldIndex) => {
      const row = numbered[fieldIndex];
      if (row) setValue(sheet, row, column, location.risk[field.key] ?? null);
    });
  });
  // A question no location answered is left out; the others are numbered in order.
  RISK_DETAIL_FIELDS.forEach((field, fieldIndex) => {
    const row = numbered[fieldIndex];
    if (row && !record.locations.some((location) => location.risk[field.key]?.trim())) {
      hideRow(sheet, row);
    }
  });
  renumberRows(sheet, numbered, header.column - 2);
}

function fillClaims(sheet: ExcelJS.Worksheet, record: ProposalRecord) {
  const header = findRow(sheet, 'Policy Period');
  if (!header) return;
  const columns = {
    period: findColumn(sheet, header, 'Policy Period') ?? 1,
    policyType: findColumn(sheet, header, 'Policy Type') ?? 2,
    sumInsured: findColumn(sheet, header, 'Sum Insured') ?? 3,
    premium: findColumn(sheet, header, 'Premium before tax') ?? 4,
    claimedAmount: findColumn(sheet, header, 'Claimed Amount') ?? 5,
    remarks: findColumn(sheet, header, 'Claim Remarks') ?? 6,
    insurer: findColumn(sheet, header, 'Insurer') ?? 7,
  };
  clearCells(
    sheet,
    { from: header + 1, to: Math.max(sheet.rowCount, header + 3) },
    { from: 1, to: sheet.columnCount },
  );
  if (record.claims.length === 0) {
    setValue(sheet, header + 1, columns.period, 'No claims reported');
    return;
  }
  record.claims.forEach((claim, index) => {
    const row = header + 1 + index;
    setValue(sheet, row, columns.period, claim.period);
    setValue(sheet, row, columns.policyType, claim.policyType);
    setValue(sheet, row, columns.sumInsured, amount(claim.sumInsured), { rupees: true });
    setValue(sheet, row, columns.premium, amount(claim.premium), { rupees: true });
    setValue(sheet, row, columns.claimedAmount, amount(claim.claimedAmount), { rupees: true });
    setValue(sheet, row, columns.remarks, claim.remarks);
    setValue(sheet, row, columns.insurer, claim.insurer);
  });
}

export function fillAnnexure(sheet: ExcelJS.Worksheet, record: ProposalRecord) {
  // Bottom up, so rows added to one block do not move the blocks still to fill.
  const codes = (Object.keys(ANNEXURE_SECTIONS) as AnnexureSection[]).toReversed();
  for (const code of codes) {
    const section = record.sections.find((s) => s.code === code);
    if (!section?.included || section.annexure.length === 0) continue;
    const title = findRow(sheet, ANNEXURE_TITLES[code], { prefix: true });
    if (!title) continue;
    const header = title + 1;
    const data: number[] = [];
    for (let row = header + 1; row <= sheet.rowCount; row += 1) {
      if (!/^\d+$/.test(cellText(sheet.getCell(row, 1)).trim())) break;
      data.push(row);
    }
    if (data.length === 0) continue;
    const extra = section.annexure.length - data.length;
    const lastData = data[data.length - 1] ?? header + 1;
    if (extra > 0) insertRows(sheet, lastData, extra, lastData);
    const column = (label: string, prefix = false) => findColumn(sheet, header, label, prefix);
    const columns = {
      description: column('Description'),
      quantity: column('No of', true),
      dimensions: column('Dimension', true),
      makeModel: column('Make & Model'),
      serialNo: column('Serial No'),
      year: column('Year of', true),
      sumInsured: column('Sum Insured'),
    };
    section.annexure.forEach((item, index) => {
      const row = header + 1 + index;
      setValue(sheet, row, 1, index + 1);
      restyle(sheet.getCell(row, 1), {
        alignment: { ...sheet.getCell(row, 1).alignment, horizontal: 'center' },
      });
      if (columns.description) setValue(sheet, row, columns.description, item.description);
      if (columns.quantity)
        setValue(
          sheet,
          row,
          columns.quantity,
          item.quantity === null ? null : Number(item.quantity),
        );
      if (columns.dimensions) setValue(sheet, row, columns.dimensions, item.dimensions);
      if (columns.makeModel) setValue(sheet, row, columns.makeModel, item.makeModel);
      if (columns.serialNo) setValue(sheet, row, columns.serialNo, item.serialNo);
      if (columns.year) setValue(sheet, row, columns.year, item.year);
      if (columns.sumInsured)
        setValue(sheet, row, columns.sumInsured, Number(item.sumInsured), { rupees: true });
    });
  }
}

interface AddonLine {
  seq: number;
  name: string;
  kind: CatalogItem<'addons'>['kind'];
  limit: string | null;
}

/**
 * The add-on sheets (C-4): the add-ons chosen on the case, else the product's whole list from the
 * add-on master (the template's lists stay when it has none). Once the case has chosen a product
 * or add-ons, the lists of other products are hidden (the sheets stay in the file).
 */
export function fillAddonSheets(
  workbook: ExcelJS.Workbook,
  addons: readonly CatalogItem<'addons'>[],
  record: ProposalRecord,
) {
  const decided =
    (record.product !== null && record.product.source !== 'SUGGESTED') || record.addons.length > 0;
  for (const [name, list] of ADDON_SHEETS) {
    const sheet = sheetNamed(workbook, name);
    if (!sheet) continue;
    const chosen = record.addons.filter((addon) => addon.list === list);
    // A list the case chose no add-on cover from is left out.
    if (chosen.length === 0 || (decided && !record.addonLists.includes(list))) {
      sheet.state = 'hidden';
      continue;
    }
    const master = addons.filter((addon) => addon.list === list && addon.active);
    const items: AddonLine[] = chosen.map((addon, index) => {
      const known = master.find((item) => labelKey(item.name) === labelKey(addon.name));
      return {
        seq: index + 1,
        name: addon.name,
        kind: known?.kind ?? null,
        limit: known?.limit ?? null,
      };
    });
    const used = sheet.rowCount;
    // Group merges in the first column (BSUS & BLUS: "Paid cover", "Inbuilt coverages").
    for (const address of [...((sheet.model as { merges?: string[] }).merges ?? [])]) {
      if (/^A\d+:A\d+$/.test(address)) sheet.unMergeCells(address);
    }
    clearCells(
      sheet,
      { from: 2, to: Math.max(used, items.length + 1) },
      { from: 1, to: sheet.columnCount },
    );
    const style = (row: number) => {
      if (row <= used) return;
      sheet.getRow(row).eachCell({ includeEmpty: true }, () => undefined);
      for (let column = 1; column <= sheet.columnCount; column += 1) {
        sheet.getCell(row, column).style = JSON.parse(
          JSON.stringify(sheet.getCell(2, column).style),
        ) as Partial<ExcelJS.Style>;
      }
    };
    if (list === 'BSUS_BLUS') {
      let groupStart = 2;
      items.forEach((item, index) => {
        const row = index + 2;
        style(row);
        const kind = item.kind === 'INBUILT' ? 'Inbuilt coverages' : 'Paid cover';
        const previous = items[index - 1];
        if (!previous || previous.kind !== item.kind) {
          if (index > 0 && row - 1 > groupStart) sheet.mergeCells(groupStart, 1, row - 1, 1);
          groupStart = row;
          setValue(sheet, row, 1, kind);
        }
        setValue(sheet, row, 2, item.name);
        setValue(sheet, row, 3, item.limit);
      });
      const end = items.length + 1;
      if (end > groupStart) sheet.mergeCells(groupStart, 1, end, 1);
    } else {
      items.forEach((item, index) => {
        style(index + 2);
        setValue(sheet, index + 2, 1, item.seq);
        restyle(sheet.getCell(index + 2, 1), {
          alignment: { ...sheet.getCell(index + 2, 1).alignment, horizontal: 'center' },
        });
        setValue(sheet, index + 2, 2, item.name);
      });
    }
    // The template's rows below a shorter list are hidden, so the PDF does not print them.
    for (let row = items.length + 2; row <= used; row += 1) sheet.getRow(row).hidden = true;
  }
}

/** Fills the client's RFQ template in place for a proposal. */
export function fillRfqTemplate(
  workbook: ExcelJS.Workbook,
  record: ProposalRecord,
  client: ClientDoc,
  masters: RfqMasters & { addons: readonly CatalogItem<'addons'>[] },
  options: { title?: string; attribution?: RfqAttribution } = {},
): void {
  const context = {
    ...fillContextOf(record, client, masters, 'RFQ'),
    title: options.title,
    attribution: options.attribution,
  };
  const sheet = (name: string) => sheetNamed(workbook, name);
  const premium = sheet(SHEETS.premium);
  if (premium) fillPremiumDetails(premium, context);
  const schedule = sheet(SHEETS.schedule);
  if (schedule) fillSchedule(schedule, context);
  const annexure = sheet(SHEETS.annexure);
  if (annexure) fillAnnexure(annexure, record);
  const risk = sheet(SHEETS.risk);
  if (risk) fillRiskDetails(risk, record);
  const claims = sheet(SHEETS.claims);
  if (claims) fillClaims(claims, record);
  fillAddonSheets(workbook, masters.addons, record);
  workbook.creator = 'Fiducial';
}
