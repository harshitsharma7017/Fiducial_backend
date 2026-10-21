import { DEFAULT_FAMILY_PLANS, PROVISIONAL_TEMPLATE_NOTICE } from '../src/shared/index.ts';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuditLogModel } from '../src/modules/audit/audit.model.ts';
import { EmployeeIdentityModel } from '../src/modules/employees/employee.model.ts';
import { FamilyPlanModel } from '../src/modules/family-plans/family-plan.model.ts';
import { GhiCaseModel } from '../src/modules/ghi/ghi-case.model.ts';
import { EbCensusImportModel, GhiMemberModel } from '../src/modules/ghi/ghi-census.model.ts';
import { bearer, createTestApp, useTestDatabase } from './helpers/app.ts';
import {
  ROLE_LIST,
  binary,
  censusWorkbook,
  createEbCase,
  ebPath,
  fillTemplate,
  gpaSheet,
  gtliSheet,
  readWorkbook,
  setUpWorld,
  uploadCensus,
  type CensusCell,
  type EbWorld,
} from './helpers/eb.ts';

// The census pipeline (N3, Requirements 17 to 23): the seven provisional templates, upload with
// a row-level preview, corrections, the error report, import by policy and mode, re-import,
// employee identities across products, and manual entry.

useTestDatabase();
const app = createTestApp();
let world: EbWorld;

const planId = async (product: 'GMC' | 'GPA' | 'GTLI', code: string) =>
  (await FamilyPlanModel.findOne({ product, code }).lean())!._id.toHexString();

/** A case of the product with the plan assigned (GMC through /ghi). */
async function caseWithPlan(
  product: 'GMC' | 'GPA' | 'GTLI',
  code: string,
  clientId = world.clientId,
) {
  const created = await createEbCase(app, world.manager, product, clientId);
  const path = product === 'GMC' ? `/api/v1/ghi/cases/${created.id}` : ebPath(product, created.id);
  if (product !== 'GTLI' || code !== 'SELF') {
    await request(app)
      .put(`${path}/plan`)
      .set(bearer(world.manager))
      .send({ planId: await planId(product, code) })
      .expect(200);
  }
  return { id: created.id, path };
}

const self = (id: string, name: string, dob = '01/02/1985'): CensusCell[] => [
  id,
  name,
  'Male',
  dob,
  'Self',
  null,
  500000,
];

