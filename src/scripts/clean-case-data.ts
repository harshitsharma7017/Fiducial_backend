/**
 * Clears the case data from a database so testing starts from empty: clients and their risk
 * locations, insurers, cases with their quotes, QCRs, client approvals, placement slips, RFQ
 * versions and edits, the mail log and its attachments, add-on favourites, and the case numbering.
 * Users, the masters (occupancy, pincode, products and covers), document and email templates, and
 * the audit log are kept.
 *
 * Lists what it would delete unless --yes is given:
 *
 *   npm run clean:cases            # counts only
 *   npm run clean:cases -- --yes   # deletes
 */
import { loadScriptEnv, ConfigError } from '../config/env.ts';
import { connectDatabase, disconnectDatabase } from '../lib/db.ts';
import {
  ClientApprovalFileModel,
  ClientApprovalModel,
} from '../modules/client-approval/client-approval.model.ts';
import { AddonFavouritesModel } from '../modules/clients/addon-favourites.model.ts';
import { ClientLocationModel } from '../modules/clients/client-location.model.ts';
import { ClientModel } from '../modules/clients/client.model.ts';
import { InsurerModel } from '../modules/insurers/insurer.model.ts';
import { MailAttachmentModel } from '../modules/mail/mail-attachment.model.ts';
import {
  PlacementFileModel,
  PlacementSlipModel,
} from '../modules/placement-slip/placement-slip.model.ts';
import { MailLogModel } from '../modules/mail/mail-log.model.ts';
import { CounterModel, ProposalModel } from '../modules/proposals/proposal.model.ts';
import { QcrModel } from '../modules/qcr/qcr.model.ts';
import { QuoteAttachmentModel, QuoteModel } from '../modules/quotes/quote.model.ts';
import { RfqStateModel, RfqVersionModel } from '../modules/rfq/rfq.model.ts';

const TARGETS = [
  ['Mail log', MailLogModel, {}],
  ['Mail attachments', MailAttachmentModel, {}],
  ['Placement slips', PlacementSlipModel, {}],
  ['Placement files', PlacementFileModel, {}],
  ['Client approvals', ClientApprovalModel, {}],
  ['Client approval files', ClientApprovalFileModel, {}],
  ['QCRs', QcrModel, {}],
  ['Quote attachments', QuoteAttachmentModel, {}],
  ['Quotes', QuoteModel, {}],
  ['RFQ versions', RfqVersionModel, {}],
  ['RFQ edits', RfqStateModel, {}],
  ['Cases', ProposalModel, {}],
  ['Case numbering', CounterModel, { _id: /^proposal-/ }],
  ['Add-on favourites', AddonFavouritesModel, {}],
  ['Risk locations', ClientLocationModel, {}],
  ['Clients', ClientModel, {}],
  ['Insurers', InsurerModel, {}],
] as const;

async function main(): Promise<number> {
  const apply = process.argv.includes('--yes');
  const env = loadScriptEnv();
  // Only the host is printed, never the credentials in the URI.
  const host = env.MONGODB_URI.replace(/^mongodb(\+srv)?:\/\/([^@]*@)?/, '').split(/[/?]/)[0];
  console.log(`${apply ? 'Deleting' : 'Would delete'} case data on ${host}:`);
  await connectDatabase(env.MONGODB_URI);
  try {
    for (const [label, model, filter] of TARGETS) {
      // Through the driver: the mail log refuses deletes made through Mongoose (it is
      // append-only in the app).
      const collection = model.collection;
      const count = await collection.countDocuments(filter);
      if (apply && count > 0) await collection.deleteMany(filter);
      console.log(`  ${label.padEnd(20)} ${String(count).padStart(6)}`);
    }
  } finally {
    await disconnectDatabase();
  }
  console.log(apply ? 'Done.' : 'Nothing deleted. Run again with --yes to delete.');
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof ConfigError ? error.message : error);
    process.exit(1);
  },
);
