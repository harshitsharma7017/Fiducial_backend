import {
  PDF_CONTENT_TYPE,
  XLSX_CONTENT_TYPE,
  NO_RFQ_EDITS,
  applyRfqEdits,
  isAnnexureSection,
  type RfqEdits,
  type CatalogItem,
  type ProposalRecord,
} from '../../shared/index.ts';
import type ExcelJS from 'exceljs';
import { notFound } from '../../lib/errors.ts';
import { istDay } from '../../lib/ist-day.ts';
import { catalogItems, taxRatePercentOn } from '../catalog/catalog.service.ts';
import { ClientModel } from '../clients/client.model.ts';
import { openTemplate, saveWorkbook, sheetNamed } from '../documents/excel-template.ts';
import { letterheadOf, workbookToPdf, type Letterhead } from '../documents/sheet-pdf.ts';
import { templateFile } from '../documents/templates.service.ts';
import type { ClientDoc } from '../clients/client.model.ts';
import { RfqStateModel } from '../rfq/rfq.model.ts';
import { fillRfqTemplate } from './rfq-template.ts';
import { buildRfqWorkbookDocument, type RfqMasters } from './rfq-workbook.ts';

/** How the RFQ was laid out: in the client's uploaded template, or the built-in layout. */
export type RfqLayout = 'template' | 'built-in';

export interface RfqDocument {
  data: Buffer;
  contentType: string;
  fileName: string;
  layout: RfqLayout;
}

/** The order sheets are printed in the PDF; others follow in the workbook's order. */
const PDF_ORDER = [
  'premium details',
  'schedule',
  'fire by location',
  'Annexure',
  'risk details',
  'claim details',
];

export function pdfSheets(workbook: ExcelJS.Workbook, record: ProposalRecord): ExcelJS.Worksheet[] {
  const anyAnnexure = record.sections.some(
    (section) => section.included && isAnnexureSection(section.code) && section.annexure.length > 0,
  );
  const first = PDF_ORDER.flatMap((name) => {
    const sheet = sheetNamed(workbook, name);
    // An empty annexure grid adds nothing to the paper copy; the Excel keeps it.
    if (!sheet || (name === 'Annexure' && !anyAnnexure)) return [];
    return [sheet];
  });
  const rest = workbook.worksheets.filter(
    (sheet) =>
      !first.includes(sheet) &&
      sheet.state !== 'hidden' &&
      !PDF_ORDER.some((name) => sheetNamed(workbook, name) === sheet),
  );
  return [...first, ...rest];
}

/**
 * The RFQ as Excel or PDF (R-3, R-4). With the client's RFQ template uploaded, it is filled in
 * place; until then the built-in layout is used. The PDF draws the same workbook on A4 with the
 * template's letterhead.
 */
export async function rfqDocument(
  caseRecord: ProposalRecord,
  client: ClientDoc,
  masters: RfqMasters & { addons: readonly CatalogItem<'addons'>[] },
  format: 'xlsx' | 'pdf',
  edits: RfqEdits = NO_RFQ_EDITS,
): Promise<RfqDocument> {
  // R-2: the edits made on the RFQ replace the Data Sheet's values on it.
  const record = applyRfqEdits(caseRecord, edits);
  const title = edits.title ?? undefined;
  const template = await templateFile('RFQ');
  let workbook: ExcelJS.Workbook;
  let letterhead: Letterhead = { logo: null, address: null };
  if (template) {
    workbook = await openTemplate(template.data);
    letterhead = letterheadOf(workbook);
    fillRfqTemplate(workbook, record, client, masters, { title });
  } else {
    workbook = buildRfqWorkbookDocument(record, client, masters, { title });
  }
  const layout: RfqLayout = template ? 'template' : 'built-in';
  const name = `RFQ-${record.reference}`;
  if (format === 'pdf') {
    return {
      data: await workbookToPdf(workbook, {
        sheets: pdfSheets(workbook, record),
        letterhead,
        title: `RFQ ${record.reference} — ${record.client.name}`,
        footer: `RFQ ${record.reference} · ${record.client.name}`,
      }),
      contentType: PDF_CONTENT_TYPE,
      fileName: `${name}.pdf`,
      layout,
    };
  }
  return {
    data: await saveWorkbook(workbook),
    contentType: XLSX_CONTENT_TYPE,
    fileName: `${name}.xlsx`,
    layout,
  };
}

/**
 * The RFQ of a case as it is now, with the masters it reads (GST, products, sections, notes,
 * add-ons): the file the download returns and the mails attach.
 */
export async function rfqFileFor(
  record: ProposalRecord,
  format: 'xlsx' | 'pdf',
  defaultGstRatePercent: string,
  edits?: RfqEdits,
): Promise<RfqDocument> {
  const client = await ClientModel.findById(record.client.id).lean();
  if (!client) throw notFound('The proposal’s client no longer exists');
  const [gstRatePercent, products, sections, notes, addons] = await Promise.all([
    record.gstRatePercent ??
      taxRatePercentOn('GST', istDay(new Date(record.createdAt)), defaultGstRatePercent),
    catalogItems('products'),
    catalogItems('sections'),
    catalogItems('notes'),
    catalogItems('addons'),
  ]);
  const saved = edits ?? (await RfqStateModel.findOne({ proposalId: record.id }).lean())?.edits;
  return rfqDocument(
    record,
    client,
    { gstRatePercent, products, sections, notes, addons },
    format,
    saved ?? NO_RFQ_EDITS,
  );
}
