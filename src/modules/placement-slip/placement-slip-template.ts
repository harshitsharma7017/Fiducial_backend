import {
  formatDate,
  type PlacementSlip,
  type ProposalRecord,
  type QuoteOption,
  type TemplateCheck,
} from '../../shared/index.ts';
import type ExcelJS from 'exceljs';
import {
  cellText,
  clearCells,
  findColumn,
  findRow,
  insertRows,
  labelKey,
  printColumns,
  restyle,
  setValue,
  sheetNamed,
} from '../documents/excel-template.ts';
import { letterheadOf } from '../documents/sheet-pdf.ts';
import type { ClientDoc } from '../clients/client.model.ts';
import {
  PREMIUM_ROWS,
  SHEETS,
  amount,
  dayBefore,
  fillAnnexure,
  fillContextOf,
  fillRiskDetails,
  fillSchedule,
  policyYear,
} from '../proposals/rfq-template.ts';
import type { RfqMasters } from '../proposals/rfq-workbook.ts';

// The placement slip in the client's own format: "premium details" for the insurer the client
// accepted (its name, capacity and premium per section, net, GST and total), the schedule for the
// option accepted (one sum insured column), the insurer's deductibles and conditions, the agreed
// bank from the Data Sheet, and the annexure. Places are found by their labels, as on the RFQ.

/** Checks that a workbook is a Placement Slip format the engine can fill. */
export function checkPlacementSlipTemplate(workbook: ExcelJS.Workbook): TemplateCheck {
  const problems: string[] = [];
  const premium = sheetNamed(workbook, SHEETS.premium);
  const schedule = sheetNamed(workbook, SHEETS.schedule);
  if (!premium) problems.push('The "premium details" sheet is missing.');
  if (!schedule) problems.push('The "schedule" sheet is missing.');
  if (premium) {
    const top = findRow(premium, 'Coverage Section');
    if (!top) problems.push('"premium details" has no "Coverage Section" table.');
    else if (!findColumn(premium, top + 1, 'Insurer Name')) {
      problems.push('"premium details" has no "Insurer Name" column.');
    }
    if (!findRow(premium, 'Net Premium')) {
      problems.push('"premium details" has no "Net Premium" row.');
    }
  }
  if (schedule) {
    if (!findRow(schedule, 'Fire & Allied Perils')) {
      problems.push('"schedule" has no "Fire & Allied Perils" table.');
    }
    const header = findRow(schedule, 'S No');
    if (!header || !findColumn(schedule, header, 'Proposed Sum Insured', true)) {
      problems.push('"schedule" has no "Proposed Sum Insured" column.');
    }
  }
  const letterhead = letterheadOf(workbook);
  return {
    ok: problems.length === 0,
    problems,
    sheets: workbook.worksheets.map((sheet) => sheet.name),
    letterhead: { logo: letterhead.logo !== null, address: letterhead.address },
  };
}

/**
 * The case as if the option accepted were its only option, with its product decided: the slip's
 * schedule has one sum insured column and names the product placed; Fire accepted without
 * terrorism marks its terrorism cover not required. Option 2 takes its second figures where given (Fire lines without one are not
 * in Option 2); the existing sum insured takes last year's figures.
 */
