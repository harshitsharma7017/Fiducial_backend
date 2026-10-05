import { z } from 'zod';
import { IsoDateTimeSchema } from './common.ts';

export const HealthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  db: z.enum(['up', 'down']),
  version: z.string(),
  uptimeSeconds: z.number().int().nonnegative(),
  time: IsoDateTimeSchema,
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
