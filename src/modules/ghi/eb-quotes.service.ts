import {
  AUDIT_ACTIONS,
  ERROR_CODES,
  gpaDeviations,
  gtliDeviations,
  type CreateEbQuoteRequest,
  type EbDeviation,
  type EbQuote,
  type EbQuoteListResponse,
  type EbQuoteTerms,
  type GpaQuoteTerms,
  type GtliQuoteTerms,
  type UpdateEbQuoteRequest,
} from '../../shared/index.ts';
import { Types, type mongo } from 'mongoose';
import { withTransaction } from '../../lib/db.ts';
import { Decimal, toDecimal128 } from '../../lib/decimal.ts';
import { conflict, notFound, validationError } from '../../lib/errors.ts';
import { gpaRequirementsOf, gtliRequirementsOf } from './eb-census-context.ts';
import { ebPremium } from './eb-calc.ts';
import { GhiCaseModel, type GhiCaseDoc } from './ghi-case.model.ts';
import {
  advanceStage,
  assertWritable,
  auditCase,
  insurerNames,
  loadCase,
  nameOf,
  stageIndex,
  userNames,
  type Actor,
} from './ghi-common.ts';
import { assertCaseFiles, fileNames } from './ghi-files.service.ts';
import { GhiQuoteModel, type GhiQuoteDoc } from './ghi-workflow.model.ts';
import type { CaseScope } from './products/profile.ts';

// GPA and GTLI quotes (Requirement 7): a draft can change until it is recorded; a recorded
// version never changes, and a revision is the insurer's next version with its reason. GST and
// the total are worked out here at the case's GST rate with Decimal; the rate as stated is kept
// as text and used in no calculation.

const str = (value: Types.Decimal128 | null) =>
  value === null ? null : new Decimal(value.toString()).toFixed(2);

/** A quote's gaps against the case's Data Sheet (7.4). */
export function ebDeviations(caseDoc: GhiCaseDoc, terms: EbQuoteTerms): EbDeviation[] {
  return caseDoc.product === 'GTLI'
    ? gtliDeviations(gtliRequirementsOf(caseDoc), terms as GtliQuoteTerms)
    : gpaDeviations(gpaRequirementsOf(caseDoc), terms as GpaQuoteTerms);
}

/** The highest recorded version of each insurer: the one a QCR compares. */
export function latestRecordedIds(
  quotes: readonly Pick<GhiQuoteDoc, '_id' | 'insurerId' | 'version' | 'status'>[],
) {
  const latest = new Map<string, Pick<GhiQuoteDoc, '_id' | 'version'>>();
  for (const quote of quotes) {
    if (quote.status !== 'FINAL') continue;
    const key = quote.insurerId.toHexString();
    const current = latest.get(key);
    if (!current || quote.version > current.version) latest.set(key, quote);
  }
  return new Set([...latest.values()].map((quote) => quote._id.toHexString()));
}

export async function ebQuoteViews(
  caseDoc: GhiCaseDoc,
  quotes: readonly GhiQuoteDoc[],
): Promise<EbQuote[]> {
  const [users, insurers, files, all] = await Promise.all([
    userNames(quotes.flatMap((quote) => [quote.createdBy, quote.finalizedBy])),
    insurerNames(quotes.map((quote) => quote.insurerId)),
    fileNames(quotes.flatMap((quote) => quote.attachmentIds)),
    GhiQuoteModel.find(
      { caseId: caseDoc._id, status: 'FINAL' },
      { insurerId: 1, version: 1, status: 1 },
    ).lean(),
  ]);
  const latest = latestRecordedIds(all);
  return quotes.map((quote) => ({
    id: quote._id.toHexString(),
    product: caseDoc.product ?? 'GPA',
    insurerId: quote.insurerId.toHexString(),
    insurerName: insurers.get(quote.insurerId.toHexString()) ?? 'Insurer',
    version: quote.version,
    status: quote.status,
    reason: quote.reason,
    basePremium: str(quote.basePremium),
    statedRate: quote.statedRate ?? null,
    gstRatePercent: new Decimal(quote.gstRatePercent.toString()).toFixed(),
    gst: str(quote.gst),
    totalPremium: str(quote.totalPremium),
    terms: quote.terms as unknown as EbQuoteTerms,
    otherTerms: quote.otherTerms,
    validUntil: quote.validUntil,
    attachments: quote.attachmentIds.map((fileId) => ({
      id: fileId.toHexString(),
      fileName: files.get(fileId.toHexString()) ?? 'File',
    })),
    deviations: ebDeviations(caseDoc, quote.terms as unknown as EbQuoteTerms),
    latest: latest.has(quote._id.toHexString()),
    createdAt: quote.createdAt.toISOString(),
    createdBy: nameOf(users, quote.createdBy),
    finalizedAt: quote.finalizedAt?.toISOString() ?? null,
    finalizedBy: quote.finalizedBy ? nameOf(users, quote.finalizedBy) : null,
  }));
}

