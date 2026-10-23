import {
  AgeBandSetSchema,
  EbCaseRecordSchema,
  EbMemberListResponseSchema,
  GhiRfqStateSchema,
  RfqSelectionSummaryResponseSchema,
  emptyGhiRequirements,
  type LegacyRole as Role,
} from '../src/shared/index.ts';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensureDefaultAgeBandSets } from '../src/modules/age-bands/age-bands.service.ts';
import { AgeBandSetModel } from '../src/modules/age-bands/age-band-set.model.ts';
import { AuditLogModel } from '../src/modules/audit/audit.model.ts';
import { FamilyPlanModel } from '../src/modules/family-plans/family-plan.model.ts';
import { GhiMemberModel } from '../src/modules/ghi/ghi-census.model.ts';
import { bearer, createTestApp, useTestDatabase } from './helpers/app.ts';
import {
  ROLE_LIST,
  binary,
  createEbCase,
  ebPath,
  gpaSheet,
  gtliSheet,
  readWorkbook,
  setUpWorld,
  type EbWorld,
} from './helpers/eb.ts';

// N4 to N7 through the API: the Age Band Master and its permissions, a case's copy of a set,
// GPA cover by relationship and nominees, GTLI sums assured from the monthly salary, and the
// RFQ Selection Summary for GMC, GPA and GTLI, kept unchanged on each RFQ version.

useTestDatabase();
const app = createTestApp();
let world: EbWorld;
const setIds: Record<string, string> = {};
const AGES = '/api/v1/age-bands';

beforeAll(async () => {
  world = await setUpWorld(app);
  await ensureDefaultAgeBandSets();
  for (const set of await AgeBandSetModel.find().lean()) {
    if (set.seedKey) setIds[set.seedKey] = set._id.toHexString();
  }
});

const planIdOf = async (product: 'GMC' | 'GPA' | 'GTLI', code: string) =>
  (await FamilyPlanModel.findOne({ product, code }).lean())!._id.toHexString();

async function gpaCase() {
  const created = await createEbCase(app, world.manager, 'GPA', world.clientId);
  const path = (rest = '') => ebPath('GPA', created.id, rest);
  await request(app)
    .put(path('/plan'))
    .set(bearer(world.manager))
    .send({ planId: await planIdOf('GPA', '1+3') })
    .expect(200);
  return { id: created.id, path };
}

const nominee = {
  name: 'Meera Nair',
  relationship: 'SPOUSE',
  dateOfBirth: '1988-06-01',
  age: null,
};
const memberBody = (overrides: Record<string, unknown>) => ({
  employeeId: 'E1',
  name: 'Ravi Nair',
  gender: 'MALE',
  dateOfBirth: '1985-06-01',
  relationship: 'SELF',
  dateOfJoining: null,
  sumInsured: null,
  annualSalary: null,
  monthlySalary: null,
  nominee: null,
  ...overrides,
});

describe('Age Band Master (N4)', () => {
  const option2 = {
    name: 'Option 2 (as the client defines it)',
    description: null,
    bands: [
      { label: '0–35', min: 0, max: 35 },
      { label: '36–60', min: 36, max: 60 },
      { label: '61–90', min: 61, max: 90 },
    ],
  };

  it('creates the default sets once, and lets every role read them', async () => {
    expect((await ensureDefaultAgeBandSets()).created).toEqual([]);
    // N10 adds the claims analysis set (0–10 to Above 70).
    expect(Object.keys(setIds).sort()).toEqual([
      'CLAIMS_ANALYSIS',
      'CUSTOM_EXAMPLE',
      'OPTION_1',
      'STANDARD',
    ]);
    for (const role of ROLE_LIST) {
      const list = await request(app).get(AGES).set(bearer(world.tokens[role])).expect(200);
      expect(list.body.items.length).toBeGreaterThanOrEqual(3);
    }
    await request(app).get(AGES).expect(401);
    await request(app)
      .get(`${AGES}/${'f'.repeat(24)}`)
      .set(bearer(world.readOnly))
      .expect(404);
  });

  it('lets only masters.manage change sets, refusing invalid bands with nothing written', async () => {
    for (const role of ['MANAGER', 'ACCOUNT_MANAGER', 'PLACEMENT_EXEC', 'READ_ONLY'] as Role[]) {
      await request(app).post(AGES).set(bearer(world.tokens[role])).send(option2).expect(403);
    }
    const before = await AgeBandSetModel.countDocuments();
    const gap = await request(app)
      .post(AGES)
      .set(bearer(world.admin))
      .send({ ...option2, bands: [option2.bands[0], { label: '40–60', min: 40, max: 60 }] })
      .expect(400);
    expect(gap.body.details).toEqual([
      expect.objectContaining({
        path: 'bands.1.min',
        message: expect.stringContaining('fall in no band'),
      }),
    ]);
    const overlap = await request(app)
      .post(AGES)
      .set(bearer(world.admin))
      .send({ ...option2, bands: [option2.bands[0], { label: '30–60', min: 30, max: 60 }] })
      .expect(400);
    expect(overlap.body.details[0].message).toContain('overlaps band 1');
    expect(await AgeBandSetModel.countDocuments()).toBe(before);

    const created = AgeBandSetSchema.parse(
      (await request(app).post(AGES).set(bearer(world.admin)).send(option2).expect(201)).body,
    );
    expect(created).toMatchObject({ revision: 1, active: true, seeded: false });
    setIds.OPTION_2 = created.id;
    const duplicate = await request(app)
      .post(AGES)
      .set(bearer(world.admin))
      .send(option2)
      .expect(409);
    expect(duplicate.body.code).toBe('AGE_BAND_SET_NAME_TAKEN');
    expect(
      await AuditLogModel.countDocuments({ action: 'AGE_BAND_SET_CREATED', entityId: created.id }),
    ).toBe(1);
  });
});

