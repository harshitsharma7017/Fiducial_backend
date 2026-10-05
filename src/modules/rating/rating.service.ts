import {
  EQ_RATE_KEY_BY_RISK_TYPE,
  EQ_ZONE_LABELS,
  ERROR_CODES,
  RATING_WARNING_CODES,
  RISK_TYPE_LABELS,
  type FirePremiumBreakdown,
  type FireRatingRequest,
  type FireRatingResponse,
  type Occupancy,
  type PincodeRecord,
  type RatingWarning,
} from '../../shared/index.ts';
import { Decimal, decimalString, moneyString } from '../../lib/decimal.ts';
import { unprocessable, type AppError } from '../../lib/errors.ts';
import { toMasterVersionRef, toOccupancyDto, toPincodeDto } from '../masters/masters.mapper.ts';
import { getActiveVersion } from '../masters/masters.service.ts';
import { OccupancyModel } from '../masters/occupancy.model.ts';
import { PincodeModel } from '../masters/pincode.model.ts';
import { resolveTerrorismRate } from './extension-points.ts';
import { calculateFire, type FireComponents, type FireRatingResult } from './fire.ts';

function masterDataError(message: string, details: Record<string, unknown>): AppError {
  return unprocessable(ERROR_CODES.MASTER_DATA_ERROR, message, details);
}

function componentStrings(
  values: FireComponents<Decimal>,
  format: (value: Decimal) => string,
): FireComponents<string> {
  return {
    fire: format(values.fire),
    stfi: format(values.stfi),
    earthquake: format(values.earthquake),
    terrorism: values.terrorism === null ? null : format(values.terrorism),
  };
}

export function toBreakdownDto(result: FireRatingResult): FirePremiumBreakdown {
  return {
    sumInsured: moneyString(result.sumInsured),
    rates: componentStrings(result.rates, decimalString),
    premiums: componentStrings(result.premiums, moneyString),
    basePremium: moneyString(result.basePremium),
    policyRate: decimalString(result.policyRate),
    totalBeforeTax: moneyString(result.totalBeforeTax),
    gstRatePercent: decimalString(result.gstRatePercent),
    gst: moneyString(result.gst),
    total: moneyString(result.total),
  };
}

function eqWarnings(occupancy: Occupancy, pincode: PincodeRecord, eqRate: string): RatingWarning[] {
  if (pincode.eqZone === null) {
    return [
      {
        code: RATING_WARNING_CODES.EQ_ZONE_MISSING,
        message: `Pincode ${pincode.pincode} has no earthquake zone, so its EQ rate could not be checked against the occupancy minimum.`,
      },
    ];
  }
  const zoneLabel = EQ_ZONE_LABELS[pincode.eqZone];
  const minimum = occupancy.minEqRates[`zone${pincode.eqZone}`];
  if (minimum === null) {
    return [
      {
        code: RATING_WARNING_CODES.OCCUPANCY_MIN_EQ_RATE_MISSING,
        message: `Occupancy ${occupancy.tacCode} has no minimum EQ rate for ${zoneLabel}, so the pincode EQ rate could not be checked.`,
        details: { zone: pincode.eqZone },
      },
    ];
  }
  if (new Decimal(eqRate).lessThan(minimum)) {
    return [
      {
        code: RATING_WARNING_CODES.EQ_RATE_BELOW_OCCUPANCY_MINIMUM,
        message: `The pincode EQ rate (${eqRate} per mille) is below the occupancy's minimum EQ rate for ${zoneLabel} (${minimum} per mille). The pincode rate was used.`,
        details: { zone: pincode.eqZone, pincodeRate: eqRate, occupancyMinimum: minimum },
      },
    ];
  }
  return [];
}

/**
 * Looks up the ACTIVE occupancy and pincode masters, prices the Fire section and returns the
 * breakdown with a snapshot of the versions and values used. Missing master values are raised
 * as data errors (422), never defaulted.
 */