beforeAll(async () => {
  world = await setUpWorld(app);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the seven provisional templates (Requirement 19)', () => {
  const expected: Record<string, string[]> = {
    'GMC SELF': [
      'Employee ID *',
      'Name *',
      'Gender *',
      'Date of Birth *',
      'Date of Joining',
      'Sum Insured *',
    ],
    'GMC 1+3': [
      'Employee ID *',
      'Name *',
      'Gender *',
      'Date of Birth *',
      'Relationship *',
      'Date of Joining',
      'Sum Insured *',
    ],
    'GMC 1+5': [
      'Employee ID *',
      'Name *',
      'Gender *',
      'Date of Birth *',
      'Relationship *',
      'Date of Joining',
      'Sum Insured *',
    ],
    'GMC 1+7': [
      'Employee ID *',
      'Name *',
      'Gender *',
      'Date of Birth *',
      'Relationship *',
      'Date of Joining',
      'Sum Insured *',
    ],
    'GPA SELF': [
      'Employee ID *',
      'Name *',
      'Gender *',
      'Date of Birth *',
      'Date of Joining',
      'Sum Insured',
      'Annual Salary',
      // N5, N6: GPA and GTLI templates ask for each employee's nominee.
      'Nominee Name *',
      'Nominee Relationship *',
      'Nominee Date of Birth',
      'Nominee Age',
    ],
    'GPA 1+3': [
      'Employee ID *',
      'Name *',
      'Gender *',
      'Date of Birth *',
      'Relationship *',
      'Date of Joining',
      'Sum Insured',
      'Annual Salary',
      // N5, N6: GPA and GTLI templates ask for each employee's nominee.
      'Nominee Name *',
      'Nominee Relationship *',
      'Nominee Date of Birth',
      'Nominee Age',
    ],
    'GTLI SELF': [
      'Employee ID *',
      'Name *',
      'Gender *',
      'Date of Birth *',
      'Date of Joining',
      'Sum Insured',
      'Annual Salary',
      // N5, N6: GPA and GTLI templates ask for each employee's nominee.
      'Nominee Name *',
      'Nominee Relationship *',
      'Nominee Date of Birth',
      'Nominee Age',
    ],
  };

  for (const plan of DEFAULT_FAMILY_PLANS) {
    it(`builds ${plan.templateName} and imports a filled copy with no invalid row`, async () => {
      const response = await binary(
        request(app)
          .get(
            `/api/v1/eb/census-templates?product=${plan.product}&planId=${await planId(plan.product, plan.code)}`,
          )
          .set(bearer(world.readOnly)),
      ).expect(200);
      expect(response.headers['content-disposition']).toContain(
        `Provisional-${plan.templateName.replace(/\s+/g, '-')}-v1.xlsx`,
      );
      const workbook = await readWorkbook(response.body as Buffer);
      expect(workbook.worksheets.map((sheet) => [sheet.name, sheet.state])).toEqual([
        ['Instructions', 'visible'],
        ['Census', 'visible'],
        ['_fiducial', 'veryHidden'],
      ]);
      const instructions = workbook.getWorksheet('Instructions')!;
      expect(instructions.getCell('A1').text).toBe(PROVISIONAL_TEMPLATE_NOTICE);
      const lines: string[] = [];
      instructions.eachRow((row) => row.eachCell((cell) => lines.push(cell.text)));
      const text = lines.join(' ');
      expect(text).toContain('Awaiting client confirmation');
      expect(text).toContain('DD/MM/YYYY');
      expect(text).toContain('10,000 rows');
      const headers = (workbook.getWorksheet('Census')!.getRow(1).values as unknown[]).filter(
        Boolean,
      );
      expect(headers).toEqual(expected[`${plan.product} ${plan.code}`]);

      // Filled with valid rows and uploaded to a case of the same plan: every row is valid.
      const target = await caseWithPlan(plan.product, plan.code);
      if (plan.product === 'GPA') {
        await request(app)
          .put(`${target.path}/requirements`)
          .set(bearer(world.manager))
          .send(gpaSheet())
          .expect(200);
      }
      const hasRelationship = headers.includes('Relationship *');
      const columns = headers.length;
      const row = (values: CensusCell[]) => values.slice(0, columns);
      const rows: CensusCell[][] = hasRelationship
        ? [
            // GPA's nominee columns follow (N5): the employee's nominee, none for dependants.
            row([
              'F1',
              'Arjun Mehta',
              'M',
              '01/01/1980',
              'Self',
              '01/04/2010',
              500000,
              null,
              'Kavya Mehta',
              'Spouse',
              '01/01/1982',
              null,
            ]),
            row(['F1', 'Kavya Mehta', 'F', '01/01/1982', 'Wife', null, null, null]),
            row(['F1', 'Rohan Mehta', 'M', '01/01/2012', 'Son', null, null, null]),
          ]
        : [
            row([
              'F1',
              'Arjun Mehta',
              'M',
              '01/01/1980',
              '01/04/2010',
              500000,
              null,
              'Kavya Mehta',
              'Wife',
              null,
              44,
            ]),
            row([
              'F2',
              'Leela Iyer',
              'F',
              '5 March 1990',
              null,
              500000,
              null,
              'Ravi Iyer',
              'Father',
              '02/02/1960',
              null,
            ]),
          ];
      const preview = (
        await uploadCensus(
          app,
          world.manager,
          target.path,
          await fillTemplate(response.body as Buffer, rows),
        ).expect(201)
      ).body;
      expect(preview.fileIssues ?? []).toEqual([]);
      expect(preview.counts).toMatchObject({ rows: rows.length, valid: rows.length, invalid: 0 });
    });
  }

  it('keeps the marker when rows are sorted, inserted and deleted', async () => {
    const response = await binary(
      request(app)
        .get(`/api/v1/eb/census-templates?product=GPA&planId=${await planId('GPA', '1+3')}`)
        .set(bearer(world.readOnly)),
    ).expect(200);
    const workbook = await readWorkbook(response.body as Buffer);
    const sheet = workbook.getWorksheet('Census')!;
    sheet.insertRow(2, ['B1', 'B', 'M', '01/01/1980', 'Self']);
    sheet.insertRow(2, ['A1', 'A', 'M', '01/01/1980', 'Self']);
    sheet.spliceRows(3, 1);
    const saved = await readWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()));
    const marker = saved.getWorksheet('_fiducial')!;
    expect(marker.state).toBe('veryHidden');
    expect(marker.getCell('B4').text).toBe('1+3');
  });

  it('serves the GHI template unchanged for a GMC case without a plan, and refuses bad requests', async () => {
    const gmc = await createEbCase(app, world.manager, 'GMC', world.clientId);
    const legacy = await binary(
      request(app)
        .get(`/api/v1/eb/census-templates?product=GMC&caseId=${gmc.id}`)
        .set(bearer(world.readOnly)),
    ).expect(200);
    const original = await binary(
      request(app).get('/api/v1/ghi/census-template').set(bearer(world.readOnly)),
    ).expect(200);
    const [a, b] = [
      await readWorkbook(legacy.body as Buffer),
      await readWorkbook(original.body as Buffer),
    ];
    expect(a.worksheets.map((sheet) => sheet.name)).toEqual(
      b.worksheets.map((sheet) => sheet.name),
    );
    expect(a.getWorksheet('Census')!.getRow(1).values).toEqual(
      b.getWorksheet('Census')!.getRow(1).values,
    );
    expect(a.getWorksheet('_fiducial')).toBeUndefined();

    const gpaPlan = await planId('GPA', '1+3');
    await request(app)
      .get('/api/v1/eb/census-templates?product=GHI')
      .set(bearer(world.readOnly))
      .expect(400);
    await request(app)
      .get('/api/v1/eb/census-templates?product=GPA')
      .set(bearer(world.readOnly))
      .expect(400);
    await request(app)
      .get(`/api/v1/eb/census-templates?product=GMC&planId=${gpaPlan}`)
      .set(bearer(world.readOnly))
      .expect(400);
    await request(app)
      .get(`/api/v1/eb/census-templates?product=GPA&caseId=${gmc.id}`)
      .set(bearer(world.readOnly))
      .expect(400);
    const noPlan = await createEbCase(app, world.manager, 'GPA', world.clientId);
    const refused = await request(app)
      .get(`/api/v1/eb/census-templates?product=GPA&caseId=${noPlan.id}`)
      .set(bearer(world.readOnly))
      .expect(409);
    expect(refused.body.code).toBe('EB_PLAN_REQUIRED');
    await request(app)
      .post(`/api/v1/family-plans/${gpaPlan}/deactivate`)
      .set(bearer(world.admin))
      .expect(200);
    await request(app)
      .get(`/api/v1/eb/census-templates?product=GPA&planId=${gpaPlan}`)
      .set(bearer(world.readOnly))
      .expect(400);
    await request(app)
      .post(`/api/v1/family-plans/${gpaPlan}/activate`)
      .set(bearer(world.admin))
      .expect(200);
    await request(app).get(`/api/v1/eb/census-templates?product=GPA&planId=${gpaPlan}`).expect(401);
  });
});

