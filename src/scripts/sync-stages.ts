/**
 * Brings each open case's stage in line with the work recorded on it, for cases made before the
 * stages followed the work: a quote recorded is Quotes Received, an approved QCR is QCR, a client
 * approval is Client Approval, a placement slip sent is Placement Slip, a policy or cover note
 * recorded is Placed. Cases are only moved forward, never back; closed cases are left alone.
 *
 * Lists what it would change unless --yes is given:
 *
 *   npm run sync:stages            # lists the cases behind their work
 *   npm run sync:stages -- --yes   # moves them
 */
import { PROPOSAL_STAGES, PROPOSAL_STAGE_LABELS, type ProposalStage } from '../shared/index.ts';
import { loadScriptEnv, ConfigError } from '../config/env.ts';
import { connectDatabase, disconnectDatabase, withTransaction } from '../lib/db.ts';
import { ClientApprovalModel } from '../modules/client-approval/client-approval.model.ts';
import { PlacementSlipModel } from '../modules/placement-slip/placement-slip.model.ts';
import { ProposalModel } from '../modules/proposals/proposal.model.ts';
import { advanceStageTo } from '../modules/proposals/proposals.service.ts';
import { QcrModel } from '../modules/qcr/qcr.model.ts';
import { QuoteModel } from '../modules/quotes/quote.model.ts';

const at = (stage: ProposalStage) => PROPOSAL_STAGES.indexOf(stage);

async function main(): Promise<number> {
  const apply = process.argv.includes('--yes');
  const env = loadScriptEnv();
  const host = env.MONGODB_URI.replace(/^mongodb(\+srv)?:\/\/([^@]*@)?/, '').split(/[/?]/)[0];
  console.log(`${apply ? 'Moving' : 'Would move'} cases on ${host}:`);
  await connectDatabase(env.MONGODB_URI);
  let behind = 0;
  try {
    const cases = await ProposalModel.find(
      { stage: { $ne: 'CLOSED' } },
      { reference: 1, stage: 1 },
    ).lean();
    for (const proposal of cases) {
      const [quoted, qcr, approval, slip] = await Promise.all([
        QuoteModel.exists({ proposalId: proposal._id }),
        QcrModel.exists({ proposalId: proposal._id, approval: { $ne: null } }),
        ClientApprovalModel.exists({ proposalId: proposal._id }),
        PlacementSlipModel.findOne({ proposalId: proposal._id }, { sends: 1, placed: 1 }).lean(),
      ]);
      const target: ProposalStage | null = slip?.placed
        ? 'PLACED'
        : slip?.sends.some((send) => send.result !== 'FAILED')
          ? 'PLACEMENT_SLIP'
          : approval
            ? 'CLIENT_APPROVAL'
            : qcr
              ? 'QCR'
              : quoted
                ? 'QUOTES_RECEIVED'
                : null;
      if (!target || at(target) <= at(proposal.stage)) continue;
      behind += 1;
      console.log(
        `  ${proposal.reference.padEnd(16)} ${PROPOSAL_STAGE_LABELS[proposal.stage]} → ${PROPOSAL_STAGE_LABELS[target]}`,
      );
      if (!apply) continue;
      await withTransaction(async (session) => {
        await advanceStageTo(proposal._id, target, session);
        await ProposalModel.updateOne(
          { _id: proposal._id },
          {
            $push: {
              activity: {
                at: new Date(),
                actorId: null,
                message: `Stage brought in line with the work recorded: ${PROPOSAL_STAGE_LABELS[target]}`,
              },
            },
          },
          { session },
        );
      });
    }
  } finally {
    await disconnectDatabase();
  }
  console.log(
    behind === 0
      ? 'Every case is in line with its work.'
      : apply
        ? `Moved ${behind} case(s).`
        : `Nothing changed. Run again with --yes to move ${behind} case(s).`,
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof ConfigError ? error.message : error);
    process.exit(1);
  },
);
