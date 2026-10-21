import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import {
  MAX_TPA_ROWS,
  streamTpaSheet,
  tpaCell,
  workbookSheets,
} from '../src/modules/tpa/tpa-workbook.ts';

// The streaming reader for TPA files (N9 5). ExcelJS's streaming reader loses the parts of a zip
// that come after a sheet it had to set aside while the caller is slow (shared strings, styles):
// these tests read the same files many times with a slow caller to show every read is complete.

async function book(
  sheets: Array<{ name: string; rows: unknown[][] }>,
  options: { sharedStrings?: boolean } = {},
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  for (const sheet of sheets) workbook.addWorksheet(sheet.name).addRows(sheet.rows);
  return Buffer.from(
    await workbook.xlsx.writeBuffer({ useSharedStrings: options.sharedStrings ?? true }),
  );
}

async function read(data: Buffer, sheetName: string | null = null, headerRow = 1, slow = false) {
  const rows: Array<[number, string[]]> = [];
  let headers: string[] = [];
  const result = await streamTpaSheet(data, {
    sheetName,
    headerRow,
    onHeaders: (found) => {
      headers = found;
    },
    onRow: async (row, values) => {
      if (slow) await new Promise((resolve) => setTimeout(resolve, 2));
      rows.push([row, values.slice(1).map((value) => JSON.stringify(tpaCell(value ?? null)))]);
    },
  });
  return { result, headers, rows };
}

describe('streaming TPA sheets', () => {
  it('reads every header and cell on every read, with a slow caller, from shared or inline strings', async () => {
    const sheets = [
      { name: 'Notes', rows: [['Not this sheet']] },
      {
        name: 'Claims',
        rows: [
          ['Claim No', 'Status', 'DOA', 'Amount'],
          ['CL-1', 'Settled', new Date(Date.UTC(2026, 4, 10)), 1234.5],
          ['CL-2', 'Registration', '11/05/2026', '2,000'],
        ],
      },
    ];
    for (const sharedStrings of [true, false]) {
      const data = await book(sheets, { sharedStrings });
      for (let run = 0; run < 10; run += 1) {
        const { result, headers, rows } = await read(data, 'claims', 1, true);
        expect(result).toMatchObject({ ok: true, sheet: 'Claims', rows: 2 });
        expect(headers).toEqual(['Claim No', 'Status', 'DOA', 'Amount']);
        expect(rows).toEqual([
          [2, ['"CL-1"', '"Settled"', '{"date":"2026-05-10"}', '"1234.5"']],
          [3, ['"CL-2"', '"Registration"', '"11/05/2026"', '"2,000"']],
        ]);
      }
    }
  });

  it('finds the sheet by name, lists the sheets, and says when the sheet or header row is missing', async () => {
    const data = await book([
      { name: 'First', rows: [['a']] },
      { name: 'Second', rows: [[], ['Claim No'], ['X']] },
    ]);
    expect(workbookSheets(data).map((sheet) => sheet.name)).toEqual(['First', 'Second']);
    expect((await read(data, null)).headers).toEqual(['a']);
    expect((await read(data, 'Second', 2)).rows).toEqual([[3, ['"X"']]]);
    expect((await read(data, 'Third')).result).toEqual({
      ok: false,
      sheets: ['First', 'Second'],
      issues: ['No sheet named "Third". The file has: First, Second.'],
    });
    expect((await read(data, 'Second', 1)).result).toMatchObject({ ok: false });
    expect((await read(Buffer.from('PK\u0003\u0004 not really a zip'))).result.ok).toBe(false);
    expect((await read(Buffer.from('plain text'))).result).toMatchObject({
      ok: false,
      issues: ['This is not an Excel workbook (.xlsx). Save the file as .xlsx and try again.'],
    });
  });

  it(`reads a large sheet row by row and refuses one with more than ${MAX_TPA_ROWS.toLocaleString('en-IN')} rows`, async () => {
    const header = ['Claim No', 'Status', 'Amount', 'Hospital', 'City'];
    const many = (count: number) => [
      header,
      ...Array.from({ length: count }, (_, index) => [
        `CL-${index + 1}`,
        index % 3 === 0 ? 'Settled' : 'Registration',
        1000 + index,
        `Hospital ${index % 50}`,
        'Pune',
      ]),
    ];
    const large = await book([{ name: 'Claims', rows: many(20_000) }]);
    let seen = 0;
    let last = '';
    const result = await streamTpaSheet(large, {
      sheetName: null,
      headerRow: 1,
      onHeaders: () => undefined,
      onRow: async (_row, values) => {
        seen += 1;
        last = JSON.stringify(tpaCell(values[1] ?? null));
        // A flush to the database every 500 rows, as the import does.
        if (seen % 500 === 0) await new Promise((resolve) => setTimeout(resolve, 1));
      },
    });
    expect(result).toMatchObject({ ok: true, rows: 20_000 });
    expect([seen, last]).toEqual([20_000, '"CL-20000"']);

    const tooMany = await book([
      { name: 'Claims', rows: many(MAX_TPA_ROWS + 1).map((row) => row.slice(0, 2)) },
    ]);
    const refused = await streamTpaSheet(tooMany, {
      sheetName: null,
      headerRow: 1,
      onHeaders: () => undefined,
      onRow: () => undefined,
    });
    expect(refused).toMatchObject({ ok: false });
    expect((refused as { issues: string[] }).issues[0]).toContain('more than 50,000 claim rows');
  }, 120_000);
});
