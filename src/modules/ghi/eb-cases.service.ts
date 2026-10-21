import {
  AUDIT_ACTIONS,
  ERROR_CODES,
  gpaMissing,
  gtliMissing,
  nextStepOf,
  planHasDependants,
  type CreateEbCaseRequest,
  type EbCaseCreated,
  type EbCaseListQuery,
  type EbCaseListResponse,
  type EbCaseRecord,
  type EbStage,
  type GpaRequirementsInput,
  type GtliRequirementsInput,
  type MissingItem,
} from '../../shared/index.ts';
import { Types, type QueryFilter } from 'mongoose';
import { withTransaction } from '../../lib/db.ts';
import { conflict } from '../../lib/errors.ts';
import { escapeRegExp } from '../../lib/text.ts';
import { ClientModel } from '../clients/client.model.ts';
import { gpaRequirementsOf, gtliRequirementsOf } from './eb-census-context.ts';
import { planView } from './eb-plan-view.ts';
import { createCaseOf } from './ghi-cases.service.ts';
import { GhiCaseModel, type GhiCaseDoc } from './ghi-case.model.ts';
import { GhiMemberModel } from './ghi-census.model.ts';
import {
  advanceStage,
  assertEditable,
  assertWritable,
  auditCase,
  caseRecordWith,
  loadCase,
  nameOf,
  requirementsOut,
  userNames,
  type Actor,
} from './ghi-common.ts';
import { productFilter, type CaseScope } from './products/profile.ts';

// GPA and GTLI cases (N1, Requirements 1 to 5): creation and listing across products, the case
// record, and the Data Sheet. The case collection, insurers, census and workflow records are the
// GHI module's (design D1, D3); only the product's own rules differ.

/** What a GPA or GTLI Data Sheet still needs before the RFQ (4.7, 5.6). */
export function ebMissingItems(doc: GhiCaseDoc): MissingItem[] {
  if (doc.product === 'GPA') {
    return gpaMissing(gpaRequirementsOf(doc), {
      planHasDependants: doc.planAssignment ? planHasDependants(doc.planAssignment.slots) : false,
    });
  }
  return gtliMissing(gtliRequirementsOf(doc), { renewal: doc.type === 'RENEWAL' });
}

/** A GPA or GTLI case as the API returns it. */
export async function toEbCaseRecord(doc: GhiCaseDoc): Promise<EbCaseRecord> {
  const items = ebMissingItems(doc);
  const base = await caseRecordWith(
    doc,
    items.map((item) => item.label),
  );
  const names = doc.placement
    ? await userNames([doc.placement.issuedBy])
    : new Map<string, string>();
  const {
    requirements: _requirements,
    finalQcr: _finalQcr,
    policy: _policy,
    product: _product,
    plan: _plan,
    stage: _stage,
    ...rest
  } = base;
  const stage = doc.stage as EbStage;
  const placed = Boolean(doc.placement);
  const shared = {
    ...rest,
    stage,
    placed,
    missing: items.map((item) => item.label),
    missingItems: items,
    plan: await planView(doc.planAssignment, doc.product ?? 'GPA'),
    placement: doc.placement
      ? {
          snapshotId: doc.placement.snapshotId.toHexString(),
          issuedAt: doc.placement.issuedAt.toISOString(),
          issuedBy: nameOf(names, doc.placement.issuedBy),
          policyNumber: doc.placement.policyNumber,
          policyStart: doc.placement.policyStart,
          policyEnd: doc.placement.policyEnd,
        }
      : null,
    nextStep: nextStepOf(stage, {
      placed,
      missing: items,
      planAssigned: Boolean(doc.planAssignment),
    }),
  };
  const requirements = requirementsOut(doc.requirements);
  return doc.product === 'GTLI'
    ? {
        ...shared,
        product: 'GTLI',
        requirements: requirements as unknown as Extract<
          EbCaseRecord,
          { product: 'GTLI' }
        >['requirements'],
      }
    : {
        ...shared,
        product: 'GPA',
        requirements: requirements as unknown as Extract<
          EbCaseRecord,
          { product: 'GPA' }
        >['requirements'],
      };
}

export async function getEbCase(scope: CaseScope, id: string): Promise<EbCaseRecord> {
  return toEbCaseRecord(await loadCase(id, undefined, scope));
}

/** Creates a case of any product (Requirement 1.4); the response names the product (1.5). */
export async function createEbCase(
  input: CreateEbCaseRequest,
  actor: Actor,
  options: { defaultGstRatePercent: string },
): Promise<EbCaseCreated> {
  const { product, ...rest } = input;
  return createCaseOf(product, rest, actor, options);
}

/**
 * Cases of every product, most recently changed first, filtered by product, stage, type, company
 * and search text (reference or company name), with page numbers (Requirement 2.3).
 */
