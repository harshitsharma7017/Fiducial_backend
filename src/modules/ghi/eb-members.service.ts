import {
  AUDIT_ACTIONS,
  ERROR_CODES,
  GHI_RELATIONSHIPS,
  GHI_RELATIONSHIP_LABELS,
  candidateFromMember,
  checkEbCensus,
  ebMemberFromInput,
  familyShortfalls,
  freeCoverFlags,
  isError,
  memberCoverage,
  type EbCensusIssue,
  type EbCensusIssuesResponse,
  type EbCensusMember,
  type EbMember,
  type EbMemberInput,
  type EbMemberListResponse,
  type GhiCensusSummary,
  type GhiMemberListQuery,
  type MemberCoverage,
} from '../../shared/index.ts';
import { Types, type PipelineStage, type mongo } from 'mongoose';
import { withTransaction } from '../../lib/db.ts';
import { Decimal, toDecimal128 } from '../../lib/decimal.ts';
import { conflict, notFound, validationError } from '../../lib/errors.ts';
import { escapeRegExp } from '../../lib/text.ts';
import { ensureSelfIdentities, unresolvedConflict } from '../employees/employees.service.ts';
import { ageOn } from './census-rules.ts';
import { summarizeCensus } from './census-summary.ts';
import {
  buildCensusContext,
  gtliRequirementsOf,
  planRulesOf,
  storedExtras,
  toEbCensusMember,
} from './eb-census-context.ts';
import { GhiCaseModel, type GhiCaseDoc } from './ghi-case.model.ts';
import { GhiMemberModel, type GhiMemberDoc } from './ghi-census.model.ts';
import {
  assertEditable,
  assertWritable,
  auditCase,
  loadCase,
  referenceDateOf,
  summaryBandsOf,
  type Actor,
} from './ghi-common.ts';
import { productOf, type CaseScope } from './products/profile.ts';

// Manual census entry (N3, Requirement 23) for GPA and GTLI cases, and for GMC cases that have a
// plan: the same Census_Validator as the import, on the member and its whole family, against the
// census as stored at that moment. A Self member creates or reuses the employee identity in the
// same transaction (17.3, 17.4). GMC cases without a plan keep census.service.ts.

const RELATIONSHIP_RANK = {
  $indexOfArray: [GHI_RELATIONSHIPS as unknown as string[], '$relationship'],
};

const lockedMessage =
  'The RFQ has gone to an insurer, so the census can no longer change. Changes after this are endorsements, which are not handled in the app yet.';

function assertCensusWritable(doc: GhiCaseDoc): void {
  assertWritable(doc);
  try {
    assertEditable(doc);
  } catch {
    throw conflict(
      ERROR_CODES.GHI_LOCKED,
      doc.stage === 'CLOSED' ? 'This case is closed.' : lockedMessage,
    );
  }
}

/** Every member of a case, families together: employee first, then spouse, children, parents. */
async function allMembers(caseId: Types.ObjectId, session?: mongo.ClientSession) {
  return GhiMemberModel.aggregate<GhiMemberDoc>([
    { $match: { caseId } },
    { $addFields: { rank: RELATIONSHIP_RANK } },
    { $sort: { employeeKey: 1, rank: 1, dateOfBirth: 1, _id: 1 } },
    { $project: { rank: 0 } },
  ]).session(session ?? null);
}

function toEbMember(
  doc: GhiMemberDoc,
  referenceDate: string,
  coverage: MemberCoverage | null,
): EbMember {
  return {
    id: doc._id.toHexString(),
    employeeId: doc.employeeId,
    name: doc.name,
    gender: doc.gender,
    dateOfBirth: doc.dateOfBirth,
    relationship: doc.relationship,
    dateOfJoining: doc.dateOfJoining,
    sumInsured: doc.sumInsured?.toString() ?? null,
    annualSalary: doc.annualSalary?.toString() ?? null,
    monthlySalary: doc.monthlySalary?.toString() ?? null,
    nominee: toEbCensusMember(doc).nominee ?? null,
    coveredSumInsured: coverage?.amount ?? null,
    coverageBasis: coverage?.basis ?? null,
    age: ageOn(doc.dateOfBirth, referenceDate),
    source: doc.source,
    employeeIdentityId: doc.employeeIdentityId?.toHexString() ?? null,
    updatedAt: doc.updatedAt.toISOString(),
  };
}

