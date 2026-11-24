import { continuesPolicy } from '../../shared/case-types.ts';
import {
  WC_DATA_SHEET_CONDITIONS,
  WC_TYPE_LABELS,
  formatDate,
  formatIndianNumber,
  wcAnnualWages,
  type WcCase,
  type WcDocumentKind,
} from '../../shared/index.ts';
import {
  money,
  type DocumentModel,
  type SheetCell,
  type SheetModel,
  type SheetRow,
} from '../ghi/ghi-sheet.ts';

// The workmen compensation documents in the client's format ("WC Format.xlsx"): the Data Sheet
// sent to the client, the RFQ sent to insurers and the Quote sheet comparing their premiums. Each
// is drawn by the shared sheet engine, so Excel and PDF say the same thing and carry the
// letterhead, header and footer of every other document.

const label = (name: string, value: string): SheetRow => ({ cells: [name, value], style: 'label' });
const rupees = (value: string | null | undefined) =>
  value ? `₹${formatIndianNumber(value, value.includes('.') ? 2 : 0)}` : '—';
/** Columns: the label or S No column, the description, then three figure columns. */
const WIDTHS = [28, 40, 16, 20, 22];

const pad = (cells: SheetCell[], span: number): SheetCell[] => [
  ...cells,
  ...new Array<null>(Math.max(0, span - cells.length)).fill(null),
];

/** "Policy No: Fresh" on new business, the expiring policy's number on a renewal. */
function policyNoLine(record: WcCase): string {
  if (continuesPolicy(record.type)) {
    return `Policy No: ${record.expiringPolicy?.policyNumber ?? 'Renewal'} · Ref: ${record.reference}`;
  }
  return `Policy No: Fresh · Ref: ${record.reference}`;
}

function insuredRows(record: WcCase, forInsurers: boolean): SheetRow[] {
  return [
    label(forInsurers ? 'Insured name' : 'Name of the insured', record.client.name),
    label('Insured GST No', record.client.gstin ?? '—'),
    label(forInsurers ? 'Comm Address' : 'Address of the insured', record.client.address || '—'),
    label('Policy Period', record.policyPeriod),
    label(
      forInsurers ? 'Nature of business' : 'Nature of job of the insured',
      record.natureOfBusiness ?? '—',
    ),
    ...(record.workingHeight ? [label('Working Height', record.workingHeight)] : []),
    ...(record.riskLocation ? [label('Risk Location', record.riskLocation)] : []),
  ];
}

/** The worker categories: persons, wages per person per month and per annum, and the total. */
function employeeRows(record: WcCase, span: number): SheetRow[] {
  return [
    { cells: pad(['Employee details'], 1), style: 'section' },
    {
      cells: pad(
        ['S.No.', 'Designation', 'No of persons', 'Per Person Monthly Wages', 'Total Annual Wages'],
        span,
      ),
      style: 'header',
    },
    ...record.categories.map((category, index) => ({
      cells: pad(
        [
          index + 1,
          category.designation,
          category.persons,
          money(category.monthlyWage),
          money(wcAnnualWages(category)),
        ],
        span,
      ),
    })),
    {
      cells: pad(
        ['Total', null, record.totals.persons, null, money(record.totals.annualWages)],
        span,
      ),
      style: 'total',
    },
  ];
}

function listRows(heading: string, items: readonly string[]): SheetRow[] {
  if (items.length === 0) return [];
  return [
    { cells: [heading], style: 'section' },
    ...items.map((item, index) => label(String(index + 1), item)),
  ];
}

function expiringRows(record: WcCase): SheetRow[] {
  const expiring = record.expiringPolicy;
  if (!continuesPolicy(record.type) || !expiring) return [];
  return [
    {
      cells: [`Expiring Policy details${expiring.policyYear ? ` ${expiring.policyYear}` : ''}`],
      style: 'section',
    },
    ...(expiring.policyNumber ? [label('Policy No:', expiring.policyNumber)] : []),
    label('No of persons:', expiring.persons === null ? '—' : String(expiring.persons)),
    label('Sum Insured:', rupees(expiring.sumInsured)),
    label('Premium incl GST:', rupees(expiring.premiumInclGst)),
    label('Coverage option:', expiring.coverageOption ?? '—'),
    label('Claim Amount', rupees(expiring.claimAmount)),
    label('Insurer:', expiring.insurer ?? '—'),
    label('Changes in renewal quote:', expiring.changes ?? 'Nil'),
  ];
}

