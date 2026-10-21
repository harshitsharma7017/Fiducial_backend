import {
  AUDIT_ACTIONS,
  ERROR_CODES,
  GHI_RELATIONSHIPS,
  ghiFieldOf,
  identityMismatches,
  rowValuesOf,
  type EbImportMode,
  type EbMember,
  GHI_RELATIONSHIP_LABELS,
  type GhiCensusImport,
  type GhiCensusIssue,
  type GhiCensusRowValues,
  type GhiCensusSummary,
  type GhiCommitResult,
  type GhiImportPolicy,
  type GhiMember,
  type GhiMemberInput,
  type GhiMemberListQuery,
  type GhiMemberListResponse,
} from '../../shared/index.ts';
import { Types, type PipelineStage, type mongo } from 'mongoose';
import { withTransaction } from '../../lib/db.ts';
import { toDecimal128 } from '../../lib/decimal.ts';
import { conflict, notFound, validationError } from '../../lib/errors.ts';
import { escapeRegExp } from '../../lib/text.ts';
import {
  ageOn,
  checkCensus,
  memberFromInput,
  type Candidate,
  type CensusMember,
} from './census-rules.ts';
import { effectiveSumInsured } from './census-summary.ts';
import {
  commitEbImport,
  correctEbImportRow,
  discardEbImport,
  ebErrorReport,
  getEbImport,
  toGhiImport,
  uploadEbCensus,
} from './eb-census-import.service.ts';
import {
  ensureSelfIdentities,
  identityContext,
  unresolvedConflict,
} from '../employees/employees.service.ts';
import {
  addEbMember,
  deleteEbMember,
  ebCensusIssues,
  updateEbMember,
} from './eb-members.service.ts';
import { GMC_SCOPE } from './products/profile.ts';
import {
  assertEditable,
  auditCase,
  censusSettingsOf,
  loadCase,
  loadSummary,
  nameOf,
  referenceDateOf,
  userNames,
  type Actor,
} from './ghi-common.ts';
import { GhiCaseModel, type GhiCaseDoc } from './ghi-case.model.ts';
import { GhiCensusImportModel, GhiMemberModel, type GhiMemberDoc } from './ghi-census.model.ts';

// The census (G3): members added or edited one at a time, or imported from a checked file. Every
// change is checked by census-rules.ts against the Data Sheet and the rest of the census, and
// bumps the case's census revision so an approved RFQ knows it is out of date.

const RELATIONSHIP_RANK = {
  $indexOfArray: [GHI_RELATIONSHIPS as unknown as string[], '$relationship'],
};

function toCensusMember(doc: GhiMemberDoc): CensusMember {
  return {
    employeeId: doc.employeeId,
    employeeKey: doc.employeeKey,
    name: doc.name,
    nameKey: doc.nameKey,
    gender: doc.gender,
    dateOfBirth: doc.dateOfBirth,
    relationship: doc.relationship,
    dateOfJoining: doc.dateOfJoining,
    sumInsured: doc.sumInsured?.toString() ?? null,
  };
}

export function toMember(doc: GhiMemberDoc, referenceDate: string): GhiMember {
  return {
    id: doc._id.toHexString(),
    employeeId: doc.employeeId,
    name: doc.name,
    gender: doc.gender,
    dateOfBirth: doc.dateOfBirth,
    relationship: doc.relationship,
    dateOfJoining: doc.dateOfJoining,
    sumInsured: doc.sumInsured?.toString() ?? null,
    age: ageOn(doc.dateOfBirth, referenceDate),
    source: doc.source,
    updatedAt: doc.updatedAt.toISOString(),
  };
}

/** Every member of a case, families together: employee first, then spouse, children, parents. */
export async function allMembers(
  caseId: Types.ObjectId,
  session?: mongo.ClientSession,
): Promise<GhiMemberDoc[]> {
  return GhiMemberModel.aggregate<GhiMemberDoc>([
    { $match: { caseId } },
    { $addFields: { rank: RELATIONSHIP_RANK } },
    { $sort: { employeeKey: 1, rank: 1, dateOfBirth: 1, _id: 1 } },
    { $project: { rank: 0 } },
  ]).session(session ?? null);
}

