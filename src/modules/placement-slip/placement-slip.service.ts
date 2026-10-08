import {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  ERROR_CODES,
  MAX_ATTACHMENT_BYTES,
  PDF_CONTENT_TYPE,
  PLACED_DOCUMENT_KIND_LABELS,
  PLACEMENT_FILE_TYPES,
  PROPOSAL_STAGES,
  XLSX_CONTENT_TYPE,
  formatDate,
  mergeValuesFor,
  quoteExpectation,
  renderMail,
  type MailAttachmentFormat,
  type PlacementFile,
  type PlacementSlip,
  type PlacementSlipSendResponse,
  type ProposalRecord,
  type RecordPlacedRequest,
  type SavePlacementSlipRequest,
  type SendPlacementSlipRequest,
} from '../../shared/index.ts';
import { createHash } from 'node:crypto';
import { Types, type mongo } from 'mongoose';
import { withTransaction } from '../../lib/db.ts';
import { decimal128ToString } from '../../lib/decimal.ts';
import { conflict, notFound, unprocessable, validationError } from '../../lib/errors.ts';
import { istDay } from '../../lib/ist-day.ts';
import { writeAudit } from '../audit/audit.service.ts';
import { catalogItems, taxRatePercentOn } from '../catalog/catalog.service.ts';
import { getClientApproval } from '../client-approval/client-approval.service.ts';
import { ClientModel } from '../clients/client.model.ts';
import { DocumentTemplateModel } from '../documents/document-template.model.ts';
import { openTemplate, saveWorkbook } from '../documents/excel-template.ts';
import { letterheadOf, workbookToPdf } from '../documents/sheet-pdf.ts';
import { templateFile } from '../documents/templates.service.ts';
import { getEmailTemplate } from '../email-templates/email-templates.service.ts';
import { InsurerModel } from '../insurers/insurer.model.ts';
import { MailLogModel } from '../mail/mail-log.model.ts';
import { fitsAttachmentLimit, storeAttachment } from '../mail/mail-log.service.ts';
import type { MailTransport } from '../mail/transport.ts';
import { ProposalModel, type ProposalDoc } from '../proposals/proposal.model.ts';
import {
  closed,
  keepStage,
  loadDoc,
  recordOf,
  type Actor,
} from '../proposals/proposals.service.ts';
import { pdfSheets } from '../proposals/rfq-document.ts';
import { QuoteModel } from '../quotes/quote.model.ts';
import { sniff } from '../quotes/quotes.service.ts';
import { UserModel } from '../users/user.model.ts';
import { fillPlacementSlipTemplate } from './placement-slip-template.ts';
import {
  PlacementFileModel,
  PlacementSlipModel,
  type PlacementFileDoc,
  type PlacementSlipDoc,
} from './placement-slip.model.ts';

// The placement slip: built each time it is read from the quote the client accepted (the version
// and premium the client approval kept) and the case; the broker's remarks are kept per case.
// Approval is for exactly what the approver saw; only an approved slip is mailed to the insurer,
// which moves the case to Placement Slip. The policy or cover note the insurer issues, recorded
// with its file, moves the case to Placed.

export interface PlacementSlipDeps {
  defaultGstRatePercent: string;
  transport: MailTransport;
}

interface Loaded {
  record: ProposalRecord;
  slip: PlacementSlip;
  doc: PlacementSlipDoc | null;
}

async function userNames(
  ids: readonly (Types.ObjectId | null | undefined)[],
): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.flatMap((id) => (id ? [id.toHexString()] : [])))];
  const users = await UserModel.find({ _id: { $in: wanted } }, { name: 1 }).lean();
  return new Map(users.map((user) => [user._id.toHexString(), user.name]));
}

function toFile(
  doc: Pick<
    PlacementFileDoc,
    '_id' | 'fileName' | 'contentType' | 'size' | 'createdAt' | 'uploadedBy'
  >,
  users: ReadonlyMap<string, string>,
): PlacementFile {
  return {
    id: doc._id.toHexString(),
    fileName: doc.fileName,
    contentType: doc.contentType,
    size: doc.size,
    uploadedAt: doc.createdAt.toISOString(),
    uploadedBy: users.get(doc.uploadedBy.toHexString()) ?? 'Unknown user',
  };
}

const str = (value: Types.Decimal128 | null) => decimal128ToString(value);

