import {
  AUDIT_ENTITIES,
  type AuditAction,
  type AuditEntity,
  type EbProduct,
} from '../../../shared/index.ts';

// The product scope of the GHI module (N1, design D1 to D3): GMC is the existing GHI case; GPA
// and GTLI are cases of the same collection with a product field. Every case load names its
// scope, so a /ghi route never opens a GPA case and an /eb/gpa route never opens a GMC case.

export interface CaseScope {
  product: EbProduct;
  /** The audit entity of the product's cases. */
  auditEntity: AuditEntity;
  /** The case's noun in messages. */
  noun: string;
}

export const GMC_SCOPE: CaseScope = {
  product: 'GMC',
  auditEntity: AUDIT_ENTITIES.GHI_CASE,
  noun: 'Group health case',
};
export const GPA_SCOPE: CaseScope = {
  product: 'GPA',
  auditEntity: AUDIT_ENTITIES.EB_CASE,
  noun: 'Group personal accident case',
};
export const GTLI_SCOPE: CaseScope = {
  product: 'GTLI',
  auditEntity: AUDIT_ENTITIES.EB_CASE,
  noun: 'Group term life case',
};

export function scopeOf(product: EbProduct): CaseScope {
  return product === 'GPA' ? GPA_SCOPE : product === 'GTLI' ? GTLI_SCOPE : GMC_SCOPE;
}

/** The filter for one product's cases: a stored case without a product is GMC. */
export function productFilter(product: EbProduct): Record<string, unknown> {
  return product === 'GMC' ? { product: { $in: [null, 'GMC'] } } : { product };
}

/** A case's product as stored: missing means GMC (Requirement 1.7). */
export function productOf(doc: { product?: EbProduct | null }): EbProduct {
  return doc.product ?? 'GMC';
}

/**
 * The audit action of a GHI step for this scope: GMC keeps its GHI_* action; GPA and GTLI use the
 * EB_* action of the same step (design: Audit).
 */
export function scopedAction(scope: CaseScope, action: AuditAction): AuditAction {
  if (scope.product === 'GMC' || !action.startsWith('GHI_')) return action;
  return `EB_${action.slice(4)}` as AuditAction;
}
