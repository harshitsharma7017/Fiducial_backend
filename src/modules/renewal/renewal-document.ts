import {
  EB_PRODUCT_NAMES,
  RENEWAL_METRICS,
  RENEWAL_METRIC_LABELS,
  formatDate,
  formatDateTime,
  type RenewalAnalysis,
  type RenewalMetric,
} from '../../shared/index.ts';
import { money, type DocumentModel, type SheetCell, type SheetRow } from '../ghi/ghi-sheet.ts';

// The benefit and cost analysis (N8) as Excel and an A4 PDF, in Fiducial's built-in layout: the
// client's renewal analysis spreadsheet is not in the repository (open question BC-3). The years
// stand side by side, then each change, then the coming year's quotes.

const COUNTS: readonly RenewalMetric[] = ['employees', 'dependants', 'lives', 'claimsCount'];
const PERCENTS: readonly RenewalMetric[] = ['claimsRatio'];

function metricCell(metric: RenewalMetric, value: string | null): SheetCell {
  if (value === null) return 'Not available';
  if (COUNTS.includes(metric)) return Number(value);
  if (PERCENTS.includes(metric)) return `${value}%`;
  return money(value, true);
}

export function renewalDocument(analysis: RenewalAnalysis, title?: string): DocumentModel {
  const years = analysis.years;
  const changes = analysis.changes;
  const span = 1 + years.length + changes.length * 2;
  const pad = (cells: SheetCell[]) => [
    ...cells,
    ...Array.from({ length: Math.max(0, span - cells.length) }, () => null),
  ];
  const label = (name: string, value: string): SheetRow => ({
    cells: [name, value],
    style: 'label',
  });
  const rows: SheetRow[] = [
    {
      cells: pad([
        `BENEFIT AND COST ANALYSIS — ${EB_PRODUCT_NAMES[analysis.product].toUpperCase()}`,
      ]),
      style: 'title',
    },
    label('Company', analysis.company),
    ...(title ? [label('Report', title)] : []),
    label('Claims counted to', formatDate(analysis.asOf)),
    label('Generated', formatDateTime(analysis.generatedAt)),
    { cells: ['Policy years'], style: 'section' },
    {
      cells: pad([
        '',
        ...years.map((year) => year.label),
        ...changes.flatMap((list) => [`Change ${list[0]?.from ?? ''} → ${list[0]?.to ?? ''}`, '%']),
      ]),
      style: 'header',
    },
    { cells: pad(['Insurer', ...years.map((year) => year.insurerName ?? '—')]) },
    { cells: pad(['Policy number', ...years.map((year) => year.policyNumber ?? '—')]) },
    {
      cells: pad([
        'Source',
        ...years.map((year) =>
          year.source === 'POLICY' ? 'Placed in the app' : 'Recorded by hand',
        ),
      ]),
    },
    ...RENEWAL_METRICS.map((metric) => ({
      cells: pad([
        RENEWAL_METRIC_LABELS[metric],
        ...years.map((year) => metricCell(metric, year[metric].value)),
        ...changes.flatMap((list) => {
          const change = list.find((item) => item.metric === metric)!;
          return [
            change.absolute === null
              ? '—'
              : COUNTS.includes(metric)
                ? Number(change.absolute)
                : PERCENTS.includes(metric)
                  ? `${change.absolute} points`
                  : money(change.absolute, true),
            change.percent === null ? '—' : `${change.percent}%`,
          ];
        }),
      ]),
    })),
    {
      cells: pad([
        'Claims as of',
        ...years.map((year) => (year.claimsAsOf ? formatDate(year.claimsAsOf) : '—')),
      ]),
    },
  ];
  const amounts = [
    ...new Set(years.flatMap((year) => (year.bySumInsured ?? []).map((item) => item.amount))),
  ].sort((a, b) => Number(BigInt(a) - BigInt(b)));
  if (amounts.length > 0) {
    rows.push(
      { cells: ['Members by sum insured (lives)'], style: 'section' },
      { cells: pad(['Sum insured', ...years.map((year) => year.label)]), style: 'header' },
      ...amounts.map((amount) => ({
        cells: pad([
          money(amount),
          ...years.map((year) =>
            year.bySumInsured === null
              ? 'Not available'
              : (year.bySumInsured.find((item) => item.amount === amount)?.lives ?? 0),
          ),
        ]),
      })),
    );
  }
  if (analysis.upcoming) {
    rows.push(
      { cells: [`Coming year: quotes on ${analysis.upcoming.reference}`], style: 'section' },
      {
        cells: pad([
          'Insurer (quote version)',
          'Premium before GST',
          'GST',
          'Total',
          'Change vs latest year',
          '%',
        ]),
        style: 'header',
      },
      ...analysis.upcoming.quotes.map((quote) => ({
        cells: pad([
          `${quote.insurerName} (v${quote.quoteVersion})${quote.lowest ? ' — lowest' : ''}`,
          money(quote.basePremium, true),
          money(quote.gst, true),
          money(quote.totalPremium, true),
          quote.changeAbsolute === null ? '—' : money(quote.changeAbsolute, true),
          quote.changePercent === null ? '—' : `${quote.changePercent}%`,
        ]),
        style: quote.lowest ? ('highlight' as const) : undefined,
      })),
    );
  }
  rows.push(
    { cells: ['How the figures are worked out'], style: 'section' },
    ...analysis.parameters.map((item) => label(item.label, item.value)),
  );
  for (const year of years)
    for (const note of year.notes) rows.push({ cells: [`${year.label}: ${note}`], style: 'note' });
  for (const warning of analysis.warnings) rows.push({ cells: [warning], style: 'note' });
  return {
    title: `Benefit and Cost Analysis — ${analysis.company}`,
    fileBase: `Benefit-and-Cost-Analysis-${analysis.product}-${analysis.company.replace(/[^A-Za-z0-9]+/g, '-').slice(0, 40)}`,
    sheets: [
      {
        name: 'Benefit and Cost Analysis',
        widths: [44, ...Array.from({ length: span - 1 }, () => 18)],
        rows,
      },
    ],
  };
}
