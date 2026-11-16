import {
  QUOTE_OPTION_LABELS,
  formatDate,
  type CatalogItem,
  type ProposalRecord,
  type Qcr,
} from '../../shared/index.ts';
import ExcelJS from 'exceljs';
import type { ClientDoc } from '../clients/client.model.ts';
import { NOTE_FILL_ARGB, SECTION_HEADING_FILL_ARGB } from '../documents/document-theme.ts';
import { fillTerrorismNote } from './qcr-notes.ts';
import { documentNotes, fillContextOf } from '../proposals/rfq-template.ts';
import {
  addonCovers,
  annexure,
  frameWorkbook,
  header,
  labelled,
  money,
  premiumBand,
  riskDetails,
  sectionHeading,
  schedule,
  title,
  TOTAL_RED,
  type RfqMasters,
} from '../proposals/rfq-workbook.ts';

// The built-in QCR, used until the client's QCR template is uploaded: the premium comparison per
// option (existing policy and insurers side by side, the lowest total marked), the broker's
// recommendation, remarks and payment, then the schedule, annexure and risk details.

// A stronger green than the template's own light-green cells, so the lowest total stands out.
const LOWEST_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FF92D050' },
};
const amount = (value: string | null) => (value === null ? null : Number(value));

function comparison(
  workbook: ExcelJS.Workbook,
  record: ProposalRecord,
  qcr: Qcr,
  notes: readonly string[],
) {
  const renewal = record.type === 'EXISTING';
  // Each option compares the insurers on its own sum insured: the existing policy's sum insured
  // and premium are not repeated in its blocks (client review); its insurer and number are above.
  const sheet = workbook.addWorksheet('premium details');
  const span = 2 + qcr.insurers.length;
  sheet.columns = [{ width: 26 }, { width: 18 }, ...qcr.insurers.map(() => ({ width: 22 }))];
  // The reference above the heading, the number only, at the right (client, 16 Nov 2026); not
  // boxed, as it is outside the table.
  const reference = sheet.addRow([record.reference]);
  if (span > 1) sheet.mergeCells(reference.number, 1, reference.number, span);
  const referenceCell = reference.getCell(1);
  referenceCell.alignment = { horizontal: 'right', vertical: 'middle' };
  referenceCell.font = { bold: true };
  referenceCell.border = { top: {}, left: {}, bottom: {}, right: {} };
  title(sheet, `PREMIUM COMPARISON — ${renewal ? 'RENEWAL' : 'NEW BUSINESS'}`, span);
  labelled(sheet, 'Insured Name:', record.client.name, span);
  if (record.existing) {
    labelled(sheet, 'Existing Insurer:', record.existing.insurer, span);
    labelled(sheet, 'Existing Policy No:', record.existing.policyNumber ?? '', span);
  }
  if (record.policyStart) labelled(sheet, 'Policy starts:', formatDate(record.policyStart), span);
  // The policy's name on the first page (client review, 27 Oct 2026).
  if (record.product) labelled(sheet, 'Policy Name:', record.product.name, span);
  const name = (insurerId: string) => {
    const insurer = qcr.insurers.find((item) => item.insurerId === insurerId);
    return insurer ? `${insurer.company}, ${insurer.branch}` : '';
  };

  for (const option of qcr.options.filter((item) => item.quotes.length > 0)) {
    sheet.addRow([]);
    sectionHeading(sheet, QUOTE_OPTION_LABELS[option.option], span);
    const quotes = qcr.insurers.map((insurer) =>
      option.quotes.find((quote) => quote.insurerId === insurer.insurerId),
    );
    const head = header(sheet, [
      'Coverage Section',
      // The renewal's Existing block compares the insurers on last year's sum insured.
      option.option === 'EXISTING' ? 'Existing sum insured' : 'Sum insured',
      ...qcr.insurers.map(
        (insurer, index) =>
          `${insurer.company}, ${insurer.branch}${quotes[index]?.lowest ? ' (lowest total)' : ''}`,
      ),
    ]);
    quotes.forEach((quote, index) => {
      if (!quote?.lowest) return;
      // The lowest quote's heading is green; navy text reads on it where white would not.
      const cell = head.getCell(3 + index);
      cell.fill = LOWEST_FILL;
      cell.font = { bold: true, color: { argb: SECTION_HEADING_FILL_ARGB } };
    });
    const firstColumn = 3;
    const moneyColumns = Array.from({ length: span - 1 }, (_, index) => index + 2);
    const quoted = (premium: string | null | undefined) =>
      premium ? Number(premium) : 'Not quoted';
    for (const section of option.sections) {
      if (section.code === 'FIRE') {
        // One plain "Fire" row (change request QCR-3, QCR-4): Fire with terrorism where the
        // insurer quoted it so, else the one figure it gave. The premium bands below show the
        // totals with and without terrorism.
        money(
          sheet.addRow([
            section.name,
            amount(section.sumInsured),
            ...quotes.map((quote) =>
              quote ? quoted(quote.fire.withTerrorism ?? quote.fire.withoutTerrorism) : null,
            ),
          ]),
          moneyColumns,
        );
        continue;
      }
      const row = sheet.addRow([
        section.name,
        amount(section.sumInsured),
        ...quotes.map((quote) =>
          quote ? quoted(quote.premiums.find((item) => item.code === section.code)?.premium) : null,
        ),
      ]);
      money(row, moneyColumns);
    }

    // Net, GST and total with terrorism and without (Fire is the only section it changes). The
    // comparison, and the lowest total, use Fire without terrorism where the insurer quoted it so.
    type Quote = (typeof option.quotes)[number];
    type Totals = Quote['totals'];
    const hasFire = option.sections.some((section) => section.code === 'FIRE');
    const withTerrorism = (quote: Quote): Totals | null =>
      quote.fire.withTerrorism === null
        ? quote.fire.withoutTerrorism === null
          ? quote.totals
          : null
        : quote.fire.withoutTerrorism === null
          ? quote.totals
          : quote.totalsWithTerrorism;
    const withoutTerrorism = (quote: Quote): Totals | null =>
      quote.fire.withoutTerrorism !== null || quote.fire.withTerrorism === null
        ? quote.totals
        : null;
    const totalRows = (band: string, pick: (quote: Quote) => Totals | null) => {
      premiumBand(sheet, band, span);
      const values = (key: keyof Totals) => [
        null,
        ...quotes.map((quote) => {
          if (!quote) return null;
          const totals = pick(quote);
          return totals ? Number(totals[key]) : 'Not quoted';
        }),
      ];
      const rows = [
        sheet.addRow(['Net Premium', ...values('net')]),
        sheet.addRow([`Add: GST ${qcr.gstRatePercent}%`, ...values('gst')]),
        sheet.addRow(['Total Premium', ...values('total')]),
      ];
      for (const row of rows) {
        row.font = { bold: true };
        money(row, moneyColumns);
      }
      // The total in red, as the client's format.
      rows[2]!.font = { bold: true, color: TOTAL_RED };
      return rows[2]!;
    };
    // Each block when at least one insurer has its figures.
    const any = (pick: (quote: Quote) => Totals | null) =>
      quotes.some((quote) => quote && pick(quote) !== null);
    // "Premium without terrorism" first, then "Premium with terrorism", as the client's format.
    const totalWithout = !hasFire
      ? totalRows('Premium', (quote) => quote.totals)
      : any(withoutTerrorism)
        ? totalRows('Premium without terrorism', withoutTerrorism)
        : null;
    const totalWith =
      hasFire && any(withTerrorism) ? totalRows('Premium with terrorism', withTerrorism) : null;
    quotes.forEach((quote, index) => {
      if (!quote?.lowest) return;
      const row = totalWithout && withoutTerrorism(quote) ? totalWithout : totalWith;
      if (row) row.getCell(firstColumn + index).fill = LOWEST_FILL;
    });
    // B2: the terrorism cover's own extra net premium, per insurer that quoted both Fire figures.
    if (
      quotes.some((quote) => quote?.terrorismExtra !== null && quote?.terrorismExtra !== undefined)
    ) {
      const terrorismRow = sheet.addRow([
        'Terrorism, extra net premium',
        null,
        ...quotes.map((quote) => amount(quote?.terrorismExtra ?? null)),
      ]);
      terrorismRow.font = { italic: true };
      money(terrorismRow, moneyColumns);
    }
    // The coverage differences are not printed (client review); the QCR tab shows them.
  }
  sheet.addRow([]);
  labelled(sheet, 'Cheque / payment in favour of:', qcr.paymentInFavourOf ?? '', span);
  if (qcr.recommendedInsurerId && qcr.recommendedOption) {
    labelled(
      sheet,
      'Our recommendation:',
      `${name(qcr.recommendedInsurerId)}, ${QUOTE_OPTION_LABELS[qcr.recommendedOption]}${qcr.recommendation ? `. ${qcr.recommendation}` : ''}`,
      span,
    );
  }
  if (qcr.remarks) labelled(sheet, 'Remarks:', qcr.remarks, span);
  // The note section, highlighted, directly under the recommendation (client review, 27 Oct
  // 2026).
  if (notes.length > 0) {
    const fill: ExcelJS.Fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: NOTE_FILL_ARGB },
    };
    ['NOTE:', ...notes].forEach((text, index) => {
      const row = sheet.addRow([text]);
      sheet.mergeCells(row.number, 1, row.number, span);
      const cell = row.getCell(1);
      cell.fill = fill;
      cell.font = { bold: index === 0 };
      cell.alignment = { wrapText: true, vertical: 'top' };
      cell.border = {
        top: { style: 'thin' },
        left: { style: 'thin' },
        bottom: { style: 'thin' },
        right: { style: 'thin' },
      };
      if (index > 0) row.height = Math.max(15, Math.ceil(text.length / 110) * 15);
    });
  }
}

/** The schedule's Option 2 and 3 columns, only for an option some insurer quoted on. */
export function quotedOptions(qcr: Qcr): { option2: boolean; option3: boolean } {
  const quoted = (option: string) =>
    qcr.options.some((item) => item.option === option && item.quotes.length > 0);
  return { option2: quoted('P2'), option3: quoted('P3') };
}

/** The built-in QCR layout. */
export function buildQcrWorkbookDocument(
  record: ProposalRecord,
  client: ClientDoc,
  masters: RfqMasters & { addons: readonly CatalogItem<'addons'>[] },
  qcr: Qcr,
): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Fiducial';
  comparison(
    workbook,
    record,
    qcr,
    documentNotes(fillContextOf(record, client, masters, 'QCR')).map((note) =>
      fillTerrorismNote(note, qcr),
    ),
  );
  schedule(workbook, record, client, masters, 'QCR', quotedOptions(qcr));
  annexure(workbook, record);
  riskDetails(workbook, record);
  addonCovers(workbook, record, masters.addons);
  frameWorkbook(workbook);
  return workbook;
}
