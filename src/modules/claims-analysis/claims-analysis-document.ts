import {
  EB_PRODUCT_NAMES,
  GHI_RELATIONSHIP_LABELS,
  TPA_CLAIM_STATUS_LABELS,
  TPA_REQUEST_TYPE_LABELS,
  formatDate,
  formatDateTime,
  type AnalysisRow,
  type ClaimsAnalysisResponse,
} from '../../shared/index.ts';
import { money, type DocumentModel, type SheetModel, type SheetRow } from '../ghi/ghi-sheet.ts';

// The claims analysis (N10) as Excel and an A4 PDF, in Fiducial's built-in layout: the client's
// claims analysis spreadsheet is not in the repository (open question CA-3). Every figure is the
// same one the screen shows; diagnosis details only when the user may see them.

const label = (name: string, value: string): SheetRow => ({ cells: [name, value], style: 'label' });
const SPAN = 7;
const pad = (cells: SheetRow['cells']) => [
  ...cells,
  ...Array.from({ length: Math.max(0, SPAN - cells.length) }, () => null),
];

function table(title: string, rows: readonly AnalysisRow[], total?: AnalysisRow): SheetRow[] {
  return [
    { cells: [title], style: 'section' },
    {
      cells: pad(['', 'Claims', 'Claimed', 'Paid', 'Outstanding', 'Incurred (paid + outstanding)']),
      style: 'header',
    },
    ...rows.map((row) => ({
      cells: pad([
        row.label,
        row.count,
        money(row.claimed, true),
        money(row.paid, true),
        money(row.outstanding, true),
        money(row.incurred, true),
      ]),
    })),
    ...(total
      ? [
          {
            cells: pad([
              'Total',
              total.count,
              money(total.claimed, true),
              money(total.paid, true),
              money(total.outstanding, true),
              money(total.incurred, true),
            ]),
            style: 'total' as const,
          },
        ]
      : []),
  ];
}

export function claimsAnalysisDocument(response: ClaimsAnalysisResponse): DocumentModel {
  const { header, analysis, details } = response;
  const premium = analysis.premium;
  const percent = (value: string | null, reason: string | null) =>
    value === null ? `Not worked out: ${reason ?? ''}` : `${value}%`;
  const summary: SheetModel = {
    name: 'Claims Analysis',
    widths: [44, 12, 18, 18, 18, 22, 4],
    rows: [
      {
        cells: pad([`CLAIMS ANALYSIS — ${EB_PRODUCT_NAMES[header.product].toUpperCase()}`]),
        style: 'title',
      },
      label('Company', header.company),
      label(
        'Policy',
        `${header.policyNumber ?? 'Number not recorded'} · ${header.insurerName ?? ''} · ${formatDate(header.policyStart)} to ${formatDate(header.policyEnd)}`,
      ),
      label('Case reference', header.reference),
      label('Admissions from', `${formatDate(header.from)} to ${formatDate(header.to)}`),
      label('Reporting date (premium earned to)', formatDate(header.asOf)),
      label('Age bands', `${header.ageBands.name} (age at admission)`),
      ...header.filters.map((filter) => label(filter.label, filter.value)),
      label('Generated', formatDateTime(header.generatedAt)),
      ...(analysis.notCounted > 0
        ? [
            label(
              'Not counted',
              `${analysis.notCounted} pre-authorisation(s) linked to their main claim (the main claim is counted)`,
            ),
          ]
        : []),
      ...(header.unreportedBoardClaims > 0
        ? [
            label(
              'Board claims not in the TPA data',
              `${header.unreportedBoardClaims} (not in these figures)`,
            ),
          ]
        : []),
      ...table('A. Status', analysis.status, analysis.reported),
      ...(analysis.outstandingBySubStatus.length > 0
        ? table('Outstanding by TPA status', analysis.outstandingBySubStatus)
        : []),
      ...table('B. Main member and dependants', analysis.members, analysis.reported),
      ...table('C. Gender', analysis.gender, analysis.reported),
      ...table('C. Relationship', analysis.relationship, analysis.reported),
      ...table('C. Age band', analysis.ageBands, analysis.reported),
      ...table('D. Cashless and reimbursement', analysis.claimType, analysis.reported),
      ...table(`E. Disease (${analysis.icdVersion})`, analysis.disease, analysis.reported),
      { cells: ['F. Incurred claims ratio'], style: 'section' },
      { cells: ['Paid claims', money(analysis.icr.paid, true)], style: 'label' },
      { cells: ['Outstanding claims', money(analysis.icr.outstanding, true)], style: 'label' },
      {
        cells: ['Incurred (paid + outstanding)', money(analysis.icr.incurred, true)],
        style: 'label',
      },
      { cells: ['Premium before GST as placed', money(premium.base, true)], style: 'label' },
      { cells: ['Additions', money(premium.additions, true)], style: 'label' },
      { cells: ['Deletions', money(premium.deletions, true)], style: 'label' },
      {
        cells: ['Total premium after additions and deletions', money(premium.total, true)],
        style: 'label',
      },
      {
        cells: [
          `Prorated premium (earned to ${formatDate(premium.asOf)}: ${premium.daysElapsed} of ${premium.policyDays} days)`,
          money(premium.prorated, true),
        ],
        style: 'label',
      },
      label(
        'ICR on the prorated premium',
        percent(analysis.icr.prorated.percent, analysis.icr.prorated.reason),
      ),
      label(
        'ICR on the total premium',
        percent(analysis.icr.total.percent, analysis.icr.total.reason),
      ),
      {
        cells: [
          'ICR (%) = (paid + outstanding) ÷ premium × 100, rounded half up to 2 decimals. Premiums are before GST. Amounts are in rupees with paise.',
        ],
        style: 'note',
      },
    ],
  };
  const showDiagnosis = header.diagnosisVisible;
  const claimsSheet: SheetModel = {
    name: 'Claims',
    widths: [16, 14, 12, 26, 14, 8, 12, 12, 14, 14, 14, 18, 10, ...(showDiagnosis ? [10, 30] : [])],
    rows: [
      {
        cells: [
          'TPA claim ID',
          'Request',
          'Employee ID',
          'Patient',
          'Relationship',
          'Age',
          'Admitted',
          'Discharged',
          'Status',
          'Claimed',
          'Paid',
          'Outstanding',
          'ICD chapter',
          ...(showDiagnosis ? ['ICD code', 'Diagnosis'] : []),
        ],
        style: 'header',
      },
      ...details.items.map((item) => ({
        cells: [
          item.tpaClaimId,
          TPA_REQUEST_TYPE_LABELS[item.requestType],
          item.employeeId ?? '',
          item.patientName ?? '',
          item.relationship ? GHI_RELATIONSHIP_LABELS[item.relationship] : '',
          item.age,
          item.admissionDate ? formatDate(item.admissionDate) : '',
          item.dischargeDate ? formatDate(item.dischargeDate) : '',
          item.bucket === 'NOT_COUNTED'
            ? 'Not counted (linked pre-auth)'
            : `${TPA_CLAIM_STATUS_LABELS[item.bucket]} (${item.sourceStatus})`,
          money(item.claimedAmount, true),
          money(item.paid, true),
          money(item.outstanding, true),
          item.icdChapter,
          ...(showDiagnosis ? [item.icdCode ?? '', item.diagnosis ?? ''] : []),
        ],
      })),
    ],
  };
  return {
    title: `Claims Analysis ${header.reference} — ${header.company}`,
    fileBase: `Claims-Analysis-${header.reference}`,
    sheets: [summary, claimsSheet],
  };
}
