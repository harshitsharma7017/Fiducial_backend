import {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  ERROR_CODES,
  icdChapterOf,
  maskAccount,
  UNCLASSIFIED_CHAPTER,
  type TpaClaimRecord,
  type TpaClaimStatus,
} from '../../shared/index.ts';
import { Types } from 'mongoose';
import { withTransaction } from '../../lib/db.ts';
import { Decimal } from '../../lib/decimal.ts';
import { conflict, notFound, validationError } from '../../lib/errors.ts';
import { escapeRegExp } from '../../lib/text.ts';
import { writeAudit } from '../audit/audit.service.ts';
import { ClaimModel } from '../claims/claim.model.ts';
import { GhiMemberModel } from '../ghi/ghi-census.model.ts';
import type { Actor } from '../ghi/ghi-common.ts';
import { loadInsuredPolicy } from '../insured-policies/insured-policies.service.ts';
import { TpaClaimEventModel, TpaClaimModel, type TpaClaimDoc } from './tpa.model.ts';

/** What a user may see of claim data (N12), decided on the server from their permissions. */
export interface ClaimAccess {
  /** Diagnosis, ICD code and rejection reason (claims.process). */
  diagnosis: boolean;
  /** Full bank account numbers (claims.admin). */
  bank: boolean;
}

// TPA claim records (N9): the list of a policy's imported claims and staff's manual links. A
// manual link (to a main claim or a board claim) and the review note are never changed by an
// import. Diagnosis details are returned only to users who process claims (claims.process).

const amount = (value: Types.Decimal128 | null) =>
  value === null ? null : new Decimal(value.toString()).toFixed(2);

export async function claimRecords(
  docs: readonly TpaClaimDoc[],
  access: ClaimAccess,
): Promise<TpaClaimRecord[]> {
  const memberIds = docs.flatMap((doc) => (doc.member.memberId ? [doc.member.memberId] : []));
  const boardIds = docs.flatMap((doc) => (doc.board.claimId ? [doc.board.claimId] : []));
  const [members, boards] = await Promise.all([
    GhiMemberModel.find(
      { _id: { $in: memberIds } },
      { relationship: 1, gender: 1, dateOfBirth: 1, employeeId: 1, name: 1 },
    ).lean(),
    ClaimModel.find({ _id: { $in: boardIds } }, { claimNumber: 1 }).lean(),
  ]);
  const memberById = new Map(members.map((member) => [member._id.toHexString(), member]));
  const boardById = new Map(boards.map((board) => [board._id.toHexString(), board.claimNumber]));
  return docs.map((doc) => {
    const member = doc.member.memberId
      ? memberById.get(doc.member.memberId.toHexString())
      : undefined;
    return {
      id: doc._id.toHexString(),
      caseId: doc.caseId.toHexString(),
      product: doc.product,
      tpaCode: doc.tpaCode,
      tpaClaimId: doc.tpaClaimId,
      requestType: doc.requestType,
      parentClaimId: doc.parentClaimId,
      parent: { state: doc.parent.state, id: doc.parent.id?.toHexString() ?? null },
      // The census member's own details when matched (the insured relationship, not a guess).
      member: {
        match: doc.member.match,
        memberId: doc.member.memberId?.toHexString() ?? null,
        employeeId: member?.employeeId ?? doc.employeeId,
        name: member?.name ?? doc.memberName,
        relationship: member?.relationship ?? doc.relationship,
        gender: member?.gender ?? doc.gender,
        dateOfBirth: member?.dateOfBirth ?? doc.dateOfBirth,
      },
      board: {
        state: doc.board.state,
        claimId: doc.board.claimId?.toHexString() ?? null,
        claimNumber: doc.board.claimId
          ? (boardById.get(doc.board.claimId.toHexString()) ?? null)
          : null,
      },
      admissionDate: doc.admissionDate,
      dischargeDate: doc.dischargeDate,
      claimType: doc.claimType,
      hospital: doc.hospital,
      claimedAmount: amount(doc.claimedAmount),
      sanctionedAmount: amount(doc.sanctionedAmount),
      settledAmount: amount(doc.settledAmount),
      disallowedAmount: amount(doc.disallowedAmount),
      status: doc.status,
      sourceStatus: doc.sourceStatus,
      icdChapter: icdChapterOf(doc.icdCode)?.key ?? UNCLASSIFIED_CHAPTER.key,
      diagnosis: access.diagnosis ? doc.diagnosis : null,
      icdCode: access.diagnosis ? doc.icdCode : null,
      rejectionReason: access.diagnosis ? doc.rejectionReason : null,
      bankAccount: access.bank ? (doc.bankAccount ?? null) : maskAccount(doc.bankAccount),
      boardNote: doc.boardNote ?? null,
      reviewNote: doc.reviewNote,
      lastImportId: doc.lastImportId.toHexString(),
      importedAt: doc.importedAt.toISOString(),
      updatedAt: doc.updatedAt.toISOString(),
    };
  });
}

