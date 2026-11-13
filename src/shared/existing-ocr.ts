import { z } from 'zod';
import { FIRE_GROUPS, OTHER_SECTIONS, SECTION_LINE_KEYS } from './proposals.ts';

// Reading the existing policy's sum insured from its schedule (a PDF or a picture) for the Data
// Sheet's Existing column. Separate from the Data Sheet workbook import: it fills only the
// Existing figures. Nothing is saved; the values fill the form, to be checked and saved there.

/** Largest policy file read, in bytes. */
export const MAX_EXISTING_OCR_BYTES = 10 * 1024 * 1024;
export const EXISTING_OCR_CONTENT_TYPES = ['application/pdf', 'image/png', 'image/jpeg'] as const;

const Rupees = z
  .string()
  .regex(/^\d{1,13}$/)
  .nullable();

export const ExistingOcrSchema = z.object({
  reader: z.enum(['GEMINI']).nullable(),
  /** True when nothing could be read: the figures are typed by hand. */
  manualEntryRequired: z.boolean(),
  /** Why, or a general remark for the reviewer. */
  message: z.string().nullable(),
  insurer: z.string().nullable(),
  policyNumber: z.string().nullable(),
  /** Whole rupees, by Fire line. */
  fireLines: z.array(z.object({ group: z.enum(FIRE_GROUPS), amount: Rupees })),
  /** The Fire total sum insured when the schedule gives no lines. */
  fireTotal: Rupees,
  sections: z.array(
    z.object({
      code: z.enum(OTHER_SECTIONS),
      existing: Rupees,
      existingLines: z.record(z.enum(SECTION_LINE_KEYS), z.string()),
    }),
  ),
  /** What was read with a doubt, or left out, in words. */
  warnings: z.array(z.string()),
});
export type ExistingOcr = z.infer<typeof ExistingOcrSchema>;

export const ExistingOcrQuerySchema = z.strictObject({
  fileName: z.string().trim().min(1).max(200).default('existing-policy.pdf'),
});
