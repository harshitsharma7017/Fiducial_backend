import {
  QUOTE_OPTION_LABELS,
  formatDate,
  formatIndianNumber,
  type CatalogItem,
  type Qcr,
  type QcrOption,
  type TemplateCheck,
} from '../../shared/index.ts';
import type ExcelJS from 'exceljs';
import {
  cellText,
  clearCells,
  findColumn,
  findRow,
  findRows,
  hideRow,
  hideRowsBetween,
  highlightHeading,
  insertRows,
  labelKey,
  printColumns,
  printRows,
  restyle,
  setValue,
  sheetNamed,
} from '../documents/excel-template.ts';
import { NOTE_FILL_ARGB } from '../documents/document-theme.ts';
import { letterheadOf } from '../documents/sheet-pdf.ts';
import type { ClientDoc } from '../clients/client.model.ts';
import {
  PREMIUM_ROWS,
  SHEETS,
  amount,
  dayBefore,
  documentNotes,
  fillAddonSheets,
  fillAnnexure,
  fillContextOf,
  fillRiskDetails,
  fillSchedule,
  findLocationHeader,
  policyYear,
  quoteBlockRows,
  quoteBlocks,
} from '../proposals/rfq-template.ts';
import type { RfqMasters } from '../proposals/rfq-workbook.ts';

// The QCR in the client's own template (QC-4, QC-5): "premium details" becomes the comparison —
// the existing policy and up to five insurers per option, net, GST and total as formulas with
// their values, the lowest total marked — followed by the payment, recommendation and remarks;
// the schedule, annexure, risk details and add-on sheets are filled as on the RFQ.

// A stronger green than the template's own light-green cells, so the lowest total stands out.
const LOWEST_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FF92D050' },
};

