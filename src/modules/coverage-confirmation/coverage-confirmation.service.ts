import {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  ERROR_CODES,
  MAX_ATTACHMENT_BYTES,
  PDF_CONTENT_TYPE,
  mergeValuesFor,
  renderMail,
  type CoverageConfirmation,
  type CoverageConfirmationSendResponse,
  type CoveragePolicyDetails,
  type PlacementSlip,
  type ProposalRecord,
  type RecordCoverageConfirmationRequest,
  type SendCoverageConfirmationRequest,
} from '../../shared/index.ts';
import { Types } from 'mongoose';
import { withTransaction } from '../../lib/db.ts';
import { conflict, notFound, unprocessable, validationError } from '../../lib/errors.ts';
import { writeAudit } from '../audit/audit.service.ts';
import { ClientModel } from '../clients/client.model.ts';
import { openTemplate } from '../documents/excel-template.ts';
import { letterheadOf, type Letterhead } from '../documents/sheet-pdf.ts';
import { templateFile } from '../documents/templates.service.ts';
import { getEmailTemplate } from '../email-templates/email-templates.service.ts';
import { MailLogModel } from '../mail/mail-log.model.ts';
import { fitsAttachmentLimit, storeAttachment } from '../mail/mail-log.service.ts';
import { PlacementFileModel } from '../placement-slip/placement-slip.model.ts';
import {
  getPlacementSlip,
  type PlacementSlipDeps,
} from '../placement-slip/placement-slip.service.ts';
import { loadDoc, recordOf, type Actor } from '../proposals/proposals.service.ts';
import { UserModel } from '../users/user.model.ts';
import { buildCoverageLetter } from './coverage-letter.ts';
import {
  CoverageConfirmationModel,
  type CoverageConfirmationDoc,
} from './coverage-confirmation.model.ts';

// Q4: records the insurer's confirmation of cover against a placed case and generates the
// confirmation letter / email for the insured. Policy details are read live from the placement
// slip, never duplicated. Recording never sends; a letter download or an email is a separate,
// explicit staff action. The letter format and signatory are configurable because the client has
// not confirmed them (presentationPending below), and no signature is ever rendered.

export type CoverageDeps = PlacementSlipDeps;

interface Loaded {
  record: ProposalRecord;
  slip: PlacementSlip;
  doc: CoverageConfirmationDoc | null;
  policy: CoveragePolicyDetails | null;
}

async function userNames(
  ids: readonly (Types.ObjectId | null | undefined)[],
): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.flatMap((id) => (id ? [id.toHexString()] : [])))];
  const users = await UserModel.find({ _id: { $in: wanted } }, { name: 1 }).lean();
  return new Map(users.map((user) => [user._id.toHexString(), user.name]));
}

/** The policy details for the confirmation, read live from the placement slip and placed record. */
function policyDetailsOf(
  record: ProposalRecord,
  slip: PlacementSlip,
): CoveragePolicyDetails | null {
  const accepted = slip.accepted;
  if (!accepted) return null;
  return {
    insuredName: record.client.name,
    insurerName: accepted.company,
    insurerBranch: accepted.branch,
    documentKind: slip.placed?.documentKind ?? null,
    policyNumber: slip.placed?.number ?? null,
    issuedOn: slip.placed?.issuedOn ?? null,
    policyStart: record.policyStart,
    policyEnd: record.policyEnd,
    option: accepted.option,
    sections: slip.sections.map((section) => ({
      code: section.code,
      name: section.name,
      sumInsured: section.sumInsured,
      premium: section.premium,
    })),
    premium: slip.premium,
    gstRatePercent: slip.gstRatePercent,
    reference: record.reference,
  };
}

async function load(id: string, deps: CoverageDeps): Promise<Loaded> {
  const proposal = await loadDoc(id);
  const record = await recordOf(proposal);
  const [slip, doc] = await Promise.all([
    getPlacementSlip(id, deps),
    CoverageConfirmationModel.findOne({ proposalId: proposal._id }).lean(),
  ]);
  const policy = policyDetailsOf(record, slip);
  return { record, slip, doc, policy };
}

