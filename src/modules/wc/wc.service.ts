import { continuesPolicy } from '../../shared/case-types.ts';
import {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  ERROR_CODES,
  WC_DEFAULT_CATEGORIES,
  WC_DEFAULT_CLAUSES,
  WC_DEFAULT_CONDITIONS,
  WC_DEFAULT_COVERAGE_OPTIONS,
  WC_DEFAULT_POLICY_PERIOD,
  wcMissing,
  wcStage,
  wcTotals,
  type CreateWcCaseRequest,
  type WcCase,
  type WcCaseSummary,
  type WcDataSheetInput,
  type WcQuotesInput,
  type WcRfqInput,
  type WcPlacementInput,
} from '../../shared/index.ts';
import { Types, type mongo } from 'mongoose';
import { withTransaction } from '../../lib/db.ts';
import { conflict, notFound, validationError } from '../../lib/errors.ts';
import { istDay } from '../../lib/ist-day.ts';
import { writeAudit } from '../audit/audit.service.ts';
import { taxRatePercentOn } from '../catalog/catalog.service.ts';
import { ClientModel, type ClientDoc } from '../clients/client.model.ts';
import type { Actor } from '../clients/clients.service.ts';
import { InsurerModel } from '../insurers/insurer.model.ts';
import { CounterModel } from '../proposals/proposal.model.ts';
import { UserModel } from '../users/user.model.ts';
import { WcCaseModel, type WcCaseDoc } from './wc-case.model.ts';

// Workmen compensation cases: created for a client (new business or renewal) with the client's
// format as the starting Data Sheet, edited, and quoted by insurers per coverage option.

/** "2026" in IST, for the yearly reference series. */
function istYear(now: Date): string {
  return istDay(now).slice(0, 4);
}

/** WC-2026-0001: its own yearly series. */
async function nextReference(session: mongo.ClientSession): Promise<string> {
  const year = istYear(new Date());
  const counter = await CounterModel.findOneAndUpdate(
    { _id: `wc-${year}` },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after', session },
  ).lean();
  return `WC-${year}-${String(counter?.seq ?? 1).padStart(4, '0')}`;
}

const rowId = (prefix: string, index: number) => `${prefix}${index + 1}`;

export function addressOf(client: Pick<ClientDoc, 'address'>): string {
  const { address } = client;
  return [address.line1, address.line2, address.city, `${address.state} ${address.pincode}`]
    .filter(Boolean)
    .join(', ');
}

/** The RFQ has gone to an insurer, as on the other lines: the Data Sheet is then locked. */
const isLocked = (doc: Pick<WcCaseDoc, 'rfqInsurers'>) =>
  (doc.rfqInsurers ?? []).some((item) => item.sentOn !== null);

async function loadCase(id: string): Promise<WcCaseDoc> {
  const doc = await WcCaseModel.findById(id).lean();
  if (!doc) throw notFound('Workmen compensation case not found');
  return doc;
}

