import { openTemplate } from './excel-template.ts';
import { letterheadOf, type Letterhead } from './sheet-pdf.ts';
import { templateFile } from './templates.service.ts';

// The broker's header (logo and address) is taken from the uploaded Placement Slip template, as
// the Coverage Confirmation Letter already does. A document whose own template has no logo or
// address, or that is built in because no template is uploaded, uses it too, so every PDF has
// the same header. A logo or address the document's own template does hold is kept.

async function placementSlipLetterhead(): Promise<Letterhead> {
  const template = await templateFile('PLACEMENT_SLIP');
  if (!template) return { logo: null, address: null };
  try {
    return letterheadOf(await openTemplate(template.data));
  } catch {
    return { logo: null, address: null };
  }
}

/** The document's own letterhead, with what it lacks taken from the Placement Slip template. */
export async function withBrokerLetterhead(own: Letterhead): Promise<Letterhead> {
  if (own.logo && own.address) return own;
  const broker = await placementSlipLetterhead();
  return { logo: own.logo ?? broker.logo, address: own.address ?? broker.address };
}
