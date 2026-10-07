import { z } from 'zod';
import { IsoDateTimeSchema, ObjectIdSchema } from './common.ts';
import { groupIndianDigits } from './format.ts';
import { OTHER_SECTIONS } from './proposals.ts';

// Product and cover masters (M-4 to M-9): products with sum insured ranges, the 14 coverage
// sections, the add-on lists, the BSUS/BLUS add-on limits and rates, the GST rate with effective
// dates, and the standard notes printed on documents. All of it is data: loaded from one Excel
// workbook (a sheet per master), downloaded back in the same layout, and edited on screen by
// Admins. Nothing here is built into the code except the sheet layouts.

export const CATALOG_MASTERS = [
  'products',
  'sections',
  'addons',
  'addon-rules',
  'tax-rates',
  'notes',
] as const;
export const CatalogMasterSchema = z.enum(CATALOG_MASTERS);
export type CatalogMaster = z.infer<typeof CatalogMasterSchema>;

/** Every coverage section of the Data Sheet. FIRE is first in every document. */
export const SECTION_CODES = ['FIRE', ...OTHER_SECTIONS] as const;
export type SectionCode = (typeof SECTION_CODES)[number];

export const ADDON_LISTS = ['FIRE_ADDITIONAL', 'PAR', 'SFSP', 'BSUS_BLUS'] as const;
export type AddonList = (typeof ADDON_LISTS)[number];
export const ADDON_LIST_LABELS: Record<AddonList, string> = {
  FIRE_ADDITIONAL: 'Fire additional',
  PAR: 'PAR',
  SFSP: 'SFSP',
  BSUS_BLUS: 'BSUS & BLUS',
};

export const ADDON_KINDS = ['PAID', 'INBUILT'] as const;
export type AddonKind = (typeof ADDON_KINDS)[number];

/**
 * How a BSUS/BLUS paid add-on is priced (document 05, section 5). "Policy rate" is the base
 * policy's rate per mille; the rate factor is a percentage of it.
 */
export const ADDON_CALC_TYPES = [
  'PCT_OF_SI_BASE',
  'FLAT_CAP',
  'SPECIFIED_SI',
  'ESCALATION',
  'POLICY_SI',
] as const;
export type AddonCalcType = (typeof ADDON_CALC_TYPES)[number];
export const ADDON_CALC_TYPE_LABELS: Record<AddonCalcType, string> = {
  PCT_OF_SI_BASE: 'Rate on a % of sum insured',
  FLAT_CAP: 'Rate on a % of sum insured, cover capped',
  SPECIFIED_SI: 'Rate on a specified sum insured',
  ESCALATION: 'Rate on the selected escalation %',
  POLICY_SI: 'Rate on the policy sum insured',
};

export const TAX_CODES = ['GST'] as const;
export type TaxCode = (typeof TAX_CODES)[number];

// Cell values and their parsing

export const CATALOG_COLUMN_TYPES = [
  'code',
  'text',
  'longtext',
  'rupees',
  'percent',
  'integer',
  'date',
  'yesno',
  'list',
  'enum',
] as const;
export type CatalogColumnType = (typeof CATALOG_COLUMN_TYPES)[number];

export interface CatalogColumn {
  key: string;
  /** Row 1 of the sheet. Matched ignoring case, spaces and a trailing "*". */
  header: string;
  type: CatalogColumnType;
  required: boolean;
  /** For enum columns. */
  options?: readonly string[];
  note: string;
}

export interface CatalogSheet {
  master: CatalogMaster;
  /** Screen and sheet title. */
  label: string;
  sheetName: string;
  description: string;
  columns: readonly CatalogColumn[];
  /** The columns that name a row; two rows may not share them. */
  keyColumns: readonly string[];
}

const YES = ['yes', 'y', 'true', '1'];
const NO = ['no', 'n', 'false', '0'];

const textCell = (max: number, message = 'This is too long') => z.string().trim().max(max, message);
const RupeesSchema = z
  .string()
  .regex(/^\d{1,13}$/, 'Enter whole rupees, digits only (for example 50000000 for 5 Cr)');
const PercentSchema = z
  .string()
  .regex(/^\d{1,3}(\.\d{1,4})?$/, 'Enter a percentage, for example 18 or 2.5')
  .refine((value) => Number(value) <= 100, 'A percentage cannot be over 100');
const CodeSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{1,39}$/, 'Use capital letters, digits and _ (for example BSUS)');
const OrderSchema = z.number().int('Enter a whole number').min(1).max(9999);
const ListSchema = z.array(textCell(300).min(1)).max(50, 'At most 50 entries');

export const ProductRowSchema = z
  .strictObject({
    code: CodeSchema,
    name: textCell(200).min(1, 'Enter the product name'),
    /** Suggested when the sum insured is above this (exclusive). Null: from zero. */
    aboveSi: RupeesSchema.nullable(),
    /** Suggested up to and including this. Null: no upper limit. */
    upToSi: RupeesSchema.nullable(),
    order: OrderSchema,
    active: z.boolean(),
    notes: textCell(500).nullable(),
  })
  .refine(
    (row) =>
      row.aboveSi === null || row.upToSi === null || BigInt(row.aboveSi) < BigInt(row.upToSi),
    { path: ['upToSi'], message: 'The upper limit must be above the lower limit' },
  );
export type ProductRow = z.infer<typeof ProductRowSchema>;

export const SectionRowSchema = z
  .strictObject({
    code: z.enum(SECTION_CODES, { error: `Use one of ${SECTION_CODES.join(', ')}` }),
    name: textCell(200).min(1, 'Enter the section name'),
    order: OrderSchema,
    active: z.boolean(),
    /** The schedule lines captured for the section. */
    fields: ListSchema,
    /** The add-on covers printed under the section on the RFQ. */
    addons: ListSchema,
  })
  .refine((row) => row.code !== 'FIRE' || row.active, {
    path: ['active'],
    message: 'Fire cannot be switched off',
  });
export type SectionRow = z.infer<typeof SectionRowSchema>;

export const AddonRowSchema = z.strictObject({
  list: z.enum(ADDON_LISTS, { error: `Use one of ${ADDON_LISTS.join(', ')}` }),
  seq: OrderSchema,
  name: textCell(300).min(1, 'Enter the add-on cover'),
  /** BSUS & BLUS only: paid or inbuilt. */
  kind: z.enum(ADDON_KINDS, { error: 'Use PAID or INBUILT' }).nullable(),
  /** The sum insured limit as the client words it. */
  limit: textCell(1000).nullable(),
  active: z.boolean(),
});
export type AddonRow = z.infer<typeof AddonRowSchema>;

export const AddonRuleRowSchema = z
  .strictObject({
    seq: OrderSchema,
    name: textCell(300).min(1, 'Enter the add-on cover'),
    sookshmaLimit: textCell(500).min(1, 'Enter the Sookshma (BSUS) cover limit'),
    laghuLimit: textCell(500).min(1, 'Enter the Laghu (BLUS) cover limit'),
    calcType: z.enum(ADDON_CALC_TYPES, { error: `Use one of ${ADDON_CALC_TYPES.join(', ')}` }),
    /** Percentage of the policy rate. */
    rateFactorPct: PercentSchema,
    /** Percentage of the sum insured the rate applies to (PCT_OF_SI_BASE, FLAT_CAP). */
    basePct: PercentSchema.nullable(),
    /** ESCALATION: the highest percentage that can be selected. */
    maxSelectablePct: PercentSchema.nullable(),
    sookshmaCap: RupeesSchema.nullable(),
    laghuCap: RupeesSchema.nullable(),
    /** The cap applies per block (cold storage, spoilage). */
    perBlock: z.boolean(),
    active: z.boolean(),
  })
  .superRefine((row, context) => {
    if ((row.calcType === 'PCT_OF_SI_BASE' || row.calcType === 'FLAT_CAP') && !row.basePct) {
      context.addIssue({
        code: 'custom',
        path: ['basePct'],
        message: 'Enter the % of sum insured the rate applies to',
      });
    }
    if (row.calcType === 'ESCALATION' && !row.maxSelectablePct) {
      context.addIssue({
        code: 'custom',
        path: ['maxSelectablePct'],
        message: 'Enter the highest escalation % that can be selected',
      });
    }
  });
export type AddonRuleRow = z.infer<typeof AddonRuleRowSchema>;

