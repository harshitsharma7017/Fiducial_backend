import {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  ERROR_CODES,
  QUOTE_ATTACHMENT_TYPES,
  QUOTE_OPTION_LABELS,
  canMoveInsurer,
  quoteDeviations,
  quoteExpectation,
  quoteOptionsOf,
  quoteTotals,
  type ProposalQuotes,
  type ProposalRecord,
  type QuoteAttachment,
  type QuoteAttachmentType,
  type QuoteVersion,
  type RecordQuoteRequest,
} from '../../shared/index.ts';
import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import { withTransaction } from '../../lib/db.ts';
import { decimal128ToString, toDecimal128 } from '../../lib/decimal.ts';
import { conflict, notFound, validationError } from '../../lib/errors.ts';
import { writeAudit } from '../audit/audit.service.ts';
import { ProposalModel } from '../proposals/proposal.model.ts';
import {
  closed,
  keepStage,
  loadDoc,
  recordOf,
  type Actor,
} from '../proposals/proposals.service.ts';
import { UserModel } from '../users/user.model.ts';
import {
  QuoteAttachmentModel,
  QuoteModel,
  type QuoteAttachmentDoc,
  type QuoteDoc,
} from './quote.model.ts';

// Insurers' quotes (Q-1 to Q-5). Each save is a new version for one insurer and option, with the
// insurer's mail or PDF as proof; the case's insurer moves to Quoted. The QCR takes each option's
// latest version of the insurers that have not declined.

const str = (value: Types.Decimal128 | null) => decimal128ToString(value);

