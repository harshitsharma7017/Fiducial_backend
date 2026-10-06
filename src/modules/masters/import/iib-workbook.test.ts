import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildIibWorkbook } from '../../../../test/helpers/workbook.ts';
import { formatImportReport } from './format-report.ts';
import { ImportStructureError, parseIibWorkbook } from './iib-workbook.ts';
import { occupancyWarningCount } from './types.ts';

const META = { sourceFileName: 'test.xlsx', sourceSha256: 'test' };

describe('parseIibWorkbook (synthetic workbook)', () => {
  it('normalises codes, risk types and float noise in rates', async () => {
    const { occupancies } = await parseIibWorkbook(await buildIibWorkbook(), META);
    expect(occupancies).toHaveLength(5);
    const abrasive = occupancies.find((o) => o.tacCode === '2001');
    expect(abrasive).toMatchObject({
      serialNo: 3,
      riskGrade: 'RG3',
      iibRate: '0.69',
      fireRiskType: 'INDUSTRIAL',
      minStfiRate: '0.37',
      // Excel stored 0.04999999999999999 and 0.09999999999999998.
      minEqRates: { zone1: '0.5', zone2: '0.25', zone3: '0.1', zone4: '0.05' },
    });
    expect(occupancies.find((o) => o.tacCode === '1001_2')?.fireRiskType).toBe('NON_INDUSTRIAL');
    expect(occupancies.every((o) => typeof o.tacCode === 'string')).toBe(true);
  });

  it('reports blank risk types and non-numeric rates without failing', async () => {
    const { occupancies, report } = await parseIibWorkbook(await buildIibWorkbook(), META);
    expect(report.occupancy.blankRiskTypes).toEqual([
      expect.objectContaining({ tacCode: '2075', field: 'Terrorism' }),
    ]);
    const tiny = occupancies.find((o) => o.tacCode === '2191');
    expect(tiny).toMatchObject({
      description: 'Tiny sector',
      iibRate: null,
      iibRateNote: 'As per existing rate built in SME Pre UW Product',
      minStfiRate: null,
    });
    const tinyCells = report.occupancy.nonNumericRates.filter((cell) => cell.tacCode === '2191');
    expect(tinyCells.map((cell) => cell.column)).toEqual(['E', 'H', 'I', 'J', 'K', 'L']);
    expect(occupancyWarningCount(report)).toBeGreaterThanOrEqual(7);
  });

  it('keeps the first of duplicate pincodes and skips pincodes that are not six digits', async () => {
    const { pincodes, report } = await parseIibWorkbook(await buildIibWorkbook(), META);
    expect(report.pincode.rowsRead).toBe(8);
    expect(report.pincode.recordsValid).toBe(6);
    expect(report.pincode.duplicates).toEqual([
      { pincode: '207001', keptRow: 5, duplicateRow: 6, identical: true },
    ]);
    expect(report.pincode.skippedRows).toEqual([
      { row: 7, reason: 'Pincode is not six digits', value: '12345' },
    ]);
    expect(pincodes.filter((p) => p.pincode === '207001')).toHaveLength(1);
    expect(report.pincode.nonNumericRates).toEqual([
      expect.objectContaining({ pincode: '600001', column: 'F', value: 'n/a' }),
    ]);
  });

  it('flags suspect state names and pincodes outside the state postal region', async () => {
    const { report } = await parseIibWorkbook(await buildIibWorkbook(), META);
    expect(report.pincode.unrecognisedStates).toEqual([
      { value: 'Mumbai', rows: 1, suggestion: null },
    ]);
    expect(report.pincode.regionMismatches).toEqual([
      expect.objectContaining({ pincode: '100000', state: 'Gujarat', expectedFirstDigits: '3' }),
    ]);
  });

  it('cross-checks pincode EQ rates against the occupancy zone columns', async () => {
    const { report } = await parseIibWorkbook(await buildIibWorkbook(), META);
    expect(report.crossCheck.reference.INDUSTRIAL).toEqual({
      zone1: '0.5',
      zone2: '0.25',
      zone3: '0.1',
      zone4: '0.05',
    });
    // 500001 is zone 4 but carries zone 3 rates; 600001 has a blank non-industrial rate.
    expect(report.crossCheck.pincodesWithMismatch).toBe(2);
    expect(report.crossCheck.mismatchGroups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          zone: 4,
          riskType: 'INDUSTRIAL',
          pincodeRate: '0.1',
          expected: '0.05',
          count: 1,
        }),
        expect.objectContaining({
          zone: 3,
          riskType: 'NON_INDUSTRIAL',
          pincodeRate: null,
          expected: '0.1',
        }),
      ]),
    );
  });

  it('rejects a workbook with a missing sheet or unexpected headers', async () => {
    await expect(
      parseIibWorkbook(await buildIibWorkbook({ omitSheet: 'Pincode' }), META),
    ).rejects.toThrow(ImportStructureError);
    await expect(
      parseIibWorkbook(await buildIibWorkbook({ badZoneHeader: true }), META),
    ).rejects.toThrow(/L2 should be "Zone I"/);
    await expect(parseIibWorkbook(Buffer.from('not a workbook'), META)).rejects.toThrow(
      ImportStructureError,
    );
  });

  it('formats a readable report', async () => {
    const { report } = await parseIibWorkbook(await buildIibWorkbook(), META);
    const text = formatImportReport(report);
    expect(text).toContain('Rows read: 5');
    expect(text).toContain('207001: kept row 5, skipped row 6 (identical)');
    expect(text).toContain('"Mumbai": 1 row');
  });
});

// The client's workbook is not kept in the repository (masters are uploaded in the app). To check
// the parser against it, run: IIB_WORKBOOK=/path/to/IIB_Code_Master.xlsx npm test
const REAL_WORKBOOK = process.env.IIB_WORKBOOK ?? '';

describe.skipIf(!REAL_WORKBOOK || !existsSync(REAL_WORKBOOK))(
  'parseIibWorkbook (client workbook)',
  () => {
    it('reconciles with the known contents and data issues of the client workbook', async () => {
      const { occupancies, pincodes, report } = await parseIibWorkbook(
        readFileSync(REAL_WORKBOOK),
        META,
      );

      expect(occupancies).toHaveLength(299);
      expect(report.occupancy.rateYearLabel).toBe('2019');
      expect(report.occupancy.blankRiskTypes).toEqual([
        expect.objectContaining({ tacCode: '2075', field: 'Terrorism' }),
      ]);
      expect(new Set(report.occupancy.nonNumericRates.map((cell) => cell.tacCode))).toEqual(
        new Set(['2191', '2215']),
      );
      expect(report.occupancy.highlightedRows.map((row) => row.tacCode)).toContain('2229');

      expect(report.pincode.rowsRead).toBe(20_611);
      expect(pincodes).toHaveLength(20_606);
      expect(report.pincode.duplicates.map((d) => d.pincode)).toEqual([
        '207001',
        '302013',
        '400062',
        '686654',
        '742184',
      ]);
      expect(report.pincode.skippedRows).toEqual([]);
      expect(report.pincode.unrecognisedStates.map((s) => s.value)).toContain('Mumbai');
      expect(report.pincode.regionMismatches.map((m) => m.pincode)).toContain('100000');

      const mumbai = pincodes.find((p) => p.pincode === '400001');
      expect(mumbai).toMatchObject({ state: 'Mumbai', eqZone: 3, eqRates: { industrial: '0.1' } });
      expect(report.crossCheck.pincodesWithMismatch).toBe(361);
    });
  },
);