export const TaxRateRowSchema = z.strictObject({
  tax: z.enum(TAX_CODES, { error: 'Use GST' }),
  ratePercent: PercentSchema,
  effectiveFrom: z.iso.date({ error: 'Enter the date as YYYY-MM-DD' }),
  note: textCell(300).nullable(),
});
export type TaxRateRow = z.infer<typeof TaxRateRowSchema>;

export const NoteRowSchema = z.strictObject({
  code: CodeSchema,
  title: textCell(200).min(1, 'Enter a title'),
  text: textCell(4000).min(1, 'Enter the note'),
  onDataSheet: z.boolean(),
  onRfq: z.boolean(),
  onQcr: z.boolean(),
  onPlacementSlip: z.boolean(),
  order: OrderSchema,
  active: z.boolean(),
});
export type NoteRow = z.infer<typeof NoteRowSchema>;

export const CATALOG_ROW_SCHEMAS = {
  products: ProductRowSchema,
  sections: SectionRowSchema,
  addons: AddonRowSchema,
  'addon-rules': AddonRuleRowSchema,
  'tax-rates': TaxRateRowSchema,
  notes: NoteRowSchema,
} as const satisfies Record<CatalogMaster, z.ZodType>;

export interface CatalogRows {
  products: ProductRow;
  sections: SectionRow;
  addons: AddonRow;
  'addon-rules': AddonRuleRow;
  'tax-rates': TaxRateRow;
  notes: NoteRow;
}
export type CatalogRow = CatalogRows[CatalogMaster];

const YES_NO_NOTE = 'Yes or No.';

