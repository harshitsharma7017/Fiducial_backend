import {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  ERROR_CODES,
  OTHER_SECTIONS,
  PROPOSAL_STAGE_LABELS,
  ROLES,
  ADDON_LIST_LABELS,
  SUM_INSURED_LINE,
  formatDate,
  formatRupeesShort,
  hasBasis,
  hasExistingFigures,
  hasRfq,
  isAnnexureSection,
  can,
  wholeRupees,
  type AuditAction,
  type CreateProposalRequest,
  type ExistingPolicyLookup,
  type MoveProposalStageRequest,
  type OtherSection,
  type ProposalOwnersResponse,
  type DataSheetInput,
  type MarkRfqSentRequest,
  type Paginated,
  type ProposalListQuery,
  type ProposalRecord,
  type SetProposalInsurersRequest,
} from '../../shared/index.ts';
import { Types, type QueryFilter, type mongo } from 'mongoose';
import { withTransaction } from '../../lib/db.ts';
import { Decimal, toDecimal128 } from '../../lib/decimal.ts';
import { istDay } from '../../lib/ist-day.ts';
import { conflict, notFound, validationError, type AppError } from '../../lib/errors.ts';
import { writeAudit } from '../audit/audit.service.ts';
import { ClientLocationModel } from '../clients/client-location.model.ts';
import { ClientModel } from '../clients/client.model.ts';
import { catalogItems, taxRatePercentOn } from '../catalog/catalog.service.ts';
import { InsurerModel } from '../insurers/insurer.model.ts';
import { UserModel } from '../users/user.model.ts';
import type { ExistingPolicyResult, ExistingPolicySource } from './existing-policy-source.ts';
import { loadContext, toProposalAuditView, toProposalRecord } from './proposals.mapper.ts';
import {
  CounterModel,
  ProposalModel,
  type ExistingFiguresDoc,
  type ExistingPolicyDoc,
  type ProposalDoc,
} from './proposal.model.ts';

export interface Actor {
  id: string;
  requestId: string | null;
}

const money = (value: string | null) => (value === null ? null : toDecimal128(value));

function proposalNotFound(): AppError {
  return notFound('Proposal not found');
}

function locked(): AppError {
  return conflict(
    ERROR_CODES.PROPOSAL_LOCKED,
    'The RFQ has gone to an insurer, so the Data Sheet can no longer change.',
  );
}

export function closed(): AppError {
  return conflict(ERROR_CODES.PROPOSAL_LOCKED, 'This case is closed.');
}

/** Roles whose users can be assigned a case: those who may edit proposals. */
const OWNER_ROLES = ROLES.filter((role) => can([role], 'proposals.edit'));

/** Active staff who can be assigned a case, by name. */
export async function listOwners(): Promise<ProposalOwnersResponse> {
  const users = await UserModel.find(
    { active: true, roles: { $in: OWNER_ROLES } },
    { name: 1, email: 1 },
  )
    .sort({ name: 1 })
    .lean();
  return {
    items: users.map((user) => ({
      id: user._id.toHexString(),
      name: user.name,
      email: user.email,
    })),
  };
}

/** Last year's policy from the policy software, as stored on a renewal. */
function snapshotOf(result: ExistingPolicyResult, at: Date): ExistingPolicyDoc | null {
  if (result.status !== 'FOUND') return null;
  const policy = result.policy;
  return {
    source: policy.source,
    fetchedAt: at,
    insurer: policy.insurer,
    policyNumber: policy.policyNumber,
    product: policy.product,
    periodStart: policy.periodStart,
    periodEnd: policy.periodEnd,
    sections: policy.sections.map((section) => ({
      code: section.code,
      sumInsured: toDecimal128(section.sumInsured),
      premium: money(section.premium),
    })),
    fireLines: policy.fireLines.map((line) => ({
      group: line.group,
      sumInsured: toDecimal128(line.sumInsured),
    })),
    totalSumInsured: toDecimal128(policy.totalSumInsured),
    netPremium: money(policy.netPremium),
    gst: money(policy.gst),
    totalPremium: money(policy.totalPremium),
  };
}

