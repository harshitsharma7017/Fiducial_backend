import {
  FIRE_GROUP_LABELS,
  FIRE_ITEMS,
  RISK_DETAIL_FIELDS,
  formatDate,
  productRangeText,
  type CatalogItem,
  type ProposalRecord,
} from '../../shared/index.ts';
import ExcelJS from 'exceljs';
import type { ClientDoc } from '../clients/client.model.ts';

// The RFQ in the client's layout (document 07): premium details for the insurer to fill in,
// the schedule, Fire by location, risk details and claim details. Amounts are whole rupees.
// Products, section add-ons and notes come from the product and cover masters; until those are
// uploaded, the wording of the client's RFQ format is used.

/** The masters the RFQ prints from. */
export interface RfqMasters {
  gstRatePercent: string;
  products: readonly CatalogItem<'products'>[];
  sections: readonly CatalogItem<'sections'>[];
  notes: readonly CatalogItem<'notes'>[];
}

const DEFAULT_FIRE_ADDONS = ['Earthquake', 'Storm, Tempest, Flood & Inundation', 'Terrorism'];
const DEFAULT_PRODUCT_LINES = [
  'Upto 5 Cr sum insured: Bharat Sookshma Udyam Suraksha (BSUS)',
  'Above 5 Cr & Upto 50 Cr sum insured: Bharat Laghu Udyam Suraksha (BLUS)',
  'Above 50 Cr sum insured: Standard Fire & Special Perils Policy (SFSP)',
  'Above 5 Cr sum insured: Property All Risk (PAR)',
];

/** Indian digit grouping (1,23,45,678) for whole rupees. */
const RUPEES = '[>=10000000]##\\,##\\,##\\,##0;[>=100000]##\\,##\\,##0;##,##0';
const HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFE8EEF6' },
};
const ITEM_LABELS = new Map<string, string>(FIRE_ITEMS.map((item) => [item.key, item.label]));

const amount = (value: string | null) => (value === null ? null : Number(value));

function title(sheet: ExcelJS.Worksheet, text: string, span: number) {
  const row = sheet.addRow([text]);
  row.font = { bold: true, size: 13 };
  sheet.mergeCells(row.number, 1, row.number, span);
}

function header(sheet: ExcelJS.Worksheet, values: (string | null)[]) {
  const row = sheet.addRow(values);
  row.font = { bold: true };
  row.alignment = { wrapText: true, vertical: 'top' };
  row.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.border = { bottom: { style: 'thin' } };
  });
  return row;
}

function labelled(sheet: ExcelJS.Worksheet, label: string, value: string, span: number) {
  const row = sheet.addRow([label, value]);
  row.getCell(1).font = { bold: true };
  row.getCell(2).alignment = { wrapText: true, vertical: 'top' };
  if (span > 2) sheet.mergeCells(row.number, 2, row.number, span);
}

function money(row: ExcelJS.Row, columns: number[]) {
  for (const column of columns) row.getCell(column).numFmt = RUPEES;
}

function addressLine(location: NonNullable<ProposalRecord['locations'][number]['location']>) {
  const { address } = location;
  return [address.line1, address.line2, address.city, `${address.state} ${address.pincode}`]
    .filter(Boolean)
    .join(', ');
}

function premiumDetails(workbook: ExcelJS.Workbook, record: ProposalRecord, gstRate: number) {
  const sheet = workbook.addWorksheet('premium details');
  sheet.columns = [{ width: 34 }, { width: 20 }, { width: 22 }, { width: 22 }];
  title(sheet, 'RFQ FOR NEW BUSINESS — PROPERTY INSURANCE', 4);
  labelled(sheet, 'Insured Name:', record.client.name, 4);
  labelled(sheet, 'Reference:', record.reference, 4);
  labelled(sheet, 'Quotes needed by:', formatDate(record.dueDate), 4);
  const hasOption2 =
    record.fire.proposed2 !== null || record.sections.some((s) => s.included && s.proposed2);

  for (const option of hasOption2 ? [1, 2] : [1]) {
    sheet.addRow([]);
    const caption = sheet.addRow([
      `Quote Option ${option}: For Proposed Sum Insured Option ${option}`,
    ]);
    caption.font = { bold: true };
    header(sheet, [
      'Coverage Section',
      'Sum Insured',
      'Premium with terrorism',
      'Premium without terrorism',
    ]);
    const first = sheet.rowCount + 1;
    const fire = option === 1 ? record.fire.proposed1 : record.fire.proposed2;
    money(sheet.addRow(['Fire', amount(fire)]), [2, 3, 4]);
    for (const section of record.sections) {
      const value = option === 1 ? section.proposed1 : section.proposed2;
      const row = sheet.addRow([section.name, section.included ? amount(value) : 'Not required']);
      money(row, [2, 3, 4]);
    }
    const last = sheet.rowCount;
    const net = sheet.addRow([
      'Net Premium',
      null,
      { formula: `SUM(C${first}:C${last})` },
      { formula: `SUM(D${first}:D${last})` },
    ]);
    const gst = sheet.addRow([
      `Add: GST ${gstRate}%`,
      null,
      { formula: `C${net.number}*${gstRate / 100}` },
      { formula: `D${net.number}*${gstRate / 100}` },
    ]);
    const total = sheet.addRow([
      'Total Premium',
      null,
      { formula: `C${net.number}+C${gst.number}` },
      { formula: `D${net.number}+D${gst.number}` },
    ]);
    for (const row of [net, gst, total]) {
      row.font = { bold: true };
      money(row, [3, 4]);
    }
  }
}

