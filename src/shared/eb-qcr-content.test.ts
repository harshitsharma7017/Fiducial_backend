import { describe, expect, it } from 'vitest';
import { qcrContentKey } from './eb-workflow.ts';

const content = {
  columns: [
    {
      quoteId: 'q1',
      quoteVersion: 1,
      basePremium: '100.00',
      gst: '18.00',
      totalPremium: '118.00',
      lowest: true,
      deviations: [],
    },
  ],
  recommendedInsurerId: null,
  remarks: null,
};

describe('the QCR content key (client review 4/11/2026)', () => {
  it('stays the same for a case with Option 1 only, so approved QCRs do not go out of date', () => {
    const before =
      '{"columns":[["q1",1,"100.00","18.00","118.00",true,[]]],"recommendedInsurerId":null,"remarks":null}';
    expect(qcrContentKey(content)).toBe(before);
    expect(
      qcrContentKey({
        ...content,
        options: [{ option: 1, basis: 'Flat: ₹5,00,000' }],
        optionTotals: [['118.00']],
        recommendedOption: 1,
      }),
    ).toBe(before);
  });

  it('changes when an option’s premium or the recommended option changes', () => {
    const options = [
      { option: 1, basis: 'Flat: ₹5,00,000' },
      { option: 2, basis: 'Flat: ₹10,00,000' },
    ];
    const key = (total: string, recommendedOption: number) =>
      qcrContentKey({ ...content, options, optionTotals: [['118.00', total]], recommendedOption });
    expect(key('200.00', 1)).not.toBe(key('210.00', 1));
    expect(key('200.00', 1)).not.toBe(key('200.00', 2));
  });
});
