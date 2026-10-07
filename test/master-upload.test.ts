import { XLSX_CONTENT_TYPE } from '../src/shared/index.ts';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseIibWorkbook } from '../src/modules/masters/import/iib-workbook.ts';
import { MasterVersionModel } from '../src/modules/masters/master-version.model.ts';
import { OccupancyModel } from '../src/modules/masters/occupancy.model.ts';
import { PincodeModel } from '../src/modules/masters/pincode.model.ts';
import { bearer, createTestApp, tokenFor, useTestDatabase } from './helpers/app.ts';
import { buildIibWorkbook } from './helpers/workbook.ts';

useTestDatabase();
const app = createTestApp();

let adminToken: string;
/** The original upload, kept as bytes: a re-upload is the same file, not a rebuilt one. */
let original: Buffer;

beforeAll(async () => {
  adminToken = (await tokenFor(app, ['ADMIN'])).token;
});

function upload(
  file: Buffer,
  { dryRun = true, fileName = 'IIB_Code_Master.xlsx', token = adminToken } = {},
) {
  return request(app)
    .post(
      `/api/v1/masters/import?dryRun=${String(dryRun)}&fileName=${encodeURIComponent(fileName)}`,
    )
    .set(bearer(token))
    .set('Content-Type', XLSX_CONTENT_TYPE)
    .send(file);
}

function download(query = '', token = adminToken) {
  return request(app)
    .get(`/api/v1/masters/workbook${query}`)
    .set(bearer(token))
    .buffer(true)
    .parse((res, callback) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => callback(null, Buffer.concat(chunks)));
    });
}

