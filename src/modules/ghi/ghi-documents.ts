import {
  GHI_AGE_GROUPS,
  GHI_AGE_GROUP_LABELS,
  GHI_CASE_TYPE_LABELS,
  GHI_COVERAGE_TYPE_LABELS,
  GHI_GENDER_LABELS,
  GHI_PARENT_COVER_LABELS,
  CENSUS_GROUPS,
  CENSUS_GROUP_LABELS,
  GHI_QCR_STATUS_LABELS,
  ghiQuoteOptions,
  GHI_RELATIONSHIPS,
  GHI_RELATIONSHIP_LABELS,
  GHI_ROOM_RENT_KIND_LABELS,
  GHI_WAIVERS,
  GHI_WAIVER_LABELS,
  formatDate,
  formatIndianNumber,
  slotText,
  type GhiCaseRecord,
  type CensusGroup,
  type GhiCensusSummary,
  type GhiMember,
  type GhiQcr,
  type GhiQuote,
  type GhiRequirements,
} from '../../shared/index.ts';
import { compareTerms } from './ghi-quote-calc.ts';
import { gmcFamilyCover } from './products/gmc.ts';
import { money, type DocumentModel, type SheetModel, type SheetRow } from './ghi-sheet.ts';

// What the GHI RFQ (G5), QCR (G6) and placement slip (G7) say, as sheets. Every figure comes from
// the saved Data Sheet, census and quotes; nothing is typed into the documents.

const yesNo = (value: boolean | null) => (value === null ? 'Not stated' : value ? 'Yes' : 'No');
const rupeesText = (value: string | null) =>
  value === null ? 'Not stated' : `₹${formatIndianNumber(value, 0)}`;
const label = (name: string, value: string): SheetRow => ({ cells: [name, value], style: 'label' });

function periodText(record: GhiCaseRecord): string {
  if (!record.policyStart) return '1 year from the date of payment';
  return `${formatDate(record.policyStart)} to ${record.policyEnd ? formatDate(record.policyEnd) : '1 year'}`;
}

function familyText(record: GhiCaseRecord): string {
  // With a plan, the family is the plan's (Requirement 16.4).
  if (record.plan) {
    return `${record.plan.name} v${record.plan.versionNumber}: ${record.plan.slots.map((slot) => slotText(slot)).join('; ')}`;
  }
  const family = record.requirements.familyDefinition;
  const parts = ['Employee'];
  if (family.spouse) parts.push('spouse');
  if (family.maxChildren > 0) {
    parts.push(`up to ${family.maxChildren} ${family.maxChildren === 1 ? 'child' : 'children'}`);
  }
  if (family.parents !== 'NONE') parts.push(GHI_PARENT_COVER_LABELS[family.parents].toLowerCase());
  return parts.join(', ');
}

function roomRentText(requirements: GhiRequirements): string {
  const roomRent = requirements.roomRent;
  if (roomRent.kind === null) return 'Not stated';
  if (roomRent.kind === 'NO_LIMIT') return GHI_ROOM_RENT_KIND_LABELS.NO_LIMIT;
  const unit =
    roomRent.kind === 'PERCENT_OF_SI' ? (value: string) => `${value}% of SI` : rupeesText;
  return `Normal room: ${roomRent.normal ? unit(roomRent.normal) : 'not stated'}; ICU: ${roomRent.icu ? unit(roomRent.icu) : 'not stated'} per day`;
}