function schedule(
  workbook: ExcelJS.Workbook,
  record: ProposalRecord,
  client: ClientDoc,
  masters: RfqMasters,
) {
  const sectionMaster = new Map(masters.sections.map((section) => [section.code, section]));
  const sheet = workbook.addWorksheet('schedule');
  sheet.columns = [{ width: 24 }, { width: 70 }, { width: 22 }, { width: 22 }];
  title(sheet, 'RFQ - SCHEDULE FOR PROPERTY INSURANCE', 4);
  labelled(sheet, 'Insured Name', client.name, 4);
  labelled(sheet, 'Insured GST No', client.gstin ?? 'Not registered', 4);
  const { address } = client;
  labelled(
    sheet,
    'Communication Address',
    [address.line1, address.line2, address.city, `${address.state} ${address.pincode}`]
      .filter(Boolean)
      .join(', '),
    4,
  );
  record.locations.forEach((location, index) => {
    const text = location.location
      ? `${location.location.name}: ${addressLine(location.location)}`
      : location.locationId;
    labelled(sheet, index === 0 ? 'Risk Location' : '', text, 4);
  });
  labelled(
    sheet,
    'Policy Period',
    record.policyStart
      ? `For 1 year from ${formatDate(record.policyStart)}`
      : 'For 1 year from date of payment',
    4,
  );
  labelled(sheet, 'Nature of business', client.natureOfBusiness, 4);
  labelled(sheet, 'Occupancy', `${client.occupancy.tacCode} — ${client.occupancy.description}`, 4);

  sheet.addRow([]);
  header(sheet, [
    'S No',
    'Description',
    'Proposed Sum Insured - Option 1',
    'Proposed Sum Insured - Option 2',
  ]);
  sheet.addRow(['Fire & Allied Perils']).font = { bold: true };
  record.fire.groups.forEach((line, index) => {
    const row = sheet.addRow([
      index + 1,
      FIRE_GROUP_LABELS[line.group],
      amount(line.proposed1),
      amount(line.proposed2),
    ]);
    row.getCell(2).alignment = { wrapText: true };
    money(row, [3, 4]);
  });
  const total = sheet.addRow([
    null,
    'Total Sum Insured - Fire & Allied Perils',
    amount(record.fire.proposed1),
    amount(record.fire.proposed2),
  ]);
  total.font = { bold: true };
  money(total, [3, 4]);
  const fire = sectionMaster.get('FIRE');
  (fire ? fire.addons : DEFAULT_FIRE_ADDONS).forEach((addon, index) => {
    sheet.addRow([index === 0 ? 'Addon coverages' : null, addon]);
  });
  const products = masters.products.filter((product) => product.active);
  const productLines =
    products.length > 0
      ? products.map((product) => `${productRangeText(product)} sum insured: ${product.name}`)
      : DEFAULT_PRODUCT_LINES;
  productLines.forEach((line, index) => {
    sheet.addRow([index === 0 ? 'Product to be chosen' : null, line]);
  });
  for (const location of record.locations) {
    const name = location.location?.name ?? location.locationId;
    if (location.hypothecation)
      sheet.addRow(['Hypothecation', `${name}: ${location.hypothecation}`]);
    if (location.openStock) sheet.addRow(['Stock in open space', `${name}: ${location.openStock}`]);
  }

  const included = record.sections.filter((section) => section.included);
  for (const section of included) {
    sheet.addRow([]);
    sheet.addRow([section.name]).font = { bold: true };
    money(
      sheet.addRow([1, 'Sum insured', amount(section.proposed1), amount(section.proposed2)]),
      [3, 4],
    );
    (sectionMaster.get(section.code)?.addons ?? []).forEach((addon, index) => {
      sheet.addRow([index === 0 ? 'Addon coverages' : null, addon]);
    });
  }
  const excluded = record.sections.filter((section) => !section.included);
  if (excluded.length > 0) {
    sheet.addRow([]);
    labelled(sheet, 'Not required', excluded.map((s) => s.name).join(', '), 4);
  }
  if (record.notes) labelled(sheet, 'Notes', record.notes, 4);

  const notes = masters.notes.filter((note) => note.active && note.onRfq);
  if (notes.length > 0) {
    sheet.addRow([]);
    sheet.addRow(['NOTE:']).font = { bold: true };
    for (const note of notes) {
      const row = sheet.addRow([note.text]);
      row.alignment = { wrapText: true, vertical: 'top' };
      sheet.mergeCells(row.number, 1, row.number, 4);
      row.height = Math.max(15, Math.ceil(note.text.length / 110) * 15);
    }
  }
}

