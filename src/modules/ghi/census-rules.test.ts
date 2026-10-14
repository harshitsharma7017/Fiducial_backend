import type { GhiCensusRowValues } from '../../shared/index.ts';
import { describe, expect, it } from 'vitest';
import {
  ageOn,
  checkCensus,
  parseCensusDate,
  parseCensusRupees,
  parseGender,
  parseRelationship,
  readCensusRow,
  type Candidate,
  type CensusMember,
  type CensusSettings,
} from './census-rules.ts';

const settings = (overrides: Partial<CensusSettings> = {}): CensusSettings => ({
  familyDefinition: { spouse: true, maxChildren: 3, parents: 'EITHER' },
  coverageType: 'FLOATER',
  sumInsuredOptions: ['300000', '500000'],
  ageLimits: {
    employee: { min: 18, max: 65 },
    spouse: { min: 18, max: 65 },
    child: { min: 0, max: 25 },
    parent: { min: null, max: 80 },
  },
  referenceDate: '2026-04-01',
  today: '2026-10-13',
  ...overrides,
});

const row = (values: Partial<GhiCensusRowValues>): GhiCensusRowValues => ({
  employeeId: 'E001',
  name: 'Asha Rao',
  gender: 'F',
  dateOfBirth: '12/05/1990',
  relationship: 'Self',
  dateOfJoining: '01/06/2015',
  sumInsured: '500000',
  ...values,
});

function candidates(rows: GhiCensusRowValues[]): Candidate[] {
  return rows.map((values, index) => {
    const read = readCensusRow(values);
    return {
      key: String(index + 2),
      label: `row ${index + 2}`,
      member: read.member,
      issues: read.issues,
    };
  });
}

function check(rows: GhiCensusRowValues[], existing: CensusMember[] = [], options = settings()) {
  const result = checkCensus(candidates(rows), existing, options);
  return rows.map((_, index) => result.get(String(index + 2)) ?? []);
}

describe('reading census values', () => {
  it('reads Indian, ISO, month-name and Excel serial dates, refusing two-digit years', () => {
    expect(parseCensusDate('12/05/1990')).toEqual({ ok: true, date: '1990-05-12' });
    expect(parseCensusDate('1990-05-12')).toEqual({ ok: true, date: '1990-05-12' });
    expect(parseCensusDate('12-May-1990')).toEqual({ ok: true, date: '1990-05-12' });
    expect(parseCensusDate('1 April 2026')).toEqual({ ok: true, date: '2026-04-01' });
    expect(parseCensusDate('45383')).toEqual({ ok: true, date: '2024-04-01' });
    expect(parseCensusDate('31/02/1990')).toMatchObject({
      ok: false,
      message: 'This date does not exist',
    });
    expect(parseCensusDate('12/05/90')).toMatchObject({ ok: false });
    expect(parseCensusDate('yesterday')).toMatchObject({ ok: false });
  });

  it('reads rupees with Indian grouping and refuses paise or zero', () => {
    expect(parseCensusRupees('5,00,000')).toEqual({ ok: true, value: '500000' });
    expect(parseCensusRupees('₹ 300000.00')).toEqual({ ok: true, value: '300000' });
    expect(parseCensusRupees('300000.50')).toEqual({ ok: false });
    expect(parseCensusRupees('0')).toEqual({ ok: false });
  });

  it('accepts common relationship and gender words', () => {
    expect(parseRelationship('Employee')).toBe('SELF');
    expect(parseRelationship('wife')).toBe('SPOUSE');
    expect(parseRelationship('Daughter')).toBe('CHILD');
    expect(parseRelationship('Mother-in-law')).toBe('MOTHER_IN_LAW');
    expect(parseRelationship('Cousin')).toBeNull();
    expect(parseGender('m')).toBe('MALE');
    expect(parseGender('Unknown')).toBeNull();
  });

  it('works out completed years on the reference date', () => {
    expect(ageOn('1990-05-12', '2026-04-01')).toBe(35);
    expect(ageOn('1990-04-01', '2026-04-01')).toBe(36);
    expect(ageOn('2026-06-01', '2026-04-01')).toBe(0);
  });

  it('names each field that fails', () => {
    const read = readCensusRow(
      row({
        employeeId: '',
        gender: 'X',
        dateOfBirth: '31/02/1990',
        relationship: 'Uncle',
        sumInsured: 'five lakh',
      }),
    );
    expect(read.member).toBeNull();
    expect(read.issues.map((issue) => issue.field)).toEqual([
      'employeeId',
      'gender',
      'relationship',
      'dateOfBirth',
      'sumInsured',
    ]);
  });
});

