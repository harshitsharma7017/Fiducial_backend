import { z } from 'zod';

// The add-on cover lists of the client's workbooks (M-6). In a module of their own because both the
// catalog (the add-on master) and proposals (the add-ons chosen on a case, C-4) use them.

export const ADDON_LISTS = [
  'FIRE_ADDITIONAL',
  'PAR',
  'SFSP',
  'BSUS_BLUS',
  'EMPLOYEE_BENEFITS',
] as const;
export type AddonList = (typeof ADDON_LISTS)[number];
export const ADDON_LIST_LABELS: Record<AddonList, string> = {
  FIRE_ADDITIONAL: 'Fire additional',
  PAR: 'PAR',
  SFSP: 'SFSP',
  BSUS_BLUS: 'BSUS & BLUS',
  EMPLOYEE_BENEFITS: 'Employee Benefits',
};

/** The add-on list the Employee Benefits cases (GMC, GPA, GTLI) choose their covers from. */
export const EB_ADDON_LIST = 'EMPLOYEE_BENEFITS' satisfies AddonList;
export const MAX_EB_ADDONS = 50;

/**
 * The add-on covers asked for on an Employee Benefits case, by name from the Employee Benefits
 * list of the add-on master (checked against it by the API). Missing on cases saved before: none.
 */
export const EbAddonsSchema = z
  .array(z.string().trim().min(1).max(300))
  .max(MAX_EB_ADDONS, `Choose at most ${MAX_EB_ADDONS} add-on covers`)
  .refine(
    (names) => new Set(names.map((name) => name.toLowerCase())).size === names.length,
    'Each add-on cover once',
  )
  .default([]);

/**
 * The add-on lists offered for a product: those the product master names, else the lists whose
 * code contains the product's (BSUS and BLUS → BSUS & BLUS, PAR → PAR, SFSP → SFSP).
 */
export function addonListsForProduct(product: {
  code: string;
  addonLists?: readonly AddonList[] | null;
}): AddonList[] {
  if (product.addonLists && product.addonLists.length > 0) return [...product.addonLists];
  return ADDON_LISTS.filter((list) => list.split('_').includes(product.code));
}