/** The case's placement slip as it stands now. */
async function load(
  id: string,
  deps: Pick<PlacementSlipDeps, 'defaultGstRatePercent'>,
): Promise<Loaded> {
  const proposal = await loadDoc(id);
  const record = await recordOf(proposal);
  const [approval, doc, fileDocs, template] = await Promise.all([
    getClientApproval(id, deps.defaultGstRatePercent),
    PlacementSlipModel.findOne({ proposalId: proposal._id }).lean(),
    PlacementFileModel.find({ proposalId: proposal._id }, { data: 0 }).sort({ _id: 1 }).lean(),
    DocumentTemplateModel.exists({ kind: 'PLACEMENT_SLIP' }),
  ]);
  const accepted = approval.approval;
  const [quote, insurer] = accepted
    ? await Promise.all([
        QuoteModel.findById(accepted.quoteId).lean(),
        InsurerModel.findById(accepted.insurerId, { rfqEmails: 1, contacts: 1 }).lean(),
      ])
    : [null, null];
  const users = await userNames([
    doc?.updatedBy,
    doc?.approval?.by,
    doc?.placed?.recordedBy,
    ...(doc?.sends ?? []).map((send) => send.by),
    ...fileDocs.map((file) => file.uploadedBy),
  ]);
  const files = fileDocs.map((file) => toFile(file, users));

  // The sections the insurer quoted, with the sum insured of the option accepted.
  const expected = accepted ? quoteExpectation(record, accepted.option).sections : [];
  const sections = (quote?.sections ?? []).flatMap((section) => {
    const premium =
      section.code === 'FIRE' && accepted?.withTerrorism === false
        ? (str(section.premiumWithoutTerrorism) ?? str(section.premium))
        : str(section.premium);
    if (premium === null) return [];
    const asked = expected.find((item) => item.code === section.code);
    return [
      {
        code: section.code as PlacementSlip['sections'][number]['code'],
        name: asked?.name ?? section.code,
        sumInsured: str(section.sumInsured) ?? asked?.sumInsured ?? null,
        premium,
      },
    ];
  });
  const remarks = doc?.remarks ?? null;
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        quoteId: accepted?.quoteId ?? null,
        option: accepted?.option ?? null,
        withTerrorism: accepted?.withTerrorism ?? null,
        sections,
        premium: accepted?.premium ?? null,
        remarks,
      }),
    )
    .digest('hex')
    .slice(0, 32);

  const missing: string[] = [];
  if (!accepted) missing.push('Record the quote the client accepted (Client approval tab).');
  if (!template) {
    missing.push('Upload the client’s Placement Slip format (Masters → Document templates).');
  }
  const approvalCurrent = doc?.approval?.fingerprint === fingerprint;
  const sentNow = (doc?.sends ?? []).some(
    (send) => send.fingerprint === fingerprint && send.result !== 'FAILED',
  );
  const company = accepted ? `${accepted.company}, ${accepted.branch}` : '';
  const recipients = [
    ...(insurer?.rfqEmails ?? []).map((email) => ({ name: company, email })),
    ...(insurer?.contacts ?? []).flatMap((contact) =>
      contact.email ? [{ name: contact.name, email: contact.email }] : [],
    ),
  ].filter((item, index, all) => all.findIndex((other) => other.email === item.email) === index);
  const placed = doc?.placed
    ? {
        documentKind: doc.placed.documentKind,
        number: doc.placed.number,
        issuedOn: doc.placed.issuedOn,
        note: doc.placed.note,
        files: doc.placed.fileIds.flatMap((fileId) => {
          const file = files.find((item) => item.id === fileId.toHexString());
          return file ? [file] : [];
        }),
        recordedAt: doc.placed.recordedAt.toISOString(),
        recordedBy: users.get(doc.placed.recordedBy.toHexString()) ?? 'Unknown user',
      }
    : null;

  const slip: PlacementSlip = {
    status: approvalCurrent ? (sentNow ? 'SENT' : 'APPROVED') : 'DRAFT',
    accepted,
    sections,
    premium: accepted?.premium ?? null,
    gstRatePercent: record.gstRatePercent ?? deps.defaultGstRatePercent,
    capacityPercent: quote ? str(quote.capacityPercent) : null,
    deductibles: quote?.deductibles ?? null,
    conditions: quote?.conditions ?? null,
    remarks,
    updatedAt: doc?.updatedAt.toISOString() ?? null,
    updatedBy: doc?.updatedBy ? (users.get(doc.updatedBy.toHexString()) ?? 'Unknown user') : null,
    fingerprint,
    approval: doc?.approval
      ? {
          at: doc.approval.at.toISOString(),
          by: users.get(doc.approval.by.toHexString()) ?? 'Unknown user',
          current: approvalCurrent,
        }
      : null,
    missing,
    templateUploaded: template !== null,
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
    recipients,
    placed,
    files,
    blocked:
      record.stage === 'CLOSED'
        ? 'This case is closed.'
        : accepted
          ? null
          : 'Record the quote the client accepted on the Client approval tab first.',
  };
  return { record, slip, doc };
}

