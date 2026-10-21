import {
  AUDIT_ACTIONS,
  ERROR_CODES,
  type CreateGhiQuoteRequest,
  type GhiQuote,
  type GhiQuoteListResponse,
  type UpdateGhiQuoteRequest,
} from '../../shared/index.ts';
import { Types, type mongo } from 'mongoose';
import { withTransaction } from '../../lib/db.ts';
import { Decimal, toDecimal128 } from '../../lib/decimal.ts';
import { conflict, notFound, validationError } from '../../lib/errors.ts';
import {
  advanceStage,
  assertOpen,
  auditCase,
  insurerNames,
  loadCase,
  nameOf,
  stageIndex,
  userNames,
  type Actor,
} from './ghi-common.ts';
import { GhiCaseModel, type GhiCaseDoc } from './ghi-case.model.ts';
import { assertCaseFiles, fileNames } from './ghi-files.service.ts';
import { deviationsOf, premiumOf } from './ghi-quote-calc.ts';
import { gmcFamilyCover } from './products/gmc.ts';
import { GhiQuoteModel, type GhiQuoteDoc } from './ghi-workflow.model.ts';

// Insurers' quotes (G6): a draft can change until it is recorded; a recorded (final) version
// never changes, and a revision is a new version with its reason. GST and the total are worked
// out here, at the case's GST rate, with decimal arithmetic.

const str = (value: Types.Decimal128 | null) =>
  value === null ? null : new Decimal(value.toString()).toFixed(2);

export function toQuote(
  doc: GhiQuoteDoc,
  caseDoc: GhiCaseDoc,
  names: {
    users: ReadonlyMap<string, string>;
    insurers: ReadonlyMap<string, string>;
    files: ReadonlyMap<string, string>;
  },
  latestIds: ReadonlySet<string>,
): GhiQuote {
  return {
    id: doc._id.toHexString(),
    insurerId: doc.insurerId.toHexString(),
    insurerName: names.insurers.get(doc.insurerId.toHexString()) ?? 'Insurer',
    version: doc.version,
    status: doc.status,
    kind: doc.kind,
    reason: doc.reason,
    basePremium: str(doc.basePremium),
    gstRatePercent: new Decimal(doc.gstRatePercent.toString()).toFixed(),
    gst: str(doc.gst),
    totalPremium: str(doc.totalPremium),
    terms: doc.terms,
    otherTerms: doc.otherTerms,
    validUntil: doc.validUntil,
    attachments: doc.attachmentIds.map((fileId) => ({
      id: fileId.toHexString(),
      fileName: names.files.get(fileId.toHexString()) ?? 'File',
    })),
    deviations: deviationsOf(
      caseDoc.requirements,
      doc.terms,
      gmcFamilyCover(caseDoc).parentsCovered,
    ),
    latest: latestIds.has(doc._id.toHexString()),
    createdAt: doc.createdAt.toISOString(),
    createdBy: nameOf(names.users, doc.createdBy),
    finalizedAt: doc.finalizedAt?.toISOString() ?? null,
    finalizedBy: doc.finalizedBy ? nameOf(names.users, doc.finalizedBy) : null,
  };
}

/** The latest final quote of each insurer: what a new QCR compares. */
export function latestFinalIds(quotes: readonly GhiQuoteDoc[]): Set<string> {
  const latest = new Map<string, GhiQuoteDoc>();
  for (const quote of quotes) {
    if (quote.status !== 'FINAL' || quote.kind !== 'QUOTE') continue;
    const key = quote.insurerId.toHexString();
    const current = latest.get(key);
    if (!current || quote.version > current.version) latest.set(key, quote);
  }
  return new Set([...latest.values()].map((quote) => quote._id.toHexString()));
}

export async function quoteViews(
  caseDoc: GhiCaseDoc,
  quotes: readonly GhiQuoteDoc[],
): Promise<GhiQuote[]> {
  const [users, insurers, files] = await Promise.all([
    userNames(quotes.flatMap((quote) => [quote.createdBy, quote.finalizedBy])),
    insurerNames(quotes.map((quote) => quote.insurerId)),
    fileNames(quotes.flatMap((quote) => quote.attachmentIds)),
  ]);
  const latest = latestFinalIds(
    await GhiQuoteModel.find(
      { caseId: caseDoc._id, status: 'FINAL', kind: 'QUOTE' },
      { insurerId: 1, version: 1, status: 1, kind: 1 },
    ).lean(),
  );
  return quotes.map((quote) => toQuote(quote, caseDoc, { users, insurers, files }, latest));
}

export async function listQuotes(id: string): Promise<GhiQuoteListResponse> {
  const doc = await loadCase(id);
  const quotes = await GhiQuoteModel.find({ caseId: doc._id })
    .sort({ insurerId: 1, version: -1 })
    .lean();
  return { items: await quoteViews(doc, quotes) };
}

