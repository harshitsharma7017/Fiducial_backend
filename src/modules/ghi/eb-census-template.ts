import {
  COLUMN_REQUIREMENT_LABELS,
  EB_CENSUS_FIELD_LABELS,
  EB_PRODUCTS,
  GHI_CENSUS_SHEET,
  GHI_GENDER_ALIASES,
  MAX_EB_CENSUS_ROWS,
  PROVISIONAL_TEMPLATE_NOTICE,
  awaitingText,
  mixingText,
  relationshipValueOf,
  relationshipValues,
  slotText,
  type EbCensusField,
  type EbCensusIssue,
  type EbCensusRowValues,
  type EbProduct,
  type PlanSlot,
  type TemplateColumn,
} from '../../shared/index.ts';
import ExcelJS from 'exceljs';

// The Template_Builder (N3, Requirement 19): the provisional product census templates and the
// Excel error report. The client's GMC, GPA and GTLI formats have not been received, so every
// template says it is provisional, on its Instructions sheet and in its file name (19.5).

export const INSTRUCTIONS_SHEET = 'Instructions';
/** The hidden metadata sheet (design D13): Excel keeps it, and Census edits never touch it. */
export const MARKER_SHEET = '_fiducial';
const MARKER_KIND = 'census-template';

const HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFE8EEF6' },
};
const NOTICE_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFFFF4CE' },
};
const DATE_FIELDS = new Set<EbCensusField>(['dateOfBirth', 'dateOfJoining']);
const AMOUNT_FIELDS = new Set<EbCensusField>(['sumInsured', 'annualSalary']);

export interface TemplatePlan {
  code: string;
  name: string;
  versionNumber: number;
  slots: readonly PlanSlot[];
  parentsAndInLawsMixed: boolean;
  clientConfirmed: boolean;
  openQuestions: readonly number[];
}

export interface TemplateMarker {
  product: EbProduct;
  planCode: string;
  planVersion: number;
}

/** "Provisional-GPA-1+3-v1.xlsx" (Requirement 19.5). */
export function templateFileName(templateName: string, version: number): string {
  return `Provisional-${templateName.trim().replace(/\s+/g, '-')}-v${version}.xlsx`;
}

type WithValidations = ExcelJS.Worksheet & {
  dataValidations: { add(range: string, rule: ExcelJS.DataValidation): void };
};

