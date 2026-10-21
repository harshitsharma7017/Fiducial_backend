import type { Logger } from '../../lib/logger.ts';
import { istDay } from '../../lib/ist-day.ts';
import { ProposalModel } from '../proposals/proposal.model.ts';
import { notify } from './notifications.service.ts';

// A4 (renewal due): a periodic scan that raises a notification for each placed Property case whose
// policy ends within the reminder window. It uses the real policy end date (ProposalModel.policyEnd
// of a PLACED case) — never a derived date — and notifies the case owner. Deduplication is by the
// policy's own end date (dedupeKey `renewal-due:<proposalId>:<policyEnd>`), so the reminder fires
// once per policy expiry no matter how often the scan runs, across restarts and across multiple
// app instances (the unique dedupe index is the shared lock; no in-memory state is relied upon).

/** Days between two YYYY-MM-DD dates (b - a), in whole UTC days. */
function daysBetween(a: string, b: string): number {
  const from = Date.parse(`${a}T00:00:00Z`);
  const to = Date.parse(`${b}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000);
}

/**
 * One pass of the renewal scan. Notifies the owner of each PLACED case whose policy ends within
 * `reminderDays` from today (and not already past). Returns how many notifications were created.
 */
export async function scanRenewalsDue(reminderDays: number, logger?: Logger): Promise<number> {
  if (reminderDays <= 0) return 0;
  const today = istDay(new Date());
  const horizon = new Date(`${today}T00:00:00Z`);
  horizon.setUTCDate(horizon.getUTCDate() + reminderDays);
  const horizonDay = horizon.toISOString().slice(0, 10);

  // Placed cases with a real policy end date inside the window, soonest first. The owner is the
  // recipient. We do not cap to a small page: already-notified policies are skipped by `notify`
  // (unique dedupeKey), so a small cap combined with those rows being re-returned could otherwise
  // starve un-notified policies. The due set (placed + expiring within N days) is naturally small;
  // a generous safety bound guards against an unexpectedly large result. The stored `stage` is kept
  // in sync with the effective stage (keepStage), so `stage: 'PLACED'` reliably matches placed cases.
  const due = await ProposalModel.find(
    { stage: 'PLACED', policyEnd: { $ne: null, $gte: today, $lte: horizonDay } },
    { reference: 1, ownerId: 1, policyEnd: 1 },
  )
    .sort({ policyEnd: 1, _id: 1 })
    .limit(5000)
    .lean();

  let created = 0;
  for (const proposal of due) {
    if (!proposal.ownerId || !proposal.policyEnd) continue;
    const days = daysBetween(today, proposal.policyEnd);
    created += await notify(
      [
        {
          recipientId: proposal.ownerId.toHexString(),
          event: 'RENEWAL_DUE',
          title: 'Renewal due',
          message: `${proposal.reference} renews on ${proposal.policyEnd} (in ${days} day${days === 1 ? '' : 's'}).`,
          entity: 'proposal',
          entityId: proposal._id.toHexString(),
          proposalId: proposal._id.toHexString(),
          reference: proposal.reference,
          // One per policy expiry: the end date is the milestone, so it never repeats.
          dedupeKey: `renewal-due:${proposal._id.toHexString()}:${proposal.policyEnd}`,
        },
      ],
      logger,
    );
  }
  return created;
}

/**
 * Runs the renewal scan on an interval until stopped (the claims-worker pattern). The timer is
 * unref'd so it never keeps the process alive, and a re-entrancy guard avoids overlapping scans.
 * Returns a stop function. Idempotency is in the data (the unique dedupeKey), so running several
 * instances is safe.
 */
export function startRenewalReminderWorker(options: {
  reminderDays: number;
  intervalMs: number;
  logger: Logger;
}): () => void {
  if (options.reminderDays <= 0) return () => {};
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    scanRenewalsDue(options.reminderDays, options.logger)
      .then((created) => {
        if (created > 0) options.logger.info({ created }, 'Renewal-due notifications created');
      })
      .catch((error: unknown) => options.logger.error({ err: error }, 'Renewal scan failed'))
      .finally(() => {
        running = false;
      });
  }, options.intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