export async function rateFire(
  request: FireRatingRequest,
  options: { gstRatePercent: string },
): Promise<FireRatingResponse> {
  const [occupancyVersion, pincodeVersion] = await Promise.all([
    getActiveVersion('OCCUPANCY'),
    getActiveVersion('PINCODE'),
  ]);
  const [occupancyDoc, pincodeDoc] = await Promise.all([
    OccupancyModel.findOne({
      versionId: occupancyVersion._id,
      tacCode: request.occupancyCode,
    }).lean(),
    PincodeModel.findOne({ versionId: pincodeVersion._id, pincode: request.pincode }).lean(),
  ]);

  if (!occupancyDoc) {
    throw unprocessable(
      ERROR_CODES.OCCUPANCY_NOT_FOUND,
      `Occupancy code ${request.occupancyCode} is not in the active occupancy master`,
      { occupancyCode: request.occupancyCode },
    );
  }
  if (!pincodeDoc) {
    throw unprocessable(
      ERROR_CODES.PINCODE_NOT_FOUND,
      `Pincode ${request.pincode} is not in the active pincode master`,
      { pincode: request.pincode },
    );
  }

  const occupancy = toOccupancyDto(occupancyDoc);
  const pincode = toPincodeDto(pincodeDoc);
  const where = { tacCode: occupancy.tacCode, versionId: occupancy.versionId };

  if (!occupancy.fireRiskType) {
    throw masterDataError(
      `Occupancy ${occupancy.tacCode} has no Fire risk type in the master, so the EQ rate cannot be chosen. Correct the master before rating.`,
      { ...where, field: 'fireRiskType' },
    );
  }
  if (occupancy.iibRate === null) {
    const note = occupancy.iibRateNote ? ` The master says: "${occupancy.iibRateNote}".` : '';
    throw masterDataError(`Occupancy ${occupancy.tacCode} has no numeric IIB rate.${note}`, {
      ...where,
      field: 'iibRate',
    });
  }
  if (occupancy.minStfiRate === null) {
    throw masterDataError(
      `Occupancy ${occupancy.tacCode} has no minimum STFI rate in the master.`,
      {
        ...where,
        field: 'minStfiRate',
      },
    );
  }

  const eqRiskType = occupancy.fireRiskType;
  const eqRate = pincode.eqRates[EQ_RATE_KEY_BY_RISK_TYPE[eqRiskType]];
  if (eqRate === null) {
    throw masterDataError(
      `Pincode ${pincode.pincode} has no ${RISK_TYPE_LABELS[eqRiskType]} EQ rate in the master.`,
      {
        pincode: pincode.pincode,
        versionId: pincode.versionId,
        field: 'eqRates',
        riskType: eqRiskType,
      },
    );
  }

  const terrorismRate = resolveTerrorismRate(
    request.terrorismRate === undefined ? null : new Decimal(request.terrorismRate),
  );

  const result = calculateFire({
    sumInsured: request.sumInsured,
    iibRate: occupancy.iibRate,
    stfiRate: occupancy.minStfiRate,
    eqRate,
    terrorismRate,
    gstRatePercent: options.gstRatePercent,
  });

  const warnings = eqWarnings(occupancy, pincode, eqRate);
  if (terrorismRate !== null && occupancy.terrorismRiskType === null) {
    warnings.push({
      code: RATING_WARNING_CODES.TERRORISM_RISK_TYPE_MISSING,
      message: `Occupancy ${occupancy.tacCode} has no Terrorism risk type in the master. Check that the terrorism rate supplied is right for this risk.`,
    });
  }

  return {
    input: {
      occupancyCode: request.occupancyCode,
      pincode: request.pincode,
      sumInsured: request.sumInsured,
      terrorismRate: terrorismRate === null ? null : decimalString(terrorismRate),
    },
    premium: toBreakdownDto(result),
    warnings,
    snapshot: {
      occupancyVersion: toMasterVersionRef(occupancyVersion),
      pincodeVersion: toMasterVersionRef(pincodeVersion),
      occupancy,
      pincode,
      eqRiskType,
    },
    calculatedAt: new Date().toISOString(),
  };
}
