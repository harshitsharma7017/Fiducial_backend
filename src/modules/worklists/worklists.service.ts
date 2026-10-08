import {
  isAwaitingResponse,
  type PlacementSlipSummary,
  type QcrSummary,
} from '../../shared/index.ts';
import { ClientApprovalModel } from '../client-approval/client-approval.model.ts';
import { getPlacementSlip } from '../placement-slip/placement-slip.service.ts';
import { ProposalModel } from '../proposals/proposal.model.ts';
import { recordOf } from '../proposals/proposals.service.ts';
import { getQcr } from '../qcr/qcr.service.ts';

// The lists behind the Quotes and QCR and Placement Slips pages: one row per case, worked out
// from the same QCR and placement slip each case's tabs show.

const latestOk = (sends: readonly { at: string; result: string }[]) =>
  sends.find((send) => send.result !== 'FAILED')?.at ?? null;

/** Every open case whose RFQ has gone to an insurer, with its quotes and QCR. */
export async function qcrSummaries(defaultGstRatePercent: string): Promise<QcrSummary[]> {
  const docs = await ProposalModel.find({
    stage: { $ne: 'CLOSED' },
    insurers: { $elemMatch: { status: { $ne: 'NOT_SENT' } } },
  })
    .sort({ _id: -1 })
    .lean();
  return Promise.all(
    docs.map(async (doc) => {
      const [record, qcr] = await Promise.all([
        recordOf(doc),
        getQcr(doc._id.toHexString(), { defaultGstRatePercent }),
      ]);
      const asked = record.insurers.filter((insurer) => insurer.status !== 'NOT_SENT');
      const option =
        qcr.options.find((item) => item.option === 'P1' && item.quotes.length > 0) ??
        qcr.options.find((item) => item.quotes.length > 0);
      const lowestQuote = option?.quotes.find((quote) => quote.lowest);
      const lowestInsurer = qcr.insurers.find(
        (insurer) => insurer.insurerId === lowestQuote?.insurerId,
      );
      const recommended = qcr.insurers.find(
        (insurer) => insurer.insurerId === qcr.recommendedInsurerId,
      );
      return {
        proposalId: record.id,
        reference: record.reference,
        clientName: record.client.name,
        clientCity: record.client.city || record.client.state,
        type: record.type,
        stage: record.stage,
        dueDate: record.dueDate,
        insurers: {
          asked: asked.length,
          quoted: asked.filter((insurer) => insurer.status === 'QUOTED').length,
          declined: asked.filter((insurer) => insurer.status === 'DECLINED').length,
          awaiting: asked.filter((insurer) => isAwaitingResponse(insurer.status)).length,
          overdue: asked.filter((insurer) => insurer.overdue).length,
        },
        lowest:
          option && lowestQuote && lowestInsurer
            ? {
                company: lowestInsurer.company,
                branch: lowestInsurer.branch,
                option: option.option,
                total: lowestQuote.totals.total,
              }
            : null,
        qcr: {
          status: qcr.status,
          recommended: recommended ? `${recommended.company}, ${recommended.branch}` : null,
          approvedAt: qcr.approval?.current ? qcr.approval.at : null,
          sentAt: latestOk(qcr.sends),
        },
      };
    }),
  );
}

/** Every case with a client approval, with its placement slip and the policy issued. */
export async function placementSlipSummaries(
  defaultGstRatePercent: string,
): Promise<PlacementSlipSummary[]> {
  const approvals = await ClientApprovalModel.find({}, { proposalId: 1 })
    .sort({ updatedAt: -1 })
    .lean();
  const rows = await Promise.all(
    approvals.map(async ({ proposalId }) => {
      const doc = await ProposalModel.findById(proposalId).lean();
      if (!doc || doc.stage === 'CLOSED') return null;
      const [record, slip] = await Promise.all([
        recordOf(doc),
        getPlacementSlip(proposalId.toHexString(), { defaultGstRatePercent }),
      ]);
      const accepted = slip.accepted;
      if (!accepted) return null;
      const row: PlacementSlipSummary = {
        proposalId: record.id,
        reference: record.reference,
        clientName: record.client.name,
        clientCity: record.client.city || record.client.state,
        type: record.type,
        stage: record.stage,
        accepted: {
          company: accepted.company,
          branch: accepted.branch,
          option: accepted.option,
          withTerrorism: accepted.withTerrorism,
          total: accepted.premium.total,
          acceptedOn: accepted.acceptedOn,
        },
        slip: {
          status: slip.status,
          approvedAt: slip.approval?.current ? slip.approval.at : null,
          sentAt: latestOk(slip.sends),
        },
        placed: slip.placed
          ? {
              documentKind: slip.placed.documentKind,
              number: slip.placed.number,
              issuedOn: slip.placed.issuedOn,
            }
          : null,
      };
      return row;
    }),
  );
  return rows.filter((row): row is PlacementSlipSummary => row !== null);
}
