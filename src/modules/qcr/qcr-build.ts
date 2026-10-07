import {
  formatDate,
  formatIndianNumber,
  quoteExpectation,
  quoteTotals,
  type ProposalQuotes,
  type ProposalRecord,
  type QcrOption,
  type QuoteVersion,
} from '../../shared/index.ts';

// The comparison itself (QC-1, QC-2), worked out from the case and its quotes without a database:
// each option's sections, the existing policy, the latest quote of every insurer compared, the
// lowest total, and where the insurers' cover differs.

const toPaise = (value: string) => {
  const [rupees = '0', paise = ''] = value.split('.');
  return BigInt(rupees) * 100n + BigInt(paise.padEnd(2, '0').slice(0, 2));
};
const fromPaise = (paise: bigint) =>
  `${paise / 100n}.${(paise % 100n).toString().padStart(2, '0')}`;

export interface Comparison {
  insurers: ProposalQuotes['insurers'];
  options: QcrOption[];
}

/** Every version of the case's quotes, by id. */
function versionsById(quotes: ProposalQuotes): Map<string, QuoteVersion> {
  return new Map(
    quotes.insurers.flatMap((insurer) =>
      insurer.quotes.flatMap(({ versions }) =>
        versions.map((version) => [version.id, version] as const),
      ),
    ),
  );
}

/** Where the quotes of an option differ (QC-2): only topics on which not every insurer agrees. */
function differencesOf(
  record: ProposalRecord,
  option: QcrOption['option'],
  quoted: readonly { insurerId: string; version: QuoteVersion }[],
): QcrOption['differences'] {
  if (quoted.length < 2) return [];
  const expectation = quoteExpectation(record, option);
  const topics: { topic: string; value: (quote: QuoteVersion) => string }[] = [
    ...expectation.sections.map((section) => ({
      topic: `${section.name}: cover`,
      value: (quote: QuoteVersion) => {
        const entry = quote.sections.find((item) => item.code === section.code);
        if (!entry?.premium) return 'Not quoted';
        return entry.sumInsured ? `On ₹${formatIndianNumber(entry.sumInsured, 0)}` : 'As asked';
      },
    })),
    ...expectation.asked.map((name) => ({
      topic: name,
      value: (quote: QuoteVersion) => {
        const term = quote.terms.find((item) => item.name.toLowerCase() === name.toLowerCase());
        return term === undefined ? 'Not answered' : term.accepted ? 'Accepted' : 'Declined';
      },
    })),
    {
      topic: 'Capacity',
      value: (quote) => (quote.capacityPercent ? `${quote.capacityPercent}%` : 'Not stated'),
    },
    {
      topic: 'Valid until',
      value: (quote) => (quote.validUntil ? formatDate(quote.validUntil) : 'Not stated'),
    },
    { topic: 'Deductibles', value: (quote) => quote.deductibles ?? '—' },
    { topic: 'Conditions', value: (quote) => quote.conditions ?? '—' },
  ];
  return topics.flatMap(({ topic, value }) => {
    const values = quoted.map(({ insurerId, version }) => ({ insurerId, value: value(version) }));
    return new Set(values.map((item) => item.value)).size > 1 ? [{ topic, values }] : [];
  });
}

/**
 * The QCR's figures: for each option of the case, the existing policy (renewals), and the latest
 * quote of every insurer compared, Fire without terrorism where quoted so, with net, GST and
 * total exactly as the quote entries give them.
 */
export function buildComparison(
  record: ProposalRecord,
  quotes: ProposalQuotes,
  gstRatePercent: string,
): Comparison {
  const versions = versionsById(quotes);
  const latest = new Map(quotes.qcr.map((entry) => [`${entry.insurerId}|${entry.option}`, entry]));
  // Insurers that have not declined and have a quote to compare, in the case's order; five at most.
  const insurers = quotes.insurers
    .filter(
      (insurer) =>
        !insurer.declined && quotes.qcr.some((entry) => entry.insurerId === insurer.insurerId),
    )
    .slice(0, 5);
  const renewal = record.type === 'EXISTING';
  const existingPremium = new Map(
    record.existingPolicy?.sections.map((section) => [section.code, section.premium]) ?? [],
  );
  const existingSum = new Map<string, string | null>([
    ['FIRE', record.fire.existing],
    ...record.sections.map((section) => [section.code, section.existing] as const),
  ]);

  const options = quotes.options.map((option): QcrOption => {
    const expectation = quoteExpectation(record, option);
    const sections = expectation.sections.map((section) => ({
      code: section.code,
      name: section.name,
      existingSumInsured: renewal ? (existingSum.get(section.code) ?? null) : null,
      existingPremium: renewal ? (existingPremium.get(section.code as never) ?? null) : null,
      sumInsured: section.sumInsured,
    }));
    const existing =
      renewal && sections.some((section) => section.existingPremium !== null)
        ? quoteTotals(
            sections.map((section) => ({ code: section.code, premium: section.existingPremium })),
            gstRatePercent,
          ).withTerrorism
        : null;

    const quoted = insurers.flatMap((insurer) => {
      const entry = latest.get(`${insurer.insurerId}|${option}`);
      const version = entry ? versions.get(entry.quoteId) : undefined;
      return version ? [{ insurerId: insurer.insurerId, version }] : [];
    });
    const rows = quoted.map(({ insurerId, version }) => {
      const fire = version.sections.find((section) => section.code === 'FIRE');
      const premiums = sections.map((section) => {
        const entry = version.sections.find((item) => item.code === section.code);
        const premium =
          section.code === 'FIRE'
            ? (entry?.premiumWithoutTerrorism ?? entry?.premium ?? null)
            : (entry?.premium ?? null);
        return { code: section.code, premium };
      });
      const totals = quoteTotals(premiums, version.gstRatePercent).withTerrorism;
      const without = version.totals.withoutTerrorism;
      return {
        insurerId,
        quoteId: version.id,
        version: version.version,
        premiums,
        fireWithTerrorism: Boolean(fire?.premium) && !fire?.premiumWithoutTerrorism,
        totals,
        terrorismExtra: without
          ? fromPaise(toPaise(version.totals.withTerrorism.net) - toPaise(without.net))
          : null,
        deviations: version.deviations,
        lowest: false,
      };
    });
    const totals = rows.map((row) => toPaise(row.totals.total));
    const lowest =
      totals.length > 0 ? totals.reduce((min, value) => (value < min ? value : min)) : null;
    return {
      option,
      sections,
      existing,
      quotes: rows.map((row) => ({
        ...row,
        lowest: lowest !== null && toPaise(row.totals.total) === lowest,
      })),
      differences: differencesOf(record, option, quoted),
    };
  });
  return { insurers, options };
}