/**
 * Each member's cover and how it is worked out (N5, N6), by member id. A dependant's employee
 * row is read from the census when it is not among the members given.
 */
export async function coverages(
  doc: GhiCaseDoc,
  members: readonly GhiMemberDoc[],
  session?: mongo.ClientSession,
): Promise<Map<string, MemberCoverage>> {
  const context = await buildCensusContext(doc, { identityChecks: false, session }).catch(
    () => null,
  );
  const selfByKey = new Map<string, EbCensusMember>();
  for (const member of members) {
    if (member.relationship === 'SELF') selfByKey.set(member.employeeKey, toEbCensusMember(member));
  }
  const missing = [
    ...new Set(
      members
        .filter((member) => member.relationship !== 'SELF' && !selfByKey.has(member.employeeKey))
        .map((member) => member.employeeKey),
    ),
  ];
  if (context && missing.length > 0) {
    const selves = await GhiMemberModel.find({
      caseId: doc._id,
      relationship: 'SELF',
      employeeKey: { $in: missing },
    })
      .session(session ?? null)
      .lean();
    for (const self of selves) selfByKey.set(self.employeeKey, toEbCensusMember(self));
  }
  return new Map(
    members.map((member) => [
      member._id.toHexString(),
      context
        ? memberCoverage(
            toEbCensusMember(member),
            selfByKey.get(member.employeeKey) ?? null,
            context,
          )
        : { amount: member.sumInsured?.toString() ?? null, basis: 'As entered' },
    ]),
  );
}

/** The sum insured that covers each member, by member id. */
async function coveredAmounts(
  doc: GhiCaseDoc,
  members: readonly GhiMemberDoc[],
  session?: mongo.ClientSession,
) {
  const all = await coverages(doc, members, session);
  return new Map([...all].map(([id, coverage]) => [id, coverage.amount]));
}

export async function listEbMembers(
  scope: CaseScope,
  id: string,
  query: GhiMemberListQuery,
): Promise<EbMemberListResponse> {
  const doc = await loadCase(id, undefined, scope);
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
  const keys = [...new Set(docs.map((member) => member.employeeKey))];
  const selves = await GhiMemberModel.find({
    caseId: doc._id,
    employeeKey: { $in: keys },
    relationship: 'SELF',
  }).lean();
  const covered = await coverages(doc, [...docs, ...selves]);
  const referenceDate = referenceDateOf(doc);
  return {
    items: docs.map((member) =>
      toEbMember(member, referenceDate, covered.get(member._id.toHexString()) ?? null),
    ),
    total,
    page: query.page,
    limit: query.limit,
  };
}

/** A 400 with each issue on its field (Requirement 23.6), values only of the member sent. */
function issuesError(issues: readonly EbCensusIssue[]) {
  const errors = issues.filter(isError);
  return validationError(
    errors.map((issue) => ({
      location: 'body' as const,
      path: issue.field ?? '',
      message: issue.message,
      fix: issue.fix,
      code: issue.code,
    })),
    errors[0]?.message ?? 'The member cannot be saved',
  );
}

async function bumpCensus(
  doc: GhiCaseDoc,
  actorId: Types.ObjectId,
  message: string,
  scope: CaseScope,
  session: mongo.ClientSession,
): Promise<void> {
  const result = await GhiCaseModel.updateOne(
    {
      _id: doc._id,
      stage: { $ne: 'CLOSED' },
      placement: { $in: [null] },
      insurers: { $not: { $elemMatch: { sentAt: { $ne: null } } } },
    },
    {
      $inc: { censusRevision: 1 },
      $set: { updatedBy: actorId },
      $push: { activity: { at: new Date(), actorId, message } },
    },
    { session },
  );
  if (result.modifiedCount === 0)
    assertCensusWritable(await loadCase(doc._id.toHexString(), session, scope));
}

/**
 * Checks a member with its whole family against the rest of the census (23.2): a dependant joins
 * the family already there; an employee goes first and its dependants are checked again after it
 * (their amounts follow the employee's).
 */