/** The type a file really is, from its first bytes (and, for a mail, its headers). */
function sniff(data: Buffer, fileName: string): QuoteAttachmentType | null {
  const head = data.subarray(0, 8);
  if (head.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  // Outlook .msg files are OLE compound documents.
  if (head.equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
    return /\.msg$/i.test(fileName) ? 'application/vnd.ms-outlook' : null;
  }
  const text = data.subarray(0, 8192).toString('utf8');
  if (/\.eml$/i.test(fileName) && /^(from|subject|date|received|mime-version):/im.test(text)) {
    return 'message/rfc822';
  }
  return null;
}

function toAttachment(
  doc: Pick<
    QuoteAttachmentDoc,
    '_id' | 'insurerId' | 'fileName' | 'contentType' | 'size' | 'createdAt' | 'uploadedBy'
  >,
  users: ReadonlyMap<string, string>,
): QuoteAttachment {
  return {
    id: doc._id.toHexString(),
    insurerId: doc.insurerId.toHexString(),
    fileName: doc.fileName,
    contentType: doc.contentType,
    size: doc.size,
    uploadedAt: doc.createdAt.toISOString(),
    uploadedBy: users.get(doc.uploadedBy.toHexString()) ?? 'Unknown user',
  };
}

async function userNames(ids: readonly Types.ObjectId[]): Promise<Map<string, string>> {
  const users = await UserModel.find(
    { _id: { $in: [...new Set(ids.map((id) => id.toHexString()))] } },
    { name: 1 },
  ).lean();
  return new Map(users.map((user) => [user._id.toHexString(), user.name]));
}

function insurerOf(record: ProposalRecord, insurerId: string) {
  const insurer = record.insurers.find((item) => item.insurerId === insurerId);
  if (!insurer) throw notFound('This insurer is not on the case');
  return insurer;
}

/** Keeps the insurer's mail or PDF on the case (Q-3), for its quotes to point to. */
export async function uploadQuoteAttachment(
  id: string,
  insurerId: string,
  data: Buffer,
  fileName: string,
  actor: Actor,
): Promise<QuoteAttachment> {
  const doc = await loadDoc(id);
  if (doc.stage === 'CLOSED') throw closed();
  const record = await recordOf(doc);
  const insurer = insurerOf(record, insurerId);
  const contentType = sniff(data, fileName);
  if (!contentType) {
    throw validationError([
      {
        location: 'body',
        path: 'file',
        message: `Attach the insurer’s mail (.eml or .msg), a PDF, or a PNG or JPEG of it (${Object.values(QUOTE_ATTACHMENT_TYPES).join(', ')})`,
      },
    ]);
  }
  return withTransaction(async (session) => {
    const [saved] = await QuoteAttachmentModel.create(
      [
        {
          proposalId: doc._id,
          insurerId: new Types.ObjectId(insurerId),
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
    if (!saved) throw new Error('Attachment was not saved');
    await writeAudit(
      {
        userId: actor.id,
        action: AUDIT_ACTIONS.QUOTE_ATTACHMENT_UPLOADED,
        entity: AUDIT_ENTITIES.PROPOSAL,
        entityId: id,
        before: null,
        after: {
          insurer: `${insurer.company}, ${insurer.branch}`,
          fileName,
          contentType,
          size: data.length,
        },
        requestId: actor.requestId,
      },
      session,
    );
    return toAttachment(saved, await userNames([saved.uploadedBy]));
  });
}

/** A kept attachment, to download. */
export async function quoteAttachmentFile(
  id: string,
  attachmentId: string,
): Promise<{ fileName: string; contentType: string; data: Buffer }> {
  const file = await QuoteAttachmentModel.findOne({
    _id: new Types.ObjectId(attachmentId),
    proposalId: new Types.ObjectId(id),
  }).lean();
  if (!file) throw notFound('Attachment not found');
  const raw = file.data as unknown as Buffer | { buffer: Uint8Array };
  return {
    fileName: file.fileName,
    contentType: file.contentType,
    data: Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer),
  };
}

function toVersion(
  doc: QuoteDoc,
  record: ProposalRecord,
  attachments: ReadonlyMap<string, QuoteAttachment>,
  users: ReadonlyMap<string, string>,
): QuoteVersion {
  const sections = doc.sections.map((section) => ({
    code: section.code as QuoteVersion['sections'][number]['code'],
    sumInsured: str(section.sumInsured),
    premium: str(section.premium),
    premiumWithoutTerrorism: str(section.premiumWithoutTerrorism),
  }));
  const gstRatePercent = doc.gstRatePercent.toString();
  const capacityPercent = str(doc.capacityPercent);
  const terms = doc.terms.map((term) => ({ name: term.name, accepted: term.accepted }));
  return {
    id: doc._id.toHexString(),
    insurerId: doc.insurerId.toHexString(),
    option: doc.option,
    version: doc.version,
    reason: doc.reason,
    sections,
    terms,
    deductibles: doc.deductibles,
    capacityPercent,
    conditions: doc.conditions,
    validUntil: doc.validUntil,
    attachments: doc.attachmentIds.flatMap((attachmentId) => {
      const attachment = attachments.get(attachmentId.toHexString());
      return attachment ? [attachment] : [];
    }),
    gstRatePercent,
    totals: quoteTotals(sections, gstRatePercent),
    deviations: quoteDeviations(
      quoteExpectation(record, doc.option),
      { sections, terms, capacityPercent, validUntil: doc.validUntil },
      record.policyStart,
    ),
    createdAt: doc.createdAt.toISOString(),
    createdBy: users.get(doc.createdBy.toHexString()) ?? 'Unknown user',
  };
}

/** Every insurer's quotes on a case, by option and newest first, and what the QCR takes (Q-4, Q-5). */
export async function proposalQuotes(
  id: string,
  defaultGstRatePercent: string,
): Promise<ProposalQuotes> {
  const doc = await loadDoc(id);
  const record = await recordOf(doc);
  const [quotes, attachmentDocs] = await Promise.all([
    QuoteModel.find({ proposalId: doc._id }).sort({ version: -1 }).lean(),
    QuoteAttachmentModel.find({ proposalId: doc._id }, { data: 0 }).sort({ _id: 1 }).lean(),
  ]);
  const declinedBy = doc.insurers.flatMap((insurer) =>
    insurer.status === 'DECLINED' && insurer.response ? [insurer.response.by] : [],
  );
  const users = await userNames([
    ...quotes.map((quote) => quote.createdBy),
    ...attachmentDocs.map((attachment) => attachment.uploadedBy),
    ...declinedBy,
  ]);
  const attachments = attachmentDocs.map((attachment) => toAttachment(attachment, users));
  const byId = new Map(attachments.map((attachment) => [attachment.id, attachment]));
  const options = quoteOptionsOf(record);
  // Options quoted once but no longer asked for (Option 2 taken out) still show their quotes.
  const quotedOptions = [...new Set([...options, ...quotes.map((quote) => quote.option)])];

  const insurers = record.insurers.map((insurer) => {
    const entry = doc.insurers.find((item) => item.insurerId.toHexString() === insurer.insurerId);
    const response = entry?.status === 'DECLINED' ? (entry.response ?? null) : null;
    return {
      insurerId: insurer.insurerId,
      company: insurer.company,
      branch: insurer.branch,
      status: insurer.status,
      declined: response
        ? {
            reason: response.note,
            at: response.at.toISOString(),
            by: users.get(response.by.toHexString()) ?? 'Unknown user',
          }
        : null,
      quotes: quotedOptions.map((option) => ({
        option,
        versions: quotes
          .filter(
            (quote) =>
              quote.insurerId.toHexString() === insurer.insurerId && quote.option === option,
          )
          .map((quote) => toVersion(quote, record, byId, users)),
      })),
    };
  });
  return {
    gstRatePercent: record.gstRatePercent ?? defaultGstRatePercent,
    options,
    insurers,
    attachments,
    // Q-4, Q-5: the latest version of each option asked for, from insurers that have not declined.
    qcr: insurers.flatMap((insurer) =>
      insurer.status === 'DECLINED'
        ? []
        : insurer.quotes.flatMap(({ option, versions }) => {
            const latest = versions[0];
            return latest && options.includes(option)
              ? [
                  {
                    insurerId: insurer.insurerId,
                    company: insurer.company,
                    branch: insurer.branch,
                    option,
                    quoteId: latest.id,
                    version: latest.version,
                  },
                ]
              : [];
          }),
    ),
  };
}

/**
 * Records an insurer's quote for one option as its next version (Q-1 to Q-4): the sections the
 * RFQ asked for, the insurer's terms and at least one attachment of its own. A revision needs its
 * reason. The insurer moves to Quoted.
 */
export async function recordQuote(
  id: string,
  insurerId: string,
  input: RecordQuoteRequest,
  actor: Actor,
  defaultGstRatePercent: string,
): Promise<ProposalQuotes> {
  const doc = await loadDoc(id);
  if (doc.stage === 'CLOSED') throw closed();
  const record = await recordOf(doc);
  const insurer = insurerOf(record, insurerId);
  const name = `${insurer.company}, ${insurer.branch}`;
  if (insurer.status === 'NOT_SENT') {
    throw conflict(ERROR_CODES.CONFLICT, `${name} has not been sent the RFQ yet.`);
  }
  const issues: { location: 'body'; path: string; message: string }[] = [];
  if (!quoteOptionsOf(record).includes(input.option)) {
    issues.push({
      location: 'body',
      path: 'option',
      message: `This case does not ask for a quote on ${QUOTE_OPTION_LABELS[input.option]}`,
    });
  }
  const asked = new Set(quoteExpectation(record, input.option).sections.map((s) => s.code));
  input.sections.forEach((section, index) => {
    if (!asked.has(section.code)) {
      issues.push({
        location: 'body',
        path: `sections.${index}.code`,
        message: `The RFQ did not ask for ${section.code}`,
      });
    }
  });
  const proposalId = doc._id;
  const insurerObjectId = new Types.ObjectId(insurerId);
  const attachments = await QuoteAttachmentModel.countDocuments({
    _id: { $in: input.attachmentIds.map((attachmentId) => new Types.ObjectId(attachmentId)) },
    proposalId,
    insurerId: insurerObjectId,
  });
  if (attachments !== new Set(input.attachmentIds).size) {
    issues.push({
      location: 'body',
      path: 'attachmentIds',
      message: `Attach files uploaded for ${name} on this case`,
    });
  }
  if (issues.length > 0) throw validationError(issues);

  const gstRatePercent = record.gstRatePercent ?? defaultGstRatePercent;
  const entry = doc.insurers.find((item) => item.insurerId.toHexString() === insurerId);
  const moveToQuoted =
    entry !== undefined && entry.status !== 'QUOTED' && canMoveInsurer(entry.status, 'QUOTED');

  try {
    await withTransaction(async (session) => {
      const last = await QuoteModel.findOne(
        { proposalId, insurerId: insurerObjectId, option: input.option },
        { version: 1 },
      )
        .sort({ version: -1 })
        .session(session)
        .lean();
      const version = (last?.version ?? 0) + 1;
      if (version > 1 && !input.reason) {
        throw validationError([
          { location: 'body', path: 'reason', message: 'Say why the quote was revised' },
        ]);
      }
      await QuoteModel.create(
        [
          {
            proposalId,
            insurerId: insurerObjectId,
            option: input.option,
            version,
            reason: input.reason,
            sections: input.sections.map((section) => ({
              code: section.code,
              sumInsured: section.sumInsured === null ? null : toDecimal128(section.sumInsured),
              premium: section.premium === null ? null : toDecimal128(section.premium),
              premiumWithoutTerrorism:
                section.premiumWithoutTerrorism === null
                  ? null
                  : toDecimal128(section.premiumWithoutTerrorism),
            })),
            terms: input.terms,
            deductibles: input.deductibles,
            capacityPercent:
              input.capacityPercent === null ? null : toDecimal128(input.capacityPercent),
            conditions: input.conditions,
            validUntil: input.validUntil,
            attachmentIds: input.attachmentIds.map(
              (attachmentId) => new Types.ObjectId(attachmentId),
            ),
            gstRatePercent: toDecimal128(gstRatePercent),
            createdBy: new Types.ObjectId(actor.id),
          },
        ],
        { session },
      );
      const totals = quoteTotals(input.sections, gstRatePercent);
      const at = new Date();
      const message = `${name}: ${QUOTE_OPTION_LABELS[input.option]} quote${version > 1 ? `, version ${version} (${input.reason ?? ''})` : ''} recorded — net ₹${totals.withTerrorism.net}`;
      const update: Record<string, unknown> = {
        $set: {
          updatedBy: new Types.ObjectId(actor.id),
          ...(moveToQuoted
            ? {
                'insurers.$[target].status': 'QUOTED',
                'insurers.$[target].response': {
                  status: 'QUOTED',
                  note: null,
                  at,
                  by: new Types.ObjectId(actor.id),
                },
              }
            : {}),
        },
        $push: { activity: { at, actorId: new Types.ObjectId(actor.id), message } },
      };
      const updated = await ProposalModel.findOneAndUpdate(
        // The insurer must still be where it was when the quote was checked.
        {
          _id: proposalId,
          insurers: { $elemMatch: { insurerId: insurerObjectId, status: entry?.status } },
        },
        update,
        {
          returnDocument: 'after',
          runValidators: true,
          session,
          ...(moveToQuoted ? { arrayFilters: [{ 'target.insurerId': insurerObjectId }] } : {}),
        },
      ).lean();
      if (!updated) {
        throw conflict(
          ERROR_CODES.CONFLICT,
          `${name} changed while you were recording the quote. Reload the case and try again.`,
        );
      }
      await keepStage(updated, session);
      await writeAudit(
        {
          userId: actor.id,
          action: AUDIT_ACTIONS.QUOTE_RECORDED,
          entity: AUDIT_ENTITIES.PROPOSAL,
          entityId: id,
          before: null,
          after: {
            insurer: name,
            option: QUOTE_OPTION_LABELS[input.option],
            version,
            reason: input.reason,
            net: totals.withTerrorism.net,
            gst: totals.withTerrorism.gst,
            total: totals.withTerrorism.total,
            netWithoutTerrorism: totals.withoutTerrorism?.net ?? null,
            attachments: input.attachmentIds.length,
          },
          requestId: actor.requestId,
        },
        session,
      );
    });
  } catch (error) {
    // Two saves at once: the second found the same last version.
    if ((error as { code?: number }).code === 11000) {
      throw conflict(
        ERROR_CODES.CONFLICT,
        `Another version of ${name}’s quote was saved meanwhile. Reload and try again.`,
      );
    }
    throw error;
  }
  return proposalQuotes(id, defaultGstRatePercent);
}
