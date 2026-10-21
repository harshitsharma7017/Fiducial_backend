import { describe, expect, it } from 'vitest';
import { PLAN_RELATIONSHIPS } from './eb-plan.ts';
import {
  DEFAULT_FAMILY_PLANS,
  PlanVersionInputSchema,
  mixingText,
  overlaps,
  planAcceptsParents,
  planHasDependants,
  templateNameOf,
  versionOn,
  type PlanVersionLike,
} from './family-plans.ts';
import { GHI_RELATIONSHIPS } from './ghi-census.ts';

const valid = {
  effectiveFrom: '2026-04-01',
  effectiveTo: null,
  parentsAndInLawsMixed: false,
  slots: [
    { name: 'Self', min: 1, max: 1, relationships: [{ relationship: 'SELF', max: 1 }] },
    { name: 'Spouse', min: 0, max: 1, relationships: [{ relationship: 'SPOUSE', max: 1 }] },
    { name: 'Children', min: 0, max: 3, relationships: [{ relationship: 'CHILD', max: 3 }] },
  ],
};

function issuesOf(input: unknown) {
  const parsed = PlanVersionInputSchema.safeParse(input);
  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

describe('plan version rules (Requirement 13)', () => {
  it('accepts a valid version and the seven default plans', () => {
    expect(issuesOf(valid)).toEqual([]);
    expect(DEFAULT_FAMILY_PLANS).toHaveLength(7);
    for (const plan of DEFAULT_FAMILY_PLANS) expect(issuesOf(plan.version)).toEqual([]);
  });

  it('keeps the plan relationships equal to the census relationships', () => {
    expect([...PLAN_RELATIONSHIPS]).toEqual([...GHI_RELATIONSHIPS]);
  });

  it('refuses fewer than 1 or more than 7 slots (13.2)', () => {
    expect(issuesOf({ ...valid, slots: [] })).toContainEqual({
      path: 'slots',
      message: 'Give the version 1 to 7 slots',
    });
    const many = Array.from({ length: 8 }, (_, index) =>
      index === 0
        ? valid.slots[0]
        : { name: `S${index}`, min: 0, max: 1, relationships: [{ relationship: 'CHILD', max: 1 }] },
    );
    expect(issuesOf({ ...valid, slots: many }).map((issue) => issue.path)).toContain('slots');
  });

  it('refuses a blank, long or repeated slot name and an unknown or missing relationship (13.2)', () => {
    const issues = issuesOf({
      ...valid,
      slots: [
        valid.slots[0],
        { name: '  ', min: 0, max: 1, relationships: [{ relationship: 'SPOUSE', max: 1 }] },
        {
          name: 'x'.repeat(51),
          min: 0,
          max: 1,
          relationships: [{ relationship: 'COUSIN', max: 1 }],
        },
        { name: 'SELF', min: 0, max: 1, relationships: [] },
      ],
    });
    const paths = issues.map((issue) => issue.path);
    expect(paths).toContain('slots.1.name');
    expect(paths).toContain('slots.2.name');
    expect(paths).toContain('slots.2.relationships.0.relationship');
    expect(paths).toContain('slots.3.name');
    expect(paths).toContain('slots.3.relationships');
    expect(issues.find((issue) => issue.path === 'slots.3.name')?.message).toMatch(
      /Slot 4 \(SELF\)/,
    );
  });

  it('needs exactly one Self slot holding only Self with 1 to 1 (13.3)', () => {
    expect(issuesOf({ ...valid, slots: valid.slots.slice(1) })).toContainEqual({
      path: 'slots',
      message: 'Add a slot for the employee (Self) with a minimum and maximum of 1',
    });
    const mixed = issuesOf({
      ...valid,
      slots: [
        {
          name: 'Self',
          min: 0,
          max: 2,
          relationships: [
            { relationship: 'SELF', max: 1 },
            { relationship: 'SPOUSE', max: 1 },
          ],
        },
      ],
    });
    expect(mixed.map((issue) => issue.path)).toEqual(
      expect.arrayContaining(['slots.0.relationships', 'slots.0.min']),
    );
  });

  it('refuses a relationship in two slots, naming both (13.4)', () => {
    const issues = issuesOf({
      ...valid,
      slots: [
        ...valid.slots,
        { name: 'Kids', min: 0, max: 2, relationships: [{ relationship: 'CHILD', max: 2 }] },
      ],
    });
    expect(issues).toContainEqual({
      path: 'slots.3.relationships.0.relationship',
      message:
        'Slot 4 (Kids): Child is already in Slot 3 (Children); a relationship belongs to one slot',
    });
  });

  it('refuses minimums and maximums out of bounds or crossed (13.5)', () => {
    const issues = issuesOf({
      ...valid,
      slots: [
        valid.slots[0],
        { name: 'Children', min: 11, max: 0, relationships: [{ relationship: 'CHILD', max: 1 }] },
        { name: 'Spouse', min: 1.5, max: 1, relationships: [{ relationship: 'SPOUSE', max: 1 }] },
        { name: 'Parents', min: 2, max: 1, relationships: [{ relationship: 'FATHER', max: 1 }] },
      ],
    });
    const paths = issues.map((issue) => issue.path);
    expect(paths).toEqual(
      expect.arrayContaining(['slots.1.min', 'slots.1.max', 'slots.2.min', 'slots.3.min']),
    );
  });

  it('refuses relationship maximums out of bounds, a minimum above their sum, and more than one of a single relationship (13.6)', () => {
    const issues = issuesOf({
      ...valid,
      slots: [
        valid.slots[0],
        { name: 'Spouse', min: 0, max: 2, relationships: [{ relationship: 'SPOUSE', max: 2 }] },
        { name: 'Children', min: 0, max: 3, relationships: [{ relationship: 'CHILD', max: 4 }] },
        {
          name: 'Parents',
          min: 3,
          max: 4,
          relationships: [
            { relationship: 'FATHER', max: 1 },
            { relationship: 'MOTHER', max: 1 },
          ],
        },
        { name: 'In-laws', min: 0, max: 1, relationships: [{ relationship: 'FATHER_IN_LAW' }] },
      ],
    });
    expect(issues).toContainEqual({
      path: 'slots.1.relationships.0.max',
      message: 'Slot 2 (Spouse), Spouse: at most 1 per family',
    });
    expect(issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        'slots.2.relationships.0.max',
        'slots.3.min',
        'slots.4.relationships.0.max',
      ]),
    );
  });

  it('needs the mixing setting stated, with no default (13.7)', () => {
    const { parentsAndInLawsMixed: _omitted, ...rest } = valid;
    expect(issuesOf(rest)).toContainEqual({
      path: 'parentsAndInLawsMixed',
      message: 'State whether parents and parents-in-law may be in one family (Yes or No)',
    });
    expect(issuesOf({ ...valid, parentsAndInLawsMixed: null }).map((i) => i.path)).toEqual([
      'parentsAndInLawsMixed',
    ]);
  });

  it('reports every failing field at once (13.9) and checks the dates (12.2)', () => {
    const issues = issuesOf({
      effectiveFrom: '2026-02-30',
      effectiveTo: 'not a date',
      slots: [{ name: '', min: 5, max: 1, relationships: [] }],
    });
    expect(issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        'effectiveFrom',
        'parentsAndInLawsMixed',
        'slots.0.name',
        'slots.0.min',
        'slots.0.relationships',
        'slots',
      ]),
    );
    expect(issuesOf({ ...valid, effectiveTo: '2026-03-31' })).toEqual([
      { path: 'effectiveTo', message: 'The end date must be on or after the start date' },
    ]);
  });
});