async function checkFamily(
  doc: GhiCaseDoc,
  member: EbCensusMember,
  others: readonly GhiMemberDoc[],
  session: mongo.ClientSession,
): Promise<EbCensusIssue[]> {
  const context = await buildCensusContext(doc, { session });
  if (member.relationship !== 'SELF') {
    const result = checkEbCensus(
      [candidateFromMember('member', member)],
      others.map(toEbCensusMember),
      context,
    );
    return result.get('member') ?? [];
  }
  const dependants = others.filter(
    (item) => item.employeeKey === member.employeeKey && item.relationship !== 'SELF',
  );
  const rest = others.filter((item) => !dependants.includes(item));
  const result = checkEbCensus(
    [
      candidateFromMember('member', member),
      ...dependants.map((item) =>
        candidateFromMember(
          item._id.toHexString(),
          toEbCensusMember(item),
          `${GHI_RELATIONSHIP_LABELS[item.relationship].toLowerCase()} ${item.name}`,
        ),
      ),
    ],
    rest.map(toEbCensusMember),
    context,
  );
  return [
    ...(result.get('member') ?? []),
    ...dependants.flatMap((item) => (result.get(item._id.toHexString()) ?? []).filter(isError)),
  ];
}

function failOn(
  issues: readonly EbCensusIssue[],
  employeeId: string,
  unresolved: readonly string[] | undefined,
) {
  if (!issues.some(isError)) return;
  if (issues.some((issue) => issue.code === 'EMPLOYEE_UNRESOLVED') && unresolved) {
    throw unresolvedConflict(employeeId, unresolved);
  }
  throw issuesError(issues);
}

const memberAudit = (member: EbCensusMember) => ({
  employeeId: member.employeeId,
  name: member.name,
  gender: member.gender,
  dateOfBirth: member.dateOfBirth,
  relationship: member.relationship,
  dateOfJoining: member.dateOfJoining,
  sumInsured: member.sumInsured,
  annualSalary: member.annualSalary,
  monthlySalary: member.monthlySalary ?? null,
  // The nominee's name and relationship only: their date of birth or age is not logged.
  nominee: member.nominee ? `${member.nominee.name} (${member.nominee.relationship})` : null,
});