async function nextVersion(
  caseId: Types.ObjectId,
  insurerId: Types.ObjectId,
  session: mongo.ClientSession,
) {
  const last = await GhiQuoteModel.findOne({ caseId, insurerId }, { version: 1 })
    .sort({ version: -1 })
    .session(session)
    .lean();
  return (last?.version ?? 0) + 1;
}

/** The checks shared by a new quote and a draft's update. */
async function checkQuote(
  doc: GhiCaseDoc,
  insurerId: Types.ObjectId,
  input: UpdateGhiQuoteRequest,
  ignoreQuoteId: Types.ObjectId | null,
) {
  const item = doc.insurers.find((insurer) => insurer.insurerId.equals(insurerId));
  if (!item) {
    throw validationError([
      { location: 'body', path: 'insurerId', message: 'Choose an insurer on this case' },
    ]);
  }
  if (item.status === 'NOT_SENT') {
    throw conflict(
      ERROR_CODES.CONFLICT,
      'Send the RFQ to this insurer before recording its quote.',
    );
  }
  if (doc.finalQcr) {
    throw conflict(
      ERROR_CODES.CONFLICT,
      'The final QCR is recorded; quotes can no longer change. Record revised final terms instead.',
    );
  }
  const issues: { location: 'body'; path: string; message: string }[] = [];
  if (input.finalize && input.basePremium === null) {
    issues.push({
      location: 'body',
      path: 'basePremium',
      message: 'Enter the base premium before recording the quote',
    });
  }
  if (input.basePremium !== null && new Decimal(input.basePremium).lessThanOrEqualTo(0)) {
    issues.push({ location: 'body', path: 'basePremium', message: 'Enter a premium above 0' });
  }
  const earlierFinal = await GhiQuoteModel.exists({
    caseId: doc._id,
    insurerId,
    status: 'FINAL',
    kind: 'QUOTE',
    ...(ignoreQuoteId ? { _id: { $ne: ignoreQuoteId } } : {}),
  });
  if (input.finalize && earlierFinal && input.reason === null) {
    issues.push({
      location: 'body',
      path: 'reason',
      message: 'Say why the insurer revised its quote',
    });
  }
  if (issues.length > 0) throw validationError(issues);
  await assertCaseFiles(doc._id, input.attachmentIds, 'QUOTE', 'attachmentIds');
  return item;
}

function quoteFields(doc: GhiCaseDoc, input: UpdateGhiQuoteRequest, actorId: Types.ObjectId) {
  const gstRatePercent = new Decimal(doc.gstRatePercent.toString()).toFixed();
  const premium = input.basePremium === null ? null : premiumOf(input.basePremium, gstRatePercent);
  return {
    status: input.finalize ? ('FINAL' as const) : ('DRAFT' as const),
    reason: input.reason,
    basePremium: premium ? toDecimal128(premium.basePremium) : null,
    gstRatePercent: toDecimal128(gstRatePercent),
    gst: premium ? toDecimal128(premium.gst) : null,
    totalPremium: premium ? toDecimal128(premium.totalPremium) : null,
    terms: input.terms,
    otherTerms: input.otherTerms,
    validUntil: input.validUntil,
    attachmentIds: input.attachmentIds.map((fileId) => new Types.ObjectId(fileId)),
    finalizedAt: input.finalize ? new Date() : null,
    finalizedBy: input.finalize ? actorId : null,
  };
}

async function afterFinal(
  doc: GhiCaseDoc,
  quote: GhiQuoteDoc,
  insurerName: string,
  actorId: Types.ObjectId,
  session: mongo.ClientSession,
) {
  await GhiCaseModel.updateOne(
    { _id: doc._id },
    {
      $set: {
        'insurers.$[target].status': 'QUOTED',
        'insurers.$[target].declineReason': null,
        updatedBy: actorId,
      },
      $push: {
        activity: {
          at: new Date(),
          actorId,
          message: `Quote v${quote.version} recorded for ${insurerName}: total ₹${str(quote.totalPremium)}${quote.reason ? ` (${quote.reason})` : ''}`,
        },
      },
    },
    { session, arrayFilters: [{ 'target.insurerId': quote.insurerId }] },
  );
  await advanceStage(doc._id, 'QCR', actorId, session);
}

function auditView(
  quote: Pick<
    GhiQuoteDoc,
    'version' | 'status' | 'basePremium' | 'gst' | 'totalPremium' | 'terms' | 'reason'
  >,
  insurer: string,
) {
  return {
    insurer,
    version: quote.version,
    status: quote.status,
    basePremium: str(quote.basePremium),
    gst: str(quote.gst),
    totalPremium: str(quote.totalPremium),
    reason: quote.reason,
    terms: quote.terms,
  };
}