export const CATALOG_SHEETS: Record<CatalogMaster, CatalogSheet> = {
  products: {
    master: 'products',
    label: 'Products',
    sheetName: 'Products',
    description:
      'The policies a proposal can be placed under, with the sum insured range in which each is suggested.',
    keyColumns: ['code'],
    columns: [
      { key: 'code', header: 'Code', type: 'code', required: true, note: 'For example BSUS.' },
      { key: 'name', header: 'Name', type: 'text', required: true, note: 'As printed on the RFQ.' },
      {
        key: 'aboveSi',
        header: 'Sum insured above (Rs)',
        type: 'rupees',
        required: false,
        note: 'Suggested when the total sum insured is above this. Blank: from zero.',
      },
      {
        key: 'upToSi',
        header: 'Sum insured up to (Rs)',
        type: 'rupees',
        required: false,
        note: 'Suggested up to and including this. Blank: no upper limit.',
      },
      {
        key: 'order',
        header: 'Order',
        type: 'integer',
        required: true,
        note: '1 is listed first.',
      },
      { key: 'active', header: 'Active', type: 'yesno', required: true, note: YES_NO_NOTE },
      { key: 'notes', header: 'Notes', type: 'text', required: false, note: 'Optional.' },
    ],
  },
  sections: {
    master: 'sections',
    label: 'Coverage sections',
    sheetName: 'Coverage sections',
    description:
      'The 14 sections of the Data Sheet and RFQ: their names, order, whether they are offered, their schedule lines and add-on covers.',
    keyColumns: ['code'],
    columns: [
      {
        key: 'code',
        header: 'Code',
        type: 'enum',
        options: SECTION_CODES,
        required: true,
        note: 'One row for each of the 14 section codes.',
      },
      { key: 'name', header: 'Name', type: 'text', required: true, note: 'As printed.' },
      {
        key: 'order',
        header: 'Order',
        type: 'integer',
        required: true,
        note: 'Sections are listed in this order. Fire always comes first.',
      },
      {
        key: 'active',
        header: 'Active',
        type: 'yesno',
        required: true,
        note: 'No hides the section from new Data Sheets. Fire is always on.',
      },
      {
        key: 'fields',
        header: 'Schedule lines',
        type: 'list',
        required: false,
        note: 'Separate lines with a semicolon (;).',
      },
      {
        key: 'addons',
        header: 'Add-on covers',
        type: 'list',
        required: false,
        note: 'Printed under the section on the RFQ. Separate with a semicolon (;).',
      },
    ],
  },
  addons: {
    master: 'addons',
    label: 'Add-on covers',
    sheetName: 'Add-on covers',
    description:
      'The add-on lists from the client’s workbooks: Fire additional, PAR, SFSP, and BSUS & BLUS with their limits.',
    keyColumns: ['list', 'name'],
    columns: [
      {
        key: 'list',
        header: 'List',
        type: 'enum',
        options: ADDON_LISTS,
        required: true,
        note: ADDON_LISTS.join(', '),
      },
      { key: 'seq', header: 'S No', type: 'integer', required: true, note: 'Order in the list.' },
      { key: 'name', header: 'Add-on cover', type: 'text', required: true, note: '' },
      {
        key: 'kind',
        header: 'Type',
        type: 'enum',
        options: ADDON_KINDS,
        required: false,
        note: 'BSUS & BLUS only: PAID or INBUILT.',
      },
      {
        key: 'limit',
        header: 'Sum insured limit',
        type: 'longtext',
        required: false,
        note: 'BSUS & BLUS only, as worded by the client.',
      },
      { key: 'active', header: 'Active', type: 'yesno', required: true, note: YES_NO_NOTE },
    ],
  },
  'addon-rules': {
    master: 'addon-rules',
    label: 'BSUS & BLUS add-on limits and rates',
    sheetName: 'BSUS BLUS add-on rates',
    description:
      'The paid add-ons of Bharat Sookshma (BSUS) and Bharat Laghu (BLUS): cover limit and cap for each scheme, and the rate formula.',
    keyColumns: ['seq'],
    columns: [
      { key: 'seq', header: 'S No', type: 'integer', required: true, note: '1 to 15.' },
      { key: 'name', header: 'Add-on cover', type: 'text', required: true, note: '' },
      {
        key: 'sookshmaLimit',
        header: 'Cover limit - Sookshma (BSUS)',
        type: 'longtext',
        required: true,
        note: 'As on the Sookshma chart.',
      },
      {
        key: 'laghuLimit',
        header: 'Cover limit - Laghu (BLUS)',
        type: 'longtext',
        required: true,
        note: 'As on the Laghu chart.',
      },
      {
        key: 'calcType',
        header: 'Calculation',
        type: 'enum',
        options: ADDON_CALC_TYPES,
        required: true,
        note: 'PCT_OF_SI_BASE, FLAT_CAP, SPECIFIED_SI, ESCALATION or POLICY_SI.',
      },
      {
        key: 'rateFactorPct',
        header: 'Rate (% of policy rate)',
        type: 'percent',
        required: true,
        note: 'For example 2.5 for 2.5% of the policy rate.',
      },
      {
        key: 'basePct',
        header: 'On % of sum insured',
        type: 'percent',
        required: false,
        note: 'PCT_OF_SI_BASE and FLAT_CAP: the % of sum insured the rate applies to.',
      },
      {
        key: 'maxSelectablePct',
        header: 'Max selectable %',
        type: 'percent',
        required: false,
        note: 'ESCALATION: the highest % that can be chosen.',
      },
      {
        key: 'sookshmaCap',
        header: 'Cap - Sookshma (Rs)',
        type: 'rupees',
        required: false,
        note: 'Blank when there is no cap.',
      },
      {
        key: 'laghuCap',
        header: 'Cap - Laghu (Rs)',
        type: 'rupees',
        required: false,
        note: 'Blank when there is no cap.',
      },
      {
        key: 'perBlock',
        header: 'Cap per block',
        type: 'yesno',
        required: true,
        note: 'Yes when the cap applies per block.',
      },
      { key: 'active', header: 'Active', type: 'yesno', required: true, note: YES_NO_NOTE },
    ],
  },
  'tax-rates': {
    master: 'tax-rates',
    label: 'Tax rates',
    sheetName: 'Tax rates',
    description:
      'GST with the date each rate applies from. A proposal keeps the rate in force when it was created.',
    keyColumns: ['tax', 'effectiveFrom'],
    columns: [
      { key: 'tax', header: 'Tax', type: 'enum', options: TAX_CODES, required: true, note: 'GST.' },
      {
        key: 'ratePercent',
        header: 'Rate %',
        type: 'percent',
        required: true,
        note: 'For example 18.',
      },
      {
        key: 'effectiveFrom',
        header: 'Effective from',
        type: 'date',
        required: true,
        note: 'YYYY-MM-DD. Applies from this date until the next rate.',
      },
      { key: 'note', header: 'Note', type: 'text', required: false, note: 'Optional.' },
    ],
  },
  notes: {
    master: 'notes',
    label: 'Standard notes',
    sheetName: 'Standard notes',
    description:
      'The NOTE and disclaimer text at the foot of the Data Sheet, RFQ, QCR and Placement Slip.',
    keyColumns: ['code'],
    columns: [
      {
        key: 'code',
        header: 'Code',
        type: 'code',
        required: true,
        note: 'A short name, for example REPLACEMENT_VALUE.',
      },
      { key: 'title', header: 'Title', type: 'text', required: true, note: 'For the screen.' },
      { key: 'text', header: 'Text', type: 'longtext', required: true, note: 'Printed as is.' },
      {
        key: 'onDataSheet',
        header: 'On Data Sheet',
        type: 'yesno',
        required: true,
        note: YES_NO_NOTE,
      },
      { key: 'onRfq', header: 'On RFQ', type: 'yesno', required: true, note: YES_NO_NOTE },
      { key: 'onQcr', header: 'On QCR', type: 'yesno', required: true, note: YES_NO_NOTE },
      {
        key: 'onPlacementSlip',
        header: 'On Placement Slip',
        type: 'yesno',
        required: true,
        note: YES_NO_NOTE,
      },
      {
        key: 'order',
        header: 'Order',
        type: 'integer',
        required: true,
        note: '1 is printed first.',
      },
      { key: 'active', header: 'Active', type: 'yesno', required: true, note: YES_NO_NOTE },
    ],
  },
};

