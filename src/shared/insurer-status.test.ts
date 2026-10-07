import { describe, expect, it } from 'vitest';
import {
  INSURER_STATUSES,
  INSURER_STATUS_LABELS,
  RecordInsurerResponseRequestSchema,
  canMoveInsurer,
  hasRfq,
  isAwaitingResponse,
  isOverdue,
  type InsurerStatus,
} from './proposals.ts';

// Requirement 7.2: every allowed change, written out once.
const ALLOWED: ReadonlyArray<[InsurerStatus, InsurerStatus]> = [
  ['NOT_SENT', 'SENT'],
  ...(['SENT', 'REMINDED'] as const).flatMap((from) =>
    (['REMINDED', 'QUOTED', 'DECLINED', 'NO_RESPONSE'] as const).map(
      (to) => [from, to] as [InsurerStatus, InsurerStatus],
    ),
  ),
  ...(['QUOTED', 'DECLINED', 'NO_RESPONSE'] as const).flatMap((from) =>
    (['QUOTED', 'DECLINED', 'NO_RESPONSE'] as const).map(
      (to) => [from, to] as [InsurerStatus, InsurerStatus],
    ),
  ),
];
const allowed = new Set(ALLOWED.map(([from, to]) => `${from}>${to}`));

describe('insurer statuses', () => {
  // Feature: rfq-email, Property 4: Status changes follow the table
  it('allows exactly the changes in the table', () => {
    for (const from of INSURER_STATUSES) {
      for (const to of INSURER_STATUSES) {
        expect(canMoveInsurer(from, to), `${from} → ${to}`).toBe(allowed.has(`${from}>${to}`));
      }
    }
  });

  // Feature: rfq-email, Property 4: Status changes follow the table
  it('never returns an insurer to Not sent', () => {
    // Every status reachable from Sent, by any number of allowed changes.
    const reached = new Set<InsurerStatus>(['SENT']);
    let grew = true;
    while (grew) {
      grew = false;
      for (const from of [...reached]) {
        for (const to of INSURER_STATUSES) {
          if (canMoveInsurer(from, to) && !reached.has(to)) {
            reached.add(to);
            grew = true;
          }
        }
      }
    }
    expect([...reached].sort()).toEqual(
      ['DECLINED', 'NO_RESPONSE', 'QUOTED', 'REMINDED', 'SENT'].sort(),
    );
  });

  it('labels every status', () => {
    expect(INSURER_STATUSES.map((status) => INSURER_STATUS_LABELS[status])).toEqual([
      'Not sent',
      'Sent',
      'Reminded',
      'Quoted',
      'Declined',
      'No response',
    ]);
  });

  it('counts the RFQ as sent from Sent onwards, and waiting while Sent or Reminded', () => {
    expect(INSURER_STATUSES.filter(hasRfq)).toEqual([
      'SENT',
      'REMINDED',
      'QUOTED',
      'DECLINED',
      'NO_RESPONSE',
    ]);
    expect(INSURER_STATUSES.filter(isAwaitingResponse)).toEqual(['SENT', 'REMINDED']);
  });

  // Feature: rfq-email, Property 8: Overdue follows the due date
  it('is overdue exactly when still waiting after the due date', () => {
    const today = '2026-10-06';
    for (const status of INSURER_STATUSES) {
      for (const dueDate of ['2026-10-05', '2026-10-06', '2026-10-07', null]) {
        const expected = isAwaitingResponse(status) && dueDate !== null && dueDate < today;
        expect(isOverdue({ status, dueDate }, today), `${status} due ${dueDate}`).toBe(expected);
      }
    }
    // Month and year boundaries compare as dates.
    expect(isOverdue({ status: 'SENT', dueDate: '2026-09-30' }, '2026-10-01')).toBe(true);
    expect(isOverdue({ status: 'REMINDED', dueDate: '2026-12-31' }, '2027-01-01')).toBe(true);
  });
});

describe('RecordInsurerResponseRequestSchema', () => {
  it('takes an answer and an optional note', () => {
    expect(RecordInsurerResponseRequestSchema.parse({ status: 'DECLINED', note: '  ' })).toEqual({
      status: 'DECLINED',
      note: null,
    });
    expect(RecordInsurerResponseRequestSchema.parse({ status: 'QUOTED' })).toEqual({
      status: 'QUOTED',
    });
  });

  it('refuses statuses that are not answers, and long notes', () => {
    expect(RecordInsurerResponseRequestSchema.safeParse({ status: 'SENT' }).success).toBe(false);
    expect(RecordInsurerResponseRequestSchema.safeParse({ status: 'REMINDED' }).success).toBe(
      false,
    );
    expect(
      RecordInsurerResponseRequestSchema.safeParse({ status: 'QUOTED', note: 'x'.repeat(501) })
        .success,
    ).toBe(false);
  });
});