export async function getPlacementSlip(
  id: string,
  deps: Pick<PlacementSlipDeps, 'defaultGstRatePercent'>,
): Promise<PlacementSlip> {
  return (await load(id, deps)).slip;
}

function assertWorkable(loaded: Loaded) {
  if (loaded.record.stage === 'CLOSED') throw closed();
  if (loaded.slip.blocked) throw conflict(ERROR_CODES.CONFLICT, loaded.slip.blocked);
}

/** Saves the broker's remarks. Any change voids an approval. */
export async function savePlacementSlip(
  id: string,
  input: SavePlacementSlipRequest,
  actor: Actor,
  deps: Pick<PlacementSlipDeps, 'defaultGstRatePercent'>,
): Promise<PlacementSlip> {
  const before = await load(id, deps);
  assertWorkable(before);
  await withTransaction(async (session) => {
    await PlacementSlipModel.updateOne(
      { proposalId: new Types.ObjectId(id) },
      {
        $set: { remarks: input.remarks, updatedBy: new Types.ObjectId(actor.id) },
        $setOnInsert: { approval: null, sends: [], placed: null },
      },
      { upsert: true, session },
    );
    await writeAudit(
      {
        userId: actor.id,
        action: AUDIT_ACTIONS.PLACEMENT_SLIP_SAVED,
        entity: AUDIT_ENTITIES.PROPOSAL,
        entityId: id,
        before: { remarks: before.slip.remarks },
        after: { remarks: input.remarks },
        requestId: actor.requestId,
      },
      session,
    );
  });
  return getPlacementSlip(id, deps);
}

/** Approves the slip exactly as the approver saw it. */
export async function approvePlacementSlip(
  id: string,
  fingerprint: string,
  actor: Actor,
  deps: Pick<PlacementSlipDeps, 'defaultGstRatePercent'>,
): Promise<PlacementSlip> {
  const loaded = await load(id, deps);
  assertWorkable(loaded);
  const { slip } = loaded;
  if (slip.missing.length > 0) {
    throw conflict(
      ERROR_CODES.PLACEMENT_SLIP_INCOMPLETE,
      'The placement slip is not ready for approval.',
      { missing: slip.missing },
    );
  }
  if (slip.fingerprint !== fingerprint) {
    throw conflict(
      ERROR_CODES.PLACEMENT_SLIP_CHANGED,
      'The placement slip changed since you opened it (the quote accepted or the remarks). Review it again before approving.',
    );
  }
  const at = new Date();
  const actorId = new Types.ObjectId(actor.id);
  await withTransaction(async (session) => {
    await PlacementSlipModel.updateOne(
      { proposalId: new Types.ObjectId(id) },
      {
        $set: { approval: { at, by: actorId, fingerprint } },
        $setOnInsert: { sends: [], placed: null },
      },
      { upsert: true, session },
    );
    await ProposalModel.updateOne(
      { _id: new Types.ObjectId(id) },
      { $push: { activity: { at, actorId, message: 'Placement slip approved' } } },
      { session },
    );
    await writeAudit(
      {
        userId: actor.id,
        action: AUDIT_ACTIONS.PLACEMENT_SLIP_APPROVED,
        entity: AUDIT_ENTITIES.PROPOSAL,
        entityId: id,
        before: null,
        after: {
          insurer: slip.accepted ? `${slip.accepted.company}, ${slip.accepted.branch}` : null,
          total: slip.premium?.total ?? null,
          fingerprint,
        },
        requestId: actor.requestId,
      },
      session,
    );
  });
  return getPlacementSlip(id, deps);
}

