import { describe, expect, it } from 'vitest';
import { addonPremium } from './addon-premium.ts';

// Document 05, section 4: Rs 10 crore, policy rate 1.16 per mille, BLUS (Laghu).
const base = { scheme: 'LAGHU' as const, policyRatePerMille: '1.16', sumInsured: '100000000' };

describe('addonPremium', () => {
  it('prices loss minimisation as 1% of policy rate on 5% of SI (Rs 58)', () => {
    const rule = {
      calcType: 'PCT_OF_SI_BASE' as const,
      rateFactorPct: '1',
      basePct: '5',
      maxSelectablePct: null,
      sookshmaCap: '2500000',
      laghuCap: '10000000',
    };
    const result = addonPremium(rule, base);
    expect(result.coverAmount.toFixed()).toBe('5000000');
    expect(result.premium.toFixed(2)).toBe('58.00');
    // Sookshma caps the cover at 25 lakh.
    expect(addonPremium(rule, { ...base, scheme: 'SOOKSHMA' }).coverAmount.toFixed()).toBe(
      '2500000',
    );
  });

  it('prices escalation at 10% as 50% of policy rate on the increase (Rs 5,800)', () => {
    const rule = {
      calcType: 'ESCALATION' as const,
      rateFactorPct: '50',
      basePct: null,
      maxSelectablePct: '25',
      sookshmaCap: null,
      laghuCap: null,
    };
    expect(addonPremium(rule, { ...base, selectedPct: '10' }).premium.toFixed(2)).toBe('5800.00');
    // The selection is limited to the maximum.
    expect(addonPremium(rule, { ...base, selectedPct: '40' }).coverAmount.toFixed()).toBe(
      '25000000',
    );
  });

  it('limits a specified sum insured to the scheme cap and prices policy SI covers', () => {
    const specified = {
      calcType: 'SPECIFIED_SI' as const,
      rateFactorPct: '15',
      basePct: null,
      maxSelectablePct: null,
      sookshmaCap: '2500000',
      laghuCap: '10000000',
    };
    expect(
      addonPremium(specified, { ...base, specifiedSi: '30000000' }).coverAmount.toFixed(),
    ).toBe('10000000');
    const policy = { ...specified, calcType: 'POLICY_SI' as const, rateFactorPct: '1' };
    expect(addonPremium(policy, base).premium.toFixed(2)).toBe('1160.00');
  });
});
