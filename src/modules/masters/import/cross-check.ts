import {
  EQ_RATE_KEY_BY_RISK_TYPE,
  EQ_ZONES,
  RISK_TYPES,
  type EqZone,
  type RiskType,
} from '../../../shared/index.ts';
import type { CrossCheckReport, OccupancyRow, PincodeRow, ZoneRateValues } from './types.ts';

const SAMPLE_SIZE = 5;

type ZoneKey = `zone${EqZone}`;
const zoneKey = (zone: EqZone): ZoneKey => `zone${zone}`;

/** Most common non-null value; ties go to the value seen first. */
function mostCommon(values: Array<string | null>): string | null {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (value !== null) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Checks that each pincode's EQ rate for a risk type equals the occupancy sheet's minimum EQ
 * rate for the same zone (pincode zone 1 = "Zone I"). The occupancy sheet repeats those rates
 * on every row, so the reference is the most common value per risk type and zone; occupancies
 * that differ from it are listed separately. Mismatches are reported, never corrected.
 */
export function crossCheckEqRates(
  occupancies: OccupancyRow[],
  pincodes: PincodeRow[],
): CrossCheckReport {
  const reference = {} as Record<RiskType, ZoneRateValues>;
  for (const riskType of RISK_TYPES) {
    const group = occupancies.filter((occupancy) => occupancy.fireRiskType === riskType);
    reference[riskType] = {
      zone1: mostCommon(group.map((occupancy) => occupancy.minEqRates.zone1)),
      zone2: mostCommon(group.map((occupancy) => occupancy.minEqRates.zone2)),
      zone3: mostCommon(group.map((occupancy) => occupancy.minEqRates.zone3)),
      zone4: mostCommon(group.map((occupancy) => occupancy.minEqRates.zone4)),
    };
  }

  const occupancyDeviations: CrossCheckReport['occupancyDeviations'] = [];
  for (const occupancy of occupancies) {
    if (!occupancy.fireRiskType) continue;
    const expected = reference[occupancy.fireRiskType];
    const zones: Array<{ zone: EqZone; value: string; reference: string }> = [];
    for (const zone of EQ_ZONES) {
      const value = occupancy.minEqRates[zoneKey(zone)];
      const referenceValue = expected[zoneKey(zone)];
      // Blank cells are already reported as non-numeric rates.
      if (value !== null && referenceValue !== null && value !== referenceValue) {
        zones.push({ zone, value, reference: referenceValue });
      }
    }
    if (zones.length > 0) {
      occupancyDeviations.push({
        row: occupancy.sourceRow,
        tacCode: occupancy.tacCode,
        riskType: occupancy.fireRiskType,
        zones,
      });
    }
  }

  const groups = new Map<string, CrossCheckReport['mismatchGroups'][number]>();
  let pincodesWithMismatch = 0;
  for (const pincode of pincodes) {
    if (pincode.eqZone === null) continue;
    let mismatched = false;
    for (const riskType of RISK_TYPES) {
      const expected = reference[riskType][zoneKey(pincode.eqZone)];
      if (expected === null) continue;
      const actual = pincode.eqRates[EQ_RATE_KEY_BY_RISK_TYPE[riskType]];
      if (actual === expected) continue;
      mismatched = true;
      const key = `${pincode.eqZone}|${riskType}|${actual ?? 'blank'}`;
      const group = groups.get(key) ?? {
        zone: pincode.eqZone,
        riskType,
        pincodeRate: actual,
        expected,
        count: 0,
        samplePincodes: [],
      };
      group.count += 1;
      if (group.samplePincodes.length < SAMPLE_SIZE) group.samplePincodes.push(pincode.pincode);
      groups.set(key, group);
    }
    if (mismatched) pincodesWithMismatch += 1;
  }

  const mismatchGroups = [...groups.values()].sort(
    (a, b) => a.zone - b.zone || RISK_TYPES.indexOf(a.riskType) - RISK_TYPES.indexOf(b.riskType),
  );

  return { reference, occupancyDeviations, pincodesWithMismatch, mismatchGroups };
}