function lookupOf(
  result: ExistingPolicyResult,
  at: Date,
): NonNullable<ProposalDoc['existingPolicyLookup']> {
  return {
    status: result.status,
    message: result.status === 'FOUND' ? null : result.message,
    checkedAt: at,
  };
}

/**
 * A renewal starts from last year's figures: every other section the policy had is included,
 * with its sum insured as Proposed 1 (to the rupee), for the team to change.
 */
function sectionsFrom(snapshot: ExistingPolicyDoc | null): ProposalDoc['sections'] {
  if (!snapshot) return [];
  return snapshot.sections.flatMap((section) =>
    (OTHER_SECTIONS as readonly string[]).includes(section.code) &&
    section.sumInsured.toString() !== '0'
      ? [
          {
            code: section.code as OtherSection,
            included: true,
            proposed1: toDecimal128(wholeRupees(section.sumInsured.toString())),
            proposed2: null,
          },
        ]
      : [],
  );
}

/** What the policy software has for a client, for the New proposal screen. Nothing is saved. */
export async function lastPolicyOf(
  clientId: string,
  source: ExistingPolicySource,
): Promise<ExistingPolicyLookup> {
  const client = await ClientModel.findById(clientId, { name: 1, gstin: 1 }).lean();
  if (!client) throw notFound('Client not found');
  const result = await source.latest({ gstin: client.gstin, clientName: client.name });
  const at = new Date();
  return {
    status: result.status,
    policy: result.status === 'FOUND' ? { ...result.policy, fetchedAt: at.toISOString() } : null,
    message: result.status === 'FOUND' ? null : result.message,
    checkedAt: at.toISOString(),
  };
}

export async function recordOf(doc: ProposalDoc): Promise<ProposalRecord> {
  return toProposalRecord(doc, await loadContext([doc]));
}

/** The year in India, for references such as PRP-2026-0001. */
function istYear(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric' }).format(
    now,
  );
}

async function nextReference(session: mongo.ClientSession): Promise<string> {
  const year = istYear(new Date());
  const counter = await CounterModel.findOneAndUpdate(
    { _id: `proposal-${year}` },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after', session },
  ).lean();
  return `PRP-${year}-${String(counter?.seq ?? 1).padStart(4, '0')}`;
}

/** Every location must be one of the client's risk locations. */
async function assertClientLocations(
  clientId: Types.ObjectId,
  locationIds: readonly string[],
  path: string,
): Promise<void> {
  if (locationIds.length === 0) return;
  const found = await ClientLocationModel.countDocuments({
    _id: { $in: locationIds.map((id) => new Types.ObjectId(id)) },
    clientId,
  });
  if (found !== new Set(locationIds).size) {
    throw validationError([
      { location: 'body', path, message: "Choose risk locations from this client's locations" },
    ]);
  }
}

/** The record of a just-updated case, with its stored stage kept in step (same transaction). */
export async function keepStage(
  updated: ProposalDoc,
  session: mongo.ClientSession,
): Promise<ProposalRecord> {
  const record = await recordOf(updated);
  if (record.stage !== updated.stage) {
    await ProposalModel.updateOne(
      { _id: updated._id },
      { $set: { stage: record.stage } },
      { session },
    );
  }
  return record;
}

/**
 * Where a change applies: `guard` narrows the update (it fails with `changed()` when the case no
 * longer matches), and `arrayFilters` serve dotted paths such as insurers.$[target].status.
 */
export interface SaveTarget {
  guard?: Record<string, unknown>;
  arrayFilters?: Record<string, unknown>[];
  changed?: () => AppError;
}

/** Saves the change, keeps the stored stage in step, and writes the audit entry. */
export async function saveWith(
  doc: ProposalDoc,
  set: Partial<ProposalDoc> & Record<string, unknown>,
  activity: string | null,
  action: AuditAction,
  actor: Actor,
  before: ProposalRecord | null,
  target: SaveTarget = {},
): Promise<ProposalRecord> {
  return withTransaction(async (session) => {
    const update: Record<string, unknown> = {
      $set: { ...set, updatedBy: new Types.ObjectId(actor.id) },
    };
    if (activity) {
      update.$push = {
        activity: { at: new Date(), actorId: new Types.ObjectId(actor.id), message: activity },
      };
    }
    const updated = await ProposalModel.findOneAndUpdate(
      { ...target.guard, _id: doc._id },
      update,
      {
        returnDocument: 'after',
        runValidators: true,
        session,
        ...(target.arrayFilters ? { arrayFilters: target.arrayFilters } : {}),
      },
    ).lean();
    if (!updated) throw target.changed && target.guard ? target.changed() : proposalNotFound();
    const record = await keepStage(updated, session);
    await writeAudit(
      {
        userId: actor.id,
        action,
        entity: AUDIT_ENTITIES.PROPOSAL,
        entityId: record.id,
        before: before ? toProposalAuditView(before) : null,
        after: toProposalAuditView(record),
        requestId: actor.requestId,
      },
      session,
    );
    return record;
  });
}

