import { z } from 'zod';
import { ObjectIdSchema } from './common.ts';
import { FIRE_ITEM_KEYS, OTHER_SECTIONS, RISK_DETAIL_FIELDS } from './proposals.ts';

// Reading the client's own Data Sheet workbook (DS-08): each "data sheet" sheet is one risk
// location (its Fire lines, hypothecation, stock in the open and risk features); the other
// sections and the Annexure apply to the case. Nothing is saved: the values fill the Data Sheet
// form, to be checked and saved there.

/** Largest Data Sheet workbook accepted, in bytes. */
export const MAX_DATA_SHEET_BYTES = 5 * 1024 * 1024;

const Text = z.string().nullable();

export const DataSheetImportSchema = z.object({
  /** The insured as the sheet gives it, to compare with the case's client. */
  insured: z.object({
    name: Text,
    gstin: Text,
    address: Text,
    natureOfBusiness: Text,
    policyPeriod: Text,
  }),
  /** One per "data sheet" sheet, in the workbook's order. */
  locations: z.array(
    z.object({
      sheetName: z.string(),
      /** The Risk Location text of the sheet. */
      riskLocation: Text,
      /** The case location it most likely is (by name or address, else by order); null: none. */
      suggestedLocationId: ObjectIdSchema.nullable(),
      fire: z.array(
        z.object({
          key: z.enum(FIRE_ITEM_KEYS),
          sqFt: Text,
          ratePerSqFt: Text,
          amount: Text,
        }),
      ),
      hypothecation: Text,
      openStock: Text,
      /** By risk detail key (RISK_DETAIL_FIELDS); only the details the sheet answers. */
      risk: z.record(z.string(), z.string()),
    }),
  ),
  /** The other sections with something entered: their lines, sum insured and annexure rows. */
  sections: z.array(
    z.object({
      code: z.enum(OTHER_SECTIONS),
      lines: z.record(z.string(), z.string()),
      proposed1: Text,
      annexure: z.array(
        z.object({
          description: z.string(),
          quantity: Text,
          dimensions: Text,
          makeModel: Text,
          serialNo: Text,
          year: Text,
          sumInsured: z.string(),
        }),
      ),
    }),
  ),
  /** What was read with a doubt, or left out, in words. */
  warnings: z.array(z.string()),
});
export type DataSheetImport = z.infer<typeof DataSheetImportSchema>;

export const DataSheetImportQuerySchema = z.strictObject({
  fileName: z.string().trim().min(1).max(200).default('data-sheet.xlsx'),
});

/** The risk detail fields, by key, for the reader and the form. */
export const RISK_DETAIL_KEYS = RISK_DETAIL_FIELDS.map((field) => field.key);
