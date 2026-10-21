import { describe, expect, it } from 'vitest';
import {
  AgeBandSetInputSchema,
  DEFAULT_AGE_BAND_SETS,
  STANDARD_AGE_BANDS,
  ageBandIssues,
  bandIndexOf,
  completedAge,
  type AgeBand,
} from './age-bands.ts';

const option1 = DEFAULT_AGE_BAND_SETS.find((set) => set.seedKey === 'OPTION_1')!.bands;
const custom = DEFAULT_AGE_BAND_SETS.find((set) => set.seedKey === 'CUSTOM_EXAMPLE')!.bands;
const issuesOf = (bands: AgeBand[]) => ageBandIssues({ name: 'Test', bands });

describe('age band sets (N4)', () => {
  it('defines Option 1 as 0–18, 19–25, 26–35, then five-year bands through 86–90', () => {
    expect(option1.map((band) => [band.min, band.max])).toEqual([
      [0, 18],
      [19, 25],
      [26, 35],
      [36, 40],
      [41, 45],
      [46, 50],
      [51, 55],
      [56, 60],
      [61, 65],
      [66, 70],
      [71, 75],
      [76, 80],
      [81, 85],
      [86, 90],
    ]);
    for (const set of DEFAULT_AGE_BAND_SETS) {
      expect(AgeBandSetInputSchema.safeParse({ name: set.name, bands: set.bands }).success).toBe(
        true,
      );
    }
    // Option 2 waits for the client's boundaries (open question AB-1): it is not created.
    expect(DEFAULT_AGE_BAND_SETS.map((set) => set.seedKey)).not.toContain('OPTION_2');
  });

  it('places every boundary age in its own band, and none outside the set', () => {
    for (const [index, band] of option1.entries()) {
      expect(bandIndexOf(band.min, option1)).toBe(index);
      expect(bandIndexOf(band.max!, option1)).toBe(index);
    }
    expect(bandIndexOf(91, option1)).toBeNull();
    expect(bandIndexOf(35, custom)).toBe(0);
    expect(bandIndexOf(36, custom)).toBe(1);
    expect(bandIndexOf(45, custom)).toBe(1);
    expect(bandIndexOf(46, custom)).toBe(2);
    expect(bandIndexOf(50, custom)).toBe(2);
    expect(bandIndexOf(51, custom)).toBeNull();
    expect(bandIndexOf(120, STANDARD_AGE_BANDS)).toBe(5);
  });

  it('refuses gaps, overlaps, wrong order, inverted and invalid ranges, each on its band', () => {
    expect(
      issuesOf([
        { label: '0–18', min: 0, max: 18 },
        { label: '20–25', min: 20, max: 25 },
      ]),
    ).toEqual([
      {
        path: ['bands', 1, 'min'],
        message: 'Band 2 (20–25): ages 19 fall in no band; start it at 19',
      },
    ]);
    expect(
      issuesOf([
        { label: '0–18', min: 0, max: 18 },
        { label: '18–25', min: 18, max: 25 },
      ])[0],
    ).toMatchObject({
      path: ['bands', 1, 'min'],
      message: expect.stringContaining('overlaps band 1'),
    });
    expect(
      issuesOf([
        { label: 'b', min: 19, max: 25 },
        { label: 'a', min: 0, max: 18 },
      ])[0]!.message,
    ).toContain('increasing order');
    expect(issuesOf([{ label: 'x', min: 30, max: 20 }])[0]!.message).toContain('below the first');
    expect(issuesOf([{ label: 'x', min: -1, max: 20 }])[0]!.path).toEqual(['bands', 0, 'min']);
    expect(issuesOf([{ label: 'x', min: 1.5, max: 20 }])[0]!.path).toEqual(['bands', 0, 'min']);
    expect(issuesOf([{ label: 'x', min: 0, max: 121 }])[0]!.path).toEqual(['bands', 0, 'max']);
    expect(
      issuesOf([
        { label: 'x', min: 0, max: null },
        { label: 'y', min: 1, max: 5 },
      ])[0]!.message,
    ).toContain('only the last band');
    expect(
      issuesOf([
        { label: 'Same', min: 0, max: 5 },
        { label: 'same', min: 6, max: 9 },
      ])[0]!.message,
    ).toContain('already has this label');
    expect(issuesOf([])[0]).toEqual({ path: ['bands'], message: 'Give the set 1 to 30 bands' });
    expect(ageBandIssues({ name: ' ', bands: custom })[0]!.path).toEqual(['name']);
  });

  it('works out completed years on the reference date and reports a missing or invalid date', () => {
    expect(completedAge('1990-04-03', '2026-04-02')).toBe(35);
    expect(completedAge('1990-04-03', '2026-04-03')).toBe(36);
    expect(completedAge('2000-02-29', '2026-02-28')).toBe(25);
    expect(completedAge('2026-05-01', '2026-04-01')).toBe(0);
    expect(completedAge(null, '2026-04-01')).toBeNull();
    expect(completedAge('', '2026-04-01')).toBeNull();
    expect(completedAge('1990-02-30', '2026-04-01')).toBeNull();
    expect(completedAge('03/04/1990', '2026-04-01')).toBeNull();
  });
});