export async function listTpaClaims(
  query: {
    caseId: string;
    status?: TpaClaimStatus;
    q?: string;
    review?: boolean;
    page: number;
    limit: number;
  },
  access: ClaimAccess,
) {
  const { doc } = await loadInsuredPolicy(query.caseId);
  const filter: Record<string, unknown> = { caseId: doc._id };
  if (query.status) filter.status = query.status;
  if (query.review) {
    filter.$or = [
      { 'member.match': { $ne: 'MATCHED' } },
      { 'parent.state': 'NOT_FOUND' },
      { 'board.state': 'AMBIGUOUS' },
    ];
  }
  if (query.q) {
    const pattern = new RegExp(escapeRegExp(query.q), 'i');
    filter.$and = [
      { $or: [{ tpaClaimId: pattern }, { employeeId: pattern }, { memberName: pattern }] },
    ];
  }
  const [total, docs] = await Promise.all([
    TpaClaimModel.countDocuments(filter),
    TpaClaimModel.find(filter)
      .sort({ admissionDate: -1, _id: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean<TpaClaimDoc[]>(),
  ]);
  return {
    items: await claimRecords(docs, access),
    total,
    page: query.page,
    limit: query.limit,
  };
}

async function loadTpaClaim(id: string): Promise<TpaClaimDoc> {
  const doc = Types.ObjectId.isValid(id)
    ? await TpaClaimModel.findById(id).lean<TpaClaimDoc>()
    : null;
  if (!doc) throw notFound('TPA claim not found');
  return doc;
}

export async function getTpaClaim(id: string, access: ClaimAccess): Promise<TpaClaimRecord> {
  return (await claimRecords([await loadTpaClaim(id)], access))[0]!;
}

export async function tpaClaimHistory(id: string) {
  const doc = await loadTpaClaim(id);
  const events = await TpaClaimEventModel.find({ claimId: doc._id }).sort({ at: 1 }).lean();
  return {
    // For the view's audit entry (not sent): the policy and the TPA's claim ID.
    caseId: doc.caseId.toHexString(),
    tpaClaimId: doc.tpaClaimId,
    items: events.map((event) => ({
      type: event.type,
      at: event.at.toISOString(),
      importId: event.importId?.toHexString() ?? null,
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      changes: event.changes,
    })),
  };
}

/**
 * Links a record by hand (N9 4): to its main claim (same policy and TPA, not itself) or to a
 * board claim of the same policy, or clears a manual link; sets the review note.
 */
export async function linkTpaClaim(
  id: string,
  input: { parentId?: string | null; boardClaimId?: string | null; reviewNote?: string | null },
  actor: Actor,
): Promise<void> {
  const doc = await loadTpaClaim(id);
  const set: Record<string, unknown> = {};
  const changes: Array<{ field: string; before: string | null; after: string | null }> = [];
  if (input.parentId !== undefined) {
    if (input.parentId === null)
      set.parent = { state: doc.parentClaimId ? 'NOT_FOUND' : 'NONE', id: null };
    else {
      const parent = await TpaClaimModel.findOne({
        _id: input.parentId,
        caseId: doc.caseId,
        tpaCode: doc.tpaCode,
      }).lean();
      if (!parent || parent._id.equals(doc._id)) {
        throw validationError([
          {
            location: 'body',
            path: 'parentId',
            message: 'Choose another claim of the same policy and TPA',
          },
        ]);
      }
      set.parent = { state: 'MANUAL', id: parent._id };
    }
    changes.push({
      field: 'parent',
      before: doc.parent.id?.toHexString() ?? null,
      after: input.parentId,
    });
  }
  if (input.boardClaimId !== undefined) {
    if (input.boardClaimId === null) set.board = { state: 'NONE', claimId: null };
    else {
      const board = await ClaimModel.findOne(
        { _id: input.boardClaimId, ghiCaseId: doc.caseId },
        { _id: 1 },
      ).lean();
      if (!board)
        throw validationError([
          {
            location: 'body',
            path: 'boardClaimId',
            message: 'Choose a board claim of the same policy',
          },
        ]);
      set.board = { state: 'MANUAL', claimId: board._id };
    }
    changes.push({
      field: 'board',
      before: doc.board.claimId?.toHexString() ?? null,
      after: input.boardClaimId,
    });
  }
  if (input.reviewNote !== undefined) {
    set.reviewNote = input.reviewNote;
    changes.push({ field: 'reviewNote', before: doc.reviewNote, after: input.reviewNote });
  }
  if (changes.length === 0) throw conflict(ERROR_CODES.CONFLICT, 'Nothing to change.');
  await withTransaction(async (session) => {
    await TpaClaimModel.updateOne({ _id: doc._id }, { $set: set }, { session });
    await TpaClaimEventModel.create(
      [
        {
          claimId: doc._id,
          type: input.reviewNote !== undefined && changes.length === 1 ? 'NOTE' : 'LINKED',
          at: new Date(),
          actorId: new Types.ObjectId(actor.id),
          importId: null,
          changes,
          fromStatus: null,
          toStatus: null,
        },
      ],
      { session },
    );
    await writeAudit(
      {
        userId: actor.id,
        action: AUDIT_ACTIONS.TPA_CLAIM_LINKED,
        entity: AUDIT_ENTITIES.INSURED_POLICY,
        entityId: doc.caseId.toHexString(),
        before: { claim: doc.tpaClaimId, parent: doc.parent.state, board: doc.board.state },
        after: { claim: doc.tpaClaimId, changes: changes.map((change) => change.field) },
        requestId: actor.requestId,
      },
      session,
    );
  });
}
