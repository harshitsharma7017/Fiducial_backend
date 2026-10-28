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
import { documentNotes, fillContextOf } from '../proposals/rfq-template.ts';
import {
  addonCovers,
  annexure,
  frameWorkbook,
  header,
  labelled,
  money,
  riskDetails,
  sectionHeading,
  schedule,
  title,
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
  const sheet = workbook.addWorksheet('premium details');
  const span = 2 + (renewal ? 2 : 0) + qcr.insurers.length;
  sheet.columns = [
    { width: 26 },
    ...(renewal ? [{ width: 18 }, { width: 18 }] : []),
    { width: 18 },
    ...qcr.insurers.map(() => ({ width: 22 })),
  ];
  title(sheet, `PREMIUM COMPARISON — ${renewal ? 'RENEWAL' : 'NEW BUSINESS'}`, span);
  labelled(sheet, 'Insured Name:', record.client.name, span);
  labelled(sheet, 'Reference:', record.reference, span);
  if (renewal && record.existing) {
    labelled(sheet, 'Existing insurer:', record.existing.insurer, span);
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
    sectionHeading(
      sheet,
      `${QUOTE_OPTION_LABELS[option.option]} — premium with and without terrorism`,
      span,
    );
    const quotes = qcr.insurers.map((insurer) =>
      option.quotes.find((quote) => quote.insurerId === insurer.insurerId),
    );
    const head = header(sheet, [
      'Coverage Section',
      ...(renewal ? ['Existing sum insured', 'Existing premium'] : []),
      'Sum insured',
      ...qcr.insurers.map(
        (insurer, index) =>
          `${insurer.company}, ${insurer.branch}${quotes[index]?.lowest ? ' (lowest total)' : ''}`,
      ),
    ]);
    quotes.forEach((quote, index) => {
      if (!quote?.lowest) return;
      // The lowest quote's heading is green; navy text reads on it where white would not.
      const cell = head.getCell((renewal ? 4 : 2) + index + 1);
      cell.fill = LOWEST_FILL;
      cell.font = { bold: true, color: { argb: SECTION_HEADING_FILL_ARGB } };
    });
    const firstColumn = renewal ? 5 : 3;
    const moneyColumns = Array.from({ length: span - 1 }, (_, index) => index + 2);
    const quoted = (premium: string | null | undefined) =>
      premium ? Number(premium) : 'Not quoted';
    for (const section of option.sections) {
      const existing = renewal
        ? [amount(section.existingSumInsured), amount(section.existingPremium)]
        : [];
      if (section.code === 'FIRE') {
        // Fire is quoted with and without terrorism, as the RFQ asks: both premiums are shown,
        // each when at least one insurer gave it.
        const kinds = (['withTerrorism', 'withoutTerrorism'] as const).filter((kind) =>
          quotes.some((quote) => quote && quote.fire[kind] !== null),
        );
        kinds.forEach((kind, index) => {
          money(
            sheet.addRow([
              `${section.name} (premium ${kind === 'withTerrorism' ? 'with' : 'without'} terrorism)`,
              ...(index === 0 ? existing : renewal ? [null, null] : []),
              index === 0 ? amount(section.sumInsured) : null,
              ...quotes.map((quote) => (quote ? quoted(quote.fire[kind]) : null)),
            ]),
            moneyColumns,
          );
        });
        continue;
      }
      const row = sheet.addRow([
        section.name,
        ...existing,
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
    const totalRows = (
      suffix: string,
      pick: (quote: Quote) => Totals | null,
      existing: boolean,
    ) => {
      const values = (key: keyof Totals) => [
        ...(renewal ? [null, existing ? amount(option.existing?.[key] ?? null) : null] : []),
        null,
        ...quotes.map((quote) => {
          if (!quote) return null;
          const totals = pick(quote);
          return totals ? Number(totals[key]) : 'Not quoted';
        }),
      ];
      const rows = [
        sheet.addRow([`Net Premium${suffix}`, ...values('net')]),
        sheet.addRow([`Add: GST ${qcr.gstRatePercent}%`, ...values('gst')]),
        sheet.addRow([`Total Premium${suffix}`, ...values('total')]),
      ];
      for (const row of rows) {
        row.font = { bold: true };
        money(row, moneyColumns);
      }
      return rows[2]!;
    };
    // Each block when at least one insurer has its figures.
    const any = (pick: (quote: Quote) => Totals | null) =>
      quotes.some((quote) => quote && pick(quote) !== null);
    const totalWith =
      hasFire && any(withTerrorism) ? totalRows(' (with terrorism)', withTerrorism, false) : null;
    const totalWithout = !hasFire
      ? totalRows('', (quote) => quote.totals, true)
      : any(withoutTerrorism)
        ? totalRows(' (without terrorism)', withoutTerrorism, true)
        : null;
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
        ...(renewal ? [null, null] : []),
        null,
        ...quotes.map((quote) => amount(quote?.terrorismExtra ?? null)),
      ]);
      terrorismRow.font = { italic: true };
      money(terrorismRow, moneyColumns);
    }
    for (const difference of option.differences) {
      labelled(
        sheet,
        `Differs: ${difference.topic}`,
        difference.values.map((value) => `${name(value.insurerId)}: ${value.value}`).join('; '),
        span,
      );
    }
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

/** The built-in QCR layout. */
export function buildQcrWorkbookDocument(
  record: ProposalRecord,
  client: ClientDoc,
  masters: RfqMasters & { addons: readonly CatalogItem<'addons'>[] },
  qcr: Qcr,
): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Fiducial';
  comparison(workbook, record, qcr, documentNotes(fillContextOf(record, client, masters, 'QCR')));
  schedule(workbook, record, client, masters, 'QCR');
  annexure(workbook, record);
  riskDetails(workbook, record);
  addonCovers(workbook, record, masters.addons);
  frameWorkbook(workbook);
  return workbook;
}