describe('upload, preview and corrections (Requirements 20, 21)', () => {
  let target: { id: string; path: string };
  const headers = [
    'Employee ID',
    'Name',
    'Gender',
    'Date of Birth',
    'Relationship',
    'Date of Joining',
    'Sum Insured',
  ];

  beforeAll(async () => {
    target = await caseWithPlan('GPA', '1+3');
    await request(app)
      .put(`${target.path}/requirements`)
      .set(bearer(world.manager))
      .send(gpaSheet())
      .expect(200);
  });

  it('refuses files that are not workbooks, lack a column, have no rows or too many', async () => {
    const notXlsx = await uploadCensus(
      app,
      world.manager,
      target.path,
      Buffer.from('employee,name\n'),
    ).expect(422);
    expect(notXlsx.body.code).toBe('IMPORT_FILE_INVALID');
    const missing = await uploadCensus(
      app,
      world.manager,
      target.path,
      await censusWorkbook(['Employee ID', 'Name', 'Gender'], [['E1', 'A', 'M']]),
    ).expect(422);
    expect(missing.body.message).toBe(
      'Row 1: the "Date of Birth" column is missing. Use the headers from the census template.',
    );
    await uploadCensus(app, world.manager, target.path, await censusWorkbook(headers, [])).expect(
      422,
    );
    const many = Array.from({ length: 10_001 }, (_, index) => [
      `E${index}`,
      'N',
      'M',
      '01/01/1990',
      'Self',
      null,
      500000,
    ]);
    const tooMany = await uploadCensus(
      app,
      world.manager,
      target.path,
      await censusWorkbook(headers, many),
    ).expect(422);
    expect(tooMany.body.message).toContain('more than 10,000 rows');
    expect(await EbCensusImportModel.countDocuments({ caseId: target.id })).toBe(0);
  });

  it('refuses a template made for another plan, naming both, and warns when there is no marker', async () => {
    const other = await binary(
      request(app)
        .get(`/api/v1/eb/census-templates?product=GPA&planId=${await planId('GPA', 'SELF')}`)
        .set(bearer(world.readOnly)),
    ).expect(200);
    const mismatch = await uploadCensus(
      app,
      world.manager,
      target.path,
      await fillTemplate(other.body as Buffer, [['E1', 'A', 'M', '01/01/1990', null, 500000]]),
    ).expect(422);
    expect(mismatch.body.message).toContain('GPA plan SELF v1');
    expect(mismatch.body.message).toContain('plan 1+3 v1');
    const plain = await uploadCensus(
      app,
      world.manager,
      target.path,
      await censusWorkbook(headers, [self('E1', 'Ravi')]),
    ).expect(201);
    expect(plain.body.fileWarnings[0]).toContain('no product or plan marker');
  });

  it('keeps every row with its issues, sets aside the open preview, and corrects rows', async () => {
    const rows = [
      self('E10', 'Asha Rao', '03/04/1990'),
      ['E10', 'Kid One', 'F', '12/31/2015', 'Child', null, null],
      ['E11', 'Lonely Spouse', 'F', '01/01/1990', 'Spouse', null, null],
      ['E12', 'Too Young', 'M', '01/01/2027', 'Self', null, 500000],
      ['E13', '=1+1', 'M', '01/01/1990', 'Self', null, '+1'],
    ];
    const first = (
      await uploadCensus(
        app,
        world.manager,
        target.path,
        await censusWorkbook(headers, rows),
      ).expect(201)
    ).body;
    const second = (
      await uploadCensus(
        app,
        world.manager,
        target.path,
        await censusWorkbook(headers, rows),
      ).expect(201)
    ).body;
    expect((await EbCensusImportModel.findById(first.id).lean())?.status).toBe('DISCARDED');
    expect(
      await AuditLogModel.countDocuments({
        action: 'EB_CENSUS_IMPORT_DISCARDED',
        entityId: target.id,
      }),
    ).toBeGreaterThan(0);
    expect(second.counts).toMatchObject({ rows: 5, valid: 1, invalid: 4 });
    const byRow = new Map(
      second.rows.map((row: { row: number; issues: unknown[] }) => [row.row, row.issues]),
    );
    expect(byRow.get(3)).toEqual([
      expect.objectContaining({
        row: 3,
        field: 'dateOfBirth',
        value: '12/31/1990'.replace('1990', '2015'),
        fix: expect.stringContaining('DD/MM/YYYY'),
      }),
    ]);
    expect(byRow.get(4)).toEqual([
      expect.objectContaining({
        field: 'employeeId',
        message: 'No employee (Self) row for employee ID E11',
      }),
    ]);
    expect(byRow.get(5)).toEqual([
      expect.objectContaining({
        field: 'dateOfBirth',
        message: 'The date of birth is after today',
      }),
    ]);

    // The error report: every cell text, no-store, audited without the values.
    const report = await binary(
      request(app)
        .get(`${target.path}/census/imports/${second.id as string}/error-report`)
        .set(bearer(world.readOnly)),
    ).expect(200);
    expect(report.headers['cache-control']).toBe('no-store');
    const workbook = await readWorkbook(report.body as Buffer);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(['Census', 'Issues']);
    const census = workbook.getWorksheet('Census')!;
    let formulas = 0;
    census.eachRow((row) =>
      row.eachCell((cell) => {
        if (cell.type === ExcelJS.ValueType.Formula) formulas += 1;
      }),
    );
    expect(formulas).toBe(0);
    const values = census.getSheetValues().flat().map(String);
    expect(values).toContain('=1+1');
    expect(values).toContain('+1');
    const audit = await AuditLogModel.findOne({
      action: 'EB_CENSUS_ERROR_REPORT_DOWNLOADED',
      entityId: target.id,
    }).lean();
    expect(audit?.after).toMatchObject({ rows: 4 });
    expect(JSON.stringify(audit?.after)).not.toContain('Asha');

    // Corrections: the child's date, then an employee ID change that moves a row to another family.
    const fixed = await request(app)
      .put(`${target.path}/census/imports/${second.id as string}/rows/3`)
      .set(bearer(world.manager))
      .send({
        values: {
          employeeId: 'E10',
          name: 'Kid One',
          gender: 'F',
          dateOfBirth: '31/12/2015',
          relationship: 'Child',
          dateOfJoining: '',
          sumInsured: '',
          annualSalary: '',
        },
      })
      .expect(200);
    expect(fixed.body.rows.find((row: { row: number }) => row.row === 3)).toMatchObject({
      valid: true,
      corrected: true,
    });
    const moved = await request(app)
      .put(`${target.path}/census/imports/${second.id as string}/rows/4`)
      .set(bearer(world.manager))
      .send({
        values: {
          employeeId: 'E10',
          name: 'Lonely Spouse',
          gender: 'F',
          dateOfBirth: '01/01/1990',
          relationship: 'Spouse',
          dateOfJoining: '',
          sumInsured: '',
          annualSalary: '',
        },
      })
      .expect(200);
    expect(moved.body.counts).toMatchObject({ valid: 3, invalid: 2 });
    const [corrected] = await AuditLogModel.find({
      action: 'EB_CENSUS_ROW_CORRECTED',
      entityId: target.id,
    })
      .sort({ _id: 1 })
      .lean();
    expect(corrected?.after).toMatchObject({ row: 3, dateOfBirth: '31/12/2015' });

    // Valid only: imports the three valid rows and lists the two left out.
    const commit = await request(app)
      .post(`${target.path}/census/imports/${second.id as string}/commit`)
      .set(bearer(world.manager))
      .send({ policy: 'VALID_ONLY', mode: 'ADD_NEW_ONLY' })
      .expect(200);
    expect(commit.body.result).toMatchObject({
      added: 3,
      updated: 0,
      unchanged: 0,
      skipped: 2,
      identitiesCreated: 1,
      identitiesReused: 0,
    });
    expect(commit.body.result.leftOut.map((item: { row: number }) => item.row)).toEqual([5, 6]);
    expect(await GhiMemberModel.countDocuments({ caseId: target.id })).toBe(3);
    await request(app)
      .put(`${target.path}/census/imports/${second.id as string}/rows/5`)
      .set(bearer(world.manager))
      .send({
        values: {
          employeeId: 'E12',
          name: 'X',
          gender: 'M',
          dateOfBirth: '01/01/1990',
          relationship: 'Self',
          dateOfJoining: '',
          sumInsured: '500000',
          annualSalary: '',
        },
      })
      .expect(409);
  });

  it('refuses the error report when nothing has an issue, and an import with no policy', async () => {
    const clean = (
      await uploadCensus(
        app,
        world.manager,
        target.path,
        await censusWorkbook(headers, [self('E20', 'Clean Row')]),
      ).expect(201)
    ).body;
    const none = await request(app)
      .get(`${target.path}/census/imports/${clean.id as string}/error-report`)
      .set(bearer(world.readOnly))
      .expect(409);
    expect(none.body.code).toBe('EB_NO_ERRORS');
    await request(app)
      .post(`${target.path}/census/imports/${clean.id as string}/commit`)
      .set(bearer(world.manager))
      .send({})
      .expect(400);
    await request(app)
      .post(`${target.path}/census/imports/${clean.id as string}/commit`)
      .set(bearer(world.manager))
      .send({ policy: 'SOME' })
      .expect(400);
    await request(app)
      .post(`${target.path}/census/imports/${clean.id as string}/commit`)
      .set(bearer(world.manager))
      .send({ policy: 'ALL_VALID', mode: 'REPLACE' })
      .expect(400);
  });

  it('checks permissions and ownership of previews', async () => {
    const preview = (
      await uploadCensus(
        app,
        world.manager,
        target.path,
        await censusWorkbook(headers, [self('E30', 'Perm Row')]),
      ).expect(201)
    ).body;
    for (const role of ROLE_LIST) {
      const upload = await uploadCensus(
        app,
        world.tokens[role],
        target.path,
        await censusWorkbook(headers, [self('E31', 'Role Row')]),
      );
      expect(upload.status).toBe(
        ['ADMIN', 'ACCOUNT_MANAGER', 'PLACEMENT_EXEC'].includes(role) ? 201 : 403,
      );
    }
    const other = await caseWithPlan('GPA', 'SELF');
    await request(app)
      .get(`${other.path}/census/imports/${preview.id as string}`)
      .set(bearer(world.readOnly))
      .expect(404);
    await request(app)
      .get(`${target.path}/census/imports/${preview.id as string}`)
      .expect(401);
  });
});