/** Checks that a workbook is a QCR template the engine can fill. */
export function checkQcrTemplate(workbook: ExcelJS.Workbook): TemplateCheck {
  const problems: string[] = [];
  const premium = sheetNamed(workbook, SHEETS.premium);
  const schedule = sheetNamed(workbook, SHEETS.schedule);
  if (!premium) problems.push('The "premium details" sheet is missing.');
  if (!schedule) problems.push('The "schedule" sheet is missing.');
  if (premium) {
    const blocks = findRows(premium, 'Coverage Section');
    if (blocks.length === 0) problems.push('"premium details" has no "Coverage Section" table.');
    const top = blocks[0];
    if (top && !findColumn(premium, top + 1, 'Insurer-1')) {
      problems.push('"premium details" has no "Insurer-1" column.');
    }
    if (!findRow(premium, 'Net Premium'))
      problems.push('"premium details" has no "Net Premium" row.');
  }
  if (schedule) {
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
  const letterhead = letterheadOf(workbook);
  return {
    ok: problems.length === 0,
    problems,
    sheets: workbook.worksheets.map((sheet) => sheet.name),
    letterhead: { logo: letterhead.logo !== null, address: letterhead.address },
  };
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

const insurerName = (qcr: Qcr, insurerId: string) => {
  const insurer = qcr.insurers.find((item) => item.insurerId === insurerId);
  return insurer ? `${insurer.company}, ${insurer.branch}` : 'Unknown insurer';
};

const rupees = (value: string) => `Rs ${formatIndianNumber(value, 2)}/-`;

/** A formula cell with its value, so the file and the PDF show the figure before Excel recalculates. */
function formula(
  sheet: ExcelJS.Worksheet,
  row: number,
  column: number,
  text: string,
  result: string | null,
) {
  const cell = sheet.getCell(row, column);
  cell.value = {
    formula: text,
    result: result === null ? 0 : Number(result),
  };
}

function fillPremiumComparison(
  sheet: ExcelJS.Worksheet,
  context: ReturnType<typeof fillContextOf>,
  qcr: Qcr,
) {
  const { record, renewal } = context;
  const start = record.policyStart ?? record.dueDate;
  const year = policyYear(start);
  const previous = policyYear(`${Number(start.slice(0, 4)) - 1}`);
  const rate = Number(qcr.gstRatePercent) / 100;
  const expiry =
    record.existingPolicy?.periodEnd ?? (record.policyStart ? dayBefore(record.policyStart) : null);

  setValue(
    sheet,
    1,
    1,
    renewal
      ? `PREMIUM COMPARISON FOR THE RENEWAL OF ${year}`
      : `PREMIUM COMPARISON FOR NEW BUSINESS ${year}`,
  );
  const insuredRow = findRow(sheet, 'Insured Name', { prefix: true });
  if (insuredRow) setValue(sheet, insuredRow, 1, `Insured Name: ${record.client.name}`);
  const expiryRow = findRow(sheet, 'Policy Expiry Date', { prefix: true });
  if (expiryRow) {
    setValue(
      sheet,
      expiryRow,
      1,
      renewal
        ? `Policy Expiry Date: ${expiry ? formatDate(expiry) : ''}`
        : `Policy Start Date: ${record.policyStart ? formatDate(record.policyStart) : 'From the date of payment'}`,
    );
  }
  // The policy's name on the first page, under the dates (client review, 27 Oct 2026).
  const nameAfter = expiryRow ?? insuredRow;
  if (record.product && nameAfter) {
    insertRows(sheet, nameAfter + 1, 1, nameAfter);
    clearCells(sheet, { from: nameAfter + 1, to: nameAfter + 1 }, printColumns(sheet));
    setValue(sheet, nameAfter + 1, 1, `Policy Name: ${record.product.name}`);
  }

  const plans: { option: QcrOption['option']; caption: string }[] = quoteBlocks(renewal);
  const quoted = new Set(
    qcr.options.filter((option) => option.quotes.length > 0).map((option) => option.option),
  );

  quoteBlockRows(sheet, plans, quoted).forEach((top, index) => {
    const end = findRow(sheet, 'Total Premium', { from: top }) ?? top + 20;
    const plan = plans[index];
    const data = plan ? qcr.options.find((option) => option.option === plan.option) : undefined;
    // An option no insurer quoted has nothing to compare: its block is hidden.
    if (!plan || !data || data.quotes.length === 0) {
      for (let row = top - 1; row <= end; row += 1) sheet.getRow(row).hidden = true;
      return;
    }
    const existingColumn = findColumn(sheet, top, 'Existing Policy', true) ?? 2;
    const quoteColumn = findColumn(sheet, top, 'Renewal Policy', true) ?? 4;
    setValue(
      sheet,
      top,
      existingColumn,
      renewal ? `Existing Policy ${previous}` : 'Existing Policy (not applicable)',
    );
    setValue(sheet, top, quoteColumn, `${renewal ? 'Renewal' : 'Proposed'} Policy ${year}`);
    const namesRow = top + 1;
    const insurerColumns = [1, 2, 3, 4, 5].map(
      (n) => findColumn(sheet, namesRow, `Insurer-${n}`) ?? quoteColumn + n,
    );
    // The existing insurer where the template says "Insurer Name".
    const insurerLabel = findColumn(sheet, namesRow, 'Insurer Name');
    if (insurerLabel) {
      setValue(
        sheet,
        namesRow,
        insurerLabel,
        renewal && record.existing ? record.existing.insurer : '—',
      );
    }
    const captionRow =
      findRow(sheet, 'Renewal Quote Option', {
        column: quoteColumn,
        from: top,
        to: top + 4,
        prefix: true,
      }) ??
      findRow(sheet, 'Quote Option', {
        column: quoteColumn,
        from: top,
        to: top + 4,
        prefix: true,
      }) ??
      top + 3;
    setValue(sheet, captionRow, quoteColumn, plan.caption);
    for (let row = top; row <= captionRow; row += 1) {
      highlightHeading(sheet, row, printColumns(sheet));
    }
    const sumColumn = findColumn(sheet, namesRow, 'Sum Insured') ?? quoteColumn;
    const existingSum = findColumn(sheet, top + 2, 'Sum Insured') ?? existingColumn;
    const existingPremium = existingSum + 1;
    // Left out: the existing policy's columns for new business, and insurer columns not used.
    if (!renewal) {
      for (const column of new Set([existingColumn, existingSum, existingPremium])) {
        sheet.getColumn(column).hidden = true;
      }
    }
    insurerColumns.slice(qcr.insurers.length).forEach((column) => {
      sheet.getColumn(column).hidden = true;
    });

    const quotes = qcr.insurers.map((insurer) =>
      data.quotes.find((quote) => quote.insurerId === insurer.insurerId),
    );
    insurerColumns.forEach((column, position) => {
      const insurer = qcr.insurers[position];
      const quote = quotes[position];
      setValue(
        sheet,
        namesRow,
        column,
        insurer
          ? `${insurer.company}, ${insurer.branch}${quote?.lowest ? '\n(lowest total)' : ''}`
          : null,
      );
      // B3: long insurer names wrap within their column so they are not clipped in the PDF; the
      // lowest column is also tinted and bold.
      if (insurer) {
        const cell = sheet.getCell(namesRow, column);
        restyle(cell, {
          ...(quote?.lowest ? { fill: LOWEST_FILL } : {}),
          font: { ...cell.font, bold: quote?.lowest ?? false },
          alignment: { ...cell.alignment, wrapText: true, vertical: 'top' },
        });
      }
    });

    let first = 0;
    let last = 0;
    for (let row = captionRow + 1; row < end; row += 1) {
      const label = labelKey(cellText(sheet.getCell(row, 1)));
      if (label === 'net premium') break;
      const code = PREMIUM_ROWS.get(label);
      if (!code) continue;
      if (!first) first = row;
      last = row;
      const section = data.sections.find((item) => item.code === code);
      // B5: a section not in the comparison (not marked required) is omitted — its row is hidden,
      // never shown as "Not required". It carries no figure, so the Net Premium SUM is unaffected.
      if (!section) {
        sheet.getRow(row).hidden = true;
        continue;
      }
      if (renewal) {
        setValue(sheet, row, existingSum, amount(section.existingSumInsured ?? null), {
          rupees: true,
        });
        setValue(sheet, row, existingPremium, amount(section.existingPremium ?? null), {
          rupees: true,
        });
      }
      setValue(sheet, row, sumColumn, amount(section.sumInsured), { rupees: true });
      insurerColumns.forEach((column, position) => {
        const quote = quotes[position];
        if (!quote) return;
        const premium = quote.premiums.find((item) => item.code === code)?.premium ?? null;
        setValue(sheet, row, column, premium === null ? 'Not quoted' : Number(premium), {
          rupees: true,
        });
      });
    }
    if (!first) return;

    // Net, GST at the case's rate and total, as formulas carrying the quote entries' figures.
    const netRow = findRow(sheet, 'Net Premium', { from: top, to: end }) ?? end - 2;
    const gstRow = findRow(sheet, 'Add: GST', { from: top, to: end, prefix: true }) ?? netRow + 1;
    const totalRow = end;
    setValue(sheet, gstRow, 1, `Add: GST ${qcr.gstRatePercent}%`);
    const columns: {
      column: number;
      totals: { net: string; gst: string; total: string } | null;
      lowest: boolean;
    }[] = [
      ...(renewal ? [{ column: existingPremium, totals: data.existing, lowest: false }] : []),
      ...insurerColumns.map((column, position) => ({
        column,
        totals: quotes[position]?.totals ?? null,
        lowest: quotes[position]?.lowest ?? false,
      })),
    ];
    for (const { column, totals, lowest } of columns) {
      const letter = sheet.getColumn(column).letter;
      if (!totals) {
        for (const row of [netRow, gstRow, totalRow]) sheet.getCell(row, column).value = null;
        continue;
      }
      formula(sheet, netRow, column, `SUM(${letter}${first}:${letter}${last})`, totals.net);
      formula(sheet, gstRow, column, `ROUND(${letter}${netRow}*${rate},2)`, totals.gst);
      formula(sheet, totalRow, column, `SUM(${letter}${netRow}:${letter}${gstRow})`, totals.total);
      if (lowest) {
        const cell = sheet.getCell(totalRow, column);
        restyle(cell, { fill: LOWEST_FILL, font: { ...cell.font, bold: true } });
      }
    }
  });

  // The broker's part (QC-3): payment, then the recommendation, remarks and coverage differences.
  const paymentRow = findRow(sheet, 'Cheque / payment in favour of', { prefix: true });
  const width = printColumns(sheet);
  const lines: string[] = [];
  if (qcr.recommendedInsurerId && qcr.recommendedOption) {
    lines.push(
      `Our recommendation: ${insurerName(qcr, qcr.recommendedInsurerId)}, ${QUOTE_OPTION_LABELS[qcr.recommendedOption]}${qcr.recommendation ? `. ${qcr.recommendation}` : ''}`,
    );
  } else if (qcr.recommendation) {
    lines.push(`Our recommendation: ${qcr.recommendation}`);
  }
  if (qcr.remarks) lines.push(`Remarks: ${qcr.remarks}`);
  for (const option of qcr.options) {
    if (option.differences.length === 0) continue;
    lines.push(
      `Coverage differences, ${QUOTE_OPTION_LABELS[option.option]}: ${option.differences
        .map(
          (difference) =>
            `${difference.topic} — ${difference.values.map((value) => `${insurerName(qcr, value.insurerId)}: ${value.value}`).join('; ')}`,
        )
        .join(' | ')}`,
    );
  }
  if (paymentRow) {
    setValue(sheet, paymentRow, 1, `Cheque / payment in favour of: ${qcr.paymentInFavourOf ?? ''}`);
    if (lines.length > 0) {
      const at = paymentRow + 1;
      insertRows(sheet, at, lines.length, paymentRow);
      lines.forEach((line, offset) => {
        const row = at + offset;
        clearCells(sheet, { from: row, to: row }, { from: width.from, to: width.to });
        mergeAcross(sheet, row, width.from, width.to);
        setValue(sheet, row, width.from, line);
        const cell = sheet.getCell(row, width.from);
        restyle(cell, {
          alignment: { wrapText: true, vertical: 'top', horizontal: 'left' },
          font: { ...cell.font, bold: offset === 0 && line.startsWith('Our recommendation') },
        });
        sheet.getRow(row).height = Math.max(18, Math.ceil(line.length / 150) * 15);
      });
    }
    // Not given: the row is left out (after the lines above have taken its style).
    if (!qcr.paymentInFavourOf) hideRow(sheet, paymentRow);
  }
  fillNotes(sheet, context, qcr, paymentRow === null ? null : paymentRow + lines.length);
}

/**
 * The note section on the first page, highlighted, directly under the payment and the
 * recommendation (client review, 27 Oct 2026): the terrorism note with the recommended (else the
 * lowest) quote's extra premium per option, then the case's notes and the standard QCR notes from
 * the notes master (the template's own notes when the master has none). The template's note rows
 * further down are left out.
 */
function fillNotes(
  sheet: ExcelJS.Worksheet,
  context: ReturnType<typeof fillContextOf>,
  qcr: Qcr,
  after: number | null,
) {
  const terrorismRow = findRow(sheet, '*New / Renewal Quote is given as per recommended coverage', {
    prefix: true,
  });
  const headingRow = findRow(sheet, 'NOTE:');
  const notes: string[] = [];
  if (terrorismRow) {
    const extras = qcr.options.flatMap((option) => {
      const quote =
        option.quotes.find((item) => item.insurerId === qcr.recommendedInsurerId) ??
        option.quotes.find((item) => item.lowest);
      return quote?.terrorismExtra
        ? [`${rupees(quote.terrorismExtra)} for ${QUOTE_OPTION_LABELS[option.option]}`]
        : [];
    });
    const text = cellText(sheet.getCell(terrorismRow, 1));
    // No terrorism figure to give: the sentence with blanks for it is left out.
    notes.push(
      extras.length > 0
        ? text.replace(
            /If you opt for the same,[\s\S]*$/,
            `If you opt for terrorism cover, additional premium of ${extras.join(' & ')} (before GST) will be charged.`,
          )
        : text.replace(/\s*If you opt for the same,[\s\S]*$/, ''),
    );
  }
  // The template's own notes, under its "NOTE:" heading, until a blank row.
  const templateNotes: string[] = [];
  let lastNoteRow = Math.max(terrorismRow ?? 0, headingRow ?? 0);
  if (headingRow) {
    for (let row = headingRow + 1; row <= sheet.rowCount; row += 1) {
      const text = cellText(sheet.getCell(row, 1)).trim();
      if (!text) break;
      templateNotes.push(text);
      lastNoteRow = row;
    }
  }
  const standard = context.masters.notes.some((note) => note.active && note.onQcr);
  notes.push(...(standard ? [] : templateNotes), ...documentNotes(context));
  if (notes.length === 0) return;

  const firstNoteRow = Math.min(
    ...[terrorismRow, headingRow].filter((row): row is number => row !== null),
    Number.MAX_SAFE_INTEGER,
  );
  const at =
    (after ?? (firstNoteRow < Number.MAX_SAFE_INTEGER ? firstNoteRow - 1 : printRows(sheet).to)) +
    1;
  // The template's note rows (and the blank rows before them) are left out below the new ones.
  const old = lastNoteRow >= at ? { from: at, to: lastNoteRow } : null;
  insertRows(sheet, at, notes.length + 1, Math.max(at - 1, 1));
  if (old) hideRowsBetween(sheet, old.from + notes.length + 1, old.to + notes.length + 2);
  const width = printColumns(sheet);
  const fill: ExcelJS.Fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: NOTE_FILL_ARGB },
  };
  const border: Partial<ExcelJS.Borders> = {
    top: { style: 'thin' },
    left: { style: 'thin' },
    bottom: { style: 'thin' },
    right: { style: 'thin' },
  };
  ['NOTE:', ...notes].forEach((text, offset) => {
    const row = at + offset;
    clearCells(sheet, { from: row, to: row }, width);
    mergeAcross(sheet, row, width.from, width.to);
    setValue(sheet, row, width.from, text);
    const cell = sheet.getCell(row, width.from);
    restyle(cell, {
      fill,
      border,
      font: { ...cell.font, bold: offset === 0, color: { argb: 'FF000000' } },
      alignment: { wrapText: true, vertical: 'top', horizontal: 'left' },
    });
    sheet.getRow(row).hidden = false;
    sheet.getRow(row).height = offset === 0 ? 18 : Math.max(18, Math.ceil(text.length / 140) * 15);
  });
}