export function recordForOption(
  record: ProposalRecord,
  option: QuoteOption,
  withTerrorism: boolean | null = null,
): ProposalRecord {
  const pickSection = (values: {
    existing: string | null;
    proposed1: string | null;
    proposed2: string | null;
  }) =>
    option === 'EXISTING'
      ? values.existing
      : option === 'P1'
        ? values.proposed1
        : (values.proposed2 ?? values.proposed1);
  const pickFire = (values: {
    existing: string | null;
    proposed1: string;
    proposed2: string | null;
  }) =>
    (option === 'EXISTING'
      ? values.existing
      : option === 'P1'
        ? values.proposed1
        : values.proposed2) ?? '0';
  const given = (values: Readonly<Record<string, string | null>>): Record<string, string | null> =>
    Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null));
  return {
    ...record,
    type: 'NEW',
    existing: null,
    existingPolicy: null,
    // The slip names the product placed, not the range the RFQ offered.
    product: record.product ? { ...record.product, source: 'CHOSEN' } : null,
    fire: {
      ...record.fire,
      // Fire taken without terrorism: its terrorism cover is not placed.
      covers:
        withTerrorism === false
          ? record.fire.covers.map((cover) =>
              /terrorism/i.test(cover.name) ? { ...cover, required: false } : cover,
            )
          : record.fire.covers,
      groups: record.fire.groups.map((line) => ({
        ...line,
        existing: null,
        proposed1: pickFire(line),
        proposed2: null,
      })),
      existing: null,
      proposed1: pickFire(record.fire),
      proposed2: null,
    },
    sections: record.sections.map((section) => ({
      ...section,
      existing: null,
      proposed1: pickSection(section),
      proposed2: null,
      lines:
        option === 'EXISTING'
          ? section.existingLines
          : option === 'P2'
            ? { ...section.lines, ...given(section.lines2) }
            : section.lines,
      lines2: {},
      existingLines: {},
      basisAmounts: section.basisAmounts
        ? {
            proposed1:
              option === 'EXISTING'
                ? null
                : option === 'P2'
                  ? (section.basisAmounts.proposed2 ?? section.basisAmounts.proposed1)
                  : section.basisAmounts.proposed1,
            proposed2: null,
          }
        : null,
    })),
  };
}

/** A formula cell with its value, so the file and the PDF show the figure before Excel recalculates. */
function formula(
  sheet: ExcelJS.Worksheet,
  row: number,
  column: number,
  text: string,
  result: string,
) {
  sheet.getCell(row, column).value = { formula: text, result: Number(result) };
}

