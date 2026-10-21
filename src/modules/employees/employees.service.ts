import {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  EMPLOYEES_PAGE_SIZE,
  ERROR_CODES,
  GHI_RELATIONSHIP_LABELS,
  candidateFromMember,
  checkEbCensus,
  identityMismatches,
  isError,
  issueSentence,
  nameKeyOf,
  type EbEmployee,
  type EbEmployeeListQuery,
  type EbEmployeeListResponse,
  type GhiGender,
  type IdentityDetails,
  type ResolveEbEmployeeRequest,
  type UpdateEbEmployeeRequest,
} from '../../shared/index.ts';
import { Types, type mongo } from 'mongoose';
import { withTransaction } from '../../lib/db.ts';
import { conflict, notFound } from '../../lib/errors.ts';
import { writeAudit, writeAudits, type AuditEntry } from '../audit/audit.service.ts';
import { ClientModel } from '../clients/client.model.ts';
import { buildCensusContext, toEbCensusMember } from '../ghi/eb-census-context.ts';
import { GhiCaseModel, type GhiCaseDoc } from '../ghi/ghi-case.model.ts';
import { GhiMemberModel, type GhiMemberDoc } from '../ghi/ghi-census.model.ts';
import { isLocked, type Actor } from '../ghi/ghi-common.ts';
import { productOf, scopeOf, scopedAction } from '../ghi/products/profile.ts';
import { EmployeeIdentityModel, type EmployeeIdentityDoc } from './employee.model.ts';

// Employee identity (N1, Requirement 17): one record per company and employee key across GMC, GPA
// and GTLI. Members are created or linked at write; existing GHI members are linked at startup
// (employee-link.ts). A key whose Self members are not linked is "unresolved" (design D12): its
// members disagree, and a user resolves it by choosing the details.

const unlinked = { $in: [null] };

/** The company's case ids, with reference, product, stage and whether they can still change. */
async function companyCases(clientId: Types.ObjectId, session?: mongo.ClientSession) {
  return GhiCaseModel.find(
    { clientId },
    { reference: 1, product: 1, stage: 1, insurers: 1, policy: 1, placement: 1 },
  )
    .session(session ?? null)
    .lean<
      Array<
        Pick<
          GhiCaseDoc,
          '_id' | 'reference' | 'product' | 'stage' | 'insurers' | 'policy' | 'placement'
        >
      >
    >();
}

const writableCase = (
  item: Pick<GhiCaseDoc, 'stage' | 'insurers' | 'policy' | 'placement'>,
): boolean => item.stage !== 'CLOSED' && !isLocked(item) && item.policy === null && !item.placement;

export interface IdentityContext {
  identities: Map<string, IdentityDetails & { id: Types.ObjectId }>;
  unresolvedKeys: Map<string, string[]>;
}

/** The company's identities by employee key, and its unresolved keys with their case references. */
export async function identityContext(
  clientId: Types.ObjectId,
  session?: mongo.ClientSession,
): Promise<IdentityContext> {
  const [identities, cases] = await Promise.all([
    EmployeeIdentityModel.find({ clientId })
      .session(session ?? null)
      .lean<EmployeeIdentityDoc[]>(),
    companyCases(clientId, session),
  ]);
  const unlinkedSelf = await GhiMemberModel.find(
    {
      caseId: { $in: cases.map((item) => item._id) },
      relationship: 'SELF',
      employeeIdentityId: unlinked,
    },
    { employeeKey: 1, caseId: 1 },
  )
    .session(session ?? null)
    .lean();
  const reference = new Map(cases.map((item) => [item._id.toHexString(), item.reference]));
  const unresolvedKeys = new Map<string, string[]>();
  for (const member of unlinkedSelf) {
    const refs = unresolvedKeys.get(member.employeeKey) ?? [];
    const ref = reference.get(member.caseId.toHexString()) ?? '';
    if (!refs.includes(ref)) refs.push(ref);
    unresolvedKeys.set(member.employeeKey, refs);
  }
  return {
    identities: new Map(
      identities.map((identity) => [
        identity.employeeKey,
        {
          id: identity._id,
          employeeId: identity.employeeId,
          name: identity.name,
          nameKey: identity.nameKey,
          gender: identity.gender,
          dateOfBirth: identity.dateOfBirth,
        },
      ]),
    ),
    unresolvedKeys,
  };
}