export async function loadDoc(id: string): Promise<ProposalDoc> {
  const doc = await ProposalModel.findById(id).lean();
  if (!doc) throw proposalNotFound();
  return doc;
}

/** New proposals, newest first. The cursor is the last proposal's id. */
export async function listProposals(query: ProposalListQuery): Promise<Paginated<ProposalRecord>> {
  const filter: QueryFilter<ProposalDoc> = {};
  if (query.type) filter.type = query.type;
  if (query.stage) filter.stage = query.stage;
  if (query.clientId) filter.clientId = new Types.ObjectId(query.clientId);
  if (query.cursor) filter._id = { $lt: new Types.ObjectId(query.cursor) };
  const docs = await ProposalModel.find(filter)
    .sort({ _id: -1 })
    .limit(query.limit + 1)
    .lean();
  const page = docs.slice(0, query.limit);
  const context = await loadContext(page);
  const last = page.at(-1);
  return {
    items: page.map((doc) => toProposalRecord(doc, context)),
    nextCursor: docs.length > query.limit && last ? last._id.toHexString() : null,
  };
}

export async function getProposal(id: string): Promise<ProposalRecord> {
  return recordOf(await loadDoc(id));
}

export async function createProposal(
  input: CreateProposalRequest,
  actor: Actor,
  options: { defaultGstRatePercent: string; policySource: ExistingPolicySource },
): Promise<ProposalRecord> {
  const client = await ClientModel.findById(input.clientId, { name: 1, gstin: 1 }).lean();
  if (!client) {
    throw validationError([{ location: 'body', path: 'clientId', message: 'Choose a client' }]);
  }
  await assertClientLocations(client._id, input.locationIds, 'locationIds');
  const userId = new Types.ObjectId(actor.id);
  const ownerId = input.ownerId ? new Types.ObjectId(input.ownerId) : userId;
  if (input.ownerId) {
    const owner = await UserModel.exists({
      _id: ownerId,
      active: true,
      roles: { $in: OWNER_ROLES },
    });
    if (!owner) {
      throw validationError([
        {
          location: 'body',
          path: 'ownerId',
          message: 'Choose active staff who can edit proposals',
        },
      ]);
    }
  }
  // A renewal copies last year's policy from the policy software (D-2). Looked up before the
  // transaction: it is a call to another system.
  const renewal = input.type === 'EXISTING';
  const now = new Date();
  const result = renewal
    ? await options.policySource.latest({ gstin: client.gstin, clientName: client.name })
    : null;
  const snapshot = result ? snapshotOf(result, now) : null;
  const created = renewal
    ? snapshot
      ? `Renewal created for ${client.name}; last year’s policy ${snapshot.policyNumber} with ${snapshot.insurer} copied from ${snapshot.source}`
      : `Renewal created for ${client.name}; last year’s policy was not copied: ${result && result.status !== 'FOUND' ? result.message : ''}`
    : `Proposal created for ${client.name}`;
  // The proposal keeps this rate even if GST changes later (M-8).
  const gstRatePercent = await taxRatePercentOn(
    'GST',
    istDay(new Date()),
    options.defaultGstRatePercent,
  );
  return withTransaction(async (session) => {
    const [doc] = await ProposalModel.create(
      [
        {
          reference: await nextReference(session),
          type: input.type,
          stage: 'DRAFT',
          stageOverride: null,
          closedReason: null,
          clientId: client._id,
          ownerId,
          dueDate: input.dueDate,
          policyStart: input.policyStart,
          policyEnd: input.policyEnd,
          existingPolicy: snapshot,
          existingPolicyLookup: result ? lookupOf(result, now) : null,
          locations: [...new Set(input.locationIds)].map((locationId) => ({
            locationId: new Types.ObjectId(locationId),
            fire: [],
            hypothecation: null,
            openStock: null,
            risk: {},
          })),
          fireOption2: [],
          sections: sectionsFrom(snapshot),
          claims: [],
          notes: null,
          gstRatePercent: toDecimal128(gstRatePercent),
          insurers: [],
          activity: [{ at: now, actorId: userId, message: created }],
          createdBy: userId,
          updatedBy: userId,
        },
      ],
      { session },
    );
    if (!doc) throw new Error('Proposal was not created');
    const record = await recordOf(doc.toObject());
    await writeAudit(
      {
        userId: actor.id,
        action: AUDIT_ACTIONS.PROPOSAL_CREATED,
        entity: AUDIT_ENTITIES.PROPOSAL,
        entityId: record.id,
        before: null,
        after: toProposalAuditView(record),
        requestId: actor.requestId,
      },
      session,
    );
    return record;
  });
}