export async function createQuote(
  id: string,
  input: CreateGhiQuoteRequest,
  actor: Actor,
): Promise<GhiQuote> {
  const doc = await loadCase(id);
  assertOpen(doc);
  if (stageIndex(doc.stage) < stageIndex('RFQ')) {
    throw conflict(ERROR_CODES.CONFLICT, 'Generate and send the RFQ before recording quotes.');
  }
  const insurerId = new Types.ObjectId(input.insurerId);
  await checkQuote(doc, insurerId, input, null);
  const draft = await GhiQuoteModel.exists({ caseId: doc._id, insurerId, status: 'DRAFT' });
  if (draft)
    throw conflict(
      ERROR_CODES.CONFLICT,
      'This insurer has a draft quote: finish or delete it first.',
    );
  const actorId = new Types.ObjectId(actor.id);
  const insurerName = (await insurerNames([insurerId])).get(input.insurerId) ?? 'Insurer';
  const saved = await withTransaction(async (session) => {
    const [quote] = await GhiQuoteModel.create(
      [
        {
          caseId: doc._id,
          insurerId,
          version: await nextVersion(doc._id, insurerId, session),
          kind: 'QUOTE',
          ...quoteFields(doc, input, actorId),
          createdBy: actorId,
        },
      ],
      { session },
    );
    if (!quote) throw new Error('Quote was not saved');
    const plain = quote.toObject();
    if (plain.status === 'FINAL') await afterFinal(doc, plain, insurerName, actorId, session);
    await auditCase(
      actor,
      plain.status === 'FINAL' ? AUDIT_ACTIONS.GHI_QUOTE_FINALIZED : AUDIT_ACTIONS.GHI_QUOTE_SAVED,
      id,
      null,
      auditView(plain, insurerName),
      session,
    );
    return plain;
  });
  return (await quoteViews(await loadCase(id), [saved]))[0]!;
}

async function loadDraft(doc: GhiCaseDoc, quoteId: string) {
  const quote = await GhiQuoteModel.findOne({
    _id: new Types.ObjectId(quoteId),
    caseId: doc._id,
  }).lean();
  if (!quote) throw notFound('Quote not found');
  if (quote.status !== 'DRAFT') {
    throw conflict(
      ERROR_CODES.CONFLICT,
      'A recorded quote does not change. Record a revised version instead.',
    );
  }
  return quote;
}

export async function updateQuote(
  id: string,
  quoteId: string,
  input: UpdateGhiQuoteRequest,
  actor: Actor,
): Promise<GhiQuote> {
  const doc = await loadCase(id);
  assertOpen(doc);
  const draft = await loadDraft(doc, quoteId);
  await checkQuote(doc, draft.insurerId, input, draft._id);
  const actorId = new Types.ObjectId(actor.id);
  const insurerName =
    (await insurerNames([draft.insurerId])).get(draft.insurerId.toHexString()) ?? 'Insurer';
  const saved = await withTransaction(async (session) => {
    const quote = await GhiQuoteModel.findOneAndUpdate(
      { _id: draft._id, caseId: doc._id, status: 'DRAFT' },
      { $set: quoteFields(doc, input, actorId) },
      { returnDocument: 'after', session },
    ).lean();
    if (!quote)
      throw conflict(ERROR_CODES.CONFLICT, 'The quote was recorded meanwhile. Reload it.');
    if (quote.status === 'FINAL') await afterFinal(doc, quote, insurerName, actorId, session);
    await auditCase(
      actor,
      quote.status === 'FINAL' ? AUDIT_ACTIONS.GHI_QUOTE_FINALIZED : AUDIT_ACTIONS.GHI_QUOTE_SAVED,
      id,
      auditView(draft, insurerName),
      auditView(quote, insurerName),
      session,
    );
    return quote;
  });
  return (await quoteViews(await loadCase(id), [saved]))[0]!;
}

export async function deleteDraftQuote(id: string, quoteId: string, actor: Actor): Promise<void> {
  const doc = await loadCase(id);
  assertOpen(doc);
  const draft = await loadDraft(doc, quoteId);
  const insurerName =
    (await insurerNames([draft.insurerId])).get(draft.insurerId.toHexString()) ?? 'Insurer';
  await withTransaction(async (session) => {
    const result = await GhiQuoteModel.deleteOne(
      { _id: draft._id, caseId: doc._id, status: 'DRAFT' },
      { session },
    );
    if (result.deletedCount === 0)
      throw conflict(ERROR_CODES.CONFLICT, 'The quote was recorded meanwhile.');
    await auditCase(
      actor,
      AUDIT_ACTIONS.GHI_QUOTE_DELETED,
      id,
      auditView(draft, insurerName),
      null,
      session,
    );
  });
}
