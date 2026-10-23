import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { findRow, hideRowsBetween } from './excel-template.ts';

// Documents leave out what is empty: a titled block (for example "Warranties / Conditions") that
// the case does not fill must not print the blank rows the template reserved for it. This mirrors
// the client's Placement Slip and QCR schedule layout: a title, two reserved rows, the next title,
// one reserved row, then the footer.
function scheduleLikeSheet(): ExcelJS.Worksheet {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('schedule');
  sheet.getCell('A1').value = 'Warranties / Conditions'; // title
  // rows 2 and 3: reserved, blank
  sheet.getCell('A4').value = 'Excess'; // next title
  // row 5: reserved, blank
  sheet.getCell('A6').value = 'Fiducial Insurance Brokers India Pvt Ltd.,'; // footer
  return sheet;
}

describe('hideRowsBetween', () => {
  it('hides the blank rows an empty block reserved, keeping the titles and footer', () => {
    const sheet = scheduleLikeSheet();

    // No conditions and no deductibles: hide both reserved blocks.
    hideRowsBetween(sheet, 2, 4); // Warranties / Conditions -> Excess
    hideRowsBetween(sheet, 5, 6); // Excess -> footer

    expect(sheet.getRow(2).hidden).toBe(true);
    expect(sheet.getRow(3).hidden).toBe(true);
    expect(sheet.getRow(5).hidden).toBe(true);
    // Titles and footer stay visible and found by label.
    expect(sheet.getRow(1).hidden).toBeFalsy();
    expect(sheet.getRow(4).hidden).toBeFalsy();
    expect(sheet.getRow(6).hidden).toBeFalsy();
    expect(findRow(sheet, 'Warranties / Conditions')).toBe(1);
    expect(findRow(sheet, 'Excess')).toBe(4);
  });

  it('does nothing when the range is empty (a full block was used)', () => {
    const sheet = scheduleLikeSheet();
    hideRowsBetween(sheet, 2, 2);
    expect(sheet.getRow(2).hidden).toBeFalsy();
  });
});