describe('IIB master upload and download', () => {
  it('has nothing to download before a master is active', async () => {
    const response = await request(app)
      .get('/api/v1/masters/workbook')
      .set(bearer(adminToken))
      .expect(409);
    expect(response.body.code).toBe('MASTER_NOT_ACTIVE');
  });

  it('previews, imports as drafts, activates, and downloads what was uploaded', async () => {
    original = await buildIibWorkbook();
    const file = original;

    const preview = await upload(file).expect(200);
    expect(preview.body).toMatchObject({
      dryRun: true,
      sourceFileName: 'IIB_Code_Master.xlsx',
      fileError: null,
      alreadyImported: false,
      versions: [],
      occupancy: { rowsRead: 5, recordsImported: 5 },
    });
    expect(preview.body.reportText).toContain('Pincode');
    expect(await MasterVersionModel.countDocuments()).toBe(0);

    const saved = await upload(file, { dryRun: false }).expect(200);
    expect(
      saved.body.versions.map((v: { type: string; status: string }) => [v.type, v.status]),
    ).toEqual([
      ['OCCUPANCY', 'DRAFT'],
      ['PINCODE', 'DRAFT'],
    ]);
    // The same file again creates nothing.
    const again = await upload(file, { dryRun: false }).expect(200);
    expect(again.body.alreadyImported).toBe(true);
    expect(await MasterVersionModel.countDocuments()).toBe(2);

    for (const version of saved.body.versions as Array<{ id: string }>) {
      await request(app)
        .post(`/api/v1/masters/versions/${version.id}/activate`)
        .set(bearer(adminToken))
        .send({})
        .expect(200);
    }

    const downloaded = await download().expect(200);
    expect(downloaded.headers['content-type']).toBe(XLSX_CONTENT_TYPE);
    expect(downloaded.headers['content-disposition']).toMatch(
      /^attachment; filename="IIB-master-\d{4}-\d{2}-\d{2}\.xlsx"$/,
    );

    // The download reads back to exactly the active master.
    const parsed = await parseIibWorkbook(downloaded.body as Buffer, {
      sourceFileName: 'x',
      sourceSha256: 'x',
    });
    const [occupancyVersion, pincodeVersion] = saved.body.versions as Array<{ id: string }>;
    const occupancies = await OccupancyModel.find({ versionId: occupancyVersion!.id })
      .sort({ sourceRow: 1 })
      .lean();
    const pincodes = await PincodeModel.find({ versionId: pincodeVersion!.id })
      .sort({ sourceRow: 1 })
      .lean();
    expect(
      parsed.occupancies.map((o) => [
        o.tacCode,
        o.description,
        o.riskGrade,
        o.iibRate,
        o.iibRateNote,
        o.fireRiskType,
        o.terrorismRiskType,
        o.minStfiRate,
        o.minEqRates,
      ]),
    ).toEqual(
      occupancies.map((o) => [
        o.tacCode,
        o.description,
        o.riskGrade,
        o.iibRate?.toString() ?? null,
        o.iibRateNote,
        o.fireRiskType,
        o.terrorismRiskType,
        o.minStfiRate?.toString() ?? null,
        {
          zone1: o.minEqRates.zone1?.toString() ?? null,
          zone2: o.minEqRates.zone2?.toString() ?? null,
          zone3: o.minEqRates.zone3?.toString() ?? null,
          zone4: o.minEqRates.zone4?.toString() ?? null,
        },
      ]),
    );
    expect(
      parsed.pincodes.map((p) => [p.pincode, p.state, p.district, p.eqZone, p.eqRates]),
    ).toEqual(
      pincodes.map((p) => [
        p.pincode,
        p.state,
        p.district,
        p.eqZone,
        {
          residential: p.eqRates.residential?.toString() ?? null,
          nonIndustrial: p.eqRates.nonIndustrial?.toString() ?? null,
          industrial: p.eqRates.industrial?.toString() ?? null,
        },
      ]),
    );
    expect(parsed.report.occupancy.rateYearLabel).toBe('2019');

    // Edited and uploaded again, it becomes the next draft version.
    const next = await upload(downloaded.body as Buffer, {
      dryRun: false,
      fileName: 'IIB-master-edited.xlsx',
    }).expect(200);
    expect(next.body).toMatchObject({ alreadyImported: false, fileError: null });
    expect(next.body.versions.map((v: { status: string }) => v.status)).toEqual(['DRAFT', 'DRAFT']);
  });

  it('rolls back: a superseded file uploads again as a new draft', async () => {
    // The first test imported and activated this file, then saved an edited copy as a draft.
    const before = await upload(original).expect(200);
    expect(before.body.alreadyImported).toBe(true);
    const edited = await MasterVersionModel.find({
      sourceFileName: 'IIB-master-edited.xlsx',
    }).lean();
    for (const version of edited) {
      await request(app)
        .post(`/api/v1/masters/versions/${version._id.toHexString()}/activate`)
        .set(bearer(adminToken))
        .send({})
        .expect(200);
    }
    const preview = await upload(original).expect(200);
    expect(preview.body.alreadyImported).toBe(false);
    const again = await upload(original, { dryRun: false }).expect(200);
    expect(again.body.versions.map((v: { status: string }) => v.status)).toEqual([
      'DRAFT',
      'DRAFT',
    ]);
  });

  it('gives a template with the headers only', async () => {
    const response = await download('?template=true').expect(200);
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="IIB-master-template.xlsx"',
    );
    const parsed = await parseIibWorkbook(response.body as Buffer, {
      sourceFileName: 'x',
      sourceSha256: 'x',
    });
    expect(parsed.occupancies).toEqual([]);
    expect(parsed.pincodes).toEqual([]);
  });

  it('reports a wrong layout or a file that is not a workbook, and saves nothing', async () => {
    const before = await MasterVersionModel.countDocuments();
    const missing = await upload(await buildIibWorkbook({ omitSheet: 'Pincode' }), {
      dryRun: false,
    }).expect(200);
    expect(missing.body.fileError).toContain('Sheet "Pincode" is missing');
    expect(missing.body.versions).toEqual([]);
    const text = await upload(Buffer.from('not a workbook')).expect(200);
    expect(text.body.fileError).toContain('not a readable .xlsx workbook');
    expect(await MasterVersionModel.countDocuments()).toBe(before);
  });

  it('lets every role download and only Admins upload', async () => {
    const { token: manager } = await tokenFor(app, ['ACCOUNT_MANAGER']);
    await download('?template=true', manager).expect(200);
    await upload(await buildIibWorkbook(), { token: manager }).expect(403);
  });
});
