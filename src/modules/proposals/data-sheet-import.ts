import {
  ANNEXURE_SECTIONS,
  FIRE_ITEMS,
  SECTION_LINES,
  type AnnexureSection,
  type DataSheetImport,
  type FireItemKey,
  type OtherSection,
  type ProposalRecord,
  type RiskDetailKey,
  type SectionWithLines,
} from '../../shared/index.ts';
import type ExcelJS from 'exceljs';
import { Decimal } from '../../lib/decimal.ts';
import {
  cellText,
  findColumn,
  findRow,
  isCovered,
  labelKey,
  openTemplate,
  sheetNamed,
} from '../documents/excel-template.ts';

// Reads the client's Data Sheet workbook (DS-08), found by the labels a person reads, as the
// client's format lays them out: "DATA SHEET FOR PROPERTY INSURANCE" sheets (one per location)
// and the Annexure. Every place found by its label, so a row moved or added is still read.

const TITLE = 'DATA SHEET FOR PROPERTY INSURANCE';
const MAX_TEXT = 300;

/** Fire lines by the words their description starts with, as the client's sheet words them. */
const FIRE_LINE_WORDS: readonly [string, FireItemKey][] = [
  ['building 1', 'BUILDING_1'],
  ['building 2', 'BUILDING_2'],
  ['compound wall', 'COMPOUND_WALL'],
  ['false ceiling', 'FALSE_CEILING'],
  ['plinth', 'PLINTH_FOUNDATION'],
  ['interior', 'INTERIOR'],
  ['furniture', 'FFF'],
  ['office equipment', 'OFFICE_EQUIPMENT'],
  ['entire power', 'ELECTRICAL'],
  ['genset', 'GENSET'],
  ['compressor', 'COMPRESSOR'],
  ['transformer', 'TRANSFORMER'],
  ['all other machineries', 'OTHER_MACHINERY'],
  ['all types of stock', 'STOCKS'],
  ['any other stocks', 'STOCKS_THIRD_PARTY'],
  ['any other items', 'OTHER'],
];

/** Section titles in column A, by the words they start with. */
const SECTION_TITLES: readonly [string, OtherSection][] = [
  ['fire loss of profit', 'FIRE_LOSS_OF_PROFIT'],
  ['money', 'MONEY'],
  ['fidelity', 'FIDELITY_GUARANTEE'],
  ['plate glass', 'PLATE_GLASS'],
  ['neon', 'NEON_GLOW_SIGN'],
  ['all risk', 'ALL_RISK'],
  ['electronic equipment', 'EEI'],
  ['mechanical breakdown', 'MECHANICAL_BREAKDOWN'],
  ['boiler', 'BOILER_PRESSURE_PLANT'],
  ['public liability', 'PUBLIC_LIABILITY'],
];

/** The Data Sheet's 14 risk features, folded into the RFQ's 9 risk details. */
const RISK_FEATURES: readonly [string, RiskDetailKey, string | null][] = [
  ['fire fighting', 'fireFighting', null],
  ['age of building', 'buildingAge', null],
  ['type of construction', 'construction', null],
  ['no of floors', 'construction', 'No of floors'],
  ['type of electrical', 'electrical', null],
  ['claim experience', 'claimExperience', null],
  ['watch and ward', 'watchAndWard', null],
  ['cc tv', 'watchAndWard', 'CCTV'],
  ['cctv', 'watchAndWard', 'CCTV'],
  ['working hours', 'workingHours', null],
  ['basement', 'basementExposure', null],
  ['availability of paint booth', 'stockComposition', 'Paint booth'],
  ['percentage of plastic', 'stockComposition', 'Plastic & rubber in stock'],
  ['details of stock raw', 'stockComposition', 'Raw materials'],
  ['details of stock finished', 'stockComposition', 'Finished goods'],
];

const startsWithAny = <T>(text: string, table: readonly (readonly [string, T, ...unknown[]])[]) =>
  table.find(([words]) => labelKey(text).startsWith(words));

/** A cell's own value: a merged cell's other cells, which repeat it, are blank here. */
function own(sheet: ExcelJS.Worksheet, row: number, column: number): string {
  const cell = sheet.getCell(row, column);
  return isCovered(cell) ? '' : cellText(cell).replace(/\s+/g, ' ').trim();
}

