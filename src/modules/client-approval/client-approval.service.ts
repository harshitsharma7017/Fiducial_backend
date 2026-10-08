import {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  CLIENT_APPROVAL_FILE_TYPES,
  ERROR_CODES,
  PROPOSAL_STAGES,
  QUOTE_OPTION_LABELS,
  formatDate,
  formatIndianNumber,
  type ClientApproval,
  type ClientApprovalChoice,
  type ClientApprovalFile,
  type ProposalClientApproval,
  type ProposalRecord,
  type Qcr,
  type RecordClientApprovalRequest,
} from '../../shared/index.ts';
import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import { withTransaction } from '../../lib/db.ts';
import { Decimal, decimal128ToString, toDecimal128 } from '../../lib/decimal.ts';
import { conflict, notFound, validationError } from '../../lib/errors.ts';
import { istDay } from '../../lib/ist-day.ts';
import { writeAudit } from '../audit/audit.service.ts';
import { ClientModel } from '../clients/client.model.ts';
import { ProposalModel } from '../proposals/proposal.model.ts';
import {
  closed,
  keepStage,
  loadDoc,
  recordOf,
  type Actor,
} from '../proposals/proposals.service.ts';
import { getQcr } from '../qcr/qcr.service.ts';
import { proposalQuotes, sniff } from '../quotes/quotes.service.ts';
import { UserModel } from '../users/user.model.ts';
import {
  ClientApprovalFileModel,
  ClientApprovalModel,
  type ClientApprovalDoc,
  type ClientApprovalFileDoc,
} from './client-approval.model.ts';

// Client approval: the quote the client accepted from the QCR it received, with the client's
// mail or signed letter. Recording it moves the case to Client Approval (from an earlier stage);
// it can be corrected until the case is placed or closed.

async function userNames(ids: readonly Types.ObjectId[]): Promise<Map<string, string>> {
  const users = await UserModel.find(
    { _id: { $in: [...new Set(ids.map((id) => id.toHexString()))] } },
    { name: 1 },
  ).lean();
  return new Map(users.map((user) => [user._id.toHexString(), user.name]));
}

function toFile(
  doc: Pick<ClientApprovalFileDoc, '_id' | 'fileName' | 'contentType' | 'size' | 'createdAt'> & {
    uploadedBy: Types.ObjectId;
  },
  users: ReadonlyMap<string, string>,
): ClientApprovalFile {
  return {
    id: doc._id.toHexString(),
    fileName: doc.fileName,
    contentType: doc.contentType,
    size: doc.size,
    uploadedAt: doc.createdAt.toISOString(),
    uploadedBy: users.get(doc.uploadedBy.toHexString()) ?? 'Unknown user',
  };
}

/** Why the approval cannot be recorded now, or null. */
function blockedReason(record: ProposalRecord, qcr: Qcr): string | null {
  if (record.stage === 'CLOSED') return 'This case is closed.';
  if (record.stage === 'PLACED')
    return 'The case is placed: the client approval can no longer change.';
  if (!qcr.sends.some((send) => send.result !== 'FAILED')) {
    return 'Send the QCR to the insured first (QCR tab): the client accepts a quote from the QCR it received.';
  }
  return null;
}

/** Each insurer and option the QCR compares, with the quote's totals both ways. */
async function choicesOf(id: string, qcr: Qcr, gst: string): Promise<ClientApprovalChoice[]> {
  const quotes = await proposalQuotes(id, gst);
  return qcr.options.flatMap((option) =>
    option.quotes.flatMap((quote) => {
      const insurer = quotes.insurers.find((item) => item.insurerId === quote.insurerId);
      const version = insurer?.quotes
        .find((entry) => entry.option === option.option)
        ?.versions.find((entry) => entry.id === quote.quoteId);
      if (!insurer || !version) return [];
      return [
        {
          insurerId: quote.insurerId,
          company: insurer.company,
          branch: insurer.branch,
          option: option.option,
          quoteId: quote.quoteId,
          version: quote.version,
          withTerrorism: version.totals.withTerrorism,
          withoutTerrorism: version.totals.withoutTerrorism,
          recommended:
            qcr.recommendedInsurerId === quote.insurerId && qcr.recommendedOption === option.option,
          lowest: quote.lowest,
        },
      ];
    }),
  );
}

/** Rupees as the quotes give them, with paise: Decimal128 keeps 136880.00 as 136880. */
const paise = (value: Types.Decimal128) => new Decimal(value.toString()).toFixed(2);

function toApproval(
  doc: ClientApprovalDoc,
  insurer: { company: string; branch: string },
  files: readonly ClientApprovalFile[],
  users: ReadonlyMap<string, string>,
  latestQuoteId: string | null,
): ClientApproval {
  const byId = new Map(files.map((file) => [file.id, file]));
  return {
    insurerId: doc.insurerId.toHexString(),
    company: insurer.company,
    branch: insurer.branch,
    option: doc.option,
    quoteId: doc.quoteId.toHexString(),
    version: doc.version,
    withTerrorism: doc.withTerrorism,
    premium: { net: paise(doc.net), gst: paise(doc.gst), total: paise(doc.total) },
    acceptedOn: doc.acceptedOn,
    confirmedBy: doc.confirmedBy,
    note: doc.note,
    files: doc.fileIds.flatMap((fileId) => {
      const file = byId.get(fileId.toHexString());
      return file ? [file] : [];
    }),
    recordedAt: doc.updatedAt.toISOString(),
    recordedBy: users.get(doc.recordedBy.toHexString()) ?? 'Unknown user',
    quoteCurrent: latestQuoteId === null || latestQuoteId === doc.quoteId.toHexString(),
  };
}