function issuesToValidation(issues: readonly GhiCensusIssue[]) {
  return validationError(
    issues.map((item) => ({
      location: 'body' as const,
      path: item.field ?? '',
      message: item.message,
    })),
    issues[0]?.message ?? 'The member cannot be added',
  );
}

async function bumpCensus(
  doc: GhiCaseDoc,
  actorId: Types.ObjectId,
  message: string,
  session: mongo.ClientSession,
): Promise<void> {
  // Guarded so a census change cannot slip in after the RFQ went out.
  const result = await GhiCaseModel.updateOne(
    {
      _id: doc._id,
      stage: { $ne: 'CLOSED' },
      insurers: { $not: { $elemMatch: { sentAt: { $ne: null } } } },
    },
    {
      $inc: { censusRevision: 1 },
      $set: { updatedBy: actorId },
      $push: { activity: { at: new Date(), actorId, message } },
    },
    { session },
  );
  if (result.modifiedCount === 0) assertEditable(await loadCase(doc._id.toHexString(), session));
}

export async function listMembers(
  id: string,
  query: GhiMemberListQuery,
): Promise<GhiMemberListResponse> {
  const doc = await loadCase(id);
  const match: Record<string, unknown> = { caseId: doc._id };
  if (query.relationship) match.relationship = query.relationship;
  if (query.q) {
    const pattern = new RegExp(escapeRegExp(query.q.trim()), 'i');
    match.$or = [{ name: pattern }, { employeeId: pattern }];
  }
  const pipeline: PipelineStage[] = [
    { $match: match },
    { $addFields: { rank: RELATIONSHIP_RANK } },
    { $sort: { employeeKey: 1, rank: 1, dateOfBirth: 1, _id: 1 } },
    { $skip: (query.page - 1) * query.limit },
    { $limit: query.limit },
    { $project: { rank: 0 } },
  ];
  const [total, docs] = await Promise.all([
    GhiMemberModel.countDocuments(match),
    GhiMemberModel.aggregate<GhiMemberDoc>(pipeline),
  ]);
  const referenceDate = referenceDateOf(doc);
  return {
    items: docs.map((member) => toMember(member, referenceDate)),
    total,
    page: query.page,
    limit: query.limit,
  };
}

export async function censusSummary(id: string): Promise<GhiCensusSummary> {
  return loadSummary(await loadCase(id));
}

/**
 * The census checked as a whole against the Data Sheet as it is now: members that no longer fit
 * (after a change of family definition, sums insured or age limits) with their problems.
 */
export async function censusIssues(
  doc: GhiCaseDoc,
  session?: mongo.ClientSession,
): Promise<Array<{ member: GhiMember; issues: GhiCensusIssue[] }>> {
  if (doc.planAssignment) {
    // With a plan, the census is checked against the plan's slots (16.4).
    const checked = await ebCensusIssues(doc, session);
    return checked.items.map((item) => ({
      member: asGhiMember(item.member),
      issues: item.issues.map((issue) => ({
        field: ghiFieldOf(issue.field),
        message: issue.message,
        severity: issue.severity,
        fix: issue.fix,
        code: issue.code,
      })),
    }));
  }
  const members = await allMembers(doc._id, session);
  const candidates: Candidate[] = members.map((member) => ({
    key: member._id.toHexString(),
    label: `${member.employeeId} ${GHI_RELATIONSHIP_LABELS[member.relationship].toLowerCase()} ${member.name}`,
    member: toCensusMember(member),
    issues: [],
  }));
  const result = checkCensus(candidates, [], censusSettingsOf(doc));
  const referenceDate = referenceDateOf(doc);
  return members.flatMap((member) => {
    const issues = result.get(member._id.toHexString()) ?? [];
    return issues.length > 0 ? [{ member: toMember(member, referenceDate), issues }] : [];
  });
}

/** An EB member in the GMC member contract. */
function asGhiMember(member: EbMember): GhiMember {
  return {
    id: member.id,
    employeeId: member.employeeId,
    name: member.name,
    gender: member.gender,
    dateOfBirth: member.dateOfBirth,
    relationship: member.relationship,
    dateOfJoining: member.dateOfJoining,
    sumInsured: member.sumInsured,
    age: member.age,
    source: member.source,
    updatedAt: member.updatedAt,
  };
}

/**
 * The employee identity of a Self member being saved on a GMC case without a plan (design D7):
 * an unresolved key or details that differ from the company's record refuse the save; otherwise
 * the identity is created or reused in the same transaction.
 */
