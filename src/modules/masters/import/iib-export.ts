import type { RiskType } from '../../../shared/index.ts';
import ExcelJS from 'exceljs';
import type { Types } from 'mongoose';
import { decimal128ToString } from '../../../lib/decimal.ts';
import type { OccupancyDoc } from '../occupancy.model.ts';
import type { PincodeDoc } from '../pincode.model.ts';
import { OCCUPANCY_SHEET, PINCODE_SHEET } from './iib-workbook.ts';

// Writes the occupancy and pincode masters in the IIB workbook's own layout (the one
// parseIibWorkbook reads), so a downloaded master can be edited in Excel and uploaded as the
// next version. With no rows it is the blank template.

const RISK_TYPE_LABELS: Record<RiskType, string> = {
  RESIDENTIAL: 'Residential',
  NON_INDUSTRIAL: 'N Industrial',
  INDUSTRIAL: 'Industrial',
};

const HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFE8EEF6' },
};

/** A rate as a number cell (what the IIB workbook holds); blank when there is none. */
function rate(value: Types.Decimal128 | null): number | null {
  const text = decimal128ToString(value);
  return text === null ? null : Number(text);
}

function styleHeader(row: ExcelJS.Row) {
  row.font = { bold: true };
  row.alignment = { wrapText: true, vertical: 'top' };
  row.eachCell((cell) => {
    cell.fill = HEADER_FILL;
  });
}

export interface IibWorkbookData {
  occupancies: readonly OccupancyDoc[];
  pincodes: readonly PincodeDoc[];
  /** The IIB rate column's year label (cell E2), for example "2019". */
  rateYearLabel?: string | null;
}

export async function buildIibWorkbook(data: IibWorkbookData): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Fiducial';

  const occupancy = workbook.addWorksheet(OCCUPANCY_SHEET, {
    views: [{ state: 'frozen', ySplit: 2 }],
  });
  occupancy.columns = [
    { width: 6 },
    { width: 12, style: { numFmt: '@' } },
    { width: 60 },
    { width: 10 },
    { width: 12 },
    { width: 14 },
    { width: 14 },
    { width: 10 },
    { width: 9 },
    { width: 9 },
    { width: 9 },
    { width: 9 },
  ];
  occupancy.getRow(1).values = [
    'Rates',
    null,
    null,
    null,
    'IIB Rate %0',
    'Type of Risk for Fire',
    'Type of Risk for Terrorism',
    'Min STFI Rate',
    'Min EQ Rate %0',
    'Min EQ Rate %0',
    'Min EQ Rate %0',
    'Min EQ Rate %0',
  ];
  occupancy.getRow(2).values = [
    'S No',
    'TAC Occupancy Code',
    'Occupancy Description',
    'Risk Grade',
    data.rateYearLabel ?? 'Rate',
    'Residential / Industrial / N Industrial',
    'Residential / Industrial / N Industrial',
    '%0',
    'Zone IV',
    'Zone III',
    'Zone II',
    'Zone I',
  ];
  styleHeader(occupancy.getRow(1));
  styleHeader(occupancy.getRow(2));
  const occupancies = [...data.occupancies].sort((a, b) => a.sourceRow - b.sourceRow);
  occupancies.forEach((row, index) => {
    occupancy.getRow(index + 3).values = [
      row.serialNo ?? index + 1,
      row.tacCode,
      row.description,
      row.riskGrade,
      // A rate the sheet gave as text is kept as that text, so it survives a round trip.
      rate(row.iibRate) ?? row.iibRateNote,
      row.fireRiskType ? RISK_TYPE_LABELS[row.fireRiskType] : null,
      row.terrorismRiskType ? RISK_TYPE_LABELS[row.terrorismRiskType] : null,
      rate(row.minStfiRate),
      rate(row.minEqRates.zone4),
      rate(row.minEqRates.zone3),
      rate(row.minEqRates.zone2),
      rate(row.minEqRates.zone1),
    ];
  });

  const pincode = workbook.addWorksheet(PINCODE_SHEET, {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  pincode.columns = [
    { width: 10 },
    { width: 22 },
    { width: 22 },
    { width: 12 },
    { width: 12 },
    { width: 14 },
    { width: 12 },
  ];
  pincode.getRow(1).values = [
    'Pincode',
    'State',
    'District',
    'AIFT Earthquake zone',
    'Residential Risk',
    'Non - Industrial Risk',
    'Industrial Risk',
  ];
  styleHeader(pincode.getRow(1));
  const pincodes = [...data.pincodes].sort((a, b) => a.sourceRow - b.sourceRow);
  pincodes.forEach((row, index) => {
    pincode.getRow(index + 2).values = [
      Number(row.pincode),
      row.state,
      row.district,
      row.eqZone,
      rate(row.eqRates.residential),
      rate(row.eqRates.nonIndustrial),
      rate(row.eqRates.industrial),
    ];
  });

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
