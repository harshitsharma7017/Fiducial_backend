import { headerKey, type TpaCell, type TpaClaimField } from '../../shared/index.ts';
import ExcelJS from 'exceljs';
import { Readable } from 'node:stream';
import { inflateRawSync } from 'node:zlib';

// Reads a TPA's Excel export row by row with the streaming reader (N9 5), so a large file with
// hundreds of columns is never held as a whole workbook in memory. The caller gets the headers,
// then each data row's mapped cells; nothing is logged from the cells.

export const MAX_TPA_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_TPA_ROWS = 50_000;

type CellValue = ExcelJS.CellValue;

function plain(value: CellValue): string | number | boolean | Date | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value instanceof Date
  ) {
    return value;
  }
  if (typeof value === 'object') {
    if ('result' in value) return plain(value.result);
    if ('richText' in value) return value.richText.map((part) => part.text).join('');
    if ('error' in value) return String(value.error);
    if ('text' in value && typeof value.text === 'string') return value.text;
  }
  return null;
}

/** A cell as the TPA parser reads it: an Excel date as a date, anything else as text. */
export function tpaCell(value: CellValue): TpaCell {
  const cell = plain(value);
  if (cell === null) return '';
  if (cell instanceof Date) {
    const pad = (part: number) => String(part).padStart(2, '0');
    return {
      date: `${cell.getUTCFullYear()}-${pad(cell.getUTCMonth() + 1)}-${pad(cell.getUTCDate())}`,
    };
  }
  // Excel numbers are binary floats: 15 significant digits recover what was typed.
  if (typeof cell === 'number')
    return Number.isFinite(cell) ? String(Number(cell.toPrecision(15))) : '';
  return String(cell);
}

export interface ColumnPlan {
  /** Column (1-based) of each mapped field found in the header row. */
  fields: Map<TpaClaimField, number>;
  /** Column of each kept extra header found. */
  extra: Map<string, number>;
  /** Mapped headers not found, by field. */
  missing: Array<{ field: TpaClaimField; header: string; required: boolean }>;
}

export function planColumns(
  headers: readonly string[],
  mappings: ReadonlyArray<{ field: TpaClaimField; header: string; required: boolean }>,
  keepColumns: readonly string[],
): ColumnPlan {
  const byKey = new Map<string, number>();
  headers.forEach((header, index) => {
    const key = headerKey(header);
    if (key && !byKey.has(key)) byKey.set(key, index + 1);
  });
  const fields = new Map<TpaClaimField, number>();
  const missing: ColumnPlan['missing'] = [];
  for (const mapping of mappings) {
    const column = byKey.get(headerKey(mapping.header));
    if (column === undefined) missing.push(mapping);
    else fields.set(mapping.field, column);
  }
  const extra = new Map<string, number>();
  for (const header of keepColumns) {
    const column = byKey.get(headerKey(header));
    if (column !== undefined) extra.set(header, column);
  }
  return { fields, extra, missing };
}

export type SheetRead =
  | { ok: true; sheets: string[]; sheet: string; headers: string[]; rows: number }
  | { ok: false; issues: string[]; sheets: string[] };

interface ZipPart {
  name: string;
  method: number;
  flags: number;
  time: number;
  date: number;
  crc: number;
  compressedSize: number;
  size: number;
  /** Where the compressed bytes start. */
  start: number;
}

/** The files of the .xlsx (a zip), read through the central directory; null when it is not a zip. */
function zipParts(data: Buffer): Map<string, ZipPart> | null {
  const min = Math.max(0, data.length - 65_557);
  let end = -1;
  for (let at = data.length - 22; at >= min; at -= 1) {
    if (data.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end === -1) return null;
  const count = data.readUInt16LE(end + 10);
  let at = data.readUInt32LE(end + 16);
  const parts = new Map<string, ZipPart>();
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > data.length || data.readUInt32LE(at) !== 0x02014b50) return null;
    const nameLength = data.readUInt16LE(at + 28);
    const local = data.readUInt32LE(at + 42);
    const name = data.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    if (local + 30 > data.length || data.readUInt32LE(local) !== 0x04034b50) return null;
    const part: ZipPart = {
      name,
      flags: data.readUInt16LE(at + 8),
      method: data.readUInt16LE(at + 10),
      time: data.readUInt16LE(at + 12),
      date: data.readUInt16LE(at + 14),
      crc: data.readUInt32LE(at + 16),
      compressedSize: data.readUInt32LE(at + 20),
      size: data.readUInt32LE(at + 24),
      start: local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28),
    };
    if (part.start + part.compressedSize > data.length) return null;
    parts.set(name, part);
    at += 46 + nameLength + data.readUInt16LE(at + 30) + data.readUInt16LE(at + 32);
  }
  return parts;
}

