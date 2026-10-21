import {
  GHI_COVERAGE_TYPE_LABELS,
  GHI_WAIVERS,
  GHI_WAIVER_LABELS,
  formatIndianNumber,
  type GhiComparison,
  type GhiDeviation,
  type GhiQuoteTermsInput,
  type GhiRequirementsInput,
  type GhiWaiver,
} from '../../shared/index.ts';
import { Decimal, ROUND_HALF_UP, moneyString } from '../../lib/decimal.ts';

// GHI premiums and the comparison of each quote with the RFQ (G6), pure so they can be tested on
// their own. GST is worked out on the base premium at the case's rate and rounded half up to the
// paisa, as on Property quotes; the total is base + GST.

export interface Premium {
  basePremium: string;
  gst: string;
  totalPremium: string;
}

export function premiumOf(basePremium: string, gstRatePercent: string): Premium {
  const base = new Decimal(basePremium);
  const gst = base.times(gstRatePercent).dividedBy(100).toDecimalPlaces(2, ROUND_HALF_UP);
  return {
    basePremium: moneyString(base),
    gst: moneyString(gst),
    totalPremium: moneyString(base.plus(gst)),
  };
}

export interface ComparedRow {
  key: string;
  label: string;
  requested: string;
  offered: string;
  kind: GhiComparison;
}

const NOT_STATED = 'Not stated';
const yesNo = (value: boolean | null) => (value === null ? NOT_STATED : value ? 'Yes' : 'No');
const rupees = (value: string | null) =>
  value === null ? NOT_STATED : `₹${formatIndianNumber(value, 0)}`;
const percent = (value: string | null) =>
  value === null ? NOT_STATED : `${new Decimal(value).toFixed()}%`;

/** A yes/no term: asking for it and being refused is a deviation; more than asked is better. */
function compareYesNo(requested: boolean | null, offered: boolean | null): GhiComparison {
  if (requested === null) return 'NOT_ASKED';
  if (offered === null) return 'MISSING';
  if (requested === offered) return 'MATCH';
  return requested ? 'DEVIATION' : 'BETTER';
}

/** An amount where more is better for the insured (a limit, a buffer). */
function compareAtLeast(requested: string | null, offered: string | null): GhiComparison {
  if (requested === null) return 'NOT_ASKED';
  if (offered === null) return 'MISSING';
  const order = new Decimal(offered).comparedTo(requested);
  return order === 0 ? 'MATCH' : order > 0 ? 'BETTER' : 'DEVIATION';
}

/** An amount where less is better for the insured (a co-payment, a waiting period). */
function compareAtMost(requested: string | null, offered: string | null): GhiComparison {
  if (requested === null) return 'NOT_ASKED';
  if (offered === null) return 'MISSING';
  const order = new Decimal(offered).comparedTo(requested);
  return order === 0 ? 'MATCH' : order < 0 ? 'BETTER' : 'DEVIATION';
}

type RoomRent = GhiRequirementsInput['roomRent'];

function roomRentText(roomRent: RoomRent): string {
  switch (roomRent.kind) {
    case null:
      return NOT_STATED;
    case 'NO_LIMIT':
      return 'No capping';
    case 'PERCENT_OF_SI':
      return `Normal ${percent(roomRent.normal)} of SI, ICU ${percent(roomRent.icu)} of SI`;
    case 'FIXED_AMOUNT':
      return `Normal ${rupees(roomRent.normal)}/day, ICU ${rupees(roomRent.icu)}/day`;
  }
}

function compareRoomRent(requested: RoomRent, offered: RoomRent): GhiComparison {
  if (requested.kind === null) return 'NOT_ASKED';
  if (offered.kind === null) return 'MISSING';
  if (offered.kind === 'NO_LIMIT') return requested.kind === 'NO_LIMIT' ? 'MATCH' : 'BETTER';
  if (requested.kind === 'NO_LIMIT' || requested.kind !== offered.kind) return 'DEVIATION';
  const parts = (['normal', 'icu'] as const).map((key) =>
    compareAtLeast(requested[key], offered[key]),
  );
  if (parts.includes('DEVIATION')) return 'DEVIATION';
  if (parts.includes('MISSING')) return 'MISSING';
  return parts.includes('BETTER') ? 'BETTER' : 'MATCH';
}

/** The waiting period that each waiver removes, and its unit. */
const WAITING_FOR_WAIVER: Partial<
  Record<GhiWaiver, { key: keyof GhiQuoteTermsInput['waitingPeriods']; unit: string }>
> = {
  initialWaitingPeriod: { key: 'initialDays', unit: 'days' },
  twoYearExclusions: { key: 'specificDiseasesMonths', unit: 'months' },
  preExistingWaitingPeriod: { key: 'preExistingMonths', unit: 'months' },
};