export async function listEbCases(query: EbCaseListQuery): Promise<EbCaseListResponse> {
  const filter: QueryFilter<GhiCaseDoc> = query.product ? productFilter(query.product) : {};
  if (query.stage) filter.stage = query.stage;
  if (query.type) filter.type = query.type;
  if (query.clientId) filter.clientId = new Types.ObjectId(query.clientId);
  if (query.q) {
    const pattern = new RegExp(escapeRegExp(query.q), 'i');
    const clients = await ClientModel.find({ name: pattern }, { _id: 1 }).limit(500).lean();
    filter.$or = [
      { reference: pattern },
      { clientId: { $in: clients.map((client) => client._id) } },
    ];
  }
  const [total, docs] = await Promise.all([
    GhiCaseModel.countDocuments(filter),
    GhiCaseModel.find(filter, { requirements: 0, activity: 0 })
      .sort({ updatedAt: -1, _id: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean(),
  ]);
  const [clients, owners, counts] = await Promise.all([
    ClientModel.find({ _id: { $in: docs.map((doc) => doc.clientId) } }, { name: 1 }).lean(),
    userNames(docs.map((doc) => doc.ownerId)),
    GhiMemberModel.aggregate<{ _id: Types.ObjectId; lives: number; employees: number }>([
      { $match: { caseId: { $in: docs.map((doc) => doc._id) } } },
      {
        $group: {
          _id: '$caseId',
          lives: { $sum: 1 },
          employees: { $sum: { $cond: [{ $eq: ['$relationship', 'SELF'] }, 1, 0] } },
        },
      },
    ]),
  ]);
  const clientName = new Map(clients.map((client) => [client._id.toHexString(), client.name]));
  const countOf = new Map(counts.map((count) => [count._id.toHexString(), count]));
  return {
    items: docs.map((doc) => ({
      id: doc._id.toHexString(),
      product: doc.product ?? 'GMC',
      reference: doc.reference,
      type: doc.type,
      stage: doc.stage,
      placed: doc.policy !== null || Boolean(doc.placement),
      client: {
        id: doc.clientId.toHexString(),
        name: clientName.get(doc.clientId.toHexString()) ?? 'Client no longer exists',
      },
      owner: owners.get(doc.ownerId.toHexString()) ?? 'Unknown user',
      policyStart: doc.policyStart,
      dueDate: doc.dueDate,
      employees: countOf.get(doc._id.toHexString())?.employees ?? 0,
      lives: countOf.get(doc._id.toHexString())?.lives ?? 0,
      updatedAt: doc.updatedAt.toISOString(),
    })),
    total,
    page: query.page,
    limit: query.limit,
  };
}

const lockedMessage =
  'The RFQ has been sent to an insurer, so the Data Sheet can no longer change. Changes after this are endorsements, which are not handled in the app yet.';

/** The Data Sheet fields whose change re-checks the census (sums insured, ages). */
function censusFields(input: GpaRequirementsInput | GtliRequirementsInput) {
  return JSON.stringify([
    input.sumInsuredBasis,
    'dependantBasis' in input ? input.dependantBasis : null,
    'freeCoverLimit' in input ? input.freeCoverLimit : null,
    input.ageLimits,
    input.ageReferenceDate,
  ]);
}

/**
 * Saves a GPA or GTLI Data Sheet as a draft (4.7, 5.6): the first save moves the case to Data
 * Sheet (3.2). Refused while the case is locked, closed or placed (4.9, 5.8, 3.11).
 */
export async function saveEbRequirements(
  scope: CaseScope,
  id: string,
  input: GpaRequirementsInput | GtliRequirementsInput,
  actor: Actor,
): Promise<EbCaseRecord> {
  const doc = await loadCase(id, undefined, scope);
  assertWritable(doc);
  try {
    assertEditable(doc);
  } catch {
    throw conflict(
      ERROR_CODES.GHI_LOCKED,
      doc.stage === 'CLOSED' ? 'This case is closed.' : lockedMessage,
    );
  }
  const actorId = new Types.ObjectId(actor.id);
  const previous = doc.requirements as unknown as GpaRequirementsInput | GtliRequirementsInput;
  const affectsCensus = censusFields(previous) !== censusFields(input);
  await withTransaction(async (session) => {
    const result = await GhiCaseModel.updateOne(
      {
        _id: doc._id,
        requirementsRevision: doc.requirementsRevision,
        stage: { $ne: 'CLOSED' },
        placement: { $in: [null] },
        insurers: { $not: { $elemMatch: { sentAt: { $ne: null } } } },
      },
      {
        $set: {
          requirements: input,
          requirementsSaved: true,
          updatedBy: actorId,
          ...(affectsCensus ? { censusRevision: doc.censusRevision + 1 } : {}),
        },
        $inc: { requirementsRevision: 1 },
        $push: { activity: { at: new Date(), actorId, message: 'Data Sheet saved' } },
      },
      { session },
    );
    if (result.modifiedCount === 0) {
      const current = await loadCase(id, session, scope);
      assertWritable(current);
      if (current.insurers.some((insurer) => insurer.sentAt !== null)) {
        throw conflict(ERROR_CODES.GHI_LOCKED, lockedMessage);
      }
      throw conflict(
        ERROR_CODES.CONFLICT,
        'Someone else saved this Data Sheet meanwhile. Reload it and make your change again.',
      );
    }
    await advanceStage(doc._id, 'DATA_SHEET', actorId, session);
    await auditCase(
      actor,
      AUDIT_ACTIONS.GHI_REQUIREMENTS_SAVED,
      id,
      doc.requirementsSaved ? doc.requirements : null,
      input,
      session,
      scope,
    );
  });
  return getEbCase(scope, id);
}