function fireByLocation(workbook: ExcelJS.Workbook, record: ProposalRecord) {
  const sheet = workbook.addWorksheet('fire by location');
  sheet.columns = [{ width: 44 }, { width: 14 }, { width: 18 }, { width: 22 }];
  title(sheet, 'FIRE & ALLIED PERILS — SUM INSURED BY LOCATION (OPTION 1)', 4);
  for (const location of record.locations) {
    sheet.addRow([]);
    const place = location.location;
    sheet.addRow([place?.name ?? location.locationId]).font = { bold: true };
    if (place) {
      sheet.addRow([addressLine(place)]);
      sheet.addRow([
        `District ${place.district || '—'} · EQ zone ${place.eqZone ?? '—'} · Occupancy ${place.occupancy.tacCode} — ${place.occupancy.description}`,
      ]);
    }
    header(sheet, ['Item', 'Sq ft', 'Rate per sq ft', 'Sum insured']);
    for (const item of location.fire) {
      const row = sheet.addRow([
        ITEM_LABELS.get(item.key) ?? item.key,
        item.sqFt === null ? null : Number(item.sqFt),
        amount(item.ratePerSqFt),
        amount(item.sumInsured),
      ]);
      money(row, [3, 4]);
    }
    const total = sheet.addRow(['Total', null, null, amount(location.fireTotal)]);
    total.font = { bold: true };
    money(total, [4]);
  }
}

function riskDetails(workbook: ExcelJS.Workbook, record: ProposalRecord) {
  const sheet = workbook.addWorksheet('risk details');
  sheet.columns = [{ width: 6 }, { width: 40 }, ...record.locations.map(() => ({ width: 32 }))];
  header(sheet, [
    null,
    null,
    ...record.locations.map((l, i) => l.location?.name ?? `Location ${i + 1}`),
  ]);
  RISK_DETAIL_FIELDS.forEach((field, index) => {
    const row = sheet.addRow([
      index + 1,
      field.label,
      ...record.locations.map((l) => l.risk[field.key] ?? ''),
    ]);
    row.alignment = { wrapText: true, vertical: 'top' };
  });
}

function claimDetails(workbook: ExcelJS.Workbook, record: ProposalRecord) {
  const sheet = workbook.addWorksheet('claim details');
  sheet.columns = [
    { width: 14 },
    { width: 18 },
    { width: 18 },
    { width: 18 },
    { width: 18 },
    { width: 36 },
    { width: 28 },
  ];
  sheet.addRow(['Past 3 years claim details:']).font = { bold: true };
  header(sheet, [
    'Policy Period',
    'Policy Type',
    'Sum Insured',
    'Premium before tax',
    'Claimed Amount',
    'Claim Remarks',
    'Insurer',
  ]);
  if (record.claims.length === 0) sheet.addRow(['No claims reported']);
  for (const claim of record.claims) {
    const row = sheet.addRow([
      claim.period,
      claim.policyType,
      amount(claim.sumInsured),
      amount(claim.premium),
      amount(claim.claimedAmount),
      claim.remarks,
      claim.insurer,
    ]);
    money(row, [3, 4, 5]);
  }
}

export async function buildRfqWorkbook(
  record: ProposalRecord,
  client: ClientDoc,
  masters: RfqMasters,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Fiducial';
  premiumDetails(workbook, record, Number(masters.gstRatePercent));
  schedule(workbook, record, client, masters);
  fireByLocation(workbook, record);
  riskDetails(workbook, record);
  claimDetails(workbook, record);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
