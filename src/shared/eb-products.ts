import { z } from 'zod';

// The Employee Benefits products (N1): GMC is the existing group health (GHI) product; GPA and
// GTLI sit beside it. Kept in its own module so the family plan and case contracts can share it.

export const EB_PRODUCTS = ['GMC', 'GPA', 'GTLI'] as const;
export const EbProductSchema = z.enum(EB_PRODUCTS, {
  error: 'Choose GMC, GPA or GTLI',
});
export type EbProduct = z.infer<typeof EbProductSchema>;

export const EB_PRODUCT_LABELS: Record<EbProduct, string> = {
  GMC: 'GMC (Group Health)',
  GPA: 'GPA (Group Personal Accident)',
  GTLI: 'GTLI (Group Term Life Insurance)',
};

export const EB_PRODUCT_NAMES: Record<EbProduct, string> = {
  GMC: 'Group Health',
  GPA: 'Group Personal Accident',
  GTLI: 'Group Term Life Insurance',
};

/** The reference prefix: GMC continues the existing GHI series. */
export const EB_REFERENCE_PREFIX: Record<EbProduct, string> = {
  GMC: 'GHI',
  GPA: 'GPA',
  GTLI: 'GTLI',
};

/** The products with their own /eb/{slug} routes and pages; GMC stays on /ghi. */
export const EB_ROUTED_PRODUCTS = ['GPA', 'GTLI'] as const;
export type EbRoutedProduct = (typeof EB_ROUTED_PRODUCTS)[number];
export const EB_PRODUCT_SLUGS: Record<EbRoutedProduct, 'gpa' | 'gtli'> = {
  GPA: 'gpa',
  GTLI: 'gtli',
};
export function productOfSlug(slug: string): EbRoutedProduct | null {
  return slug === 'gpa' ? 'GPA' : slug === 'gtli' ? 'GTLI' : null;
}

/** Where a case of this product is opened in the web app. */
export function ebCasePath(product: EbProduct, id: string): string {
  return product === 'GMC' ? `/ghi/${id}` : `/eb/${EB_PRODUCT_SLUGS[product]}/${id}`;
}
