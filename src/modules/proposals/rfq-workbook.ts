import {
  ADDON_LIST_LABELS,
  BURGLARY_BASIS_LABELS,
  DEFAULT_FIRE_COVERS,
  FIRE_GROUP_LABELS,
  ANNEXURE_SECTIONS,
  FIRE_ITEM_HEADINGS,
  FIRE_ITEMS,
  HYPOTHECATION_LABEL,
  OPEN_STOCK_LABEL,
  RISK_DETAIL_FIELDS,
  SECTION_LINES,
  SUM_INSURED_LINE,
  annexureColumnLabel,
  isAnnexureSection,
  type AnnexureColumn,
  type AnnexureSection,
  type SectionWithLines,
  formatDate,
  productRangeText,
  type CatalogItem,
  type Cover,
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
  const renewal = record.type === 'EXISTING';
  title(
    sheet,
    renewal ? 'RFQ FOR RENEWAL — PROPERTY INSURANCE' : 'RFQ FOR NEW BUSINESS — PROPERTY INSURANCE',
    4,
  );
  labelled(sheet, 'Insured Name:', record.client.name, 4);
  labelled(sheet, 'Reference:', record.reference, 4);
  if (renewal && record.existing) {
    const existing = record.existing;
    labelled(
      sheet,
      'Existing policy:',
      `${existing.policyNumber ? `${existing.policyNumber} with ` : ''}${existing.insurer}`,
      4,
    );
    const premium = record.existingPolicy?.totalPremium ?? null;
    if (premium) {
      const row = sheet.addRow(['Existing premium:', amount(premium)]);
      row.getCell(1).font = { bold: true };
      money(row, [2]);
    }
  }
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
  // A renewal adds the client format's "Existing Sum Insured" column, from last year's policy.
  const renewal = record.type === 'EXISTING';
  const existing = record.existing;
  const copy = record.existingPolicy;
  const span = renewal ? 5 : 4;
  const amountColumns = renewal ? [3, 4, 5] : [3, 4];
  const figures = (
    existingValue: string | null | undefined,
    p1: string | null | undefined,
    p2: string | null | undefined,
  ) =>
    renewal
      ? [amount(existingValue ?? null), amount(p1 ?? null), amount(p2 ?? null)]
      : [amount(p1 ?? null), amount(p2 ?? null)];
  // C-6: each add-on cover marked as asked for or not, in the option columns.
  const covers = (list: readonly Cover[], option2: boolean) => {
    list.forEach((cover, index) => {
      const answer = cover.required === null ? null : cover.required ? 'Required' : 'Not required';
      sheet.addRow([
        index === 0 ? 'Addon coverages' : null,
        cover.name,
        ...(renewal ? [null] : []),
        answer,
        option2 ? answer : null,
      ]);
    });
  };
  const sheet = workbook.addWorksheet('schedule');
  sheet.columns = [{ width: 24 }, { width: 70 }, { width: 22 }, { width: 22 }, { width: 22 }].slice(
    0,
    span,
  );
  if (renewal) {
    sheet.addRow([`Policy No: ${existing?.policyNumber ?? ''}`]).font = { bold: true };
  }
  title(sheet, 'RFQ - SCHEDULE FOR PROPERTY INSURANCE', span);
  labelled(sheet, 'Insured Name', client.name, span);
  labelled(sheet, 'Insured GST No', client.gstin ?? 'Not registered', span);
  const { address } = client;
  labelled(
    sheet,
    'Communication Address',
    [address.line1, address.line2, address.city, `${address.state} ${address.pincode}`]
      .filter(Boolean)
      .join(', '),
    span,
  );
  record.locations.forEach((location, index) => {
    const text = location.location
      ? `${location.location.name}: ${addressLine(location.location)}`
      : location.locationId;
    labelled(sheet, index === 0 ? 'Risk Location' : '', text, span);
  });
  labelled(
    sheet,
    'Policy Period',
    record.policyStart && record.policyEnd
      ? `${formatDate(record.policyStart)} to ${formatDate(record.policyEnd)}`
      : record.policyStart
        ? `For 1 year from ${formatDate(record.policyStart)}`
        : 'For 1 year from date of payment',
    span,
  );
  if (renewal) {
    labelled(
      sheet,
      'Existing Policy',
      existing
        ? [
            `${existing.policyNumber ? `${existing.policyNumber} with ` : ''}${existing.insurer}`,
            copy?.periodStart && copy.periodEnd
              ? `${formatDate(copy.periodStart)} to ${formatDate(copy.periodEnd)}`
              : null,
            copy?.totalPremium ? `premium ${copy.totalPremium}` : null,
          ]
            .filter(Boolean)
            .join(', ')
        : 'Not available',
      span,
    );
  }
  labelled(sheet, 'Nature of business', client.natureOfBusiness, span);
  labelled(
    sheet,
    'Occupancy',
    `${client.occupancy.tacCode} — ${client.occupancy.description}`,
    span,
  );

  sheet.addRow([]);
  header(sheet, [
    'S No',
    'Description',
    ...(renewal ? ['Existing Sum Insured'] : []),
    'Proposed Sum Insured - Option 1',
    'Proposed Sum Insured - Option 2',
  ]);
  sheet.addRow(['Fire & Allied Perils']).font = { bold: true };
  record.fire.groups.forEach((line, index) => {
    const row = sheet.addRow([
      index + 1,
      FIRE_GROUP_LABELS[line.group],
      ...figures(line.existing, line.proposed1, line.proposed2),
    ]);
    row.getCell(2).alignment = { wrapText: true };
    money(row, amountColumns);
  });
  const total = sheet.addRow([
    null,
    'Total Sum Insured - Fire & Allied Perils',
    ...figures(record.fire.existing, record.fire.proposed1, record.fire.proposed2),
  ]);
  total.font = { bold: true };
  money(total, amountColumns);
  const fire = sectionMaster.get('FIRE');
  covers(
    record.fire.covers.length > 0
      ? record.fire.covers
      : (fire ? fire.addons : DEFAULT_FIRE_COVERS).map((name) => ({ name, required: null })),
    record.fire.proposed2 !== null,
  );
  // C-1: the product the case chose, else every product with its range.
  const decided = record.product && record.product.source !== 'SUGGESTED' ? record.product : null;
  const products = masters.products.filter((product) => product.active);
  const chosenProduct = decided
    ? masters.products.find((product) => product.code === decided.code)
    : undefined;
  const productLines = decided
    ? [
        chosenProduct
          ? `${productRangeText(chosenProduct)} sum insured: ${chosenProduct.name}`
          : decided.name,
      ]
    : products.length > 0
      ? products.map((product) => `${productRangeText(product)} sum insured: ${product.name}`)
      : DEFAULT_PRODUCT_LINES;
  productLines.forEach((line, index) => {
    sheet.addRow([index === 0 ? (decided ? 'Product' : 'Product to be chosen') : null, line]);
  });
  if (record.addons.length > 0) {
    sheet.addRow(['Additional Addon cover', 'Details as per attached list of addons']);
  }
  for (const location of record.locations) {
    const name = location.location?.name ?? location.locationId;
    if (location.hypothecation)
      sheet.addRow(['Hypothecation', `${name}: ${location.hypothecation}`]);
    if (location.openStock)
      sheet.addRow(['Stock kept at open space', `${name}: ${location.openStock}`]);
  }

  const included = record.sections.filter((section) => section.included);
  for (const section of included) {
    sheet.addRow([]);
    sheet.addRow([section.name]).font = { bold: true };
    // The Data Sheet's lines for the section (D-4), then its sum insured.
    const lines = SECTION_LINES[section.code as SectionWithLines] ?? [];
    let number = 1;
    for (const line of lines) {
      if (SUM_INSURED_LINE[section.code] === line.key) continue;
      const row = sheet.addRow([
        number,
        line.label,
        ...figures(
          section.existingLines[line.key],
          section.lines[line.key],
          section.lines2[line.key],
        ),
      ]);
      if (line.kind === 'rupees') money(row, amountColumns);
      number += 1;
    }
    money(
      sheet.addRow([
        number,
        isAnnexureSection(section.code)
          ? `As per Annexure${section.annexure.length > 0 ? ` (${section.annexure.length} ${section.annexure.length === 1 ? 'item' : 'items'})` : ''}`
          : SUM_INSURED_LINE[section.code]
            ? (lines.find((line) => line.key === SUM_INSURED_LINE[section.code])?.label ??
              'Sum insured')
            : 'Sum insured',
        ...figures(section.existing, section.proposed1, section.proposed2),
      ]),
      amountColumns,
    );
    // C-3: the sum insured on the chosen basis (100% or first loss).
    if (section.basis && section.basisAmounts) {
      money(
        sheet.addRow([
          null,
          `Total Sum Insured - Burglary on ${BURGLARY_BASIS_LABELS[section.basis]}`,
          ...figures(null, section.basisAmounts.proposed1, section.basisAmounts.proposed2),
        ]),
        amountColumns,
      );
    }
    covers(section.covers, section.proposed2 !== null);
  }
  const excluded = record.sections.filter((section) => !section.included);
  if (excluded.length > 0) {
    sheet.addRow([]);
    labelled(sheet, 'Not required', excluded.map((s) => s.name).join(', '), span);
  }
  if (record.notes) labelled(sheet, 'Notes', record.notes, span);

  const notes = masters.notes.filter((note) => note.active && note.onRfq);
  if (notes.length > 0) {
    sheet.addRow([]);
    sheet.addRow(['NOTE:']).font = { bold: true };
    for (const note of notes) {
      const row = sheet.addRow([note.text]);
      row.alignment = { wrapText: true, vertical: 'top' };
      sheet.mergeCells(row.number, 1, row.number, span);
      row.height = Math.max(15, Math.ceil(note.text.length / 110) * 15);
    }
  }
}