export interface SelfRow {
  employeeKey: string;
  employeeId: string;
  name: string;
  gender: GhiGender;
  dateOfBirth: string;
  dateOfJoining: string | null;
}

/**
 * Creates or reuses the identity of each Self row of a company in the caller's transaction
 * (17.3, 17.4). An identity created meanwhile that disagrees with its row aborts the write: the
 * user reloads the preview, where the row now shows the difference (17.5).
 */
export async function ensureSelfIdentities(
  clientId: Types.ObjectId,
  rows: readonly SelfRow[],
  actor: Actor | null,
  session: mongo.ClientSession,
): Promise<{ byKey: Map<string, Types.ObjectId>; created: string[]; reused: string[] }> {
  const byKey = new Map<string, Types.ObjectId>();
  if (rows.length === 0) return { byKey, created: [], reused: [] };
  const unique = [...new Map(rows.map((row) => [row.employeeKey, row])).values()];
  const actorId = actor ? new Types.ObjectId(actor.id) : null;
  const now = new Date();
  const result = await EmployeeIdentityModel.bulkWrite(
    unique.map((row) => ({
      updateOne: {
        filter: { clientId, employeeKey: row.employeeKey },
        update: {
          $setOnInsert: {
            clientId,
            employeeKey: row.employeeKey,
            employeeId: row.employeeId,
            name: row.name,
            nameKey: nameKeyOf(row.name),
            gender: row.gender,
            dateOfBirth: row.dateOfBirth,
            dateOfJoining: row.dateOfJoining,
            source: 'CENSUS',
            createdBy: actorId,
            updatedBy: actorId,
            createdAt: now,
            updatedAt: now,
          },
        },
        upsert: true,
      },
    })),
    { session, ordered: true, timestamps: false },
  );
  const insertedIndexes = new Set(Object.keys(result.upsertedIds).map(Number));
  const created = unique
    .filter((_, index) => insertedIndexes.has(index))
    .map((row) => row.employeeKey);
  const createdSet = new Set(created);
  const identities = await EmployeeIdentityModel.find({
    clientId,
    employeeKey: { $in: unique.map((row) => row.employeeKey) },
  })
    .session(session)
    .lean<EmployeeIdentityDoc[]>();
  for (const row of unique) {
    const identity = identities.find((item) => item.employeeKey === row.employeeKey);
    if (!identity) throw new Error('Employee identity was not saved');
    if (identityMismatches(identity, row).length > 0) {
      throw conflict(
        ERROR_CODES.EB_IDENTITY_CONFLICT,
        `Employee ${row.employeeId} was saved meanwhile with other details. Reload and check the rows again.`,
      );
    }
    byKey.set(row.employeeKey, identity._id);
  }
  if (created.length > 0) {
    await writeAudits(
      identities
        .filter((identity) => createdSet.has(identity.employeeKey))
        .map((identity): AuditEntry => ({
          userId: actor?.id ?? null,
          action: AUDIT_ACTIONS.EB_EMPLOYEE_CREATED,
          entity: AUDIT_ENTITIES.EB_EMPLOYEE,
          entityId: identity._id.toHexString(),
          before: null,
          after: identityAudit(identity),
          requestId: actor?.requestId ?? null,
        })),
      session,
    );
  }
  return {
    byKey,
    created,
    reused: unique.map((row) => row.employeeKey).filter((key) => !createdSet.has(key)),
  };
}

