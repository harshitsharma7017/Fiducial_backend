import { EQ_ZONE_LABELS, EQ_ZONES, RISK_TYPES, RISK_TYPE_LABELS } from '../../../shared/index.ts';
import { occupancyWarningCount, pincodeWarningCount, type ImportReport } from './types.ts';

/** Entries listed per section before the rest are summarised. */
const LIST_LIMIT = 25;

function shorten(text: string, length = 48): string {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function list<T>(items: T[], render: (item: T) => string, limit = LIST_LIMIT): string[] {
  if (items.length === 0) return ['    none'];
  const lines = items.slice(0, limit).map((item) => `    ${render(item)}`);
  if (items.length > limit) lines.push(`    … and ${items.length - limit} more`);
  return lines;
}

function digitsText(digits: string): string {
  return digits.split('').join(' or ');
}

function rows(count: number): string {
  return `${count} ${count === 1 ? 'row' : 'rows'}`;
}

/** Human-readable import report printed by scripts/import-masters.ts. */
export function formatImportReport(report: ImportReport): string {
  const occupancy = report.occupancy;
  const pincode = report.pincode;
  const check = report.crossCheck;
  const lines: string[] = [];

  lines.push('IIB master import report');
  lines.push(`Source: ${report.sourceFileName} (sha256 ${report.sourceSha256.slice(0, 16)}…)`);
  lines.push('');

  lines.push(`Occupancies (sheet "${occupancy.sheet}")`);
  lines.push(
    `  Rows read: ${occupancy.rowsRead}   Valid: ${occupancy.recordsValid}   Skipped: ${occupancy.rowsSkipped}`,
  );
  if (occupancy.rateYearLabel) lines.push(`  IIB rate column label: ${occupancy.rateYearLabel}`);
  lines.push(
    `  Skipped rows (${occupancy.skippedRows.length}):`,
    ...list(
      occupancy.skippedRows,
      (s) => `row ${s.row}: ${s.reason}${s.value ? ` (${s.value})` : ''}`,
    ),
  );
  lines.push(
    `  Blank risk types (${occupancy.blankRiskTypes.length}):`,
    ...list(
      occupancy.blankRiskTypes,
      (b) => `row ${b.row}, ${b.tacCode} ${shorten(b.description)}: ${b.field} risk type is blank`,
    ),
  );
  if (occupancy.unrecognisedRiskTypes.length > 0) {
    lines.push(
      `  Unrecognised risk types, stored as blank (${occupancy.unrecognisedRiskTypes.length}):`,
      ...list(
        occupancy.unrecognisedRiskTypes,
        (u) => `row ${u.row}, ${u.tacCode}: ${u.field} "${u.value}"`,
      ),
    );
  }

  const ratesByRow = new Map<number, ImportReport['occupancy']['nonNumericRates']>();
  for (const cell of occupancy.nonNumericRates) {
    ratesByRow.set(cell.row, [...(ratesByRow.get(cell.row) ?? []), cell]);
  }
  lines.push(
    `  Rate cells that are not numeric (${occupancy.nonNumericRates.length} cells in ${ratesByRow.size} rows):`,
    ...list([...ratesByRow.values()], (cells) => {
      const first = cells[0];
      const texts = cells
        .filter((c) => c.value !== null)
        .map((c) => `${c.field} "${shorten(c.value ?? '', 60)}"`);
      const blanks = cells.filter((c) => c.value === null).map((c) => c.field);
      const parts = [...texts, ...(blanks.length > 0 ? [`blank: ${blanks.join(', ')}`] : [])];
      return `row ${first?.row}, ${first?.tacCode} ${shorten(first?.description ?? '', 32)}: ${parts.join('; ')}`;
    }),
  );
  lines.push(
    `  Risk grade blank or not RG1 to RG9 (${occupancy.riskGradeIssues.length}):`,
    ...list(
      occupancy.riskGradeIssues,
      (g) => `row ${g.row}, ${g.tacCode}: ${g.value === null ? 'blank' : `"${g.value}"`}`,
    ),
  );
  if (occupancy.otherWarnings.length > 0) {
    lines.push(
      `  Other warnings (${occupancy.otherWarnings.length}):`,
      ...list(occupancy.otherWarnings, (w) => `row ${w.row}: ${w.message}`),
    );
  }
  lines.push(
    `  Highlighted rows; the sheet does not say what the colour means (${occupancy.highlightedRows.length}):`,
    ...list(
      occupancy.highlightedRows,
      (h) => `row ${h.row}, ${h.tacCode} ${shorten(h.description)}: fill ${h.colour}`,
    ),
  );
  lines.push('');

  lines.push(`Pincodes (sheet "${pincode.sheet}")`);
  lines.push(
    `  Rows read: ${pincode.rowsRead}   Valid: ${pincode.recordsValid}   Skipped: ${pincode.rowsSkipped}`,
  );
  lines.push(
    `  Pincodes that are not six digits (${pincode.skippedRows.length}):`,
    ...list(pincode.skippedRows, (s) => `row ${s.row}: ${s.value ?? 'blank'}`),
  );
  lines.push(
    `  Duplicate pincodes, first row kept (${pincode.duplicates.length}):`,
    ...list(
      pincode.duplicates,
      (d) =>
        `${d.pincode}: kept row ${d.keptRow}, skipped row ${d.duplicateRow} (${d.identical ? 'identical' : 'values differ'})`,
    ),
  );
  lines.push(
    `  Rate cells that are not numeric (${pincode.nonNumericRates.length}):`,
    ...list(
      pincode.nonNumericRates,
      (r) =>
        `row ${r.row}, ${r.pincode}: ${r.field} ${r.value === null ? 'blank' : `"${r.value}"`}`,
    ),
  );
  if (pincode.invalidZones.length > 0) {
    lines.push(
      `  Earthquake zone blank or not 1 to 4 (${pincode.invalidZones.length}):`,
      ...list(pincode.invalidZones, (z) => `row ${z.row}, ${z.pincode}: ${z.value ?? 'blank'}`),
    );
  }
  if (pincode.blankFields.length > 0) {
    lines.push(
      `  Blank state or district (${pincode.blankFields.length}):`,
      ...list(pincode.blankFields, (b) => `row ${b.row}, ${b.pincode}: ${b.field} is blank`),
    );
  }
  lines.push(
    `  State values that are not a current state or union territory (${pincode.unrecognisedStates.length}):`,
    ...list(
      pincode.unrecognisedStates,
      (s) =>
        `"${s.value}": ${rows(s.rows)}${s.suggestion ? ` (current name: ${s.suggestion})` : ''}`,
    ),
  );
  lines.push(
    `  States written more than one way (${pincode.inconsistentStateSpellings.length}):`,
    ...list(
      pincode.inconsistentStateSpellings,
      (s) => `${s.state}: ${s.spellings.map((v) => `"${v.value}" ${v.rows}`).join(', ')}`,
    ),
  );
  lines.push(
    `  Pincode outside the state's postal region (${pincode.regionMismatches.length}):`,
    ...list(
      pincode.regionMismatches,
      (m) =>
        `${m.pincode} ${m.state} / ${m.district} (row ${m.row}): ${m.regionState} pincodes start with ${digitsText(m.expectedFirstDigits)}`,
    ),
  );
  lines.push('');

  lines.push(
    'Cross-check: pincode EQ rates against the occupancy minimum EQ rates for the same zone',
  );
  lines.push('  Reference: most common occupancy value per Fire risk type and zone (per mille)');
  const width = 16;
  lines.push(
    `    ${''.padEnd(width)}${EQ_ZONES.map((z) => EQ_ZONE_LABELS[z].padEnd(10)).join('')}`,
  );
  for (const riskType of RISK_TYPES) {
    const rates = check.reference[riskType];
    const cells = EQ_ZONES.map((zone) => (rates[`zone${zone}`] ?? '-').padEnd(10)).join('');
    lines.push(`    ${RISK_TYPE_LABELS[riskType].padEnd(width)}${cells}`);
  }
  lines.push(
    `  Occupancies that differ from the reference (${check.occupancyDeviations.length}):`,
    ...list(
      check.occupancyDeviations,
      (d) =>
        `${d.tacCode} (row ${d.row}, ${RISK_TYPE_LABELS[d.riskType]}): ${d.zones
          .map((z) => `${EQ_ZONE_LABELS[z.zone]} ${z.value} (reference ${z.reference})`)
          .join(', ')}`,
    ),
  );
  lines.push(
    `  Pincodes with an EQ rate that differs from the reference: ${check.pincodesWithMismatch}`,
  );
  lines.push(
    ...list(
      check.mismatchGroups,
      (g) =>
        `${EQ_ZONE_LABELS[g.zone]}, ${RISK_TYPE_LABELS[g.riskType]}: pincode rate ${g.pincodeRate ?? 'blank'}, reference ${g.expected}: ${g.count} pincodes (e.g. ${g.samplePincodes.join(', ')})`,
    ),
  );
  lines.push('');

  const errors = occupancy.skippedRows.length + pincode.skippedRows.length;
  const warnings = occupancyWarningCount(report) + pincodeWarningCount(report);
  lines.push(
    `Summary: ${occupancy.recordsValid} occupancies and ${pincode.recordsValid} pincodes (after de-duplication) ` +
      `ready; ${errors} rows skipped as errors; ${warnings} warnings. Mismatches are reported, not corrected.`,
  );
  return lines.join('\n');
}
