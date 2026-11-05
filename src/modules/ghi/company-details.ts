import {
  COMPANY_DETAIL_ALIASES,
  COMPANY_DETAIL_FIELDS,
  COMPANY_DETAILS_SHEET,
  GhiRequirementsInputSchema,
  type CompanyDetailField,
  type CompanyDetailsImport,
} from '../../shared/index.ts';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { validationError } from '../../lib/errors.ts';
import { withoutNotes } from '../imports/strip-notes.ts';
import { cellText, readCell } from '../masters/import/cells.ts';
import { loadCase, type Actor } from './ghi-common.ts';
import { uploadFile } from './ghi-files.service.ts';
import { GMC_SCOPE, type CaseScope } from './products/profile.ts';

// Company details from Excel (alteration 3/11/2026): the Data Sheet's company section and the
// number of employees, for GMC, GPA and GTLI alike. The template lists one field per row (Field,
// Value), filled with what the case holds; the import reads it back, checks each value with the
// Data Sheet's own rules and keeps the workbook with the case's files. Nothing is saved to the
// Data Sheet here: the values go to the form, which the user reviews and saves.

const company = GhiRequirementsInputSchema.shape.company.shape;
const EmployeeCount = z
  .number({ error: 'Enter a whole number' })
  .int('Enter a whole number')
  .min(1, 'Enter 1 or more')
  .max(1_000_000, 'Enter at most 1,000,000');

const key = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const FIELD_BY_NAME = new Map<string, CompanyDetailField>(
  COMPANY_DETAIL_FIELDS.flatMap((field) => [
    [key(field.label), field.key] as const,
    ...COMPANY_DETAIL_ALIASES[field.key].map((alias) => [key(alias), field.key] as const),
  ]),
);

interface CaseCompany {
  company: Record<string, string | null>;
  employeeCount: number | null;
}

/** The template, filled with the case's current company details. */
export async function companyDetailsTemplate(
  id: string,
  scope: CaseScope = GMC_SCOPE,
): Promise<{ fileName: string; data: Buffer }> {
  const doc = await loadCase(id, undefined, scope);
  const current = doc.requirements as unknown as CaseCompany;
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(COMPANY_DETAILS_SHEET);
  sheet.columns = [
    { header: 'Field', key: 'field', width: 32 },
    { header: 'Value', key: 'value', width: 60 },
  ];
  for (const field of COMPANY_DETAIL_FIELDS) {
    const value =
      field.key === 'employeeCount' ? current.employeeCount : current.company?.[field.key];
    sheet.addRow({ field: field.label, value: value ?? '' });
  }
  sheet.getColumn('field').font = { bold: true };
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF12285E' } };
  sheet.addRow([]);
  sheet.addRow([
    'Fill the Value column, keep the Field column as it is, and import the file on the case’s Data Sheet.',
  ]);
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  const data = Buffer.from(await workbook.xlsx.writeBuffer());
  return { fileName: `Company-details-${doc.reference}.xlsx`, data };
}

/** The Field → Value pairs of the workbook's company-details sheet. */
async function readPairs(data: Buffer): Promise<Map<CompanyDetailField, string | null>> {
  const unreadable = () =>
    validationError([
      {
        location: 'body',
        path: 'file',
        message:
          'This is not the company details workbook (.xlsx). Download the template from the Data Sheet, fill it and import it again.',
      },
    ]);
  if (data.length < 4 || data.readUInt32LE(0) !== 0x04034b50) throw unreadable();
  const workbook = new ExcelJS.Workbook();
  try {
    const readable = await withoutNotes(data);
    await workbook.xlsx.load(readable as unknown as Parameters<ExcelJS.Xlsx['load']>[0]);
  } catch {
    throw unreadable();
  }
  const sheet =
    workbook.worksheets.find((item) => key(item.name) === key(COMPANY_DETAILS_SHEET)) ??
    workbook.worksheets.find((item) => item.state !== 'hidden');
  if (!sheet) throw unreadable();
  const pairs = new Map<CompanyDetailField, string | null>();
  sheet.eachRow((row) => {
    const name = cellText(readCell(row.getCell(1)));
    const field = name ? FIELD_BY_NAME.get(key(name)) : undefined;
    if (field && !pairs.has(field)) pairs.set(field, cellText(readCell(row.getCell(2))));
  });
  if (pairs.size === 0) throw unreadable();
  return pairs;
}

/**
 * Reads the company details from an uploaded workbook and keeps the workbook with the case.
 * Each value is checked like the form checks it; a value that fails is reported, not applied.
 */
export async function importCompanyDetails(
  id: string,
  fileName: string,
  data: Buffer,
  actor: Actor,
  scope: CaseScope = GMC_SCOPE,
): Promise<CompanyDetailsImport> {
  const pairs = await readPairs(data);
  const result: Omit<CompanyDetailsImport, 'file'> = {
    company: {
      natureOfBusiness: null,
      locations: null,
      contactName: null,
      contactEmail: null,
      contactPhone: null,
    },
    employeeCount: null,
    provided: [],
    issues: [],
  };
  for (const field of COMPANY_DETAIL_FIELDS) {
    const raw = pairs.get(field.key) ?? null;
    if (raw === null) continue;
    const parsed =
      field.key === 'employeeCount'
        ? EmployeeCount.safeParse(Number(raw.replace(/[,\s]/g, '')))
        : company[field.key].safeParse(raw);
    if (!parsed.success) {
      result.issues.push({
        field: field.key,
        label: field.label,
        message: parsed.error.issues[0]?.message ?? 'This value is not valid',
      });
      continue;
    }
    if (field.key === 'employeeCount') result.employeeCount = parsed.data as number;
    else result.company[field.key] = parsed.data as string | null;
    result.provided.push(field.key);
  }
  const file = await uploadFile(id, 'COMPANY_DETAILS', fileName, data, actor, scope);
  return { ...result, file };
}