function fillPremium(sheet: ExcelJS.Worksheet, record: ProposalRecord, slip: PlacementSlip) {
  const accepted = slip.accepted;
  if (!accepted || !slip.premium) return;
  const renewal = record.type === 'EXISTING';
  const start = record.policyStart ?? record.dueDate;
  const year = policyYear(start);
  setValue(
    sheet,
    1,
    1,
    renewal
      ? `FINAL PLACEMENT SLIP FOR THE RENEWAL OF ${year}`
      : `FINAL PLACEMENT SLIP FOR NEW BUSINESS ${year}`,
  );
  const insuredRow = findRow(sheet, 'Insured Name', { prefix: true });
  if (insuredRow) setValue(sheet, insuredRow, 1, `Insured Name: ${record.client.name}`);
  const expiryRow = findRow(sheet, 'Policy Expiry Date', { prefix: true });
  if (expiryRow) {
    const expiry =
      record.existingPolicy?.periodEnd ??
      (record.policyStart ? dayBefore(record.policyStart) : null);
    setValue(
      sheet,
      expiryRow,
      1,
      renewal
        ? `Policy Expiry Date: ${expiry ? formatDate(expiry) : ''}`
        : `Policy Start Date: ${record.policyStart ? formatDate(record.policyStart) : 'From the date of payment'}`,
    );
  }

  const top = findRow(sheet, 'Coverage Section') ?? 5;
  const netRow = findRow(sheet, 'Net Premium', { from: top }) ?? top + 10;
  const premiumColumn = findColumn(sheet, top + 1, 'Insurer Name') ?? 3;
  const sumColumn = findColumn(sheet, top + 1, 'Sum Insured') ?? 2;
  setValue(sheet, top, sumColumn, `${renewal ? 'Renewal' : 'Proposed'} Policy ${year}`);
  const caption = (label: string) =>
    findRow(sheet, label, { column: premiumColumn, from: top, to: netRow, prefix: true });
  const nameRow = caption('Insurer Name');
  if (nameRow) setValue(sheet, nameRow, premiumColumn, `${accepted.company}, ${accepted.branch}`);
  const capacityRow = caption('Capacity');
  if (capacityRow) {
    setValue(
      sheet,
      capacityRow,
      premiumColumn,
      `Capacity: ${slip.capacityPercent ? `${slip.capacityPercent}%` : 'Not stated'}`,
    );
  }
  // Which Fire premium was accepted: the other caption is hidden.
  const without = caption('Optional: (Fire section without terrorism)');
  const withRow = caption('Optional: (Fire section with terrorism)');
  if (without) {
    if (accepted.withTerrorism === false) {
      setValue(sheet, without, premiumColumn, 'Fire section without terrorism (accepted)');
    } else sheet.getRow(without).hidden = true;
  }
  if (withRow) {
    if (accepted.withTerrorism === true) {
      setValue(sheet, withRow, premiumColumn, 'Fire section with terrorism (accepted)');
    } else sheet.getRow(withRow).hidden = true;
  }

  // The section rows: the template's, then a row for each other section placed.
  const firstSection = (nameRow ?? top) + 1;
  let sectionsStart = firstSection;
  for (let row = firstSection; row < netRow; row += 1) {
    if (PREMIUM_ROWS.has(labelKey(cellText(sheet.getCell(row, 1))))) {
      sectionsStart = row;
      break;
    }
  }
  const rowsOf = () => {
    const end = findRow(sheet, 'Net Premium', { from: top }) ?? netRow;
    const rows = new Map<string, number>();
    for (let row = sectionsStart; row < end; row += 1) {
      const code = PREMIUM_ROWS.get(labelKey(cellText(sheet.getCell(row, 1))));
      if (code && !rows.has(code)) rows.set(code, row);
    }
    return { rows, end };
  };
  const missing = slip.sections.filter((section) => !rowsOf().rows.has(section.code));
  if (missing.length > 0) {
    const { end } = rowsOf();
    insertRows(sheet, end, missing.length, end - 1);
    missing.forEach((section, offset) => {
      clearCells(sheet, { from: end + offset, to: end + offset }, { from: 1, to: 4 });
      setValue(sheet, end + offset, 1, section.name);
    });
  }
  const { rows, end } = rowsOf();
  for (const [code, row] of rows) {
    const section = slip.sections.find((item) => item.code === code);
    if (!section) {
      sheet.getRow(row).hidden = true;
      continue;
    }
    setValue(sheet, row, sumColumn, amount(section.sumInsured), { rupees: true });
    setValue(sheet, row, premiumColumn, Number(section.premium), { rupees: true });
  }
  const placedRows = [...rows.entries()]
    .filter(([code]) => slip.sections.some((section) => section.code === code))
    .map(([, row]) => row);
  const first = Math.min(...placedRows);
  const last = Math.max(...placedRows);
  const gstRow = findRow(sheet, 'Add: GST', { from: end, prefix: true }) ?? end + 1;
  const totalRow = findRow(sheet, 'Total Premium', { from: end }) ?? gstRow + 1;
  setValue(sheet, gstRow, 1, `Add: GST ${slip.gstRatePercent}%`);
  const letter = sheet.getColumn(premiumColumn).letter;
  const rate = Number(slip.gstRatePercent) / 100;
  formula(sheet, end, premiumColumn, `SUM(${letter}${first}:${letter}${last})`, slip.premium.net);
  formula(sheet, gstRow, premiumColumn, `ROUND(${letter}${end}*${rate},2)`, slip.premium.gst);
  formula(
    sheet,
    totalRow,
    premiumColumn,
    `SUM(${letter}${end}:${letter}${gstRow})`,
    slip.premium.total,
  );
  // The template's second premium column repeats the first (a merge in some rows only).
  for (const row of [end, gstRow, totalRow]) {
    const next = sheet.getCell(row, premiumColumn + 1);
    if (!next.isMerged && next.formula) next.value = null;
  }
  const remarksRow = findRow(sheet, 'Remarks if any', { prefix: true });
  if (remarksRow) {
    setValue(sheet, remarksRow, 1, `Remarks if any: ${slip.remarks ?? ''}`);
    restyle(sheet.getCell(remarksRow, 1), {
      alignment: { wrapText: true, vertical: 'top', horizontal: 'left' },
    });
    if (slip.remarks) {
      sheet.getRow(remarksRow).height = Math.max(18, Math.ceil(slip.remarks.length / 90) * 15);
    }
    // The format's print area stops above the remarks.
    const printed = printColumns(sheet);
    sheet.pageSetup.printArea = `${sheet.getColumn(printed.from).letter}1:${sheet.getColumn(printed.to).letter}${remarksRow}`;
  }
}

