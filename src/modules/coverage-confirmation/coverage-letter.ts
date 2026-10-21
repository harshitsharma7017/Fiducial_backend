import {
  PLACED_DOCUMENT_KIND_LABELS,
  QUOTE_OPTION_LABELS,
  formatDate,
  formatIndianNumber,
  type CoveragePolicyDetails,
} from '../../shared/index.ts';
import pdfmake from 'pdfmake';
import type { Content, TableCell } from 'pdfmake';

type TDocumentDefinitions = Parameters<typeof pdfmake.createPdf>[0];
import {
  DOCUMENT_COLORS,
  DOCUMENT_FONT,
  DOCUMENT_FONT_FAMILY,
  DOCUMENT_LINE_HEIGHT,
  MARGIN,
} from '../documents/document-theme.ts';
import {
  documentFooter,
  documentHeader,
  logoDataUrl,
  type Letterhead,
} from '../documents/sheet-pdf.ts';

// Q4: the Coverage Confirmation Letter, drawn directly with pdfmake (not from an Excel workbook)
// but using the shared document theme so it reads as part of the same Fiducial family as the RFQ,
// QCR and Placement Slip PDFs: same letterhead band, footer, page numbering, palette and fonts.
//
// The content comes only from the live policy details and the recorded confirmation. No signatory
// is invented: when one was entered it is shown as typed text with a clear "for and on behalf of"
// line, never as a rendered signature; when none was entered the signature block says the
// signatory is awaiting confirmation. The letter is never represented as signed.

export interface CoverageLetterInput {
  policy: CoveragePolicyDetails;
  confirmedOn: string;
  insurerReference: string | null;
  notes: string | null;
  signatoryName: string | null;
  signatoryTitle: string | null;
  /** The address line shown in the broker's letterhead; null when no template provides one. */
  letterhead: Letterhead;
}

const rupees = (value: string | null) =>
  value === null ? '—' : `₹${formatIndianNumber(value, 0)}`;
const paise = (value: string) => `₹${formatIndianNumber(value, 2)}`;

function detailRow(label: string, value: string): Content {
  return {
    columns: [
      { text: label, width: 150, bold: true, color: DOCUMENT_COLORS.text },
      { text: value, width: '*' },
    ],
    margin: [0, 0, 0, 3],
  };
}

function sectionsTable(policy: CoveragePolicyDetails): Content {
  const header: TableCell[] = [
    { text: 'Section', bold: true, fillColor: DOCUMENT_COLORS.tableHeader },
    { text: 'Sum insured', bold: true, alignment: 'right', fillColor: DOCUMENT_COLORS.tableHeader },
    { text: 'Premium', bold: true, alignment: 'right', fillColor: DOCUMENT_COLORS.tableHeader },
  ];
  const body: TableCell[][] = policy.sections.map((section) => [
    { text: section.name },
    { text: rupees(section.sumInsured), alignment: 'right' },
    { text: paise(section.premium), alignment: 'right' },
  ]);
  const footer: TableCell[][] = policy.premium
    ? [
        [
          { text: 'Net premium', colSpan: 2, alignment: 'right' },
          {},
          { text: paise(policy.premium.net), alignment: 'right' },
        ],
        [
          { text: `GST ${policy.gstRatePercent}%`, colSpan: 2, alignment: 'right' },
          {},
          { text: paise(policy.premium.gst), alignment: 'right' },
        ],
        [
          { text: 'Total premium', colSpan: 2, alignment: 'right', bold: true },
          {},
          { text: paise(policy.premium.total), alignment: 'right', bold: true },
        ],
      ]
    : [];
  return {
    table: { headerRows: 1, widths: ['*', 'auto', 'auto'], body: [header, ...body, ...footer] },
    layout: {
      hLineWidth: () => 0.5,
      vLineWidth: () => 0.5,
      hLineColor: () => DOCUMENT_COLORS.gridline,
      vLineColor: () => DOCUMENT_COLORS.gridline,
      paddingLeft: () => 4,
      paddingRight: () => 4,
      paddingTop: () => 3,
      paddingBottom: () => 3,
    },
    margin: [0, 6, 0, 10],
  };
}

