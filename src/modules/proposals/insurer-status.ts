import {
  AUDIT_ACTIONS,
  ERROR_CODES,
  INSURER_STATUS_LABELS,
  canMoveInsurer,
  type ProposalRecord,
  type RecordInsurerResponseRequest,
} from '../../shared/index.ts';
import { Types } from 'mongoose';
import { conflict, notFound } from '../../lib/errors.ts';
import { closed, loadDoc, recordOf, saveWith, type Actor } from './proposals.service.ts';
import { CLAIM_STALE_MS } from './rfq-mail.service.ts';

/**
 * Records an insurer's answer to the RFQ: Quoted, Declined or No response (E-4). Only the
 * changes canMoveInsurer() allows; an answer can be corrected to another answer.
 */
export async function recordResponse(
  id: string,
  insurerId: string,
  input: RecordInsurerResponseRequest,
  actor: Actor,
): Promise<ProposalRecord> {
  const doc = await loadDoc(id);
  if (doc.stage === 'CLOSED') throw closed();
  const entry = doc.insurers.find((insurer) => insurer.insurerId.toHexString() === insurerId);
  if (!entry) throw notFound('This insurer is not on the case');
  const before = await recordOf(doc);
  const insurer = before.insurers.find((item) => item.insurerId === insurerId);
  const name = insurer ? `${insurer.company}, ${insurer.branch}` : 'The insurer';
  if (!canMoveInsurer(entry.status, input.status)) {
    throw conflict(
      ERROR_CODES.CONFLICT,
      entry.status === 'NOT_SENT'
        ? `${name} has not been sent the RFQ yet.`
        : `${name} is ${INSURER_STATUS_LABELS[entry.status]}; it cannot be marked ${INSURER_STATUS_LABELS[input.status]}.`,
    );
  }
  const note = input.note ?? null;
  const at = new Date();
  const target = new Types.ObjectId(insurerId);
  // Only this insurer's status and response change, and only if nothing changed it meanwhile
  // (another answer, or a reminder going out).
  return saveWith(
    doc,
    {
      'insurers.$[target].status': input.status,
      'insurers.$[target].response': {
        status: input.status,
        note,
        at,
        by: new Types.ObjectId(actor.id),
      },
    },
    `${name}: ${INSURER_STATUS_LABELS[input.status]}${note ? ` (${note})` : ''}`,
    AUDIT_ACTIONS.INSURER_RESPONSE_RECORDED,
    actor,
    before,
    {
      guard: {
        insurers: {
          $elemMatch: {
            insurerId: target,
            status: entry.status,
            $or: [
              { sending: null },
              { 'sending.at': { $lt: new Date(at.getTime() - CLAIM_STALE_MS) } },
            ],
          },
        },
      },
      arrayFilters: [{ 'target.insurerId': target }],
      changed: () =>
        conflict(
          ERROR_CODES.CONFLICT,
          `${name} changed, or a mail to it is going out, while you were recording the answer. Reload the case and try again.`,
        ),
    },
  );
}