/** The case as the API returns it. */
export async function toWcCase(doc: WcCaseDoc): Promise<WcCase> {
  const [client, owner, insurers] = await Promise.all([
    ClientModel.findById(doc.clientId, { name: 1, gstin: 1, address: 1 }).lean(),
    UserModel.findById(doc.ownerId, { name: 1 }).lean(),
    InsurerModel.find(
      {
        _id: {
          $in: [
            ...doc.quotes.map((quote) => quote.insurerId),
            ...(doc.rfqInsurers ?? []).map((item) => item.insurerId),
            ...(doc.placement ? [doc.placement.insurerId] : []),
          ],
        },
      },
      { company: 1, branch: 1 },
    ).lean(),
  ]);
  const insurerName = new Map(
    insurers.map((insurer) => [insurer._id.toHexString(), `${insurer.company}, ${insurer.branch}`]),
  );
  const sheet = {
    policyPeriod: doc.policyPeriod,
    natureOfBusiness: doc.natureOfBusiness,
    workingHeight: doc.workingHeight,
    riskLocation: doc.riskLocation,
    categoryDescription: doc.categoryDescription,
    categories: doc.categories.map((category) => ({ ...category })),
    coverageOptions: doc.coverageOptions.map((option) => ({ ...option })),
    clauses: [...doc.clauses],
    conditions: [...doc.conditions],
    expiringPolicy: doc.expiringPolicy ? { ...doc.expiringPolicy } : null,
  };
  const nameOf = (id: Types.ObjectId) => insurerName.get(id.toHexString()) ?? 'Unknown insurer';
  const placement = doc.placement ?? null;
  const placedQuote = placement
    ? doc.quotes.find((quote) => quote.insurerId.equals(placement.insurerId))
    : undefined;
  const missing = wcMissing(sheet);
  return {
    id: doc._id.toHexString(),
    reference: doc.reference,
    type: doc.type,
    stage: wcStage({
      missing,
      rfqSent: (doc.rfqInsurers ?? []).some((item) => item.sentOn !== null),
      quoted: doc.quotes.some((quote) => quote.premiums.some((premium) => premium.premium)),
      recommended: doc.recommendedInsurerId !== null,
      placement,
    }),
    locked: isLocked(doc),
    rfqInsurers: (doc.rfqInsurers ?? []).map((item) => ({
      insurerId: item.insurerId.toHexString(),
      insurerName: nameOf(item.insurerId),
      sentOn: item.sentOn,
    })),
    placement: placement
      ? {
          insurerId: placement.insurerId.toHexString(),
          insurerName: nameOf(placement.insurerId),
          optionId: placement.optionId,
          optionLabel:
            doc.coverageOptions.find((option) => option.id === placement.optionId)?.label ?? '—',
          premium:
            placedQuote?.premiums.find((premium) => premium.optionId === placement.optionId)
              ?.premium ?? null,
          paymentInFavourOf: placedQuote?.paymentInFavourOf ?? null,
          policyNumber: placement.policyNumber,
          policyStart: placement.policyStart,
          policyEnd: placement.policyEnd,
          updatedAt: placement.updatedAt.toISOString(),
        }
      : null,
    client: {
      id: doc.clientId.toHexString(),
      name: client?.name ?? 'Unknown client',
      gstin: client?.gstin ?? null,
      address: client ? addressOf(client) : '',
    },
    gstRatePercent: doc.gstRatePercent,
    ...sheet,
    totals: wcTotals(sheet.categories),
    quotes: doc.quotes.map((quote) => ({
      insurerId: quote.insurerId.toHexString(),
      insurerName: insurerName.get(quote.insurerId.toHexString()) ?? 'Unknown insurer',
      paymentInFavourOf: quote.paymentInFavourOf,
      premiums: quote.premiums.map((premium) => ({ ...premium })),
    })),
    recommendedInsurerId: doc.recommendedInsurerId?.toHexString() ?? null,
    remarks: doc.remarks,
    missing,
    owner: { id: doc.ownerId.toHexString(), name: owner?.name ?? 'Unknown user' },
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export async function getWcCase(id: string): Promise<WcCase> {
  return toWcCase(await loadCase(id));
}

export async function listWcCases(): Promise<{ items: WcCaseSummary[] }> {
  const docs = await WcCaseModel.find({}).sort({ updatedAt: -1 }).limit(500).lean();
  const clients = await ClientModel.find(
    { _id: { $in: [...new Set(docs.map((doc) => doc.clientId.toHexString()))] } },
    { name: 1 },
  ).lean();
  const clientName = new Map(clients.map((client) => [client._id.toHexString(), client.name]));
  return {
    items: docs.map((doc) => ({
      id: doc._id.toHexString(),
      reference: doc.reference,
      type: doc.type,
      stage: wcStage({
        missing: wcMissing(doc),
        rfqSent: (doc.rfqInsurers ?? []).some((item) => item.sentOn !== null),
        quoted: doc.quotes.some((quote) => quote.premiums.some((premium) => premium.premium)),
        recommended: doc.recommendedInsurerId !== null,
        placement: doc.placement ?? null,
      }),
      clientName: clientName.get(doc.clientId.toHexString()) ?? 'Unknown client',
      persons: wcTotals(doc.categories).persons,
      insurers: doc.quotes.length,
      ready: wcMissing(doc).length === 0,
      updatedAt: doc.updatedAt.toISOString(),
    })),
  };
}

/**
 * Creates a case for a client. Its Data Sheet starts from the client's format: the worker
 * categories (persons and wages to fill), the three coverage options, the clauses and conditions;
 * the nature of business is the client's. A renewal starts with an empty expiring policy.
 */
export async function createWcCase(
  input: CreateWcCaseRequest,
  actor: Actor,
  options: { defaultGstRatePercent: string },
): Promise<WcCase> {
  const client = await ClientModel.findById(input.clientId, { natureOfBusiness: 1 }).lean();
  if (!client) {
    throw validationError([{ location: 'body', path: 'clientId', message: 'Choose a client' }]);
  }
  const now = new Date();
  const gstRatePercent = await taxRatePercentOn('GST', istDay(now), options.defaultGstRatePercent);
  const userId = new Types.ObjectId(actor.id);
  const id = await withTransaction(async (session) => {
    const reference = await nextReference(session);
    const [doc] = await WcCaseModel.create(
      [
        {
          reference,
          type: input.type,
          clientId: client._id,
          ownerId: userId,
          gstRatePercent,
          policyPeriod: WC_DEFAULT_POLICY_PERIOD,
          natureOfBusiness: client.natureOfBusiness || null,
          workingHeight: null,
          riskLocation: null,
          categoryDescription: null,
          categories: WC_DEFAULT_CATEGORIES.map((designation, index) => ({
            id: rowId('c', index),
            designation,
            persons: 0,
            monthlyWage: '0',
          })),
          coverageOptions: WC_DEFAULT_COVERAGE_OPTIONS.map((label, index) => ({
            id: rowId('o', index),
            label,
          })),
          clauses: [...WC_DEFAULT_CLAUSES],
          conditions: [...WC_DEFAULT_CONDITIONS],
          expiringPolicy: continuesPolicy(input.type)
            ? {
                policyYear: null,
                policyNumber: null,
                insurer: null,
                persons: null,
                sumInsured: null,
                premiumInclGst: null,
                coverageOption: null,
                claimAmount: null,
                changes: null,
              }
            : null,
          rfqInsurers: [],
          quotes: [],
          recommendedInsurerId: null,
          placement: null,
          remarks: null,
          createdBy: userId,
          updatedBy: userId,
        },
      ],
      { session },
    );
    if (!doc) throw new Error('The case was not created');
    await writeAudit(
      {
        userId: actor.id,
        action: AUDIT_ACTIONS.WC_CASE_CREATED,
        entity: AUDIT_ENTITIES.WC_CASE,
        entityId: doc._id.toHexString(),
        after: { reference, clientId: input.clientId, type: input.type },
        requestId: actor.requestId,
      },
      session,
    );
    return doc._id.toHexString();
  });
  return getWcCase(id);
}

/**
 * Saves the Data Sheet. A coverage option removed takes its quoted premiums with it; the
 * expiring policy is a renewal's only.
 */
export async function saveWcDataSheet(
  id: string,
  input: WcDataSheetInput,
  actor: Actor,
): Promise<WcCase> {
  const before = await loadCase(id);
  if (isLocked(before)) {
    throw conflict(
      ERROR_CODES.CONFLICT,
      'The RFQ has been sent to insurers, so the Data Sheet is locked. Clear the sent dates on the RFQ tab to change it.',
    );
  }
  const kept = new Set(input.coverageOptions.map((option) => option.id));
  await withTransaction(async (session) => {
    await WcCaseModel.updateOne(
      { _id: before._id },
      {
        $set: {
          ...input,
          expiringPolicy: continuesPolicy(before.type) ? input.expiringPolicy : null,
          quotes: before.quotes.map((quote) => ({
            ...quote,
            premiums: quote.premiums.filter((premium) => kept.has(premium.optionId)),
          })),
          // The coverage option accepted was removed: the placement is chosen again.
          ...(before.placement && !kept.has(before.placement.optionId) ? { placement: null } : {}),
          updatedBy: new Types.ObjectId(actor.id),
        },
      },
      { session },
    );
    await writeAudit(
      {
        userId: actor.id,
        action: AUDIT_ACTIONS.WC_CASE_UPDATED,
        entity: AUDIT_ENTITIES.WC_CASE,
        entityId: id,
        before: {
          categories: before.categories,
          coverageOptions: before.coverageOptions,
          clauses: before.clauses,
          conditions: before.conditions,
        },
        after: {
          categories: input.categories,
          coverageOptions: input.coverageOptions,
          clauses: input.clauses,
          conditions: input.conditions,
        },
        requestId: actor.requestId,
      },
      session,
    );
  });
  return getWcCase(id);
}

/**
 * Saves the insurers' quotes: a premium (GST included) per coverage option of the case, the
 * payee, the insurer recommended and remarks. Insurers must be in the insurer master.
 */
export async function saveWcQuotes(
  id: string,
  input: WcQuotesInput,
  actor: Actor,
): Promise<WcCase> {
  const before = await loadCase(id);
  const ids = input.quotes.map((quote) => new Types.ObjectId(quote.insurerId));
  const found = await InsurerModel.countDocuments({ _id: { $in: ids } });
  if (found !== ids.length) {
    throw validationError([
      { location: 'body', path: 'quotes', message: 'Choose insurers from the insurer master' },
    ]);
  }
  // Only the insurers added on the Insurers and RFQ tab quote (as on the other lines); one that
  // quoted before stays allowed.
  const allowed = new Set([
    ...(before.rfqInsurers ?? []).map((item) => item.insurerId.toHexString()),
    ...before.quotes.map((quote) => quote.insurerId.toHexString()),
  ]);
  input.quotes.forEach((quote, index) => {
    if (!allowed.has(quote.insurerId)) {
      throw validationError([
        {
          location: 'body',
          path: `quotes.${index}.insurerId`,
          message: 'Add the insurer on the Insurers and RFQ tab before its quote',
        },
      ]);
    }
  });
  const options = new Set(before.coverageOptions.map((option) => option.id));
  input.quotes.forEach((quote, index) => {
    quote.premiums.forEach((premium, line) => {
      if (!options.has(premium.optionId)) {
        throw validationError([
          {
            location: 'body',
            path: `quotes.${index}.premiums.${line}.optionId`,
            message: 'This coverage option is no longer on the case; reload it',
          },
        ]);
      }
    });
  });
  await withTransaction(async (session) => {
    await WcCaseModel.updateOne(
      { _id: before._id },
      {
        $set: {
          quotes: input.quotes.map((quote) => ({
            insurerId: new Types.ObjectId(quote.insurerId),
            paymentInFavourOf: quote.paymentInFavourOf,
            premiums: quote.premiums,
          })),
          recommendedInsurerId: input.recommendedInsurerId
            ? new Types.ObjectId(input.recommendedInsurerId)
            : null,
          remarks: input.remarks,
          // The insurer accepted no longer quotes: the placement is chosen again.
          ...(before.placement &&
          !input.quotes.some((quote) => before.placement?.insurerId.equals(quote.insurerId))
            ? { placement: null }
            : {}),
          updatedBy: new Types.ObjectId(actor.id),
        },
      },
      { session },
    );
    await writeAudit(
      {
        userId: actor.id,
        action: AUDIT_ACTIONS.WC_QUOTES_SAVED,
        entity: AUDIT_ENTITIES.WC_CASE,
        entityId: id,
        before: { quotes: before.quotes, recommendedInsurerId: before.recommendedInsurerId },
        after: input,
        requestId: actor.requestId,
      },
      session,
    );
  });
  return getWcCase(id);
}

/** Records a document download. */
export async function auditWcDownload(id: string, kind: string, format: string, actor: Actor) {
  await writeAudit({
    userId: actor.id,
    action: AUDIT_ACTIONS.WC_DOCUMENT_DOWNLOADED,
    entity: AUDIT_ENTITIES.WC_CASE,
    entityId: id,
    after: { kind, format },
    requestId: actor.requestId,
  });
}

/** The insurers the RFQ goes to and the day it was sent to each. */
export async function saveWcRfq(id: string, input: WcRfqInput, actor: Actor): Promise<WcCase> {
  const before = await loadCase(id);
  const ids = input.insurers.map((item) => new Types.ObjectId(item.insurerId));
  if ((await InsurerModel.countDocuments({ _id: { $in: ids } })) !== ids.length) {
    throw validationError([
      { location: 'body', path: 'insurers', message: 'Choose insurers from the insurer master' },
    ]);
  }
  await withTransaction(async (session) => {
    await WcCaseModel.updateOne(
      { _id: before._id },
      {
        $set: {
          rfqInsurers: input.insurers.map((item) => ({
            insurerId: new Types.ObjectId(item.insurerId),
            sentOn: item.sentOn,
          })),
          updatedBy: new Types.ObjectId(actor.id),
        },
      },
      { session },
    );
    await writeAudit(
      {
        userId: actor.id,
        action: AUDIT_ACTIONS.WC_RFQ_SENT,
        entity: AUDIT_ENTITIES.WC_CASE,
        entityId: id,
        before: { insurers: before.rfqInsurers ?? [] },
        after: input,
        requestId: actor.requestId,
      },
      session,
    );
  });
  return getWcCase(id);
}

/**
 * The client's decision: the insurer and coverage option accepted, which must have been quoted;
 * with the policy number the case is placed.
 */
export async function saveWcPlacement(
  id: string,
  input: WcPlacementInput,
  actor: Actor,
): Promise<WcCase> {
  const before = await loadCase(id);
  const quote = before.quotes.find((item) => item.insurerId.equals(input.insurerId));
  const premium = quote?.premiums.find((item) => item.optionId === input.optionId)?.premium;
  if (!quote || !premium) {
    throw validationError([
      {
        location: 'body',
        path: 'optionId',
        message: 'Choose an insurer and coverage option with a premium quoted',
      },
    ]);
  }
  await withTransaction(async (session) => {
    await WcCaseModel.updateOne(
      { _id: before._id },
      {
        $set: {
          placement: {
            insurerId: new Types.ObjectId(input.insurerId),
            optionId: input.optionId,
            policyNumber: input.policyNumber,
            policyStart: input.policyStart,
            policyEnd: input.policyEnd,
            updatedAt: new Date(),
          },
          updatedBy: new Types.ObjectId(actor.id),
        },
      },
      { session },
    );
    await writeAudit(
      {
        userId: actor.id,
        action: AUDIT_ACTIONS.WC_PLACEMENT_SAVED,
        entity: AUDIT_ENTITIES.WC_CASE,
        entityId: id,
        before: { placement: before.placement ?? null },
        after: input,
        requestId: actor.requestId,
      },
      session,
    );
  });
  return getWcCase(id);
}