/**
 * The signature block. Never a rendered signature: it shows the configured signatory as typed
 * text (clearly a name/title, not a signature), or a note that the signatory is still to be
 * confirmed by the client. The document is therefore never represented as signed.
 */
function signatureBlock(signatoryName: string | null, signatoryTitle: string | null): Content {
  const stack: Content[] = [
    { text: 'For and on behalf of', margin: [0, 24, 0, 2], color: DOCUMENT_COLORS.text },
    { text: 'Fiducial Insurance Brokers', bold: true },
  ];
  if (signatoryName) {
    stack.push({ text: signatoryName, margin: [0, 16, 0, 0] });
    if (signatoryTitle) stack.push({ text: signatoryTitle, color: DOCUMENT_COLORS.muted });
  } else {
    stack.push({
      text: '[Authorised signatory to be confirmed]',
      italics: true,
      color: DOCUMENT_COLORS.muted,
      margin: [0, 16, 0, 0],
    });
  }
  return { stack };
}

export async function buildCoverageLetter(input: CoverageLetterInput): Promise<Buffer> {
  const { policy } = input;
  const logoImage = logoDataUrl(input.letterhead.logo);
  const docKind = policy.documentKind
    ? PLACED_DOCUMENT_KIND_LABELS[policy.documentKind]
    : 'policy / cover note';

  const details: Content[] = [];
  details.push(detailRow('Insured', policy.insuredName));
  details.push(detailRow('Insurer', `${policy.insurerName}, ${policy.insurerBranch}`));
  if (policy.policyNumber) details.push(detailRow(`${docKind} number`, policy.policyNumber));
  if (policy.issuedOn) details.push(detailRow('Issued on', formatDate(policy.issuedOn)));
  if (policy.policyStart) {
    details.push(
      detailRow(
        'Policy period',
        `${formatDate(policy.policyStart)}${policy.policyEnd ? ` to ${formatDate(policy.policyEnd)}` : ''}`,
      ),
    );
  }
  if (policy.option) details.push(detailRow('Basis', QUOTE_OPTION_LABELS[policy.option]));
  if (input.insurerReference) {
    details.push(detailRow('Insurer reference', input.insurerReference));
  }
  details.push(detailRow('Reference', policy.reference));

  const body: Content[] = [
    { text: formatDate(input.confirmedOn), alignment: 'right', color: DOCUMENT_COLORS.muted },
    {
      text: 'Confirmation of Cover',
      fontSize: DOCUMENT_FONT.title,
      bold: true,
      margin: [0, 10, 0, 2],
    },
    {
      text: `This is to confirm that cover has been placed with ${policy.insurerName}, ${policy.insurerBranch} for ${policy.insuredName}.`,
      margin: [0, 0, 0, 10],
    },
    ...details,
    { text: 'Coverage', fontSize: DOCUMENT_FONT.heading, bold: true, margin: [0, 12, 0, 0] },
    sectionsTable(policy),
  ];
  if (input.notes) {
    body.push({ text: 'Notes', fontSize: DOCUMENT_FONT.heading, bold: true, margin: [0, 6, 0, 2] });
    body.push({ text: input.notes });
  }
  body.push(signatureBlock(input.signatoryName, input.signatoryTitle));

  const definition: TDocumentDefinitions = {
    pageSize: 'A4',
    pageOrientation: 'portrait',
    pageMargins: [MARGIN.left, MARGIN.top, MARGIN.right, MARGIN.bottom],
    info: {
      title: `Coverage confirmation ${policy.reference} — ${policy.insuredName}`,
      creator: 'Fiducial',
      producer: 'Fiducial',
    },
    defaultStyle: {
      font: DOCUMENT_FONT_FAMILY,
      fontSize: DOCUMENT_FONT.body,
      lineHeight: DOCUMENT_LINE_HEIGHT,
    },
    header: () => documentHeader(logoImage, input.letterhead.address),
    footer: (page: number, pages: number) =>
      documentFooter(
        `Coverage confirmation ${policy.reference} · ${policy.insuredName}`,
        page,
        pages,
      ),
    content: body,
  };
  return Buffer.from(await pdfmake.createPdf(definition).getBuffer());
}