function identityAudit(
  identity: Pick<
    EmployeeIdentityDoc,
    'employeeId' | 'name' | 'gender' | 'dateOfBirth' | 'dateOfJoining'
  >,
) {
  return {
    employeeId: identity.employeeId,
    name: identity.name,
    gender: identity.gender,
    dateOfBirth: identity.dateOfBirth,
    dateOfJoining: identity.dateOfJoining,
  };
}

async function assertClient(clientId: string): Promise<Types.ObjectId> {
  const client = await ClientModel.exists({ _id: new Types.ObjectId(clientId) });
  if (!client) throw notFound('Company not found');
  return new Types.ObjectId(clientId);
}

/** The company's employees, unresolved first, searchable, 50 per page (17.13). */
export async function listEmployees(
  clientIdText: string,
  query: EbEmployeeListQuery,
): Promise<EbEmployeeListResponse> {
  const clientId = await assertClient(clientIdText);
  const [identities, cases] = await Promise.all([
    EmployeeIdentityModel.find({ clientId }).lean<EmployeeIdentityDoc[]>(),
    companyCases(clientId),
  ]);
  const caseById = new Map(cases.map((item) => [item._id.toHexString(), item]));
  const selfMembers = await GhiMemberModel.find(
    { caseId: { $in: cases.map((item) => item._id) }, relationship: 'SELF' },
    {
      caseId: 1,
      employeeKey: 1,
      employeeId: 1,
      name: 1,
      gender: 1,
      dateOfBirth: 1,
      dateOfJoining: 1,
      employeeIdentityId: 1,
    },
  ).lean<GhiMemberDoc[]>();
  const enrollmentOf = (member: GhiMemberDoc) => {
    const item = caseById.get(member.caseId.toHexString());
    return {
      caseId: member.caseId.toHexString(),
      product: item?.product ?? 'GMC',
      reference: item?.reference ?? '',
      stage: item?.stage ?? 'CREATED',
    };
  };
  const rows: EbEmployee[] = identities.map((identity) => ({
    id: identity._id.toHexString(),
    employeeKey: identity.employeeKey,
    employeeId: identity.employeeId,
    name: identity.name,
    gender: identity.gender,
    dateOfBirth: identity.dateOfBirth,
    dateOfJoining: identity.dateOfJoining,
    unresolved: false,
    enrollments: selfMembers
      .filter((member) => member.employeeIdentityId?.equals(identity._id))
      .map(enrollmentOf),
    variants: [],
    updatedAt: identity.updatedAt.toISOString(),
  }));
  const unresolved = new Map<string, GhiMemberDoc[]>();
  for (const member of selfMembers) {
    if (member.employeeIdentityId) continue;
    unresolved.set(member.employeeKey, [...(unresolved.get(member.employeeKey) ?? []), member]);
  }
  const unresolvedRows: EbEmployee[] = [...unresolved.entries()].map(([key, members]) => {
    const first = members[0]!;
    return {
      id: null,
      employeeKey: key,
      employeeId: first.employeeId,
      name: first.name,
      gender: first.gender,
      dateOfBirth: first.dateOfBirth,
      dateOfJoining: first.dateOfJoining,
      unresolved: true,
      enrollments: members.map(enrollmentOf),
      variants: members.map((member) => ({
        caseId: member.caseId.toHexString(),
        reference: caseById.get(member.caseId.toHexString())?.reference ?? '',
        product: caseById.get(member.caseId.toHexString())?.product ?? 'GMC',
        name: member.name,
        gender: member.gender,
        dateOfBirth: member.dateOfBirth,
      })),
      updatedAt: null,
    };
  });
  const text = query.q?.toLowerCase();
  const matches = (row: EbEmployee) =>
    !text ||
    row.employeeId.toLowerCase().includes(text) ||
    row.name.toLowerCase().includes(text) ||
    row.variants.some((variant) => variant.name.toLowerCase().includes(text));
  const byId = (a: EbEmployee, b: EbEmployee) => a.employeeKey.localeCompare(b.employeeKey);
  const all = [...unresolvedRows.filter(matches).sort(byId), ...rows.filter(matches).sort(byId)];
  const start = (query.page - 1) * EMPLOYEES_PAGE_SIZE;
  return {
    items: all.slice(start, start + EMPLOYEES_PAGE_SIZE),
    total: all.length,
    unresolved: unresolvedRows.length,
    page: query.page,
    limit: EMPLOYEES_PAGE_SIZE,
  };
}

