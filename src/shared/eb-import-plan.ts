import {
  candidateFromMember,
  checkEbCensus,
  isError,
  type EbCandidate,
  type EbCensusContext,
  type EbCensusMember,
} from './eb-census-rules.ts';
import {
  EB_CENSUS_FIELD_LABELS,
  type EbCensusIssue,
  type EbImportMode,
  type EbImportResult,
  type EbRowMatch,
} from './eb-census.ts';
import type { GhiImportPolicy } from './ghi-census.ts';

// The import plan (Requirement 22), pure so its counts can be tested on their own: how each
// preview row matches the census under the mode, what the policy leaves out, and the census
// after the import. The API writes exactly what the plan says, in one transaction.

/** A census member as stored, with its id and employee identity. */
export interface ExistingMember extends EbCensusMember {
  id: string;
  employeeIdentityId: string | null;
}

export type UpdatableFields = Pick<EbCensusMember, 'sumInsured' | 'annualSalary' | 'dateOfJoining'>;

export interface RowPlan {
  key: string;
  row: number | null;
  match: EbRowMatch | null;
  issues: EbCensusIssue[];
  /** The member the row matches (SAME or CHANGED). */
  memberId: string | null;
}

export interface ImportPlan {
  rows: RowPlan[];
  /** New members, in row order. */
  add: Array<{ key: string; member: EbCensusMember }>;
  /** Members whose sum insured, salary or joining date change (Add and update only). */
  update: Array<{ key: string; memberId: string; changes: UpdatableFields }>;
  /** Rows equal to a member of the census. */
  unchanged: string[];
}

const sameMember = (a: EbCensusMember, b: EbCensusMember) =>
  a.employeeKey === b.employeeKey &&
  a.relationship === b.relationship &&
  a.nameKey === b.nameKey &&
  a.dateOfBirth === b.dateOfBirth;

const UPDATABLE = ['sumInsured', 'annualSalary', 'dateOfJoining'] as const;

function changedFields(member: EbCensusMember, row: EbCensusMember) {
  return UPDATABLE.filter((field) => (member[field] ?? null) !== (row[field] ?? null));
}

/**
 * Classifies every pending row (Requirement 22.2): a row matches a member when its employee key,
 * relationship, name (ignoring case and repeated spaces) and date of birth are the same. SAME is
 * unchanged; CHANGED is an error under Add new only and an update under Add and update; NEW rows
 * go through the Census_Validator with the matched members held in their places. LEGACY (a GMC
 * import without a mode, design D8) matches nothing: every row is checked as GMC does today.
 */
export function classifyImport(
  rows: readonly EbCandidate[],
  existing: readonly ExistingMember[],
  context: EbCensusContext,
  mode: EbImportMode | 'LEGACY',
): ImportPlan {
  if (mode === 'LEGACY') {
    const issues = checkEbCensus(rows, existing, context);
    const plan: ImportPlan = { rows: [], add: [], update: [], unchanged: [] };
    for (const row of rows) {
      const rowIssues = issues.get(row.key) ?? [];
      plan.rows.push({
        key: row.key,
        row: row.row,
        match: null,
        issues: rowIssues,
        memberId: null,
      });
      if (row.member && !rowIssues.some(isError))
        plan.add.push({ key: row.key, member: row.member });
    }
    return plan;
  }

  const rowPlans = new Map<string, RowPlan>();
  const matchedIds = new Set<string>();
  const updates = new Map<
    string,
    { candidate: EbCandidate; member: ExistingMember; changes: UpdatableFields }
  >();
  const fresh: EbCandidate[] = [];
  const freshKeys = new Set<string>();
  const addFresh = (row: EbCandidate) => {
    fresh.push(row);
    freshKeys.add(row.key);
  };

  for (const row of rows) {
    const plan: RowPlan = { key: row.key, row: row.row, match: null, issues: [], memberId: null };
    rowPlans.set(row.key, plan);
    const member = row.member;
    if (!member) {
      addFresh(row);
      continue;
    }
    const match = existing.find((item) => sameMember(item, member));
    if (!match) {
      plan.match = 'NEW';
      addFresh(row);
      continue;
    }
    plan.memberId = match.id;
    if (matchedIds.has(match.id)) {
      // A second row for the same member: a duplicate of the row before it (18.5).
      plan.match = 'NEW';
      addFresh(row);
      continue;
    }
    matchedIds.add(match.id);
    const changed = changedFields(match, member);
    if (changed.length === 0) {
      plan.match = 'SAME';
      continue;
    }
    plan.match = 'CHANGED';
    if (mode === 'ADD_NEW_ONLY') {
      plan.issues = changed.map((field) => ({
        row: row.row,
        employeeId: member.employeeId,
        name: member.name,
        relationship: member.relationship,
        field,
        value: row.values?.[field] ?? member[field] ?? null,
        message: `This member is already in the census with ${EB_CENSUS_FIELD_LABELS[field].toLowerCase()} ${match[field] ?? 'blank'}; the row has ${member[field] ?? 'blank'}`,
        fix: 'Import in “Add and update” mode to change it, or correct the row.',
        severity: 'ERROR' as const,
        code: 'MEMBER_CHANGED',
      }));
      continue;
    }
    updates.set(row.key, {
      candidate: row,
      member: match,
      changes: {
        sumInsured: member.sumInsured,
        annualSalary: member.annualSalary,
        dateOfJoining: member.dateOfJoining,
      },
    });
  }

  // Updated members are checked in their new form, in their own places, before new rows (18.2).
  const updatedIds = new Set([...updates.values()].map((item) => item.member.id));
  const kept = existing.filter((item) => !updatedIds.has(item.id));
  const updateCandidates = [...updates.entries()].map(([key, item]) => ({
    ...candidateFromMember(key, { ...item.member, ...item.changes }, item.candidate.label),
    row: item.candidate.row,
    values: item.candidate.values,
  }));
  const checked = checkEbCensus(
    [...updateCandidates, ...fresh],
    kept,
    // An existing employee is not "new": the unresolved check applies to new Self rows only.
    { ...context },
  );

  const plan: ImportPlan = { rows: [], add: [], update: [], unchanged: [] };
  for (const row of rows) {
    const rowPlan = rowPlans.get(row.key)!;
    if (updates.has(row.key) || freshKeys.has(row.key)) {
      rowPlan.issues = (checked.get(row.key) ?? []).filter(
        (issue) => !(updates.has(row.key) && issue.code === 'EMPLOYEE_UNRESOLVED'),
      );
    }
    plan.rows.push(rowPlan);
    const valid = !rowPlan.issues.some(isError);
    if (rowPlan.match === 'SAME') plan.unchanged.push(row.key);
    else if (updates.has(row.key) && valid) {
      const item = updates.get(row.key)!;
      plan.update.push({ key: row.key, memberId: item.member.id, changes: item.changes });
    } else if (freshKeys.has(row.key) && valid && row.member) {
      plan.add.push({ key: row.key, member: row.member });
    }
  }
  return plan;
}

