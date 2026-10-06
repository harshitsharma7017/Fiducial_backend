import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  type MasterVersion,
  type MasterVersionStats,
} from '../../../shared/index.ts';
import { Types } from 'mongoose';
import { toDecimal128 } from '../../../lib/decimal.ts';
import { writeAudit } from '../../audit/audit.service.ts';
import { MasterVersionModel, type MasterVersionDoc } from '../master-version.model.ts';
import { toMasterVersionDto } from '../masters.mapper.ts';
import { activateMasterVersions } from '../masters.service.ts';
import { OccupancyModel } from '../occupancy.model.ts';
import { PincodeModel } from '../pincode.model.ts';
import { parseIibWorkbook } from './iib-workbook.ts';
import {
  occupancyWarningCount,
  pincodeWarningCount,
  type ImportReport,
  type OccupancyRow,
  type PincodeRow,
} from './types.ts';

export interface ImportMastersOptions {
  filePath: string;
  /** Activate both versions after a successful import. */
  activate?: boolean;
  /** Effective date for activation: YYYY-MM-DD (midnight India time) or a date-time. */
  effectiveFrom?: string;
  /** User id the import is attributed to in the audit log. */
  importedBy?: string | null;
  /** Import again even if this exact file (same SHA-256) was imported before. */
  force?: boolean;
  batchSize?: number;
}

export interface ImportMastersResult {
  runId: string;
  report: ImportReport;
  occupancyVersion: MasterVersion;
  pincodeVersion: MasterVersion;
  /** The same file had been imported before, so no new versions were written. */
  alreadyImported: boolean;
  /** This run activated at least one version. */
  activated: boolean;
}

const DEFAULT_BATCH_SIZE = 1000;

const decimalOrNull = (value: string | null) => (value === null ? null : toDecimal128(value));

function occupancyDocument(row: OccupancyRow, versionId: Types.ObjectId) {
  return {
    versionId,
    serialNo: row.serialNo,
    tacCode: row.tacCode,
    description: row.description,
    riskGrade: row.riskGrade,
    iibRate: decimalOrNull(row.iibRate),
    iibRateNote: row.iibRateNote,
    fireRiskType: row.fireRiskType,
    terrorismRiskType: row.terrorismRiskType,
    minStfiRate: decimalOrNull(row.minStfiRate),
    minEqRates: {
      zone1: decimalOrNull(row.minEqRates.zone1),
      zone2: decimalOrNull(row.minEqRates.zone2),
      zone3: decimalOrNull(row.minEqRates.zone3),
      zone4: decimalOrNull(row.minEqRates.zone4),
    },
    sourceRow: row.sourceRow,
  };
}

function pincodeDocument(row: PincodeRow, versionId: Types.ObjectId) {
  return {
    versionId,
    pincode: row.pincode,
    state: row.state,
    district: row.district,
    eqZone: row.eqZone,
    eqRates: {
      residential: decimalOrNull(row.eqRates.residential),
      nonIndustrial: decimalOrNull(row.eqRates.nonIndustrial),
      industrial: decimalOrNull(row.eqRates.industrial),
    },
    sourceRow: row.sourceRow,
  };
}

function occupancyStats(report: ImportReport): MasterVersionStats {
  return {
    rowsRead: report.occupancy.rowsRead,
    recordsImported: report.occupancy.recordsValid,
    rowsSkipped: report.occupancy.rowsSkipped,
    warningCount: occupancyWarningCount(report),
    errorCount: report.occupancy.skippedRows.length,
  };
}

function pincodeStats(report: ImportReport): MasterVersionStats {
  return {
    rowsRead: report.pincode.rowsRead,
    recordsImported: report.pincode.recordsValid,
    rowsSkipped: report.pincode.rowsSkipped,
    warningCount: pincodeWarningCount(report),
    errorCount: report.pincode.skippedRows.length,
  };
}

async function insertInBatches<T>(
  rows: T[],
  batchSize: number,
  insert: (batch: T[]) => Promise<unknown>,
): Promise<void> {
  for (let start = 0; start < rows.length; start += batchSize) {
    await insert(rows.slice(start, start + batchSize));
  }
}

/** Removes the rows and draft versions this run created, so a failed run leaves nothing behind. */
async function removeRun(versionIds: Types.ObjectId[]): Promise<void> {
  if (versionIds.length === 0) return;
  await OccupancyModel.deleteMany({ versionId: { $in: versionIds } });
  await PincodeModel.deleteMany({ versionId: { $in: versionIds } });
  await MasterVersionModel.deleteMany({ _id: { $in: versionIds }, status: 'DRAFT' });
}