/** A number as typed: grouping commas, "Rs" or "₹" and spaces are allowed. */
function numberOf(text: string): Decimal | null {
  const cleaned = text.replace(/₹|rs\.?|inr|,|\s|\/-/gi, '');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  // Excel keeps numbers as binary floats; 15 significant digits recover what was typed.
  return new Decimal(Number(cleaned).toPrecision(15));
}

interface Reader {
  warnings: string[];
}

/** Whole rupees from a cell, rounding paise with a warning; null when blank. */
function rupees(reader: Reader, text: string, where: string): string | null {
  if (!text) return null;
  const value = numberOf(text);
  if (!value) {
    reader.warnings.push(`${where}: "${text}" is not an amount; left blank.`);
    return null;
  }
  if (!value.isInteger()) {
    reader.warnings.push(`${where}: ${value.toFixed()} rounded to whole rupees.`);
  }
  return value.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed();
}

const clip = (reader: Reader, text: string, where: string) => {
  if (text.length <= MAX_TEXT) return text;
  reader.warnings.push(`${where}: shortened to ${MAX_TEXT} characters.`);
  return text.slice(0, MAX_TEXT);
};

/** The value beside a label in column A: the first other cell of the row with text. */
function valueBeside(sheet: ExcelJS.Worksheet, label: string): string | null {
  const row = findRow(sheet, label, { prefix: true });
  if (!row) return null;
  for (let column = 2; column <= Math.max(sheet.columnCount, 6); column += 1) {
    const text = own(sheet, row, column);
    if (text && labelKey(text) !== labelKey(label)) return text;
  }
  return null;
}

/** The sheets of the workbook that are a Data Sheet, in order. */
function dataSheets(workbook: ExcelJS.Workbook): ExcelJS.Worksheet[] {
  return workbook.worksheets.filter(
    (sheet) =>
      sheet.state !== 'hidden' &&
      (findRow(sheet, TITLE, { prefix: true }) !== null ||
        labelKey(sheet.name).startsWith('data sheet')),
  );
}

function readFire(reader: Reader, sheet: ExcelJS.Worksheet, place: string) {
  const header = findRow(sheet, 'S No') ?? 10;
  const sqFtColumn = findColumn(sheet, header, 'Sq Feet', true) ?? 3;
  const rateColumn = findColumn(sheet, header, 'Rate', true) ?? 4;
  const sumColumn = findColumn(sheet, header, 'Sum Insured', true) ?? 5;
  const total =
    findRow(sheet, 'Total sum insured', { column: 2, from: header, prefix: true }) ?? header + 20;
  const fire: DataSheetImport['locations'][number]['fire'] = [];
  for (let row = header + 1; row < total; row += 1) {
    const label = own(sheet, row, 2);
    const match = label ? startsWithAny(label, FIRE_LINE_WORDS) : undefined;
    if (!match) continue;
    const key = match[1];
    const item = FIRE_ITEMS.find((candidate) => candidate.key === key);
    const where = `${place}, ${item?.number ?? ''} ${item?.label ?? key}`;
    const amount = rupees(reader, own(sheet, row, sumColumn), where);
    let sqFt: string | null = null;
    let rate: string | null = null;
    if (item?.measured) {
      const area = own(sheet, row, sqFtColumn);
      const perSqFt = own(sheet, row, rateColumn);
      const areaValue = area ? numberOf(area) : null;
      const rateValue = perSqFt ? numberOf(perSqFt) : null;
      if (area && !areaValue)
        reader.warnings.push(`${where}: "${area}" is not an area; left blank.`);
      if (perSqFt && !rateValue) {
        reader.warnings.push(`${where}: "${perSqFt}" is not a rate; left blank.`);
      }
      if (areaValue && rateValue) {
        if (rateValue.isInteger() && areaValue.decimalPlaces() <= 2) {
          sqFt = areaValue.toFixed();
          rate = rateValue.toFixed();
        } else if (!amount) {
          // The form takes whole-rupee rates and 2-decimal areas: the product is kept instead.
          const product = areaValue.times(rateValue).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
          reader.warnings.push(
            `${where}: ${areaValue.toFixed()} sq ft × ${rateValue.toFixed()} entered as the sum insured ₹${product.toFixed()}.`,
          );
          fire.push({ key, sqFt: null, ratePerSqFt: null, amount: product.toFixed() });
          continue;
        }
      }
    }
    if (sqFt === null && rate === null && amount === null) continue;
    // A typed sum insured equal to sq ft × rate adds nothing.
    const sameAsProduct =
      sqFt !== null &&
      rate !== null &&
      amount !== null &&
      new Decimal(sqFt).times(rate).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).equals(amount);
    fire.push({ key, sqFt, ratePerSqFt: rate, amount: sameAsProduct ? null : amount });
  }
  return { fire, sumColumn };
}

