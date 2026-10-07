import {
  PDF_CONTENT_TYPE,
  XLSX_CONTENT_TYPE,
  isAnnexureSection,
  type CatalogItem,
  type ProposalRecord,
} from '../../shared/index.ts';
import type ExcelJS from 'exceljs';
import { openTemplate, saveWorkbook, sheetNamed } from '../documents/excel-template.ts';
import { letterheadOf, workbookToPdf, type Letterhead } from '../documents/sheet-pdf.ts';
import { templateFile } from '../documents/templates.service.ts';
import type { ClientDoc } from '../clients/client.model.ts';
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

function pdfSheets(workbook: ExcelJS.Workbook, record: ProposalRecord): ExcelJS.Worksheet[] {
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
  record: ProposalRecord,
  client: ClientDoc,
  masters: RfqMasters & { addons: readonly CatalogItem<'addons'>[] },
  format: 'xlsx' | 'pdf',
): Promise<RfqDocument> {
  const template = await templateFile('RFQ');
  let workbook: ExcelJS.Workbook;
  let letterhead: Letterhead = { logo: null, address: null };
  if (template) {
    workbook = await openTemplate(template.data);
    letterhead = letterheadOf(workbook);
    fillRfqTemplate(workbook, record, client, masters);
  } else {
    workbook = buildRfqWorkbookDocument(record, client, masters);
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