/** One file of the .xlsx, inflated; null when absent. */
function zipEntry(data: Buffer, wanted: string): Buffer | null {
  const part = zipParts(data)?.get(wanted);
  if (!part) return null;
  const body = data.subarray(part.start, part.start + part.compressedSize);
  if (part.method === 0) return Buffer.from(body);
  if (part.method === 8) return inflateRawSync(body);
  return null;
}

/**
 * A copy of the workbook holding only what reading one sheet needs, in the order the streaming
 * reader needs it: relationships, workbook, shared strings, styles, then the sheet, last. The
 * compressed bytes are copied as they are (nothing is inflated). Read in the order Excel or other
 * tools save it, the streaming reader parks a sheet that comes before its shared strings, and
 * while it waits the zip stream can end early and lose the parts after it (strings or styles).
 */
function sheetOnlyWorkbook(data: Buffer, sheetNo: number): Buffer | null {
  const parts = zipParts(data);
  if (!parts) return null;
  const wanted = [
    'xl/_rels/workbook.xml.rels',
    'xl/workbook.xml',
    'xl/sharedStrings.xml',
    'xl/styles.xml',
    `xl/worksheets/sheet${sheetNo}.xml`,
  ].flatMap((name) => (parts.has(name) ? [parts.get(name)!] : []));
  if (!wanted.at(-1)?.name.startsWith('xl/worksheets/')) return null;
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const part of wanted) {
    const name = Buffer.from(part.name, 'utf8');
    // The sizes go in the header itself, so no data descriptor follows the bytes (bit 3 cleared).
    const flags = part.flags & ~0x0008;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(part.method, 8);
    local.writeUInt16LE(part.time, 10);
    local.writeUInt16LE(part.date, 12);
    local.writeUInt32LE(part.crc, 14);
    local.writeUInt32LE(part.compressedSize, 18);
    local.writeUInt32LE(part.size, 22);
    local.writeUInt16LE(name.length, 26);
    const body = data.subarray(part.start, part.start + part.compressedSize);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(part.method, 10);
    central.writeUInt16LE(part.time, 12);
    central.writeUInt16LE(part.date, 14);
    central.writeUInt32LE(part.crc, 16);
    central.writeUInt32LE(part.compressedSize, 20);
    central.writeUInt32LE(part.size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(wanted.length, 8);
  end.writeUInt16LE(wanted.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const xmlText = (text: string) =>
  text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
const attribute = (tag: string, name: string) => {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return match ? xmlText(match[1]!) : null;
};

/** The workbook's sheets in order, each with the number of its part (sheetN.xml). */
export function workbookSheets(data: Buffer): Array<{ no: number; name: string }> {
  const workbook = zipEntry(data, 'xl/workbook.xml')?.toString('utf8');
  const rels = zipEntry(data, 'xl/_rels/workbook.xml.rels')?.toString('utf8');
  if (!workbook || !rels) return [];
  const targets = new Map<string, string>();
  for (const tag of rels.match(/<Relationship\b[^>]*>/g) ?? []) {
    const id = attribute(tag, 'Id');
    const target = attribute(tag, 'Target');
    if (id && target) targets.set(id, target);
  }
  const sheets: Array<{ no: number; name: string }> = [];
  for (const tag of workbook.match(/<sheet\b[^>]*>/g) ?? []) {
    const name = attribute(tag, 'name');
    const id = attribute(tag, 'r:id');
    const match = id ? /sheet(\d+)\.xml$/.exec(targets.get(id) ?? '') : null;
    if (name !== null && match) sheets.push({ no: Number(match[1]), name });
  }
  return sheets;
}

/**
 * Streams the chosen sheet: `onHeaders` gets the header row (and may stop the read by returning
 * issues), then `onRow` gets every non-blank data row with its Excel row number. `limit` stops
 * after that many data rows (for a preview). The sheet is found by name in the workbook part,
 * whatever order the zip holds its parts in.
 */
export async function streamTpaSheet(
  data: Buffer,
  options: {
    sheetName: string | null;
    headerRow: number;
    limit?: number;
    onHeaders: (headers: string[]) => string[] | void;
    onRow: (row: number, values: CellValue[]) => Promise<void> | void;
  },
): Promise<SheetRead> {
  if (data.length < 4 || data.readUInt32LE(0) !== 0x04034b50) {
    return {
      ok: false,
      sheets: [],
      issues: ['This is not an Excel workbook (.xlsx). Save the file as .xlsx and try again.'],
    };
  }
  if (data.length > MAX_TPA_FILE_BYTES) {
    return {
      ok: false,
      sheets: [],
      issues: [`The file is larger than ${MAX_TPA_FILE_BYTES / 1024 / 1024} MB.`],
    };
  }
  let list: Array<{ no: number; name: string }>;
  try {
    list = workbookSheets(data);
  } catch {
    list = [];
  }
  const unreadable = {
    ok: false as const,
    sheets: list.map((item) => item.name),
    issues: [
      'The workbook could not be read. Open it in Excel, save it as .xlsx (Excel Workbook) and try again.',
    ],
  };
  if (list.length === 0) return unreadable;
  const sheets = list.map((item) => item.name);
  const target = options.sheetName
    ? list.find(
        (item) => item.name.trim().toLowerCase() === options.sheetName!.trim().toLowerCase(),
      )
    : list[0];
  if (!target) {
    return {
      ok: false,
      sheets,
      issues: [`No sheet named "${options.sheetName ?? ''}". The file has: ${sheets.join(', ')}.`],
    };
  }
  const ordered = sheetOnlyWorkbook(data, target.no);
  if (!ordered) return unreadable;
  let headers: string[] | null = null;
  let headerIssues: string[] = [];
  let rows = 0;
  let stopped = false;
  try {
    const reader = new ExcelJS.stream.xlsx.WorkbookReader(Readable.from(ordered), {
      sharedStrings: 'cache',
      styles: 'cache',
      worksheets: 'emit',
    });
    // A workbook without shared strings (all text inline): read the sheet as it streams in.
    if (!zipParts(ordered)?.has('xl/sharedStrings.xml')) {
      (reader as unknown as { sharedStrings?: string[] }).sharedStrings = [];
    }
    // The copy holds the target sheet only.
    for await (const worksheet of reader) {
      const sheet = worksheet as unknown as AsyncIterable<ExcelJS.Row>;
      for await (const row of sheet) {
        if (stopped) continue;
        const values = (row.values as CellValue[]).slice();
        if (row.number < options.headerRow) continue;
        if (row.number === options.headerRow) {
          headers = values.slice(1).map((value) =>
            String(plain(value) ?? '')
              .replace(/\s+/g, ' ')
              .trim(),
          );
          headerIssues = options.onHeaders(headers) ?? [];
          if (headerIssues.length > 0) stopped = true;
          continue;
        }
        if (!headers) continue;
        if (values.every((value) => plain(value) === null || String(plain(value)).trim() === ''))
          continue;
        rows += 1;
        if (rows > MAX_TPA_ROWS) {
          headerIssues = [
            `The sheet has more than ${MAX_TPA_ROWS.toLocaleString('en-IN')} claim rows: split the file.`,
          ];
          stopped = true;
          continue;
        }
        if (options.limit !== undefined && rows > options.limit) {
          stopped = true;
          continue;
        }
        await options.onRow(row.number, values);
      }
    }
  } catch {
    return unreadable;
  }
  if (!headers)
    return {
      ok: false,
      sheets,
      issues: [`Row ${options.headerRow} of "${target.name}" (the header row) is empty.`],
    };
  if (headerIssues.length > 0) return { ok: false, sheets, issues: headerIssues };
  return {
    ok: true,
    sheets,
    sheet: target.name,
    headers,
    rows: Math.min(rows, options.limit ?? rows),
  };
}