/**
 * Fire & Burglary per location in the client's Data Sheet layout: the 7 numbered items with their
 * sub-items (headings 1 and 5 show the sum of theirs), sq ft and rate for buildings, the total,
 * then hypothecation and stock in open space.
 */
function fireByLocation(workbook: ExcelJS.Workbook, record: ProposalRecord) {
  const sheet = workbook.addWorksheet('fire by location');
  sheet.columns = [{ width: 6 }, { width: 70 }, { width: 14 }, { width: 18 }, { width: 22 }];
  title(sheet, 'FIRE & BURGLARY — SUM INSURED BY LOCATION (OPTION 1)', 5);
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
    header(sheet, [
      'S No',
      'Description',
      'Sq. Feet (total builtup area)',
      'Rate / sq ft (construction cost per sq ft)',
      'Sum Insured',
    ]);
    const saved = new Map(location.fire.map((item) => [item.key, item]));
    const headed = new Set<string>();
    for (const item of FIRE_ITEMS) {
      const heading = FIRE_ITEM_HEADINGS[item.group];
      if (heading && !headed.has(item.group)) {
        headed.add(item.group);
        const subtotal = FIRE_ITEMS.filter((other) => other.group === item.group)
          .map((other) => saved.get(other.key)?.sumInsured ?? '0')
          .reduce((total, value) => total + Number(value), 0);
        const row = sheet.addRow([heading.number, heading.label, null, null, subtotal || null]);
        row.font = { bold: true };
        row.getCell(2).alignment = { wrapText: true };
        money(row, [5]);
      }
      const values = saved.get(item.key);
      const sub = heading !== undefined || item.number.length > 1;
      const row = sheet.addRow([
        sub ? item.number.slice(-1) : item.number,
        item.label,
        values?.sqFt == null ? null : Number(values.sqFt),
        amount(values?.ratePerSqFt ?? null),
        values ? amount(values.sumInsured) || null : null,
      ]);
      row.getCell(2).alignment = { wrapText: true, indent: sub ? 2 : 0 };
      money(row, [4, 5]);
    }
    const total = sheet.addRow([null, 'Total sum insured', null, null, amount(location.fireTotal)]);
    total.font = { bold: true };
    money(total, [5]);
    for (const [number, label, value] of [
      ['1', HYPOTHECATION_LABEL, location.hypothecation],
      ['2', OPEN_STOCK_LABEL, location.openStock],
    ] as const) {
      const row = sheet.addRow([number, label, value ?? 'Nil']);
      sheet.mergeCells(row.number, 3, row.number, 5);
      row.getCell(3).alignment = { wrapText: true, vertical: 'top' };
    }
  }
}

