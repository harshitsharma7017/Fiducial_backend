// The add-on cover lists of the client's workbooks (M-6). In a module of their own because both the
// catalog (the add-on master) and proposals (the add-ons chosen on a case, C-4) use them.

export const ADDON_LISTS = ['FIRE_ADDITIONAL', 'PAR', 'SFSP', 'BSUS_BLUS'] as const;
export type AddonList = (typeof ADDON_LISTS)[number];
export const ADDON_LIST_LABELS: Record<AddonList, string> = {
  FIRE_ADDITIONAL: 'Fire additional',
  PAR: 'PAR',
  SFSP: 'SFSP',
  BSUS_BLUS: 'BSUS & BLUS',
};

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