function readRisk(reader: Reader, sheet: ExcelJS.Worksheet, place: string) {
  const risk: Partial<Record<RiskDetailKey, string>> = {};
  const header = findRow(sheet, 'Details of risk features', { column: 2, prefix: true });
  if (!header) return risk;
  const valueColumn = findColumn(sheet, header, 'Please provide the details', true) ?? 3;
  for (let row = header + 1; row <= sheet.rowCount; row += 1) {
    const label = own(sheet, row, 2);
    if (!label) {
      if (!own(sheet, row, 1)) break;
      continue;
    }
    const key = labelKey(label.replace(/\./g, ''));
    const match = RISK_FEATURES.find(([words]) => key.startsWith(words));
    if (!match) continue;
    const answer = own(sheet, row, valueColumn);
    if (!answer) continue;
    const [, field, prefix] = match;
    const part = prefix ? `${prefix}: ${answer}` : answer;
    const before = risk[field];
    risk[field] = clip(reader, before ? `${before}; ${part}` : part, `${place}, ${label}`);
  }
  return risk;
}

/** The other sections of a Data Sheet: their lines, and the sum insured "as per annexure". */
function readSections(reader: Reader, sheet: ExcelJS.Worksheet, sumColumn: number) {
  const titles: { row: number; code: OtherSection }[] = [];
  // After the Fire table, before the risk features.
  const start = (findRow(sheet, 'Total sum insured', { column: 2, prefix: true }) ?? 0) + 1;
  const features =
    findRow(sheet, 'Details of risk features', { column: 2, prefix: true }) ?? sheet.rowCount;
  for (let row = start; row < features; row += 1) {
    const text = own(sheet, row, 1);
    const match = text ? startsWithAny(text, SECTION_TITLES) : undefined;
    if (match) titles.push({ row, code: match[1] });
  }
  const sections: DataSheetImport['sections'] = [];
  titles.forEach(({ row: title, code }, index) => {
    const last = (titles[index + 1]?.row ?? features) - 1;
    const lines: Record<string, string> = {};
    let proposed1: string | null = null;
    const where = (label: string) => `${sheet.name}, ${label}`;
    for (let row = title + 1; row <= last; row += 1) {
      const label = own(sheet, row, 2);
      if (!label || labelKey(label) === 'description') continue;
      const value = own(sheet, row, sumColumn);
      if (!value) continue;
      const known = SECTION_LINES[code as SectionWithLines]?.find((line) =>
        labelKey(label).startsWith(labelKey(line.label)),
      );
      if (known) {
        if (known.kind === 'count') {
          const count = numberOf(value);
          if (count?.isInteger()) lines[known.key] = count.toFixed();
          else reader.warnings.push(`${where(label)}: "${value}" is not a number; left blank.`);
        } else {
          const amount = rupees(reader, value, where(label));
          if (amount) lines[known.key] = amount;
        }
      } else if (labelKey(label).startsWith('as per annexure')) {
        proposed1 = rupees(reader, value, where(label));
      }
    }
    if (Object.keys(lines).length > 0 || proposed1 !== null) {
      sections.push({ code, lines, proposed1, annexure: [] });
    }
  });
  return sections;
}