/** The Data Sheet the client fills: insured details, worker categories and the ESI conditions. */
function dataSheet(record: WcCase): SheetModel {
  const span = WIDTHS.length;
  return {
    name: 'Data Sheet',
    widths: WIDTHS,
    rows: [
      { cells: [`Ref: ${record.reference} (${WC_TYPE_LABELS[record.type]})`] },
      { cells: pad(['Data Sheet for Workmen Compensation Insurance'], span), style: 'title' },
      ...insuredRows(record, false),
      {
        cells: [
          'S.No',
          'Category of Workers',
          'No. of Persons',
          'Total Wages Per Month',
          'Total Wages Per Annum',
        ],
        style: 'header',
      },
      ...record.categories.map((category, index) => ({
        cells: [
          index + 1,
          category.designation,
          category.persons,
          money((BigInt(category.persons) * BigInt(category.monthlyWage || '0')).toString()),
          money(wcAnnualWages(category)),
        ],
      })),
      {
        cells: [
          'Total',
          null,
          record.totals.persons,
          money(record.totals.monthlyWages),
          money(record.totals.annualWages),
        ],
        style: 'total',
      },
      ...listRows('Conditions', WC_DATA_SHEET_CONDITIONS),
    ],
  };
}

/** The RFQ sheet: the risk, the employees, the coverage options to quote, clauses and conditions. */
function rfqSheet(record: WcCase): SheetModel {
  const span = WIDTHS.length;
  const gst = `Premium Incl GST ${record.gstRatePercent}%`;
  return {
    name: 'RFQ',
    widths: WIDTHS,
    rows: [
      { cells: [policyNoLine(record)] },
      { cells: pad(['RFQ Sheet for Workmen Compensation Insurance'], span), style: 'title' },
      ...insuredRows(record, true),
      ...(record.categoryDescription ? [label('Category', record.categoryDescription)] : []),
      label('No.of Persons', String(record.totals.persons)),
      label('Total Wages per Month', rupees(record.totals.monthlyWages)),
      ...employeeRows(record, span),
      label('Insurance Company', ''),
      { cells: ['S No', 'Coverage', gst], style: 'header' },
      ...record.coverageOptions.map((option, index) => ({
        cells: [index + 1, option.label, null],
      })),
      label('Cheque / payment in favour of', ''),
      ...listRows('Clauses to be attached', record.clauses),
      ...listRows('Conditions', record.conditions),
      ...expiringRows(record),
    ],
  };
}

/**
 * The Quote sheet (QCR): the RFQ's details, then each coverage option's premium from every
 * insurer that quoted, the payee, the lowest premium per option and the recommendation.
 */
