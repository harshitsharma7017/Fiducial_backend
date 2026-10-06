import { z } from 'zod';

/**
 * GST state codes: the first two digits of a GSTIN. 97 is "Other Territory" and 99 "Centre
 * Jurisdiction". 25 (Daman and Diu) and 28 (Andhra Pradesh before 2014) are still printed on
 * registrations issued under them.
 */
export const GST_STATE_CODES: Readonly<Record<string, string>> = {
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '25': 'Daman and Diu',
  '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra',
  '28': 'Andhra Pradesh (before 2014)',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
  '97': 'Other Territory',
  '99': 'Centre Jurisdiction',
};

/**
 * A regular taxpayer's GSTIN: state code, the holder's PAN (5 letters, 4 digits, 1 letter), the
 * registration number for that PAN in the state (1-9, A-Z), "Z", and a check character.
 */
const GSTIN_PATTERN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const GSTIN_CHARACTERS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export const GSTIN_EXAMPLE = '27AAPFU0939F1ZV';

/** The 15th character of a GSTIN, computed from the first 14 (the GSTN mod-36 check). */
export function gstinCheckCharacter(first14: string): string {
  let sum = 0;
  for (let index = 0; index < 14; index += 1) {
    const product = GSTIN_CHARACTERS.indexOf(first14.charAt(index)) * (index % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_CHARACTERS.charAt((36 - (sum % 36)) % 36);
}

/** Why a GSTIN (already trimmed and upper-cased) is invalid, or null when it is valid. */
export function gstinProblem(gstin: string): string | null {
  if (gstin.length !== 15) return 'A GSTIN has 15 characters';
  if (!GSTIN_PATTERN.test(gstin)) {
    return `Enter the GSTIN as printed on the registration, for example ${GSTIN_EXAMPLE}`;
  }
  if (!Object.hasOwn(GST_STATE_CODES, gstin.slice(0, 2))) {
    return `${gstin.slice(0, 2)} is not a GST state code`;
  }
  if (gstinCheckCharacter(gstin) !== gstin.charAt(14)) {
    return 'This GSTIN fails its check digit. Check it for a typing mistake.';
  }
  return null;
}

/** A GSTIN, normalised to upper case without spaces, and checked for format, state and check digit. */
export const GstinSchema = z
  .string()
  .transform((value) => value.replace(/\s+/g, '').toUpperCase())
  .superRefine((value, context) => {
    const problem = gstinProblem(value);
    if (problem) context.addIssue({ code: 'custom', message: problem });
  });