export type PolicyOutcome =
  | {
      ok: true;
      add: ImportPlan['add'];
      update: ImportPlan['update'];
      unchanged: string[];
      skipped: RowPlan[];
    }
  | { ok: false; reason: 'INVALID_ROWS' | 'NO_VALID_ROWS'; invalid: number };

/**
 * Applies the import policy (22.1, 22.10): All valid refuses when any row has an error; Valid
 * only leaves the invalid rows out (a dependant whose employee's row fails already has its own
 * error) and refuses when no row is valid.
 */
export function applyPolicy(plan: ImportPlan, policy: GhiImportPolicy): PolicyOutcome {
  const invalidRows = plan.rows.filter((row) => row.issues.some(isError));
  if (policy === 'ALL_VALID' && invalidRows.length > 0) {
    return { ok: false, reason: 'INVALID_ROWS', invalid: invalidRows.length };
  }
  if (invalidRows.length === plan.rows.length) {
    return { ok: false, reason: 'NO_VALID_ROWS', invalid: invalidRows.length };
  }
  return {
    ok: true,
    add: plan.add,
    update: plan.update,
    unchanged: plan.unchanged,
    skipped: invalidRows,
  };
}

/** The import's counts (22.4): they add up to the rows, and identities to the Self rows added. */
export function importResultOf(
  outcome: Extract<PolicyOutcome, { ok: true }>,
  identities: { created: number; reused: number },
): EbImportResult {
  return {
    added: outcome.add.length,
    updated: outcome.update.length,
    unchanged: outcome.unchanged.length,
    skipped: outcome.skipped.length,
    identitiesCreated: identities.created,
    identitiesReused: identities.reused,
    leftOut: outcome.skipped.map((row) => ({
      row: row.row ?? 0,
      employeeId: row.issues[0]?.employeeId ?? null,
      issues: row.issues,
    })),
  };
}

/** Employee keys of the Self members an import adds. */
export function selfKeysAdded(add: ImportPlan['add']): string[] {
  return add
    .filter((item) => item.member.relationship === 'SELF')
    .map((item) => item.member.employeeKey);
}

/** The census after the import: the pure model of what the API writes. */
export function applyImportPlan(
  existing: readonly ExistingMember[],
  outcome: Pick<Extract<PolicyOutcome, { ok: true }>, 'add' | 'update'>,
  identities: ReadonlyMap<string, string> = new Map(),
): ExistingMember[] {
  const changes = new Map(outcome.update.map((item) => [item.memberId, item.changes]));
  const updated = existing.map((member) => {
    const change = changes.get(member.id);
    return change ? { ...member, ...change } : member;
  });
  const added = outcome.add.map((item, index) => ({
    ...item.member,
    id: `new-${index}`,
    employeeIdentityId:
      item.member.relationship === 'SELF'
        ? (identities.get(item.member.employeeKey) ?? null)
        : null,
  }));
  return [...updated, ...added];
}
