import type { MasterImportQuery, MasterImportResult } from '../../shared/index.ts';
import { formatImportReport } from './import/format-report.ts';
import { buildIibWorkbook } from './import/iib-export.ts';
import { ImportStructureError } from './import/iib-workbook.ts';
import {
  importMasters,
  occupancyStats,
  pincodeStats,
  previewMasters,
} from './import/import-masters.ts';
import { MasterVersionModel, type MasterVersionDoc } from './master-version.model.ts';
import { getActiveVersion } from './masters.service.ts';
import { OccupancyModel } from './occupancy.model.ts';
import { PincodeModel } from './pincode.model.ts';

function fileProblem(sourceFileName: string, error: ImportStructureError): MasterImportResult {
  return {
    dryRun: true,
    sourceFileName,
    fileError: error.message,
    occupancy: null,
    pincode: null,
    reportText: null,
    alreadyImported: false,
    versions: [],
  };
}

/**
 * The Import data page's IIB master upload. A dry run checks the workbook and returns its
 * validation report; otherwise the occupancy and pincode masters are saved as new DRAFT versions
 * (audited), which an admin then activates. Nothing that is active changes here.
 */
export async function uploadMasters(
  data: Buffer,
  query: MasterImportQuery,
  actor: { id: string; requestId: string | null },
): Promise<MasterImportResult> {
  const sourceFileName = query.fileName;
  try {
    if (query.dryRun) {
      const { report, alreadyImported } = await previewMasters(data, sourceFileName);
      return {
        dryRun: true,
        sourceFileName,
        fileError: null,
        occupancy: occupancyStats(report),
        pincode: pincodeStats(report),
        reportText: formatImportReport(report),
        alreadyImported,
        versions: [],
      };
    }
    const result = await importMasters({
      data,
      sourceFileName,
      importedBy: actor.id,
      requestId: actor.requestId,
    });
    return {
      dryRun: false,
      sourceFileName,
      fileError: null,
      occupancy: occupancyStats(result.report),
      pincode: pincodeStats(result.report),
      reportText: formatImportReport(result.report),
      alreadyImported: result.alreadyImported,
      versions: [result.occupancyVersion, result.pincodeVersion],
    };
  } catch (error) {
    if (error instanceof ImportStructureError) return fileProblem(sourceFileName, error);
    throw error;
  }
}

/** The IIB rate column's year label the version was imported with, for example "2019". */
async function rateYearLabel(versionId: MasterVersionDoc['_id']): Promise<string | null> {
  const version = await MasterVersionModel.findById(versionId, {
    'report.rateYearLabel': 1,
  }).lean();
  const report = version?.report as { rateYearLabel?: unknown } | null | undefined;
  return typeof report?.rateYearLabel === 'string' ? report.rateYearLabel : null;
}

/**
 * The active occupancy and pincode masters as an IIB workbook, to edit and upload as the next
 * version; or, as a template, the same workbook with headers only.
 */
export async function masterWorkbook(template: boolean): Promise<Buffer> {
  if (template) return buildIibWorkbook({ occupancies: [], pincodes: [] });
  const [occupancyVersion, pincodeVersion] = await Promise.all([
    getActiveVersion('OCCUPANCY'),
    getActiveVersion('PINCODE'),
  ]);
  const [occupancies, pincodes, label] = await Promise.all([
    OccupancyModel.find({ versionId: occupancyVersion._id }).lean(),
    PincodeModel.find({ versionId: pincodeVersion._id }).lean(),
    rateYearLabel(occupancyVersion._id),
  ]);
  return buildIibWorkbook({ occupancies, pincodes, rateYearLabel: label });
}