describe('versions and dates', () => {
  const plan: { versions: PlanVersionLike[] } = {
    versions: [
      { number: 1, status: 'ACTIVE', effectiveFrom: '2000-01-01', effectiveTo: '2026-03-31' },
      { number: 2, status: 'ACTIVE', effectiveFrom: '2026-04-01', effectiveTo: null },
      { number: 3, status: 'DRAFT', effectiveFrom: '2027-01-01', effectiveTo: null },
    ],
  };

  it('picks the Active version in effect on a day, never a Draft', () => {
    expect(versionOn(plan, '2026-03-31')?.number).toBe(1);
    expect(versionOn(plan, '2026-04-01')?.number).toBe(2);
    expect(versionOn(plan, '2027-06-01')?.number).toBe(2);
    expect(versionOn(plan, '1999-12-31')).toBeNull();
  });

  it('finds overlaps by shared days, a blank end being open', () => {
    expect(
      overlaps(
        { effectiveFrom: '2026-01-01', effectiveTo: '2026-03-31' },
        { effectiveFrom: '2026-03-31', effectiveTo: null },
      ),
    ).toBe(true);
    expect(
      overlaps(
        { effectiveFrom: '2026-01-01', effectiveTo: '2026-03-30' },
        { effectiveFrom: '2026-03-31', effectiveTo: null },
      ),
    ).toBe(false);
    expect(
      overlaps(
        { effectiveFrom: '2026-01-01', effectiveTo: null },
        { effectiveFrom: '2020-01-01', effectiveTo: null },
      ),
    ).toBe(true);
  });
});

describe('default plans (Requirement 14.2)', () => {
  const plan = (product: string, code: string) =>
    DEFAULT_FAMILY_PLANS.find((item) => item.product === product && item.code === code)!;

  it('has the requested slots, with three children on 1+3 and mixing allowed on 1+5 and 1+7', () => {
    expect(plan('GMC', '1+3').version.slots.find((slot) => slot.name === 'Children')?.max).toBe(3);
    expect(plan('GPA', '1+3').version.slots.find((slot) => slot.name === 'Children')?.max).toBe(3);
    expect(plan('GMC', '1+5').version.slots.find((slot) => slot.name === 'Parents')?.max).toBe(2);
    expect(plan('GMC', '1+7').version.slots.find((slot) => slot.name === 'Parents')?.max).toBe(4);
    expect(plan('GMC', '1+5').version.parentsAndInLawsMixed).toBe(true);
    expect(planAcceptsParents(plan('GMC', '1+3').version.slots)).toBe(false);
    expect(mixingText(plan('GMC', '1+3').version)).toBe('Not applicable (no parent slot)');
    expect(planHasDependants(plan('GTLI', 'SELF').version.slots)).toBe(false);
    expect(plan('GTLI', 'SELF').openQuestions).toEqual([6, 16]);
  });

  it('names the seven templates', () => {
    expect(DEFAULT_FAMILY_PLANS.map(templateNameOf)).toEqual([
      'GMC Self',
      'GMC 1+3',
      'GMC 1+5',
      'GMC 1+7',
      'GPA Self Only',
      'GPA 1+3',
      'GTLI',
    ]);
    expect(templateNameOf({ product: 'GPA', code: 'X1' })).toBe('GPA X1');
  });
});
