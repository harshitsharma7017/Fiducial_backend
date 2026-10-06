import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';

type Cell = string | number | null;

/** S No, TAC code, description, grade, IIB, Fire type, Terrorism type, STFI, Zone IV, III, II, I */
export type OccupancySheetRow = [
  Cell,
  Cell,
  Cell,
  Cell,
  Cell,
  Cell,
  Cell,
  Cell,
  Cell,
  Cell,
  Cell,
  Cell,
];

/** Pincode, state, district, zone, residential, non-industrial, industrial */
export type PincodeSheetRow = [Cell, Cell, Cell, Cell, Cell, Cell, Cell];

export const STANDARD_OCCUPANCIES: OccupancySheetRow[] = [
  [1, 1001, 'Dwellings', 'RG1', 0.14, 'Residential', 'Residential', 0.075, 0.05, 0.05, 0.05, 0.05],
  [
    2,
    '1001_2',
    'Dwellings: Cooperative Society',
    'RG2',
    0.24,
    'N Industrial',
    'Residential',
    0.22,
    0.05000000000000002,
    0.1,
    0.15,
    0.25,
  ],
  [
    3,
    2001,
    'Abrasive Manufacturing',
    'RG3',
    0.69,
    'Industrial',
    'Industrial',
    0.37,
    0.04999999999999999,
    0.09999999999999998,
    0.25,
    0.5,
  ],
  [4, 2075, 'Engineering Workshop', 'RG4', 0.32, 'Industrial', ' ', 0.37, 0.05, 0.1, 0.25, 0.5],
  [
    5,
    2191,
    'Tiny sector ',
    'RG4',
    'As per existing rate built in SME Pre UW Product',
    'Industrial',
    'Industrial',
    null,
    null,
    null,
    null,
    null,
  ],
];

export const STANDARD_PINCODES: PincodeSheetRow[] = [
  [100000, 'Gujarat', 'Kachchh', 1, 0.05, 0.25, 0.5],
  [110001, 'Delhi', 'Central Delhi', 2, 0.05, 0.15, 0.25],
  [400001, 'Mumbai', 'Mumbai', 3, 0.05, 0.1, 0.1],
  [207001, 'Uttar Pradesh', 'Etah', 3, 0.05, 0.1, 0.1],
  [207001, 'Uttar Pradesh', 'Etah', 3, 0.05, 0.1, 0.1],
  [12345, 'Delhi', 'Short', 2, 0.05, 0.15, 0.25],
  [500001, 'Andhra Pradesh', 'Hyderabad', 4, 0.05, 0.1, 0.1],
  [600001, 'Tamil Nadu', 'Chennai', 3, 0.05, 'n/a', 0.1],
];

export interface WorkbookOptions {
  occupancies?: OccupancySheetRow[];
  pincodes?: PincodeSheetRow[];
  /** Leave out a sheet to test structure validation. */
  omitSheet?: 'IIB Code' | 'Pincode';
  /** Replace the "Zone I" header to test header validation. */
  badZoneHeader?: boolean;
}

/** Builds a workbook laid out like data/IIB_Code_Master.xlsx. */
export async function buildIibWorkbook(options: WorkbookOptions = {}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();

  if (options.omitSheet !== 'IIB Code') {
    const sheet = workbook.addWorksheet('IIB Code');
    sheet.getRow(1).values = [
      'Rates ',
      null,
      null,
      null,
      'IIB Rate %0',
      'Type of Risk for Fire',
      'Type of Risk for Terrorism ',
      'Min STFI Rate',
      'Min EQ Rate %0',
      'Min EQ Rate %0',
      'Min EQ Rate %0',
      'Min EQ Rate %0',
    ];
    sheet.getRow(2).values = [
      'S No',
      'TAC Occupancy Code',
      'Occupancy Description',
      'Risk Grade',
      '2019\n',
      'Residential\nIndustrial\nN Industrial',
      'Residential Industrial N Industrial',
      '\n%0\n',
      'Zone IV',
      'Zone III',
      'Zone II',
      options.badZoneHeader ? 'Zone 1' : 'Zone I',
    ];
    (options.occupancies ?? STANDARD_OCCUPANCIES).forEach((row, index) => {
      sheet.getRow(index + 3).values = row;
    });
    // The legend in column V is not data.
    sheet.getCell('V3').value = 'Preferred';
    sheet.getCell('V4').value = 'Referred';
    sheet.getCell('V5').value = 'Declined';
  }

  if (options.omitSheet !== 'Pincode') {
    const sheet = workbook.addWorksheet('Pincode');
    sheet.getRow(1).values = [
      'Pincode',
      'State',
      'District',
      'AIFT Earthquake zone',
      'Residential Risk',
      'Non - Industrial Risk',
      'Industrial Risk',
    ];
    (options.pincodes ?? STANDARD_PINCODES).forEach((row, index) => {
      sheet.getRow(index + 2).values = row;
    });
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** Writes a workbook to a temporary file and returns its path. */
export async function writeWorkbookFile(
  options: WorkbookOptions = {},
  name = 'IIB_Test.xlsx',
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'fiducial-import-'));
  const path = join(directory, name);
  await writeFile(path, await buildIibWorkbook(options));
  return path;
}