export interface CatalogCellIssue {
  /** The column's key, or null for the row as a whole. */
  column: string | null;
  message: string;
}

function scalarText(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : '';
}

/** A cell as text, the way a sheet or a form holds it. */
export function catalogCellText(column: CatalogColumn, value: unknown): string {
  if (value === null || value === undefined) return '';
  if (column.type === 'yesno') return value === true ? 'Yes' : 'No';
  if (column.type === 'list') {
    return Array.isArray(value) ? value.map(scalarText).join('; ') : scalarText(value);
  }
  return scalarText(value);
}

/** Every column of a row as text. */
export function catalogRowToCells(master: CatalogMaster, row: object): Record<string, string> {
  const values = row as Record<string, unknown>;
  return Object.fromEntries(
    CATALOG_SHEETS[master].columns.map((column) => [
      column.key,
      catalogCellText(column, values[column.key]),
    ]),
  );
}

function cellValue(column: CatalogColumn, raw: string): { value: unknown } | { message: string } {
  const text = raw.trim();
  if (text === '') {
    if (column.type === 'list') return { value: [] };
    if (column.required) return { message: `Enter the ${column.header.toLowerCase()}` };
    return { value: null };
  }
  switch (column.type) {
    case 'yesno': {
      const lower = text.toLowerCase();
      if (YES.includes(lower)) return { value: true };
      if (NO.includes(lower)) return { value: false };
      return { message: 'Enter Yes or No' };
    }
    case 'integer':
      return /^\d{1,4}$/.test(text) ? { value: Number(text) } : { message: 'Enter a whole number' };
    case 'rupees':
      // Grouping commas and a ".00" from Excel are accepted.
      return { value: text.replace(/,/g, '').replace(/\.0+$/, '') };
    case 'percent':
      return { value: text.replace(/%$/, '').trim() };
    case 'code':
    case 'enum':
      // "BSUS & BLUS" and "Fire additional" become BSUS_BLUS and FIRE_ADDITIONAL.
      return {
        value: text
          .toUpperCase()
          .replace(/&/g, ' ')
          .trim()
          .replace(/[\s-]+/g, '_'),
      };
    case 'list':
      return {
        value: text
          .split(/[;\n]/)
          .map((entry) => entry.trim())
          .filter(Boolean),
      };
    default:
      return { value: text };
  }
}

/**
 * A row from text cells (a sheet row or a form), checked against the master's rules. Issues
 * name the column they belong to.
 */