/** The schedule's Warranties / Conditions rows: each insurer's deductibles and conditions. */
function fillConditions(
  sheet: ExcelJS.Worksheet,
  qcr: Qcr,
  versions: ReadonlyMap<string, { deductibles: string | null; conditions: string | null }>,
) {
  const title = findRow(sheet, 'Warranties / Conditions');
  const excess = title ? findRow(sheet, 'Excess', { from: title + 1 }) : null;
  if (!title || !excess) return;
  const lines = qcr.insurers.flatMap((insurer) => {
    const terms = versions.get(insurer.insurerId);
    if (!terms || (!terms.deductibles && !terms.conditions)) return [];
    return [
      `${insurer.company}, ${insurer.branch}: ${[
        terms.deductibles ? `Deductibles: ${terms.deductibles}` : null,
        terms.conditions ? `Conditions: ${terms.conditions}` : null,
      ]
        .filter(Boolean)
        .join('. ')}`,
    ];
  });
  const free = excess - title - 1;
  if (lines.length > free && free > 0) insertRows(sheet, excess, lines.length - free, excess - 1);
  const printed = printColumns(sheet);
  lines.forEach((line, offset) => {
    const row = title + 1 + offset;
    mergeAcross(sheet, row, printed.from, printed.to);
    setValue(sheet, row, printed.from, line);
    restyle(sheet.getCell(row, printed.from), { alignment: { wrapText: true, vertical: 'top' } });
    sheet.getRow(row).height = Math.max(15, Math.ceil(line.length / 110) * 15);
  });
  // Rows the template reserved but no insurer filled are hidden, so no blank framed row prints
  // (the whole block when no insurer stated deductibles or conditions).
  hideRowsBetween(sheet, title + 1 + lines.length, title + 1 + Math.max(lines.length, free));
}

/** Fills the client's QCR template in place. */
export function fillQcrTemplate(
  workbook: ExcelJS.Workbook,
  record: Parameters<typeof fillContextOf>[0],
  client: ClientDoc,
  masters: RfqMasters & { addons: readonly CatalogItem<'addons'>[] },
  qcr: Qcr,
  terms: ReadonlyMap<string, { deductibles: string | null; conditions: string | null }>,
): void {
  const context = fillContextOf(record, client, masters, 'QCR');
  const sheet = (name: string) => sheetNamed(workbook, name);
  const premium = sheet(SHEETS.premium);
  if (premium) fillPremiumComparison(premium, context, qcr);
  const schedule = sheet(SHEETS.schedule);
  if (schedule) {
    fillSchedule(schedule, context);
    fillConditions(schedule, qcr, terms);
  }
  const annexure = sheet(SHEETS.annexure);
  if (annexure) fillAnnexure(annexure, record);
  const risk = sheet(SHEETS.risk);
  if (risk) fillRiskDetails(risk, record);
  fillAddonSheets(workbook, masters.addons, record);
  workbook.creator = 'Fiducial';
}