/** The case's coverage confirmation as it stands now. */
export async function getCoverageConfirmation(
  id: string,
  deps: CoverageDeps,
): Promise<CoverageConfirmation> {
  const loaded = await load(id, deps);
  const { record, slip, doc, policy } = loaded;
  const [client, users] = await Promise.all([
    ClientModel.findById(record.client.id, { contacts: 1 }).lean(),
    userNames([doc?.recordedBy, doc?.updatedBy, ...(doc?.sends ?? []).map((send) => send.by)]),
  ]);

  // An insurer confirmation can only be treated as confirmed once the case is placed: an insurer
  // policy / cover note must already be recorded. Merely having a placement slip is not enough.
  const placed = slip.placed !== null;
  const missing: string[] = [];
  if (!slip.accepted) missing.push('Record the quote the client accepted first.');
  if (!placed) {
    missing.push('Record the insurer’s policy or cover note on the Placement slip tab first.');
  }
  const blocked =
    record.stage === 'CLOSED'
      ? 'This case is closed.'
      : !slip.accepted
        ? 'Record the quote the client accepted on the Client approval tab first.'
        : !placed
          ? 'Record the insurer’s policy or cover note on the Placement slip tab first.'
          : null;

  return {
    confirmation: doc
      ? {
          confirmedOn: doc.confirmedOn,
          insurerReference: doc.insurerReference,
          channel: doc.channel,
          notes: doc.notes,
          signatoryName: doc.signatoryName,
          signatoryTitle: doc.signatoryTitle,
          recordedAt: doc.createdAt.toISOString(),
          recordedBy: users.get(doc.recordedBy.toHexString()) ?? 'Unknown user',
          updatedAt: doc.updatedAt.toISOString(),
          updatedBy: doc.updatedBy
            ? (users.get(doc.updatedBy.toHexString()) ?? 'Unknown user')
            : null,
          attachmentIds: doc.attachmentIds.map((attachmentId) => attachmentId.toHexString()),
        }
      : null,
    policy,
    files: slip.files.map((file) => ({
      id: file.id,
      fileName: file.fileName,
      uploadedAt: file.uploadedAt,
      uploadedBy: file.uploadedBy,
    })),
    recipients: (client?.contacts ?? []).flatMap((contact) =>
      contact.email ? [{ name: contact.name, email: contact.email }] : [],
    ),
    sends: (doc?.sends ?? [])
      .toSorted((a, b) => b.at.getTime() - a.at.getTime())
      .map((send) => ({
        mailId: send.mailId.toHexString(),
        at: send.at.toISOString(),
        by: users.get(send.by.toHexString()) ?? 'Unknown user',
        to: [...send.to],
        result: send.result,
        error: send.error,
      })),
    missing,
    blocked,
    // The client has not confirmed the letter format or the authorised signatory (OPEN_ITEMS Q4).
    presentationPending: true,
  };
}

function auditView(doc: CoverageConfirmationDoc | null) {
  if (!doc) return null;
  return {
    confirmedOn: doc.confirmedOn,
    insurerReference: doc.insurerReference,
    channel: doc.channel,
    notes: doc.notes,
    signatoryName: doc.signatoryName,
    signatoryTitle: doc.signatoryTitle,
    attachments: doc.attachmentIds.length,
  };
}

/**
 * Records (or corrects) the insurer's confirmation against the placed case. Never sends anything.
 * 409 until the case is placed, and on a closed case.
 */
export async function recordCoverageConfirmation(
  id: string,
  input: RecordCoverageConfirmationRequest,
  actor: Actor,
  deps: CoverageDeps,
): Promise<CoverageConfirmation> {
  const loaded = await load(id, deps);
  if (loaded.record.stage === 'CLOSED') {
    throw conflict(ERROR_CODES.CONFLICT, 'This case is closed.');
  }
  if (!loaded.slip.accepted || !loaded.slip.placed) {
    throw conflict(
      ERROR_CODES.CONFLICT,
      'Record the insurer’s policy or cover note on the Placement slip tab before confirming cover.',
    );
  }
  const proposalId = new Types.ObjectId(id);
  // Only files already uploaded for this case's placement may be referenced as the insurer's proof.
  if (input.attachmentIds.length > 0) {
    const count = await PlacementFileModel.countDocuments({
      _id: { $in: input.attachmentIds.map((fileId) => new Types.ObjectId(fileId)) },
      proposalId,
    });
    if (count !== new Set(input.attachmentIds).size) {
      throw validationError([
        {
          location: 'body',
          path: 'attachmentIds',
          message: 'Attach files uploaded for this case’s placement',
        },
      ]);
    }
  }
  const before = loaded.doc;
  const actorId = new Types.ObjectId(actor.id);
  await withTransaction(async (session) => {
    await CoverageConfirmationModel.updateOne(
      { proposalId },
      {
        $set: {
          confirmedOn: input.confirmedOn,
          insurerReference: input.insurerReference,
          channel: input.channel,
          notes: input.notes,
          signatoryName: input.signatoryName,
          signatoryTitle: input.signatoryTitle,
          attachmentIds: input.attachmentIds.map((fileId) => new Types.ObjectId(fileId)),
          updatedBy: actorId,
        },
        $setOnInsert: { recordedBy: actorId, sends: [] },
      },
      { upsert: true, session },
    );
    const saved = await CoverageConfirmationModel.findOne({ proposalId }).session(session).lean();
    await writeAudit(
      {
        userId: actor.id,
        action: before
          ? AUDIT_ACTIONS.COVERAGE_CONFIRMATION_UPDATED
          : AUDIT_ACTIONS.COVERAGE_CONFIRMATION_RECORDED,
        entity: AUDIT_ENTITIES.PROPOSAL,
        entityId: id,
        before: auditView(before),
        after: auditView(saved),
        requestId: actor.requestId,
      },
      session,
    );
  });
  return getCoverageConfirmation(id, deps);
}

