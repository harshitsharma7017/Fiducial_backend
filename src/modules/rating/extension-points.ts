/**
 * Rating extension points.
 *
 * Each is deliberately inert because the client has not confirmed the rule. They mark where the
 * logic belongs once it is signed off with worked examples (see docs/OPEN_ITEMS.md). Do not fill
 * them in from assumptions.
 */
import { Decimal } from '../../lib/decimal.ts';

export interface AddOnPricingContext {
  sumInsured: Decimal;
  /** Per mille. Which components make up the "policy rate" is itself open (Q03). */
  policyRate: Decimal;
}

export interface AddOnPremiumLine {
  coverCode: string;
  premium: Decimal;
}

/**
 * OI-01 Add-on premiums (Bharat Sookshma / Laghu covers, add-on catalogues).
 * Formulas are ambiguous (Q02, Q03, Q28), so nothing is priced and the total before tax
 * equals the base premium.
 */
export function calculateAddOnPremiums(_context: AddOnPricingContext): AddOnPremiumLine[] {
  return [];
}

/**
 * OI-03 Terrorism rate source (Q05). The master has terrorism risk types but no rates, so only
 * a rate supplied by the caller is used.
 */
export function resolveTerrorismRate(supplied: Decimal | null): Decimal | null {
  return supplied;
}

/**
 * OI-02 The 13 non-fire sections (Burglary, FLOP, Money and so on) have no rate master (Q23).
 * They are priced from insurer quotes, not by this engine.
 */
export const NON_FIRE_SECTION_PRICING = 'INSURER_QUOTE' as const;

export function totalAddOnPremium(lines: AddOnPremiumLine[]): Decimal {
  return lines.reduce((sum, line) => sum.plus(line.premium), new Decimal(0));
}
