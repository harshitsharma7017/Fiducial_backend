import { z } from 'zod';
import type { Permission } from './permissions.ts';

/**
 * Records that can be loaded from an Excel workbook. Each has a template with one sheet of
 * columns (below), downloaded from the API. A preview checks every row and saves nothing; the
 * import then saves the chosen valid rows in one transaction, leaving out rows with problems.
 */
export const IMPORT_ENTITIES = ['clients', 'client-locations', 'insurers'] as const;
export const ImportEntitySchema = z.enum(IMPORT_ENTITIES);
export type ImportEntity = z.infer<typeof ImportEntitySchema>;

/** Rows per file. Larger lists are split into several files. */
export const MAX_IMPORT_ROWS = 1000;
/** Largest workbook accepted, in bytes. */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export interface ImportColumn {
  key: string;
  /** The header in row 1 of the sheet. Matched ignoring case, spaces and a trailing "*". */
  header: string;
  required: boolean;
  note: string;
}

export interface ImportSheet {
  label: string;
  /** The name of the data sheet in the template. */
  sheetName: string;
  description: string;
  /** Needed to download the template and to import. */
  permission: Permission;
  columns: readonly ImportColumn[];
}

function contactColumns(n: number): ImportColumn[] {
  return [
    {
      key: `contact${n}Name`,
      header: `Contact ${n} name`,
      required: false,
      note: 'Person to contact.',
    },
    {
      key: `contact${n}Designation`,
      header: `Contact ${n} designation`,
      required: false,
      note: 'For example CFO or Underwriter.',
    },
    {
      key: `contact${n}Email`,
      header: `Contact ${n} email`,
      required: false,
      note: 'An email or a phone number is needed when a contact name is given.',
    },
    {
      key: `contact${n}Phone`,
      header: `Contact ${n} phone`,
      required: false,
      note: 'Digits, spaces, brackets, - or a leading +.',
    },
  ];
}

/** Contacts per row in a template. More can be added on the screen afterwards. */
export const IMPORT_CONTACTS_PER_ROW = 2;
const CONTACT_COLUMNS = Array.from({ length: IMPORT_CONTACTS_PER_ROW }, (_, index) =>
  contactColumns(index + 1),
).flat();

export const IMPORT_SHEETS: Record<ImportEntity, ImportSheet> = {
  clients: {
    label: 'Clients',
    sheetName: 'Clients',
    description: 'The insured: name, GSTIN, communication address, business, occupancy, contacts.',
    permission: 'clients.manage',
    columns: [
      { key: 'name', header: 'Insured name', required: true, note: 'As on the Data Sheet.' },
      {
        key: 'gstin',
        header: 'GSTIN',
        required: false,
        note: '15 characters. Leave blank if the insured has no GST registration. Must not belong to another client.',
      },
      { key: 'line1', header: 'Address line 1', required: true, note: 'Communication address.' },
      { key: 'line2', header: 'Address line 2', required: false, note: 'Optional.' },
      { key: 'city', header: 'City', required: true, note: '' },
      {
        key: 'state',
        header: 'State',
        required: true,
        note: 'A state or union territory, as in the drop-down list.',
      },
      { key: 'pincode', header: 'Pincode', required: true, note: '6 digits.' },
      {
        key: 'natureOfBusiness',
        header: 'Nature of business',
        required: true,
        note: 'For example Cotton yarn spinning.',
      },
      {
        key: 'occupancyCode',
        header: 'Occupancy code',
        required: true,
        note: 'TAC code from the active IIB occupancy master, for example 2189.',
      },
      ...CONTACT_COLUMNS,
    ],
  },
  'client-locations': {
    label: 'Risk locations',
    sheetName: 'Risk locations',
    description: 'Sites of existing clients. Import the clients first.',
    permission: 'clients.manage',
    columns: [
      {
        key: 'clientGstin',
        header: 'Client GSTIN',
        required: false,
        note: 'Finds the client. Leave blank for a client without a GSTIN and fill Client name.',
      },
      {
        key: 'clientName',
        header: 'Client name',
        required: false,
        note: 'Used when Client GSTIN is blank: must match exactly one client name.',
      },
      {
        key: 'name',
        header: 'Location name',
        required: true,
        note: 'How the client refers to the site, for example Plant 2.',
      },
      { key: 'line1', header: 'Address line 1', required: true, note: '' },
      { key: 'line2', header: 'Address line 2', required: false, note: 'Optional.' },
      { key: 'city', header: 'City', required: true, note: '' },
      {
        key: 'pincode',
        header: 'Pincode',
        required: true,
        note: 'Must be in the active pincode master; it sets the state, district and EQ zone.',
      },
      {
        key: 'occupancyCode',
        header: 'Occupancy code',
        required: false,
        note: "Blank when the location has the client's occupancy.",
      },
    ],
  },
  insurers: {
    label: 'Insurers',
    sheetName: 'Insurers',
    description: 'Insurer branches with the email addresses RFQs are sent to.',
    permission: 'masters.manage',
    columns: [
      { key: 'company', header: 'Insurance company', required: true, note: '' },
      {
        key: 'branch',
        header: 'Branch',
        required: true,
        note: 'Company and branch together must be new.',
      },
      {
        key: 'rfqEmails',
        header: 'RFQ emails',
        required: true,
        note: 'One or more addresses, separated by commas, semicolons or new lines.',
      },
      ...CONTACT_COLUMNS,
    ],
  },
};

