import { describe, expect, it } from 'vitest';
import { ICD10_CHAPTERS, icdChapterOf, primaryIcdCode } from './icd.ts';
import { maskAccount, maskPhone } from './masking.ts';
import {
  TpaFormatInputSchema,
  boardStatusFor,
  changedTpaFields,
  parseTpaAmount,
  parseTpaDate,
  parseTpaRow,
  type TpaFormatRules,
} from './tpa-claims.ts';

const rules: TpaFormatRules = {
  mappings: [
    { field: 'tpaClaimId', required: true },
    { field: 'status', required: true },
    { field: 'employeeId', required: false },
  ],
  statusMap: [
    { source: 'Settled', status: 'SETTLED' },
    { source: 'Registration', status: 'OUTSTANDING' },
    { source: 'For Investigation', status: 'OUTSTANDING' },
    { source: 'Repudiated', status: 'REJECTED' },
  ],
  requestTypeMap: [],
  claimTypeMap: [],
  relationshipMap: [{ source: 'Wife', relationship: 'SPOUSE' }],
};
const base = { tpaClaimId: 'CL-1', status: 'Settled' };

describe('TPA rows (N9)', () => {
  it('reads dates from Excel cells and day-first text, ignoring a time of day', () => {
    expect(parseTpaDate({ date: '2025-01-12' })).toEqual({ ok: true, date: '2025-01-12' });
    expect(parseTpaDate('12/01/2025 10:30')).toEqual({ ok: true, date: '2025-01-12' });
    expect(parseTpaDate('12-Jan-2025 09:15 AM')).toEqual({ ok: true, date: '2025-01-12' });
    expect(parseTpaDate('')).toEqual({ ok: true, date: null });
    expect(parseTpaDate('31/02/2025').ok).toBe(false);
    expect(parseTpaDate('01/13/2025').ok).toBe(false);
  });

  it('reads amounts with paise and refuses negative or malformed ones', () => {
    expect(parseTpaAmount('1,23,456.5')).toEqual({ ok: true, amount: '123456.50' });
    expect(parseTpaAmount('₹ 50000')).toEqual({ ok: true, amount: '50000.00' });
    expect(parseTpaAmount('Rs.2,000.25')).toEqual({ ok: true, amount: '2000.25' });
    expect(parseTpaAmount('')).toEqual({ ok: true, amount: null });
    expect(parseTpaAmount('-500').ok).toBe(false);
    expect(parseTpaAmount('(500)').ok).toBe(false);
    expect(parseTpaAmount('12.345').ok).toBe(false);
    expect(parseTpaAmount('abc').ok).toBe(false);
  });

  it('classifies statuses only by the format’s map and reports an unmapped one', () => {
    expect(parseTpaRow({ ...base, status: 'For Investigation' }, rules).row?.status).toBe(
      'OUTSTANDING',
    );
    expect(parseTpaRow({ ...base, status: ' settled ' }, rules).row?.status).toBe('SETTLED');
    const unknown = parseTpaRow({ ...base, status: 'Closed - Paid' }, rules);
    expect(unknown.row).toBeNull();
    expect(unknown.issues).toEqual([
      expect.objectContaining({
        field: 'status',
        code: 'UNSUPPORTED_STATUS',
        severity: 'ERROR',
        value: 'Closed - Paid',
      }),
    ]);
  });

  it('reports each problem on its field with the row still unread, and never shows a diagnosis or bank account', () => {
    const parsed = parseTpaRow(
      {
        tpaClaimId: '',
        status: 'Settled',
        admissionDate: '05/03/2025',
        dischargeDate: '01/03/2025',
        claimedAmount: '-10',
        requestType: 'Cancellation',
        relationship: 'Cousin',
        icdCode: 'NOT-A-CODE',
        bankAccount: '12',
      },
      rules,
    );
    expect(parsed.row).toBeNull();
    expect(parsed.issues.map((issue) => [issue.field, issue.code])).toEqual([
      ['tpaClaimId', 'REQUIRED'],
      ['dischargeDate', 'DATES'],
      ['claimedAmount', 'AMOUNT'],
      ['requestType', 'UNSUPPORTED_REQUEST_TYPE'],
      ['relationship', 'INVALID_RELATIONSHIP'],
      ['bankAccount', 'INVALID'],
      ['icdCode', 'ICD'],
    ]);
    for (const issue of parsed.issues.filter(
      (item) => item.field === 'icdCode' || item.field === 'bankAccount',
    )) {
      expect(issue.value).toBeNull();
    }
  });

  it('normalises a good row, with the request type defaulting to the main claim', () => {
    const parsed = parseTpaRow(
      {
        ...base,
        employeeId: ' E 101 ',
        relationship: 'wife',
        claimType: 'Cashless',
        settledAmount: '27,336.27',
        icdCode: 'k35.8, K80',
        bankAccount: '1234 5678 9012',
        parentClaimId: '',
      },
      rules,
    );
    expect(parsed.issues).toEqual([]);
    expect(parsed.row).toMatchObject({
      claimKey: 'CL-1',
      requestType: 'MAIN',
      relationship: 'SPOUSE',
      claimType: 'CASHLESS',
      settledAmount: '27336.27',
      icdCode: 'K35.8',
      bankAccount: '123456789012',
      status: 'SETTLED',
      sourceStatus: 'Settled',
    });
    expect(changedTpaFields({ ...parsed.row! }, parsed.row!)).toEqual([]);
    expect(changedTpaFields({ ...parsed.row!, status: 'OUTSTANDING' }, parsed.row!)).toEqual([
      'status',
    ]);
  });

  it('refuses a format without required claim ID and status columns, or with a column mapped twice', () => {
    const format = {
      name: 'Medi Assist',
      tpaCode: 'MEDI',
      mappings: [
        { field: 'tpaClaimId', header: 'Claim No', required: true },
        { field: 'status', header: 'Claim Status', required: true },
      ],
      statusMap: [{ source: 'Settled', status: 'SETTLED' }],
    };
    expect(TpaFormatInputSchema.safeParse(format).success).toBe(true);
    const noStatus = TpaFormatInputSchema.safeParse({ ...format, mappings: [format.mappings[0]] });
    expect(noStatus.error?.issues[0]?.message).toContain('Claim status');
    const twice = TpaFormatInputSchema.safeParse({
      ...format,
      mappings: [...format.mappings, { field: 'employeeId', header: 'claim no', required: false }],
    });
    expect(twice.error?.issues[0]?.path).toEqual(['mappings', 2, 'header']);
    const sameStatus = TpaFormatInputSchema.safeParse({
      ...format,
      statusMap: [
        { source: 'Settled', status: 'SETTLED' },
        { source: 'SETTLED ', status: 'REJECTED' },
      ],
    });
    expect(sameStatus.success).toBe(false);
  });
});

