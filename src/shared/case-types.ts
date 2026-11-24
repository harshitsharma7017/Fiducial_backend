// The types of a case on every line of business: new business, the renewal of a policy in force
// (EXISTING on Property, RENEWAL on the Employee Benefits lines and Workmen Compensation), and a
// roll over (client, 17 Nov 2026): a policy in force taken over from another insurer or broker,
// handled exactly as a renewal (Existing columns, last year's policy, expiring policy details).

export const ROLLOVER = 'ROLLOVER' as const;
export const ROLLOVER_LABEL = 'Roll over';

/** True for a renewal or a roll over: a case that continues a policy already in force. */
export function continuesPolicy(type: string): boolean {
  return type !== 'NEW';
}

/** The word documents print for a continuing case: "ROLL OVER" or "RENEWAL". */
export function renewalWord(type: string): 'ROLL OVER' | 'RENEWAL' {
  return type === ROLLOVER ? 'ROLL OVER' : 'RENEWAL';
}