export function parseCatalogCells<M extends CatalogMaster>(
  master: M,
  cells: Readonly<Record<string, string>>,
): { row: CatalogRows[M]; issues: [] } | { row: null; issues: CatalogCellIssue[] } {
  const sheet = CATALOG_SHEETS[master];
  const issues: CatalogCellIssue[] = [];
  const candidate: Record<string, unknown> = {};
  for (const column of sheet.columns) {
    const result = cellValue(column, cells[column.key] ?? '');
    if ('message' in result) issues.push({ column: column.key, message: result.message });
    else candidate[column.key] = result.value;
  }
  if (issues.length > 0) return { row: null, issues };
  const parsed = CATALOG_ROW_SCHEMAS[master].safeParse(candidate);
  if (parsed.success) return { row: parsed.data as CatalogRows[M], issues: [] };
  return {
    row: null,
    issues: parsed.error.issues.map((issue) => ({
      column: typeof issue.path[0] === 'string' ? issue.path[0] : null,
      message: issue.message,
    })),
  };
}

/** The text that identifies a row within its master, ignoring case and spacing. */
export function catalogKeyOf(master: CatalogMaster, row: object): string {
  const values = row as Record<string, unknown>;
  return CATALOG_SHEETS[master].keyColumns
    .map((key) => scalarText(values[key]).trim().toLowerCase().replace(/\s+/g, ' '))
    .join('|');
}

// API

export const CatalogMasterParamsSchema = z.strictObject({ master: CatalogMasterSchema });
export const CatalogItemParamsSchema = z.strictObject({
  master: CatalogMasterSchema,
  id: ObjectIdSchema,
});

const itemMeta = { id: ObjectIdSchema, updatedAt: IsoDateTimeSchema };
export const ProductItemSchema = ProductRowSchema.safeExtend(itemMeta);
export const SectionItemSchema = SectionRowSchema.safeExtend(itemMeta);
export const AddonItemSchema = AddonRowSchema.extend(itemMeta);
export const AddonRuleItemSchema = AddonRuleRowSchema.safeExtend(itemMeta);
export const TaxRateItemSchema = TaxRateRowSchema.extend(itemMeta);
export const NoteItemSchema = NoteRowSchema.extend(itemMeta);

export const CATALOG_ITEM_SCHEMAS = {
  products: ProductItemSchema,
  sections: SectionItemSchema,
  addons: AddonItemSchema,
  'addon-rules': AddonRuleItemSchema,
  'tax-rates': TaxRateItemSchema,
  notes: NoteItemSchema,
} as const satisfies Record<CatalogMaster, z.ZodType>;

export type CatalogItem<M extends CatalogMaster = CatalogMaster> = CatalogRows[M] & {
  id: string;
  updatedAt: string;
};

/** The list response of every master: all rows, in display order. */
export function catalogListSchema<M extends CatalogMaster>(master: M) {
  return z.object({ items: z.array(CATALOG_ITEM_SCHEMAS[master]) });
}
export const CatalogListResponseSchema = z.object({
  items: z.array(z.record(z.string(), z.unknown())),
});

export const CatalogListQuerySchema = z.strictObject({
  /** Words that must all appear in the row's text columns. */
  q: z.string().trim().max(100).optional(),
});

/** Moves rows of an ordered master (sections, products, notes): ids in the new order. */
export const CatalogReorderRequestSchema = z.strictObject({
  ids: z.array(ObjectIdSchema).min(1).max(500),
});

export const CATALOG_REORDERABLE: readonly CatalogMaster[] = ['products', 'sections', 'notes'];

// Workbook upload

export const CatalogImportQuerySchema = z.strictObject({
  /** Checks the workbook and reports without saving. Defaults to true. */
  dryRun: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  /** The uploaded file's name, kept in the audit log. */
  fileName: z.string().trim().min(1).max(200, 'File name is too long').optional(),
});

export const CatalogSheetReportSchema = z.object({
  master: CatalogMasterSchema,
  label: z.string(),
  sheetName: z.string(),
  /** False when the workbook has no such sheet: that master is left as it is. */
  present: z.boolean(),
  rows: z.number().int(),
  /** Rows saved now, before the import replaces them. */
  currentRows: z.number().int(),
  issues: z.array(
    z.object({
      row: z.number().int().nullable(),
      column: z.string().nullable(),
      message: z.string(),
    }),
  ),
});
export type CatalogSheetReport = z.infer<typeof CatalogSheetReportSchema>;