function insuredRows(record: GhiCaseRecord): SheetRow[] {
  return [
    label('Reference', record.reference),
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

/** The Data Sheet's requirements as label rows (G2). */
export function requirementRows(record: GhiCaseRecord): SheetRow[] {
  const requirements = record.requirements;
  const maternity = requirements.maternity;
  const company = requirements.company;
  const ageLimits = GHI_AGE_GROUPS.map((group) => {
    const limit = requirements.ageLimits[group];
    const text =
      limit.min === null && limit.max === null
        ? 'no limit'
        : `${limit.min ?? 0} to ${limit.max ?? 'no maximum'}`;
    return `${GHI_AGE_GROUP_LABELS[group]}: ${text}`;
  }).join('; ');
  return [
    { cells: ['Coverage requirements'], style: 'section' },
    label('Employees to be covered', requirements.employeeCount?.toString() ?? 'Not stated'),
    label('Family definition', familyText(record)),
    label(
      'Coverage type',
      requirements.coverageType
        ? GHI_COVERAGE_TYPE_LABELS[requirements.coverageType]
        : 'Not stated',
    ),
    label(
      'Sum insured options',
      requirements.sumInsuredOptions.length > 0
        ? requirements.sumInsuredOptions.map(rupeesText).join(', ')
        : 'Not stated',
    ),
    // Options 2–4 (alteration 3/11/2026): each quoted separately, like Fire's options.
    ...((requirements.quoteOptions ?? []).length > 0
      ? [label('Please quote for', ghiQuoteOptions(requirements).map(optionText).join('; '))]
      : []),
    label('Room rent', roomRentText(requirements)),
    label(
      'Maternity',
      maternity.covered === null
        ? 'Not stated'
        : maternity.covered
          ? `Covered. Normal delivery ${rupeesText(maternity.normalLimit)}; caesarean ${rupeesText(maternity.cesareanLimit)}; new-born from day 1: ${yesNo(maternity.newbornCovered)}; 9-month waiting period waived: ${yesNo(maternity.nineMonthWaiver)}`
          : 'Not covered',
    ),
    label(
      'Pre-existing diseases',
      `${yesNo(requirements.preExistingDiseases.covered)}${requirements.preExistingDiseases.note ? ` (${requirements.preExistingDiseases.note})` : ''}`,
    ),
    ...GHI_WAIVERS.map((waiver) =>
      label(GHI_WAIVER_LABELS[waiver], yesNo(requirements.waivers[waiver])),
    ),
    label(
      'Co-payment for parents',
      !gmcFamilyCover({ requirements, planAssignment: record.plan }).parentsCovered
        ? 'Parents not covered'
        : requirements.parentsCoPayPercent === null
          ? 'Not stated'
          : `${requirements.parentsCoPayPercent}%`,
    ),
    label(
      'Corporate buffer',
      requirements.corporateBuffer.amount === null
        ? 'Not stated'
        : `${rupeesText(requirements.corporateBuffer.amount)}${requirements.corporateBuffer.perFamilyLimit ? `, up to ${rupeesText(requirements.corporateBuffer.perFamilyLimit)} per family` : ''}${requirements.corporateBuffer.note ? ` (${requirements.corporateBuffer.note})` : ''}`,
    ),
    label('Age limits (completed years)', ageLimits),
    label('Ages worked out on', formatDate(record.ageReferenceDate)),
    ...(requirements.addons.length > 0
      ? [label('Add-on covers', requirements.addons.join('; '))]
      : []),
    ...(requirements.otherRequirements
      ? [label('Other requirements', requirements.otherRequirements)]
      : []),
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

/** The census summary (G4) as a sheet. */
export function summarySheet(summary: GhiCensusSummary): SheetModel {
  // The sheet is only as wide as its widest table: the age-by-relationship breakup when there is
  // one, otherwise the three-column sum insured and family tables.
  const columns = (summary.byAgeBandAndGroup ?? []).length > 0 ? SUMMARY_WIDTHS.length : 3;
  // Narrower tables are not padded: the sheet writer runs their last column across the rest.
  const fullWidth = (...cells: SheetRow['cells']): SheetRow['cells'] => cells;
  return {
    name: 'Census Summary',
    widths: SUMMARY_WIDTHS.slice(0, columns),
    rows: [
      { cells: fullWidth('CENSUS SUMMARY'), style: 'title' },
      label('Employees', String(summary.employees)),
      label('Total insured lives', String(summary.lives)),
      label(
        'Coverage type',
        summary.coverageType ? GHI_COVERAGE_TYPE_LABELS[summary.coverageType] : 'Not stated',
      ),
      { cells: ['Total sum insured', money(summary.totalSumInsured)], style: 'label' },
      label('Average age', summary.averageAge ?? '—'),
      label('Ages worked out on', formatDate(summary.ageReferenceDate)),
      { cells: ['Lives by relationship'], style: 'section' },
      { cells: fullWidth('Relationship', 'Lives'), style: 'header' },
      ...GHI_RELATIONSHIPS.map((relationship) => ({
        cells: fullWidth(
          GHI_RELATIONSHIP_LABELS[relationship],
          summary.byRelationship[relationship] ?? 0,
        ),
      })),
      { cells: ['Lives by age'], style: 'section' },
      { cells: fullWidth('Age band (years)', 'Lives'), style: 'header' },
      ...summary.byAgeBand.map((band) => ({ cells: fullWidth(band.label, band.lives) })),
      { cells: fullWidth('Total', summary.lives), style: 'total' },
      { cells: ['Sum insured distribution'], style: 'section' },
      { cells: fullWidth('Sum insured', 'Families', 'Lives'), style: 'header' },
      ...summary.bySumInsured.map((item) => ({
        cells: fullWidth(money(item.sumInsured), item.families, item.lives),
      })),
      ...breakupRows(summary, fullWidth),
    ],
  };
}

/** The summary sheet is as wide as its breakup table; a narrower table's bands still fill it. */
const SUMMARY_WIDTHS = [30, 14, 14, 14, 14, 16, 12];

/**
 * The employee age-wise and family-wise breakup (client review 4/11/2026): each age band's lives
 * by relationship group, and the families by who they cover.
 */
function breakupRows(
  summary: GhiCensusSummary,
  fullWidth: (...cells: SheetRow['cells']) => SheetRow['cells'],
): SheetRow[] {
  const bands = summary.byAgeBandAndGroup ?? [];
  const families = summary.byFamily ?? [];
  const total = (group: CensusGroup) =>
    bands.reduce((sum, band) => sum + (band.groups[group] ?? 0), 0);
  return [
    ...(bands.length > 0
      ? [
          { cells: ['Lives by age and relationship'], style: 'section' as const },
          {
            cells: [
              'Age band (years)',
              ...CENSUS_GROUPS.map((group) => CENSUS_GROUP_LABELS[group]),
              'Total',
            ],
            style: 'header' as const,
          },
          ...bands.map((band) => ({
            cells: [
              band.label,
              ...CENSUS_GROUPS.map((group) => band.groups[group] ?? 0),
              band.lives,
            ],
          })),
          {
            cells: [
              'Total',
              ...CENSUS_GROUPS.map(total),
              bands.reduce((sum, band) => sum + band.lives, 0),
            ],
            style: 'total' as const,
          },
        ]
      : []),
    ...(families.length > 0
      ? [
          { cells: ['Family-wise breakup'], style: 'section' as const },
          { cells: fullWidth('Family', 'Families', 'Lives'), style: 'header' as const },
          ...families.map((family) => ({
            cells: fullWidth(family.label, family.families, family.lives),
          })),
          {
            cells: fullWidth(
              'Total',
              families.reduce((sum, family) => sum + family.families, 0),
              families.reduce((sum, family) => sum + family.lives, 0),
            ),
            style: 'total' as const,
          },
        ]
      : []),
  ];
}

export function claimsSheet(record: {
  requirements: { claims: GhiRequirements['claims'] };
}): SheetModel {
  const claims = record.requirements.claims;
  return {
    name: 'Claims History',
    widths: [12, 26, 10, 18, 18, 18, 10, 12],
    rows: [
      {
        cells: [
          'PREVIOUS THREE YEARS: PREMIUM AND CLAIMS',
          null,
          null,
          null,
          null,
          null,
          null,
          null,
        ],
        style: 'title',
      },
      {
        cells: [
          'Policy year',
          'Insurer',
          'Lives',
          'Premium',
          'Claims paid',
          'Claims outstanding',
          'Claims',
          'Claims ratio',
        ],
        style: 'header',
      },
      ...(claims.length === 0
        ? [{ cells: ['No previous group health policy was declared.'], style: 'note' as const }]
        : claims.map((claim) => ({
            cells: [
              claim.policyYear,
              claim.insurer ?? '',
              claim.livesCovered,
              money(claim.premium, true),
              money(claim.claimsPaid, true),
              money(claim.claimsOutstanding, true),
              claim.claimCount,
              claim.claimsRatioPercent === null ? '' : `${claim.claimsRatioPercent}%`,
            ],
          }))),
    ],
  };
}

/** Every insured life (G5, G7 annexure), with the sum insured that covers them. */
export function membersSheet(
  members: readonly (GhiMember & { coveredBy: string | null })[],
): SheetModel {
  return {
    name: 'Annexure - Members',
    widths: [7, 14, 28, 9, 13, 6, 16, 13, 15],
    rows: [
      {
        cells: [
          'ANNEXURE: EMPLOYEES AND FAMILY MEMBERS',
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
        ],
        style: 'title',
      },
      {
        cells: [
          'Sr',
          'Employee ID',
          'Name',
          'Gender',
          'Date of birth',
          'Age',
          'Relationship',
          'Date of joining',
          'Sum insured',
        ],
        style: 'header',
      },
      ...members.map((member, index) => ({
        cells: [
          index + 1,
          member.employeeId,
          member.name,
          GHI_GENDER_LABELS[member.gender],
          member.dateOfBirth ? formatDate(member.dateOfBirth) : '',
          member.age,
          GHI_RELATIONSHIP_LABELS[member.relationship],
          member.dateOfJoining ? formatDate(member.dateOfJoining) : '',
          money(member.coveredBy),
        ],
      })),
    ],
  };
}

export function rfqDocument(
  record: GhiCaseRecord,
  summary: GhiCensusSummary,
  members: readonly (GhiMember & { coveredBy: string | null })[],
  version: number,
): DocumentModel {
  return {
    title: `GHI RFQ ${record.reference} v${version} — ${record.client.name}`,
    fileBase: `GHI-RFQ-${record.reference}-v${version}`,
    sheets: [
      {
        name: 'GHI Data Sheet',
        widths: [34, 70],
        rows: [
          { cells: ['REQUEST FOR QUOTATION — GROUP HEALTH INSURANCE', null], style: 'title' },
          label('RFQ version', `v${version}`),
          label('Quotes needed by', formatDate(record.dueDate)),
          ...insuredRows(record),
          ...requirementRows(record),
          {
            cells: [
              'The census summary, the previous three years’ claims and the full list of employees and family members follow as annexures.',
            ],
            style: 'note',
          },
        ],
      },
      summarySheet(summary),
      claimsSheet(record),
      membersSheet(members),
    ],
  };
}

/** "Option 2: sum insured ₹5,00,000 per family" (Option 1: the sums insured above). */
function optionText(option: { label: string; sumInsured: string | null }): string {
  return option.sumInsured === null
    ? `${option.label}: the sums insured above (as per the census)`
    : `${option.label}: sum insured ${rupeesText(option.sumInsured)} for every family or person`;
}

/**
 * The QCR's premium rows: base, GST and total for each option the case asks for (one set when it
 * has only Option 1), the lowest total of each option marked; "Not quoted" where an insurer gave
 * no premium for an option.
 */
function premiumRows(qcr: GhiQcr): SheetRow[] {
  const single = qcr.options.length <= 1;
  return qcr.options.flatMap((option, at) => {
    const name = (item: string) => (single ? item : `${option.label} — ${item}`);
    const value = (
      column: GhiQcr['columns'][number],
      key: 'basePremium' | 'gst' | 'totalPremium',
    ) => {
      const amount = single ? column[key] : column.options[at]?.[key];
      return amount ? money(amount, true) : 'Not quoted';
    };
    return [
      ...(single ? [] : [label(option.label, optionText(option))]),
      {
        cells: [
          name('Base premium'),
          '',
          ...qcr.columns.map((column) => value(column, 'basePremium')),
        ],
      },
      { cells: [name('GST'), '', ...qcr.columns.map((column) => value(column, 'gst'))] },
      {
        cells: [
          name('Total premium'),
          '',
          ...qcr.columns.map((column) => value(column, 'totalPremium')),
        ],
        style: 'total' as const,
      },
      ...(single
        ? []
        : [
            {
              cells: [
                `${option.label} — Lowest total`,
                '',
                ...qcr.columns.map((column) => (column.options[at]?.lowest ? 'Lowest' : '')),
              ],
            },
          ]),
    ];
  });
}

export function qcrDocument(
  record: GhiCaseRecord,
  qcr: GhiQcr,
  summary: GhiCensusSummary,
): DocumentModel {
  const span = 2 + qcr.columns.length;
  const blank = () => Array.from({ length: span - 1 }, () => null);
  const decision = qcr.decision;
  /** The insurers' column heads, over the terms and again over the premium. */
  const header: SheetRow = {
    cells: [
      'Item',
      'As asked in the RFQ',
      ...qcr.columns.map(
        (column) =>
          `${column.insurerName} (quote v${column.quoteVersion})${column.lowest ? ' — lowest' : ''}${column.recommended ? ' — recommended' : ''}`,
      ),
    ],
    style: 'header',
  };
  return {
    title: `GHI QCR ${record.reference} v${qcr.version} — ${record.client.name}`,
    fileBase: `GHI-QCR-${record.reference}-v${qcr.version}`,
    sheets: [
      {
        name: 'QCR',
        widths: [34, 26, ...qcr.columns.map(() => 26)],
        rows: [
          {
            cells: ['QUOTE COMPARISON REPORT — GROUP HEALTH INSURANCE', ...blank()],
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
          ...(record.requirements.addons.length > 0
            ? [label('Add-on covers', record.requirements.addons.join('; '))]
            : []),
          { cells: ['Terms offered'], style: 'section' },
          header,
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
              ...qcr.columns.map((column) => `${column.deviations} / ${column.missing}`),
            ],
            style: 'total',
          },
          // The premium comes last, just above the recommendation (alteration 3/11/2026).
          { cells: ['Premium'], style: 'section' },
          header,
          ...premiumRows(qcr),
          { cells: ['Recommendation'], style: 'section' },
          label(
            'Recommended insurer',
            qcr.columns.find((column) => column.recommended)?.insurerName ?? 'None',
          ),
          ...(qcr.options.length > 1
            ? [label('Recommended option', `Option ${qcr.recommendedOption}`)]
            : []),
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

export function placementSlipDocument(
  record: GhiCaseRecord,
  quote: GhiQuote,
  qcrVersion: number,
  summary: GhiCensusSummary,
  members: readonly (GhiMember & { coveredBy: string | null })[],
  payments: { received: string; references: string[] },
  option: { label: string; sumInsured: string | null } | null = null,
): DocumentModel {
  const terms = compareTerms(
    record.requirements,
    quote.terms,
    gmcFamilyCover({ requirements: record.requirements, planAssignment: record.plan })
      .parentsCovered,
  );
  return {
    title: `GHI Placement Slip ${record.reference} — ${record.client.name}`,
    fileBase: `GHI-Placement-Slip-${record.reference}`,
    sheets: [
      {
        name: 'Placement Slip',
        widths: [36, 60],
        rows: [
          { cells: ['PLACEMENT SLIP — GROUP HEALTH INSURANCE', null], style: 'title' },
          label('To', quote.insurerName),
          ...insuredRows(record),
          label('Based on', `QCR v${qcrVersion}, final agreed terms v${quote.version}`),
          ...(option && option.sumInsured !== null
            ? [label('Option chosen', optionText(option))]
            : []),
          { cells: ['Final agreed premium'], style: 'section' },
          { cells: ['Base premium', money(quote.basePremium, true)], style: 'label' },
          { cells: [`GST (${quote.gstRatePercent}%)`, money(quote.gst, true)], style: 'label' },
          { cells: ['Total premium', money(quote.totalPremium, true)], style: 'total' },
          { cells: ['Premium received', money(payments.received, true)], style: 'label' },
          label('Payment references', payments.references.join(', ') || 'None'),
          { cells: ['Final agreed terms'], style: 'section' },
          ...terms.map((row) => label(row.label, row.offered)),
          ...(quote.otherTerms ? [label('Other terms', quote.otherTerms)] : []),
          { cells: ['Insured census'], style: 'section' },
          label('Employees', String(summary.employees)),
          label('Total insured lives', String(summary.lives)),
          { cells: ['Total sum insured', money(summary.totalSumInsured)], style: 'label' },
          {
            cells: [
              'Please issue the policy as per the final agreed terms above, covering the members listed in the annexure.',
            ],
            style: 'note',
          },
        ],
      },
      summarySheet(summary),
      membersSheet(members),
    ],
  };
}