const lineEntries = (values: Partial<Record<string, string | null | undefined>>) =>
  Object.entries(values).flatMap(([key, value]) =>
    value === null || value === undefined ? [] : [{ key, value: toDecimal128(value) }],
  );

/**
 * A renewal's Existing column as typed (C-2), or null to follow the policy software's copy: when
 * nothing is typed, or when what is typed is the copy unchanged (the form starts from it).
 */
function existingFiguresOf(input: DataSheetInput, copy: ProposalRecord): ExistingFiguresDoc | null {
  const typed = input.existing;
  if (!typed || (typed.insurer === null && !hasExistingFigures(input))) return null;
  const lines = typed.fireLines.filter((line) => line.amount !== null);
  const sections = input.sections.flatMap((section) => {
    const values = lineEntries(section.existingLines);
    return section.existing === null && values.length === 0
      ? []
      : [{ code: section.code, sumInsured: money(section.existing), lines: values }];
  });
  const rupees = (value: string | null | undefined) => (value ? wholeRupees(value) : null);
  const unchanged =
    copy.existing?.source === 'POLICY_SOFTWARE' &&
    typed.insurer === copy.existing.insurer &&
    typed.policyNumber === copy.existing.policyNumber &&
    copy.fire.groups.every(
      (line) =>
        rupees(line.existing) ===
        (lines.find((typedLine) => typedLine.group === line.group)?.amount ?? null),
    ) &&
    (lines.length > 0 || rupees(copy.fire.existing) === typed.fireTotal) &&
    copy.sections.every((section) => {
      const entry = input.sections.find((item) => item.code === section.code);
      return (
        rupees(section.existing) === (entry?.existing ?? null) &&
        Object.values(entry?.existingLines ?? {}).every((value) => value === null)
      );
    });
  if (unchanged) return null;
  return {
    insurer: typed.insurer ?? '',
    policyNumber: typed.policyNumber,
    fireLines: lines.map((line) => ({
      group: line.group,
      amount: toDecimal128(line.amount ?? '0'),
    })),
    fireTotal: lines.length > 0 ? null : money(typed.fireTotal),
    sections,
  };
}

/**
 * The product and add-ons as they will be saved (C-1, C-4): a product from the master; one the
 * Fire sum insured does not suggest, with the reason; add-ons from the product's lists.
 */
