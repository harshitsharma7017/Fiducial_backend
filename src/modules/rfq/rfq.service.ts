import {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  ERROR_CODES,
  RFQ_VERSION_STATUS_LABELS,
  type AuditAction,
  type ProposalRecord,
  type RfqEdits,
  type RfqState,
  type RfqVersion,
  type RfqVersionStatus,
  type RfqVersionSummary,
} from '../../shared/index.ts';
import { Types } from 'mongoose';
import { withTransaction } from '../../lib/db.ts';
import { conflict, notFound } from '../../lib/errors.ts';
import { writeAudit } from '../audit/audit.service.ts';
import { ProposalModel } from '../proposals/proposal.model.ts';
import { closed, loadDoc, recordOf, type Actor } from '../proposals/proposals.service.ts';
import { rfqFileFor } from '../proposals/rfq-document.ts';
import { UserModel } from '../users/user.model.ts';
import { bufferOf, rfqEditsOf, rfqFingerprint, rfqStanding } from './rfq-approval.ts';
import {
  RfqStateModel,
  RfqVersionModel,
  type RfqEventDoc,
  type RfqVersionDoc,
} from './rfq.model.ts';

// The RFQ's preview, edits, versions and approval (R-1, R-2, R-5). Each generation is a new
// version (v1, v2, v3) keeping the case as it was and both files; only the latest version moves
// through submit, approve or return, and only an approved, still current version is sent.

async function userNames(ids: readonly (Types.ObjectId | null | undefined)[]) {
  const wanted = [...new Set(ids.flatMap((id) => (id ? [id.toHexString()] : [])))];
  const users = await UserModel.find({ _id: { $in: wanted } }, { name: 1 }).lean();
  return new Map(users.map((user) => [user._id.toHexString(), user.name]));
}

type VersionHead = Omit<RfqVersionDoc, 'xlsx' | 'pdf' | 'record' | 'edits'>;

function toSummary(doc: VersionHead, users: ReadonlyMap<string, string>): RfqVersionSummary {
  const name = (id: Types.ObjectId) => users.get(id.toHexString()) ?? 'Unknown user';
  return {
    version: doc.version,
    status: doc.status,
    layout: doc.layout,
    fileName: doc.fileName,
    createdAt: doc.createdAt.toISOString(),
    createdBy: name(doc.createdBy),
    events: doc.events.map((event) => ({
      action: event.action,
      at: event.at.toISOString(),
      by: name(event.by),
      comment: event.comment,
    })),
  };
}

function openCase(record: ProposalRecord) {
  if (record.stage === 'CLOSED') throw closed();
}

/** The RFQ of a case: its edits, versions (newest first) and whether it may be sent. */
export async function rfqState(id: string): Promise<RfqState> {
  const record = await recordOf(await loadDoc(id));
  const proposalId = new Types.ObjectId(id);
  const [state, versions] = await Promise.all([
    RfqStateModel.findOne({ proposalId }).lean(),
    RfqVersionModel.find({ proposalId }, { xlsx: 0, pdf: 0, record: 0, edits: 0 })
      .sort({ version: -1 })
      .lean<VersionHead[]>(),
  ]);
  const edits = state?.edits ?? (await rfqEditsOf(id));
  const standing = await rfqStanding(record, edits);
  const users = await userNames([
    state?.updatedBy,
    ...versions.flatMap((version) => [
      version.createdBy,
      ...version.events.map((event) => event.by),
    ]),
  ]);
  const latest = versions[0];
  return {
    edits,
    editsUpdatedAt: state?.updatedAt.toISOString() ?? null,
    editsUpdatedBy: state?.updatedBy ? (users.get(state.updatedBy.toHexString()) ?? null) : null,
    versions: versions.map((version) => toSummary(version, users)),
    current: latest
      ? { version: latest.version, status: latest.status, stale: standing.stale }
      : null,
    sendable: standing.blocked === null,
    blocked: standing.blocked,
  };
}

