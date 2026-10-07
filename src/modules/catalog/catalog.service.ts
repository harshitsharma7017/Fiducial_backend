import {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  CATALOG_MASTERS,
  CATALOG_REORDERABLE,
  CATALOG_ROW_SCHEMAS,
  CATALOG_SHEETS,
  ERROR_CODES,
  SECTION_CODES,
  catalogKeyOf,
  parseCatalogCells,
  taxRateOn,
  type CatalogImportReport,
  type CatalogItem,
  type CatalogMaster,
  type CatalogRows,
  type CatalogSheetReport,
  type TaxCode,
} from '../../shared/index.ts';
import { Types, mongo } from 'mongoose';
import { withTransaction } from '../../lib/db.ts';
import { conflict, notFound, validationError } from '../../lib/errors.ts';
import type { Logger } from '../../lib/logger.ts';
import { writeAudit, writeAudits, type AuditEntry } from '../audit/audit.service.ts';
import type { Actor } from '../clients/clients.service.ts';
import { CatalogItemModel } from './catalog-item.model.ts';
import { parseCatalogWorkbook } from './catalog-workbook.ts';
import { compareCatalogItems, toCatalogData, toCatalogItem } from './catalog.mapper.ts';

function isDuplicateKey(error: unknown): boolean {
  return error instanceof mongo.MongoServerError && error.code === 11000;
}

function itemExists(master: CatalogMaster): never {
  const columns = CATALOG_SHEETS[master].keyColumns
    .map((key) => CATALOG_SHEETS[master].columns.find((column) => column.key === key)?.header)
    .join(' and ');
  throw conflict(ERROR_CODES.CATALOG_ITEM_EXISTS, `A row with this ${columns} already exists`);
}

/** Every row of a master, in display order. */
export async function catalogItems<M extends CatalogMaster>(master: M): Promise<CatalogItem<M>[]> {
  const docs = await CatalogItemModel.find({ master }).lean();
  return docs.map((doc) => toCatalogItem(master, doc)).toSorted(compareCatalogItems(master));
}

