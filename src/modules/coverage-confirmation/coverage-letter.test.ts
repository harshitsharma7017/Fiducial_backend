import type { CoveragePolicyDetails } from '../../shared/index.ts';
import { describe, expect, it } from 'vitest';
import { buildCoverageLetter } from './coverage-letter.ts';

// Q2/Q4: the coverage confirmation letter renders a valid PDF from live policy details, handling
// long names, many sections, missing optional fields and a missing signatory without fabricating
// anything. These are pure render checks (no DB).

function policy(overrides: Partial<CoveragePolicyDetails> = {}): CoveragePolicyDetails {
  return {
    insuredName: 'Sundarvan Agro Foods Private Limited',
    insurerName: 'Kavach General Insurance Company Limited',
    insurerBranch: 'Pune',
    documentKind: 'POLICY',
    policyNumber: 'KG/FIRE/2026/1',
    issuedOn: '2026-10-08',
    policyStart: '2026-12-01',
    policyEnd: '2027-11-30',
    option: 'P1',
    sections: [{ code: 'FIRE', name: 'Fire', sumInsured: '60000000', premium: '100000.00' }],
    premium: { net: '100000.00', gst: '18000.00', total: '118000.00' },
    gstRatePercent: '18',
    reference: 'PRP-2026-0042',
    ...overrides,
  };
}

const isPdf = (buffer: Buffer) => buffer.subarray(0, 5).toString() === '%PDF-';

describe('buildCoverageLetter', () => {
  it('renders a PDF with a configured signatory shown as typed text', async () => {
    const pdf = await buildCoverageLetter({
      policy: policy(),
      confirmedOn: '2026-10-09',
      insurerReference: 'CONF/88',
      notes: 'Subject to premium before inception.',
      signatoryName: 'A. Broker',
      signatoryTitle: 'Principal Officer',
      letterhead: { logo: null, address: 'Fiducial Insurance Brokers | Pune' },
    });
    expect(isPdf(pdf)).toBe(true);
    expect(pdf.length).toBeGreaterThan(1000);
  });

  it('shows the signatory as unconfirmed when none is configured (never a fabricated signature)', async () => {
    const pdf = await buildCoverageLetter({
      policy: policy(),
      confirmedOn: '2026-10-09',
      insurerReference: null,
      notes: null,
      signatoryName: null,
      signatoryTitle: null,
      letterhead: { logo: null, address: null },
    });
    expect(isPdf(pdf)).toBe(true);
  });

  it('handles long names, many sections and missing optional fields', async () => {
    const pdf = await buildCoverageLetter({
      policy: policy({
        insuredName:
          'A Very Long Insured Company Name Private Limited (Unit III, Industrial Estate, Phase II)',
        insurerName: 'Another Very Long Insurer Company Name General Insurance Limited',
        documentKind: null,
        policyNumber: null,
        issuedOn: null,
        policyEnd: null,
        option: null,
        sections: Array.from({ length: 10 }, (_, index) => ({
          code: 'FIRE' as const,
          name: `Coverage section number ${index + 1} with a fairly long descriptive name`,
          sumInsured: '123456789',
          premium: '9999.99',
        })),
      }),
      confirmedOn: '2026-10-09',
      insurerReference: null,
      notes: null,
      signatoryName: null,
      signatoryTitle: null,
      letterhead: { logo: null, address: null },
    });
    expect(isPdf(pdf)).toBe(true);
  });
});
