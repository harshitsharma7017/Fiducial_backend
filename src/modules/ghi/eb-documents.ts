import {
  COVER_CHOICE_LABELS,
  DEPENDANT_BASIS_LABELS,
  GHI_AGE_GROUPS,
  GHI_AGE_GROUP_LABELS,
  GHI_CASE_TYPE_LABELS,
  GHI_GENDER_LABELS,
  GHI_QCR_STATUS_LABELS,
  GHI_RELATIONSHIPS,
  GHI_RELATIONSHIP_LABELS,
  GPA_COVERS,
  GPA_COVER_LABELS,
  NOMINEE_REQUIREMENT_LABELS,
  EB_PRODUCT_NAMES,
  awaitingText,
  nomineeText,
  basisText,
  dependantRuleOf,
  dependantRuleText,
  nomineeRequirementOf,
  formatDate,
  formatIndianNumber,
  mixingText,
  slotText,
  type EbCaseRecord,
  type EbMember,
  type EbPlanAssignment,
  type EbQcr,
  type GhiCensusSummary,
  type GpaCaseRecord,
  type GtliCaseRecord,
} from '../../shared/index.ts';
import { claimsSheet, summarySheet } from './ghi-documents.ts';
import { money, type DocumentModel, type SheetModel, type SheetRow } from './ghi-sheet.ts';

// The built-in GPA and GTLI documents (open question 15: the client's layouts have not been
// received): the RFQ (6.2), the QCR (8.6) and the placement slip (11.1), as sheets written to
// Excel and an A4 PDF by the GHI document engine. Every figure comes from the saved records.

const label = (name: string, value: string): SheetRow => ({ cells: [name, value], style: 'label' });
const rupeesText = (value: string | null) =>
  value === null ? 'Not stated' : `₹${formatIndianNumber(value, 0)}`;

function periodText(record: EbCaseRecord): string {
  if (!record.policyStart) return '1 year from the date of payment';
  return `${formatDate(record.policyStart)} to ${record.policyEnd ? formatDate(record.policyEnd) : '1 year'}`;
}

function insuredRows(record: EbCaseRecord): SheetRow[] {
  return [
    label('Reference', record.reference),
    label('Product', `${record.product} (${EB_PRODUCT_NAMES[record.product]})`),
    label('Insured name', record.client.name),
    label('Address', record.client.address),
    label('GSTIN', record.client.gstin ?? 'Not registered'),
    label(
      'Nature of business',
      record.requirements.company.natureOfBusiness ?? record.client.natureOfBusiness,
    ),
    label('Type of case', GHI_CASE_TYPE_LABELS[record.type]),
    label('Policy period', periodText(record)),
    ...(record.type === 'RENEWAL'
      ? [
          label(
            'Expiring policy',
            [record.existingInsurer, record.existingPolicyNumber].filter(Boolean).join(', ') ||
              'Not stated',
          ),
        ]
      : []),
  ];
}

function ageLimitsText(record: EbCaseRecord): string {
  return GHI_AGE_GROUPS.map((group) => {
    const limit = record.requirements.ageLimits[group];
    const text =
      limit.min === null && limit.max === null
        ? 'no limit'
        : `${limit.min ?? 0} to ${limit.max ?? 'no maximum'}`;
    return `${GHI_AGE_GROUP_LABELS[group]}: ${text}`;
  }).join('; ');
}