/** The broker's letterhead from the uploaded Placement Slip template, so the letter is branded. */
async function letterheadFor(): Promise<Letterhead> {
  const template = await templateFile('PLACEMENT_SLIP');
  if (!template) return { logo: null, address: null };
  const workbook = await openTemplate(template.data);
  return letterheadOf(workbook);
}

interface LetterFile {
  fileName: string;
  contentType: string;
  data: Buffer;
}

async function letterFileOf(loaded: Loaded): Promise<LetterFile> {
  const { doc, policy, record } = loaded;
  if (!doc) {
    throw conflict(
      ERROR_CODES.CONFLICT,
      'Record the insurer’s coverage confirmation before generating the letter.',
    );
  }
  if (!policy) {
    throw conflict(ERROR_CODES.CONFLICT, 'The placement details are not available yet.');
  }
  // Mandatory policy data must be present before the letter can be presented as complete: it is
  // read live from the placement slip and never invented. Recording requires a placed policy, so
  // these are normally present; this guards any edge where the placement was undone meanwhile.
  const missingPolicy: string[] = [];
  if (!policy.policyNumber) missingPolicy.push('policy or cover note number');
  if (!policy.premium) missingPolicy.push('premium');
  if (policy.sections.length === 0) missingPolicy.push('at least one coverage section');
  if (missingPolicy.length > 0) {
    throw conflict(
      ERROR_CODES.CONFLICT,
      `The coverage confirmation is missing ${missingPolicy.join(', ')}. Complete the placement first.`,
      { missing: missingPolicy },
    );
  }
  const data = await buildCoverageLetter({
    policy,
    confirmedOn: doc.confirmedOn,
    insurerReference: doc.insurerReference,
    notes: doc.notes,
    signatoryName: doc.signatoryName,
    signatoryTitle: doc.signatoryTitle,
    letterhead: await letterheadFor(),
  });
  return {
    fileName: `Coverage-Confirmation-${record.reference}.pdf`,
    contentType: PDF_CONTENT_TYPE,
    data,
  };
}

/** The coverage confirmation letter (PDF) to download, audited as an export. */
export async function coverageLetterDocument(
  id: string,
  actor: Actor,
  deps: CoverageDeps,
): Promise<LetterFile> {
  const loaded = await load(id, deps);
  const file = await letterFileOf(loaded);
  await writeAudit({
    userId: actor.id,
    action: AUDIT_ACTIONS.COVERAGE_CONFIRMATION_DOWNLOADED,
    entity: AUDIT_ENTITIES.PROPOSAL,
    entityId: id,
    after: { reference: loaded.record.reference },
    requestId: actor.requestId,
  });
  return file;
}

