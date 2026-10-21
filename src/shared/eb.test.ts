import { describe, expect, it } from 'vitest';
import {
  CreateEbCaseRequestSchema,
  EB_STAGES,
  EbCaseListQuerySchema,
  UpdateEbCaseRequestSchema,
  ebReturnAllowed,
  ebStageAfter,
  nextStepOf,
} from './eb.ts';
import { linkDecision } from './eb-employees.ts';
import { emptyGpaQuoteTerms, gpaDeviations, gtliDeviations } from './eb-quotes.ts';
import { emptyGpaRequirements, emptyGtliRequirements } from './eb-requirements.ts';
import { lowestMarks, paymentsSummary, qcrCandidates } from './eb-workflow.ts';

describe('stages (Requirement 3)', () => {
  it('moves forward only, never out of Closed, and is idempotent', () => {
    expect(ebStageAfter('CREATED', 'DATA_SHEET')).toBe('DATA_SHEET');
    expect(ebStageAfter('QCR', 'RFQ')).toBe('QCR');
    expect(ebStageAfter('CLOSED', 'PAYMENT')).toBe('CLOSED');
    expect(ebStageAfter(ebStageAfter('RFQ', 'QCR'), 'QCR')).toBe('QCR');
    expect(EB_STAGES).not.toContain('FINAL_QCR');
    expect(ebReturnAllowed('APPROVAL', 'QCR')).toBe(true);
    expect(ebReturnAllowed('PAYMENT', 'QCR')).toBe(false);
  });

  it('gives a next step until placed or Closed', () => {
    expect(nextStepOf('CLOSED', { placed: false, missing: [], planAssigned: true })).toBeNull();
    expect(
      nextStepOf('PLACEMENT_SLIP', { placed: true, missing: [], planAssigned: true }),
    ).toBeNull();
    expect(
      nextStepOf('DATA_SHEET', {
        placed: false,
        missing: [{ field: 'x', label: 'x' }],
        planAssigned: false,
      }),
    ).toBe(
      'Next: complete the Data Sheet (1 item missing), assign a family plan, add the census, then generate the RFQ.',
    );
  });
});