export const ImportEntityParamsSchema = z.strictObject({ entity: ImportEntitySchema });

export const ImportTemplateQuerySchema = z.strictObject({
  /** true fills the template with fictional sample rows that pass the import. */
  sample: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});

export const ImportQuerySchema = z.strictObject({
  /** Checks the file and reports without saving. Defaults to true; pass false to import. */
  dryRun: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  /**
   * When importing, the sheet rows to save, as "2,3,7". Every one must be valid. Left out, all
   * valid rows are saved and rows with problems are skipped.
   */
  rows: z
    .string()
    .regex(/^\d{1,5}(,\d{1,5})*$/, 'List row numbers separated by commas, for example 2,3,7')
    .transform((value) => [...new Set(value.split(',').map(Number))])
    .optional(),
});
export type ImportQuery = z.infer<typeof ImportQuerySchema>;

/** A problem with the file itself, or with one row (row is null for the whole file). */
export const ImportIssueSchema = z.object({
  row: z.number().int().nullable(),
  column: z.string().nullable(),
  message: z.string(),
});
export type ImportIssue = z.infer<typeof ImportIssueSchema>;

/** One data row of the sheet: what it holds, whether it can be imported, and why not. */
export const ImportRowSchema = z.object({
  /** The row number in Excel. */
  row: z.number().int(),
  valid: z.boolean(),
  /** What the row creates, for example "Sahyadri Textiles Pvt Ltd · Plant 1". Null when invalid. */
  label: z.string().nullable(),
  /** The cells as text, keyed by column key (see IMPORT_SHEETS). */
  values: z.record(z.string(), z.string()),
  issues: z.array(z.object({ column: z.string().nullable(), message: z.string() })),
});
export type ImportRow = z.infer<typeof ImportRowSchema>;

export const ImportReportSchema = z.object({
  entity: ImportEntitySchema,
  dryRun: z.boolean(),
  /** Data rows read (blank rows are skipped). */
  rowsRead: z.number().int(),
  validRows: z.number().int(),
  invalidRows: z.number().int(),
  /** True when rows were saved. Never true on a dry run. */
  imported: z.boolean(),
  createdCount: z.number().int(),
  /** Problems that stop the whole file or the import (unreadable file, missing column, bad selection). */
  fileErrors: z.array(ImportIssueSchema),
  /** Every data row, in sheet order. */
  rows: z.array(ImportRowSchema),
});
export type ImportReport = z.infer<typeof ImportReportSchema>;