async function gmcIdentityOf(
  doc: GhiCaseDoc,
  member: CensusMember,
  actor: Actor,
  session: mongo.ClientSession,
  options: { existing: boolean },
): Promise<Types.ObjectId | null> {
  if (member.relationship !== 'SELF') return null;
  const context = await identityContext(doc.clientId, session);
  const identity = context.identities.get(member.employeeKey);
  if (identity) {
    const mismatches = identityMismatches(identity, member);
    if (mismatches.length > 0) {
      throw issuesToValidation(
        mismatches.map((mismatch) => ({
          field: mismatch.field,
          message: `The ${mismatch.field === 'dateOfBirth' ? 'date of birth' : mismatch.field} differs from the company’s record of employee ${member.employeeId}: "${mismatch.identityValue}" there, "${mismatch.rowValue}" here. Correct it, or update the employee on the company page.`,
        })),
      );
    }
  } else {
    const unresolved = context.unresolvedKeys.get(member.employeeKey);
    if (unresolved && !options.existing) throw unresolvedConflict(member.employeeId, unresolved);
    if (unresolved) return null;
  }
  const ensured = await ensureSelfIdentities(doc.clientId, [member], actor, session);
  return ensured.byKey.get(member.employeeKey) ?? null;
}

export async function addMember(
  id: string,
  input: GhiMemberInput,
  actor: Actor,
): Promise<GhiMember> {
  const doc = await loadCase(id);
  // With a plan, the family is checked against the plan's slots (Requirement 16.4).
  if (doc.planAssignment) {
    return asGhiMember(
      await addEbMember(
        GMC_SCOPE,
        id,
        { ...input, annualSalary: null, monthlySalary: null, nominee: null },
        actor,
      ),
    );
  }
  assertEditable(doc);
  const member = memberFromInput(input);
  const actorId = new Types.ObjectId(actor.id);
  const created = await withTransaction(async (session) => {
    const existing = await GhiMemberModel.find({ caseId: doc._id }).session(session).lean();
    const issues =
      checkCensus(
        [{ key: 'new', label: 'this member', member, issues: [] }],
        existing.map(toCensusMember),
        censusSettingsOf(doc),
      ).get('new') ?? [];
    if (issues.length > 0) throw issuesToValidation(issues);
    const identityId = await gmcIdentityOf(doc, member, actor, session, { existing: false });
    const [saved] = await GhiMemberModel.create(
      [
        {
          caseId: doc._id,
          ...member,
          sumInsured: member.sumInsured === null ? null : toDecimal128(member.sumInsured),
          ...(identityId ? { employeeIdentityId: identityId } : {}),
          source: 'MANUAL',
          importId: null,
          createdBy: actorId,
          updatedBy: actorId,
        },
      ],
      { session },
    );
    if (!saved) throw new Error('Member was not saved');
    await bumpCensus(
      doc,
      actorId,
      `Census: ${member.name} (${GHI_RELATIONSHIP_LABELS[member.relationship]}, ${member.employeeId}) added`,
      session,
    );
    await auditCase(
      actor,
      AUDIT_ACTIONS.GHI_MEMBER_CREATED,
      id,
      null,
      { memberId: saved._id.toHexString(), ...member },
      session,
    );
    return saved.toObject();
  });
  return toMember(created, referenceDateOf(doc));
}

async function loadMember(doc: GhiCaseDoc, memberId: string, session?: mongo.ClientSession) {
  const member = await GhiMemberModel.findOne({
    _id: new Types.ObjectId(memberId),
    caseId: doc._id,
  })
    .session(session ?? null)
    .lean();
  if (!member) throw notFound('Census member not found');
  return member;
}

/** Dependants left without their employee if this employee row changes or goes. */
async function dependantsOf(
  doc: GhiCaseDoc,
  member: GhiMemberDoc,
  session: mongo.ClientSession,
): Promise<number> {
  if (member.relationship !== 'SELF') return 0;
  return GhiMemberModel.countDocuments({
    caseId: doc._id,
    employeeKey: member.employeeKey,
    relationship: { $ne: 'SELF' },
  }).session(session);
}

