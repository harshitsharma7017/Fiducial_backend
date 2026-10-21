import {
  AUDIT_ACTIONS,
  EB_CENSUS_FIELDS,
  ERROR_CODES,
  GHI_CENSUS_COLUMNS,
  GHI_CENSUS_SHEET,
  MAX_EB_CENSUS_ROWS,
  applyPolicy,
  candidateFromRow,
  classifyImport,
  emptyRowValues,
  dependantsGiveOwnAmount,
  formatDate,
  ghiFieldOf,
  nomineeRequirementOf,
  importResultOf,
  isError,
  resolveHeaders,
  templateColumns,
  type CommitEbImportRequest,
  type EbCensusField,
  type EbCensusImport,
  type EbCensusIssue,
  type EbCensusRowValues,
  type EbImportMode,
  type EbImportResult,
  type EbProduct,
  type GhiCensusIssue,
  type TemplateColumn,
} from '../../shared/index.ts';
import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import { Types, type Model, type mongo } from 'mongoose';
import { withTransaction } from '../../lib/db.ts';
import { toDecimal128 } from '../../lib/decimal.ts';
import { conflict, notFound, unprocessable } from '../../lib/errors.ts';
import { writeAudits, type AuditEntry } from '../audit/audit.service.ts';
import { ensureSelfIdentities } from '../employees/employees.service.ts';
import { withoutNotes } from '../imports/strip-notes.ts';
import { readCell } from '../masters/import/cells.ts';
import { cellString } from './census-workbook.ts';
import {
  buildCensusContext,
  gpaRequirementsOf,
  gtliRequirementsOf,
  planRequired,
  toEbCensusMember,
} from './eb-census-context.ts';
import {
  INSTRUCTIONS_SHEET,
  buildErrorReport,
  readTemplateMarker,
  type TemplateMarker,
} from './eb-census-template.ts';
import { GhiCaseModel, type GhiCaseDoc } from './ghi-case.model.ts';
import {
  EbCensusImportModel,
  GhiCensusImportModel,
  GhiMemberModel,
  type GhiCensusImportDoc,
} from './ghi-census.model.ts';
import {
  assertEditable,
  assertWritable,
  auditCase,
  loadCase,
  nameOf,
  userNames,
  type Actor,
} from './ghi-common.ts';
import { productOf, scopedAction, type CaseScope } from './products/profile.ts';

// The Import_Service (N3, Requirements 20 to 22) for every product. A file is read in memory,
// checked and kept as a preview; nothing joins the census until the user imports it under an
// explicit policy and mode, in one transaction with its identities and audit entries. GMC keeps
// its collection and its guard against importing the same rows twice (22.8, design D4); GPA and
// GTLI accept the same file again and report every row unchanged (22.5).

const MAX_BYTES = 10 * 1024 * 1024;
/** The GHI census fields (GMC stores and fingerprints these, as before N3). */
const GMC_FIELDS = GHI_CENSUS_COLUMNS.map((column) => column.key) as EbCensusField[];

function importModel(product: EbProduct): Model<GhiCensusImportDoc> {
  return product === 'GMC' ? GhiCensusImportModel : EbCensusImportModel;
}

/** GMC's columns before N3: the five required ones must be in the file. */
const LEGACY_COLUMNS: TemplateColumn[] = GHI_CENSUS_COLUMNS.map((column) => ({
  key: column.key,
  header: column.header,
  required: column.required ? 'ALWAYS' : 'NO',
  help: '',
}));

