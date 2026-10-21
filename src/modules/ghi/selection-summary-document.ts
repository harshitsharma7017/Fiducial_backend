import {
  EB_PRODUCT_NAMES,
  GHI_GENDERS,
  GHI_GENDER_LABELS,
  GHI_RELATIONSHIP_LABELS,
  SELECTION_MEASURE_LABELS,
  formatDate,
  formatDateTime,
  type RfqSelectionSummaryResponse,
} from '../../shared/index.ts';
import {
  money,
  type DocumentModel,
  type SheetCell,
  type SheetModel,
  type SheetRow,
} from './ghi-sheet.ts';

// The RFQ Selection Summary Sheet (N7) as rows for the document engine, so Excel, the A4 PDF
// and the RFQ's own copy say the same. The client's layout for it has not been received (open
// question 15), so this is Fiducial's built-in layout. Every figure comes from the summary.

export const SELECTION_SUMMARY_SHEET = 'RFQ Selection Summary';

export function selectionSummarySheet(response: RfqSelectionSummaryResponse): SheetModel {
  const { header, summary } = response;
  const measure = SELECTION_MEASURE_LABELS[summary.measure];
  const categories = summary.categories;
  const span = Math.max(4, categories.length + 3);
  const pad = (cells: SheetCell[]): SheetCell[] => [
    ...cells,
    ...Array.from({ length: Math.max(0, span - cells.length) }, () => null),
  ];
  const label = (name: string, value: string): SheetRow => ({
    cells: [name, value],
    style: 'label',
  });
  const section = (title: string): SheetRow => ({ cells: [title], style: 'section' });

  const rows: SheetRow[] = [
    {
      cells: pad([`RFQ SELECTION SUMMARY — ${EB_PRODUCT_NAMES[header.product].toUpperCase()}`]),
      style: 'title',
    },
    label('Company', header.company),
    label('Case reference', header.reference),
    label('Product', `${header.product} (${header.productName})`),
    label('Type of case', header.caseType),
    label('Policy period', header.policyPeriod),
    label('Ages in completed years on', formatDate(header.referenceDate)),
    label(
      'Age bands',
      `${header.ageBands.name}${header.ageBands.revision === null ? '' : ` (revision ${header.ageBands.revision})`}`,
    ),
    label('Family plan', header.plan ?? 'The Data Sheet’s family definition'),
    ...header.rules.map((rule) => label(rule.label, rule.value)),
    label('Census revision', String(header.censusRevision)),
    label(
      'Generated',
      `${formatDateTime(header.generatedAt)}${response.source === 'RFQ_VERSION' && response.rfqVersion !== null ? ` (as in RFQ v${response.rfqVersion})` : ''}`,
    ),
  ];

  if (summary.problems.length > 0) {
    rows.push(section('Not complete'));
    for (const problem of summary.problems) rows.push({ cells: [problem.message], style: 'note' });
  }

  // A. Employees and lives by cover.
  rows.push(
    section(`A. Employees and ${measure.toLowerCase()}`),
    {
      cells: pad([measure, 'Employees', 'Lives', `Total ${measure.toLowerCase()}`]),
      style: 'header',
    },
    ...summary.coverage.rows.map((row) => ({
      cells: pad([money(row.amount), row.employees, row.lives, money(row.total)]),
    })),
    {
      cells: pad([
        'Total',
        summary.coverage.employees,
        summary.coverage.lives,
        money(summary.coverage.total),
      ]),
      style: 'total',
    },
  );
  if (summary.floater) {
    rows.push({
      cells: [
        'Family floater: each family’s sum insured is counted once, on the employee; dependants share it.',
      ],
      style: 'note',
    });
  }

  // B. The age band matrix.
  rows.push(
    section(`B. Lives by age band and ${measure.toLowerCase()}`),
    {
      cells: [
        'Age band',
        ...categories.map((amount) => money(amount)),
        'Lives',
        `Total ${measure.toLowerCase()}`,
      ],
      style: 'header',
    },
    ...summary.matrix.rows.map((row) => ({
      cells: [
        row.kind === 'BAND' && row.label !== row.range ? `${row.label} (${row.range})` : row.label,
        ...row.lives,
        row.totalLives,
        row.totalCover === null ? '—' : money(row.totalCover),
      ],
    })),
    {
      cells: [
        'Total lives',
        ...summary.matrix.totals.lives,
        summary.matrix.totals.totalLives,
        summary.matrix.totals.totalCover === null ? '—' : money(summary.matrix.totals.totalCover),
      ],
      style: 'total',
    },
  );
  if (!summary.floater) {
    rows.push({
      cells: [
        `Total ${measure.toLowerCase()}`,
        ...summary.matrix.totals.cover.map((value) => (value === null ? '—' : money(value))),
        null,
        summary.matrix.totals.totalCover === null ? '—' : money(summary.matrix.totals.totalCover),
      ],
      style: 'total',
    });
  }

  // C. Demographics.
  rows.push(
    section('C. Gender and relationship'),
    { cells: pad(['Gender', 'Lives']), style: 'header' },
    ...GHI_GENDERS.map((gender) => ({
      cells: pad([GHI_GENDER_LABELS[gender], summary.genders[gender]]),
    })),
    { cells: pad(['Relationship', 'Lives']), style: 'header' },
    ...(
      ['SELF', 'SPOUSE', 'CHILD', 'FATHER', 'MOTHER', 'FATHER_IN_LAW', 'MOTHER_IN_LAW'] as const
    ).map((relationship) => ({
      cells: pad([GHI_RELATIONSHIP_LABELS[relationship], summary.relationships[relationship]]),
    })),
    { cells: pad(['Parents (father and mother)', summary.groups.parents]) },
    { cells: pad(['Parents-in-law', summary.groups.parentsInLaw]) },
    { cells: pad(['Total lives', summary.coverage.lives]), style: 'total' },
  );

  // D. Cover by relationship.
  rows.push(
    section(`D. ${measure} by relationship`),
    { cells: pad(['Relationship', 'Lives', `Total ${measure.toLowerCase()}`]), style: 'header' },
    ...summary.byRelationship.map((row) => ({
      cells: pad([
        GHI_RELATIONSHIP_LABELS[row.relationship],
        row.lives,
        row.total === null ? 'Shares the family’s' : money(row.total),
      ]),
    })),
    {
      cells: [
        `Worked out from the census as stored; ${summary.reconciled ? 'every count and total agrees with the census' : 'the figures do NOT agree with the census: see above'}.`,
      ],
      style: 'note',
    },
  );

  return {
    name: SELECTION_SUMMARY_SHEET,
    widths: [30, ...Array.from({ length: span - 1 }, () => 16)],
    rows: rows.map((row) =>
      row.style === 'header' || row.style === 'total' || !row.style
        ? { ...row, cells: pad(row.cells) }
        : row,
    ),
  };
}

export function selectionSummaryDocument(response: RfqSelectionSummaryResponse): DocumentModel {
  const { header } = response;
  return {
    title: `${header.product} RFQ Selection Summary ${header.reference} — ${header.company}`,
    fileBase: `${header.product}-RFQ-Selection-Summary-${header.reference}`,
    sheets: [selectionSummarySheet(response)],
  };
}