export async function updateMember(
  id: string,
  memberId: string,
  input: GhiMemberInput,
  actor: Actor,
): Promise<GhiMember> {
  const doc = await loadCase(id);
  if (doc.planAssignment) {
    return asGhiMember(
      await updateEbMember(
        GMC_SCOPE,
        id,
        memberId,
        { ...input, annualSalary: null, monthlySalary: null, nominee: null },
        actor,
      ),
    );
  }
  assertEditable(doc);
  const next = memberFromInput(input);
  const actorId = new Types.ObjectId(actor.id);
  const saved = await withTransaction(async (session) => {
    const current = await loadMember(doc, memberId, session);
    const leavesFamily =
      current.relationship === 'SELF' &&
      (next.relationship !== 'SELF' || next.employeeKey !== current.employeeKey);
    const dependants = leavesFamily ? await dependantsOf(doc, current, session) : 0;
    if (dependants > 0) {
      throw conflict(
        ERROR_CODES.GHI_CENSUS_INVALID,
        `Employee ${current.employeeId} has ${dependants} dependant(s). Change or remove them before changing the employee’s ID or relationship.`,
      );
    }
    const others = await GhiMemberModel.find({ caseId: doc._id, _id: { $ne: current._id } })
      .session(session)
      .lean();
    const issues =
      checkCensus(
        [{ key: 'edit', label: 'this member', member: next, issues: [] }],
        others.map(toCensusMember),
        censusSettingsOf(doc),
      ).get('edit') ?? [];
    if (issues.length > 0) throw issuesToValidation(issues);
    // A floater employee's new sum insured must still suit dependants that typed one.
    if (current.relationship === 'SELF' && doc.requirements.coverageType === 'FLOATER') {
      const clash = others.find(
        (other) =>
          other.employeeKey === next.employeeKey &&
          other.relationship !== 'SELF' &&
          other.sumInsured !== null &&
          other.sumInsured.toString() !== next.sumInsured,
      );
      if (clash) {
        throw validationError([
          {
            location: 'body',
            path: 'sumInsured',
            message: `Family floater: ${clash.name} has ₹${clash.sumInsured?.toString()} entered. Clear the dependants’ sums insured or use the same amount.`,
          },
        ]);
      }
    }
    const identityId =
      next.relationship === 'SELF'
        ? ((await gmcIdentityOf(doc, next, actor, session, { existing: true })) ??
          (next.employeeKey === current.employeeKey ? (current.employeeIdentityId ?? null) : null))
        : null;
    const updated = await GhiMemberModel.findOneAndUpdate(
      { _id: current._id, caseId: doc._id },
      {
        $set: {
          ...next,
          sumInsured: next.sumInsured === null ? null : toDecimal128(next.sumInsured),
          ...(identityId || current.employeeIdentityId ? { employeeIdentityId: identityId } : {}),
          updatedBy: actorId,
        },
      },
      { returnDocument: 'after', session },
    ).lean();
    if (!updated) throw notFound('Census member not found');
    await bumpCensus(doc, actorId, `Census: ${next.name} (${next.employeeId}) edited`, session);
    await auditCase(
      actor,
      AUDIT_ACTIONS.GHI_MEMBER_UPDATED,
      id,
      { memberId, ...toCensusMember(current) },
      { memberId, ...next },
      session,
    );
    return updated;
  });
  return toMember(saved, referenceDateOf(doc));
}

export async function deleteMember(id: string, memberId: string, actor: Actor): Promise<void> {
  const doc = await loadCase(id);
  if (doc.planAssignment) return deleteEbMember(GMC_SCOPE, id, memberId, actor);
  assertEditable(doc);
  const actorId = new Types.ObjectId(actor.id);
  await withTransaction(async (session) => {
    const current = await loadMember(doc, memberId, session);
    const dependants = await dependantsOf(doc, current, session);
    if (dependants > 0) {
      throw conflict(
        ERROR_CODES.GHI_CENSUS_INVALID,
        `Employee ${current.employeeId} has ${dependants} dependant(s). Remove them first.`,
      );
    }
    await GhiMemberModel.deleteOne({ _id: current._id, caseId: doc._id }, { session });
    await bumpCensus(
      doc,
      actorId,
      `Census: ${current.name} (${current.employeeId}) removed`,
      session,
    );
    await auditCase(
      actor,
      AUDIT_ACTIONS.GHI_MEMBER_DELETED,
      id,
      { memberId, ...toCensusMember(current) },
      null,
      session,
    );
  });
}