function gpaRows(record: GpaCaseRecord): SheetRow[] {
  const sheet = record.requirements;
  return [
    {
      cells: [
        'Cover requirements (awaiting the client’s confirmation of the covers, open question 10)',
      ],
      style: 'section',
    },
    label('Employees to be covered', sheet.employeeCount?.toString() ?? 'Not stated'),
    label('Sum insured basis', basisText(sheet.sumInsuredBasis)),
    ...GPA_COVERS.map((cover) =>
      label(
        GPA_COVER_LABELS[cover],
        sheet.covers[cover] === null ? 'Not stated' : COVER_CHOICE_LABELS[sheet.covers[cover]],
      ),
    ),
    ...(sheet.covers.temporaryTotal === 'REQUIRED'
      ? [
          label(
            'Temporary total disablement benefit',
            `${rupeesText(sheet.temporaryTotal.weeklyBenefit)} a week${sheet.temporaryTotal.weeks ? `, up to ${sheet.temporaryTotal.weeks} weeks` : ''}`,
          ),
        ]
      : []),
    ...(sheet.otherCovers ? [label('Other covers and limits', sheet.otherCovers)] : []),
    label(
      'Dependants’ sum insured',
      sheet.dependantBasis === null
        ? 'Not stated'
        : sheet.dependantBasis.kind === 'PERCENT_OF_EMPLOYEE'
          ? `${sheet.dependantBasis.percent}% of the employee’s sum insured`
          : DEPENDANT_BASIS_LABELS[sheet.dependantBasis.kind],
    ),
    ...(sheet.dependantBasis?.kind === 'BY_RELATIONSHIP'
      ? sheet.dependantBasis.rules.map((rule) =>
          label(
            `${GHI_RELATIONSHIP_LABELS[rule.relationship]}’s sum insured`,
            dependantRuleText(dependantRuleOf(sheet.dependantBasis, rule.relationship)),
          ),
        )
      : []),
    label('Nominees', NOMINEE_REQUIREMENT_LABELS[nomineeRequirementOf(sheet)]),
    label('Age limits (completed years)', ageLimitsText(record)),
    label('Ages worked out on', formatDate(record.ageReferenceDate)),
    ...(sheet.otherRequirements ? [label('Other requirements', sheet.otherRequirements)] : []),
  ];
}

function gtliRows(record: GtliCaseRecord): SheetRow[] {
  const sheet = record.requirements;
  return [
    { cells: ['Cover requirements'], style: 'section' },
    label('Employees to be covered', sheet.employeeCount?.toString() ?? 'Not stated'),
    label('Sum assured basis', basisText(sheet.sumInsuredBasis)),
    label('Nominees', NOMINEE_REQUIREMENT_LABELS[nomineeRequirementOf(sheet)]),
    label(
      'Free cover limit asked for',
      sheet.freeCoverLimit === null ? 'Not asked' : rupeesText(sheet.freeCoverLimit),
    ),
    ...(sheet.additionalBenefits ? [label('Additional benefits', sheet.additionalBenefits)] : []),
    label('Age limits (completed years)', ageLimitsText(record)),
    label('Ages worked out on', formatDate(record.ageReferenceDate)),
    ...(sheet.otherRequirements ? [label('Other requirements', sheet.otherRequirements)] : []),
  ];
}

function contactRows(record: EbCaseRecord): SheetRow[] {
  const company = record.requirements.company;
  return [
    ...(company.contactName || company.contactEmail || company.contactPhone
      ? [
          label(
            'Contact at the insured',
            [company.contactName, company.contactEmail, company.contactPhone]
              .filter(Boolean)
              .join(', '),
          ),
        ]
      : []),
    ...(company.locations ? [label('Locations', company.locations)] : []),
  ];
}

/** The plan version and its slots; an unconfirmed version says so (open question 16). */
export function planRows(plan: EbPlanAssignment | null): SheetRow[] {
  if (!plan) return [{ cells: ['Family plan'], style: 'section' }, label('Plan', 'Not assigned')];
  return [
    { cells: ['Family plan'], style: 'section' },
    label('Plan', `${plan.name} (code ${plan.code}), version ${plan.versionNumber}`),
    ...plan.slots.map((slot, index) => label(`Slot ${index + 1}`, slotText(slot))),
    label('Parents and parents-in-law', mixingText(plan)),
    ...(plan.clientConfirmed ? [] : [label('Status', awaitingText(plan.openQuestions))]),
  ];
}

function membersSheet(members: readonly EbMember[], product: EbCaseRecord['product']): SheetModel {
  const cover = product === 'GTLI' ? 'Sum assured' : 'Sum insured';
  const monthly = members.some((member) => member.monthlySalary !== null);
  const nominees = members.some((member) => member.nominee !== null);
  const header = [
    'Sr',
    'Employee ID',
    'Name',
    'Gender',
    'Date of birth',
    'Age',
    'Relationship',
    'Date of joining',
    ...(monthly ? ['Monthly salary'] : []),
    'Annual salary',
    cover,
    `How the ${cover.toLowerCase()} is worked out`,
    ...(nominees ? ['Nominee'] : []),
  ];
  return {
    name: 'Annexure - Members',
    widths: [
      7,
      14,
      28,
      9,
      13,
      6,
      16,
      13,
      ...(monthly ? [15] : []),
      15,
      15,
      40,
      ...(nominees ? [34] : []),
    ],
    rows: [
      { cells: ['ANNEXURE: INSURED MEMBERS', ...header.slice(1).map(() => null)], style: 'title' },
      { cells: header, style: 'header' },
      ...members.map((member, index) => ({
        cells: [
          index + 1,
          member.employeeId,
          member.name,
          GHI_GENDER_LABELS[member.gender],
          formatDate(member.dateOfBirth),
          member.age,
          GHI_RELATIONSHIP_LABELS[member.relationship],
          member.dateOfJoining ? formatDate(member.dateOfJoining) : '',
          ...(monthly ? [money(member.monthlySalary)] : []),
          money(member.annualSalary),
          money(member.coveredSumInsured),
          member.coverageBasis ?? '',
          ...(nominees ? [nomineeText(member.nominee, formatDate)] : []),
        ],
      })),
    ],
  };
}