/** The rows whose text holds every word of q (any column, ignoring case). */
export async function listCatalog<M extends CatalogMaster>(
  master: M,
  q?: string,
): Promise<{ items: CatalogItem<M>[] }> {
  const items = await catalogItems(master);
  const words = (q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { items };
  return {
    items: items.filter((item) => {
      const text = Object.values(item)
        .map((value) => (Array.isArray(value) ? value.join(' ') : String(value ?? '')))
        .join(' ')
        .toLowerCase();
      return words.every((word) => text.includes(word));
    }),
  };
}

/** The audit snapshot of a row: its columns, without ids or times. */
function auditView(master: CatalogMaster, item: CatalogItem) {
  const values = item as Record<string, unknown>;
  return {
    master: CATALOG_SHEETS[master].label,
    ...Object.fromEntries(
      CATALOG_SHEETS[master].columns.map((column) => {
        const value = values[column.key];
        return [column.key, Array.isArray(value) ? value.join('; ') : (value ?? null)];
      }),
    ),
  };
}

function parseRow<M extends CatalogMaster>(master: M, body: unknown): CatalogRows[M] {
  const parsed = CATALOG_ROW_SCHEMAS[master].safeParse(body);
  if (!parsed.success) {
    throw validationError(
      parsed.error.issues.map((issue) => ({
        location: 'body',
        path: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }
  return parsed.data as CatalogRows[M];
}

export async function createCatalogItem<M extends CatalogMaster>(
  master: M,
  body: unknown,
  actor: Actor,
): Promise<CatalogItem<M>> {
  const row = parseRow(master, body);
  if (master === 'sections') {
    throw validationError(
      [{ location: 'body', path: 'code', message: 'The 14 sections are fixed; edit them instead' }],
      'Sections cannot be added',
    );
  }
  const userId = new Types.ObjectId(actor.id);
  try {
    return await withTransaction(async (session) => {
      const key = catalogKeyOf(master, row);
      if (await CatalogItemModel.exists({ master, key }).session(session)) itemExists(master);
      const [doc] = await CatalogItemModel.create(
        [{ master, key, data: toCatalogData(master, row), createdBy: userId, updatedBy: userId }],
        { session },
      );
      if (!doc) throw new Error('Master row was not created');
      const item = toCatalogItem(master, doc.toObject());
      await writeAudit(
        {
          userId: actor.id,
          action: AUDIT_ACTIONS.CATALOG_ITEM_CREATED,
          entity: AUDIT_ENTITIES.CATALOG_ITEM,
          entityId: item.id,
          before: null,
          after: auditView(master, item),
          requestId: actor.requestId,
        },
        session,
      );
      return item;
    });
  } catch (error) {
    if (isDuplicateKey(error)) itemExists(master);
    throw error;
  }
}

/** Replaces a row's columns. A section keeps its code. */
export async function updateCatalogItem<M extends CatalogMaster>(
  master: M,
  id: string,
  body: unknown,
  actor: Actor,
): Promise<CatalogItem<M>> {
  const row = parseRow(master, body);
  const key = catalogKeyOf(master, row);
  try {
    return await withTransaction(async (session) => {
      const before = await CatalogItemModel.findOne({ _id: id, master }).session(session).lean();
      if (!before) throw notFound('This master row does not exist');
      if (key !== before.key) {
        if (master === 'sections') {
          throw validationError([
            { location: 'body', path: 'code', message: 'A section’s code cannot change' },
          ]);
        }
        const clash = await CatalogItemModel.exists({
          master,
          key,
          _id: { $ne: before._id },
        }).session(session);
        if (clash) itemExists(master);
      }
      const after = await CatalogItemModel.findByIdAndUpdate(
        id,
        {
          $set: { key, data: toCatalogData(master, row), updatedBy: new Types.ObjectId(actor.id) },
        },
        { returnDocument: 'after', session },
      ).lean();
      if (!after) throw notFound('This master row does not exist');
      const beforeItem = toCatalogItem(master, before);
      const afterItem = toCatalogItem(master, after);
      await writeAudit(
        {
          userId: actor.id,
          action: AUDIT_ACTIONS.CATALOG_ITEM_UPDATED,
          entity: AUDIT_ENTITIES.CATALOG_ITEM,
          entityId: id,
          before: auditView(master, beforeItem),
          after: auditView(master, afterItem),
          requestId: actor.requestId,
        },
        session,
      );
      return afterItem;
    });
  } catch (error) {
    if (isDuplicateKey(error)) itemExists(master);
    throw error;
  }
}

/**
 * Puts the rows of an ordered master in the given order (every row, each once). Fire stays the
 * first section whatever its place in the list.
 */
export async function reorderCatalog<M extends CatalogMaster>(
  master: M,
  ids: readonly string[],
  actor: Actor,
): Promise<{ items: CatalogItem<M>[] }> {
  if (!CATALOG_REORDERABLE.includes(master)) {
    throw validationError([
      { location: 'params', path: 'master', message: 'This master has no order' },
    ]);
  }
  await withTransaction(async (session) => {
    const docs = await CatalogItemModel.find({ master }).session(session).lean();
    const byId = new Map(docs.map((doc) => [doc._id.toHexString(), doc]));
    if (
      ids.length !== docs.length ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !byId.has(id))
    ) {
      throw validationError([
        { location: 'body', path: 'ids', message: 'List every row of the master once' },
      ]);
    }
    let ordered = [...ids];
    if (master === 'sections') {
      const fire = ordered.find((id) => byId.get(id)?.data.code === 'FIRE');
      if (fire) ordered = [fire, ...ordered.filter((id) => id !== fire)];
    }
    const audits: AuditEntry[] = [];
    for (const [index, id] of ordered.entries()) {
      const doc = byId.get(id);
      if (!doc || doc.data.order === index + 1) continue;
      const data = { ...doc.data, order: index + 1 };
      await CatalogItemModel.updateOne(
        { _id: doc._id },
        { $set: { data, updatedBy: new Types.ObjectId(actor.id) } },
        { session },
      );
      audits.push({
        userId: actor.id,
        action: AUDIT_ACTIONS.CATALOG_ITEM_UPDATED,
        entity: AUDIT_ENTITIES.CATALOG_ITEM,
        entityId: id,
        before: { master: CATALOG_SHEETS[master].label, order: doc.data.order ?? null },
        after: { master: CATALOG_SHEETS[master].label, order: index + 1 },
        requestId: actor.requestId,
      });
    }
    if (audits.length > 0) await writeAudits(audits, session);
  });
  return listCatalog(master);
}

/**
 * Rules across the rows of one sheet: duplicates among valid rows, and every section present
 * (judged on the codes typed, so an invalid row does not also count as missing).
 */
function setIssues(
  master: CatalogMaster,
  rows: { row: number; value: object }[],
  typed: readonly Record<string, string>[],
): CatalogSheetReport['issues'] {
  const issues: CatalogSheetReport['issues'] = [];
  const seen = new Map<string, number>();
  const keyHeaders = CATALOG_SHEETS[master].keyColumns
    .map((key) => CATALOG_SHEETS[master].columns.find((column) => column.key === key)?.header)
    .join(' and ');
  for (const { row, value } of rows) {
    const key = catalogKeyOf(master, value);
    const first = seen.get(key);
    if (first !== undefined) {
      issues.push({ row, column: null, message: `Same ${keyHeaders} as row ${first}` });
    } else {
      seen.set(key, row);
    }
  }
  if (master === 'sections') {
    const codes = new Set(typed.map((cells) => (cells.code ?? '').trim().toUpperCase()));
    for (const code of SECTION_CODES) {
      if (!codes.has(code)) {
        issues.push({ row: null, column: 'Code', message: `Add a row for the ${code} section` });
      }
    }
  }
  if (master === 'tax-rates' && typed.length === 0) {
    issues.push({ row: null, column: null, message: 'Add at least one GST rate' });
  }
  return issues;
}

/**
 * Checks a product and cover masters workbook and, unless it is a dry run, replaces each master
 * whose sheet is in the file, in one transaction. Nothing is saved when any sheet has a problem.
 */
export async function importCatalogWorkbook(
  data: Buffer,
  options: { dryRun: boolean; sourceFileName: string | null },
  actor: Actor,
  log?: Logger,
): Promise<CatalogImportReport> {
  const parsed = await parseCatalogWorkbook(data);
  if (!parsed.ok) {
    if (parsed.cause) log?.warn({ err: parsed.cause }, 'Catalog workbook could not be read');
    return { dryRun: options.dryRun, imported: false, fileErrors: [parsed.message], sheets: [] };
  }
  const counts = new Map(
    (
      await CatalogItemModel.aggregate<{ _id: CatalogMaster; n: number }>([
        { $group: { _id: '$master', n: { $sum: 1 } } },
      ])
    ).map((entry) => [entry._id, entry.n]),
  );

  const valid = new Map<CatalogMaster, object[]>();
  const sheets: CatalogSheetReport[] = parsed.sheets.map((sheet) => {
    const spec = CATALOG_SHEETS[sheet.master];
    const header = (key: string | null) =>
      key === null ? null : (spec.columns.find((column) => column.key === key)?.header ?? key);
    const issues = [...sheet.issues];
    const rows: { row: number; value: object }[] = [];
    for (const { row, cells } of sheet.rows) {
      const result = parseCatalogCells(sheet.master, cells);
      if (result.row) rows.push({ row, value: result.row });
      else
        issues.push(
          ...result.issues.map((issue) => ({
            row,
            column: header(issue.column),
            message: issue.message,
          })),
        );
    }
    if (sheet.present && sheet.issues.length === 0)
      issues.push(
        ...setIssues(
          sheet.master,
          rows,
          sheet.rows.map((entry) => entry.cells),
        ),
      );
    if (sheet.present)
      valid.set(
        sheet.master,
        rows.map((entry) => entry.value),
      );
    return {
      master: sheet.master,
      label: spec.label,
      sheetName: spec.sheetName,
      present: sheet.present,
      rows: sheet.rows.length,
      currentRows: counts.get(sheet.master) ?? 0,
      issues,
    };
  });

  const clean = sheets.every((sheet) => sheet.issues.length === 0);
  if (options.dryRun || !clean) {
    return { dryRun: options.dryRun, imported: false, fileErrors: [], sheets };
  }

  const userId = new Types.ObjectId(actor.id);
  await withTransaction(async (session) => {
    const audits: AuditEntry[] = [];
    for (const sheet of sheets) {
      const rows = valid.get(sheet.master);
      if (!sheet.present || !rows) continue;
      await CatalogItemModel.deleteMany({ master: sheet.master }, { session });
      await CatalogItemModel.insertMany(
        rows.map((row) => ({
          master: sheet.master,
          key: catalogKeyOf(sheet.master, row),
          data: toCatalogData(sheet.master, row),
          createdBy: userId,
          updatedBy: userId,
        })),
        { session },
      );
      audits.push({
        userId: actor.id,
        action: AUDIT_ACTIONS.CATALOG_IMPORTED,
        entity: AUDIT_ENTITIES.CATALOG,
        entityId: sheet.master,
        before: { master: sheet.label, rows: sheet.currentRows },
        after: { master: sheet.label, rows: rows.length, sourceFileName: options.sourceFileName },
        requestId: actor.requestId,
      });
    }
    await writeAudits(audits, session);
  });
  return { dryRun: false, imported: true, fileErrors: [], sheets };
}

/** Every master's rows, for the workbook download. */
export async function allCatalogItems(): Promise<Record<CatalogMaster, CatalogItem[]>> {
  const entries = await Promise.all(
    CATALOG_MASTERS.map(async (master) => [master, await catalogItems(master)] as const),
  );
  return Object.fromEntries(entries) as Record<CatalogMaster, CatalogItem[]>;
}

/**
 * The tax rate in force on a date (YYYY-MM-DD), from the tax master; the configured default when
 * the master has no rate for that date.
 */
export async function taxRatePercentOn(
  tax: TaxCode,
  date: string,
  fallback: string,
): Promise<string> {
  const rates = await catalogItems('tax-rates');
  return taxRateOn(rates, tax, date)?.ratePercent ?? fallback;
}