const asLegacy = (view: Parameters<typeof toGhiImport>[0]) => toGhiImport(view, { legacy: true });

// Import: the generic Import_Service (eb-census-import.service.ts) with the GMC scope. Without a
// mode it checks rows exactly as GMC always has (design D8) and keeps the guard against
// importing the same rows twice (22.8); the employee identities of design D7 are added.

export async function uploadCensus(
  id: string,
  data: Buffer,
  fileName: string,
  actor: Actor,
): Promise<GhiCensusImport> {
  return toGhiImport(await uploadEbCensus(GMC_SCOPE, id, data, fileName, actor), {
    legacy: true,
  });
}

export async function getImport(
  id: string,
  importId: string,
  mode?: EbImportMode,
): Promise<GhiCensusImport> {
  return toGhiImport(await getEbImport(GMC_SCOPE, id, importId, mode), { legacy: !mode });
}

export async function listImports(id: string) {
  const doc = await loadCase(id);
  const imports = await GhiCensusImportModel.find({ caseId: doc._id }, { rows: 0 })
    .sort({ _id: -1 })
    .limit(50)
    .lean();
  const names = await userNames(imports.map((item) => item.uploadedBy));
  return {
    items: imports.map((item) => ({
      id: item._id.toHexString(),
      fileName: item.fileName,
      status: item.status,
      counts: { rows: 0, valid: 0, invalid: 0, imported: item.importedCount },
      policy: item.policy,
      uploadedAt: item.createdAt.toISOString(),
      uploadedBy: nameOf(names, item.uploadedBy),
      importedAt: item.importedAt?.toISOString() ?? null,
    })),
  };
}

/** Corrects one row of an unimported file on screen; the file is checked again. */
export async function correctImportRow(
  id: string,
  importId: string,
  rowNumber: number,
  values: GhiCensusRowValues,
  actor: Actor,
): Promise<GhiCensusImport> {
  return asLegacy(
    await correctEbImportRow(
      GMC_SCOPE,
      id,
      importId,
      rowNumber,
      rowValuesOf({ ...values, annualSalary: '' }),
      actor,
    ),
  );
}

export async function discardImport(
  id: string,
  importId: string,
  actor: Actor,
): Promise<GhiCensusImport> {
  return toGhiImport(await discardEbImport(GMC_SCOPE, id, importId, actor), { legacy: true });
}

/**
 * Imports a checked file by the policy chosen, in one transaction: the rows are checked again
 * against the census as it is at that moment, so two imports at once cannot break a family rule.
 */
export async function commitImport(
  id: string,
  importId: string,
  policy: GhiImportPolicy,
  actor: Actor,
  mode?: EbImportMode,
): Promise<GhiCommitResult> {
  const outcome = await commitEbImport(GMC_SCOPE, id, importId, { policy, mode }, actor);
  return {
    imported: outcome.result.added + outcome.result.updated,
    skipped: outcome.result.skipped,
    import: toGhiImport(outcome.import, { legacy: !mode }),
    summary: await loadSummary(await loadCase(id)),
  };
}

/** The error report of a GMC census file (Requirement 21.5). */
export async function importErrorReport(
  id: string,
  importId: string,
  actor: Actor,
  mode?: EbImportMode,
) {
  return ebErrorReport(GMC_SCOPE, id, importId, actor, mode);
}

/** Every member with the sum insured that covers them, for the RFQ and placement annexures. */
export async function membersForDocuments(
  doc: GhiCaseDoc,
): Promise<Array<GhiMember & { coveredBy: string | null }>> {
  const members = await allMembers(doc._id);
  const referenceDate = referenceDateOf(doc);
  const familySumInsured = new Map<string, string | null>();
  for (const member of members) {
    if (member.relationship === 'SELF') {
      familySumInsured.set(member.employeeKey, member.sumInsured?.toString() ?? null);
    }
  }
  return members.map((member) => ({
    ...toMember(member, referenceDate),
    coveredBy: effectiveSumInsured(
      {
        employeeKey: member.employeeKey,
        relationship: member.relationship,
        dateOfBirth: member.dateOfBirth,
        sumInsured: member.sumInsured?.toString() ?? null,
      },
      familySumInsured,
      doc.requirements.coverageType,
    ),
  }));
}