function productTitle(record: EbCaseRecord): string {
  return EB_PRODUCT_NAMES[record.product].toUpperCase();
}

export function ebRfqDocument(
  record: EbCaseRecord,
  summary: GhiCensusSummary,
  members: readonly EbMember[],
  version: number,
): DocumentModel {
  return {
    title: `${record.product} RFQ ${record.reference} v${version} — ${record.client.name}`,
    fileBase: `${record.product}-RFQ-${record.reference}-v${version}`,
    sheets: [
      {
        name: `${record.product} Data Sheet`,
        widths: [34, 70],
        rows: [
          { cells: [`REQUEST FOR QUOTATION — ${productTitle(record)}`, null], style: 'title' },
          label('RFQ version', `v${version}`),
          label('Quotes needed by', formatDate(record.dueDate)),
          ...insuredRows(record),
          ...(record.product === 'GPA' ? gpaRows(record) : gtliRows(record)),
          ...planRows(record.plan),
          ...contactRows(record),
          {
            cells: [
              'This RFQ is in Fiducial’s built-in layout (the client’s layout has not been received). The census summary, the previous years’ claims and every insured member follow as annexures.',
            ],
            style: 'note',
          },
        ],
      },
      summarySheet(summary),
      claimsSheet(record),
      membersSheet(members, record.product),
    ],
  };
}

export function ebQcrDocument(
  record: EbCaseRecord,
  qcr: EbQcr,
  summary: GhiCensusSummary,
): DocumentModel {
  const span = 2 + qcr.columns.length;
  const blank = () => Array.from({ length: span - 1 }, () => null);
  const decision = qcr.decision;
  return {
    title: `${record.product} QCR ${record.reference} v${qcr.version} — ${record.client.name}`,
    fileBase: `${record.product}-QCR-${record.reference}-v${qcr.version}`,
    sheets: [
      {
        name: 'QCR',
        widths: [34, 26, ...qcr.columns.map(() => 26)],
        rows: [
          {
            cells: [`QUOTE COMPARISON REPORT — ${productTitle(record)}`, ...blank()],
            style: 'title',
          },
          label('Insured name', record.client.name),
          label(
            'Reference',
            `${record.reference} (QCR v${qcr.version}, ${GHI_QCR_STATUS_LABELS[qcr.status]})`,
          ),
          label('Policy period', periodText(record)),
          label(
            'Census',
            `${summary.employees} employees, ${summary.lives} lives, total sum insured ${rupeesText(summary.totalSumInsured)}`,
          ),
          { cells: ['Premium'], style: 'section' },
          {
            cells: [
              'Item',
              'As asked in the RFQ',
              ...qcr.columns.map(
                (column) =>
                  `${column.insurerName} (quote v${column.quoteVersion})${column.lowest ? ' — lowest' : ''}${column.recommended ? ' — recommended' : ''}`,
              ),
            ],
            style: 'header',
          },
          {
            cells: [
              'Base premium',
              '',
              ...qcr.columns.map((column) => money(column.basePremium, true)),
            ],
          },
          { cells: ['GST', '', ...qcr.columns.map((column) => money(column.gst, true))] },
          {
            cells: [
              'Total premium',
              '',
              ...qcr.columns.map((column) => money(column.totalPremium, true)),
            ],
            style: 'total',
          },
          { cells: ['Terms offered'], style: 'section' },
          ...qcr.rows.map((row) => ({
            cells: [
              row.label,
              row.requested,
              ...row.values.map((value) =>
                value.kind === 'DEVIATION'
                  ? `${value.text} (deviation)`
                  : value.kind === 'MISSING'
                    ? `${value.text} (missing)`
                    : value.kind === 'BETTER'
                      ? `${value.text} (better)`
                      : value.text,
              ),
            ],
          })),
          {
            cells: [
              'Deviations / missing information',
              '',
              ...qcr.columns.map(
                (column) =>
                  `${column.deviations.filter((item) => item.kind === 'DEVIATION').length} / ${column.deviations.filter((item) => item.kind === 'MISSING').length}`,
              ),
            ],
            style: 'total',
          },
          { cells: ['Recommendation'], style: 'section' },
          label(
            'Recommended insurer',
            qcr.columns.find((column) => column.recommended)?.insurerName ?? 'None',
          ),
          label('Remarks', qcr.remarks ?? ''),
          label(
            'Approval',
            decision
              ? `${decision.status === 'APPROVED' ? 'Approved' : 'Rejected'} by ${decision.by} on ${formatDate(decision.at.slice(0, 10))}${decision.comment ? `: ${decision.comment}` : ''}`
              : 'Not yet approved',
          ),
        ],
      },
      summarySheet(summary),
    ],
  };
}

