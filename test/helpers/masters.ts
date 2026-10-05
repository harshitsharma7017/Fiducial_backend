import type { MasterType, MasterVersionStatus, RiskGrade, RiskType } from '../../src/shared/index.ts';
import type { Types } from 'mongoose';
import { toDecimal128 } from '../../src/lib/decimal.ts';
import { MasterVersionModel } from '../../src/modules/masters/master-version.model.ts';
import { OccupancyModel } from '../../src/modules/masters/occupancy.model.ts';
import { PincodeModel } from '../../src/modules/masters/pincode.model.ts';

const d = (value: string | null) => (value === null ? null : toDecimal128(value));

interface OccupancyFixture {
  tacCode: string;
  description: string;
  riskGrade: RiskGrade | null;
  iibRate: string | null;
  iibRateNote?: string | null;
  fireRiskType: RiskType | null;
  terrorismRiskType: RiskType | null;
  minStfiRate: string | null;
  /** Zone I, II, III, IV */
  zones: [string | null, string | null, string | null, string | null];
}

interface PincodeFixture {
  pincode: string;
  state: string;
  district: string;
  eqZone: 1 | 2 | 3 | 4 | null;
  /** Residential, non-industrial, industrial */
  rates: [string | null, string | null, string | null];
}

const INDUSTRIAL_ZONES: OccupancyFixture['zones'] = ['0.5', '0.25', '0.1', '0.05'];

/** Values from the real IIB workbook, plus one synthetic row with a blank Fire risk type. */
export const OCCUPANCIES: OccupancyFixture[] = [
  {
    tacCode: '1001',
    description: 'Dwellings',
    riskGrade: 'RG1',
    iibRate: '0.14',
    fireRiskType: 'RESIDENTIAL',
    terrorismRiskType: 'RESIDENTIAL',
    minStfiRate: '0.075',
    zones: ['0.05', '0.05', '0.05', '0.05'],
  },
  {
    tacCode: '1001_2',
    description: 'Dwellings: Cooperative Society',
    riskGrade: 'RG2',
    iibRate: '0.24',
    fireRiskType: 'NON_INDUSTRIAL',
    terrorismRiskType: 'RESIDENTIAL',
    minStfiRate: '0.22',
    zones: ['0.25', '0.15', '0.1', '0.05'],
  },
  {
    tacCode: '2001',
    description: 'Abrasive Manufacturing',
    riskGrade: 'RG3',
    iibRate: '0.69',
    fireRiskType: 'INDUSTRIAL',
    terrorismRiskType: 'INDUSTRIAL',
    minStfiRate: '0.37',
    zones: INDUSTRIAL_ZONES,
  },
  {
    tacCode: '2002',
    description: 'Aerated Water Factories',
    riskGrade: 'RG4',
    iibRate: '0.32',
    fireRiskType: 'INDUSTRIAL',
    terrorismRiskType: 'INDUSTRIAL',
    minStfiRate: '0.37',
    zones: INDUSTRIAL_ZONES,
  },
  {
    tacCode: '2075',
    description: 'Engineering Workshop - Structural Steel fabricators',
    riskGrade: 'RG4',
    iibRate: '0.32',
    fireRiskType: 'INDUSTRIAL',
    terrorismRiskType: null,
    minStfiRate: '0.37',
    zones: INDUSTRIAL_ZONES,
  },
  {
    tacCode: '2191',
    description: 'Tiny sector',
    riskGrade: 'RG4',
    iibRate: null,
    iibRateNote: 'As per existing rate built in SME Pre UW Product',
    fireRiskType: 'INDUSTRIAL',
    terrorismRiskType: 'INDUSTRIAL',
    minStfiRate: null,
    zones: [null, null, null, null],
  },
  {
    tacCode: '3006',
    description: 'Electric Transmission / Distribution Lines',
    riskGrade: 'RG2',
    iibRate: '0.3',
    fireRiskType: 'INDUSTRIAL',
    terrorismRiskType: 'INDUSTRIAL',
    minStfiRate: '0.52',
    zones: ['0.5', '0.25', '0.225', '0.225'],
  },
  {
    tacCode: 'TEST_NO_FIRE_TYPE',
    description: 'Synthetic row with a blank Fire risk type',
    riskGrade: 'RG5',
    iibRate: '0.5',
    fireRiskType: null,
    terrorismRiskType: 'INDUSTRIAL',
    minStfiRate: '0.37',
    zones: INDUSTRIAL_ZONES,
  },
];