/** The slip as a file: the client's Placement Slip format, filled. */
async function fileOf(
  loaded: Loaded,
  format: MailAttachmentFormat,
  defaultGstRatePercent: string,
): Promise<{ fileName: string; contentType: string; data: Buffer }> {
  const { record, slip } = loaded;
  const [client, template, gstRatePercent, products, sections, notes, clauses] = await Promise.all([
    ClientModel.findById(record.client.id).lean(),
    templateFile('PLACEMENT_SLIP'),
    record.gstRatePercent ??
      taxRatePercentOn('GST', istDay(new Date(record.createdAt)), defaultGstRatePercent),
    catalogItems('products'),
    catalogItems('sections'),
    catalogItems('notes'),
    catalogItems('clauses'),
  ]);
  if (!client) throw notFound('The proposal’s client no longer exists');
  if (!template) {
    throw conflict(
      ERROR_CODES.PLACEMENT_SLIP_INCOMPLETE,
      'Upload the client’s Placement Slip format (Masters → Document templates) first.',
      { missing: slip.missing },
    );
  }
  const workbook = await openTemplate(template.data);
  const letterhead = letterheadOf(workbook);
  fillPlacementSlipTemplate(
    workbook,
    record,
    client,
    { gstRatePercent, products, sections, notes, clauses },
    slip,
  );
  const name = `Placement-Slip-${record.reference}`;
  return format === 'pdf'
    ? {
        fileName: `${name}.pdf`,
        contentType: PDF_CONTENT_TYPE,
        data: await workbookToPdf(workbook, {
          sheets: pdfSheets(workbook, record),
          letterhead,
          title: `Placement slip ${record.reference} — ${record.client.name}`,
          footer: `Placement slip ${record.reference} · ${record.client.name}`,
        }),
      }
    : {
        fileName: `${name}.xlsx`,
        contentType: XLSX_CONTENT_TYPE,
        data: await saveWorkbook(workbook),
      };
}

/** The slip to download, audited as an export. A draft can be downloaded to review. */
export async function placementSlipDocument(
  id: string,
  format: MailAttachmentFormat,
  actor: Actor,
  deps: Pick<PlacementSlipDeps, 'defaultGstRatePercent'>,
): Promise<{
  fileName: string;
  contentType: string;
  data: Buffer;
  status: PlacementSlip['status'];
}> {
  const loaded = await load(id, deps);
  if (!loaded.slip.accepted) {
    throw conflict(
      ERROR_CODES.PLACEMENT_SLIP_INCOMPLETE,
      'Record the quote the client accepted first.',
      {
        missing: loaded.slip.missing,
      },
    );
  }
  const file = await fileOf(loaded, format, deps.defaultGstRatePercent);
  await writeAudit({
    userId: actor.id,
    action: AUDIT_ACTIONS.PLACEMENT_SLIP_DOWNLOADED,
    entity: AUDIT_ENTITIES.PROPOSAL,
    entityId: id,
    after: { reference: loaded.record.reference, format, status: loaded.slip.status },
    requestId: actor.requestId,
  });
  return { ...file, status: loaded.slip.status };
}

/** Moves the case forward to a stage when it is before it, in the same transaction. */
async function advanceTo(
  proposalId: Types.ObjectId,
  stage: 'PLACEMENT_SLIP' | 'PLACED',
  current: ProposalRecord['stage'],
  push: { at: Date; actorId: Types.ObjectId; message: string },
  session: mongo.ClientSession,
): Promise<void> {
  const move = PROPOSAL_STAGES.indexOf(current) < PROPOSAL_STAGES.indexOf(stage);
  const updated = await ProposalModel.findOneAndUpdate(
    { _id: proposalId, stage: { $ne: 'CLOSED' } },
    {
      $set: { updatedBy: push.actorId, ...(move ? { stageOverride: stage } : {}) },
      $push: { activity: push },
    },
    { returnDocument: 'after', session },
  ).lean<ProposalDoc>();
  if (!updated) throw closed();
  await keepStage(updated, session);
}