/** Every compared term, in the QCR's order, with what was asked and what is offered. */
export function compareTerms(
  requested: GhiRequirementsInput,
  offered: GhiQuoteTermsInput,
  /** Whether the cover includes parents (design D6); the Data Sheet's family definition when left out. */
  parentsCovered: boolean = requested.familyDefinition.parents !== 'NONE',
): ComparedRow[] {
  const rows: ComparedRow[] = [];
  const add = (key: string, label: string, asked: string, given: string, kind: GhiComparison) =>
    rows.push({ key, label, requested: asked, offered: given, kind });

  add(
    'coverageType',
    'Coverage',
    requested.coverageType ? GHI_COVERAGE_TYPE_LABELS[requested.coverageType] : NOT_STATED,
    offered.coverageType ? GHI_COVERAGE_TYPE_LABELS[offered.coverageType] : NOT_STATED,
    requested.coverageType === null
      ? 'NOT_ASKED'
      : offered.coverageType === null
        ? 'MISSING'
        : requested.coverageType === offered.coverageType
          ? 'MATCH'
          : 'DEVIATION',
  );
  add(
    'roomRent',
    'Room rent',
    roomRentText(requested.roomRent),
    roomRentText(offered.roomRent),
    compareRoomRent(requested.roomRent, offered.roomRent),
  );
  const maternity = requested.maternity;
  add(
    'maternity.covered',
    'Maternity',
    yesNo(maternity.covered),
    yesNo(offered.maternity.covered),
    compareYesNo(maternity.covered, offered.maternity.covered),
  );
  const maternityAsked = maternity.covered === true;
  for (const [key, label] of [
    ['normalLimit', 'Maternity limit: normal delivery'],
    ['cesareanLimit', 'Maternity limit: caesarean'],
  ] as const) {
    // No maternity cover at all leaves every requested limit unmet, not merely unstated.
    const refused = offered.maternity.covered === false;
    add(
      `maternity.${key}`,
      label,
      maternityAsked ? rupees(maternity[key]) : NOT_STATED,
      refused ? 'Not covered' : rupees(offered.maternity[key]),
      !maternityAsked || maternity[key] === null
        ? 'NOT_ASKED'
        : refused
          ? 'DEVIATION'
          : compareAtLeast(maternity[key], offered.maternity[key]),
    );
  }
  add(
    'maternity.newbornCovered',
    'New-born baby covered from day 1',
    yesNo(maternity.newbornCovered),
    yesNo(offered.maternity.newbornCovered),
    compareYesNo(maternity.newbornCovered, offered.maternity.newbornCovered),
  );
  add(
    'maternity.nineMonthWaiver',
    '9-month maternity waiting period waived',
    yesNo(maternity.nineMonthWaiver),
    yesNo(offered.maternity.nineMonthWaiver),
    compareYesNo(maternity.nineMonthWaiver, offered.maternity.nineMonthWaiver),
  );
  add(
    'preExistingDiseases',
    'Pre-existing diseases covered',
    yesNo(requested.preExistingDiseases.covered),
    yesNo(offered.preExistingCovered),
    compareYesNo(requested.preExistingDiseases.covered, offered.preExistingCovered),
  );
  add(
    'parentsCoPayPercent',
    'Co-payment for parents',
    parentsCovered ? percent(requested.parentsCoPayPercent) : 'Parents not covered',
    percent(offered.parentsCoPayPercent),
    parentsCovered
      ? compareAtMost(requested.parentsCoPayPercent, offered.parentsCoPayPercent)
      : 'NOT_ASKED',
  );
  for (const waiver of GHI_WAIVERS) {
    add(
      `waivers.${waiver}`,
      GHI_WAIVER_LABELS[waiver],
      yesNo(requested.waivers[waiver]),
      yesNo(offered.waivers[waiver]),
      compareYesNo(requested.waivers[waiver], offered.waivers[waiver]),
    );
    const waiting = WAITING_FOR_WAIVER[waiver];
    if (waiting) {
      const days = offered.waitingPeriods[waiting.key];
      const given = days === null ? NOT_STATED : `${days} ${waiting.unit}`;
      const waived = requested.waivers[waiver] === true;
      add(
        `waitingPeriods.${waiting.key}`,
        `Waiting period (${waiting.unit}): ${GHI_WAIVER_LABELS[waiver].replace(/ waived$/, '').toLowerCase()}`,
        waived ? `0 ${waiting.unit}` : NOT_STATED,
        given,
        waived ? compareAtMost('0', days === null ? null : String(days)) : 'NOT_ASKED',
      );
    }
  }
  const maternityWaiting = offered.waitingPeriods.maternityMonths;
  add(
    'waitingPeriods.maternityMonths',
    'Waiting period (months): maternity',
    maternity.nineMonthWaiver === true ? '0 months' : NOT_STATED,
    maternityWaiting === null ? NOT_STATED : `${maternityWaiting} months`,
    maternity.nineMonthWaiver === true
      ? compareAtMost('0', maternityWaiting === null ? null : String(maternityWaiting))
      : 'NOT_ASKED',
  );
  add(
    'corporateBuffer',
    'Corporate buffer',
    rupees(requested.corporateBuffer.amount),
    rupees(offered.corporateBufferAmount),
    compareAtLeast(requested.corporateBuffer.amount, offered.corporateBufferAmount),
  );
  return rows;
}

/** A quote's deviations from the RFQ and the information it leaves out. */
export function deviationsOf(
  requested: GhiRequirementsInput,
  offered: GhiQuoteTermsInput,
  parentsCovered?: boolean,
): GhiDeviation[] {
  return compareTerms(requested, offered, parentsCovered).flatMap((row) =>
    row.kind === 'DEVIATION' || row.kind === 'MISSING'
      ? [
          {
            field: row.key,
            label: row.label,
            requested: row.requested,
            offered: row.offered === NOT_STATED ? null : row.offered,
            kind: row.kind,
          },
        ]
      : [],
  );
}

/** Indexes of the lowest total among the totals given (all of them on a tie). */
export function lowestTotals(totals: readonly string[]): Set<number> {
  if (totals.length === 0) return new Set();
  let lowest = new Decimal(totals[0]!);
  for (const total of totals) if (new Decimal(total).lessThan(lowest)) lowest = new Decimal(total);
  return new Set(
    totals.flatMap((total, index) => (new Decimal(total).equals(lowest) ? [index] : [])),
  );
}
