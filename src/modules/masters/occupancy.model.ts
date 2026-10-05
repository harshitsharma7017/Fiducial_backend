import { RISK_GRADES, RISK_TYPES, type RiskGrade, type RiskType } from '../../shared/index.ts';
import { Schema, model, type Types } from 'mongoose';

export interface ZoneRatesDoc {
  zone1: Types.Decimal128 | null;
  zone2: Types.Decimal128 | null;
  zone3: Types.Decimal128 | null;
  zone4: Types.Decimal128 | null;
}

export interface OccupancyDoc {
  _id: Types.ObjectId;
  versionId: Types.ObjectId;
  serialNo: number | null;
  /** Text, never a number: the sheet mixes 1001 and 1001_2. */
  tacCode: string;
  description: string;
  riskGrade: RiskGrade | null;
  /** Per mille. Null when the sheet holds text instead (kept in iibRateNote). */
  iibRate: Types.Decimal128 | null;
  iibRateNote: string | null;
  fireRiskType: RiskType | null;
  terrorismRiskType: RiskType | null;
  minStfiRate: Types.Decimal128 | null;
  /** Minimum EQ rate per mille by zone; zone1 is "Zone I". */
  minEqRates: ZoneRatesDoc;
  /** Row number in the source sheet, for tracing data issues. */
  sourceRow: number;
}

const decimal = { type: Schema.Types.Decimal128, default: null };

const zoneRatesSchema = new Schema<ZoneRatesDoc>(
  { zone1: decimal, zone2: decimal, zone3: decimal, zone4: decimal },
  { _id: false },
);

const occupancySchema = new Schema<OccupancyDoc>(
  {
    versionId: { type: Schema.Types.ObjectId, ref: 'MasterVersion', required: true },
    serialNo: { type: Number, default: null },
    tacCode: { type: String, required: true },
    // Blank descriptions are imported (and reported) rather than rejected.
    description: { type: String, default: '' },
    riskGrade: { type: String, enum: RISK_GRADES, default: null },
    iibRate: decimal,
    iibRateNote: { type: String, default: null },
    fireRiskType: { type: String, enum: RISK_TYPES, default: null },
    terrorismRiskType: { type: String, enum: RISK_TYPES, default: null },
    minStfiRate: decimal,
    minEqRates: { type: zoneRatesSchema, required: true },
    sourceRow: { type: Number, required: true },
  },
  { collection: 'occupancies', versionKey: false, strict: 'throw' },
);

occupancySchema.index({ versionId: 1, tacCode: 1 }, { unique: true });
occupancySchema.index({ versionId: 1, _id: 1 });

export const OccupancyModel = model<OccupancyDoc>('Occupancy', occupancySchema);
