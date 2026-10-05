import { describe, expect, it } from 'vitest';
import { AuditLogModel } from '../src/modules/audit/audit.model.ts';
import { ImportStructureError } from '../src/modules/masters/import/iib-workbook.ts';
import { importMasters } from '../src/modules/masters/import/import-masters.ts';
import { MasterVersionModel } from '../src/modules/masters/master-version.model.ts';
import { getPincode, searchOccupancies } from '../src/modules/masters/masters.service.ts';
import { OccupancyModel } from '../src/modules/masters/occupancy.model.ts';
import { PincodeModel } from '../src/modules/masters/pincode.model.ts';
import { createTestUser, useTestDatabase } from './helpers/app.ts';
import { STANDARD_OCCUPANCIES, writeWorkbookFile } from './helpers/workbook.ts';

useTestDatabase();

describe('importMasters', () => {
  it('rejects a workbook with the wrong layout and writes nothing', async () => {
    const before = await MasterVersionModel.countDocuments();
    const path = await writeWorkbookFile({ omitSheet: 'IIB Code' });
    await expect(importMasters({ filePath: path })).rejects.toThrow(ImportStructureError);
    expect(await MasterVersionModel.countDocuments()).toBe(before);
  });

  it('imports DRAFT versions that lookups ignore until activated, then activates them', async () => {
    const admin = await createTestUser({ roles: ['ADMIN'] });
    const path = await writeWorkbookFile();

    const draft = await importMasters({ filePath: path, importedBy: admin.id });
    expect(draft.alreadyImported).toBe(false);
    expect(draft.activated).toBe(false);
    expect(draft.occupancyVersion).toMatchObject({
      status: 'DRAFT',
      importedBy: admin.id,
      stats: { rowsRead: 5, recordsImported: 5, rowsSkipped: 0, errorCount: 0 },
    });
    expect(draft.pincodeVersion).toMatchObject({
      status: 'DRAFT',
      stats: { rowsRead: 8, recordsImported: 6, rowsSkipped: 2, errorCount: 1 },
    });
    expect(await OccupancyModel.countDocuments({ versionId: draft.occupancyVersion.id })).toBe(5);
    expect(await PincodeModel.countDocuments({ versionId: draft.pincodeVersion.id })).toBe(6);

    // Nothing is active yet, so lookups refuse rather than read the draft.
    await expect(getPincode('400001')).rejects.toMatchObject({ code: 'MASTER_NOT_ACTIVE' });

    const imported = await AuditLogModel.find({
      action: 'MASTER_IMPORTED',
      requestId: draft.runId,
    }).lean();
    expect(imported).toHaveLength(2);
    expect(imported[0]?.userId?.toHexString()).toBe(admin.id);

    // Running the same file again with --activate reuses the drafts and activates them.
    const activated = await importMasters({
      filePath: path,
      activate: true,
      effectiveFrom: '2026-10-05',
    });
    expect(activated.alreadyImported).toBe(true);
    expect(activated.activated).toBe(true);
    expect(activated.occupancyVersion).toMatchObject({
      id: draft.occupancyVersion.id,
      status: 'ACTIVE',
    });
    expect(activated.pincodeVersion).toMatchObject({
      id: draft.pincodeVersion.id,
      status: 'ACTIVE',
    });
    expect(activated.occupancyVersion.effectiveFrom).toBe('2026-10-04T18:30:00.000Z');

    const pincode = await getPincode('400001');
    expect(pincode).toMatchObject({ state: 'Mumbai', eqZone: 3, eqRates: { industrial: '0.1' } });
    const occupancies = await searchOccupancies({ q: '1001', limit: 20 });
    expect(occupancies.items.map((o) => o.tacCode)).toEqual(['1001', '1001_2']);
    expect(occupancies.items[1]?.minEqRates).toEqual({
      zone1: '0.25',
      zone2: '0.15',
      zone3: '0.1',
      zone4: '0.05',
    });

    expect(
      await AuditLogModel.countDocuments({
        action: 'MASTER_ACTIVATED',
        requestId: activated.runId,
      }),
    ).toBe(2);
  });

  it('is idempotent for the same file and never overwrites an existing version', async () => {
    const path = await writeWorkbookFile({}, 'Same.xlsx');
    const first = await importMasters({ filePath: path });
    const versionsAfterFirst = await MasterVersionModel.countDocuments();

    const again = await importMasters({ filePath: path });
    expect(again.alreadyImported).toBe(true);
    expect(again.occupancyVersion.id).toBe(first.occupancyVersion.id);
    expect(await MasterVersionModel.countDocuments()).toBe(versionsAfterFirst);
    expect(await OccupancyModel.countDocuments({ versionId: first.occupancyVersion.id })).toBe(5);

    // --force imports the same file again as new versions, leaving the earlier ones alone.
    const forced = await importMasters({ filePath: path, force: true });
    expect(forced.occupancyVersion.id).not.toBe(first.occupancyVersion.id);
    expect(await MasterVersionModel.countDocuments()).toBe(versionsAfterFirst + 2);
    expect(await OccupancyModel.countDocuments({ versionId: first.occupancyVersion.id })).toBe(5);
  });

  it('supersedes the active version when a newer workbook is activated', async () => {
    const newer = STANDARD_OCCUPANCIES.map((row) => [...row] as typeof row);
    newer[2]![4] = 0.7; // 2001 IIB rate changes from 0.69 to 0.7
    const path = await writeWorkbookFile({ occupancies: newer }, 'Newer.xlsx');
    const previousActive = await MasterVersionModel.findOne({
      type: 'OCCUPANCY',
      status: 'ACTIVE',
    }).lean();

    const result = await importMasters({ filePath: path, activate: true });
    expect(result.occupancyVersion.status).toBe('ACTIVE');

    const superseded = await MasterVersionModel.findById(previousActive?._id).lean();
    expect(superseded?.status).toBe('SUPERSEDED');
    expect(superseded?.effectiveTo).toBeInstanceOf(Date);
    // Superseded data is kept so earlier calculations stay reproducible.
    expect(await OccupancyModel.countDocuments({ versionId: previousActive?._id })).toBe(5);

    const abrasive = await searchOccupancies({ q: '2001', limit: 5 });
    expect(abrasive.items[0]?.iibRate).toBe('0.7');
  });

  it('stores the validation report on the version for review', async () => {
    const path = await writeWorkbookFile({}, 'Report.xlsx');
    const result = await importMasters({ filePath: path, force: true });
    const version = await MasterVersionModel.findById(result.pincodeVersion.id).lean();
    expect(version?.report).toMatchObject({
      duplicates: [expect.objectContaining({ pincode: '207001' })],
      skippedRows: [expect.objectContaining({ value: '12345' })],
      crossCheck: expect.objectContaining({ pincodesWithMismatch: 2 }),
    });
  });
});