export async function listEbQuotes(scope: CaseScope, id: string): Promise<EbQuoteListResponse> {
  const doc = await loadCase(id, undefined, scope);
  const quotes = await GhiQuoteModel.find({ caseId: doc._id })
    .sort({ insurerId: 1, version: -1 })
    .lean();
  return { items: await ebQuoteViews(doc, quotes) };
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

/** The checks of a new quote and of a draft's update (7.7 to 7.9). */
async function checkQuote(
  doc: GhiCaseDoc,
  insurerId: Types.ObjectId,
  input: UpdateEbQuoteRequest,
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
  if (input.finalize && input.attachmentIds.length === 0) {
    issues.push({
      location: 'body',
      path: 'attachmentIds',
      message: 'Attach the insurer’s mail or PDF before recording the quote',
    });
  }
  const earlierFinal = await GhiQuoteModel.exists({
    caseId: doc._id,
    insurerId,
    status: 'FINAL',
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
}

function quoteFields(doc: GhiCaseDoc, input: UpdateEbQuoteRequest, actorId: Types.ObjectId) {
  const gstRatePercent = new Decimal(doc.gstRatePercent.toString()).toFixed();
  const premium = input.basePremium === null ? null : ebPremium(input.basePremium, gstRatePercent);
  return {
    status: input.finalize ? ('FINAL' as const) : ('DRAFT' as const),
    reason: input.reason,
    basePremium: premium ? toDecimal128(premium.basePremium) : null,
    statedRate: input.statedRate,
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

async function afterRecorded(
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
  // The first recorded quote moves the case to QCR (3.2).
  await advanceStage(doc._id, 'QCR', actorId, session);
}

function auditView(
  quote: Pick<
    GhiQuoteDoc,
    | 'version'
    | 'status'
    | 'basePremium'
    | 'gst'
    | 'totalPremium'
    | 'terms'
    | 'reason'
    | 'statedRate'
  >,
  insurer: string,
) {
  return {
    insurer,
    version: quote.version,
    status: quote.status,
    basePremium: str(quote.basePremium),
    statedRate: quote.statedRate ?? null,
    gst: str(quote.gst),
    totalPremium: str(quote.totalPremium),
    reason: quote.reason,
    terms: quote.terms,
  };
}

function assertQuotable(doc: GhiCaseDoc): void {
  assertWritable(doc);
  if (stageIndex(doc.stage) < stageIndex('RFQ')) {
    throw conflict(ERROR_CODES.CONFLICT, 'Generate and send the RFQ before recording quotes.');
  }
}

export async function createEbQuote(
  scope: CaseScope,
  id: string,
  input: CreateEbQuoteRequest,
  actor: Actor,
): Promise<EbQuote> {
  const doc = await loadCase(id, undefined, scope);
  assertQuotable(doc);
  const insurerId = new Types.ObjectId(input.insurerId);
  await checkQuote(doc, insurerId, input, null);
  if (await GhiQuoteModel.exists({ caseId: doc._id, insurerId, status: 'DRAFT' })) {
    throw conflict(
      ERROR_CODES.CONFLICT,
      'This insurer has a draft quote: finish or delete it first.',
    );
  }
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
    if (plain.status === 'FINAL') await afterRecorded(doc, plain, insurerName, actorId, session);
    await auditCase(
      actor,
      plain.status === 'FINAL' ? AUDIT_ACTIONS.GHI_QUOTE_FINALIZED : AUDIT_ACTIONS.GHI_QUOTE_SAVED,
      id,
      null,
      auditView(plain, insurerName),
      session,
      scope,
    );
    return plain;
  });
  return (await ebQuoteViews(await loadCase(id, undefined, scope), [saved]))[0]!;
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

export async function updateEbQuote(
  scope: CaseScope,
  id: string,
  quoteId: string,
  input: UpdateEbQuoteRequest,
  actor: Actor,
): Promise<EbQuote> {
  const doc = await loadCase(id, undefined, scope);
  assertQuotable(doc);
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
    if (quote.status === 'FINAL') await afterRecorded(doc, quote, insurerName, actorId, session);
    await auditCase(
      actor,
      quote.status === 'FINAL' ? AUDIT_ACTIONS.GHI_QUOTE_FINALIZED : AUDIT_ACTIONS.GHI_QUOTE_SAVED,
      id,
      auditView(draft, insurerName),
      auditView(quote, insurerName),
      session,
      scope,
    );
    return quote;
  });
  return (await ebQuoteViews(await loadCase(id, undefined, scope), [saved]))[0]!;
}

export async function deleteEbDraftQuote(
  scope: CaseScope,
  id: string,
  quoteId: string,
  actor: Actor,
): Promise<void> {
  const doc = await loadCase(id, undefined, scope);
  assertWritable(doc);
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
      scope,
    );
  });
}