/** The columns a case's file must have (by template level) and the fields it reads. */
export function caseColumns(doc: GhiCaseDoc): {
  columns: TemplateColumn[];
  fields: EbCensusField[];
} {
  const product = productOf(doc);
  const plan = doc.planAssignment;
  if (!plan) {
    if (product !== 'GMC') throw planRequired();
    return { columns: LEGACY_COLUMNS, fields: GMC_FIELDS };
  }
  if (product === 'GMC') {
    return { columns: templateColumns('GMC', plan.slots, 'UNKNOWN'), fields: GMC_FIELDS };
  }
  const sheet = product === 'GPA' ? gpaRequirementsOf(doc) : gtliRequirementsOf(doc);
  const basis = sheet.sumInsuredBasis ?? 'UNKNOWN';
  const ownAmount =
    product === 'GPA' && dependantsGiveOwnAmount(gpaRequirementsOf(doc).dependantBasis);
  return {
    columns: templateColumns(product, plan.slots, basis, {
      dependantsOwnAmount: ownAmount,
      nominees: nomineeRequirementOf(sheet),
    }),
    fields: [...EB_CENSUS_FIELDS],
  };
}

type Parsed =
  | {
      ok: true;
      rows: Array<{ row: number; values: EbCensusRowValues }>;
      columns: EbCensusField[];
      marker: TemplateMarker | null;
    }
  | { ok: false; issues: string[] };

/** Reads an uploaded census workbook into rows of text (Requirements 20.2, 20.3, 20.6). */
export async function parseEbWorkbook(
  data: Buffer,
  expected: readonly TemplateColumn[],
  fields: readonly EbCensusField[],
  /** A marker for another product, plan or version refuses the file first (20.4). */
  markerProblem: (marker: TemplateMarker) => string | null = () => null,
): Promise<Parsed> {
  if (data.length > MAX_BYTES) {
    return { ok: false, issues: ['The file is larger than 10 MB. Split it into several files.'] };
  }
  if (data.length < 4 || data.readUInt32LE(0) !== 0x04034b50) {
    return {
      ok: false,
      issues: ['This is not an Excel workbook (.xlsx). Save the file as .xlsx and try again.'],
    };
  }
  const workbook = new ExcelJS.Workbook();
  try {
    const readable = await withoutNotes(data);
    await workbook.xlsx.load(readable as unknown as Parameters<ExcelJS.Xlsx['load']>[0]);
  } catch {
    return {
      ok: false,
      issues: [
        'The workbook could not be read. Open it in Excel, save it as .xlsx (Excel Workbook) and try again.',
      ],
    };
  }
  const marker = readTemplateMarker(workbook);
  const problem = marker ? markerProblem(marker) : null;
  if (problem) return { ok: false, issues: [problem] };
  const visible = (item: ExcelJS.Worksheet) =>
    item.state !== 'hidden' && item.state !== 'veryHidden';
  const sheet =
    workbook.worksheets.find(
      (item) => item.name.trim().toLowerCase() === GHI_CENSUS_SHEET.toLowerCase(),
    ) ?? workbook.worksheets.find((item) => item.name !== INSTRUCTIONS_SHEET && visible(item));
  if (!sheet) return { ok: false, issues: [`The workbook has no "${GHI_CENSUS_SHEET}" sheet.`] };

  const headers: string[] = [];
  sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, columnNumber) => {
    headers[columnNumber - 1] = cellString(readCell(cell));
  });
  const { columns } = resolveHeaders(headers.map((header) => header ?? ''));
  const missing = expected.filter((column) => column.required !== 'NO' && !columns.has(column.key));
  if (missing.length > 0) {
    return {
      ok: false,
      issues: missing.map(
        (column) =>
          `Row 1: the "${column.header}" column is missing. Use the headers from the census template.`,
      ),
    };
  }
  const rows: Array<{ row: number; values: EbCensusRowValues }> = [];
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const values = emptyRowValues();
    for (const field of fields) {
      const index = columns.get(field);
      values[field] =
        index === undefined ? '' : cellString(readCell(row.getCell(index + 1))).slice(0, 200);
    }
    if (fields.every((field) => values[field] === '')) continue;
    if (rows.length === MAX_EB_CENSUS_ROWS) {
      return {
        ok: false,
        issues: [
          `The sheet has more than ${MAX_EB_CENSUS_ROWS.toLocaleString('en-IN')} rows. Split it into several files.`,
        ],
      };
    }
    rows.push({ row: rowNumber, values });
  }
  if (rows.length === 0) return { ok: false, issues: [`The "${sheet.name}" sheet has no rows.`] };
  return {
    ok: true,
    rows,
    columns: fields.filter((field) => columns.has(field)),
    marker,
  };
}