async function checkProductAndAddons(input: DataSheetInput, preview: ProposalRecord) {
  const issues: { location: 'body'; path: string; message: string }[] = [];
  if (input.product.code !== null) {
    const products = await catalogItems('products');
    const product = products.find((item) => item.code === input.product.code);
    if (!product?.active) {
      issues.push({
        location: 'body',
        path: 'product.code',
        message: 'Choose an active product from the product master',
      });
    } else if (preview.product?.source === 'OVERRIDE' && !input.product.reason) {
      issues.push({
        location: 'body',
        path: 'product.reason',
        message: `Say why ${product.name} is chosen: a Fire sum insured of ${formatRupeesShort(wholeRupees(preview.fire.proposed1))} suggests ${preview.suggestedProducts.map((item) => item.code).join(' or ')}`,
      });
    }
  }
  if (input.addons.length > 0) {
    const master = await catalogItems('addons');
    const lists = new Set(preview.addonLists);
    const listed = new Set(
      master
        .filter((addon) => addon.active)
        .map((addon) => `${addon.list}|${addon.name.toLowerCase()}`),
    );
    const product = preview.product?.code ?? 'no product';
    for (const [index, addon] of input.addons.entries()) {
      if (!lists.has(addon.list)) {
        issues.push({
          location: 'body',
          path: `addons.${index}`,
          message: `${addon.name} is on the ${ADDON_LIST_LABELS[addon.list]} list, which ${product} does not use`,
        });
      } else if (!listed.has(`${addon.list}|${addon.name.toLowerCase()}`)) {
        issues.push({
          location: 'body',
          path: `addons.${index}`,
          message: `${addon.name} is not an active add-on of the ${ADDON_LIST_LABELS[addon.list]} list`,
        });
      }
    }
  }
  if (issues.length > 0) throw validationError(issues);
}

/** Replaces the Data Sheet. Not allowed once the RFQ has gone to an insurer. */
export async function updateDataSheet(
  id: string,
  input: DataSheetInput,
  actor: Actor,
): Promise<ProposalRecord> {
  const doc = await loadDoc(id);
  if (doc.stage === 'CLOSED') throw closed();
  if (doc.insurers.some((insurer) => hasRfq(insurer.status))) throw locked();
  await assertClientLocations(
    doc.clientId,
    input.locations.map((location) => location.locationId),
    'locations',
  );
  const before = await recordOf(doc);
  const renewal = doc.type === 'EXISTING';
  const set: Partial<ProposalDoc> = {
    dueDate: input.dueDate,
    policyStart: input.policyStart,
    policyEnd: input.policyEnd,
    locations: input.locations.map((location) => ({
      locationId: new Types.ObjectId(location.locationId),
      fire: location.fire
        .filter((item) => item.sqFt !== null || item.ratePerSqFt !== null || item.amount !== null)
        .map((item) => ({
          key: item.key,
          sqFt: money(item.sqFt),
          ratePerSqFt: money(item.ratePerSqFt),
          amount: money(item.amount),
        })),
      hypothecation: location.hypothecation,
      openStock: location.openStock,
      risk: location.risk,
    })),
    fireOption2: input.fireOption2
      .filter((line) => line.amount !== null)
      .map((line) => ({ group: line.group, amount: money(line.amount) })),
    fireCovers: input.fireCovers,
    product: input.product.code ? { code: input.product.code, reason: input.product.reason } : null,
    addons: input.addons,
    sections: input.sections.map((section) => {
      // D-5: an annexure's rows give the section its sum insured; FLOP's is its gross profit.
      const rows = isAnnexureSection(section.code) ? section.annexure : [];
      const sumLine = SUM_INSURED_LINE[section.code];
      const fromLines = sumLine ? (section.lines[sumLine] ?? null) : null;
      const proposed1 =
        rows.length > 0
          ? rows.reduce((total, row) => total.plus(row.sumInsured), new Decimal(0)).toFixed()
          : (fromLines ?? section.proposed1);
      return {
        code: section.code,
        included: section.included,
        proposed1: money(proposed1),
        proposed2: money(section.proposed2),
        lines: lineEntries(section.lines),
        lines2: lineEntries(section.lines2),
        basis: hasBasis(section.code) ? section.basis : null,
        covers: section.covers,
        annexure: rows.map((row) => ({
          description: row.description,
          quantity: row.quantity === null ? null : Number(row.quantity),
          dimensions: row.dimensions,
          makeModel: row.makeModel,
          serialNo: row.serialNo,
          year: row.year,
          sumInsured: toDecimal128(row.sumInsured),
        })),
      };
    }),
    claims: input.claims.map((claim) => ({
      period: claim.period,
      policyType: claim.policyType,
      sumInsured: money(claim.sumInsured),
      premium: money(claim.premium),
      claimedAmount: money(claim.claimedAmount),
      remarks: claim.remarks,
      insurer: claim.insurer,
    })),
    notes: input.notes,
  };
  // The Existing column of a renewal; new business has none.
  if (renewal) {
    const copy = await recordOf({ ...doc, ...set, existingFigures: null });
    set.existingFigures = existingFiguresOf(input, copy);
  }
  await checkProductAndAddons(input, await recordOf({ ...doc, ...set }));
  return saveWith(doc, set, 'Data Sheet saved', AUDIT_ACTIONS.PROPOSAL_UPDATED, actor, before);
}

