import type { ProposalRecord } from '../../shared/index.ts';
import type ExcelJS from 'exceljs';
import {
  COVER_CROSS,
  COVER_CROSS_ARGB,
  COVER_TICK,
  COVER_TICK_ARGB,
  NOTE_FILL_ARGB,
} from '../documents/document-theme.ts';
import {
  extendPrintRows,
  frameSheet,
  printColumns,
  sheetNamed,
} from '../documents/excel-template.ts';
import { fillTerrorismNote } from '../qcr/qcr-notes.ts';
import {
  RUPEES,
  TOTAL_RED,
  centreTables,
  header,
  labelled,
  sectionHeading,
} from './rfq-workbook.ts';
import type { RfqMasters } from './rfq-workbook.ts';

// Sections added to the RFQ whichever layout it is drawn in (change requests RFQ-4, RFQ-5, NOTE-1).
// They are separate sheets of their own, so the client's template and the built-in layout both get
// them without either being rearranged.

const amount = (value: string | null | undefined) =>
  value === null || value === undefined || value === '' ? null : Number(value);

/** Last year's premium, section by section, from the existing policy (RFQ-4). */
export function addLastYearPremium(workbook: ExcelJS.Workbook, record: ProposalRecord): void {
  const policy = record.existingPolicy;
  if (!policy || policy.sections.every((section) => !section.premium)) return;
  const sheet = workbook.addWorksheet('last year premium');
  sheet.columns = [{ width: 44 }, { width: 22 }, { width: 22 }];
  sectionHeading(sheet, 'Last year premium details', 3);
  labelled(sheet, 'Insurer:', policy.insurer, 3);
  labelled(sheet, 'Policy No:', policy.policyNumber, 3);
  header(sheet, ['Coverage Section', 'Sum Insured', 'Premium paid']);
  for (const section of policy.sections) {
    const name =
      section.code === 'FIRE'
        ? 'Fire & Allied Perils'
        : (record.sections.find((item) => item.code === section.code)?.name ?? section.code);
    const row = sheet.addRow([name, amount(section.sumInsured), amount(section.premium)]);
    for (const column of [2, 3]) row.getCell(column).numFmt = RUPEES;
  }
  const totals: [string, string | null][] = [
    ['Net Premium', policy.netPremium],
    ['GST', policy.gst],
    ['Total Premium', policy.totalPremium],
  ];
  for (const [label, value] of totals) {
    if (!value) continue;
    const row = sheet.addRow([label, null, amount(value)]);
    row.getCell(3).numFmt = RUPEES;
    row.font = label === 'Total Premium' ? { bold: true, color: TOTAL_RED } : { bold: true };
  }
  centreTables(sheet, 3);
  frameSheet(sheet, 3);
}

/** The last three years' claim experience: a tick or a cross for each year, and the amount (RFQ-5). */
export function addClaimExperience(workbook: ExcelJS.Workbook, record: ProposalRecord): void {
  if (record.claims.length === 0) return;
  const sheet = workbook.addWorksheet('claim experience');
  sheet.columns = [{ width: 18 }, { width: 18 }, { width: 22 }, { width: 44 }];
  sectionHeading(sheet, 'Last 3 years claim experience', 4);
  header(sheet, ['Policy Year', 'Claim made', 'Claim amount', 'Remarks']);
  for (const claim of record.claims) {
    const claimed = Number(claim.claimedAmount ?? 0) > 0;
    const row = sheet.addRow([
      claim.period,
      claimed ? COVER_TICK : COVER_CROSS,
      claimed ? amount(claim.claimedAmount) : null,
      claim.remarks,
    ]);
    row.getCell(3).numFmt = RUPEES;
    row.getCell(2).font = {
      bold: true,
      color: { argb: claimed ? COVER_TICK_ARGB : COVER_CROSS_ARGB },
    };
    row.getCell(2).alignment = { horizontal: 'center' };
  }
  centreTables(sheet, 4);
  frameSheet(sheet, 4);
}

/**
 * The standard notes marked for the RFQ, under the schedule in the note colours, with the
 * terrorism note's blanks filled: the RFQ has no quotes yet, so an unknown premium shows "—"
 * (NOTE-1).
 */
export function addRfqNotes(workbook: ExcelJS.Workbook, masters: RfqMasters): void {
  const sheet = sheetNamed(workbook, 'schedule');
  const notes = masters.notes
    .filter((note) => note.active && note.onRfq)
    .map((note) => fillTerrorismNote(note.text, null));
  if (!sheet || notes.length === 0) return;
  const span = printColumns(sheet).to;
  sheet.addRow([]);
  ['NOTE:', ...notes].forEach((text, index) => {
    const row = sheet.addRow([text]);
    sheet.mergeCells(row.number, 1, row.number, span);
    const cell = row.getCell(1);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NOTE_FILL_ARGB } };
    cell.font = { bold: true };
    cell.alignment = { wrapText: true, vertical: 'top', horizontal: 'left' };
    cell.border = {
      top: { style: 'thin' },
      left: { style: 'thin' },
      bottom: { style: 'thin' },
      right: { style: 'thin' },
    };
    if (index > 0) row.height = Math.max(15, Math.ceil(text.length / 100) * 15);
  });
  extendPrintRows(sheet, sheet.rowCount);
}

/** All of the RFQ's added sections. */
export function addRfqExtras(
  workbook: ExcelJS.Workbook,
  record: ProposalRecord,
  masters: RfqMasters,
): void {
  addLastYearPremium(workbook, record);
  addClaimExperience(workbook, record);
  addRfqNotes(workbook, masters);
}