/** A product and plan census template (Requirements 19.1 to 19.7). */
export async function buildEbCensusTemplate(input: {
  product: EbProduct;
  templateName: string;
  plan: TemplatePlan;
  columns: readonly TemplateColumn[];
  caseReference?: string | null;
}): Promise<{ fileName: string; data: Buffer }> {
  const { plan, columns } = input;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Fiducial';

  const help = workbook.addWorksheet(INSTRUCTIONS_SHEET);
  help.columns = [{ width: 26 }, { width: 26 }, { width: 96 }];
  const notice = help.addRow([PROVISIONAL_TEMPLATE_NOTICE]);
  notice.font = { bold: true, color: { argb: 'FF7A4B00' } };
  notice.getCell(1).fill = NOTICE_FILL;
  help.mergeCells(1, 1, 1, 3);
  help.addRow([`${input.templateName} census (${input.product})`]).font = { bold: true, size: 14 };
  if (input.caseReference) help.addRow([`For case ${input.caseReference}`]);
  help.addRow([]);
  const values = relationshipValues(plan.slots);
  for (const line of [
    `Fill the "${GHI_CENSUS_SHEET}" sheet: one row per insured life, from row 2. Keep the headers in row 1.`,
    values.length > 0
      ? `Relationship values: ${values.map(relationshipValueOf).join(', ')}. Each dependant repeats the employee ID of their employee; add the employee’s own row (Self) too.`
      : 'Every row is the employee (Self): there is no Relationship column.',
    `Gender values: ${Object.values(GHI_GENDER_ALIASES)
      .map((aliases) => aliases[0])
      .join(', ')}.`,
    'Dates as DD/MM/YYYY (day first), for example 03/04/1990 for 3 April 1990. Excel date cells are read as they are.',
    `Up to ${MAX_EB_CENSUS_ROWS.toLocaleString('en-IN')} rows per file. Blank rows are skipped.`,
    'Upload the file on the case’s Census tab. Every row is checked first; nothing is saved until you import.',
  ]) {
    help.addRow([line]);
  }
  help.addRow([]);
  const head = help.addRow(['Column', 'Required', 'What to enter']);
  head.font = { bold: true };
  head.eachCell((cell) => {
    cell.fill = HEADER_FILL;
  });
  for (const column of columns) {
    help.addRow([column.header, COLUMN_REQUIREMENT_LABELS[column.required], column.help]);
  }
  help.addRow([]);
  help.addRow(['Family plan']).font = { bold: true };
  help.addRow(['Plan', `${plan.name} (code ${plan.code})`]);
  help.addRow(['Version', String(plan.versionNumber)]);
  plan.slots.forEach((slot, index) => {
    help.addRow([`Slot ${index + 1}`, slot.name, slotText(slot)]);
  });
  help.addRow(['Parents and parents-in-law', mixingText(plan)]);
  if (!plan.clientConfirmed) {
    const row = help.addRow(['Status', awaitingText(plan.openQuestions)]);
    row.font = { bold: true, color: { argb: 'FF7A4B00' } };
  }

  const sheet = workbook.addWorksheet(GHI_CENSUS_SHEET, {
    views: [{ state: 'frozen', ySplit: 1 }],
  }) as WithValidations;
  sheet.columns = columns.map((column) => ({
    key: column.key,
    width: column.key === 'name' ? 32 : 18,
    style: DATE_FIELDS.has(column.key)
      ? { numFmt: 'dd/mm/yyyy' }
      : column.key === 'employeeId'
        ? { numFmt: '@' }
        : AMOUNT_FIELDS.has(column.key)
          ? { numFmt: '#,##0' }
          : {},
  }));
  const header = sheet.getRow(1);
  columns.forEach((column, index) => {
    const cell = header.getCell(index + 1);
    cell.value = column.required === 'NO' ? column.header : `${column.header} *`;
    cell.font = { bold: true };
    cell.fill = HEADER_FILL;
    cell.note = column.help;
  });
  const lists: Partial<Record<EbCensusField, string>> = {
    gender: Object.values(GHI_GENDER_ALIASES)
      .map((aliases) => aliases[0])
      .join(','),
    relationship: values.map(relationshipValueOf).join(','),
  };
  columns.forEach((column, index) => {
    const list = lists[column.key];
    if (!list) return;
    const letter = sheet.getColumn(index + 1).letter;
    // Typed values are accepted (no error message), so the aliases still import (19.6).
    sheet.dataValidations.add(`${letter}2:${letter}${MAX_EB_CENSUS_ROWS + 1}`, {
      type: 'list',
      allowBlank: true,
      formulae: [`"${list}"`],
      showErrorMessage: false,
    });
  });

  const marker = workbook.addWorksheet(MARKER_SHEET, { state: 'veryHidden' });
  for (const [key, value] of [
    ['kind', MARKER_KIND],
    ['templateVersion', '1'],
    ['product', input.product],
    ['planCode', plan.code],
    ['planVersion', String(plan.versionNumber)],
  ]) {
    marker.addRow([key, value]);
  }

  workbook.views = [
    { x: 0, y: 0, width: 20000, height: 12000, activeTab: 1, firstSheet: 0, visibility: 'visible' },
  ];
  return {
    fileName: templateFileName(input.templateName, plan.versionNumber),
    data: Buffer.from(await workbook.xlsx.writeBuffer()),
  };
}