/** Chooses the insurers (up to five). Insurers the RFQ was sent to stay on the list. */
export async function setInsurers(
  id: string,
  input: SetProposalInsurersRequest,
  actor: Actor,
): Promise<ProposalRecord> {
  const doc = await loadDoc(id);
  const wanted = new Set(input.insurerIds);
  const sentMissing = doc.insurers.filter(
    (insurer) => hasRfq(insurer.status) && !wanted.has(insurer.insurerId.toHexString()),
  );
  if (sentMissing.length > 0) {
    throw conflict(ERROR_CODES.CONFLICT, 'An insurer the RFQ was sent to cannot be taken off.');
  }
  const current = new Map(
    doc.insurers.map((insurer) => [insurer.insurerId.toHexString(), insurer]),
  );
  const added = input.insurerIds.filter((insurerId) => !current.has(insurerId));
  const found = await InsurerModel.find(
    { _id: { $in: added.map((insurerId) => new Types.ObjectId(insurerId)) } },
    { company: 1, branch: 1, active: 1 },
  ).lean();
  if (found.length !== added.length || found.some((insurer) => !insurer.active)) {
    throw validationError([
      {
        location: 'body',
        path: 'insurerIds',
        message: 'Choose active insurers from the insurer master',
      },
    ]);
  }
  const before = await recordOf(doc);
  return saveWith(
    doc,
    {
      insurers: input.insurerIds.map(
        (insurerId) =>
          current.get(insurerId) ?? {
            insurerId: new Types.ObjectId(insurerId),
            status: 'NOT_SENT' as const,
            sentAt: null,
            sentBy: null,
          },
      ),
    },
    added.length > 0
      ? `Insurers added: ${found.map((insurer) => `${insurer.company}, ${insurer.branch}`).join('; ')}`
      : 'Insurers changed',
    AUDIT_ACTIONS.PROPOSAL_UPDATED,
    actor,
    before,
  );
}

/** Records that the RFQ was emailed to these insurers. The Data Sheet must be complete. */
export async function markRfqSent(
  id: string,
  input: MarkRfqSentRequest,
  actor: Actor,
): Promise<ProposalRecord> {
  const doc = await loadDoc(id);
  const before = await recordOf(doc);
  if (before.missing.length > 0) {
    throw conflict(
      ERROR_CODES.DATA_SHEET_INCOMPLETE,
      'Finish the Data Sheet before sending the RFQ.',
      {
        missing: before.missing,
      },
    );
  }
  const chosen = new Set(input.insurerIds);
  const unknown = input.insurerIds.filter(
    (insurerId) => !doc.insurers.some((insurer) => insurer.insurerId.toHexString() === insurerId),
  );
  if (unknown.length > 0) {
    throw validationError([
      { location: 'body', path: 'insurerIds', message: 'Choose insurers already on the proposal' },
    ]);
  }
  const now = new Date();
  const dueDate = input.dueDate ?? doc.dueDate;
  const sentTo = before.insurers.filter(
    (insurer) => chosen.has(insurer.insurerId) && insurer.status === 'NOT_SENT',
  );
  return saveWith(
    doc,
    {
      insurers: doc.insurers.map((insurer) =>
        chosen.has(insurer.insurerId.toHexString()) && insurer.status === 'NOT_SENT'
          ? {
              ...insurer,
              status: 'SENT' as const,
              sentVia: 'OUTSIDE' as const,
              sentAt: now,
              sentBy: new Types.ObjectId(actor.id),
              dueDate,
            }
          : insurer,
      ),
    },
    sentTo.length > 0
      ? `RFQ sent outside the app to ${sentTo.map((insurer) => `${insurer.company}, ${insurer.branch} (${insurer.rfqEmails.join(', ')})`).join('; ')}, quotes due ${formatDate(dueDate)}`
      : null,
    AUDIT_ACTIONS.RFQ_SENT,
    actor,
    before,
  );
}

