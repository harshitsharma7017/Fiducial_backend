import { z } from 'zod';
import { DecimalStringSchema, IsoDateTimeSchema, ObjectIdSchema } from './common.ts';
import {
  MasterTypeSchema,
  OccupancySchema,
  PincodeRecordSchema,
  PincodeValueSchema,
  TacCodeSchema,
} from './masters.ts';
import { RiskTypeSchema } from './risk-types.ts';

/** Default GST on premium. The API reads the live value from configuration. */
export const DEFAULT_GST_RATE_PERCENT = '18';

/** Rupees with up to 2 decimals, as a string. */
export const SumInsuredSchema = z
  .string()
  .trim()
  .regex(/^\d{1,15}(\.\d{1,2})?$/, 'Enter an amount in rupees (digits only, up to 2 decimals)')
  .refine((value) => /[1-9]/.test(value), 'Sum insured must be greater than zero');

/** A rate per mille (per thousand of sum insured), as a string. */
export const PerMilleRateSchema = z
  .string()
  .trim()
  .regex(/^\d{1,4}(\.\d{1,6})?$/, 'Enter a rate per mille, for example 0.05');

export const FireRatingRequestSchema = z.strictObject({
  occupancyCode: TacCodeSchema,
  pincode: PincodeValueSchema,
  sumInsured: SumInsuredSchema,
  /** Optional terrorism rate per mille. The source of terrorism rates is still to be confirmed. */
  terrorismRate: PerMilleRateSchema.optional(),
});
export type FireRatingRequest = z.infer<typeof FireRatingRequestSchema>;

export const RATING_WARNING_CODES = {
  EQ_RATE_BELOW_OCCUPANCY_MINIMUM: 'EQ_RATE_BELOW_OCCUPANCY_MINIMUM',
  EQ_ZONE_MISSING: 'EQ_ZONE_MISSING',
  OCCUPANCY_MIN_EQ_RATE_MISSING: 'OCCUPANCY_MIN_EQ_RATE_MISSING',
  TERRORISM_RISK_TYPE_MISSING: 'TERRORISM_RISK_TYPE_MISSING',
} as const;

export const RatingWarningSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type RatingWarning = z.infer<typeof RatingWarningSchema>;

const ComponentValuesSchema = z.object({
  fire: DecimalStringSchema,
  stfi: DecimalStringSchema,
  earthquake: DecimalStringSchema,
  /** Null when no terrorism rate was supplied. */
  terrorism: DecimalStringSchema.nullable(),
});

export const FirePremiumBreakdownSchema = z.object({
  sumInsured: DecimalStringSchema,
  /** Component rates per mille. */
  rates: ComponentValuesSchema,
  /** Component premiums in rupees, 2 decimals. */
  premiums: ComponentValuesSchema,
  basePremium: DecimalStringSchema,
  /** Sum of the component rates included in the base premium, per mille. */
  policyRate: DecimalStringSchema,
  totalBeforeTax: DecimalStringSchema,
  gstRatePercent: DecimalStringSchema,
  gst: DecimalStringSchema,
  total: DecimalStringSchema,
});
export type FirePremiumBreakdown = z.infer<typeof FirePremiumBreakdownSchema>;

export const MasterVersionRefSchema = z.object({
  id: ObjectIdSchema,
  type: MasterTypeSchema,
  sourceFileName: z.string(),
  effectiveFrom: IsoDateTimeSchema.nullable(),
  activatedAt: IsoDateTimeSchema.nullable(),
});
export type MasterVersionRef = z.infer<typeof MasterVersionRefSchema>;

export const FireRatingResponseSchema = z.object({
  input: z.object({
    occupancyCode: z.string(),
    pincode: z.string(),
    sumInsured: DecimalStringSchema,
    terrorismRate: DecimalStringSchema.nullable(),
  }),
  premium: FirePremiumBreakdownSchema,
  warnings: z.array(RatingWarningSchema),
  /** The master versions and values used, so the calculation can be reproduced later. */
  snapshot: z.object({
    occupancyVersion: MasterVersionRefSchema,
    pincodeVersion: MasterVersionRefSchema,
    occupancy: OccupancySchema,
    pincode: PincodeRecordSchema,
    /** The occupancy's Fire risk type, used to pick the pincode EQ rate. */
    eqRiskType: RiskTypeSchema,
  }),
  calculatedAt: IsoDateTimeSchema,
});
export type FireRatingResponse = z.infer<typeof FireRatingResponseSchema>;