/** The case's client approval, what can be accepted, and whether it can be recorded now. */
export async function getClientApproval(
  id: string,
  defaultGstRatePercent: string,
): Promise<ProposalClientApproval> {
  const proposal = await loadDoc(id);
  const record = await recordOf(proposal);
  const qcr = await getQcr(id, { defaultGstRatePercent });
  const [doc, fileDocs, client, quotes] = await Promise.all([
    ClientApprovalModel.findOne({ proposalId: proposal._id }).lean(),
    ClientApprovalFileModel.find({ proposalId: proposal._id }, { data: 0 }).sort({ _id: 1 }).lean(),
    ClientModel.findById(proposal.clientId, { contacts: 1 }).lean(),
    proposalQuotes(id, defaultGstRatePercent),
  ]);
  const users = await userNames([
    ...fileDocs.map((file) => file.uploadedBy),
    ...(doc ? [doc.recordedBy] : []),
  ]);
  const files = fileDocs.map((file) => toFile(file, users));
  let approval: ClientApproval | null = null;
  if (doc) {
    const insurer = quotes.insurers.find((item) => item.insurerId === doc.insurerId.toHexString());
    const latest =
      insurer?.quotes.find((entry) => entry.option === doc.option)?.versions[0]?.id ?? null;
    approval = toApproval(
      doc,
      { company: insurer?.company ?? 'Unknown insurer', branch: insurer?.branch ?? '' },
      files,
      users,
      latest,
    );
  }
  return {
    approval,
    choices: await choicesOf(id, qcr, defaultGstRatePercent),
    files,
    contacts: (client?.contacts ?? []).map((contact) => contact.name),
    blocked: blockedReason(record, qcr),
  };
}

/** Keeps the client's mail or signed letter on the case, for the approval to point to. */
export async function uploadClientApprovalFile(
  id: string,
  data: Buffer,
  fileName: string,
  actor: Actor,
): Promise<ClientApprovalFile> {
  const doc = await loadDoc(id);
  if (doc.stage === 'CLOSED') throw closed();
  const contentType = sniff(data, fileName);
  if (!contentType) {
    throw validationError([
      {
        location: 'body',
        path: 'file',
        message: `Attach the client’s mail (.eml or .msg), a PDF, or a PNG or JPEG of it (${Object.values(CLIENT_APPROVAL_FILE_TYPES).join(', ')})`,
      },
    ]);
  }
  return withTransaction(async (session) => {
    const [saved] = await ClientApprovalFileModel.create(
      [
        {
          proposalId: doc._id,
          fileName,
          contentType,
          size: data.length,
          sha256: createHash('sha256').update(data).digest('hex'),
          data,
          uploadedBy: new Types.ObjectId(actor.id),
        },
      ],
      { session },
    );
    if (!saved) throw new Error('File was not saved');
    await writeAudit(
      {
        userId: actor.id,
        action: AUDIT_ACTIONS.CLIENT_APPROVAL_FILE_UPLOADED,
        entity: AUDIT_ENTITIES.PROPOSAL,
        entityId: id,
        before: null,
        after: { fileName, contentType, size: data.length },
        requestId: actor.requestId,
      },
      session,
    );
    return toFile(saved, await userNames([saved.uploadedBy]));
  });
}

/** A kept file, to download. */
export async function clientApprovalFile(
  id: string,
  fileId: string,
): Promise<{ fileName: string; contentType: string; data: Buffer }> {
  const file = await ClientApprovalFileModel.findOne({
    _id: new Types.ObjectId(fileId),
    proposalId: new Types.ObjectId(id),
  }).lean();
  if (!file) throw notFound('File not found');
  const raw = file.data as unknown as Buffer | { buffer: Uint8Array };
  return {
    fileName: file.fileName,
    contentType: file.contentType,
    data: Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer),
  };
}

const rupees = (value: string) => `₹${formatIndianNumber(value, 2)}`;

function auditView(
  doc: Pick<
    ClientApprovalDoc,
    | 'insurerId'
    | 'option'
    | 'version'
    | 'withTerrorism'
    | 'total'
    | 'acceptedOn'
    | 'confirmedBy'
    | 'note'
    | 'fileIds'
  > | null,
) {
  return doc
    ? {
        insurerId: doc.insurerId.toHexString(),
        option: doc.option,
        version: doc.version,
        withTerrorism: doc.withTerrorism,
        total: decimal128ToString(doc.total),
        acceptedOn: doc.acceptedOn,
        confirmedBy: doc.confirmedBy,
        note: doc.note,
        files: doc.fileIds.length,
      }
    : null;
}

