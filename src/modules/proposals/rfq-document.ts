import {
  PDF_CONTENT_TYPE,
  XLSX_CONTENT_TYPE,
  NO_RFQ_EDITS,
  applyRfqEdits,
  isAnnexureSection,
  type RfqAttribution,
  type RfqEdits,
  type CatalogItem,
  type ProposalRecord,
} from '../../shared/index.ts';
import type ExcelJS from 'exceljs';
import { notFound } from '../../lib/errors.ts';
import { istDay } from '../../lib/ist-day.ts';
import { Types } from 'mongoose';
import { catalogItems, taxRatePercentOn } from '../catalog/catalog.service.ts';
import { ClientModel } from '../clients/client.model.ts';
import {
  centreFigures,
  emboldenWorkbook,
  openTemplate,
  rightAlignFigures,
  saveWorkbook,
  sheetNamed,
} from '../documents/excel-template.ts';
import { letterheadOf, workbookToPdf, type Letterhead } from '../documents/sheet-pdf.ts';
import { withBrokerLetterhead } from '../documents/broker-letterhead.ts';
import { templateFile } from '../documents/templates.service.ts';
import type { ClientDoc } from '../clients/client.model.ts';
import { RfqStateModel, RfqVersionModel } from '../rfq/rfq.model.ts';
import { rfqAttributionOf, rfqAttributionUserIds } from '../rfq/rfq-approval.ts';
import { roleNameMap } from '../roles/roles.service.ts';
import { UserModel } from '../users/user.model.ts';
import { addRfqExtras } from './rfq-extras.ts';
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

/** The order sheets are printed in the QCR's and the placement slip's PDF; others follow. */
const PDF_ORDER = [
  'premium details',
  'schedule',
  'fire by location',
  'Annexure',
  'risk details',
  'claim details',
];

/**
 * The RFQ's PDF (change requests RFQ-1, RFQ-4, RFQ-5): it starts at the schedule, without the
 * premium details page, and has last year's premium and the claim experience in place of the claim
 * details. The Excel keeps every sheet.
 */
const RFQ_PDF_ORDER = [
  'schedule',
  'fire by location',
  'last year premium',
  'claim experience',
  'Annexure',
  'risk details',
];
const RFQ_NOT_IN_PDF = ['premium details', 'claim details'];

export function pdfSheets(
  workbook: ExcelJS.Workbook,
  record: ProposalRecord,
  document: 'RFQ' | 'OTHER' = 'OTHER',
): ExcelJS.Worksheet[] {
  const order = document === 'RFQ' ? RFQ_PDF_ORDER : PDF_ORDER;
  const notInPdf = document === 'RFQ' ? RFQ_NOT_IN_PDF : [];
  const anyAnnexure = record.sections.some(
    (section) => section.included && isAnnexureSection(section.code) && section.annexure.length > 0,
  );
  const anyRisk = record.locations.some((location) =>
    Object.values(location.risk).some((answer) => answer?.trim()),
  );
  // A sheet with nothing in it adds nothing to the paper copy; the Excel keeps it.
  const empty: Record<string, boolean> = {
    Annexure: !anyAnnexure,
    'risk details': !anyRisk,
    'claim experience': record.claims.length === 0,
    'claim details': record.claims.length === 0,
  };
  const first = order.flatMap((name) => {
    const sheet = sheetNamed(workbook, name);
    if (!sheet || empty[name]) return [];
    return [sheet];
  });
  const rest = workbook.worksheets.filter(
    (sheet) =>
      !first.includes(sheet) &&
      !notInPdf.some((name) => sheetNamed(workbook, name) === sheet) &&
      sheet.state !== 'hidden' &&
      !order.some((name) => sheetNamed(workbook, name) === sheet),
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
  attribution?: RfqAttribution,
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
    fillRfqTemplate(workbook, record, client, masters, { title, attribution });
    // Figures centred, as the built-in layout (client review, 28 Oct 2026).
    centreFigures(workbook);
  } else {
    workbook = buildRfqWorkbookDocument(record, client, masters, { title, attribution });
  }
  // Last year's premium and the claim experience (RFQ-4, RFQ-5). No notes (client review).
  addRfqExtras(workbook, record);
  // Amounts and counts to the right of their cells; S No and ticks stay centred.
  rightAlignFigures(workbook);
  // Every line bold, so the RFQ reads easily (client review, 28 Oct 2026).
  emboldenWorkbook(workbook);
  letterhead = await withBrokerLetterhead(letterhead);
  const layout: RfqLayout = template ? 'template' : 'built-in';
  const name = `RFQ-${record.reference}`;
  if (format === 'pdf') {
    return {
      data: await workbookToPdf(workbook, {
        sheets: pdfSheets(workbook, record, 'RFQ'),
        // The schedule opens with its own title, so no "Schedule" band above it.
        withoutHeading: [sheetNamed(workbook, 'schedule')].filter((sheet) => sheet !== undefined),
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
  attribution?: RfqAttribution,
): Promise<RfqDocument> {
  const client = await ClientModel.findById(record.client.id).lean();
  if (!client) throw notFound('The proposal’s client no longer exists');
  const [gstRatePercent, products, sections, notes, addons, clauses] = await Promise.all([
    record.gstRatePercent ??
      taxRatePercentOn('GST', istDay(new Date(record.createdAt)), defaultGstRatePercent),
    catalogItems('products'),
    catalogItems('sections'),
    catalogItems('notes'),
    catalogItems('addons'),
    catalogItems('clauses'),
  ]);
  const saved = edits ?? (await RfqStateModel.findOne({ proposalId: record.id }).lean())?.edits;
  // The caller may pass a specific version's attribution (per-version download); otherwise the
  // latest version's attribution is used (the live case download and the mails).
  const attributionForDoc = attribution ?? (await latestRfqAttribution(record.id));
  return rfqDocument(
    record,
    client,
    { gstRatePercent, products, sections, notes, addons, clauses },
    format,
    saved ?? NO_RFQ_EDITS,
    attributionForDoc,
  );
}

/**
 * A2: the attribution for the latest RFQ version of a case (the one the case download and the
 * mails represent) — its preparer and, once approved, its approver. Null when no version exists
 * yet, so the document simply omits the block.
 */
export async function latestRfqAttribution(
  proposalId: string,
): Promise<RfqAttribution | undefined> {
  const version = await RfqVersionModel.findOne(
    { proposalId: new Types.ObjectId(proposalId) },
    { version: 1, status: 1, createdBy: 1, events: 1 },
  )
    .sort({ version: -1 })
    .lean();
  if (!version) return undefined;
  return rfqAttributionFor(version);
}

/** Resolves an attribution's creator and approver names + roles from the User collection. */
export async function rfqAttributionFor(
  version: Parameters<typeof rfqAttributionOf>[0],
): Promise<RfqAttribution> {
  const ids = rfqAttributionUserIds(version);
  const [users, roleNames] = await Promise.all([
    UserModel.find({ _id: { $in: ids } }, { name: 1, roles: 1 }).lean(),
    roleNameMap(),
  ]);
  return rfqAttributionOf(
    version,
    new Map(users.map((user) => [user._id.toHexString(), { name: user.name, roles: user.roles }])),
    roleNames,
  );
}
