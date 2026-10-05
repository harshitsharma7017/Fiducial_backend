import type {
  MasterVersion,
  MasterVersionRef,
  Occupancy,
  PincodeRecord,
} from '../../shared/index.ts';
import { decimal128ToString } from '../../lib/decimal.ts';
import type { MasterVersionDoc } from './master-version.model.ts';
import type { OccupancyDoc } from './occupancy.model.ts';
import type { PincodeDoc } from './pincode.model.ts';

// Decimal128 values always leave the API as strings.

export function toOccupancyDto(doc: OccupancyDoc): Occupancy {
  return {
    id: doc._id.toHexString(),
    versionId: doc.versionId.toHexString(),
    serialNo: doc.serialNo,
    tacCode: doc.tacCode,
    description: doc.description,
    riskGrade: doc.riskGrade,
    iibRate: decimal128ToString(doc.iibRate),
    iibRateNote: doc.iibRateNote,
    fireRiskType: doc.fireRiskType,
    terrorismRiskType: doc.terrorismRiskType,
    minStfiRate: decimal128ToString(doc.minStfiRate),
    minEqRates: {
      zone1: decimal128ToString(doc.minEqRates.zone1),
      zone2: decimal128ToString(doc.minEqRates.zone2),
      zone3: decimal128ToString(doc.minEqRates.zone3),
      zone4: decimal128ToString(doc.minEqRates.zone4),
    },
  };
}

export function toPincodeDto(doc: PincodeDoc): PincodeRecord {
  return {
    id: doc._id.toHexString(),
    versionId: doc.versionId.toHexString(),
    pincode: doc.pincode,
    state: doc.state,
    district: doc.district,
    eqZone: doc.eqZone,
    eqRates: {
      residential: decimal128ToString(doc.eqRates.residential),
      nonIndustrial: decimal128ToString(doc.eqRates.nonIndustrial),
      industrial: decimal128ToString(doc.eqRates.industrial),
    },
  };
}

export function toMasterVersionDto(doc: MasterVersionDoc): MasterVersion {
  return {
    id: doc._id.toHexString(),
    type: doc.type,
    status: doc.status,
    sourceFileName: doc.sourceFileName,
    sourceSha256: doc.sourceSha256,
    importedBy: doc.importedBy ? doc.importedBy.toHexString() : null,
    importedAt: doc.importedAt.toISOString(),
    effectiveFrom: doc.effectiveFrom ? doc.effectiveFrom.toISOString() : null,
    effectiveTo: doc.effectiveTo ? doc.effectiveTo.toISOString() : null,
    activatedBy: doc.activatedBy ? doc.activatedBy.toHexString() : null,
    activatedAt: doc.activatedAt ? doc.activatedAt.toISOString() : null,
    stats: {
      rowsRead: doc.stats.rowsRead,
      recordsImported: doc.stats.recordsImported,
      rowsSkipped: doc.stats.rowsSkipped,
      warningCount: doc.stats.warningCount,
      errorCount: doc.stats.errorCount,
    },
  };
}

export function toMasterVersionRef(doc: MasterVersionDoc): MasterVersionRef {
  return {
    id: doc._id.toHexString(),
    type: doc.type,
    sourceFileName: doc.sourceFileName,
    effectiveFrom: doc.effectiveFrom ? doc.effectiveFrom.toISOString() : null,
    activatedAt: doc.activatedAt ? doc.activatedAt.toISOString() : null,
  };
}