export const CatalogImportReportSchema = z.object({
  dryRun: z.boolean(),
  /** True when the sheets were saved (not a dry run and no sheet has problems). */
  imported: z.boolean(),
  fileErrors: z.array(z.string()),
  sheets: z.array(CatalogSheetReportSchema),
});
export type CatalogImportReport = z.infer<typeof CatalogImportReportSchema>;

export const ProductSuggestionQuerySchema = z.strictObject({
  sumInsured: z.string().regex(/^\d{1,15}$/, 'Enter whole rupees'),
});
export const ProductSuggestionSchema = z.object({
  sumInsured: z.string(),
  products: z.array(z.object({ code: z.string(), name: z.string(), range: z.string() })),
});
export type ProductSuggestion = z.infer<typeof ProductSuggestionSchema>;

// Pure helpers used by both repos

const CRORE = 10_000_000n;
const LAKH = 100_000n;

/** Whole rupees as "5 Cr", "25 L" or "₹50,000" (exact, two decimals at most). */
export function formatRupeesShort(value: string): string {
  const rupees = BigInt(value);
  const unit = (divisor: bigint, suffix: string) => {
    const hundredths = (rupees * 100n) / divisor;
    const whole = hundredths / 100n;
    const fraction = (hundredths % 100n).toString().padStart(2, '0').replace(/0+$/, '');
    return `₹${groupIndianDigits(whole.toString())}${fraction ? `.${fraction}` : ''} ${suffix}`;
  };
  if (rupees >= CRORE && (rupees * 100n) % CRORE === 0n) return unit(CRORE, 'Cr');
  if (rupees >= LAKH && (rupees * 100n) % LAKH === 0n) return unit(LAKH, 'L');
  return `₹${groupIndianDigits(value)}`;
}

/** "Up to ₹5 Cr", "Above ₹5 Cr and up to ₹50 Cr", "Above ₹50 Cr" or "Any sum insured". */
export function productRangeText(product: Pick<ProductRow, 'aboveSi' | 'upToSi'>): string {
  const { aboveSi, upToSi } = product;
  if (aboveSi && upToSi) {
    return `Above ${formatRupeesShort(aboveSi)} and up to ${formatRupeesShort(upToSi)}`;
  }
  if (aboveSi) return `Above ${formatRupeesShort(aboveSi)}`;
  if (upToSi) return `Up to ${formatRupeesShort(upToSi)}`;
  return 'Any sum insured';
}

/** The active products whose range holds the sum insured, in their order. */
export function suggestProducts<
  P extends Pick<ProductRow, 'aboveSi' | 'upToSi' | 'active' | 'order'>,
>(products: readonly P[], sumInsured: string): P[] {
  const si = BigInt(sumInsured);
  return products
    .filter(
      (product) =>
        product.active &&
        (product.aboveSi === null || si > BigInt(product.aboveSi)) &&
        (product.upToSi === null || si <= BigInt(product.upToSi)),
    )
    .toSorted((a, b) => a.order - b.order);
}

/** The rate in force on a date: the latest one effective on or before it, else null. */
export function taxRateOn<R extends Pick<TaxRateRow, 'tax' | 'effectiveFrom' | 'ratePercent'>>(
  rates: readonly R[],
  tax: TaxCode,
  date: string,
): R | null {
  let match: R | null = null;
  for (const rate of rates) {
    if (rate.tax !== tax || rate.effectiveFrom > date) continue;
    if (!match || rate.effectiveFrom > match.effectiveFrom) match = rate;
  }
  return match;
}

/** The rate formula of a BSUS/BLUS add-on in words, for the screen and checks. */
export function addonRuleFormula(
  rule: Pick<AddonRuleRow, 'calcType' | 'rateFactorPct' | 'basePct' | 'maxSelectablePct'>,
): string {
  const rate = `${rule.rateFactorPct}% of policy rate`;
  switch (rule.calcType) {
    case 'PCT_OF_SI_BASE':
      return `${rate} on ${rule.basePct ?? '?'}% of SI`;
    case 'FLAT_CAP':
      return `${rate} on ${rule.basePct ?? '?'}% of SI, cover capped`;
    case 'SPECIFIED_SI':
      return `${rate} on specified SI`;
    case 'ESCALATION':
      return `${rate} on the selected % (max ${rule.maxSelectablePct ?? '?'}%) of SI excluding stocks`;
    case 'POLICY_SI':
      return `${rate} on policy SI`;
  }
}