/** The product, plan and version a template was made for, from its hidden sheet (19.7). */
export function readTemplateMarker(workbook: ExcelJS.Workbook): TemplateMarker | null {
  const sheet = workbook.getWorksheet(MARKER_SHEET);
  if (!sheet) return null;
  const pairs = new Map<string, string>();
  sheet.eachRow((row) => {
    const key = row.getCell(1).text.trim();
    const value = row.getCell(2).text.trim();
    if (key) pairs.set(key, value);
  });
  const product = pairs.get('product') as EbProduct | undefined;
  const planVersion = Number(pairs.get('planVersion'));
  const planCode = pairs.get('planCode');
  if (
    pairs.get('kind') !== MARKER_KIND ||
    !product ||
    !EB_PRODUCTS.includes(product) ||
    !planCode ||
    !Number.isInteger(planVersion) ||
    planVersion < 1
  ) {
    return null;
  }
  return { product, planCode, planVersion };
}

/** Sets a cell to text that Excel never runs as a formula (Requirement 21.7). */
function textCell(cell: ExcelJS.Cell, value: string): void {
  cell.numFmt = '@';
  cell.value = value;
}

/**
 * The error report of a preview (Requirements 21.5, 21.7): a Census sheet with each row that has
 * an issue, its values as uploaded and its issues, and an Issues sheet with one line per issue.
 * Every cell is text, so "=1+1" shows as typed and is never a formula.
 */
export async function buildErrorReport(input: {
  fileName: string;
  fields: readonly EbCensusField[];
  rows: ReadonlyArray<{ row: number; values: EbCensusRowValues; issues: readonly EbCensusIssue[] }>;
}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Fiducial';
  const census = workbook.addWorksheet(GHI_CENSUS_SHEET, {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  const headers = ['Row', ...input.fields.map((field) => EB_CENSUS_FIELD_LABELS[field]), 'Errors'];
  census.columns = headers.map((header) => ({ width: header === 'Errors' ? 80 : 18 }));
  const head = census.getRow(1);
  headers.forEach((header, index) => {
    textCell(head.getCell(index + 1), header);
    head.getCell(index + 1).font = { bold: true };
    head.getCell(index + 1).fill = HEADER_FILL;
  });
  const issues = workbook.addWorksheet('Issues', { views: [{ state: 'frozen', ySplit: 1 }] });
  const issueHeaders = ['Row', 'Employee ID', 'Field', 'Value', 'Explanation', 'Fix'];
  issues.columns = issueHeaders.map((header) => ({
    width: header === 'Explanation' || header === 'Fix' ? 60 : 18,
  }));
  const issueHead = issues.getRow(1);
  issueHeaders.forEach((header, index) => {
    textCell(issueHead.getCell(index + 1), header);
    issueHead.getCell(index + 1).font = { bold: true };
    issueHead.getCell(index + 1).fill = HEADER_FILL;
  });
  let censusRow = 2;
  let issueRow = 2;
  for (const item of input.rows) {
    const row = census.getRow(censusRow++);
    const cells = [
      String(item.row),
      ...input.fields.map((field) => item.values[field] ?? ''),
      item.issues
        .map((issue) =>
          `${issue.severity === 'WARNING' ? 'Warning: ' : ''}${issue.field ? `${EB_CENSUS_FIELD_LABELS[issue.field]}: ` : ''}${issue.message} ${issue.fix}`.trim(),
        )
        .join('\n'),
    ];
    cells.forEach((value, index) => textCell(row.getCell(index + 1), value));
    for (const issue of item.issues) {
      const line = issues.getRow(issueRow++);
      [
        String(item.row),
        issue.employeeId ?? '',
        issue.field ? EB_CENSUS_FIELD_LABELS[issue.field] : '',
        issue.value ?? '',
        `${issue.severity === 'WARNING' ? 'Warning: ' : ''}${issue.message}`,
        issue.fix,
      ].forEach((value, index) => textCell(line.getCell(index + 1), value));
    }
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