export interface PlacementSlipInput {
  insurerName: string;
  quoteVersion: number;
  qcrVersion: number;
  basePremium: string;
  gstRatePercent: string;
  gst: string;
  agreedPremium: string;
  receivedPayments: ReadonlyArray<{ amount: string; paidOn: string; reference: string }>;
  plan: EbPlanAssignment | null;
  byRelationship: GhiCensusSummary['byRelationship'];
  employees: number;
  lives: number;
  totalSumInsured: string | null;
  policyNumber: string | null;
  policyStart: string | null;
  policyEnd: string | null;
  placed: boolean;
}

export function ebPlacementSlipDocument(
  record: EbCaseRecord,
  input: PlacementSlipInput,
  summary: GhiCensusSummary,
  members: readonly EbMember[],
): DocumentModel {
  return {
    title: `${record.product} Placement Slip ${record.reference} — ${record.client.name}`,
    fileBase: `${record.product}-Placement-Slip-${record.reference}`,
    sheets: [
      {
        name: 'Placement Slip',
        widths: [36, 60],
        rows: [
          { cells: [`PLACEMENT SLIP — ${productTitle(record)}`, null], style: 'title' },
          label('To', input.insurerName),
          ...insuredRows(record),
          ...(input.placed
            ? [
                label('Policy number', input.policyNumber ?? 'Not recorded'),
                label(
                  'Policy dates',
                  input.policyStart
                    ? `${formatDate(input.policyStart)} to ${input.policyEnd ? formatDate(input.policyEnd) : 'not recorded'}`
                    : 'Not recorded',
                ),
              ]
            : []),
          label(
            'Based on',
            `QCR v${input.qcrVersion}, quote v${input.quoteVersion} (the client’s decision)`,
          ),
          { cells: ['Agreed premium'], style: 'section' },
          { cells: ['Base premium', money(input.basePremium, true)], style: 'label' },
          { cells: [`GST (${input.gstRatePercent}%)`, money(input.gst, true)], style: 'label' },
          { cells: ['Total premium', money(input.agreedPremium, true)], style: 'total' },
          { cells: ['Premium received'], style: 'section' },
          ...(input.receivedPayments.length === 0
            ? [label('Payments', 'None')]
            : input.receivedPayments.map((payment) => ({
                cells: [
                  `${formatDate(payment.paidOn)} (${payment.reference})`,
                  money(payment.amount, true),
                ],
                style: 'label' as const,
              }))),
          ...planRows(input.plan),
          { cells: ['Insured census'], style: 'section' },
          label('Employees', String(input.employees)),
          label('Total insured lives', String(input.lives)),
          ...GHI_RELATIONSHIPS.filter(
            (relationship) => (input.byRelationship[relationship] ?? 0) > 0,
          ).map((relationship) =>
            label(
              GHI_RELATIONSHIP_LABELS[relationship],
              String(input.byRelationship[relationship]),
            ),
          ),
          { cells: ['Total sum insured', money(input.totalSumInsured)], style: 'label' },
          {
            cells: [
              'Please issue the policy as per the agreed quote above, covering the members listed in the annexure. Built-in layout: the client’s placement slip layout has not been received (open question 15).',
            ],
            style: 'note',
          },
        ],
      },
      summarySheet(summary),
      membersSheet(members, record.product),
    ],
  };
}