/** The Annexure sheet's item grids, by section. */
function readAnnexure(reader: Reader, workbook: ExcelJS.Workbook) {
  const sheet = sheetNamed(workbook, 'Annexure');
  const grids = new Map<AnnexureSection, DataSheetImport['sections'][number]['annexure']>();
  if (!sheet) return grids;
  const codes = Object.keys(ANNEXURE_SECTIONS) as AnnexureSection[];
  const titles: { row: number; code: AnnexureSection }[] = [];
  for (let row = 1; row <= sheet.rowCount; row += 1) {
    const text = own(sheet, row, 1);
    const match = text ? startsWithAny(text, SECTION_TITLES) : undefined;
    if (match && codes.includes(match[1] as AnnexureSection)) {
      titles.push({ row, code: match[1] as AnnexureSection });
    }
  }
  titles.forEach(({ row: title, code }, index) => {
    const header = title + 1;
    const last = (titles[index + 1]?.row ?? sheet.rowCount + 1) - 1;
    const columns = new Map<string, number>();
    for (let column = 2; column <= Math.max(sheet.columnCount, 7); column += 1) {
      const key = labelKey(own(sheet, header, column));
      if (!key) continue;
      const name = key.startsWith('description')
        ? 'description'
        : key.startsWith('no of')
          ? 'quantity'
          : key.startsWith('dimension')
            ? 'dimensions'
            : key.startsWith('make')
              ? 'makeModel'
              : key.startsWith('serial')
                ? 'serialNo'
                : key.startsWith('year')
                  ? 'year'
                  : key.startsWith('sum insured')
                    ? 'sumInsured'
                    : null;
      if (name && !columns.has(name)) columns.set(name, column);
    }
    const read = (row: number, name: string) => {
      const column = columns.get(name);
      return column ? own(sheet, row, column) : '';
    };
    const rows: DataSheetImport['sections'][number]['annexure'] = [];
    for (let row = header + 1; row <= last; row += 1) {
      const description = read(row, 'description');
      if (!description) continue;
      const where = `Annexure, ${ANNEXURE_SECTIONS[code].title}, row ${row}`;
      const sumInsured = rupees(reader, read(row, 'sumInsured'), where);
      if (sumInsured === null) reader.warnings.push(`${where}: no sum insured; entered as 0.`);
      const quantity = read(row, 'quantity');
      const year = read(row, 'year');
      const count = quantity ? numberOf(quantity) : null;
      if (quantity && !count?.isInteger()) {
        reader.warnings.push(`${where}: "${quantity}" is not a count; left blank.`);
      }
      const yearValue = /^(19|20)\d{2}$/.test(year) ? year : null;
      if (year && !yearValue)
        reader.warnings.push(`${where}: "${year}" is not a year; left blank.`);
      rows.push({
        description: clip(reader, description, where),
        quantity: count?.isInteger() ? count.toFixed() : null,
        dimensions: read(row, 'dimensions') || null,
        makeModel: read(row, 'makeModel') || null,
        serialNo: read(row, 'serialNo') || null,
        year: yearValue,
        sumInsured: sumInsured ?? '0',
      });
    }
    if (rows.length > 0) grids.set(code, rows);
  });
  return grids;
}

/** The case location a sheet's Risk Location names, by location name or first address line. */
function suggestLocations(
  record: Pick<ProposalRecord, 'locations'>,
  texts: readonly (string | null)[],
): (string | null)[] {
  const taken = new Set<string>();
  const named = texts.map((text) => {
    const key = labelKey(text ?? '');
    if (!key) return null;
    const match = record.locations.find((location) => {
      if (taken.has(location.locationId) || !location.location) return false;
      const name = labelKey(location.location.name);
      const line1 = labelKey(location.location.address.line1);
      return (name && key.includes(name)) || (line1 && key.includes(line1));
    });
    if (match) taken.add(match.locationId);
    return match?.locationId ?? null;
  });
  // The rest in order, onto the locations not named.
  const free = record.locations.filter((location) => !taken.has(location.locationId));
  return named.map((id) => id ?? free.shift()?.locationId ?? null);
}

export type DataSheetReadResult =
  { ok: true; value: DataSheetImport } | { ok: false; message: string };