/**
 * Records the quote the client accepted: an insurer and option the QCR compares (Fire with or
 * without terrorism when quoted both ways), the date, who confirmed, and the client's files. The
 * premium is kept as the quote stands. The case moves to Client Approval when it is before it.
 */
export async function recordClientApproval(
  id: string,
  input: RecordClientApprovalRequest,
  actor: Actor,
  defaultGstRatePercent: string,
): Promise<ProposalClientApproval> {
  const proposal = await loadDoc(id);
  const record = await recordOf(proposal);
  const qcr = await getQcr(id, { defaultGstRatePercent });
  const blocked = blockedReason(record, qcr);
  if (blocked) {
    if (record.stage === 'CLOSED') throw closed();
    throw conflict(ERROR_CODES.CONFLICT, blocked);
  }
  const choice = (await choicesOf(id, qcr, defaultGstRatePercent)).find(
    (item) => item.insurerId === input.insurerId && item.option === input.option,
  );
  const issues: { location: 'body'; path: string; message: string }[] = [];
  if (!choice) {
    issues.push({
      location: 'body',
      path: 'insurerId',
      message: 'Choose an insurer and option compared in the QCR',
    });
  }
  const bothWays = choice?.withoutTerrorism != null;
  if (bothWays && input.withTerrorism === null) {
    issues.push({
      location: 'body',
      path: 'withTerrorism',
      message: 'Say whether the client takes Fire with or without terrorism',
    });
  }
  if (input.acceptedOn > istDay(new Date())) {
    issues.push({
      location: 'body',
      path: 'acceptedOn',
      message: 'The date cannot be in the future',
    });
  }
  const files = await ClientApprovalFileModel.countDocuments({
    _id: { $in: input.attachmentIds.map((fileId) => new Types.ObjectId(fileId)) },
    proposalId: proposal._id,
  });
  if (files !== new Set(input.attachmentIds).size) {
    issues.push({
      location: 'body',
      path: 'attachmentIds',
      message: 'Attach files uploaded for this case’s client approval',
    });
  }
  if (issues.length > 0 || !choice) throw validationError(issues);

  const withTerrorism = bothWays ? input.withTerrorism : null;
  const premium =
    withTerrorism === false && choice.withoutTerrorism
      ? choice.withoutTerrorism
      : choice.withTerrorism;
  const actorId = new Types.ObjectId(actor.id);
  const before = await ClientApprovalModel.findOne({ proposalId: proposal._id }).lean();
  const fire =
    withTerrorism === null
      ? ''
      : withTerrorism
        ? ', Fire with terrorism'
        : ', Fire without terrorism';
  const message = `${before ? 'Client approval changed' : 'Client approval recorded'}: ${choice.company}, ${choice.branch}, ${QUOTE_OPTION_LABELS[choice.option]}${fire}, total ${rupees(premium.total)}; confirmed by ${input.confirmedBy.trim()} on ${formatDate(input.acceptedOn)}`;
  const moveStage =
    PROPOSAL_STAGES.indexOf(record.stage) < PROPOSAL_STAGES.indexOf('CLIENT_APPROVAL');

  await withTransaction(async (session) => {
    const saved = await ClientApprovalModel.findOneAndUpdate(
      { proposalId: proposal._id },
      {
        $set: {
          insurerId: new Types.ObjectId(choice.insurerId),
          option: choice.option,
          quoteId: new Types.ObjectId(choice.quoteId),
          version: choice.version,
          withTerrorism,
          net: toDecimal128(premium.net),
          gst: toDecimal128(premium.gst),
          total: toDecimal128(premium.total),
          acceptedOn: input.acceptedOn,
          confirmedBy: input.confirmedBy.trim(),
          note: input.note,
          fileIds: input.attachmentIds.map((fileId) => new Types.ObjectId(fileId)),
          recordedBy: actorId,
        },
      },
      { upsert: true, returnDocument: 'after', session, runValidators: true },
    ).lean();
    const updated = await ProposalModel.findOneAndUpdate(
      // Not placed or closed meanwhile.
      { _id: proposal._id, stage: { $nin: ['PLACED', 'CLOSED'] } },
      {
        $set: { updatedBy: actorId, ...(moveStage ? { stageOverride: 'CLIENT_APPROVAL' } : {}) },
        $push: { activity: { at: new Date(), actorId, message } },
      },
      { returnDocument: 'after', session },
    ).lean();
    if (!updated) {
      throw conflict(
        ERROR_CODES.CONFLICT,
        'The case was placed or closed meanwhile. Reload it and try again.',
      );
    }
    await keepStage(updated, session);
    await writeAudit(
      {
        userId: actor.id,
        action: AUDIT_ACTIONS.CLIENT_APPROVAL_RECORDED,
        entity: AUDIT_ENTITIES.PROPOSAL,
        entityId: id,
        before: auditView(before),
        after: { ...auditView(saved), insurer: `${choice.company}, ${choice.branch}` },
        requestId: actor.requestId,
      },
      session,
    );
  });
  return getClientApproval(id, defaultGstRatePercent);
}
