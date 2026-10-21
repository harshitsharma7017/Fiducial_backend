import {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  ERROR_CODES,
  TPA_CLAIM_FIELDS,
  TPA_FIELD_INFO,
  TPA_BANK_FIELDS,
  TPA_PRIVATE_FIELDS,
  TPA_SENSITIVE_FIELDS,
  XLSX_CONTENT_TYPE,
  changedTpaFields,
  claimKeyOf,
  employeeKeyOf,
  headerKey,
  maskAccount,
  nameKeyOf,
  parseTpaRow,
  type TpaCell,
  type TpaClaimField,
  type TpaImport,
  type TpaImportPolicy,
  type TpaImportRow,
  type TpaInspectResponse,
  type TpaMemberMatch,
  type TpaNormalisedRow,
  type TpaRowAction,
  type TpaRowIssue,
} from '../../shared/index.ts';
import ExcelJS from 'exceljs';
import { createHash, randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { withTransaction } from '../../lib/db.ts';
import { Decimal, toDecimal128 } from '../../lib/decimal.ts';
import { AppError, conflict, notFound } from '../../lib/errors.ts';
import { saveWorkbook } from '../documents/excel-template.ts';
import { writeAudit } from '../audit/audit.service.ts';
import { ClaimModel } from '../claims/claim.model.ts';
import { GhiMemberModel } from '../ghi/ghi-census.model.ts';
import { nameOf, userNames, type Actor } from '../ghi/ghi-common.ts';
import { loadInsuredPolicy } from '../insured-policies/insured-policies.service.ts';
import type { ClaimAccess } from './tpa-claims.service.ts';
import type { MailTransport } from '../mail/transport.ts';
import { syncBoard } from './tpa-board.service.ts';
import { loadFormat } from './tpa-formats.service.ts';
import {
  TpaClaimEventModel,
  TpaClaimModel,
  TpaImportModel,
  TpaImportRowModel,
  type TpaClaimDoc,
  type TpaFormatDoc,
  type TpaImportDoc,
} from './tpa.model.ts';
import { planColumns, streamTpaSheet, tpaCell } from './tpa-workbook.ts';

// The TPA claims import (N9): upload → check every row against the chosen format → preview with
// row errors → commit by an explicit policy. A file is read row by row and its rows are stored in
// batches; a commit takes a lock per policy and TPA, writes in batches (each batch in one
// transaction), creates or updates by the stable key (policy, TPA, claim ID), keeps every change
// in the claim's history, and never touches a board claim or sends a notification.

const BATCH = 500;

function invalidFile(issues: string[]): AppError {
  return new AppError(
    422,
    ERROR_CODES.IMPORT_FILE_INVALID,
    issues[0] ?? 'The file cannot be imported',
    { issues },
  );
}

// The census, to match rows to members by employee ID and relationship (never by name alone)

interface CensusMember {
  id: Types.ObjectId;
  relationship: string;
  dateOfBirth: string;
  nameKey: string;
}

async function censusIndex(caseId: Types.ObjectId): Promise<Map<string, CensusMember[]>> {
  const members = await GhiMemberModel.find(
    { caseId },
    { employeeKey: 1, relationship: 1, dateOfBirth: 1, nameKey: 1 },
  ).lean();
  const index = new Map<string, CensusMember[]>();
  for (const member of members) {
    const list = index.get(member.employeeKey) ?? [];
    list.push({
      id: member._id,
      relationship: member.relationship,
      dateOfBirth: member.dateOfBirth,
      nameKey: member.nameKey,
    });
    index.set(member.employeeKey, list);
  }
  return index;
}

/**
 * The census member a row is about: the employee's family by employee ID, narrowed by the
 * relationship, then the date of birth, then the name within that family. Not exactly one: no match.
 */
export function matchMember(
  row: Pick<TpaNormalisedRow, 'employeeId' | 'relationship' | 'dateOfBirth' | 'memberName'>,
  index: ReadonlyMap<string, readonly CensusMember[]>,
): { match: TpaMemberMatch; memberId: Types.ObjectId | null } {
  if (!row.employeeId) return { match: 'NO_EMPLOYEE_ID', memberId: null };
  let candidates = [...(index.get(employeeKeyOf(row.employeeId)) ?? [])];
  if (candidates.length === 0) return { match: 'NOT_FOUND', memberId: null };
  if (row.relationship)
    candidates = candidates.filter((member) => member.relationship === row.relationship);
  if (candidates.length > 1 && row.dateOfBirth) {
    const born = candidates.filter((member) => member.dateOfBirth === row.dateOfBirth);
    if (born.length > 0) candidates = born;
  }
  if (candidates.length > 1 && row.memberName) {
    const named = candidates.filter((member) => member.nameKey === nameKeyOf(row.memberName!));
    if (named.length > 0) candidates = named;
  }
  if (candidates.length === 1) return { match: 'MATCHED', memberId: candidates[0]!.id };
  return { match: candidates.length === 0 ? 'NOT_FOUND' : 'AMBIGUOUS', memberId: null };
}

const MEMBER_MESSAGES: Record<Exclude<TpaMemberMatch, 'MATCHED'>, string> = {
  NO_EMPLOYEE_ID: 'No employee ID: the claim cannot be linked to the census',
  NOT_FOUND: 'The employee (or this relationship) is not in the policy’s census',
  AMBIGUOUS:
    'Several census members fit this row (same employee and relationship): it is not linked, for manual review',
};

// Comparing a stored record with a row

const amount = (value: Types.Decimal128 | null) =>
  value === null ? null : new Decimal(value.toString()).toFixed(2);

function comparable(doc: TpaClaimDoc) {
  return {
    ...doc,
    claimedAmount: amount(doc.claimedAmount),
    sanctionedAmount: amount(doc.sanctionedAmount),
    settledAmount: amount(doc.settledAmount),
    disallowedAmount: amount(doc.disallowedAmount),
  };
}

const sameExtra = (a: Record<string, string>, b: Record<string, string>) =>
  JSON.stringify(a) === JSON.stringify(b);

function actionOf(
  existing: TpaClaimDoc | undefined,
  row: TpaNormalisedRow,
  member: { match: TpaMemberMatch; memberId: Types.ObjectId | null },
  extra: Record<string, string>,
): TpaRowAction {
  if (!existing) return 'CREATE';
  const changed = changedTpaFields(comparable(existing), row);
  const memberChanged =
    existing.member.match !== member.match ||
    String(existing.member.memberId) !== String(member.memberId);
  return changed.length > 0 || memberChanged || !sameExtra(existing.extra, extra)
    ? 'UPDATE'
    : 'UNCHANGED';
}

// Views

function importView(
  doc: TpaImportDoc,
  names: ReadonlyMap<string, string>,
  caseReference: string,
): TpaImport {
  return {
    id: doc._id.toHexString(),
    caseId: doc.caseId.toHexString(),
    caseReference,
    formatId: doc.formatId.toHexString(),
    formatName: doc.format.name,
    formatRevision: doc.format.revision,
    tpaCode: doc.tpaCode,
    fileName: doc.fileName,
    status: doc.status,
    fileIssues: doc.fileIssues,
    counts: doc.counts,
    result: doc.result,
    policy: doc.policy,
    uploadedAt: doc.createdAt.toISOString(),
    uploadedBy: nameOf(names, doc.uploadedBy),
    importedAt: doc.importedAt?.toISOString() ?? null,
    importedBy: doc.importedBy ? nameOf(names, doc.importedBy) : null,
  };
}

async function viewOf(doc: TpaImportDoc): Promise<TpaImport> {
  const [names, policy] = await Promise.all([
    userNames([doc.uploadedBy, doc.importedBy]),
    loadInsuredPolicy(doc.caseId.toHexString()).catch(() => null),
  ]);
  return importView(doc, names, policy?.policy.reference ?? '');
}

/** Text of a stored scalar (strings, numbers, booleans; anything else as JSON). */
const scalarText = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : JSON.stringify(value);

/** A row's values for the screen; diagnosis details only for users who process claims. */
function displayValues(
  values: Record<string, unknown> | null,
  access: ClaimAccess,
): Record<string, string | null> {
  if (!values) return {};
  const out: Record<string, string | null> = {};
  for (const field of TPA_CLAIM_FIELDS) {
    if (!access.diagnosis && TPA_SENSITIVE_FIELDS.includes(field)) continue;
    const value = values[field];
    out[field] = value === null || value === undefined ? null : scalarText(value);
    if (TPA_BANK_FIELDS.includes(field) && !access.bank) out[field] = maskAccount(out[field]);
  }
  out.memberMatch = typeof values.memberMatch === 'string' ? values.memberMatch : null;
  return out;
}

const hideIssue = (issue: TpaRowIssue, access: ClaimAccess): TpaRowIssue =>
  issue.field &&
  TPA_PRIVATE_FIELDS.includes(issue.field) &&
  !(access.diagnosis && TPA_SENSITIVE_FIELDS.includes(issue.field))
    ? { ...issue, value: null }
    : issue;

// Inspect (mapping preview)

const SUGGEST: Partial<Record<TpaClaimField, string[]>> = {
  tpaClaimId: ['claimno', 'claimnumber', 'claimid', 'ccn', 'claimrefno'],
  parentClaimId: ['mainclaimno', 'parentclaim', 'linkedclaim', 'preauthno'],
  requestType: ['requesttype', 'claimcategory', 'requestcategory'],
  employeeId: ['employeeid', 'empid', 'employeecode', 'empcode', 'empno'],
  memberName: ['patientname', 'membername', 'claimantname', 'insuredname'],
  tpaMemberId: ['memberid', 'uhid', 'tpaid', 'cardno'],
  relationship: ['relationship', 'relation'],
  gender: ['gender', 'sex'],
  dateOfBirth: ['dob', 'dateofbirth'],
  age: ['age', 'patientage'],
  admissionDate: ['doa', 'dateofadmission', 'admissiondate'],
  dischargeDate: ['dod', 'dateofdischarge', 'dischargedate'],
  diagnosis: ['diagnosis', 'ailment', 'disease'],
  icdCode: ['icd', 'icdcode', 'icd10'],
  claimType: ['claimtype', 'cashlessreimbursement', 'typeofclaim'],
  hospital: ['hospital', 'hospitalname'],
  hospitalCity: ['hospitalcity', 'city'],
  claimedAmount: ['claimedamount', 'claimamount', 'amountclaimed'],
  sanctionedAmount: ['sanctionedamount', 'approvedamount', 'sanctionamount'],
  settledAmount: ['settledamount', 'paidamount', 'settlementamount'],
  disallowedAmount: ['disallowedamount', 'deductedamount', 'disallowance'],
  status: ['claimstatus', 'status'],
  rejectionReason: ['rejectionreason', 'repudiationreason', 'denialreason'],
  settlementDate: ['settlementdate', 'paymentdate', 'dateofsettlement'],
};

/** Reads a file's headers and first rows against a format (or none), for the mapping screen. */
export async function inspectTpaFile(
  data: Buffer,
  query: { formatId?: string; sheetName?: string; headerRow?: number },
  access: ClaimAccess,
): Promise<TpaInspectResponse> {
  const format = query.formatId ? await loadFormat(query.formatId) : null;
  const sheetName = query.sheetName ?? format?.sheetName ?? null;
  const headerRow = query.headerRow ?? format?.headerRow ?? 1;
  let plan: ReturnType<typeof planColumns> | null = null;
  const sample: TpaInspectResponse['sample'] = [];
  // The status values in the file, to map each one (statuses are not sensitive).
  const statuses = new Map<string, number>();
  let statusColumn: number | null = null;
  const read = await streamTpaSheet(data, {
    sheetName,
    headerRow,
    onHeaders: (headers) => {
      plan = planColumns(headers, format?.mappings ?? [], format?.keepColumns ?? []);
      const mapped = plan.fields.get('status');
      const guessed = headers.findIndex((item) => SUGGEST.status!.includes(headerKey(item)));
      statusColumn = mapped ?? (guessed >= 0 ? guessed + 1 : null);
    },
    onRow: (row, values) => {
      if (statusColumn !== null) {
        const cell = tpaCell(values[statusColumn] ?? null);
        const text = typeof cell === 'string' ? cell.trim() : '';
        if (text && (statuses.has(text) || statuses.size < 100))
          statuses.set(text, (statuses.get(text) ?? 0) + 1);
      }
      if (!format || !plan || sample.length >= 10) return;
      const cells = cellsOf(plan, values);
      const parsed = parseTpaRow(cells, format);
      sample.push({
        row,
        values: displayValues(parsed.row as unknown as Record<string, unknown> | null, access),
        issues: parsed.issues.map((issue) => hideIssue(issue, access)),
      });
    },
  });
  if (!read.ok) throw invalidFile(read.issues);
  const used = new Set((format?.mappings ?? []).map((mapping) => mapping.field));
  const finalPlan = plan as ReturnType<typeof planColumns> | null;
  return {
    sheets: read.sheets,
    sheet: read.sheet,
    headers: read.headers,
    found: (format?.mappings ?? []).map((mapping) => ({
      field: mapping.field,
      header: mapping.header,
      column: finalPlan?.fields.get(mapping.field) ?? null,
    })),
    suggestions: TPA_CLAIM_FIELDS.filter((field) => !used.has(field)).flatMap((field) => {
      const wanted = SUGGEST[field] ?? [];
      const header = read.headers.find((item) => wanted.includes(headerKey(item)));
      return header ? [{ field, header }] : [];
    }),
    sample,
    statusValues: [...statuses].map(([value, rows]) => ({ value, rows })),
  };
}

function cellsOf(
  plan: ReturnType<typeof planColumns>,
  values: ExcelJS.CellValue[],
): Partial<Record<TpaClaimField, TpaCell>> {
  const cells: Partial<Record<TpaClaimField, TpaCell>> = {};
  for (const [field, column] of plan.fields) cells[field] = tpaCell(values[column] ?? null);
  return cells;
}

function extraOf(
  plan: ReturnType<typeof planColumns>,
  values: ExcelJS.CellValue[],
): Record<string, string> {
  const extra: Record<string, string> = {};
  for (const [header, column] of plan.extra) {
    const cell = tpaCell(values[column] ?? null);
    const text = typeof cell === 'string' ? cell.trim() : cell.date;
    if (text) extra[header] = text.slice(0, 300);
  }
  return extra;
}

// Upload

const formatCopy = (format: TpaFormatDoc): TpaImportDoc['format'] => ({
  name: format.name,
  tpaCode: format.tpaCode,
  description: format.description,
  sheetName: format.sheetName,
  headerRow: format.headerRow,
  mappings: format.mappings,
  statusMap: format.statusMap,
  requestTypeMap: format.requestTypeMap,
  claimTypeMap: format.claimTypeMap,
  relationshipMap: format.relationshipMap,
  keepColumns: format.keepColumns,
  requireMemberMatch: format.requireMemberMatch,
  // N11: what the import does to the claims board, as configured when the file was checked.
  boardStatusMap: format.boardStatusMap ?? [],
  boardStatusOverrides: format.boardStatusOverrides ?? [],
  boardUpdate: format.boardUpdate ?? 'FORWARD_ONLY',
  createBoardClaims: format.createBoardClaims ?? true,
  active: format.active,
  revision: format.revision,
});

/** Checks every row of an uploaded export against the format; nothing is imported yet. */
export async function uploadTpaImport(
  input: { caseId: string; formatId: string; fileName: string; data: Buffer },
  actor: Actor,
): Promise<TpaImport> {
  const { doc } = await loadInsuredPolicy(input.caseId);
  const format = await loadFormat(input.formatId);
  if (!format.active)
    throw conflict(ERROR_CODES.CONFLICT, 'This TPA format is inactive: choose an active one.');
  const census = await censusIndex(doc._id);
  const importId = new Types.ObjectId();
  const notes: string[] = [];
  const counts = { rows: 0, valid: 0, invalid: 0, warnings: 0, create: 0, update: 0, unchanged: 0 };
  const firstRowOf = new Map<string, number>();
  let plan: ReturnType<typeof planColumns> | null = null;
  let pending: Array<{
    row: number;
    parsed: ReturnType<typeof parseTpaRow>;
    extra: Record<string, string>;
    /** The claim ID as written, to find a row that could not be read in the TPA's file. */
    rawClaimId: string | null;
  }> = [];

  const flush = async () => {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    const keys = batch.flatMap((item) => (item.parsed.row ? [item.parsed.row.claimKey] : []));
    const existing = new Map(
      (
        await TpaClaimModel.find({
          caseId: doc._id,
          tpaCode: format.tpaCode,
          claimKey: { $in: keys },
        }).lean<TpaClaimDoc[]>()
      ).map((item) => [item.claimKey, item]),
    );
    await TpaImportRowModel.insertMany(
      batch.map(({ row, parsed, extra, rawClaimId }) => {
        const issues = [...parsed.issues];
        let values: Record<string, unknown> | null = null;
        let action: TpaRowAction = 'INVALID';
        if (parsed.row) {
          const member = matchMember(parsed.row, census);
          if (member.match !== 'MATCHED') {
            issues.push({
              field: member.match === 'NO_EMPLOYEE_ID' ? 'employeeId' : 'employeeId',
              value: parsed.row.employeeId,
              message: MEMBER_MESSAGES[member.match],
              severity: format.requireMemberMatch ? 'ERROR' : 'WARNING',
              code: `MEMBER_${member.match}`,
            });
          }
          if (!issues.some((item) => item.severity === 'ERROR')) {
            action = actionOf(existing.get(parsed.row.claimKey), parsed.row, member, extra);
            values = { ...parsed.row, memberMatch: member.match, memberId: member.memberId };
          }
        }
        counts.rows += 1;
        if (action === 'INVALID') counts.invalid += 1;
        else {
          counts.valid += 1;
          counts[action === 'CREATE' ? 'create' : action === 'UPDATE' ? 'update' : 'unchanged'] +=
            1;
        }
        if (issues.some((item) => item.severity === 'WARNING')) counts.warnings += 1;
        return {
          importId,
          row,
          claimKey: parsed.row?.claimKey ?? null,
          tpaClaimId: parsed.row?.tpaClaimId ?? rawClaimId,
          action,
          issues,
          values,
          extra,
        };
      }),
      { ordered: true },
    );
  };

  let read: Awaited<ReturnType<typeof streamTpaSheet>>;
  try {
    read = await streamTpaSheet(input.data, {
      sheetName: format.sheetName,
      headerRow: format.headerRow,
      onHeaders: (headers) => {
        plan = planColumns(headers, format.mappings, format.keepColumns);
        const required = plan.missing.filter((item) => item.required);
        for (const item of plan.missing.filter((entry) => !entry.required)) {
          notes.push(
            `Optional column "${item.header}" (${TPA_FIELD_INFO[item.field].label}) is not in the file: left blank.`,
          );
        }
        return required.map(
          (item) =>
            `Required column "${item.header}" (${TPA_FIELD_INFO[item.field].label}) is not in row ${format.headerRow} of the sheet.`,
        );
      },
      onRow: async (row, values) => {
        const columns = plan!;
        const cells = cellsOf(columns, values);
        const parsed = parseTpaRow(cells, format);
        const written = typeof cells.tpaClaimId === 'string' ? cells.tpaClaimId.trim() : '';
        if (parsed.row) {
          const first = firstRowOf.get(parsed.row.claimKey);
          if (first !== undefined) {
            parsed.issues.push({
              field: 'tpaClaimId',
              value: parsed.row.tpaClaimId,
              message: `Claim ID ${parsed.row.tpaClaimId} is also on row ${first}: only the first is imported`,
              severity: 'ERROR',
              code: 'DUPLICATE_IN_FILE',
            });
            parsed.row = null;
          } else firstRowOf.set(parsed.row.claimKey, row);
        }
        pending.push({
          row,
          parsed,
          extra: extraOf(columns, values),
          rawClaimId: written ? written.slice(0, 100) : null,
        });
        if (pending.length >= BATCH) await flush();
      },
    });
    if (read.ok) await flush();
  } catch (error) {
    await TpaImportRowModel.deleteMany({ importId });
    throw error;
  }
  if (!read.ok || counts.rows === 0) {
    await TpaImportRowModel.deleteMany({ importId });
    throw invalidFile(
      read.ok ? ['The sheet has no claim rows below the header row.'] : read.issues,
    );
  }
  const actorId = new Types.ObjectId(actor.id);
  const [created] = await TpaImportModel.create([
    {
      _id: importId,
      caseId: doc._id,
      clientId: doc.clientId,
      formatId: format._id,
      format: formatCopy(format),
      tpaCode: format.tpaCode,
      fileName: input.fileName,
      sha256: createHash('sha256').update(input.data).digest('hex'),
      size: input.data.length,
      status: 'VALIDATED',
      fileIssues: notes,
      counts,
      policy: null,
      result: null,
      committing: null,
      uploadedBy: actorId,
    },
  ]);
  await writeAudit({
    userId: actor.id,
    action: AUDIT_ACTIONS.TPA_IMPORT_UPLOADED,
    entity: AUDIT_ENTITIES.INSURED_POLICY,
    entityId: doc._id.toHexString(),
    before: null,
    after: {
      importId: importId.toHexString(),
      fileName: input.fileName,
      format: format.name,
      tpaCode: format.tpaCode,
      counts,
    },
    requestId: actor.requestId,
  });
  return viewOf(created!.toObject());
}

// Reading imports

async function loadImport(id: string): Promise<TpaImportDoc> {
  const doc = Types.ObjectId.isValid(id)
    ? await TpaImportModel.findById(id).lean<TpaImportDoc>()
    : null;
  if (!doc) throw notFound('TPA import not found');
  return doc;
}

export async function getTpaImport(id: string): Promise<TpaImport> {
  return viewOf(await loadImport(id));
}

export async function listTpaImports(caseId: string): Promise<{ items: TpaImport[] }> {
  const { doc } = await loadInsuredPolicy(caseId);
  const imports = await TpaImportModel.find({ caseId: doc._id })
    .sort({ _id: -1 })
    .limit(100)
    .lean<TpaImportDoc[]>();
  const names = await userNames(imports.flatMap((item) => [item.uploadedBy, item.importedBy]));
  return { items: imports.map((item) => importView(item, names, doc.reference)) };
}

export async function tpaImportRows(
  id: string,
  query: { page: number; limit: number; only: 'ALL' | 'ERRORS' | 'WARNINGS' },
  access: ClaimAccess,
): Promise<{ items: TpaImportRow[]; total: number; page: number; limit: number }> {
  const doc = await loadImport(id);
  const filter: Record<string, unknown> = { importId: doc._id };
  if (query.only === 'ERRORS') filter.action = 'INVALID';
  if (query.only === 'WARNINGS') filter['issues.severity'] = 'WARNING';
  const [total, rows] = await Promise.all([
    TpaImportRowModel.countDocuments(filter),
    TpaImportRowModel.find(filter)
      .sort({ row: 1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean(),
  ]);
  return {
    items: rows.map((row) => ({
      row: row.row,
      tpaClaimId: row.tpaClaimId,
      action: row.action,
      issues: row.issues.map((issue) => hideIssue(issue, access)),
      values: displayValues(row.values, access),
    })),
    total,
    page: query.page,
    limit: query.limit,
  };
}

/** The rows with problems as an Excel file (values only for fields that are not sensitive). */
export async function tpaErrorReport(
  id: string,
): Promise<{ fileName: string; contentType: string; data: Buffer }> {
  const doc = await loadImport(id);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Problems');
  sheet.columns = [
    { header: 'Excel row', width: 10 },
    { header: 'TPA claim ID', width: 18 },
    { header: 'Field', width: 26 },
    { header: 'Value as read', width: 24 },
    { header: 'Severity', width: 10 },
    { header: 'Problem', width: 80 },
  ];
  sheet.getRow(1).font = { bold: true };
  const cursor = TpaImportRowModel.find({ importId: doc._id, 'issues.0': { $exists: true } })
    .sort({ row: 1 })
    .lean()
    .cursor();
  for await (const row of cursor) {
    for (const issue of row.issues) {
      sheet.addRow([
        row.row,
        row.tpaClaimId ?? '',
        issue.field ? TPA_FIELD_INFO[issue.field].label : '',
        issue.field && TPA_PRIVATE_FIELDS.includes(issue.field) ? '' : (issue.value ?? ''),
        issue.severity === 'ERROR' ? 'Error' : 'Warning',
        issue.message,
      ]);
    }
  }
  return {
    fileName: `TPA-import-problems-${doc.fileName.replace(/\.xlsx$/i, '')}.xlsx`.replace(
      /[^A-Za-z0-9._ -]/g,
      '_',
    ),
    contentType: XLSX_CONTENT_TYPE,
    data: await saveWorkbook(workbook),
  };
}

export async function discardTpaImport(id: string, actor: Actor): Promise<TpaImport> {
  const doc = await loadImport(id);
  const result = await TpaImportModel.updateOne(
    { _id: doc._id, status: 'VALIDATED' },
    { $set: { status: 'DISCARDED' } },
  );
  if (result.modifiedCount === 0)
    throw conflict(
      ERROR_CODES.CONFLICT,
      `This import is ${doc.status.toLowerCase()}: it cannot be discarded.`,
    );
  await TpaImportRowModel.deleteMany({ importId: doc._id });
  await writeAudit({
    userId: actor.id,
    action: AUDIT_ACTIONS.TPA_IMPORT_DISCARDED,
    entity: AUDIT_ENTITIES.INSURED_POLICY,
    entityId: doc.caseId.toHexString(),
    before: { importId: id, status: doc.status },
    after: { importId: id, status: 'DISCARDED' },
    requestId: actor.requestId,
  });
  return getTpaImport(id);
}

// Commit

const CLAIM_FIELDS_FROM_ROW = [
  'tpaClaimId',
  'requestType',
  'sourceRequestType',
  'parentClaimId',
  'employeeId',
  'memberName',
  'tpaMemberId',
  'relationship',
  'sourceRelationship',
  'gender',
  'dateOfBirth',
  'age',
  'admissionDate',
  'dischargeDate',
  'diagnosis',
  'icdCode',
  'claimType',
  'sourceClaimType',
  'hospital',
  'hospitalCity',
  'status',
  'sourceStatus',
  'rejectionReason',
  'settlementDate',
  'bankAccount',
] as const;
const AMOUNT_FIELDS = [
  'claimedAmount',
  'sanctionedAmount',
  'settledAmount',
  'disallowedAmount',
] as const;

function claimFields(row: TpaNormalisedRow) {
  const fields: Record<string, unknown> = {};
  for (const field of CLAIM_FIELDS_FROM_ROW) fields[field] = row[field];
  for (const field of AMOUNT_FIELDS)
    fields[field] = row[field] === null ? null : toDecimal128(row[field]);
  return fields;
}

/** A change for the history; diagnosis details are recorded as changed, never their text. */
function changeOf(field: string, before: unknown, after: unknown) {
  const hidden = (TPA_PRIVATE_FIELDS as readonly string[]).includes(field);
  const text = (value: unknown) =>
    value === null || value === undefined ? null : hidden ? '(changed)' : scalarText(value);
  return {
    field,
    before: hidden && before !== null && before !== undefined ? '(previous)' : text(before),
    after: text(after),
  };
}

export async function commitTpaImport(
  id: string,
  policy: TpaImportPolicy,
  actor: Actor,
  transport: MailTransport | null = null,
): Promise<TpaImport> {
  const doc = await loadImport(id);
  if (doc.status !== 'VALIDATED') {
    throw conflict(
      ERROR_CODES.CONFLICT,
      `This import is ${doc.status.toLowerCase()}: upload the file again to import it.`,
    );
  }
  if (policy === 'ALL_VALID' && doc.counts.invalid > 0) {
    throw conflict(
      ERROR_CODES.GHI_CENSUS_INVALID,
      `${doc.counts.invalid} row(s) have errors. Correct the file, or import the valid rows only.`,
      { invalid: doc.counts.invalid },
    );
  }
  if (doc.counts.valid === 0)
    throw conflict(ERROR_CODES.GHI_CENSUS_INVALID, 'No row can be imported.');
  const lock = randomUUID();
  try {
    const locked = await TpaImportModel.updateOne(
      { _id: doc._id, status: 'VALIDATED' },
      { $set: { status: 'IMPORTING', committing: lock, policy } },
    );
    if (locked.modifiedCount === 0)
      throw conflict(ERROR_CODES.CONFLICT, 'This import is already being imported.');
  } catch (error) {
    if ((error as { code?: number } | null)?.code === 11000) {
      throw conflict(
        ERROR_CODES.CONFLICT,
        'Another import for this policy and TPA is running. Try again when it has finished.',
      );
    }
    throw error;
  }
  const actorId = new Types.ObjectId(actor.id);
  const result = {
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: doc.counts.invalid,
    failed: 0,
    failures: [] as Array<{ row: number; message: string }>,
  };
  const touched: Types.ObjectId[] = [];
  let product = 'GMC';
  try {
    const { policy: insured } = await loadInsuredPolicy(doc.caseId.toHexString());
    product = insured.product;
    const cursor = TpaImportRowModel.find({ importId: doc._id, action: { $ne: 'INVALID' } })
      .sort({ row: 1 })
      .lean()
      .cursor({ batchSize: BATCH });
    let batch: Array<{
      row: number;
      values: TpaNormalisedRow & { memberMatch: TpaMemberMatch; memberId: Types.ObjectId | null };
      extra: Record<string, string>;
    }> = [];
    const run = async () => {
      if (batch.length === 0) return;
      const items = batch;
      batch = [];
      try {
        const counts = await withTransaction(async (session) => {
          const existing = new Map(
            (
              await TpaClaimModel.find({
                caseId: doc.caseId,
                tpaCode: doc.tpaCode,
                claimKey: { $in: items.map((item) => item.values.claimKey) },
              })
                .session(session)
                .lean<TpaClaimDoc[]>()
            ).map((item) => [item.claimKey, item]),
          );
          const now = new Date();
          const operations: Parameters<typeof TpaClaimModel.bulkWrite>[0] = [];
          const events: Array<Record<string, unknown>> = [];
          const tally = { created: 0, updated: 0, unchanged: 0, ids: [] as Types.ObjectId[] };
          for (const item of items) {
            const row = item.values;
            const member = {
              match: row.memberMatch,
              memberId: row.memberId ? new Types.ObjectId(String(row.memberId)) : null,
            };
            const current = existing.get(row.claimKey);
            const action = actionOf(current, row, member, item.extra);
            if (action === 'UNCHANGED') {
              tally.unchanged += 1;
              continue;
            }
            if (!current) {
              const claimId = new Types.ObjectId();
              operations.push({
                insertOne: {
                  document: {
                    _id: claimId,
                    caseId: doc.caseId,
                    clientId: doc.clientId,
                    product,
                    tpaCode: doc.tpaCode,
                    claimKey: row.claimKey,
                    ...claimFields(row),
                    parent: { state: 'NONE', id: null },
                    member,
                    board: { state: 'NONE', claimId: null },
                    extra: item.extra,
                    reviewNote: null,
                    firstImportId: doc._id,
                    lastImportId: doc._id,
                    importedAt: now,
                  },
                },
              });
              events.push({
                claimId,
                type: 'CREATED',
                at: now,
                actorId,
                importId: doc._id,
                changes: [],
                fromStatus: null,
                toStatus: row.status,
              });
              tally.created += 1;
              tally.ids.push(claimId);
              continue;
            }
            const comparableCurrent = comparable(current);
            const changes = changedTpaFields(comparableCurrent, row).map((field) =>
              changeOf(field, (comparableCurrent as Record<string, unknown>)[field], row[field]),
            );
            if (current.member.match !== member.match)
              changes.push(changeOf('memberMatch', current.member.match, member.match));
            operations.push({
              updateOne: {
                filter: { _id: current._id },
                // Staff's review note and manual links are never changed by an import.
                update: {
                  $set: {
                    ...claimFields(row),
                    member,
                    extra: item.extra,
                    lastImportId: doc._id,
                    importedAt: now,
                  },
                },
              },
            });
            events.push({
              claimId: current._id,
              type: 'UPDATED',
              at: now,
              actorId,
              importId: doc._id,
              changes,
              fromStatus: current.status,
              toStatus: row.status,
            });
            tally.updated += 1;
            tally.ids.push(current._id);
          }
          if (operations.length > 0)
            await TpaClaimModel.bulkWrite(operations, { session, ordered: true });
          if (events.length > 0) await TpaClaimEventModel.insertMany(events, { session });
          return tally;
        });
        result.created += counts.created;
        result.updated += counts.updated;
        result.unchanged += counts.unchanged;
        touched.push(...counts.ids);
      } catch (error) {
        // The batch is rolled back as a whole: each of its rows is reported as failed.
        const reason =
          (error as { code?: number } | null)?.code === 11000
            ? 'A claim with this ID was saved at the same moment by another import: import the file again'
            : 'The batch could not be saved; nothing from it was written';
        result.failed += items.length;
        for (const item of items)
          if (result.failures.length < 200)
            result.failures.push({ row: item.row, message: reason });
      }
    };
    for await (const row of cursor) {
      batch.push({ row: row.row, values: row.values as never, extra: row.extra });
      if (batch.length >= BATCH) await run();
    }
    await run();
    await relinkScope(doc.caseId, doc.tpaCode, touched);
    // N11: the board follows the records this import created or updated (unchanged ones: nothing).
    const board = await syncBoard(doc, touched, actor, transport);
    Object.assign(result, {
      board: {
        created: board.created,
        moved: board.moved,
        settlementUpdated: board.settlementUpdated,
        unchanged: board.unchanged,
        notMapped: board.notMapped,
        review: board.review,
        failed: board.failed,
        emailsQueued: board.emailsQueued,
      },
      unmappedBoardStatuses: [...board.unmapped.entries()].map(([source, rows]) => ({
        source,
        rows,
      })),
    });
  } catch (error) {
    await TpaImportModel.updateOne(
      { _id: doc._id, committing: lock },
      {
        $set: {
          status: 'FAILED',
          committing: null,
          result,
          importedAt: new Date(),
          importedBy: actorId,
        },
      },
    );
    throw error;
  }
  await TpaImportModel.updateOne(
    { _id: doc._id, committing: lock },
    {
      $set: {
        status: 'IMPORTED',
        committing: null,
        result,
        importedAt: new Date(),
        importedBy: actorId,
      },
    },
  );
  await writeAudit({
    userId: actor.id,
    action: AUDIT_ACTIONS.TPA_IMPORT_COMMITTED,
    entity: AUDIT_ENTITIES.INSURED_POLICY,
    entityId: doc.caseId.toHexString(),
    before: null,
    after: {
      importId: id,
      fileName: doc.fileName,
      tpaCode: doc.tpaCode,
      policy,
      created: result.created,
      updated: result.updated,
      unchanged: result.unchanged,
      skipped: result.skipped,
      failed: result.failed,
    },
    requestId: actor.requestId,
  });
  return getTpaImport(id);
}

/**
 * Links records to their main claim by the main claim's ID (same policy and TPA), and to a board
 * claim of the policy by the census member and admission date. Never by a name; more than one
 * board claim is AMBIGUOUS, for manual review. Manual links are kept.
 */
export async function relinkScope(
  caseId: Types.ObjectId,
  tpaCode: string,
  touched: readonly Types.ObjectId[],
): Promise<void> {
  const keys = new Map(
    (await TpaClaimModel.find({ caseId, tpaCode }, { claimKey: 1 }).lean()).map((item) => [
      item.claimKey,
      item._id,
    ]),
  );
  const withParent = await TpaClaimModel.find(
    {
      caseId,
      tpaCode,
      'parent.state': { $ne: 'MANUAL' },
      $or: [{ parentClaimId: { $ne: null } }, { 'parent.state': { $ne: 'NONE' } }],
    },
    { parentClaimId: 1, parent: 1, requestType: 1 },
  ).lean();
  const parentOps = withParent.flatMap((item) => {
    const target =
      item.parentClaimId && item.requestType !== 'MAIN'
        ? (keys.get(claimKeyOf(item.parentClaimId)) ?? null)
        : null;
    const state =
      !item.parentClaimId || item.requestType === 'MAIN' ? 'NONE' : target ? 'LINKED' : 'NOT_FOUND';
    if (item.parent.state === state && String(item.parent.id) === String(target)) return [];
    return [
      {
        updateOne: {
          filter: { _id: item._id },
          update: { $set: { parent: { state, id: target } } },
        },
      },
    ];
  });
  if (parentOps.length > 0) await TpaClaimModel.bulkWrite(parentOps as never, { ordered: false });
  if (touched.length === 0) return;
  const records = await TpaClaimModel.find(
    { _id: { $in: touched }, 'board.state': { $ne: 'MANUAL' } },
    { member: 1, admissionDate: 1, board: 1, requestType: 1, parent: 1 },
  )
    .sort({ _id: 1 })
    .lean();
  // Board claims another TPA record already drives: a second record on the same card is for review.
  const taken = new Map(
    (
      await TpaClaimModel.find(
        {
          caseId,
          _id: { $nin: records.map((record) => record._id) },
          'board.state': { $in: ['LINKED', 'MANUAL'] },
        },
        { board: 1 },
      ).lean()
    ).map((item) => [String(item.board.claimId), item._id]),
  );
  const boardOps = [];
  for (const record of records) {
    let state: 'NONE' | 'LINKED' | 'AMBIGUOUS' = 'NONE';
    let claimId: Types.ObjectId | null = null;
    // A pre-auth or pre/post record linked to its main claim follows that claim on the board.
    const follower = record.requestType !== 'MAIN' && record.parent.state === 'LINKED';
    if (
      !follower &&
      record.member.match === 'MATCHED' &&
      record.member.memberId &&
      record.admissionDate
    ) {
      // The board claim this record created is its own; otherwise one claim of the same patient
      // and admission date.
      const own = await ClaimModel.findOne(
        { 'tpa.tpaClaimRecordId': record._id },
        { _id: 1 },
      ).lean();
      const boards = own
        ? [own]
        : await ClaimModel.find(
            {
              ghiCaseId: caseId,
              'patient.memberId': record.member.memberId,
              admissionDate: record.admissionDate,
            },
            { _id: 1 },
          )
            .limit(2)
            .lean();
      if (boards.length === 1) {
        const other = taken.get(String(boards[0]!._id));
        if (other && String(other) !== String(record._id)) state = 'AMBIGUOUS';
        else {
          state = 'LINKED';
          claimId = boards[0]!._id;
          taken.set(String(claimId), record._id);
        }
      } else if (boards.length > 1) state = 'AMBIGUOUS';
    }
    if (record.board.state !== state || String(record.board.claimId) !== String(claimId)) {
      boardOps.push({
        updateOne: { filter: { _id: record._id }, update: { $set: { board: { state, claimId } } } },
      });
    }
  }
  if (boardOps.length > 0) await TpaClaimModel.bulkWrite(boardOps as never, { ordered: false });
}
