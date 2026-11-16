import { z } from 'zod';
import { IsoDateTimeSchema } from './common.ts';

// The header and footer of every generated PDF (RFQ, QCR, placement slip, the group health and
// GPA/GTLI documents and the coverage confirmation letter), set by an Admin in Settings: the
// broker's name and address beside the logo at the top of each page, and the contact line and an
// optional note at the foot. Until it is saved the documents print Fiducial's details.

export const MAX_BRAND_ADDRESS_LINES = 5;

const text = (max: number, message = 'This is too long') => z.string().trim().max(max, message);

export const DocumentBrandInputSchema = z.strictObject({
  /** The first, bold line of the header. */
  companyName: text(200).min(1, 'Enter the company name'),
  /** The address under the name, one line each. */
  addressLines: z
    .array(text(200).min(1, 'Enter the line or remove it'))
    .max(MAX_BRAND_ADDRESS_LINES, `Use at most ${MAX_BRAND_ADDRESS_LINES} address lines`),
  /** The footer's contact line; each part is left out when blank. */
  telephone: text(100),
  email: text(200),
  website: text(200),
  /** An extra line under the contact line (for example a registration number); blank: none. */
  footerNote: text(300),
});
export type DocumentBrandInput = z.infer<typeof DocumentBrandInputSchema>;

export const DocumentBrandSchema = DocumentBrandInputSchema.extend({
  /** Never saved: the documents print the defaults below. */
  isDefault: z.boolean(),
  updatedAt: IsoDateTimeSchema.nullable(),
  updatedBy: z.string().nullable(),
});
export type DocumentBrand = z.infer<typeof DocumentBrandSchema>;

/** Fiducial's letterhead ("Invoice-2"), printed until an Admin saves the header and footer. */
export const DEFAULT_DOCUMENT_BRAND: DocumentBrandInput = {
  companyName: 'Fiducial Insurance Brokers India Pvt Ltd',
  addressLines: [
    'LBR Complex, 172/1, Third Floor, Rajunaidu',
    'Road, Sivananda Colony,',
    'Coimbatore - 641 012.',
  ],
  telephone: '+91 422 4372530 / 2499962',
  email: 'info@fiducial.in',
  website: 'www.fiducial.in',
  footerNote: '',
};
