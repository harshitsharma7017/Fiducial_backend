import { describe, expect, it } from 'vitest';
import {
  CLAIM_NOTIFIED_STATUSES,
  CLAIM_STATUSES,
  SAMPLE_CLAIM_MERGE_VALUES,
  canMoveClaim,
  parseClaimTemplate,
  renderClaimMail,
} from './claims.ts';

describe('claim statuses', () => {
  it('keeps the four agreed columns, one step forward at a time', () => {
    expect(CLAIM_STATUSES).toEqual(['FORM', 'SUBMITTED', 'INVESTIGATION', 'APPROVED']);
    expect(canMoveClaim('FORM', 'SUBMITTED')).toBe(true);
    expect(canMoveClaim('SUBMITTED', 'INVESTIGATION')).toBe(true);
    expect(canMoveClaim('INVESTIGATION', 'APPROVED')).toBe(true);
    expect(canMoveClaim('FORM', 'APPROVED')).toBe(false);
    expect(canMoveClaim('APPROVED', 'FORM')).toBe(false);
    expect(canMoveClaim('SUBMITTED', 'FORM')).toBe(false);
  });

  it('has templates for every status a claim can be moved into', () => {
    expect(CLAIM_NOTIFIED_STATUSES).toEqual(['SUBMITTED', 'INVESTIGATION', 'APPROVED']);
  });
});

describe('claim email templates', () => {
  it('accepts the claim merge fields and refuses others and stray braces', () => {
    expect(parseClaimTemplate('Claim {{claimNumber}} is {{ status }}').ok).toBe(true);
    expect(parseClaimTemplate('{{insurerName}}')).toEqual({
      ok: false,
      errors: [expect.stringMatching(/\{\{insurerName\}\} is not a merge field/)],
    });
    expect(parseClaimTemplate('Hello {{ there').ok).toBe(false);
  });

  it('fills every field, keeps the subject on one line and escapes the HTML', () => {
    const mail = renderClaimMail(
      {
        subject: 'Claim {{claimNumber}}\n{{status}}',
        body: '{{remark}}\n{{date}} {{employeeName}}',
      },
      { ...SAMPLE_CLAIM_MERGE_VALUES, remark: '<script>alert(1)</script>' },
    );
    expect(mail.subject).toBe('Claim CLM-2026-0001 Investigation');
    expect(mail.text).toBe('<script>alert(1)</script>\n14 Oct 2026 Ravi Kumar');
    expect(mail.html).toBe(
      '<div>&lt;script&gt;alert(1)&lt;/script&gt;<br>\n14 Oct 2026 Ravi Kumar</div>',
    );
  });
});
