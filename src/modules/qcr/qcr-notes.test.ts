import { describe, expect, it } from 'vitest';
import { fillTerrorismNote } from './qcr-notes.ts';
import type { Qcr } from '../../shared/index.ts';

describe('fillTerrorismNote', () => {
  const noteTemplate =
    '*New / Renewal Quote is given as per recommended coverage i.e. Fire section without terrorism option.\nIf you opt for the same, additional premium of Rs ______/- for Option1 & Rs ________/- for Option2 will be charged.';

  it('omits terrorism note when no terrorism extra is quoted (only with or only without terrorism)', () => {
    const qcrWithoutExtra = {
      options: [
        {
          option: 'EXISTING',
          quotes: [
            { insurerId: 'ins1', terrorismExtra: null, lowest: true },
            { insurerId: 'ins2', terrorismExtra: null, lowest: false },
          ],
        },
      ],
    } as unknown as Qcr;

    expect(fillTerrorismNote(noteTemplate, qcrWithoutExtra)).toBeNull();
    expect(fillTerrorismNote(noteTemplate, null)).toBeNull();
  });

  it('shows terrorism note when quotes provide terrorism extra (both with and without terrorism)', () => {
    const qcrWithExtra = {
      options: [
        {
          option: 'EXISTING',
          quotes: [{ insurerId: 'ins1', terrorismExtra: '500', lowest: true }],
        },
      ],
    } as unknown as Qcr;

    const result = fillTerrorismNote(noteTemplate, qcrWithExtra);
    expect(result).not.toBeNull();
    expect(result).toContain('additional premium of Rs 500.00/- for Existing');
  });

  it('preserves non-terrorism notes intact', () => {
    const otherNote =
      'Please note that all the assets to be insured to their current replacement values.';
    expect(fillTerrorismNote(otherNote, null)).toBe(otherNote);
  });
});