interface Values {
  name: string;
  gender: GhiGender;
  dateOfBirth: string;
}

/**
 * Checks each writable case of the company that holds the employee with the new details (17.7):
 * any issue refuses the whole change, listing the case and its issues.
 */
async function recheckCases(
  members: readonly GhiMemberDoc[],
  values: Values,
  writableCaseIds: ReadonlySet<string>,
): Promise<void> {
  const problems: Array<{ reference: string; issues: string[] }> = [];
  for (const member of members) {
    const caseId = member.caseId.toHexString();
    if (!writableCaseIds.has(caseId)) continue;
    const doc = await GhiCaseModel.findById(member.caseId).lean<GhiCaseDoc>();
    if (!doc || (doc.product && doc.product !== 'GMC' && !doc.planAssignment)) continue;
    const census = await GhiMemberModel.find({ caseId: member.caseId }).lean<GhiMemberDoc[]>();
    const family = census.filter((item) => item.employeeKey === member.employeeKey);
    const others = census.filter((item) => item.employeeKey !== member.employeeKey);
    const context = await buildCensusContext(doc, { identityChecks: false });
    const candidates = [...family]
      .sort((a, b) => (a.relationship === 'SELF' ? -1 : b.relationship === 'SELF' ? 1 : 0))
      .map((item) => {
        const base = toEbCensusMember(item);
        const next = item._id.equals(member._id)
          ? {
              ...base,
              name: values.name.trim().replace(/\s+/g, ' '),
              nameKey: nameKeyOf(values.name),
              gender: values.gender,
              dateOfBirth: values.dateOfBirth,
            }
          : base;
        return candidateFromMember(
          item._id.toHexString(),
          next,
          `${item.employeeId} ${GHI_RELATIONSHIP_LABELS[item.relationship].toLowerCase()}`,
        );
      });
    const result = checkEbCensus(candidates, others.map(toEbCensusMember), context);
    const issues = [...result.values()].flat().filter(isError).map(issueSentence);
    if (issues.length > 0) problems.push({ reference: doc.reference, issues });
  }
  if (problems.length > 0) {
    throw conflict(
      ERROR_CODES.EB_IDENTITY_CONFLICT,
      `The change would break the census of ${problems.map((item) => item.reference).join(', ')}. Correct those cases first.`,
      { cases: problems },
    );
  }
}

