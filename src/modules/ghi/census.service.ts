import {
  AUDIT_ACTIONS,
  ERROR_CODES,
  GHI_RELATIONSHIPS,
  GHI_RELATIONSHIP_LABELS,
  formatDate,
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
import { createHash } from 'node:crypto';
import { Types, type PipelineStage, type mongo } from 'mongoose';
import { withTransaction } from '../../lib/db.ts';
import { toDecimal128 } from '../../lib/decimal.ts';
import { conflict, notFound, unprocessable, validationError } from '../../lib/errors.ts';
import { escapeRegExp } from '../../lib/text.ts';
import {
  ageOn,
  checkCensus,
  memberFromInput,
  readCensusRow,
  type Candidate,
  type CensusMember,
} from './census-rules.ts';
import { effectiveSumInsured } from './census-summary.ts';
import { parseCensusWorkbook } from './census-workbook.ts';
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
import {
  GhiCensusImportModel,
  GhiMemberModel,
  type GhiCensusImportDoc,
  type GhiMemberDoc,
} from './ghi-census.model.ts';

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

export async function addMember(
  id: string,
  input: GhiMemberInput,
  actor: Actor,
): Promise<GhiMember> {
  const doc = await loadCase(id);
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
    const [saved] = await GhiMemberModel.create(
      [
        {
          caseId: doc._id,
          ...member,
          sumInsured: member.sumInsured === null ? null : toDecimal128(member.sumInsured),
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
    const updated = await GhiMemberModel.findOneAndUpdate(
      { _id: current._id, caseId: doc._id },
      {
        $set: {
          ...next,
          sumInsured: next.sumInsured === null ? null : toDecimal128(next.sumInsured),
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

// Import

function candidatesOf(importDoc: GhiCensusImportDoc, onlyPending = true): Candidate[] {
  return importDoc.rows
    .filter((row) => !onlyPending || !row.imported)
    .map((row) => {
      const read = readCensusRow(row.values);
      return {
        key: String(row.row),
        label: `row ${row.row}`,
        member: read.member,
        issues: read.issues,
      };
    });
}

async function importView(
  doc: GhiCaseDoc,
  importDoc: GhiCensusImportDoc,
  session?: mongo.ClientSession,
): Promise<GhiCensusImport> {
  let issuesByRow = new Map<string, GhiCensusIssue[]>();
  if (importDoc.status === 'PREVIEW') {
    const existing = await GhiMemberModel.find({ caseId: doc._id })
      .session(session ?? null)
      .lean();
    issuesByRow = checkCensus(
      candidatesOf(importDoc),
      existing.map(toCensusMember),
      censusSettingsOf(doc),
    );
  }
  const names = await userNames([importDoc.uploadedBy]);
  const rows = importDoc.rows.map((row) => {
    const issues =
      importDoc.status === 'PREVIEW' ? (issuesByRow.get(String(row.row)) ?? []) : row.issues;
    return {
      row: row.row,
      values: row.values,
      issues,
      valid: row.imported || issues.length === 0,
      corrected: row.corrected,
      imported: row.imported,
    };
  });
  const valid = rows.filter((row) => row.valid).length;
  return {
    id: importDoc._id.toHexString(),
    fileName: importDoc.fileName,
    status: importDoc.status,
    fileIssues: importDoc.fileIssues,
    rows,
    counts: {
      rows: rows.length,
      valid,
      invalid: rows.length - valid,
      imported: importDoc.importedCount,
    },
    policy: importDoc.policy,
    uploadedAt: importDoc.createdAt.toISOString(),
    uploadedBy: nameOf(names, importDoc.uploadedBy),
    importedAt: importDoc.importedAt?.toISOString() ?? null,
  };
}

async function loadImport(doc: GhiCaseDoc, importId: string, session?: mongo.ClientSession) {
  const importDoc = await GhiCensusImportModel.findOne({
    _id: new Types.ObjectId(importId),
    caseId: doc._id,
  })
    .session(session ?? null)
    .lean();
  if (!importDoc) throw notFound('Census file not found');
  return importDoc;
}

/**
 * Reads and checks an uploaded census file; nothing joins the census until it is imported. The
 * same file cannot be imported twice into a case; an earlier unfinished upload is set aside.
 */
export async function uploadCensus(
  id: string,
  data: Buffer,
  fileName: string,
  actor: Actor,
): Promise<GhiCensusImport> {
  const doc = await loadCase(id);
  assertEditable(doc);
  const parsed = await parseCensusWorkbook(data);
  if (!parsed.ok) {
    throw unprocessable(
      ERROR_CODES.IMPORT_FILE_INVALID,
      parsed.issues[0] ?? 'The file cannot be read',
      {
        issues: parsed.issues,
      },
    );
  }
  // The fingerprint is of the rows, not the file's bytes: the same census saved again in Excel
  // (which changes the bytes) is still recognised.
  const sha256 = createHash('sha256').update(JSON.stringify(parsed.rows)).digest('hex');
  const earlier = await GhiCensusImportModel.findOne(
    { caseId: doc._id, sha256, status: 'IMPORTED' },
    { importedAt: 1, importedCount: 1, fileName: 1 },
  ).lean();
  if (earlier) {
    throw conflict(
      ERROR_CODES.GHI_DUPLICATE_IMPORT,
      `This census was already imported (${earlier.fileName}, ${earlier.importedCount} members${earlier.importedAt ? ` on ${formatDate(earlier.importedAt.toISOString().slice(0, 10))}` : ''}). To add members, upload a file with only the new rows.`,
    );
  }
  const actorId = new Types.ObjectId(actor.id);
  const created = await withTransaction(async (session) => {
    await GhiCensusImportModel.updateMany(
      { caseId: doc._id, status: 'PREVIEW' },
      { $set: { status: 'DISCARDED' } },
      { session },
    );
    const [saved] = await GhiCensusImportModel.create(
      [
        {
          caseId: doc._id,
          fileName,
          sha256,
          status: 'PREVIEW',
          fileIssues: [],
          rows: parsed.rows.map((row) => ({
            ...row,
            corrected: false,
            imported: false,
            issues: [],
          })),
          policy: null,
          importedCount: 0,
          uploadedBy: actorId,
          importedAt: null,
          importedBy: null,
        },
      ],
      { session },
    );
    if (!saved) throw new Error('Census file was not saved');
    await auditCase(
      actor,
      AUDIT_ACTIONS.GHI_CENSUS_UPLOADED,
      id,
      null,
      { fileName, rows: parsed.rows.length, sha256 },
      session,
    );
    return saved.toObject();
  });
  return importView(doc, created);
}

export async function getImport(id: string, importId: string): Promise<GhiCensusImport> {
  const doc = await loadCase(id);
  return importView(doc, await loadImport(doc, importId));
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
  const doc = await loadCase(id);
  assertEditable(doc);
  const importDoc = await loadImport(doc, importId);
  if (importDoc.status !== 'PREVIEW') {
    throw conflict(
      ERROR_CODES.CONFLICT,
      'This file has been imported or set aside; upload it again to change it.',
    );
  }
  const row = importDoc.rows.find((item) => item.row === rowNumber);
  if (!row) throw notFound(`Row ${rowNumber} is not in this file`);
  const updated = await withTransaction(async (session) => {
    const saved = await GhiCensusImportModel.findOneAndUpdate(
      { _id: importDoc._id, caseId: doc._id, status: 'PREVIEW' },
      { $set: { 'rows.$[target].values': values, 'rows.$[target].corrected': true } },
      { returnDocument: 'after', session, arrayFilters: [{ 'target.row': rowNumber }] },
    ).lean();
    if (!saved) throw conflict(ERROR_CODES.CONFLICT, 'This file has been imported or set aside.');
    await auditCase(
      actor,
      AUDIT_ACTIONS.GHI_CENSUS_ROW_CORRECTED,
      id,
      { file: importDoc.fileName, row: rowNumber, ...row.values },
      { file: importDoc.fileName, row: rowNumber, ...values },
      session,
    );
    return saved;
  });
  return importView(doc, updated);
}

export async function discardImport(
  id: string,
  importId: string,
  actor: Actor,
): Promise<GhiCensusImport> {
  const doc = await loadCase(id);
  const importDoc = await loadImport(doc, importId);
  if (importDoc.status !== 'PREVIEW')
    throw conflict(ERROR_CODES.CONFLICT, 'Only a file not yet imported can be set aside.');
  const updated = await withTransaction(async (session) => {
    const saved = await GhiCensusImportModel.findOneAndUpdate(
      { _id: importDoc._id, status: 'PREVIEW' },
      { $set: { status: 'DISCARDED' } },
      { returnDocument: 'after', session },
    ).lean();
    if (!saved) throw conflict(ERROR_CODES.CONFLICT, 'This file has been imported or set aside.');
    await auditCase(
      actor,
      AUDIT_ACTIONS.GHI_CENSUS_IMPORT_DISCARDED,
      id,
      null,
      { file: importDoc.fileName },
      session,
    );
    return saved;
  });
  return importView(doc, updated);
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
): Promise<GhiCommitResult> {
  const actorId = new Types.ObjectId(actor.id);
  const outcome = await withTransaction(async (session) => {
    const doc = await loadCase(id, session);
    assertEditable(doc);
    const importDoc = await loadImport(doc, importId, session);
    if (importDoc.status !== 'PREVIEW') {
      throw conflict(ERROR_CODES.CONFLICT, 'This file has already been imported or set aside.');
    }
    const duplicate = await GhiCensusImportModel.exists({
      caseId: doc._id,
      sha256: importDoc.sha256,
      status: 'IMPORTED',
    }).session(session);
    if (duplicate)
      throw conflict(ERROR_CODES.GHI_DUPLICATE_IMPORT, 'This file was already imported.');
    const existing = await GhiMemberModel.find({ caseId: doc._id }).session(session).lean();
    const candidates = candidatesOf(importDoc);
    const issues = checkCensus(candidates, existing.map(toCensusMember), censusSettingsOf(doc));
    const valid = candidates.filter((candidate) => (issues.get(candidate.key) ?? []).length === 0);
    const invalid = candidates.length - valid.length;
    if (policy === 'ALL_VALID' && invalid > 0) {
      throw conflict(
        ERROR_CODES.GHI_CENSUS_INVALID,
        `${invalid} row(s) have problems. Correct them, or import the valid rows only.`,
        { invalid },
      );
    }
    if (valid.length === 0) {
      throw conflict(ERROR_CODES.GHI_CENSUS_INVALID, 'No row is valid: nothing to import.', {
        invalid,
      });
    }
    await GhiMemberModel.insertMany(
      valid.map((candidate) => {
        const member = candidate.member!;
        return {
          caseId: doc._id,
          ...member,
          sumInsured: member.sumInsured === null ? null : toDecimal128(member.sumInsured),
          source: 'IMPORT',
          importId: importDoc._id,
          createdBy: actorId,
          updatedBy: actorId,
        };
      }),
      { session },
    );
    const importedRows = new Set(valid.map((candidate) => candidate.key));
    const saved = await GhiCensusImportModel.findOneAndUpdate(
      { _id: importDoc._id, status: 'PREVIEW' },
      {
        $set: {
          status: 'IMPORTED',
          policy,
          importedCount: valid.length,
          importedAt: new Date(),
          importedBy: actorId,
          rows: importDoc.rows.map((row) => ({
            ...row,
            imported: importedRows.has(String(row.row)),
            issues: issues.get(String(row.row)) ?? [],
          })),
        },
      },
      { returnDocument: 'after', session },
    ).lean();
    if (!saved) throw conflict(ERROR_CODES.CONFLICT, 'This file has already been imported.');
    await bumpCensus(
      doc,
      actorId,
      `Census imported from ${importDoc.fileName}: ${valid.length} member(s)${invalid > 0 ? `, ${invalid} row(s) left out` : ''}`,
      session,
    );
    await auditCase(
      actor,
      AUDIT_ACTIONS.GHI_CENSUS_IMPORTED,
      id,
      null,
      { file: importDoc.fileName, policy, imported: valid.length, skipped: invalid },
      session,
    );
    return { imported: valid.length, skipped: invalid, saved };
  });
  const doc = await loadCase(id);
  return {
    imported: outcome.imported,
    skipped: outcome.skipped,
    import: await importView(doc, outcome.saved),
    summary: await loadSummary(doc),
  };
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