/** Reads a Data Sheet workbook for a case. Nothing is saved. */
export async function readDataSheetWorkbook(
  data: Buffer,
  record: Pick<ProposalRecord, 'locations' | 'client'>,
): Promise<DataSheetReadResult> {
  if (data.length < 4 || data.readUInt32LE(0) !== 0x04034b50) {
    return {
      ok: false,
      message: 'This is not an Excel workbook (.xlsx). Save the file as .xlsx and try again.',
    };
  }
  let workbook: ExcelJS.Workbook;
  try {
    workbook = await openTemplate(data);
  } catch {
    return {
      ok: false,
      message: 'The workbook could not be read. Open it in Excel, save it as .xlsx and try again.',
    };
  }
  const sheets = dataSheets(workbook);
  if (sheets.length === 0) {
    return {
      ok: false,
      message: `No Data Sheet found: the workbook needs a sheet titled "${TITLE}", as in the client's Data Sheet format.`,
    };
  }
  const reader: Reader = { warnings: [] };
  const first = sheets[0];
  const insured = {
    name: first ? valueBeside(first, 'Name of the Insured') : null,
    gstin: first ? valueBeside(first, 'GST No') : null,
    address: first ? valueBeside(first, 'Communication Address') : null,
    natureOfBusiness: first ? valueBeside(first, 'Nature of Business') : null,
    policyPeriod: first ? valueBeside(first, 'Policy Period') : null,
  };
  if (insured.name && labelKey(insured.name) !== labelKey(record.client.name)) {
    reader.warnings.push(
      `The sheet is for "${insured.name}"; this case's client is ${record.client.name}.`,
    );
  }
  if (
    insured.gstin &&
    record.client.gstin &&
    insured.gstin.replace(/\s/g, '').toUpperCase() !== record.client.gstin
  ) {
    reader.warnings.push(
      `The sheet's GST number ${insured.gstin} is not the client's (${record.client.gstin}).`,
    );
  }
  let sections: DataSheetImport['sections'] = [];
  const read = sheets.map((sheet, index) => {
    const place = sheets.length > 1 ? sheet.name : 'Data Sheet';
    const { fire, sumColumn } = readFire(reader, sheet, place);
    const found = readSections(reader, sheet, sumColumn);
    // The other sections are the case's: taken from the first sheet that has them.
    if (sections.length === 0) sections = found;
    else if (found.length > 0) {
      reader.warnings.push(
        `${sheet.name}: its other sections are not read; they are taken from ${sheets[0]?.name ?? 'the first sheet'}.`,
      );
    }
    const hypothecation = valueBesideColumn(sheet, 'Hypothecation if any', sumColumn);
    const openStock = valueBesideColumn(sheet, 'Stock kept at open space', sumColumn);
    return {
      sheetName: sheet.name,
      riskLocation: valueBeside(sheet, 'Risk Location'),
      index,
      fire,
      hypothecation: hypothecation ? clip(reader, hypothecation, `${place}, Hypothecation`) : null,
      openStock: openStock ? clip(reader, openStock, `${place}, Stock kept at open space`) : null,
      risk: readRisk(reader, sheet, place),
    };
  });
  const annexure = readAnnexure(reader, workbook);
  for (const [code, rows] of annexure) {
    const section = sections.find((item) => item.code === code);
    if (section) section.annexure = rows;
    else sections.push({ code, lines: {}, proposed1: null, annexure: rows });
  }
  const suggested = suggestLocations(
    record,
    read.map((sheet) => sheet.riskLocation),
  );
  if (sheets.length > record.locations.length) {
    reader.warnings.push(
      `The workbook has ${sheets.length} Data Sheets and the case ${record.locations.length} location${record.locations.length === 1 ? '' : 's'}: add the locations first, or leave the extra sheets out.`,
    );
  }
  return {
    ok: true,
    value: {
      insured,
      locations: read.map(({ index, ...sheet }) => ({
        ...sheet,
        suggestedLocationId: suggested[index] ?? null,
      })),
      sections,
      warnings: reader.warnings,
    },
  };
}

/** The value of a labelled row in column B (hypothecation, open stock), from the value column. */
function valueBesideColumn(sheet: ExcelJS.Worksheet, label: string, column: number): string | null {
  const row = findRow(sheet, label, { column: 2, prefix: true });
  if (!row) return null;
  const text = own(sheet, row, column);
  return text && !labelKey(text).startsWith(labelKey(label)) ? text : null;
}
