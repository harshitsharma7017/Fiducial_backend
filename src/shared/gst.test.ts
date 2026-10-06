import { describe, expect, it } from 'vitest';
import { GstinSchema, gstinCheckCharacter, gstinProblem } from './gst.ts';

// Published GSTINs whose check characters are known to be right.
const VALID = ['27AAPFU0939F1ZV', '29AAGCB7383J1Z4', '33AAACH7409R1Z8', '24AAACC1206D1ZM'];

describe('gstinCheckCharacter', () => {
  it.each(VALID)('computes the check character of %s', (gstin) => {
    expect(gstinCheckCharacter(gstin.slice(0, 14))).toBe(gstin.charAt(14));
  });
});

describe('gstinProblem', () => {
  it.each(VALID)('accepts %s', (gstin) => {
    expect(gstinProblem(gstin)).toBeNull();
  });

  it('rejects the wrong length', () => {
    expect(gstinProblem('27AAPFU0939F1Z')).toBe('A GSTIN has 15 characters');
  });

  it.each([
    ['a PAN with a digit where a letter belongs', '27AAPF10939F1ZV'],
    ['a registration number of 0', '27AAPFU0939F0ZV'],
    ['a 14th character other than Z', '27AAPFU0939F1YV'],
    ['punctuation', '27AAPFU0939F1Z-'],
  ])('rejects %s', (_label, gstin) => {
    expect(gstinProblem(gstin)).toMatch(/^Enter the GSTIN as printed/);
  });

  it('rejects a state code that does not exist', () => {
    const first14 = '55AAPFU0939F1Z';
    expect(gstinProblem(`${first14}${gstinCheckCharacter(first14)}`)).toBe(
      '55 is not a GST state code',
    );
  });

  it('catches a mistyped character through the check digit', () => {
    expect(gstinProblem('27AAPFU0939F1ZW')).toMatch(/check digit/);
    expect(gstinProblem('27AAPFU0938F1ZV')).toMatch(/check digit/);
  });
});

describe('GstinSchema', () => {
  it('upper-cases and removes spaces before checking', () => {
    expect(GstinSchema.parse(' 27aapfu0939f1zv ')).toBe('27AAPFU0939F1ZV');
    expect(GstinSchema.parse('27 AAPFU 0939F 1ZV')).toBe('27AAPFU0939F1ZV');
  });

  it('reports one message per invalid value', () => {
    const result = GstinSchema.safeParse('27AAPFU0939F1ZW');
    expect(result.success).toBe(false);
    expect(result.error?.issues).toHaveLength(1);
  });
});
