import type { AddonRuleRow } from '../../shared/index.ts';
import { Decimal, roundMoney, type DecimalValue } from '../../lib/decimal.ts';

// The premium of a BSUS/BLUS paid add-on from its rule in the add-on rate master (document 05,
// section 5). Proposed reading, to be confirmed with the client's own worked examples (Q03):
// premium = rate factor % × policy rate (per mille) × cover amount.

export type Scheme = 'SOOKSHMA' | 'LAGHU';

export interface AddonPremiumInput {
  scheme: Scheme;
  /** The base policy's rate per mille. */
  policyRatePerMille: DecimalValue;
  /** The policy sum insured. */
  sumInsured: DecimalValue;
  /** SPECIFIED_SI: the sum insured chosen for the add-on. */
  specifiedSi?: DecimalValue;
  /** ESCALATION: the % chosen, and the sum insured it applies to (excluding stocks). */
  selectedPct?: DecimalValue;
  sumInsuredExcludingStocks?: DecimalValue;
}

export interface AddonPremium {
  /** The amount the rate is applied to, after the scheme's cap. */
  coverAmount: Decimal;
  premium: Decimal;
}

const pct = (value: DecimalValue) => new Decimal(value).dividedBy(100);

type Rule = Pick<
  AddonRuleRow,
  'calcType' | 'rateFactorPct' | 'basePct' | 'maxSelectablePct' | 'sookshmaCap' | 'laghuCap'
>;

export function addonPremium(rule: Rule, input: AddonPremiumInput): AddonPremium {
  const cap = input.scheme === 'SOOKSHMA' ? rule.sookshmaCap : rule.laghuCap;
  const capped = (amount: Decimal) => (cap === null ? amount : Decimal.min(amount, cap));
  const sumInsured = new Decimal(input.sumInsured);
  let cover: Decimal;
  switch (rule.calcType) {
    case 'PCT_OF_SI_BASE':
    case 'FLAT_CAP':
      cover = capped(sumInsured.times(pct(rule.basePct ?? 0)));
      break;
    case 'SPECIFIED_SI':
      cover = capped(new Decimal(input.specifiedSi ?? 0));
      break;
    case 'ESCALATION': {
      const selected = Decimal.min(input.selectedPct ?? 0, rule.maxSelectablePct ?? 0);
      cover = new Decimal(input.sumInsuredExcludingStocks ?? sumInsured).times(pct(selected));
      break;
    }
    case 'POLICY_SI':
      cover = sumInsured;
      break;
  }
  const premium = pct(rule.rateFactorPct)
    .times(new Decimal(input.policyRatePerMille).dividedBy(1000))
    .times(cover);
  return { coverAmount: cover, premium: roundMoney(premium) };
}