/** The client's Annexure sheet (D-5): each included annexure section's items and their total. */
function annexure(workbook: ExcelJS.Workbook, record: ProposalRecord) {
  const sections = record.sections.filter(
    (section) => section.included && isAnnexureSection(section.code) && section.annexure.length > 0,
  );
  if (sections.length === 0) return;
  const sheet = workbook.addWorksheet('Annexure');
  sheet.columns = [
    { width: 6 },
    { width: 40 },
    { width: 22 },
    { width: 22 },
    { width: 22 },
    { width: 22 },
  ];
  title(sheet, 'ANNEXURE', 6);
  for (const section of sections) {
    const code = section.code as AnnexureSection;
    const columns = ANNEXURE_SECTIONS[code].columns as readonly AnnexureColumn[];
    sheet.addRow([]);
    const heading = sheet.addRow([ANNEXURE_SECTIONS[code].title]);
    heading.font = { bold: true };
    sheet.mergeCells(heading.number, 1, heading.number, 6);
    header(sheet, [
      'S No',
      ...columns.map((column) => annexureColumnLabel(code, column)),
      'Sum Insured',
    ]);
    section.annexure.forEach((row, index) => {
      const values = columns.map((column) =>
        column === 'quantity' && row.quantity !== null ? Number(row.quantity) : row[column],
      );
      const added = sheet.addRow([index + 1, ...values, amount(row.sumInsured)]);
      added.getCell(2).alignment = { wrapText: true };
      money(added, [columns.length + 2]);
    });
    const total = sheet.addRow([
      null,
      'Total',
      ...columns.slice(1).map(() => null),
      amount(section.proposed1),
    ]);
    total.font = { bold: true };
    money(total, [columns.length + 2]);
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

/** The add-on covers chosen on the case (C-4), with their limits where the master gives them. */
function addonCovers(
  workbook: ExcelJS.Workbook,
  record: ProposalRecord,
  addons: readonly CatalogItem<'addons'>[],
) {
  if (record.addons.length === 0) return;
  const sheet = workbook.addWorksheet('add-on covers');
  sheet.columns = [{ width: 6 }, { width: 18 }, { width: 60 }, { width: 50 }];
  title(sheet, `ADD-ON COVERS${record.product ? ` — ${record.product.name}` : ''}`, 4);
  header(sheet, ['S No', 'List', 'Addon cover', 'Sum insured limit']);
  record.addons.forEach((addon, index) => {
    const known = addons.find(
      (item) => item.list === addon.list && item.name.toLowerCase() === addon.name.toLowerCase(),
    );
    const row = sheet.addRow([
      index + 1,
      ADDON_LIST_LABELS[addon.list],
      addon.name,
      known?.limit ?? null,
    ]);
    row.alignment = { wrapText: true, vertical: 'top' };
  });
}

/** The built-in RFQ layout, used until the client's RFQ template is uploaded. */
export function buildRfqWorkbookDocument(
  record: ProposalRecord,
  client: ClientDoc,
  masters: RfqMasters & { addons?: readonly CatalogItem<'addons'>[] },
): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Fiducial';
  premiumDetails(workbook, record, Number(masters.gstRatePercent));
  schedule(workbook, record, client, masters);
  fireByLocation(workbook, record);
  annexure(workbook, record);
  riskDetails(workbook, record);
  claimDetails(workbook, record);
  addonCovers(workbook, record, masters.addons ?? []);
  return workbook;
}

export async function buildRfqWorkbook(
  record: ProposalRecord,
  client: ClientDoc,
  masters: RfqMasters,
): Promise<Buffer> {
  return Buffer.from(await buildRfqWorkbookDocument(record, client, masters).xlsx.writeBuffer());
}