describe('census rules', () => {
  it('accepts a complete family', () => {
    const issues = check([
      row({}),
      row({
        name: 'Ravi Rao',
        gender: 'M',
        relationship: 'Spouse',
        dateOfBirth: '01/01/1988',
        sumInsured: '',
      }),
      row({
        name: 'Kid One',
        gender: 'M',
        relationship: 'Son',
        dateOfBirth: '01/01/2015',
        sumInsured: '',
      }),
      row({
        name: 'Kid Two',
        gender: 'F',
        relationship: 'Daughter',
        dateOfBirth: '01/01/2017',
        sumInsured: '',
      }),
      row({
        name: 'Kid Three',
        gender: 'F',
        relationship: 'Child',
        dateOfBirth: '01/01/2019',
        sumInsured: '',
      }),
      row({
        name: 'Old Rao',
        gender: 'M',
        relationship: 'Father',
        dateOfBirth: '01/01/1960',
        sumInsured: '',
      }),
      row({
        name: 'Mrs Rao',
        gender: 'F',
        relationship: 'Mother',
        dateOfBirth: '01/01/1962',
        sumInsured: '',
      }),
    ]);
    expect(issues.flat()).toEqual([]);
  });

  it('allows one spouse and at most three children, keeping the first rows', () => {
    const issues = check([
      row({}),
      row({
        name: 'Spouse A',
        gender: 'M',
        relationship: 'Spouse',
        dateOfBirth: '01/01/1988',
        sumInsured: '',
      }),
      row({
        name: 'Spouse B',
        gender: 'M',
        relationship: 'Spouse',
        dateOfBirth: '01/01/1989',
        sumInsured: '',
      }),
      ...['A', 'B', 'C', 'D'].map((name, index) =>
        row({
          name: `Child ${name}`,
          relationship: 'Child',
          dateOfBirth: `01/01/201${index}`,
          sumInsured: '',
        }),
      ),
    ]);
    expect(issues[1]).toEqual([]);
    expect(issues[2]?.[0]?.message).toMatch(
      /already has a spouse that is on row 3: one spouse per employee/,
    );
    expect(issues.slice(3, 6).flat()).toEqual([]);
    expect(issues[6]?.[0]?.message).toMatch(/already has 3 children: at most 3 per employee/);
  });

  it('refuses parents mixed with parents-in-law, and parents the policy does not cover', () => {
    const mixed = check([
      row({}),
      row({
        name: 'Dad',
        gender: 'M',
        relationship: 'Father',
        dateOfBirth: '01/01/1960',
        sumInsured: '',
      }),
      row({
        name: 'MIL',
        gender: 'F',
        relationship: 'Mother-in-law',
        dateOfBirth: '01/01/1961',
        sumInsured: '',
      }),
    ]);
    expect(mixed[2]?.[0]?.message).toMatch(/cover either parents or parents-in-law, not both/);

    const notCovered = check(
      [
        row({}),
        row({
          name: 'Dad',
          gender: 'M',
          relationship: 'Father',
          dateOfBirth: '01/01/1960',
          sumInsured: '',
        }),
      ],
      [],
      settings({ familyDefinition: { spouse: true, maxChildren: 2, parents: 'PARENTS_IN_LAW' } }),
    );
    expect(notCovered[1]?.[0]).toMatchObject({
      field: 'relationship',
      message: expect.stringMatching(/does not cover parents/),
    });
  });

  it('flags duplicates in the file and against the census', () => {
    const existing: CensusMember = {
      employeeId: 'E001',
      employeeKey: 'E001',
      name: 'Asha Rao',
      nameKey: 'asha rao',
      gender: 'FEMALE',
      dateOfBirth: '1990-05-12',
      relationship: 'SELF',
      dateOfJoining: null,
      sumInsured: '500000',
    };
    const [againstCensus] = check([row({})], [existing]);
    expect(againstCensus?.[0]?.message).toMatch(/Duplicate: Asha Rao .* is already in the census/);
    const inFile = check([row({ employeeId: 'E002' }), row({ employeeId: 'e002' })]);
    expect(inFile[1]?.[0]?.message).toMatch(/Duplicate: .* is on row 2/);
  });

  it('needs the employee for every dependant, and points at a failing employee row', () => {
    const orphan = check([
      row({ employeeId: 'E009', name: 'Lone Spouse', relationship: 'Spouse', sumInsured: '' }),
    ]);
    expect(orphan[0]?.[0]).toMatchObject({
      field: 'employeeId',
      message: expect.stringMatching(/No employee \(Self\) row for employee ID E009/),
    });
    const failing = check([
      row({ sumInsured: '700000' }),
      row({
        name: 'Ravi Rao',
        gender: 'M',
        relationship: 'Spouse',
        dateOfBirth: '01/01/1988',
        sumInsured: '',
      }),
    ]);
    expect(failing[0]?.[0]?.field).toBe('sumInsured');
    expect(failing[1]?.[0]?.message).toMatch(/The employee’s own row \(row 2\) has errors/);
  });

  it('checks age limits, future dates and joining before birth', () => {
    const issues = check([
      row({ dateOfBirth: '01/01/1950' }),
      row({ employeeId: 'E002', dateOfBirth: '01/01/2030' }),
      row({ employeeId: 'E003', dateOfJoining: '01/01/1980' }),
      row({
        employeeId: 'E003',
        name: 'Big Kid',
        relationship: 'Child',
        dateOfBirth: '01/01/1995',
        sumInsured: '',
      }),
    ]);
    expect(issues[0]?.[0]?.message).toMatch(/Age 76 is above the maximum of 65/);
    expect(issues[1]?.map((issue) => issue.message)).toContain(
      'The date of birth is in the future',
    );
    expect(issues[2]?.[0]).toMatchObject({
      field: 'dateOfJoining',
      message: 'The date of joining is before the date of birth',
    });
    expect(issues[3]?.[0]?.message).toMatch(/Age 31 is above the maximum of 25 for child members/);
  });

  it('checks sums insured by coverage type and the options offered', () => {
    const floater = check([
      row({}),
      row({
        name: 'Ravi Rao',
        gender: 'M',
        relationship: 'Spouse',
        dateOfBirth: '01/01/1988',
        sumInsured: '300000',
      }),
    ]);
    expect(floater[1]?.[0]?.message).toMatch(
      /Family floater: dependants share the employee’s sum insured/,
    );
    const individual = check(
      [
        row({}),
        row({
          name: 'Ravi Rao',
          gender: 'M',
          relationship: 'Spouse',
          dateOfBirth: '01/01/1988',
          sumInsured: '',
        }),
      ],
      [],
      settings({ coverageType: 'INDIVIDUAL' }),
    );
    expect(individual[1]?.[0]?.message).toBe(
      'Individual cover: enter this member’s own sum insured',
    );
    const notOffered = check([row({ sumInsured: '1000000' })]);
    expect(notOffered[0]?.[0]?.message).toMatch(
      /₹10,00,000 is not offered: use ₹3,00,000, ₹5,00,000/,
    );
  });

  it('refuses a father or mother of the wrong gender', () => {
    const issues = check([
      row({}),
      row({
        name: 'Dad',
        gender: 'F',
        relationship: 'Father',
        dateOfBirth: '01/01/1960',
        sumInsured: '',
      }),
    ]);
    expect(issues[1]?.[0]).toMatchObject({ field: 'gender' });
  });
});