function qcrSheet(record: WcCase): SheetModel {
  const quotes = record.quotes;
  const span = Math.max(WIDTHS.length, 2 + quotes.length);
  const widths = [...WIDTHS.slice(0, 2), ...new Array<number>(span - 2).fill(22)];
  const premiumOf = (insurerId: string, optionId: string) =>
    quotes
      .find((quote) => quote.insurerId === insurerId)
      ?.premiums.find((premium) => premium.optionId === optionId)?.premium ?? null;
  const lowest = record.coverageOptions.flatMap((option) => {
    const quoted = quotes.flatMap((quote) => {
      const premium = premiumOf(quote.insurerId, option.id);
      return premium === null ? [] : [{ name: quote.insurerName, premium }];
    });
    if (quoted.length === 0) return [];
    const best = quoted.reduce((min, item) =>
      Number(item.premium) < Number(min.premium) ? item : min,
    );
    return [label(option.label, `${best.name} – ${rupees(best.premium)}`)];
  });
  const recommended = quotes.find((quote) => quote.insurerId === record.recommendedInsurerId);
  return {
    name: 'Quote',
    widths,
    rows: [
      { cells: [policyNoLine(record)] },
      { cells: pad(['Quote Sheet for Workmen Compensation Insurance'], span), style: 'title' },
      ...insuredRows(record, true),
      ...(record.categoryDescription ? [label('Category', record.categoryDescription)] : []),
      label('No.of Persons', String(record.totals.persons)),
      label('Total Wages per Month', rupees(record.totals.monthlyWages)),
      ...employeeRows(record, span),
      ...(quotes.length === 0
        ? [label('Insurance Company', 'No quotes recorded yet')]
        : [
            {
              cells: pad(['Insurance Company', null, ...quotes.map((q) => q.insurerName)], span),
              style: 'header' as const,
            },
            {
              cells: pad(
                [
                  'S No',
                  'Coverage',
                  ...quotes.map(() => `Premium Incl GST ${record.gstRatePercent}%`),
                ],
                span,
              ),
              style: 'header' as const,
            },
            ...record.coverageOptions.map((option, index) => ({
              cells: pad(
                [
                  index + 1,
                  option.label,
                  ...quotes.map((quote) => {
                    const premium = premiumOf(quote.insurerId, option.id);
                    return premium === null ? 'Not quoted' : money(premium, premium.includes('.'));
                  }),
                ],
                span,
              ),
            })),
            {
              cells: pad(
                [
                  'Cheque / payment in favour of',
                  null,
                  ...quotes.map((quote) => quote.paymentInFavourOf ?? '—'),
                ],
                span,
              ),
            },
          ]),
      ...(lowest.length > 0 ? [{ cells: ['Lowest premium'], style: 'section' as const }] : []),
      ...lowest,
      ...(recommended
        ? [{ cells: ['Our recommendation', recommended.insurerName], style: 'highlight' as const }]
        : []),
      ...(record.remarks ? [label('Remarks', record.remarks)] : []),
      ...listRows('Clauses to be attached', record.clauses),
      ...listRows('Conditions', record.conditions),
      ...expiringRows(record),
    ],
  };
}

/**
 * The placement slip, to the insurer accepted: the risk and employees as on the RFQ, then the
 * coverage option accepted, its premium (GST included), the payee and the policy when issued.
 */
function placementSheet(record: WcCase): SheetModel {
  const span = WIDTHS.length;
  const placement = record.placement;
  const period =
    placement?.policyStart && placement.policyEnd
      ? `${formatDate(placement.policyStart)} to ${formatDate(placement.policyEnd)}`
      : record.policyPeriod;
  return {
    name: 'Placement Slip',
    widths: WIDTHS,
    rows: [
      { cells: [policyNoLine(record)] },
      {
        cells: pad(['Placement Slip for Workmen Compensation Insurance'], span),
        style: 'title',
      },
      ...insuredRows(record, true).filter((row) => row.cells[0] !== 'Policy Period'),
      label('Policy Period', period),
      ...(record.categoryDescription ? [label('Category', record.categoryDescription)] : []),
      label('No.of Persons', String(record.totals.persons)),
      label('Total Wages per Month', rupees(record.totals.monthlyWages)),
      ...employeeRows(record, span),
      { cells: ['Placement'], style: 'section' },
      label('Insurance Company', placement?.insurerName ?? '—'),
      label('Coverage', placement?.optionLabel ?? '—'),
      label(`Premium Incl GST ${record.gstRatePercent}%`, rupees(placement?.premium)),
      label('Cheque / payment in favour of', placement?.paymentInFavourOf ?? '—'),
      ...(placement?.policyNumber ? [label('Policy No', placement.policyNumber)] : []),
      ...listRows('Clauses to be attached', record.clauses),
      ...listRows('Conditions', record.conditions),
    ],
  };
}

const TITLES: Record<WcDocumentKind, string> = {
  'data-sheet': 'Data Sheet',
  rfq: 'RFQ',
  qcr: 'Quote',
  'placement-slip': 'Placement Slip',
};

/** One of the documents of a case. */
export function wcDocument(record: WcCase, kind: WcDocumentKind): DocumentModel {
  const sheet =
    kind === 'data-sheet'
      ? dataSheet(record)
      : kind === 'rfq'
        ? rfqSheet(record)
        : kind === 'qcr'
          ? qcrSheet(record)
          : placementSheet(record);
  return {
    title: `WC ${TITLES[kind]} ${record.reference} — ${record.client.name}`,
    fileBase: `WC-${TITLES[kind].replace(/\s+/g, '-')}-${record.reference}`,
    sheets: [sheet],
  };
}