describe('case requests (Requirements 1, 2)', () => {
  const body = { type: 'NEW', clientId: 'a'.repeat(24), dueDate: '2026-11-01' };

  it('needs a product of GMC, GPA or GTLI', () => {
    expect(CreateEbCaseRequestSchema.safeParse(body).success).toBe(false);
    expect(CreateEbCaseRequestSchema.safeParse({ ...body, product: 'GHI' }).success).toBe(false);
    expect(CreateEbCaseRequestSchema.parse({ ...body, product: 'GTLI' }).product).toBe('GTLI');
  });

  it('refuses an edit that names the product, type or company', () => {
    const edit = {
      ownerId: 'b'.repeat(24),
      policyStart: null,
      policyEnd: null,
      dueDate: '2026-11-01',
      existingInsurer: null,
      existingPolicyNumber: null,
    };
    expect(UpdateEbCaseRequestSchema.safeParse(edit).success).toBe(true);
    for (const extra of [{ product: 'GPA' }, { type: 'NEW' }, { clientId: 'a'.repeat(24) }]) {
      expect(UpdateEbCaseRequestSchema.safeParse({ ...edit, ...extra }).success).toBe(false);
    }
  });

  it('treats blank search as none and refuses over 100 characters and bad paging', () => {
    expect(EbCaseListQuerySchema.parse({ q: '   ' }).q).toBeUndefined();
    expect(EbCaseListQuerySchema.parse({ q: ' GPA-2026 ' }).q).toBe('GPA-2026');
    expect(EbCaseListQuerySchema.safeParse({ q: 'x'.repeat(101) }).success).toBe(false);
    expect(EbCaseListQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(EbCaseListQuerySchema.safeParse({ page: '10001' }).success).toBe(false);
    expect(EbCaseListQuerySchema.safeParse({ product: 'HEALTH' }).success).toBe(false);
  });
});

describe('deviations (Requirement 7.4)', () => {
  it('flags a Required cover not offered as a deviation and not stated as missing', () => {
    const sheet = {
      ...emptyGpaRequirements(),
      covers: {
        accidentalDeath: 'REQUIRED' as const,
        permanentTotal: 'REQUIRED' as const,
        permanentPartial: 'NOT_REQUIRED' as const,
        temporaryTotal: null,
      },
    };
    const terms = emptyGpaQuoteTerms();
    terms.covers.accidentalDeath = { offer: 'NOT_OFFERED', limitAmount: null, limitText: null };
    terms.covers.permanentPartial = { offer: 'NOT_OFFERED', limitAmount: null, limitText: null };
    expect(gpaDeviations(sheet, terms).map((item) => [item.field, item.kind])).toEqual([
      ['covers.accidentalDeath', 'DEVIATION'],
      ['covers.permanentTotal', 'MISSING'],
    ]);
  });

  it('flags a lower free cover limit as a deviation and none stated as missing', () => {
    const sheet = { ...emptyGtliRequirements(), freeCoverLimit: '2000000' };
    expect(
      gtliDeviations(sheet, { freeCoverLimit: '1500000', additionalBenefits: null })[0]?.kind,
    ).toBe('DEVIATION');
    expect(gtliDeviations(sheet, { freeCoverLimit: null, additionalBenefits: null })[0]?.kind).toBe(
      'MISSING',
    );
    expect(gtliDeviations(sheet, { freeCoverLimit: '2500000', additionalBenefits: null })).toEqual(
      [],
    );
    expect(
      gtliDeviations(emptyGtliRequirements(), { freeCoverLimit: null, additionalBenefits: null }),
    ).toEqual([]);
  });
});

describe('QCR, payments and identities', () => {
  it('compares each insurer’s highest recorded quote, never a draft or a declined insurer', () => {
    const quotes = [
      { id: 'a1', insurerId: 'A', version: 1, status: 'FINAL' as const, totalPremium: '100.00' },
      { id: 'a2', insurerId: 'A', version: 2, status: 'FINAL' as const, totalPremium: '90.00' },
      { id: 'a3', insurerId: 'A', version: 3, status: 'DRAFT' as const, totalPremium: null },
      { id: 'b1', insurerId: 'B', version: 1, status: 'FINAL' as const, totalPremium: '90.00' },
      { id: 'c1', insurerId: 'C', version: 1, status: 'FINAL' as const, totalPremium: '50.00' },
    ];
    expect(qcrCandidates(quotes, new Set(['C'])).map((quote) => quote.id)).toEqual(['a2', 'b1']);
    expect([...lowestMarks(['90.00', '90', '91.00'])]).toEqual([0, 1]);
  });

  it('counts only received payments towards the agreed premium', () => {
    expect(
      paymentsSummary('1180.06', [
        { amount: '1000', status: 'RECEIVED' },
        { amount: '500', status: 'FAILED' },
        { amount: '100', status: 'PENDING' },
      ]),
    ).toEqual({ received: '1000.00', pending: '100.00', outstanding: '180.06', covered: false });
    expect(paymentsSummary('1180.06', [{ amount: '1180.06', status: 'RECEIVED' }]).covered).toBe(
      true,
    );
    expect(paymentsSummary(null, []).outstanding).toBeNull();
  });

  it('links only members that agree with each other and the identity', () => {
    const a = { name: 'Ravi  Nair', gender: 'MALE' as const, dateOfBirth: '1985-02-01' };
    expect(linkDecision([a, { ...a, name: 'ravi nair' }], null)).toBe('LINK');
    expect(linkDecision([a, { ...a, dateOfBirth: '1985-02-02' }], null)).toBe('UNRESOLVED');
    expect(linkDecision([a], { ...a, gender: 'FEMALE' })).toBe('UNRESOLVED');
  });
});