/** Applies the details to members of writable cases, links the rest, bumps those censuses. */
async function applyToMembers(
  members: readonly GhiMemberDoc[],
  identityId: Types.ObjectId,
  values: Values,
  writable: ReadonlyMap<string, Pick<GhiCaseDoc, '_id' | 'reference' | 'product'>>,
  actor: Actor,
  session: mongo.ClientSession,
): Promise<Array<{ caseId: string; reference: string }>> {
  const actorId = new Types.ObjectId(actor.id);
  const changed: Array<{ caseId: string; reference: string }> = [];
  const entries: AuditEntry[] = [];
  for (const member of members) {
    const item = writable.get(member.caseId.toHexString());
    if (item) {
      const next = {
        name: values.name.trim().replace(/\s+/g, ' '),
        nameKey: nameKeyOf(values.name),
        gender: values.gender,
        dateOfBirth: values.dateOfBirth,
      };
      await GhiMemberModel.updateOne(
        { _id: member._id },
        { $set: { ...next, employeeIdentityId: identityId, updatedBy: actorId } },
        { session },
      );
      await GhiCaseModel.updateOne(
        { _id: member.caseId },
        {
          $inc: { censusRevision: 1 },
          $set: { updatedBy: actorId },
          $push: {
            activity: {
              at: new Date(),
              actorId,
              message: `Employee ${member.employeeId}: details updated from the company record`,
            },
          },
        },
        { session },
      );
      const scope = scopeOf(productOf(item));
      entries.push({
        userId: actor.id,
        action: scopedAction(scope, AUDIT_ACTIONS.GHI_MEMBER_UPDATED),
        entity: scope.auditEntity,
        entityId: member.caseId.toHexString(),
        before: {
          memberId: member._id.toHexString(),
          name: member.name,
          gender: member.gender,
          dateOfBirth: member.dateOfBirth,
        },
        after: { memberId: member._id.toHexString(), ...next },
        requestId: actor.requestId,
      });
      if (!changed.some((entry) => entry.caseId === member.caseId.toHexString())) {
        changed.push({ caseId: member.caseId.toHexString(), reference: item.reference });
      }
    } else if (!member.employeeIdentityId) {
      // Locked, placed or closed: frozen; only the reference is added (17.6, 25.6).
      await GhiMemberModel.updateOne(
        { _id: member._id, employeeIdentityId: unlinked },
        { $set: { employeeIdentityId: identityId } },
        { session, timestamps: false },
      );
    }
  }
  if (entries.length > 0) await writeAudits(entries, session);
  return changed;
}

async function employeeView(clientId: string, identityId: Types.ObjectId): Promise<EbEmployee> {
  const page = await listEmployees(clientId, { page: 1, q: undefined });
  const found = page.items.find((item) => item.id === identityId.toHexString());
  if (found) return found;
  const identity = await EmployeeIdentityModel.findById(identityId).lean<EmployeeIdentityDoc>();
  if (!identity) throw notFound('Employee not found');
  return {
    id: identity._id.toHexString(),
    employeeKey: identity.employeeKey,
    employeeId: identity.employeeId,
    name: identity.name,
    gender: identity.gender,
    dateOfBirth: identity.dateOfBirth,
    dateOfJoining: identity.dateOfJoining,
    unresolved: false,
    enrollments: [],
    variants: [],
    updatedAt: identity.updatedAt.toISOString(),
  };
}

/** Updates an identity's name, gender or date of birth with a reason (17.6, 17.7). */
export async function updateEmployee(
  clientIdText: string,
  employeeId: string,
  input: UpdateEbEmployeeRequest,
  actor: Actor,
) {
  const clientId = await assertClient(clientIdText);
  const identity = await EmployeeIdentityModel.findOne({
    _id: new Types.ObjectId(employeeId),
    clientId,
  }).lean<EmployeeIdentityDoc>();
  if (!identity) throw notFound('Employee not found');
  const cases = await companyCases(clientId);
  const writable = new Map(
    cases.filter(writableCase).map((item) => [item._id.toHexString(), item]),
  );
  const members = await GhiMemberModel.find({
    caseId: { $in: cases.map((item) => item._id) },
    relationship: 'SELF',
    employeeIdentityId: identity._id,
  }).lean<GhiMemberDoc[]>();
  await recheckCases(members, input, new Set(writable.keys()));
  const casesChanged = await withTransaction(async (session) => {
    const result = await EmployeeIdentityModel.updateOne(
      { _id: identity._id, clientId, updatedAt: identity.updatedAt },
      {
        $set: {
          name: input.name.trim().replace(/\s+/g, ' '),
          nameKey: nameKeyOf(input.name),
          gender: input.gender,
          dateOfBirth: input.dateOfBirth,
          updatedBy: new Types.ObjectId(actor.id),
        },
      },
      { session },
    );
    if (result.modifiedCount === 0 && result.matchedCount === 0) {
      throw conflict(ERROR_CODES.CONFLICT, 'The employee changed meanwhile. Reload and try again.');
    }
    const changed = await applyToMembers(members, identity._id, input, writable, actor, session);
    await writeAudit(
      {
        userId: actor.id,
        action: AUDIT_ACTIONS.EB_EMPLOYEE_UPDATED,
        entity: AUDIT_ENTITIES.EB_EMPLOYEE,
        entityId: identity._id.toHexString(),
        before: identityAudit(identity),
        after: {
          ...identityAudit({ ...identity, ...input }),
          reason: input.reason,
          cases: changed.map((item) => item.reference),
        },
        requestId: actor.requestId,
      },
      session,
    );
    return changed;
  });
  return { employee: await employeeView(clientIdText, identity._id), casesChanged };
}

