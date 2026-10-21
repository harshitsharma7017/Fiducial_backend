import {
  DEFAULT_FAMILY_PLANS,
  PROVISIONAL_TEMPLATE_NOTICE,
  emptyRowValues,
  templateColumns,
} from '../../shared/index.ts';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import {
  buildErrorReport,
  buildEbCensusTemplate,
  readTemplateMarker,
  templateFileName,
} from './eb-census-template.ts';

const load = async (data: Buffer) => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(data as unknown as Parameters<ExcelJS.Xlsx['load']>[0]);
  return workbook;
};

describe('Template_Builder', () => {
  for (const plan of DEFAULT_FAMILY_PLANS) {
    it(`builds ${plan.templateName} with its notice, columns, drop-downs and marker`, async () => {
      const columns = templateColumns(plan.product, plan.version.slots, 'UNKNOWN');
      const file = await buildEbCensusTemplate({
        product: plan.product,
        templateName: plan.templateName,
        plan: {
          ...plan.version,
          code: plan.code,
          name: plan.name,
          versionNumber: 1,
          clientConfirmed: false,
          openQuestions: plan.openQuestions,
        },
        columns,
      });
      expect(file.fileName).toBe(templateFileName(plan.templateName, 1));
      const workbook = await load(file.data);
      expect(workbook.getWorksheet('Instructions')!.getCell('A1').text).toBe(
        PROVISIONAL_TEMPLATE_NOTICE,
      );
      const census = workbook.getWorksheet('Census')!;
      expect(census.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
      expect(census.getRow(1).getCell(1).text).toBe('Employee ID *');
      expect(readTemplateMarker(workbook)).toEqual({
        product: plan.product,
        planCode: plan.code,
        planVersion: 1,
      });
    });
  }

  it('names the files as the requirement says', () => {
    expect(templateFileName('GPA 1+3', 2)).toBe('Provisional-GPA-1+3-v2.xlsx');
  });

  it('writes every error report cell as text, never a formula', async () => {
    const values = {
      ...emptyRowValues(),
      employeeId: '=1+1',
      name: '+1',
      gender: '-1',
      dateOfBirth: '@x',
    };
    const data = await buildErrorReport({
      fileName: 'census.xlsx',
      fields: ['employeeId', 'name', 'gender', 'dateOfBirth'],
      rows: [
        {
          row: 2,
          values,
          issues: [
            {
              row: 2,
              employeeId: '=1+1',
              name: '+1',
              relationship: null,
              field: 'gender',
              value: '-1',
              message: 'Bad gender',
              fix: 'Use Male',
              severity: 'ERROR',
              code: 'FIELD',
            },
          ],
        },
      ],
    });
    const workbook = await load(data);
    const row = workbook.getWorksheet('Census')!.getRow(2);
    expect([2, 3, 4, 5].map((column) => row.getCell(column).value)).toEqual([
      '=1+1',
      '+1',
      '-1',
      '@x',
    ]);
    for (const sheet of workbook.worksheets) {
      sheet.eachRow((line) =>
        line.eachCell((cell) => expect(cell.type).not.toBe(ExcelJS.ValueType.Formula)),
      );
    }
    expect(workbook.getWorksheet('Issues')!.getRow(2).getCell(4).value).toBe('-1');
  });
});