/** The stored values of a row (GMC rows keep their seven fields; the rest read as blank). */
function storedValues(values: Partial<EbCensusRowValues>): EbCensusRowValues {
  return { ...emptyRowValues(), ...values };
}

/** What GMC stores and fingerprints: the seven GHI fields, in their column order. */
function gmcValues(values: EbCensusRowValues) {
  return Object.fromEntries(GMC_FIELDS.map((field) => [field, values[field]])) as Record<
    (typeof GMC_FIELDS)[number],
    string
  >;
}

/** The fingerprint of a file's rows, not its bytes (as GMC computes it). */
function fingerprintOf(
  product: EbProduct,
  rows: ReadonlyArray<{ row: number; values: EbCensusRowValues }>,
) {
  const content =
    product === 'GMC' ? rows.map((row) => ({ row: row.row, values: gmcValues(row.values) })) : rows;
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

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

/** The mode a preview or import is checked under: GMC without a mode is the legacy check (D8). */
function effectiveMode(
  product: EbProduct,
  mode: EbImportMode | undefined | null,
): EbImportMode | 'LEGACY' {
  if (mode) return mode;
  return product === 'GMC' ? 'LEGACY' : 'ADD_NEW_ONLY';
}

async function loadImport(
  product: EbProduct,
  doc: GhiCaseDoc,
  importId: string,
  session?: mongo.ClientSession,
) {
  const importDoc = await importModel(product)
    .findOne({ _id: new Types.ObjectId(importId), caseId: doc._id })
    .session(session ?? null)
    .lean<GhiCensusImportDoc>();
  if (!importDoc) throw notFound('Census file not found');
  return importDoc;
}

/** Checks the pending rows of a preview against the census as it is now, under a mode. */
async function classifyPreview(
  doc: GhiCaseDoc,
  importDoc: GhiCensusImportDoc,
  mode: EbImportMode | 'LEGACY',
  session?: mongo.ClientSession,
) {
  const context = await buildCensusContext(doc, { session });
  const members = await GhiMemberModel.find({ caseId: doc._id })
    .session(session ?? null)
    .lean();
  const pending = importDoc.rows.filter((row) => !row.imported);
  const candidates = pending.map((row) =>
    candidateFromRow(row.row, storedValues(row.values), context),
  );
  const plan = classifyImport(candidates, members.map(toEbCensusMember), context, mode);
  return { plan, candidates, context };
}

async function importView(
  doc: GhiCaseDoc,
  importDoc: GhiCensusImportDoc,
  mode: EbImportMode | undefined | null,
): Promise<EbCensusImport> {
  const product = productOf(doc);
  const checkedMode = effectiveMode(product, mode ?? importDoc.mode ?? undefined);
  const byRow = new Map<
    number,
    { issues: EbCensusIssue[]; match: EbCensusImport['rows'][number]['match'] }
  >();
  if (importDoc.status === 'PREVIEW') {
    const { plan } = await classifyPreview(doc, importDoc, checkedMode);
    for (const row of plan.rows) {
      byRow.set(row.row ?? 0, { issues: row.issues, match: row.match });
    }
  }
  const names = await userNames([importDoc.uploadedBy]);
  const rows = importDoc.rows.map((row) => {
    const checked = byRow.get(row.row);
    const issues =
      importDoc.status === 'PREVIEW' ? (checked?.issues ?? []) : (row.issues as EbCensusIssue[]);
    return {
      row: row.row,
      values: storedValues(row.values),
      issues,
      valid: row.imported || !issues.some((issue) => (issue.severity ?? 'ERROR') === 'ERROR'),
      warnings: issues.filter((issue) => issue.severity === 'WARNING').length,
      corrected: row.corrected,
      imported: row.imported,
      match: checked?.match ?? null,
    };
  });
  const valid = rows.filter((row) => row.valid).length;
  return {
    id: importDoc._id.toHexString(),
    product,
    fileName: importDoc.fileName,
    status: importDoc.status,
    fileIssues: importDoc.fileIssues,
    fileWarnings: importDoc.fileWarnings ?? [],
    columns: importDoc.columns ?? [],
    marker: importDoc.marker ?? null,
    mode: checkedMode === 'LEGACY' ? null : checkedMode,
    rows,
    counts: {
      rows: rows.length,
      valid,
      invalid: rows.length - valid,
      warnings: rows.filter((row) => row.warnings > 0).length,
      imported: importDoc.importedCount,
    },
    policy: importDoc.policy,
    result: importDoc.result
      ? {
          ...importDoc.result,
          leftOut: importDoc.rows
            .filter(
              (row) =>
                !row.imported &&
                (row.issues as EbCensusIssue[]).length > 0 &&
                importDoc.status === 'IMPORTED',
            )
            .map((row) => ({
              row: row.row,
              employeeId: row.values.employeeId || null,
              issues: row.issues as EbCensusIssue[],
            })),
        }
      : null,
    uploadedAt: importDoc.createdAt.toISOString(),
    uploadedBy: nameOf(names, importDoc.uploadedBy),
    importedAt: importDoc.importedAt?.toISOString() ?? null,
  };
}

/**
 * Reads and checks an uploaded census (Requirement 20). Refusals keep nothing; an open preview of
 * the case is set aside (and audited) in the transaction that keeps the new one (20.12).
 */
export async function uploadEbCensus(
  scope: CaseScope,
  id: string,
  data: Buffer,
  fileName: string,
  actor: Actor,
): Promise<EbCensusImport> {
  const doc = await loadCase(id, undefined, scope);
  assertCensusWritable(doc);
  const product = scope.product;
  const { columns, fields } = caseColumns(doc);
  const plan = doc.planAssignment;
  const parsed = await parseEbWorkbook(data, columns, fields, (marker) =>
    plan &&
    marker.product === product &&
    marker.planCode === plan.code &&
    marker.planVersion === plan.versionNumber
      ? null
      : `This file was made for ${marker.product} plan ${marker.planCode} v${marker.planVersion}, but the case is ${product}${plan ? ` with plan ${plan.code} v${plan.versionNumber}` : ' with no plan'}. Download the template for this case and fill it again.`,
  );
  if (!parsed.ok) {
    throw unprocessable(
      ERROR_CODES.IMPORT_FILE_INVALID,
      parsed.issues[0] ?? 'The file cannot be read',
      {
        issues: parsed.issues,
      },
    );
  }
  const fileWarnings: string[] = [];
  if (!parsed.marker && plan) {
    fileWarnings.push(
      'The file carries no product or plan marker, so its product and plan could not be confirmed. Its rows are checked against the case’s own plan.',
    );
  }
  const rows =
    product === 'GMC'
      ? parsed.rows.map((row) => ({ row: row.row, values: storedValues(gmcValues(row.values)) }))
      : parsed.rows;
  const sha256 = fingerprintOf(product, rows);
  if (product === 'GMC') {
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
  }
  const actorId = new Types.ObjectId(actor.id);
  const model = importModel(product);
  const created = await withTransaction(async (session) => {
    const open = await model
      .find({ caseId: doc._id, status: 'PREVIEW' }, { fileName: 1, rows: 1 })
      .session(session)
      .lean();
    if (open.length > 0) {
      await model.updateMany(
        { caseId: doc._id, status: 'PREVIEW' },
        { $set: { status: 'DISCARDED' } },
        { session },
      );
    }
    const [saved] = await model.create(
      [
        {
          caseId: doc._id,
          fileName,
          sha256,
          status: 'PREVIEW',
          fileIssues: [],
          rows: rows.map((row) => ({
            row: row.row,
            values: product === 'GMC' ? gmcValues(row.values) : row.values,
            corrected: false,
            imported: false,
            issues: [],
          })),
          policy: null,
          mode: null,
          columns: parsed.columns,
          fileWarnings,
          ...(parsed.marker ? { marker: parsed.marker } : {}),
          importedCount: 0,
          uploadedBy: actorId,
          importedAt: null,
          importedBy: null,
        },
      ],
      { session },
    );
    if (!saved) throw new Error('Census file was not saved');
    for (const item of open) {
      await auditCase(
        actor,
        AUDIT_ACTIONS.GHI_CENSUS_IMPORT_DISCARDED,
        id,
        null,
        { file: item.fileName, rows: item.rows.length, replacedBy: fileName },
        session,
        scope,
      );
    }
    await auditCase(
      actor,
      AUDIT_ACTIONS.GHI_CENSUS_UPLOADED,
      id,
      null,
      { fileName, size: data.length, rows: rows.length, sha256 },
      session,
      scope,
    );
    return saved.toObject();
  });
  return importView(doc, created, null);
}

export async function getEbImport(
  scope: CaseScope,
  id: string,
  importId: string,
  mode?: EbImportMode,
): Promise<EbCensusImport> {
  const doc = await loadCase(id, undefined, scope);
  return importView(doc, await loadImport(scope.product, doc, importId), mode);
}

export async function listEbImports(scope: CaseScope, id: string) {
  const doc = await loadCase(id, undefined, scope);
  const imports = await importModel(scope.product)
    .find({ caseId: doc._id }, { rows: 0 })
    .sort({ _id: -1 })
    .limit(50)
    .lean<GhiCensusImportDoc[]>();
  const names = await userNames(imports.map((item) => item.uploadedBy));
  return imports.map((item) => ({
    id: item._id.toHexString(),
    product: scope.product,
    fileName: item.fileName,
    status: item.status,
    importedCount: item.importedCount,
    policy: item.policy,
    mode: item.mode ?? null,
    result: item.result ? { ...item.result, leftOut: [] } : null,
    uploadedAt: item.createdAt.toISOString(),
    uploadedBy: nameOf(names, item.uploadedBy),
    importedAt: item.importedAt?.toISOString() ?? null,
  }));
}

/** Corrects one row of a preview and checks it again with its families (Requirement 21). */
export async function correctEbImportRow(
  scope: CaseScope,
  id: string,
  importId: string,
  rowNumber: number,
  values: EbCensusRowValues,
  actor: Actor,
  mode?: EbImportMode,
): Promise<EbCensusImport> {
  const doc = await loadCase(id, undefined, scope);
  assertCensusWritable(doc);
  const product = scope.product;
  const importDoc = await loadImport(product, doc, importId);
  if (importDoc.status !== 'PREVIEW') {
    throw conflict(
      ERROR_CODES.CONFLICT,
      'This file has been imported or set aside; upload it again to change it.',
    );
  }
  const row = importDoc.rows.find((item) => item.row === rowNumber);
  if (!row) throw notFound(`Row ${rowNumber} is not in this file`);
  const next = product === 'GMC' ? gmcValues(storedValues(values)) : storedValues(values);
  const updated = await withTransaction(async (session) => {
    const saved = await importModel(product)
      .findOneAndUpdate(
        { _id: importDoc._id, caseId: doc._id, status: 'PREVIEW' },
        { $set: { 'rows.$[target].values': next, 'rows.$[target].corrected': true } },
        { returnDocument: 'after', session, arrayFilters: [{ 'target.row': rowNumber }] },
      )
      .lean<GhiCensusImportDoc>();
    if (!saved) throw conflict(ERROR_CODES.CONFLICT, 'This file has been imported or set aside.');
    await auditCase(
      actor,
      AUDIT_ACTIONS.GHI_CENSUS_ROW_CORRECTED,
      id,
      { file: importDoc.fileName, row: rowNumber, ...row.values },
      { file: importDoc.fileName, row: rowNumber, ...next },
      session,
      scope,
    );
    return saved;
  });
  return importView(doc, updated, mode);
}

export async function discardEbImport(
  scope: CaseScope,
  id: string,
  importId: string,
  actor: Actor,
): Promise<EbCensusImport> {
  const doc = await loadCase(id, undefined, scope);
  const importDoc = await loadImport(scope.product, doc, importId);
  if (importDoc.status !== 'PREVIEW') {
    throw conflict(ERROR_CODES.CONFLICT, 'Only a file not yet imported can be set aside.');
  }
  const updated = await withTransaction(async (session) => {
    const saved = await importModel(scope.product)
      .findOneAndUpdate(
        { _id: importDoc._id, status: 'PREVIEW' },
        { $set: { status: 'DISCARDED' } },
        { returnDocument: 'after', session },
      )
      .lean<GhiCensusImportDoc>();
    if (!saved) throw conflict(ERROR_CODES.CONFLICT, 'This file has been imported or set aside.');
    await auditCase(
      actor,
      AUDIT_ACTIONS.GHI_CENSUS_IMPORT_DISCARDED,
      id,
      null,
      { file: importDoc.fileName, rows: importDoc.rows.length },
      session,
      scope,
    );
    return saved;
  });
  return importView(doc, updated, null);
}

/**
 * Imports a preview (Requirement 22) in one transaction: the rows are checked again against the
 * census, plan and identities as they are at that moment; then the new identities, the members,
 * the updates, the import's result and the audit entries are written, all or none.
 */
export async function commitEbImport(
  scope: CaseScope,
  id: string,
  importId: string,
  input: CommitEbImportRequest,
  actor: Actor,
): Promise<{ result: EbImportResult; import: EbCensusImport }> {
  const product = scope.product;
  const actorId = new Types.ObjectId(actor.id);
  const mode = effectiveMode(product, input.mode);
  const saved = await withTransaction(async (session) => {
    const doc = await loadCase(id, session, scope);
    assertCensusWritable(doc);
    const importDoc = await loadImport(product, doc, importId, session);
    if (importDoc.status !== 'PREVIEW') {
      throw conflict(ERROR_CODES.CONFLICT, 'This file has already been imported or set aside.');
    }
    if (product === 'GMC') {
      const duplicate = await GhiCensusImportModel.exists({
        caseId: doc._id,
        sha256: importDoc.sha256,
        status: 'IMPORTED',
      }).session(session);
      if (duplicate)
        throw conflict(ERROR_CODES.GHI_DUPLICATE_IMPORT, 'This file was already imported.');
    }
    const { plan, candidates } = await classifyPreview(doc, importDoc, mode, session);
    const outcome = applyPolicy(plan, input.policy);
    if (!outcome.ok) {
      throw conflict(
        ERROR_CODES.GHI_CENSUS_INVALID,
        outcome.reason === 'INVALID_ROWS'
          ? `${outcome.invalid} row(s) have problems. Correct them, or import the valid rows only.`
          : 'No row is valid: nothing to import.',
        { invalid: outcome.invalid },
      );
    }
    const selfRows = outcome.add
      .filter((item) => item.member.relationship === 'SELF')
      .map((item) => item.member);
    const identities = await ensureSelfIdentities(doc.clientId, selfRows, actor, session);
    const inserted =
      outcome.add.length > 0
        ? await GhiMemberModel.insertMany(
            outcome.add.map(({ member }) => ({
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
              annualSalary: member.annualSalary === null ? null : toDecimal128(member.annualSalary),
              ...(member.relationship === 'SELF'
                ? { employeeIdentityId: identities.byKey.get(member.employeeKey) ?? null }
                : {}),
              source: 'IMPORT',
              importId: importDoc._id,
              createdBy: actorId,
              updatedBy: actorId,
            })),
            { session },
          )
        : [];
    if (outcome.update.length > 0) {
      await GhiMemberModel.bulkWrite(
        outcome.update.map((item) => ({
          updateOne: {
            filter: { _id: new Types.ObjectId(item.memberId), caseId: doc._id },
            update: {
              $set: {
                sumInsured:
                  item.changes.sumInsured === null ? null : toDecimal128(item.changes.sumInsured),
                annualSalary:
                  item.changes.annualSalary === null
                    ? null
                    : toDecimal128(item.changes.annualSalary),
                dateOfJoining: item.changes.dateOfJoining,
                updatedBy: actorId,
              },
            },
          },
        })),
        { session },
      );
    }
    const result = importResultOf(outcome, {
      created: identities.created.length,
      reused: identities.reused.length,
    });
    const written = new Set([
      ...outcome.add.map((item) => item.key),
      ...outcome.update.map((item) => item.key),
    ]);
    const issuesByKey = new Map(plan.rows.map((row) => [row.key, row.issues]));
    const updatedImport = await importModel(product)
      .findOneAndUpdate(
        { _id: importDoc._id, status: 'PREVIEW' },
        {
          $set: {
            status: 'IMPORTED',
            policy: input.policy,
            mode: mode === 'LEGACY' ? null : mode,
            importedCount: written.size,
            importedAt: new Date(),
            importedBy: actorId,
            result: {
              added: result.added,
              updated: result.updated,
              unchanged: result.unchanged,
              skipped: result.skipped,
              identitiesCreated: result.identitiesCreated,
              identitiesReused: result.identitiesReused,
            },
            rows: importDoc.rows.map((row) => ({
              ...row,
              imported: row.imported || written.has(String(row.row)),
              issues: row.imported ? row.issues : (issuesByKey.get(String(row.row)) ?? []),
            })),
          },
        },
        { returnDocument: 'after', session },
      )
      .lean<GhiCensusImportDoc>();
    if (!updatedImport)
      throw conflict(ERROR_CODES.CONFLICT, 'This file has already been imported.');
    const changed = written.size > 0;
    if (changed) {
      const bumped = await GhiCaseModel.updateOne(
        {
          _id: doc._id,
          stage: { $ne: 'CLOSED' },
          placement: { $in: [null] },
          insurers: { $not: { $elemMatch: { sentAt: { $ne: null } } } },
        },
        {
          $inc: { censusRevision: 1 },
          $set: { updatedBy: actorId },
          $push: {
            activity: {
              at: new Date(),
              actorId,
              message: `Census imported from ${importDoc.fileName}: ${result.added} added, ${result.updated} updated, ${result.unchanged} unchanged${result.skipped > 0 ? `, ${result.skipped} row(s) left out` : ''}`,
            },
          },
        },
        { session },
      );
      if (bumped.modifiedCount === 0) assertCensusWritable(await loadCase(id, session, scope));
    }
    const entityAction = (action: Parameters<typeof scopedAction>[1]) =>
      scopedAction(scope, action);
    const byKey = new Map(candidates.map((candidate) => [candidate.key, candidate]));
    const entries: AuditEntry[] = [
      {
        userId: actor.id,
        action: entityAction(AUDIT_ACTIONS.GHI_CENSUS_IMPORTED),
        entity: scope.auditEntity,
        entityId: id,
        before: null,
        after: {
          file: importDoc.fileName,
          policy: input.policy,
          mode: mode === 'LEGACY' ? null : mode,
          imported: written.size,
          added: result.added,
          updated: result.updated,
          unchanged: result.unchanged,
          skipped: result.skipped,
          identitiesCreated: result.identitiesCreated,
          identitiesReused: result.identitiesReused,
        },
        requestId: actor.requestId,
      },
      // GMC without a mode imports exactly as before (16.7): one entry for the import.
      ...(mode === 'LEGACY' ? [] : outcome.add).map((item, index): AuditEntry => ({
        userId: actor.id,
        action: entityAction(AUDIT_ACTIONS.GHI_MEMBER_CREATED),
        entity: scope.auditEntity,
        entityId: id,
        before: null,
        after: {
          memberId: inserted[index]?._id.toHexString() ?? null,
          row: byKey.get(item.key)?.row ?? null,
          employeeId: item.member.employeeId,
          relationship: item.member.relationship,
        },
        requestId: actor.requestId,
      })),
      ...(mode === 'LEGACY' ? [] : outcome.update).map((item): AuditEntry => ({
        userId: actor.id,
        action: entityAction(AUDIT_ACTIONS.GHI_MEMBER_UPDATED),
        entity: scope.auditEntity,
        entityId: id,
        before: { memberId: item.memberId },
        after: { memberId: item.memberId, ...item.changes },
        requestId: actor.requestId,
      })),
    ];
    await writeAudits(entries, session);
    return { result, importDoc: updatedImport };
  });
  const doc = await loadCase(id, undefined, scope);
  return { result: saved.result, import: await importView(doc, saved.importDoc, null) };
}

/**
 * The preview's error report (Requirement 21.5 to 21.8): only rows with an issue, every cell as
 * text. Audited as an export with counts only, never the rows' values.
 */
export async function ebErrorReport(
  scope: CaseScope,
  id: string,
  importId: string,
  actor: Actor,
  mode?: EbImportMode,
): Promise<{ fileName: string; data: Buffer }> {
  const doc = await loadCase(id, undefined, scope);
  const importDoc = await loadImport(scope.product, doc, importId);
  const view = await importView(doc, importDoc, mode);
  const rows = view.rows.filter((row) => row.issues.length > 0);
  if (rows.length === 0) {
    throw conflict(ERROR_CODES.EB_NO_ERRORS, 'This file has no errors or warnings to report.');
  }
  const fields = view.columns.length > 0 ? view.columns : GMC_FIELDS;
  const data = await buildErrorReport({ fileName: importDoc.fileName, fields, rows });
  const issueCount = rows.reduce((total, row) => total + row.issues.length, 0);
  await auditCase(
    actor,
    AUDIT_ACTIONS.EB_CENSUS_ERROR_REPORT_DOWNLOADED,
    id,
    null,
    { importId, file: importDoc.fileName, rows: rows.length, issues: issueCount, format: 'xlsx' },
    undefined,
    scope,
  );
  const base = importDoc.fileName.replace(/\.xlsx$/i, '');
  return { fileName: `${base}-errors.xlsx`, data };
}

/**
 * The GMC route's shape of an import. Without a mode (requests that carry none of the new
 * fields) it is exactly the GHI contract as before (Requirement 16.7): issues as field and
 * message, and the four counts. With a mode, the issues keep their severity, fix and code.
 */
export function toGhiImport(view: EbCensusImport, options: { legacy: boolean }) {
  const { warnings, ...counts } = view.counts;
  return {
    ...view,
    rows: view.rows.map(({ warnings: rowWarnings, match, ...row }) => ({
      ...row,
      values: gmcValues(row.values),
      issues: row.issues.map((issue): GhiCensusIssue =>
        options.legacy
          ? { field: ghiFieldOf(issue.field), message: issue.message }
          : {
              field: ghiFieldOf(issue.field),
              message: issue.message,
              severity: issue.severity,
              fix: issue.fix,
              code: issue.code,
            },
      ),
      ...(options.legacy ? {} : { warnings: rowWarnings, match }),
    })),
    counts: options.legacy ? counts : { ...counts, warnings },
  };
}

export const hasErrors = (issues: readonly EbCensusIssue[]) => issues.some(isError);