describe('a case’s age bands and the selection summary (N4, N7)', () => {
  let gpa: Awaited<ReturnType<typeof gpaCase>>;

  beforeAll(async () => {
    gpa = await gpaCase();
    await request(app)
      .put(gpa.path('/requirements'))
      .set(bearer(world.manager))
      .send(
        gpaSheet({
          sumInsuredBasis: { kind: 'FLAT', amount: '1000000' },
          dependantBasis: {
            kind: 'BY_RELATIONSHIP',
            rules: [
              { relationship: 'SPOUSE', kind: 'PERCENT_OF_EMPLOYEE', percent: '50' },
              { relationship: 'CHILD', kind: 'FIXED_AMOUNT', amount: '50000' },
            ],
          },
          nominees: 'EMPLOYEE_ROWS',
        }),
      )
      .expect(200);
  });

  it('requires the employee’s nominee, then works out each member’s cover by relationship', async () => {
    const missing = await request(app)
      .post(gpa.path('/members'))
      .set(bearer(world.manager))
      .send(memberBody({ sumInsured: '1000000' }))
      .expect(400);
    expect(missing.body.details[0]).toMatchObject({
      path: 'nomineeName',
      code: 'NOMINEE_REQUIRED',
    });
    expect(await GhiMemberModel.countDocuments({ caseId: gpa.id })).toBe(0);
    await request(app)
      .post(gpa.path('/members'))
      .set(bearer(world.manager))
      .send(memberBody({ sumInsured: '1000000', nominee }))
      .expect(201);
    await request(app)
      .post(gpa.path('/members'))
      .set(bearer(world.manager))
      .send(
        memberBody({
          name: 'Meera Nair',
          gender: 'FEMALE',
          dateOfBirth: '1988-06-01',
          relationship: 'SPOUSE',
        }),
      )
      .expect(201);
    await request(app)
      .post(gpa.path('/members'))
      .set(bearer(world.manager))
      .send(
        memberBody({
          name: 'Asha Nair',
          gender: 'FEMALE',
          dateOfBirth: '2015-06-01',
          relationship: 'CHILD',
        }),
      )
      .expect(201);
    const wrong = await request(app)
      .post(gpa.path('/members'))
      .set(bearer(world.manager))
      .send(
        memberBody({
          name: 'Anil Nair',
          dateOfBirth: '2016-06-01',
          relationship: 'CHILD',
          sumInsured: '100000',
        }),
      )
      .expect(400);
    expect(wrong.body.details[0].message).toContain('fixed ₹50,000');
    const outside = await request(app)
      .post(gpa.path('/members'))
      .set(bearer(world.manager))
      .send(memberBody({ name: 'Gopal Nair', dateOfBirth: '1950-01-01', relationship: 'FATHER' }))
      .expect(400);
    expect(outside.body.details[0].code).toBe('RELATIONSHIP_NOT_COVERED');

    const members = EbMemberListResponseSchema.parse(
      (await request(app).get(gpa.path('/members')).set(bearer(world.readOnly)).expect(200)).body,
    ).items;
    expect(
      members.map((item) => [item.relationship, item.coveredSumInsured, item.coverageBasis]),
    ).toEqual([
      ['SELF', '1000000', 'Flat sum insured'],
      ['SPOUSE', '500000', '50% of the employee’s ₹10,00,000'],
      ['CHILD', '50000', 'Fixed ₹50,000 for a child'],
    ]);
    expect(members[0]!.nominee).toEqual(nominee);
  });

  it('summarises the census by the standard bands until a set is chosen, then by its copy', async () => {
    const before = RfqSelectionSummaryResponseSchema.parse(
      (
        await request(app)
          .get(gpa.path('/rfq/selection-summary'))
          .set(bearer(world.readOnly))
          .expect(200)
      ).body,
    );
    expect(before.header.ageBands).toEqual({ name: 'Standard (0–18 to 66+)', revision: null });
    expect(before.summary.coverage).toMatchObject({ employees: 1, lives: 3, total: '1550000' });

    await request(app)
      .put(gpa.path('/age-bands'))
      .set(bearer(world.readOnly))
      .send({ setId: setIds.CUSTOM_EXAMPLE })
      .expect(403);
    await request(app)
      .put(ebPath('GTLI', gpa.id, '/age-bands'))
      .set(bearer(world.manager))
      .send({ setId: setIds.CUSTOM_EXAMPLE })
      .expect(404);
    const record = EbCaseRecordSchema.parse(
      (
        await request(app)
          .put(gpa.path('/age-bands'))
          .set(bearer(world.manager))
          .send({ setId: setIds.CUSTOM_EXAMPLE })
          .expect(200)
      ).body,
    );
    expect(record.ageBands).toMatchObject({ name: 'Example: 0–35, 36–45, 46–50', revision: 1 });

    const census = (await request(app).get(gpa.path('/census/summary')).set(bearer(world.readOnly)))
      .body;
    expect(census.byAgeBand).toEqual([
      { band: '0-35', label: '0–35', lives: 1 },
      { band: '36-45', label: '36–45', lives: 2 },
      { band: '46-50', label: '46–50', lives: 0 },
    ]);
    expect(census).toMatchObject({ outsideAgeBands: 0, ageUnknown: 0 });

    const summary = RfqSelectionSummaryResponseSchema.parse(
      (await request(app).get(gpa.path('/rfq/selection-summary')).set(bearer(world.readOnly))).body,
    );
    // Ages on the policy start (01/12/2026): 41, 38 and 11.
    expect(
      summary.summary.matrix.rows.map((row) => [row.label, row.lives, row.totalCover]),
    ).toEqual([
      ['0–35', [1, 0, 0], '50000'],
      ['36–45', [0, 1, 1], '1500000'],
      ['46–50', [0, 0, 0], '0'],
    ]);
    expect(summary.summary.relationships).toMatchObject({ SELF: 1, SPOUSE: 1, CHILD: 1 });
    expect(summary.header.rules).toEqual(
      expect.arrayContaining([
        { label: 'Spouse’s sum insured', value: '50% of the employee’s sum insured' },
        { label: 'Child’s sum insured', value: '₹50,000 each' },
      ]),
    );

    // Editing the master leaves the case's copy as it was (N4.8).
    const custom = (
      await request(app).get(`${AGES}/${setIds.CUSTOM_EXAMPLE}`).set(bearer(world.admin))
    ).body;
    await request(app)
      .put(`${AGES}/${setIds.CUSTOM_EXAMPLE}`)
      .set(bearer(world.admin))
      .send({
        name: custom.name,
        description: custom.description,
        bands: [...custom.bands, { label: '51–60', min: 51, max: 60 }],
      })
      .expect(200);
    const after = EbCaseRecordSchema.parse(
      (await request(app).get(gpa.path()).set(bearer(world.readOnly))).body,
    );
    expect(after.ageBands).toMatchObject({ revision: 1 });
    expect(after.ageBands!.bands).toHaveLength(3);
  });

  it('downloads the summary as Excel and PDF with the census’s figures, audited', async () => {
    await request(app)
      .get(gpa.path('/rfq/selection-summary/document?format=xlsx'))
      .set(bearer(world.readOnly))
      .expect(403);
    const xlsx = await binary(
      request(app)
        .get(gpa.path('/rfq/selection-summary/document?format=xlsx'))
        .set(bearer(world.manager)),
    ).expect(200);
    const workbook = await readWorkbook(xlsx.body as Buffer);
    const sheet = workbook.getWorksheet('RFQ Selection Summary')!;
    const cells: string[] = [];
    sheet.eachRow((row) => row.eachCell((cell) => cells.push(cell.text)));
    expect(cells).toEqual(
      expect.arrayContaining([
        'Total',
        '1',
        '3',
        '1550000',
        'Example: 0–35, 36–45, 46–50 (revision 1)',
      ]),
    );
    const pdf = await binary(
      request(app)
        .get(gpa.path('/rfq/selection-summary/document?format=pdf'))
        .set(bearer(world.manager)),
    ).expect(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    expect(
      await AuditLogModel.countDocuments({
        action: 'EB_SELECTION_SUMMARY_DOWNLOADED',
        entityId: gpa.id,
      }),
    ).toBe(2);
  });

  it('keeps the bands and summary on the RFQ version, and refuses members outside the bands', async () => {
    const generated = GhiRfqStateSchema.parse(
      (await request(app).post(gpa.path('/rfq/generate')).set(bearer(world.manager)).expect(201))
        .body,
    );
    expect(generated.current).toMatchObject({
      version: 1,
      stale: false,
      ageBands: { name: 'Example: 0–35, 36–45, 46–50', revision: 1 },
      hasSelectionSummary: true,
    });
    const rfqId = generated.current!.id;
    const preview = (await request(app).get(gpa.path('/rfq/preview')).set(bearer(world.readOnly)))
      .body;
    expect(preview.sheets.map((item: { name: string }) => item.name)).toContain(
      'RFQ Selection Summary',
    );

    // Another set makes the version out of date; the version keeps what it was made with.
    await request(app)
      .put(gpa.path('/age-bands'))
      .set(bearer(world.manager))
      .send({ setId: setIds.OPTION_1 })
      .expect(200);
    const state = GhiRfqStateSchema.parse(
      (await request(app).get(gpa.path('/rfq')).set(bearer(world.readOnly))).body,
    );
    expect(state.current).toMatchObject({ stale: true });
    const stored = RfqSelectionSummaryResponseSchema.parse(
      (
        await request(app)
          .get(gpa.path(`/rfq/versions/${rfqId}/selection-summary`))
          .set(bearer(world.readOnly))
          .expect(200)
      ).body,
    );
    expect(stored).toMatchObject({ source: 'RFQ_VERSION', rfqVersion: 1 });
    expect(stored.summary.bands.map((band) => band.label)).toEqual(['0–35', '36–45', '46–50']);
    await request(app)
      .get(ebPath('GPA', gpa.id, `/rfq/versions/${'a'.repeat(24)}/selection-summary`))
      .set(bearer(world.readOnly))
      .expect(404);

    // A member older than the custom example's last band: the summary says so, no misleading totals.
    await request(app)
      .put(gpa.path('/age-bands'))
      .set(bearer(world.manager))
      .send({ setId: setIds.CUSTOM_EXAMPLE })
      .expect(200);
    await request(app)
      .post(gpa.path('/members'))
      .set(bearer(world.manager))
      .send(
        memberBody({
          employeeId: 'E2',
          name: 'Old Timer',
          dateOfBirth: '1960-01-01',
          sumInsured: '1000000',
          nominee,
        }),
      )
      .expect(201);
    const incomplete = RfqSelectionSummaryResponseSchema.parse(
      (await request(app).get(gpa.path('/rfq/selection-summary')).set(bearer(world.readOnly))).body,
    );
    expect(incomplete.summary.problems.map((problem) => problem.code)).toEqual(['OUTSIDE_BANDS']);
    const refused = await request(app)
      .get(gpa.path('/rfq/selection-summary/document?format=xlsx'))
      .set(bearer(world.manager))
      .expect(409);
    expect(refused.body.code).toBe('EB_SUMMARY_INCOMPLETE');
    const blocked = await request(app)
      .post(gpa.path('/rfq/generate'))
      .set(bearer(world.manager))
      .expect(409);
    expect(blocked.body.message).toContain('outside the age bands');
  });
});

describe('GTLI sum assured from the monthly salary (N6)', () => {
  it('works out ₹24,00,000 from ₹50,000 a month at 4 ×, recalculates on a new multiplier, and keeps it after reload', async () => {
    const created = await createEbCase(app, world.manager, 'GTLI', world.clientId);
    const path = (rest = '') => ebPath('GTLI', created.id, rest);
    const record = EbCaseRecordSchema.parse(
      (await request(app).get(path()).set(bearer(world.readOnly))).body,
    );
    expect(record.plan?.code).toBe('SELF');
    expect(record.requirements).toMatchObject({ nominees: 'EMPLOYEE_ROWS' });
    const sheet = (multiplier: string, maximum: string | null) =>
      gtliSheet({
        sumInsuredBasis: { kind: 'SALARY_MULTIPLE', multiplier, maximum, salaryInput: 'MONTHLY' },
        nominees: 'EMPLOYEE_ROWS',
      });
    await request(app)
      .put(path('/requirements'))
      .set(bearer(world.manager))
      .send(sheet('4', null))
      .expect(200);
    for (const monthlySalary of ['-50000', '0', 'abc']) {
      await request(app)
        .post(path('/members'))
        .set(bearer(world.manager))
        .send(memberBody({ monthlySalary, nominee }))
        .expect(400);
    }
    const noSalary = await request(app)
      .post(path('/members'))
      .set(bearer(world.manager))
      .send(memberBody({ nominee }))
      .expect(400);
    expect(noSalary.body.details[0].path).toBe('monthlySalary');
    const noNominee = await request(app)
      .post(path('/members'))
      .set(bearer(world.manager))
      .send(memberBody({ monthlySalary: '50000' }))
      .expect(400);
    expect(noNominee.body.details[0].path).toBe('nomineeName');
    await request(app)
      .post(path('/members'))
      .set(bearer(world.manager))
      .send(
        memberBody({ monthlySalary: '50000', nominee: { ...nominee, dateOfBirth: null, age: 38 } }),
      )
      .expect(201);
    const read = async () =>
      EbMemberListResponseSchema.parse(
        (await request(app).get(path('/members')).set(bearer(world.readOnly))).body,
      ).items[0]!;
    expect(await read()).toMatchObject({
      monthlySalary: '50000',
      coveredSumInsured: '2400000',
      coverageBasis: '₹50,000 a month × 12 = ₹6,00,000 annual CTC × 4 = ₹24,00,000',
      nominee: { name: 'Meera Nair', age: 38 },
    });
    await request(app)
      .put(path('/requirements'))
      .set(bearer(world.manager))
      .send(sheet('4', '2000000'))
      .expect(200);
    expect((await read()).coveredSumInsured).toBe('2000000');
    await request(app)
      .put(path('/requirements'))
      .set(bearer(world.manager))
      .send(sheet('3', null))
      .expect(200);
    expect((await read()).coveredSumInsured).toBe('1800000');
    const summary = RfqSelectionSummaryResponseSchema.parse(
      (await request(app).get(path('/rfq/selection-summary')).set(bearer(world.readOnly))).body,
    );
    expect(summary.summary).toMatchObject({
      measure: 'SUM_ASSURED',
      coverage: { total: '1800000' },
    });
    expect(summary.header.rules[0]).toEqual({
      label: 'Sum assured',
      value: '3 × annual CTC (monthly salary × 12)',
    });
  });
});

describe('GMC selection summary (N7)', () => {
  it('counts a floater family’s sum insured once, by the standard bands', async () => {
    const created = await createEbCase(app, world.manager, 'GMC', world.clientId);
    const path = (rest = '') => `/api/v1/ghi/cases/${created.id}${rest}`;
    await request(app)
      .put(path('/requirements'))
      .set(bearer(world.manager))
      .send({
        ...emptyGhiRequirements(),
        employeeCount: 1,
        familyDefinition: { spouse: true, maxChildren: 2, parents: 'NONE' },
        coverageType: 'FLOATER',
        sumInsuredOptions: ['300000'],
      })
      .expect(200);
    const add = (body: Record<string, unknown>) =>
      request(app)
        .post(path('/members'))
        .set(bearer(world.manager))
        .send({
          employeeId: 'G1',
          name: 'Kiran Rao',
          gender: 'MALE',
          dateOfBirth: '1990-01-01',
          relationship: 'SELF',
          dateOfJoining: null,
          sumInsured: null,
          ...body,
        })
        .expect(201);
    await add({ sumInsured: '300000' });
    await add({
      name: 'Lata Rao',
      gender: 'FEMALE',
      dateOfBirth: '1992-01-01',
      relationship: 'SPOUSE',
    });
    const summary = RfqSelectionSummaryResponseSchema.parse(
      (
        await request(app)
          .get(path('/rfq/selection-summary'))
          .set(bearer(world.readOnly))
          .expect(200)
      ).body,
    );
    expect(summary.summary).toMatchObject({
      product: 'GMC',
      floater: true,
      measure: 'SUM_INSURED',
      coverage: { employees: 1, lives: 2, total: '300000' },
      problems: [],
      reconciled: true,
    });
    // Ages on the policy start (01/12/2026): 36 and 34; a family's amount is not split by age.
    expect(
      summary.summary.matrix.rows
        .filter((row) => row.totalLives > 0)
        .map((row) => [row.label, row.totalLives, row.totalCover]),
    ).toEqual([
      ['19–35', 1, null],
      ['36–45', 1, null],
    ]);
    // A GPA path does not open a GMC case.
    await request(app)
      .get(ebPath('GPA', created.id, '/rfq/selection-summary'))
      .set(bearer(world.readOnly))
      .expect(404);
  });
});