/** Merges a row across the given columns, taking apart any template merge on that row first. */
function mergeAcross(sheet: ExcelJS.Worksheet, row: number, from: number, to: number) {
  for (const address of [...((sheet.model as { merges?: string[] }).merges ?? [])]) {
    const [start = '', end = start] = address.split(':');
    const top = Number(sheet.getCell(start).row);
    const bottom = Number(sheet.getCell(end).row);
    if (top <= row && row <= bottom) sheet.unMergeCells(address);
  }
  sheet.mergeCells(row, from, row, to);
}

/** Writes lines under a schedule title, up to the next title, adding rows when they do not fit. */
function linesBelow(sheet: ExcelJS.Worksheet, title: string, next: string, lines: string[]) {
  const titleRow = findRow(sheet, title);
  if (!titleRow || lines.length === 0) return;
  const nextRow = findRow(sheet, next, { from: titleRow + 1 }) ?? titleRow + 1 + lines.length;
  const free = nextRow - titleRow - 1;
  if (lines.length > free)
    insertRows(sheet, nextRow, lines.length - free, Math.max(titleRow + 1, nextRow - 1));
  const printed = printColumns(sheet);
  lines.forEach((line, offset) => {
    const row = titleRow + 1 + offset;
    mergeAcross(sheet, row, printed.from, printed.to);
    setValue(sheet, row, printed.from, line);
    restyle(sheet.getCell(row, printed.from), { alignment: { wrapText: true, vertical: 'top' } });
    sheet.getRow(row).height = Math.max(15, Math.ceil(line.length / 110) * 15);
  });
}

function fillScheduleExtras(sheet: ExcelJS.Worksheet, record: ProposalRecord, slip: PlacementSlip) {
  // The policy number is the insurer's, once issued.
  const policyNo = findRow(sheet, 'Policy No', { prefix: true });
  if (policyNo) {
    setValue(
      sheet,
      policyNo,
      1,
      `Policy No: ${slip.placed?.number ?? 'To be issued by the insurer'}`,
    );
  }
  // The agreed bank: the hypothecation of each location, from the Data Sheet.
  const banks = [
    ...new Set(
      record.locations.flatMap((location) =>
        location.hypothecation ? [location.hypothecation] : [],
      ),
    ),
  ];
  const bankRow = findRow(sheet, 'Agreed Bank Clause', { column: 2, prefix: true });
  if (bankRow) {
    setValue(
      sheet,
      bankRow,
      2,
      `Agreed Bank Clause: ${banks.length > 0 ? banks.join('; ') : 'Not applicable'}`,
    );
  }
  linesBelow(sheet, 'Warranties / Conditions', 'Excess', slip.conditions ? [slip.conditions] : []);
  linesBelow(
    sheet,
    'Excess',
    'Fiducial',
    slip.deductibles ? [`Deductibles: ${slip.deductibles}`] : [],
  );
  // Print every row: the format's print area stops above the clauses and conditions.
  const printed = printColumns(sheet);
  sheet.pageSetup.printArea = `${sheet.getColumn(printed.from).letter}1:${sheet.getColumn(printed.to).letter}${sheet.rowCount}`;
}

/** Fills the client's Placement Slip format in place. */
export function fillPlacementSlipTemplate(
  workbook: ExcelJS.Workbook,
  record: ProposalRecord,
  client: ClientDoc,
  masters: RfqMasters,
  slip: PlacementSlip,
): void {
  const option = slip.accepted?.option ?? 'P1';
  const projected = recordForOption(record, option, slip.accepted?.withTerrorism ?? null);
  const premium = sheetNamed(workbook, SHEETS.premium);
  if (premium) fillPremium(premium, record, slip);
  const schedule = sheetNamed(workbook, SHEETS.schedule);
  if (schedule) {
    // The format's print area stops above the clauses: the notes go above the footer instead.
    const printed = printColumns(schedule);
    schedule.pageSetup.printArea = `${schedule.getColumn(printed.from).letter}1:${schedule.getColumn(printed.to).letter}${schedule.rowCount}`;
    fillSchedule(schedule, fillContextOf(projected, client, masters, 'PLACEMENT_SLIP'));
    fillScheduleExtras(schedule, record, slip);
  }
  const annexure = sheetNamed(workbook, SHEETS.annexure);
  if (annexure) fillAnnexure(annexure, projected);
  const risk = sheetNamed(workbook, SHEETS.risk);
  if (risk) fillRiskDetails(risk, record);
  workbook.creator = 'Fiducial';
}