/** Mails the approved slip to the insurer the client accepted; moves the case to Placement Slip. */
export async function sendPlacementSlip(
  id: string,
  input: SendPlacementSlipRequest,
  actor: Actor,
  deps: PlacementSlipDeps,
): Promise<PlacementSlipSendResponse> {
  if (deps.transport.name === 'off') {
    throw conflict(
      ERROR_CODES.MAIL_DISABLED,
      'Sending mail is turned off on this server. Download the placement slip and send it outside the app.',
    );
  }
  const loaded = await load(id, deps);
  assertWorkable(loaded);
  const { record, slip, doc } = loaded;
  const earlier = doc?.sends.find((send) => send.sendId === input.sendId);
  if (earlier) {
    return {
      outcome: earlier.result === 'FAILED' ? 'FAILED' : 'SENT',
      reason: earlier.error,
      slip,
    };
  }
  if (slip.status === 'DRAFT') {
    throw conflict(
      ERROR_CODES.PLACEMENT_SLIP_NOT_APPROVED,
      slip.approval
        ? 'The placement slip changed after it was approved. It must be approved again before it is sent.'
        : 'The placement slip must be approved before it is sent to the insurer.',
    );
  }
  const accepted = slip.accepted;
  if (!accepted)
    throw conflict(ERROR_CODES.CONFLICT, 'Record the quote the client accepted first.');
  const file = await fileOf(loaded, input.format, deps.defaultGstRatePercent);
  if (!fitsAttachmentLimit(file.data.length)) {
    throw unprocessable(
      ERROR_CODES.RFQ_ATTACHMENT_TOO_LARGE,
      `The placement slip is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB, too large to email.`,
      { size: file.data.length },
    );
  }
  const attachment = await storeAttachment(file);
  const sender = await UserModel.findById(actor.id, { name: 1, email: 1 }).lean();
  if (!sender) throw notFound('Your user account no longer exists');
  const template = await getEmailTemplate('PLACEMENT_SLIP');
  const to = input.to.map((email) => email.toLowerCase());
  const contact = slip.recipients.find(
    (item) =>
      to.includes(item.email.toLowerCase()) &&
      item.name !== `${accepted.company}, ${accepted.branch}`,
  );
  const mail = renderMail(
    template,
    mergeValuesFor({
      record,
      insurer: { company: accepted.company, branch: accepted.branch },
      contactName: contact?.name ?? null,
      dueDate: record.dueDate,
      senderName: sender.name,
    }),
  );
  let sent;
  try {
    sent = await deps.transport.send({
      from: deps.transport.from ?? '',
      replyTo: sender.email,
      to,
      ...mail,
      attachment: { fileName: file.fileName, contentType: file.contentType, data: file.data },
    });
  } catch {
    sent = { ok: false as const, reason: 'The mail could not be sent' };
  }
  const at = new Date();
  const mailId = new Types.ObjectId();
  const result = sent.ok ? sent.result : 'FAILED';
  const actorId = new Types.ObjectId(actor.id);
  const proposalId = new Types.ObjectId(id);
  const message = sent.ok
    ? `Placement slip emailed to ${accepted.company}, ${accepted.branch} (${to.join(', ')})${result === 'OUTBOX' ? ' (kept in the outbox, not delivered)' : ''}`
    : `Placement slip email to ${accepted.company}, ${accepted.branch} failed: ${sent.reason}`;
  await withTransaction(async (session) => {
    await MailLogModel.create(
      [
        {
          _id: mailId,
          proposalId,
          insurerId: new Types.ObjectId(accepted.insurerId),
          kind: 'PLACEMENT_SLIP',
          sendId: input.sendId,
          from: deps.transport.from ?? '',
          replyTo: sender.email,
          to,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
          templateVersion: template.version,
          attachmentId: attachment.id,
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
    await PlacementSlipModel.updateOne(
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
            fingerprint: slip.fingerprint,
          },
        },
      },
      { session },
    );
    if (sent.ok) {
      await advanceTo(
        proposalId,
        'PLACEMENT_SLIP',
        record.stage,
        { at, actorId, message },
        session,
      );
    } else {
      await ProposalModel.updateOne(
        { _id: proposalId },
        { $push: { activity: { at, actorId, message } } },
        { session },
      );
    }
    await writeAudit(
      {
        userId: actor.id,
        action: sent.ok
          ? AUDIT_ACTIONS.PLACEMENT_SLIP_EMAILED
          : AUDIT_ACTIONS.PLACEMENT_SLIP_EMAIL_FAILED,
        entity: AUDIT_ENTITIES.PROPOSAL,
        entityId: id,
        before: null,
        after: {
          insurer: `${accepted.company}, ${accepted.branch}`,
          to: to.join(', '),
          mailId: mailId.toHexString(),
          result,
          attachment: file.fileName,
          fingerprint: slip.fingerprint,
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
    slip: await getPlacementSlip(id, deps),
  };
}

/** Keeps the insurer's policy or cover note on the case, for the placement to point to. */
export async function uploadPlacementFile(
  id: string,
  data: Buffer,
  fileName: string,
  actor: Actor,
): Promise<PlacementFile> {
  const doc = await loadDoc(id);
  if (doc.stage === 'CLOSED') throw closed();
  const contentType = sniff(data, fileName);
  if (!contentType) {
    throw validationError([
      {
        location: 'body',
        path: 'file',
        message: `Attach the policy or cover note as a PDF, the insurer’s mail (.eml or .msg), or a PNG or JPEG (${Object.values(PLACEMENT_FILE_TYPES).join(', ')})`,
      },
    ]);
  }
  return withTransaction(async (session) => {
    const [saved] = await PlacementFileModel.create(
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
        action: AUDIT_ACTIONS.PLACEMENT_FILE_UPLOADED,
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
export async function placementFile(
  id: string,
  fileId: string,
): Promise<{ fileName: string; contentType: string; data: Buffer }> {
  const file = await PlacementFileModel.findOne({
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

/**
 * Records the policy or cover note the insurer issued, with its file, once the slip has gone to
 * the insurer. Moves the case to Placed; it can be corrected afterwards (not once closed).
 */
export async function recordPlaced(
  id: string,
  input: RecordPlacedRequest,
  actor: Actor,
  deps: Pick<PlacementSlipDeps, 'defaultGstRatePercent'>,
): Promise<PlacementSlip> {
  const loaded = await load(id, deps);
  assertWorkable(loaded);
  const { record, slip, doc } = loaded;
  if (!(doc?.sends ?? []).some((send) => send.result !== 'FAILED')) {
    throw conflict(
      ERROR_CODES.CONFLICT,
      'Send the placement slip to the insurer first: the policy or cover note is issued against it.',
    );
  }
  const issues: { location: 'body'; path: string; message: string }[] = [];
  if (input.issuedOn > istDay(new Date())) {
    issues.push({
      location: 'body',
      path: 'issuedOn',
      message: 'The date cannot be in the future',
    });
  }
  const files = await PlacementFileModel.countDocuments({
    _id: { $in: input.attachmentIds.map((fileId) => new Types.ObjectId(fileId)) },
    proposalId: new Types.ObjectId(id),
  });
  if (files !== new Set(input.attachmentIds).size) {
    issues.push({
      location: 'body',
      path: 'attachmentIds',
      message: 'Attach files uploaded for this case’s placement',
    });
  }
  if (issues.length > 0) throw validationError(issues);

  const at = new Date();
  const actorId = new Types.ObjectId(actor.id);
  const kind = PLACED_DOCUMENT_KIND_LABELS[input.documentKind];
  const message = `${doc?.placed ? 'Placement corrected' : 'Placed'}: ${kind} ${input.number.trim()} issued on ${formatDate(input.issuedOn)} by ${slip.accepted?.company ?? 'the insurer'}`;
  await withTransaction(async (session) => {
    await PlacementSlipModel.updateOne(
      { proposalId: new Types.ObjectId(id) },
      {
        $set: {
          placed: {
            documentKind: input.documentKind,
            number: input.number.trim(),
            issuedOn: input.issuedOn,
            note: input.note,
            fileIds: input.attachmentIds.map((fileId) => new Types.ObjectId(fileId)),
            recordedAt: at,
            recordedBy: actorId,
          },
        },
      },
      { session },
    );
    await advanceTo(
      new Types.ObjectId(id),
      'PLACED',
      record.stage,
      { at, actorId, message },
      session,
    );
    await writeAudit(
      {
        userId: actor.id,
        action: AUDIT_ACTIONS.PLACEMENT_RECORDED,
        entity: AUDIT_ENTITIES.PROPOSAL,
        entityId: id,
        before: doc?.placed
          ? {
              documentKind: doc.placed.documentKind,
              number: doc.placed.number,
              issuedOn: doc.placed.issuedOn,
            }
          : null,
        after: {
          documentKind: input.documentKind,
          number: input.number.trim(),
          issuedOn: input.issuedOn,
          note: input.note,
          files: input.attachmentIds.length,
        },
        requestId: actor.requestId,
      },
      session,
    );
  });
  return getPlacementSlip(id, deps);
}