describe('import modes, re-import and identities (Requirements 17, 22)', () => {
  const headers = [
    'Employee ID',
    'Name',
    'Gender',
    'Date of Birth',
    'Relationship',
    'Date of Joining',
    'Sum Insured',
  ];
  const rows = [
    self('R1', 'Neel Shah'),
    ['R1', 'Pooja Shah', 'F', '01/01/1987', 'Spouse', null, null],
    self('R2', 'Tara Bose', '02/02/1992'),
  ];

  it('creates nothing the second time the same file is imported, and leaves the revision alone', async () => {
    const target = await caseWithPlan('GPA', '1+3');
    await request(app)
      .put(`${target.path}/requirements`)
      .set(bearer(world.manager))
      .send(gpaSheet())
      .expect(200);
    const file = await censusWorkbook(headers, rows);
    const first = (await uploadCensus(app, world.manager, target.path, file).expect(201)).body;
    const result = (
      await request(app)
        .post(`${target.path}/census/imports/${first.id as string}/commit`)
        .set(bearer(world.manager))
        .send({ policy: 'ALL_VALID' })
        .expect(200)
    ).body.result;
    expect(result).toMatchObject({ added: 3, identitiesCreated: 2 });
    expect(await GhiMemberModel.countDocuments({ caseId: target.id })).toBe(3);
    const revision = (await GhiCaseModel.findById(target.id).lean())!.censusRevision;
    const second = (await uploadCensus(app, world.manager, target.path, file).expect(201)).body;
    expect(second.rows.every((row: { match: string }) => row.match === 'SAME')).toBe(true);
    const again = (
      await request(app)
        .post(`${target.path}/census/imports/${second.id as string}/commit`)
        .set(bearer(world.manager))
        .send({ policy: 'ALL_VALID' })
        .expect(200)
    ).body.result;
    expect(again).toMatchObject({
      added: 0,
      updated: 0,
      unchanged: 3,
      skipped: 0,
      identitiesCreated: 0,
      identitiesReused: 0,
    });
    expect(await GhiMemberModel.countDocuments({ caseId: target.id })).toBe(3);
    expect((await GhiCaseModel.findById(target.id).lean())!.censusRevision).toBe(revision);

    // A changed row: an error under Add new only, an update of three fields under Add and update.
    const changed = await censusWorkbook(headers, [
      ['R2', 'Tara Bose', 'F', '02/02/1992', 'Self', '01/01/2021', 500000],
    ]);
    const preview = (await uploadCensus(app, world.manager, target.path, changed).expect(201)).body;
    expect(preview.rows[0]).toMatchObject({ match: 'CHANGED', valid: false });
    expect(preview.rows[0].issues[0]).toMatchObject({
      field: 'dateOfJoining',
      code: 'MEMBER_CHANGED',
    });
    const update = await request(app)
      .get(`${target.path}/census/imports/${preview.id as string}?mode=ADD_AND_UPDATE`)
      .set(bearer(world.readOnly))
      .expect(200);
    expect(update.body.rows[0]).toMatchObject({ match: 'CHANGED', valid: true });
    const updated = (
      await request(app)
        .post(`${target.path}/census/imports/${preview.id as string}/commit`)
        .set(bearer(world.manager))
        .send({ policy: 'ALL_VALID', mode: 'ADD_AND_UPDATE' })
        .expect(200)
    ).body.result;
    expect(updated).toMatchObject({ added: 0, updated: 1, unchanged: 0 });
    const member = await GhiMemberModel.findOne({ caseId: target.id, employeeKey: 'R2' }).lean();
    expect(member).toMatchObject({ dateOfJoining: '2021-01-01', name: 'Tara Bose' });
  });

  it('keeps one identity per employee across GMC, GPA and GTLI of a company, and two across companies', async () => {
    const gmc = await caseWithPlan('GMC', '1+3');
    const gtli = await caseWithPlan('GTLI', 'SELF');
    await request(app)
      .put(`${gtli.path}/requirements`)
      .set(bearer(world.manager))
      .send(gtliSheet({ sumInsuredBasis: { kind: 'FLAT', amount: '500000' } }))
      .expect(200);
    const gmcFile = await censusWorkbook(headers, [self('R1', 'Neel Shah')]);
    const gmcPreview = (await uploadCensus(app, world.manager, gmc.path, gmcFile).expect(201)).body;
    await request(app)
      .post(`${gmc.path}/census/imports/${gmcPreview.id as string}/commit`)
      .set(bearer(world.manager))
      .send({ policy: 'ALL_VALID' })
      .expect(200);
    const gtliFile = await censusWorkbook(
      ['Employee ID', 'Name', 'Gender', 'Date of Birth', 'Sum Insured'],
      [['R1', 'NEEL  SHAH', 'M', '01/02/1985', 500000]],
    );
    const gtliPreview = (await uploadCensus(app, world.manager, gtli.path, gtliFile).expect(201))
      .body;
    const committed = (
      await request(app)
        .post(`${gtli.path}/census/imports/${gtliPreview.id as string}/commit`)
        .set(bearer(world.manager))
        .send({ policy: 'ALL_VALID' })
        .expect(200)
    ).body.result;
    expect(committed).toMatchObject({ added: 1, identitiesCreated: 0, identitiesReused: 1 });
    expect(
      await EmployeeIdentityModel.countDocuments({ clientId: world.clientId, employeeKey: 'R1' }),
    ).toBe(1);

    const elsewhere = await caseWithPlan('GPA', '1+3', world.otherClientId);
    await request(app)
      .put(`${elsewhere.path}/requirements`)
      .set(bearer(world.manager))
      .send(gpaSheet())
      .expect(200);
    const otherPreview = (
      await uploadCensus(
        app,
        world.manager,
        elsewhere.path,
        await censusWorkbook(headers, [self('R1', 'Someone Else', '05/05/1995')]),
      ).expect(201)
    ).body;
    expect(otherPreview.counts.invalid).toBe(0);
    await request(app)
      .post(`${elsewhere.path}/census/imports/${otherPreview.id as string}/commit`)
      .set(bearer(world.manager))
      .send({ policy: 'ALL_VALID' })
      .expect(200);
    expect(await EmployeeIdentityModel.countDocuments({ employeeKey: 'R1' })).toBe(2);

    // A differing date of birth for the same company's employee is reported on the row.
    const differs = (
      await uploadCensus(
        app,
        world.manager,
        gtli.path,
        await censusWorkbook(
          ['Employee ID', 'Name', 'Gender', 'Date of Birth', 'Sum Insured'],
          [['R2', 'Tara Bose', 'M', '03/02/1992', 500000]],
        ),
      ).expect(201)
    ).body;
    expect(differs.rows[0].issues[0]).toMatchObject({
      field: 'dateOfBirth',
      code: 'IDENTITY_MISMATCH',
      value: '03/02/1992',
    });
  });

  it('writes nothing when the import transaction fails, and keeps the preview', async () => {
    const target = await caseWithPlan('GPA', '1+3');
    await request(app)
      .put(`${target.path}/requirements`)
      .set(bearer(world.manager))
      .send(gpaSheet())
      .expect(200);
    const preview = (
      await uploadCensus(
        app,
        world.manager,
        target.path,
        await censusWorkbook(headers, [self('X1', 'Fail Case')]),
      ).expect(201)
    ).body;
    const audits = await AuditLogModel.countDocuments({});
    const identities = await EmployeeIdentityModel.countDocuments({});
    vi.spyOn(EbCensusImportModel, 'findOneAndUpdate').mockImplementation(() => {
      throw new Error('injected failure');
    });
    await request(app)
      .post(`${target.path}/census/imports/${preview.id as string}/commit`)
      .set(bearer(world.manager))
      .send({ policy: 'ALL_VALID' })
      .expect(500);
    vi.restoreAllMocks();
    expect(await GhiMemberModel.countDocuments({ caseId: target.id })).toBe(0);
    expect(await EmployeeIdentityModel.countDocuments({})).toBe(identities);
    expect(await AuditLogModel.countDocuments({})).toBe(audits);
    expect((await EbCensusImportModel.findById(preview.id).lean())?.status).toBe('PREVIEW');
  });

  it('keeps the GMC guard against importing the same rows twice, and the no-mode check', async () => {
    const gmc = await createEbCase(app, world.manager, 'GMC', world.clientId);
    const path = `/api/v1/ghi/cases/${gmc.id}`;
    await request(app)
      .put(`${path}/requirements`)
      .set(bearer(world.manager))
      .send((await import('../src/shared/index.ts')).emptyGhiRequirements())
      .expect(200);
    const file = await censusWorkbook(headers, [self('G1', 'Ghi Person')]);
    const preview = (await uploadCensus(app, world.manager, path, file).expect(201)).body;
    expect(preview.rows[0].issues).toEqual([]);
    await request(app)
      .post(`${path}/census/imports/${preview.id as string}/commit`)
      .set(bearer(world.manager))
      .send({ policy: 'ALL_VALID' })
      .expect(200);
    const again = await uploadCensus(app, world.manager, path, file).expect(409);
    expect(again.body.code).toBe('GHI_DUPLICATE_IMPORT');
  });
});

