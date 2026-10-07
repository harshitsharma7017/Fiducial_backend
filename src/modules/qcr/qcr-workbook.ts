import {
  QUOTE_OPTION_LABELS,
  formatDate,
  type CatalogItem,
  type ProposalRecord,
  type Qcr,
} from '../../shared/index.ts';
import ExcelJS from 'exceljs';
import type { ClientDoc } from '../clients/client.model.ts';
import {
  addonCovers,
  annexure,
  header,
  labelled,
  money,
  riskDetails,
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

function comparison(workbook: ExcelJS.Workbook, record: ProposalRecord, qcr: Qcr) {
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
  const name = (insurerId: string) => {
    const insurer = qcr.insurers.find((item) => item.insurerId === insurerId);
    return insurer ? `${insurer.company}, ${insurer.branch}` : '';
  };

  for (const option of qcr.options.filter((item) => item.quotes.length > 0)) {
    sheet.addRow([]);
    sheet.addRow([
      `${QUOTE_OPTION_LABELS[option.option]} — premium (Fire section without terrorism)`,
    ]).font = {
      bold: true,
    };
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
      if (quote?.lowest) head.getCell((renewal ? 4 : 2) + index + 1).fill = LOWEST_FILL;
    });
    const firstColumn = renewal ? 5 : 3;
    for (const section of option.sections) {
      const row = sheet.addRow([
        section.name,
        ...(renewal ? [amount(section.existingSumInsured), amount(section.existingPremium)] : []),
        amount(section.sumInsured),
        ...quotes.map((quote) => {
          if (!quote) return null;
          const premium = quote.premiums.find((item) => item.code === section.code)?.premium;
          return premium ? Number(premium) : 'Not quoted';
        }),
      ]);
      money(
        row,
        Array.from({ length: span - 1 }, (_, index) => index + 2),
      );
    }
    const totals = (pick: 'net' | 'gst' | 'total') => [
      ...(renewal ? [null, amount(option.existing?.[pick] ?? null)] : []),
      null,
      ...quotes.map((quote) => amount(quote?.totals[pick] ?? null)),
    ];
    const rows = [
      sheet.addRow(['Net Premium', ...totals('net')]),
      sheet.addRow([`Add: GST ${qcr.gstRatePercent}%`, ...totals('gst')]),
      sheet.addRow(['Total Premium', ...totals('total')]),
    ];
    for (const row of rows) {
      row.font = { bold: true };
      money(
        row,
        Array.from({ length: span - 1 }, (_, index) => index + 2),
      );
    }
    quotes.forEach((quote, index) => {
      const total = rows[2];
      if (quote?.lowest && total) total.getCell(firstColumn + index).fill = LOWEST_FILL;
    });
    const extras = quotes.flatMap((quote) =>
      quote?.terrorismExtra ? [`${name(quote.insurerId)}: ₹${quote.terrorismExtra}`] : [],
    );
    if (extras.length > 0)
      labelled(sheet, 'Terrorism, extra net premium:', extras.join('; '), span);
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
  comparison(workbook, record, qcr);
  schedule(workbook, record, client, masters, 'QCR');
  annexure(workbook, record);
  riskDetails(workbook, record);
  addonCovers(workbook, record, masters.addons);
  return workbook;
}
