import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import pdfmake from 'pdfmake';

// A text PDF laid out like an insurer's quote, for the auto-fill tests: synthetic, with made-up
// insurer wording. It proves the reader on this layout, not on any real insurer's.

const fontDir = join(
  dirname(createRequire(import.meta.url).resolve('pdfmake/package.json')),
  'fonts',
  'Roboto',
);
pdfmake.setFonts({
  Roboto: {
    normal: join(fontDir, 'Roboto-Regular.ttf'),
    bold: join(fontDir, 'Roboto-Medium.ttf'),
    italics: join(fontDir, 'Roboto-Italic.ttf'),
    bolditalics: join(fontDir, 'Roboto-MediumItalic.ttf'),
  },
});
pdfmake.setUrlAccessPolicy(() => false);
pdfmake.setLocalAccessPolicy((path) => path.startsWith(fontDir));

/** Rows of text cells, one printed line each (cells of a row share the line). */
export async function textPdf(rows: string[][]): Promise<Buffer> {
  const columns = Math.max(1, ...rows.map((row) => row.length));
  const body = rows.map((row) => Array.from({ length: columns }, (_, index) => row[index] ?? ''));
  const definition = {
    defaultStyle: { font: 'Roboto', fontSize: 10 },
    content: [
      {
        table: { widths: Array.from({ length: columns }, () => 'auto'), body },
        layout: 'noBorders',
      },
    ],
  } as Parameters<typeof pdfmake.createPdf>[0];
  return Buffer.from(await pdfmake.createPdf(definition).getBuffer());
}

/** The standard synthetic quote used by the tests. */
export const SYNTHETIC_QUOTE_ROWS = [
  ['Fiducial Test Insurance Co. Ltd.'],
  ['Quotation No: FTI/2026/0457'],
  ['Section', 'Sum insured', 'Premium (Rs.)'],
  ['Fire and Special Perils (with terrorism)', '6,00,00,000', '1,00,000.50'],
  ['Fire and Special Perils (without terrorism)', '6,00,00,000', '90,000.00'],
  ['Money in Transit', '5,00,000', '2,500.00'],
  ['Net Premium (before GST)', '1,02,500.50'],
  ['GST @ 18%', '18,450.09'],
  ['Total Premium payable', '1,20,950.59'],
  ['This quotation is valid till 31/12/2026'],
];