/** Emails the coverage confirmation to the insured. A separate, explicit step from recording it. */
export async function sendCoverageConfirmation(
  id: string,
  input: SendCoverageConfirmationRequest,
  actor: Actor,
  deps: CoverageDeps,
): Promise<CoverageConfirmationSendResponse> {
  if (deps.transport.name === 'off') {
    throw conflict(
      ERROR_CODES.MAIL_DISABLED,
      'Sending mail is turned off on this server. Download the confirmation and send it outside the app.',
    );
  }
  const loaded = await load(id, deps);
  const { record, doc, policy } = loaded;
  if (record.stage === 'CLOSED') throw conflict(ERROR_CODES.CONFLICT, 'This case is closed.');
  if (!doc) {
    throw conflict(
      ERROR_CODES.CONFLICT,
      'Record the insurer’s coverage confirmation before emailing it.',
    );
  }
  if (!policy) throw conflict(ERROR_CODES.CONFLICT, 'The placement details are not available yet.');
  // A repeated send (same sendId) is answered from what it did, so nobody is mailed twice.
  const earlier = doc.sends.find((send) => send.sendId === input.sendId);
  if (earlier) {
    return {
      outcome: earlier.result === 'FAILED' ? 'FAILED' : 'SENT',
      reason: earlier.error,
      coverage: await getCoverageConfirmation(id, deps),
    };
  }

  const sender = await UserModel.findById(actor.id, { name: 1, email: 1 }).lean();
  if (!sender) throw notFound('Your user account no longer exists');
  const client = await ClientModel.findById(record.client.id, { contacts: 1 }).lean();
  const contact = (client?.contacts ?? []).find(
    (item) => item.email && input.to.includes(item.email.toLowerCase()),
  );

  let attachment: {
    id: Types.ObjectId;
    fileName: string;
    contentType: string;
    data: Buffer;
  } | null = null;
  if (input.attachLetter) {
    const file = await letterFileOf(loaded);
    if (!fitsAttachmentLimit(file.data.length)) {
      throw unprocessable(
        ERROR_CODES.RFQ_ATTACHMENT_TOO_LARGE,
        `The confirmation letter is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB, too large to email.`,
        { size: file.data.length },
      );
    }
    attachment = await storeAttachment(file);
  }

  const template = await getEmailTemplate('COVERAGE_CONFIRMATION');
  const mail = renderMail(
    template,
    mergeValuesFor({
      record,
      insurer: { company: policy.insurerName, branch: policy.insurerBranch },
      contactName: contact?.name ?? null,
      dueDate: record.dueDate,
      senderName: sender.name,
    }),
  );
  const to = input.to.map((email) => email.toLowerCase());

  let sent;
  try {
    sent = await deps.transport.send({
      from: deps.transport.from ?? '',
      replyTo: sender.email,
      to,
      ...mail,
      attachment: attachment
        ? {
            fileName: attachment.fileName,
            contentType: attachment.contentType,
            data: attachment.data,
          }
        : null,
    });
  } catch {
    sent = { ok: false as const, reason: 'The mail could not be sent' };
  }
  const at = new Date();
  const mailId = new Types.ObjectId();
  const result = sent.ok ? sent.result : 'FAILED';
  const actorId = new Types.ObjectId(actor.id);
  const proposalId = new Types.ObjectId(id);
  await withTransaction(async (session) => {
    await MailLogModel.create(
      [
        {
          _id: mailId,
          proposalId,
          insurerId: null,
          kind: 'COVERAGE_CONFIRMATION',
          sendId: input.sendId,
          from: deps.transport.from ?? '',
          replyTo: sender.email,
          to,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
          templateVersion: template.version,
          attachmentId: attachment?.id ?? null,
          dueDate: null,
          sentBy: actorId,
          at,
          transport: deps.transport.name === 'smtp' ? 'smtp' : 'outbox',
          result,
          messageId: sent.ok ? sent.messageId : null,
          error: sent.ok ? null : sent.reason,
        },
      ],
      { session },
    );
    await CoverageConfirmationModel.updateOne(
      { proposalId },
      {
        $push: {
          sends: {
            mailId,
            sendId: input.sendId,
            at,
            by: actorId,
            to,
            result,
            error: sent.ok ? null : sent.reason,
          },
        },
      },
      { session },
    );
    await writeAudit(
      {
        userId: actor.id,
        action: sent.ok
          ? AUDIT_ACTIONS.COVERAGE_CONFIRMATION_EMAILED
          : AUDIT_ACTIONS.COVERAGE_CONFIRMATION_EMAIL_FAILED,
        entity: AUDIT_ENTITIES.PROPOSAL,
        entityId: id,
        before: null,
        after: {
          to: to.join(', '),
          mailId: mailId.toHexString(),
          result,
          attachment: attachment?.fileName ?? null,
          ...(sent.ok ? {} : { error: sent.reason }),
        },
        requestId: actor.requestId,
      },
      session,
    );
  });
  return {
    outcome: sent.ok ? 'SENT' : 'FAILED',
    reason: sent.ok ? null : sent.reason,
    coverage: await getCoverageConfirmation(id, deps),
  };
}