describe('manual census entry (Requirement 23)', () => {
  it('adds, edits and removes members under the import’s rules', async () => {
    const target = await caseWithPlan('GPA', '1+3');
    await request(app)
      .put(`${target.path}/requirements`)
      .set(bearer(world.manager))
      .send(gpaSheet())
      .expect(200);
    const member = (body: Record<string, unknown>) => ({
      employeeId: 'M1',
      name: 'Manual Self',
      gender: 'MALE',
      dateOfBirth: '1985-01-01',
      relationship: 'SELF',
      dateOfJoining: '',
      sumInsured: '500000',
      annualSalary: '',
      ...body,
    });
    const revision = async () => (await GhiCaseModel.findById(target.id).lean())!.censusRevision;
    const audits = await AuditLogModel.countDocuments({});
    const before = await revision();
    const refused = await request(app)
      .post(`${target.path}/members`)
      .set(bearer(world.manager))
      .send(member({ sumInsured: '400000' }))
      .expect(400);
    expect(refused.body.details[0]).toMatchObject({ path: 'sumInsured' });
    expect(await AuditLogModel.countDocuments({})).toBe(audits);
    expect(await revision()).toBe(before);
    const self = (
      await request(app)
        .post(`${target.path}/members`)
        .set(bearer(world.manager))
        .send(member({}))
        .expect(201)
    ).body;
    expect(await revision()).toBe(before + 1);
    expect(self.employeeIdentityId).toEqual(expect.any(String));
    const spouse = (
      await request(app)
        .post(`${target.path}/members`)
        .set(bearer(world.manager))
        .send(
          member({
            name: 'Manual Spouse',
            gender: 'FEMALE',
            relationship: 'SPOUSE',
            sumInsured: '',
          }),
        )
        .expect(201)
    ).body;
    const second = await request(app)
      .post(`${target.path}/members`)
      .set(bearer(world.manager))
      .send(
        member({
          name: 'Another Spouse',
          gender: 'FEMALE',
          relationship: 'SPOUSE',
          sumInsured: '',
        }),
      )
      .expect(400);
    expect(second.body.message).toContain('the plan GPA 1+3 v1 allows at most 1');
    const blocked = await request(app)
      .delete(`${target.path}/members/${self.id as string}`)
      .set(bearer(world.manager))
      .expect(409);
    expect(blocked.body.message).toContain('Manual Spouse (Spouse)');
    await request(app)
      .put(`${target.path}/members/${spouse.id as string}`)
      .set(bearer(world.manager))
      .send(
        member({
          name: 'Manual Spouse',
          gender: 'FEMALE',
          relationship: 'SPOUSE',
          sumInsured: '',
          dateOfBirth: '1986-01-01',
        }),
      )
      .expect(200);
    await request(app)
      .delete(`${target.path}/members/${spouse.id as string}`)
      .set(bearer(world.manager))
      .expect(204);
    await request(app)
      .delete(`${target.path}/members/${self.id as string}`)
      .set(bearer(world.manager))
      .expect(204);
    await request(app)
      .delete(`${target.path}/members/${self.id as string}`)
      .set(bearer(world.manager))
      .expect(404);
    await request(app)
      .post(`${target.path}/members`)
      .set(bearer(world.readOnly))
      .send(member({}))
      .expect(403);
  });
});
