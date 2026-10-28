import { describe, expect, it } from 'vitest';
import { optionSumInsured, quoteOptionsOf } from './quotes.ts';

// The quote options of a case and the sum insured each asks for, with the third proposed Fire
// option (client review, 27 Oct 2026).

const fire = (proposed2: string | null, proposed3: string | null) => ({
  groups: [],
  existing: null,
  proposed1: '100',
  proposed2,
  proposed3,
  covers: [],
});

describe('quoteOptionsOf', () => {
  it('asks for Option 3 only when a Fire line has a third figure', () => {
    expect(quoteOptionsOf({ type: 'NEW', fire: fire(null, null), sections: [] })).toEqual(['P1']);
    expect(quoteOptionsOf({ type: 'NEW', fire: fire(null, '300'), sections: [] })).toEqual([
      'P1',
      'P3',
    ]);
    expect(quoteOptionsOf({ type: 'EXISTING', fire: fire('200', '300'), sections: [] })).toEqual([
      'EXISTING',
      'P1',
      'P2',
      'P3',
    ]);
  });
});

describe('optionSumInsured', () => {
  const values = { existing: '90', proposed1: '100', proposed2: '200', proposed3: '300' };

  it('reads each option, Option 2 and 3 falling back to Option 1', () => {
    expect(optionSumInsured('EXISTING', values)).toBe('90');
    expect(optionSumInsured('P1', values)).toBe('100');
    expect(optionSumInsured('P2', values)).toBe('200');
    expect(optionSumInsured('P3', values)).toBe('300');
    // A section has no Option 3 figure: it is quoted at Option 1 in it.
    expect(optionSumInsured('P3', { existing: null, proposed1: '100', proposed2: '200' })).toBe(
      '100',
    );
    expect(optionSumInsured('P2', { ...values, proposed2: null })).toBe('100');
  });
});