describe('board status mapping (N11)', () => {
  const map = {
    boardStatusMap: [
      { source: 'Registration', boardStatus: 'SUBMITTED' as const },
      { source: 'For Investigation', boardStatus: 'INVESTIGATION' as const },
      { source: 'Settled', boardStatus: 'APPROVED' as const },
    ],
    boardStatusOverrides: [
      { clientId: 'c1', source: 'Settled', boardStatus: 'INVESTIGATION' as const },
    ],
  };
  it('maps each configured status, a company override first, and leaves an unknown one unmapped', () => {
    expect(boardStatusFor(map, 'c2', 'registration')).toBe('SUBMITTED');
    expect(boardStatusFor(map, 'c2', 'For  Investigation')).toBe('INVESTIGATION');
    expect(boardStatusFor(map, 'c2', 'Settled')).toBe('APPROVED');
    expect(boardStatusFor(map, 'c1', 'Settled')).toBe('INVESTIGATION');
    expect(boardStatusFor(map, 'c2', 'Query Raised')).toBeNull();
  });
});

describe('ICD chapters (N10 E)', () => {
  it('places every chapter boundary in its chapter and leaves invalid codes unclassified', () => {
    for (const chapter of ICD10_CHAPTERS) {
      expect(icdChapterOf(chapter.from)?.key).toBe(chapter.key);
      expect(icdChapterOf(`${chapter.to}.9`)?.key).toBe(chapter.key);
    }
    expect(icdChapterOf('D48')?.key).toBe('II');
    expect(icdChapterOf('D50')?.key).toBe('III');
    expect(icdChapterOf('H59.1')?.key).toBe('VII');
    expect(icdChapterOf('H60')?.key).toBe('VIII');
    expect(icdChapterOf('U07.1')?.key).toBe('XXII');
    expect(icdChapterOf('k358')?.key).toBe('XI');
    expect(icdChapterOf('1A00')).toBeNull(); // ICD-11
    expect(icdChapterOf('')).toBeNull();
    expect(icdChapterOf(null)).toBeNull();
    expect(icdChapterOf('Fever')).toBeNull();
    expect(primaryIcdCode('I21.0; E11')).toBe('I21.0');
  });
});

describe('masking (N12)', () => {
  it('shows only the end of a bank account or phone number', () => {
    expect(maskAccount('123456789012')).toBe('XXXXXXXX9012');
    expect(maskAccount('1234 5678 90')).toBe('XXXXXX7890');
    expect(maskAccount('123456')).toBe('XXXX56');
    expect(maskAccount('1234')).toBe('XXXX');
    expect(maskAccount(null)).toBeNull();
    expect(maskPhone('+91 98765 43210')).toBe('XXXXXXXX3210');
  });
});