/** Resolves an unresolved employee: creates the identity with the chosen details (17.6, 17.11). */
export async function resolveEmployee(
  clientIdText: string,
  input: ResolveEbEmployeeRequest,
  actor: Actor,
) {
  const clientId = await assertClient(clientIdText);
  const key = input.employeeKey.replace(/\s+/g, '').toUpperCase();
  if (await EmployeeIdentityModel.exists({ clientId, employeeKey: key })) {
    throw conflict(
      ERROR_CODES.CONFLICT,
      `Employee ${input.employeeKey} already has a company record: update it instead.`,
    );
  }
  const cases = await companyCases(clientId);
  const members = await GhiMemberModel.find({
    caseId: { $in: cases.map((item) => item._id) },
    relationship: 'SELF',
    employeeKey: key,
    employeeIdentityId: unlinked,
  }).lean<GhiMemberDoc[]>();
  if (members.length === 0) throw notFound('Unresolved employee not found');
  const writable = new Map(
    cases.filter(writableCase).map((item) => [item._id.toHexString(), item]),
  );
  await recheckCases(members, input, new Set(writable.keys()));
  const latest = [...members].sort((a, b) =>
    b.caseId.toHexString() > a.caseId.toHexString() ? 1 : -1,
  )[0]!;
  const result = await withTransaction(async (session) => {
    const actorId = new Types.ObjectId(actor.id);
    const [identity] = await EmployeeIdentityModel.create(
      [
        {
          clientId,
          employeeKey: key,
          employeeId: latest.employeeId,
          name: input.name.trim().replace(/\s+/g, ' '),
          nameKey: nameKeyOf(input.name),
          gender: input.gender,
          dateOfBirth: input.dateOfBirth,
          dateOfJoining: latest.dateOfJoining,
          source: 'RESOLUTION',
          createdBy: actorId,
          updatedBy: actorId,
        },
      ],
      { session },
    );
    if (!identity) throw new Error('Employee was not saved');
    const changed = await applyToMembers(members, identity._id, input, writable, actor, session);
    await writeAudit(
      {
        userId: actor.id,
        action: AUDIT_ACTIONS.EB_EMPLOYEE_RESOLVED,
        entity: AUDIT_ENTITIES.EB_EMPLOYEE,
        entityId: identity._id.toHexString(),
        before: {
          employeeId: latest.employeeId,
          variants: members.map((member) => ({
            name: member.name,
            gender: member.gender,
            dateOfBirth: member.dateOfBirth,
          })),
        },
        after: {
          ...identityAudit(identity.toObject()),
          reason: input.reason,
          cases: changed.map((item) => item.reference),
        },
        requestId: actor.requestId,
      },
      session,
    );
    return { id: identity._id, changed };
  });
  return { employee: await employeeView(clientIdText, result.id), casesChanged: result.changed };
}

/** Whether a Self row of this key may be added: refused while the employee is unresolved (17.12). */
export function unresolvedConflict(employeeId: string, references: readonly string[]) {
  return conflict(
    ERROR_CODES.EB_EMPLOYEE_UNRESOLVED,
    `Employee ${employeeId} is unresolved: the members on ${references.join(', ')} disagree on the name, gender or date of birth. Resolve the employee on the company page first.`,
    { cases: references },
  );
}