export const PINCODES: PincodeFixture[] = [
  {
    pincode: '400001',
    state: 'Mumbai',
    district: 'Mumbai',
    eqZone: 3,
    rates: ['0.05', '0.1', '0.1'],
  },
  {
    pincode: '110001',
    state: 'Delhi',
    district: 'Central Delhi',
    eqZone: 2,
    rates: ['0.05', '0.15', '0.25'],
  },
  {
    pincode: '768201',
    state: 'Orissa',
    district: 'Sambalpur',
    eqZone: 3,
    rates: ['0.05', '0.05', '0.05'],
  },
];

async function createVersion(
  type: MasterType,
  status: MasterVersionStatus,
  sourceFileName: string,
) {
  return MasterVersionModel.create({
    type,
    status,
    sourceFileName,
    sourceSha256: `fixture-${sourceFileName}`,
    importedAt: new Date('2026-10-01T00:00:00Z'),
    effectiveFrom: status === 'ACTIVE' ? new Date('2026-10-01T00:00:00Z') : null,
    activatedAt: status === 'ACTIVE' ? new Date('2026-10-01T00:00:00Z') : null,
    stats: { rowsRead: 0, recordsImported: 0, rowsSkipped: 0, warningCount: 0, errorCount: 0 },
  });
}

export async function insertOccupancies(versionId: Types.ObjectId, fixtures: OccupancyFixture[]) {
  await OccupancyModel.insertMany(
    fixtures.map((o, index) => ({
      versionId,
      serialNo: index + 1,
      tacCode: o.tacCode,
      description: o.description,
      riskGrade: o.riskGrade,
      iibRate: d(o.iibRate),
      iibRateNote: o.iibRateNote ?? null,
      fireRiskType: o.fireRiskType,
      terrorismRiskType: o.terrorismRiskType,
      minStfiRate: d(o.minStfiRate),
      minEqRates: {
        zone1: d(o.zones[0]),
        zone2: d(o.zones[1]),
        zone3: d(o.zones[2]),
        zone4: d(o.zones[3]),
      },
      sourceRow: index + 3,
    })),
  );
}

export async function insertPincodes(versionId: Types.ObjectId, fixtures: PincodeFixture[]) {
  await PincodeModel.insertMany(
    fixtures.map((p, index) => ({
      versionId,
      pincode: p.pincode,
      state: p.state,
      district: p.district,
      eqZone: p.eqZone,
      eqRates: {
        residential: d(p.rates[0]),
        nonIndustrial: d(p.rates[1]),
        industrial: d(p.rates[2]),
      },
      sourceRow: index + 2,
    })),
  );
}

/** Seeds ACTIVE occupancy and pincode masters, plus a DRAFT occupancy version with other rates. */
export async function seedMasters() {
  const occupancyVersion = await createVersion('OCCUPANCY', 'ACTIVE', 'fixture-active.xlsx');
  const pincodeVersion = await createVersion('PINCODE', 'ACTIVE', 'fixture-active.xlsx');
  await insertOccupancies(occupancyVersion._id, OCCUPANCIES);
  await insertPincodes(pincodeVersion._id, PINCODES);

  // A draft must never be visible to lookups or rating.
  const draftOccupancyVersion = await createVersion('OCCUPANCY', 'DRAFT', 'fixture-draft.xlsx');
  await insertOccupancies(draftOccupancyVersion._id, [
    {
      ...OCCUPANCIES.find((o) => o.tacCode === '2001')!,
      iibRate: '9.99',
      description: 'Draft only',
    },
    { ...OCCUPANCIES.find((o) => o.tacCode === '1001')!, tacCode: 'DRAFT_ONLY' },
  ]);

  return {
    occupancyVersionId: occupancyVersion._id.toHexString(),
    pincodeVersionId: pincodeVersion._id.toHexString(),
    draftOccupancyVersionId: draftOccupancyVersion._id.toHexString(),
  };
}
