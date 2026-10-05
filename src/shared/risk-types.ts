import { z } from 'zod';

/** Risk types used by the IIB occupancy master for Fire and Terrorism. */
export const RISK_TYPES = ['RESIDENTIAL', 'NON_INDUSTRIAL', 'INDUSTRIAL'] as const;

export const RiskTypeSchema = z.enum(RISK_TYPES);
export type RiskType = z.infer<typeof RiskTypeSchema>;

export const RISK_TYPE_LABELS: Record<RiskType, string> = {
  RESIDENTIAL: 'Residential',
  NON_INDUSTRIAL: 'Non-industrial',
  INDUSTRIAL: 'Industrial',
};