/**
 * Imports the IIB workbook as new DRAFT versions of the occupancy and pincode masters.
 *
 * - Existing versions are never modified: each run writes rows only under its own version ids.
 * - Re-running with the same file is a no-op (matched by SHA-256) unless `force` is set.
 * - A failed run removes its own partial data, so it can simply be run again.
 * - Versions are activated only when `activate` is set.
 */
export async function importMasters(options: ImportMastersOptions): Promise<ImportMastersResult> {
  const runId = `import-masters-${randomUUID()}`;
  const data = await readFile(options.filePath);
  const sourceSha256 = createHash('sha256').update(data).digest('hex');
  const sourceFileName = basename(options.filePath);
  const { occupancies, pincodes, report } = await parseIibWorkbook(data, {
    sourceFileName,
    sourceSha256,
  });
  const actorId = options.importedBy ?? null;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;

  let occupancyVersion: MasterVersionDoc | null = null;
  let pincodeVersion: MasterVersionDoc | null = null;
  let alreadyImported = false;

  if (!options.force) {
    [occupancyVersion, pincodeVersion] = await Promise.all([
      MasterVersionModel.findOne({ type: 'OCCUPANCY', sourceSha256 }, { report: 0 })
        .sort({ _id: -1 })
        .lean(),
      MasterVersionModel.findOne({ type: 'PINCODE', sourceSha256 }, { report: 0 })
        .sort({ _id: -1 })
        .lean(),
    ]);
    alreadyImported = occupancyVersion !== null && pincodeVersion !== null;
  }

  if (!alreadyImported) {
    const created: Types.ObjectId[] = [];
    const importedAt = new Date();
    const importedBy = actorId ? new Types.ObjectId(actorId) : null;
    try {
      const [occupancyDraft] = await MasterVersionModel.create([
        {
          type: 'OCCUPANCY',
          status: 'DRAFT',
          sourceFileName,
          sourceSha256,
          importedBy,
          importedAt,
          stats: occupancyStats(report),
          report: { ...report.occupancy, crossCheck: report.crossCheck },
        },
      ]);
      if (!occupancyDraft) throw new Error('Occupancy version was not created');
      created.push(occupancyDraft._id);

      const [pincodeDraft] = await MasterVersionModel.create([
        {
          type: 'PINCODE',
          status: 'DRAFT',
          sourceFileName,
          sourceSha256,
          importedBy,
          importedAt,
          stats: pincodeStats(report),
          report: { ...report.pincode, crossCheck: report.crossCheck },
        },
      ]);
      if (!pincodeDraft) throw new Error('Pincode version was not created');
      created.push(pincodeDraft._id);

      await insertInBatches(
        occupancies.map((row) => occupancyDocument(row, occupancyDraft._id)),
        batchSize,
        (batch) => OccupancyModel.insertMany(batch, { ordered: true }),
      );
      await insertInBatches(
        pincodes.map((row) => pincodeDocument(row, pincodeDraft._id)),
        batchSize,
        (batch) => PincodeModel.insertMany(batch, { ordered: true }),
      );

      for (const draft of [occupancyDraft, pincodeDraft]) {
        await writeAudit({
          userId: actorId,
          action: AUDIT_ACTIONS.MASTER_IMPORTED,
          entity: AUDIT_ENTITIES.MASTER_VERSION,
          entityId: draft._id.toHexString(),
          after: {
            type: draft.type,
            status: 'DRAFT',
            sourceFileName,
            sourceSha256,
            stats: draft.stats,
          },
          requestId: runId,
        });
      }

      occupancyVersion = occupancyDraft.toObject();
      pincodeVersion = pincodeDraft.toObject();
    } catch (error) {
      await removeRun(created);
      throw error;
    }
  }

  if (!occupancyVersion || !pincodeVersion) throw new Error('Import produced no versions');
  let occupancy = toMasterVersionDto(occupancyVersion);
  let pincode = toMasterVersionDto(pincodeVersion);
  let activated = false;

  if (options.activate) {
    const drafts = [occupancy, pincode].filter((version) => version.status === 'DRAFT');
    if (drafts.length > 0) {
      const results = await activateMasterVersions(
        drafts.map((version) => version.id),
        { effectiveFrom: options.effectiveFrom, actorId, requestId: runId },
      );
      for (const result of results) {
        if (result.type === 'OCCUPANCY') occupancy = result;
        else pincode = result;
      }
      activated = true;
    }
  }

  return {
    runId,
    report,
    occupancyVersion: occupancy,
    pincodeVersion: pincode,
    alreadyImported,
    activated,
  };
}