/** Saves the edits made on the RFQ (R-2). They show in the next version generated. */
export async function saveRfqEdits(id: string, edits: RfqEdits, actor: Actor): Promise<RfqState> {
  const record = await recordOf(await loadDoc(id));
  openCase(record);
  const proposalId = new Types.ObjectId(id);
  await withTransaction(async (session) => {
    const before = await RfqStateModel.findOne({ proposalId }).session(session).lean();
    await RfqStateModel.updateOne(
      { proposalId },
      { $set: { edits, updatedBy: new Types.ObjectId(actor.id) } },
      { upsert: true, session },
    );
    await writeAudit(
      {
        userId: actor.id,
        action: AUDIT_ACTIONS.RFQ_EDITED,
        entity: AUDIT_ENTITIES.PROPOSAL,
        entityId: id,
        before: before ? { ...before.edits } : null,
        after: { ...edits },
        requestId: actor.requestId,
      },
      session,
    );
  });
  return rfqState(id);
}

/**
 * Generates the next version from the case and the edits (R-1): the Data Sheet complete, both
 * files made now and kept with the case as it is.
 */
export async function generateRfq(
  id: string,
  actor: Actor,
  defaultGstRatePercent: string,
): Promise<RfqState> {
  const record = await recordOf(await loadDoc(id));
  openCase(record);
  if (record.missing.length > 0) {
    throw conflict(
      ERROR_CODES.DATA_SHEET_INCOMPLETE,
      'Finish the Data Sheet before generating the RFQ.',
      {
        missing: record.missing,
      },
    );
  }
  const edits = await rfqEditsOf(id);
  const [xlsx, pdf] = await Promise.all([
    rfqFileFor(record, 'xlsx', defaultGstRatePercent, edits),
    rfqFileFor(record, 'pdf', defaultGstRatePercent, edits),
  ]);
  const proposalId = new Types.ObjectId(id);
  const actorId = new Types.ObjectId(actor.id);
  try {
    await withTransaction(async (session) => {
      const last = await RfqVersionModel.findOne({ proposalId }, { version: 1 })
        .sort({ version: -1 })
        .session(session)
        .lean();
      const version = (last?.version ?? 0) + 1;
      const at = new Date();
      await RfqVersionModel.create(
        [
          {
            proposalId,
            version,
            status: 'DRAFT',
            layout: xlsx.layout,
            record: JSON.parse(JSON.stringify(record)) as Record<string, unknown>,
            edits,
            fingerprint: rfqFingerprint(record, edits),
            fileName: `RFQ-${record.reference}-v${version}`,
            xlsx: xlsx.data,
            pdf: pdf.data,
            events: [{ action: 'GENERATED', at, by: actorId, comment: null }],
            createdBy: actorId,
          },
        ],
        { session },
      );
      await ProposalModel.updateOne(
        { _id: proposalId },
        { $push: { activity: { at, actorId, message: `RFQ v${version} generated` } } },
        { session },
      );
      await writeAudit(
        {
          userId: actor.id,
          action: AUDIT_ACTIONS.RFQ_GENERATED,
          entity: AUDIT_ENTITIES.PROPOSAL,
          entityId: id,
          before: null,
          after: { version, layout: xlsx.layout, fireProposed1: record.fire.proposed1 },
          requestId: actor.requestId,
        },
        session,
      );
    });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      throw conflict(
        ERROR_CODES.CONFLICT,
        'Another version was generated meanwhile. Reload and try again.',
      );
    }
    throw error;
  }
  return rfqState(id);
}

async function versionDoc(id: string, version: number) {
  const doc = await RfqVersionModel.findOne({ proposalId: new Types.ObjectId(id), version }).lean();
  if (!doc) throw notFound(`RFQ v${version} not found`);
  return doc;
}

/** A version as generated: the case and edits for its preview, and its history. */
export async function getRfqVersion(id: string, version: number): Promise<RfqVersion> {
  const doc = await versionDoc(id, version);
  const users = await userNames([doc.createdBy, ...doc.events.map((event) => event.by)]);
  return {
    ...toSummary(doc, users),
    record: doc.record as unknown as ProposalRecord,
    edits: doc.edits,
  };
}