/** The proposal for an RFQ download, audited as an export. The Data Sheet must be complete. */
export async function proposalForRfq(
  id: string,
  actor: Actor,
  format: 'xlsx' | 'pdf' = 'xlsx',
): Promise<ProposalRecord> {
  const record = await getProposal(id);
  if (record.missing.length > 0) {
    throw conflict(ERROR_CODES.DATA_SHEET_INCOMPLETE, 'Finish the Data Sheet before the RFQ.', {
      missing: record.missing,
    });
  }
  await writeAudit({
    userId: actor.id,
    action: AUDIT_ACTIONS.RFQ_DOWNLOADED,
    entity: AUDIT_ENTITIES.PROPOSAL,
    entityId: record.id,
    after: { reference: record.reference, fireProposed1: record.fire.proposed1, format },
    requestId: actor.requestId,
  });
  return record;
}

/**
 * Fetches last year's policy again for a renewal (for example after the policy software was
 * down). The Existing column is replaced; sections are filled from it only if none were yet.
 */
export async function refreshExistingPolicy(
  id: string,
  actor: Actor,
  source: ExistingPolicySource,
): Promise<ProposalRecord> {
  const doc = await loadDoc(id);
  if (doc.type !== 'EXISTING') {
    throw conflict(ERROR_CODES.CONFLICT, 'Only a renewal has an existing policy.');
  }
  if (doc.stage === 'CLOSED') throw closed();
  if (doc.insurers.some((insurer) => hasRfq(insurer.status))) throw locked();
  const client = await ClientModel.findById(doc.clientId, { name: 1, gstin: 1 }).lean();
  if (!client) throw notFound('The proposal’s client no longer exists');
  const result = await source.latest({ gstin: client.gstin, clientName: client.name });
  const now = new Date();
  const snapshot = snapshotOf(result, now);
  const before = await recordOf(doc);
  return saveWith(
    doc,
    {
      existingPolicy: snapshot ?? doc.existingPolicy ?? null,
      existingPolicyLookup: lookupOf(result, now),
      // The copy just fetched replaces what was typed in the Existing column.
      ...(snapshot ? { existingFigures: null } : {}),
      ...(snapshot && doc.sections.length === 0 ? { sections: sectionsFrom(snapshot) } : {}),
    },
    snapshot
      ? `Last year’s policy ${snapshot.policyNumber} with ${snapshot.insurer} copied from ${snapshot.source}`
      : `Last year’s policy was not copied: ${result.status === 'FOUND' ? '' : result.message}`,
    AUDIT_ACTIONS.PROPOSAL_UPDATED,
    actor,
    before,
  );
}

/**
 * Moves a case to its next stage (Quotes Received onwards, one at a time), or closes it with the
 * reason. Draft, Data Sheet and RFQ Sent follow from the work itself.
 */
export async function moveStage(
  id: string,
  input: MoveProposalStageRequest,
  actor: Actor,
): Promise<ProposalRecord> {
  const doc = await loadDoc(id);
  const before = await recordOf(doc);
  if (input.stage === 'CLOSED') {
    if (before.stage === 'PLACED' || before.stage === 'CLOSED') {
      throw conflict(
        ERROR_CODES.CONFLICT,
        `A case that is ${PROPOSAL_STAGE_LABELS[before.stage]} cannot be closed.`,
      );
    }
  } else if (input.stage !== before.nextStage) {
    throw conflict(
      ERROR_CODES.CONFLICT,
      before.nextStage
        ? `The next stage is ${PROPOSAL_STAGE_LABELS[before.nextStage]}.`
        : `The stage follows the Data Sheet and the RFQ until the RFQ is sent.`,
    );
  }
  return saveWith(
    doc,
    {
      stageOverride: input.stage,
      closedReason: input.stage === 'CLOSED' ? input.reason : null,
    },
    input.stage === 'CLOSED'
      ? `Case closed: ${input.reason ?? ''}`
      : `Moved to ${PROPOSAL_STAGE_LABELS[input.stage]}${input.reason ? `: ${input.reason}` : ''}`,
    AUDIT_ACTIONS.PROPOSAL_STAGE_CHANGED,
    actor,
    before,
  );
}