export async function addEbMember(
  scope: CaseScope,
  id: string,
  input: EbMemberInput,
  actor: Actor,
): Promise<EbMember> {
  const doc = await loadCase(id, undefined, scope);
  assertCensusWritable(doc);
  const member = ebMemberFromInput(input);
  const actorId = new Types.ObjectId(actor.id);
  const created = await withTransaction(async (session) => {
    const existing = await GhiMemberModel.find({ caseId: doc._id }).session(session).lean();
    const issues = await checkFamily(doc, member, existing, session);
    const context = await buildCensusContext(doc, { session });
    failOn(issues, member.employeeId, context.unresolvedKeys.get(member.employeeKey));
    let identityId: Types.ObjectId | null = null;
    if (member.relationship === 'SELF') {
      const identities = await ensureSelfIdentities(doc.clientId, [member], actor, session);
      identityId = identities.byKey.get(member.employeeKey) ?? null;
    }
    const [saved] = await GhiMemberModel.create(
      [
        {
          caseId: doc._id,
          employeeId: member.employeeId,
          employeeKey: member.employeeKey,
          name: member.name,
          nameKey: member.nameKey,
          gender: member.gender,
          dateOfBirth: member.dateOfBirth,
          relationship: member.relationship,
          dateOfJoining: member.dateOfJoining,
          sumInsured: member.sumInsured === null ? null : toDecimal128(member.sumInsured),
          ...storedExtras(member),
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
      scope,
      session,
    );
    await auditCase(
      actor,
      AUDIT_ACTIONS.GHI_MEMBER_CREATED,
      id,
      null,
      { memberId: saved._id.toHexString(), ...memberAudit(member) },
      session,
      scope,
    );
    return saved.toObject();
  });
  const covered = await coverages(doc, [created]);
  return toEbMember(created, referenceDateOf(doc), covered.get(created._id.toHexString()) ?? null);
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

export async function updateEbMember(
  scope: CaseScope,
  id: string,
  memberId: string,
  input: EbMemberInput,
  actor: Actor,
): Promise<EbMember> {
  const doc = await loadCase(id, undefined, scope);
  assertCensusWritable(doc);
  const next = ebMemberFromInput(input);
  const actorId = new Types.ObjectId(actor.id);
  const saved = await withTransaction(async (session) => {
    const current = await loadMember(doc, memberId, session);
    const leavesFamily =
      current.relationship === 'SELF' &&
      (next.relationship !== 'SELF' || next.employeeKey !== current.employeeKey);
    if (leavesFamily) {
      const dependants = await GhiMemberModel.find({
        caseId: doc._id,
        employeeKey: current.employeeKey,
        relationship: { $ne: 'SELF' },
      })
        .session(session)
        .lean();
      if (dependants.length > 0) {
        throw conflict(
          ERROR_CODES.GHI_CENSUS_INVALID,
          `Employee ${current.employeeId} has dependants (${dependants.map((item) => `${item.name}, ${GHI_RELATIONSHIP_LABELS[item.relationship]}`).join('; ')}). Change or remove them before changing the employee’s ID or relationship.`,
        );
      }
    }
    const others = await GhiMemberModel.find({ caseId: doc._id, _id: { $ne: current._id } })
      .session(session)
      .lean();
    const issues = await checkFamily(doc, next, others, session);
    const context = await buildCensusContext(doc, { session });
    failOn(issues, next.employeeId, context.unresolvedKeys.get(next.employeeKey));
    let identityId = current.employeeIdentityId ?? null;
    if (next.relationship === 'SELF' && (!identityId || next.employeeKey !== current.employeeKey)) {
      const identities = await ensureSelfIdentities(doc.clientId, [next], actor, session);
      identityId = identities.byKey.get(next.employeeKey) ?? null;
    }
    if (next.relationship !== 'SELF') identityId = null;
    const updated = await GhiMemberModel.findOneAndUpdate(
      { _id: current._id, caseId: doc._id },
      {
        $set: {
          employeeId: next.employeeId,
          employeeKey: next.employeeKey,
          name: next.name,
          nameKey: next.nameKey,
          gender: next.gender,
          dateOfBirth: next.dateOfBirth,
          relationship: next.relationship,
          dateOfJoining: next.dateOfJoining,
          sumInsured: next.sumInsured === null ? null : toDecimal128(next.sumInsured),
          ...storedExtras(next),
          employeeIdentityId: identityId,
          updatedBy: actorId,
        },
      },
      { returnDocument: 'after', session },
    ).lean();
    if (!updated) throw notFound('Census member not found');
    await bumpCensus(
      doc,
      actorId,
      `Census: ${next.name} (${next.employeeId}) edited`,
      scope,
      session,
    );
    await auditCase(
      actor,
      AUDIT_ACTIONS.GHI_MEMBER_UPDATED,
      id,
      { memberId, ...memberAudit(toEbCensusMember(current)) },
      { memberId, ...memberAudit(next) },
      session,
      scope,
    );
    return updated;
  });
  const covered = await coverages(doc, [saved]);
  return toEbMember(saved, referenceDateOf(doc), covered.get(saved._id.toHexString()) ?? null);
}

/** Removes a member; an employee with dependants is refused, naming them (23.4). */
export async function deleteEbMember(
  scope: CaseScope,
  id: string,
  memberId: string,
  actor: Actor,
): Promise<void> {
  const doc = await loadCase(id, undefined, scope);
  assertCensusWritable(doc);
  const actorId = new Types.ObjectId(actor.id);
  await withTransaction(async (session) => {
    const current = await loadMember(doc, memberId, session);
    if (current.relationship === 'SELF') {
      const dependants = await GhiMemberModel.find({
        caseId: doc._id,
        employeeKey: current.employeeKey,
        relationship: { $ne: 'SELF' },
      })
        .session(session)
        .lean();
      if (dependants.length > 0) {
        throw conflict(
          ERROR_CODES.GHI_CENSUS_INVALID,
          `Employee ${current.employeeId} has dependants: ${dependants.map((item) => `${item.name} (${GHI_RELATIONSHIP_LABELS[item.relationship]})`).join(', ')}. Remove them first.`,
          {
            dependants: dependants.map((item) => ({
              name: item.name,
              relationship: item.relationship,
            })),
          },
        );
      }
    }
    await GhiMemberModel.deleteOne({ _id: current._id, caseId: doc._id }, { session });
    await bumpCensus(
      doc,
      actorId,
      `Census: ${current.name} (${current.employeeId}) removed`,
      scope,
      session,
    );
    await auditCase(
      actor,
      AUDIT_ACTIONS.GHI_MEMBER_DELETED,
      id,
      { memberId, ...memberAudit(toEbCensusMember(current)) },
      null,
      session,
      scope,
    );
  });
}

/** The census summary; for GTLI with the members above the free cover limit (5.3). */
export async function ebCensusSummary(scope: CaseScope, id: string): Promise<GhiCensusSummary> {
  const doc = await loadCase(id, undefined, scope);
  return summaryOf(doc);
}

export async function summaryOf(
  doc: GhiCaseDoc,
  session?: mongo.ClientSession,
): Promise<GhiCensusSummary> {
  const members = await allMembers(doc._id, session);
  const covered = await coveredAmounts(doc, members);
  const product = productOf(doc);
  // Every member at the sum insured that covers them; GPA/GTLI sums insured are individual.
  const summary = summarizeCensus(
    members.map((member) => ({
      employeeKey: member.employeeKey,
      relationship: member.relationship,
      dateOfBirth: member.dateOfBirth,
      sumInsured: covered.get(member._id.toHexString()) ?? null,
    })),
    {
      coverageType: 'INDIVIDUAL',
      referenceDate: referenceDateOf(doc),
      declaredEmployees: doc.requirements.employeeCount,
      revision: doc.censusRevision,
      ...summaryBandsOf(doc),
    },
  );
  if (product !== 'GTLI') return summary;
  const limit = gtliRequirementsOf(doc).freeCoverLimit;
  const flags = freeCoverFlags(
    members.map((member) => ({
      key: member._id.toHexString(),
      sumInsured: covered.get(member._id.toHexString()) ?? null,
    })),
    limit,
  );
  return { ...summary, freeCoverLimit: limit, aboveFreeCoverLimit: flags.count };
}

/** The whole census checked against the case as it is now, and the family shortfalls (18.9). */
export async function ebCensusIssues(
  doc: GhiCaseDoc,
  session?: mongo.ClientSession,
): Promise<EbCensusIssuesResponse> {
  const members = await allMembers(doc._id, session);
  const plan = planRulesOf(doc);
  const context = await buildCensusContext(doc, { session, identityChecks: false });
  const result = checkEbCensus(
    members.map((member) =>
      candidateFromMember(
        member._id.toHexString(),
        toEbCensusMember(member),
        `${member.employeeId} ${GHI_RELATIONSHIP_LABELS[member.relationship].toLowerCase()} ${member.name}`,
      ),
    ),
    [],
    context,
  );
  const covered = await coverages(doc, members);
  const referenceDate = referenceDateOf(doc);
  return {
    items: members.flatMap((member) => {
      const issues = (result.get(member._id.toHexString()) ?? []).filter(isError);
      return issues.length > 0
        ? [
            {
              member: toEbMember(
                member,
                referenceDate,
                covered.get(member._id.toHexString()) ?? null,
              ),
              issues,
            },
          ]
        : [];
    }),
    shortfalls: plan ? familyShortfalls(members.map(toEbCensusMember), plan) : [],
  };
}

/** Total sum insured across members, for documents. */
export function totalOf(amounts: readonly (string | null)[]): string {
  return amounts
    .reduce((total, amount) => (amount ? total.plus(amount) : total), new Decimal(0))
    .toFixed(0);
}

/** Every member with the sum insured that covers them, for the RFQ and placement annexures. */
export async function membersForEbDocuments(doc: GhiCaseDoc): Promise<EbMember[]> {
  const members = await allMembers(doc._id);
  const covered = await coverages(doc, members);
  const referenceDate = referenceDateOf(doc);
  return members.map((member) =>
    toEbMember(member, referenceDate, covered.get(member._id.toHexString()) ?? null),
  );
}