/** A version's file, as generated; audited as an export. */
export async function rfqVersionFile(
  id: string,
  version: number,
  format: 'xlsx' | 'pdf',
  actor: Actor,
): Promise<{ fileName: string; contentType: string; data: Buffer }> {
  const doc = await versionDoc(id, version);
  await writeAudit({
    userId: actor.id,
    action: AUDIT_ACTIONS.RFQ_DOWNLOADED,
    entity: AUDIT_ENTITIES.PROPOSAL,
    entityId: id,
    after: { version, format },
    requestId: actor.requestId,
  });
  return format === 'pdf'
    ? { fileName: `${doc.fileName}.pdf`, contentType: 'application/pdf', data: bufferOf(doc.pdf) }
    : {
        fileName: `${doc.fileName}.xlsx`,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        data: bufferOf(doc.xlsx),
      };
}

const STEPS = {
  SUBMITTED: {
    from: ['DRAFT'],
    audit: AUDIT_ACTIONS.RFQ_SUBMITTED,
    verb: 'submitted for approval',
  },
  APPROVED: { from: ['SUBMITTED'], audit: AUDIT_ACTIONS.RFQ_APPROVED, verb: 'approved' },
  RETURNED: { from: ['SUBMITTED'], audit: AUDIT_ACTIONS.RFQ_RETURNED, verb: 'returned' },
} as const satisfies Record<
  string,
  { from: readonly RfqVersionStatus[]; audit: AuditAction; verb: string }
>;

/**
 * Moves the latest version on (R-5): submit a draft; approve or return a submitted one (a return
 * says why). An older version, or one the case has changed since, moves no further.
 */
export async function moveRfq(
  id: string,
  version: number,
  to: keyof typeof STEPS,
  comment: string | null,
  actor: Actor,
): Promise<RfqState> {
  const record = await recordOf(await loadDoc(id));
  openCase(record);
  const doc = await versionDoc(id, version);
  const standing = await rfqStanding(record);
  if (standing.latest?.version !== version) {
    throw conflict(ERROR_CODES.CONFLICT, `RFQ v${version} is not the latest version.`);
  }
  if (standing.stale && to !== 'RETURNED') {
    throw conflict(
      ERROR_CODES.CONFLICT,
      `The case or the RFQ changed since v${version} was generated. Generate a new version first.`,
    );
  }
  const step = STEPS[to];
  if (!(step.from as readonly RfqVersionStatus[]).includes(doc.status)) {
    throw conflict(
      ERROR_CODES.CONFLICT,
      `RFQ v${version} is ${RFQ_VERSION_STATUS_LABELS[doc.status].toLowerCase()}; it cannot be ${step.verb}.`,
    );
  }
  const at = new Date();
  const actorId = new Types.ObjectId(actor.id);
  const event: RfqEventDoc = { action: to, at, by: actorId, comment };
  await withTransaction(async (session) => {
    const updated = await RfqVersionModel.updateOne(
      { _id: doc._id, status: doc.status },
      { $set: { status: to }, $push: { events: event } },
      { session },
    );
    if (updated.modifiedCount !== 1) {
      throw conflict(
        ERROR_CODES.CONFLICT,
        `RFQ v${version} changed meanwhile. Reload and try again.`,
      );
    }
    await ProposalModel.updateOne(
      { _id: doc.proposalId },
      {
        $push: {
          activity: {
            at,
            actorId,
            message: `RFQ v${version} ${step.verb}${comment ? `: ${comment}` : ''}`,
          },
        },
      },
      { session },
    );
    await writeAudit(
      {
        userId: actor.id,
        action: step.audit,
        entity: AUDIT_ENTITIES.PROPOSAL,
        entityId: id,
        before: { version, status: doc.status },
        after: { version, status: to, comment },
        requestId: actor.requestId,
      },
      session,
    );
  });
  return rfqState(id);
}
