import {
  AUDIT_ACTIONS,
  CLAIM_STATUSES,
  CLAIM_STATUS_LABELS,
  CLAIM_TYPE_LABELS,
  ERROR_CODES,
  MAX_CLAIM_DOCUMENTS,
  ROLES,
  can,
  canMoveClaim,
  type ClaimBoard,
  type ClaimDetail,
  type ClaimDocument,
  type ClaimDocumentKind,
  type ClaimHrContact,
  type ClaimListQuery,
  type ClaimListResponse,
  type ClaimMember,
  type ClaimPolicy,
  type CreateClaimRequest,
  type SetClaimHrContactRequest,
  type TransitionClaimRequest,
  type TransitionClaimResponse,
  type UpdateClaimRequest,
} from '../../shared/index.ts';
import { createHash } from 'node:crypto';
import { Types, type QueryFilter, type mongo } from 'mongoose';
import { withTransaction } from '../../lib/db.ts';
import { toDecimal128 } from '../../lib/decimal.ts';
import { conflict, forbidden, notFound, validationError } from '../../lib/errors.ts';
import { escapeRegExp } from '../../lib/text.ts';
import type { Logger } from '../../lib/logger.ts';
import { ClientModel } from '../clients/client.model.ts';
import { GhiCaseModel } from '../ghi/ghi-case.model.ts';
import { GhiMemberModel } from '../ghi/ghi-census.model.ts';
import { InsurerModel } from '../insurers/insurer.model.ts';
import type { MailTransport } from '../mail/transport.ts';
import { sniff } from '../quotes/quotes.service.ts';
import { CounterModel } from '../proposals/proposal.model.ts';
import { UserModel } from '../users/user.model.ts';
import {
  amountText,
  assertEligible,
  auditClaim,
  documentLabel,
  familyOrder,
  loadClaim,
  mayEdit,
  mayMove,
  missingDocuments,
  placedPolicy,
  toCards,
  toDocument,
  toEvent,
  toNotification,
  toRecord,
  userNames,
  type ClaimActor,
  type EligibleClaim,
} from './claim-common.ts';
import {
  ClaimEventModel,
  ClaimFileModel,
  ClaimModel,
  ClaimNotificationModel,
  type ClaimDoc,
} from './claim.model.ts';
import { dispatchClaim, enqueueStatusEmails } from './claim-notifications.ts';
import { ClaimHrContactModel } from './claim-settings.model.ts';

/** Staff a claim can be assigned to: active users who may process claims. */
const PROCESSOR_ROLES = ROLES.filter((role) => can([role], 'claims.process'));

function istYear(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric' }).format(
    now,
  );
}

/** CLM-2026-0001: a yearly series of its own. */
export async function nextClaimNumber(session: mongo.ClientSession): Promise<string> {
  const year = istYear(new Date());
  const counter = await CounterModel.findOneAndUpdate(
    { _id: `claim-${year}` },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after', session },
  ).lean();
  return `CLM-${year}-${String(counter?.seq ?? 1).padStart(4, '0')}`;
}

async function assertAssignee(userId: string, path = 'assignedTo'): Promise<Types.ObjectId> {
  const id = new Types.ObjectId(userId);
  const ok = await UserModel.exists({ _id: id, active: true, roles: { $in: PROCESSOR_ROLES } });
  if (!ok) {
    throw validationError([
      { location: 'body', path, message: 'Choose active staff who process claims' },
    ]);
  }
  return id;
}

/** The claim document of an eligible claim, shared by staff and employee creation. */
export function newClaimDoc(
  eligible: EligibleClaim,
  details: Omit<UpdateClaimRequest, never>,
  extra: Pick<ClaimDoc, 'claimNumber' | 'source' | 'linkId' | 'assignedTo' | 'createdBy'>,
  now: Date,
) {
  const { ghiCase, employee, patient } = eligible;
  return {
    ...extra,
    status: 'FORM' as const,
    statusChangedAt: now,
    clientId: ghiCase.clientId,
    ghiCaseId: ghiCase._id,
    policy: {
      policyNumber: ghiCase.policy.policyNumber,
      insurerId: ghiCase.policy.insurerId,
      policyStart: ghiCase.policy.policyStart,
      policyEnd: ghiCase.policy.policyEnd,
    },
    employee: { memberId: employee._id, employeeId: employee.employeeId, name: employee.name },
    patient: {
      memberId: patient._id,
      name: patient.name,
      relationship: patient.relationship,
      gender: patient.gender,
      dateOfBirth: patient.dateOfBirth,
    },
    hospital: details.hospital,
    admissionDate: details.admissionDate,
    dischargeDate: details.dischargeDate,
    claimType: details.claimType,
    amountClaimed: toDecimal128(details.amountClaimed),
    contactEmail: details.contactEmail.toLowerCase(),
    contactPhone: details.contactPhone,
    updatedBy: extra.createdBy,
  };
}

/** What the audit log keeps of a claim: no names, dates of birth or medical detail. */
export function claimAuditView(
  claim: Pick<
    ClaimDoc,
    | 'claimNumber'
    | 'status'
    | 'claimType'
    | 'amountClaimed'
    | 'hospital'
    | 'admissionDate'
    | 'dischargeDate'
  >,
) {
  return {
    claimNumber: claim.claimNumber,
    status: claim.status,
    claimType: claim.claimType,
    amountClaimed: amountText(claim.amountClaimed),
    hospital: claim.hospital.name,
    admissionDate: claim.admissionDate,
    dischargeDate: claim.dischargeDate,
  };
}

export async function getClaim(id: string, actor: ClaimActor): Promise<ClaimDetail> {
  const claim = await loadClaim(id);
  const [record, events, notifications] = await Promise.all([
    toRecord(claim, actor),
    ClaimEventModel.find({ claimId: claim._id }).sort({ at: 1, _id: 1 }).lean(),
    ClaimNotificationModel.find({ claimId: claim._id }).sort({ createdAt: 1, _id: 1 }).lean(),
  ]);
  const names = await userNames(events.map((event) => event.actorId));
  return {
    ...record,
    timeline: events.map((event) => toEvent(event, names)),
    notifications: notifications.map(toNotification),
  };
}

/** Staff create a claim (C2); it starts in Form, assigned to its creator unless they choose. */
export async function createClaim(
  input: CreateClaimRequest,
  actor: ClaimActor,
): Promise<ClaimDetail> {
  const eligible = await assertEligible({ ...input, clientId: input.clientId });
  const actorId = new Types.ObjectId(actor.id ?? undefined);
  const assignedTo = input.assignedTo ? await assertAssignee(input.assignedTo) : actorId;
  const now = new Date();
  const id = await withTransaction(async (session) => {
    const [claim] = await ClaimModel.create(
      [
        newClaimDoc(
          eligible,
          input,
          {
            claimNumber: await nextClaimNumber(session),
            source: 'STAFF',
            linkId: null,
            assignedTo,
            createdBy: actorId,
          },
          now,
        ),
      ],
      { session },
    );
    if (!claim) throw new Error('Claim was not saved');
    await ClaimEventModel.create(
      [
        {
          claimId: claim._id,
          type: 'CREATED',
          at: now,
          actorKind: 'STAFF',
          actorId,
          fromStatus: null,
          toStatus: 'FORM',
          remark: null,
          changes: [],
          email: null,
          detail: null,
        },
      ],
      { session },
    );
    await auditClaim(
      actor,
      AUDIT_ACTIONS.CLAIM_CREATED,
      claim._id.toHexString(),
      null,
      claimAuditView(claim),
      session,
    );
    return claim._id.toHexString();
  });
  return getClaim(id, actor);
}

function filterOf(query: Partial<ClaimListQuery>): QueryFilter<ClaimDoc> {
  const filter: QueryFilter<ClaimDoc> = {};
  if (query.clientId) filter.clientId = new Types.ObjectId(query.clientId);
  if (query.status) filter.status = query.status;
  if (query.q) {
    const pattern = new RegExp(escapeRegExp(query.q.trim()), 'i');
    filter.$or = [
      { claimNumber: pattern },
      { 'employee.name': pattern },
      { 'employee.employeeId': pattern },
      { 'patient.name': pattern },
      { 'hospital.name': pattern },
    ];
  }
  if (query.from || query.to) {
    if (query.dateField === 'ADMISSION') {
      filter.admissionDate = {
        ...(query.from ? { $gte: query.from } : {}),
        ...(query.to ? { $lte: query.to } : {}),
      };
    } else {
      // Created dates are compared as India days.
      const start = query.from ? new Date(`${query.from}T00:00:00+05:30`) : null;
      const end = query.to
        ? new Date(new Date(`${query.to}T00:00:00+05:30`).getTime() + 86_400_000)
        : null;
      filter.createdAt = { ...(start ? { $gte: start } : {}), ...(end ? { $lt: end } : {}) };
    }
  }
  return filter;
}

/** The table view (C1): searchable, filtered by company, status and date, newest first, paged. */
export async function listClaims(
  query: ClaimListQuery,
  actor: ClaimActor,
): Promise<ClaimListResponse> {
  const filter = filterOf(query);
  const [total, docs] = await Promise.all([
    ClaimModel.countDocuments(filter),
    ClaimModel.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean(),
  ]);
  return { items: await toCards(docs, actor), total, page: query.page, limit: query.limit };
}

export const BOARD_COLUMN_LIMIT = 100;

/** The board (C1): one column per status, longest waiting first. */
export async function claimBoard(
  query: Pick<ClaimListQuery, 'q' | 'clientId'>,
  actor: ClaimActor,
): Promise<ClaimBoard> {
  const base = filterOf(query);
  const columns = await Promise.all(
    CLAIM_STATUSES.map(async (status) => {
      const filter = { ...base, status };
      const [total, docs] = await Promise.all([
        ClaimModel.countDocuments(filter),
        ClaimModel.find(filter)
          .sort({ statusChangedAt: 1, _id: 1 })
          .limit(BOARD_COLUMN_LIMIT)
          .lean(),
      ]);
      return { status, total, items: await toCards(docs, actor) };
    }),
  );
  return { columns };
}

/**
 * Moves a claim (C1, C3). Checks who may move it and that the move is allowed, then saves the new
 * status, the remark, the status-change event and the emails it owes in one transaction. The
 * emails are sent after the commit: a failure is recorded and retried, never undoing the move.
 */
export async function transitionClaim(
  id: string,
  input: TransitionClaimRequest,
  actor: ClaimActor,
  deps: { transport: MailTransport; logger?: Logger },
): Promise<TransitionClaimResponse> {
  const claim = await loadClaim(id);
  if (!mayMove(actor, claim)) {
    throw forbidden('Only the staff member the claim is assigned to, or an Admin, can move it.');
  }
  if (claim.status !== input.expectedStatus) {
    throw conflict(
      ERROR_CODES.CLAIM_STATUS_CHANGED,
      `Someone moved this claim to ${CLAIM_STATUS_LABELS[claim.status]} meanwhile. Reload the board.`,
      { status: claim.status },
    );
  }
  if (!canMoveClaim(claim.status, input.toStatus)) {
    throw conflict(
      ERROR_CODES.CLAIM_TRANSITION_NOT_ALLOWED,
      `A claim in ${CLAIM_STATUS_LABELS[claim.status]} cannot be moved to ${CLAIM_STATUS_LABELS[input.toStatus]}.`,
    );
  }
  if (input.toStatus === 'SUBMITTED') {
    const missing = missingDocuments(
      await ClaimFileModel.find({ claimId: claim._id }, { kind: 1 }).lean(),
    );
    if (missing.length > 0) {
      throw conflict(
        ERROR_CODES.CLAIM_DOCUMENTS_MISSING,
        'Upload the medical bills, discharge summary and ID proof before submitting the claim.',
        { missing },
      );
    }
  }
  const actorId = new Types.ObjectId(actor.id ?? undefined);
  const at = new Date();
  await withTransaction(async (session) => {
    const updated = await ClaimModel.findOneAndUpdate(
      { _id: claim._id, status: input.expectedStatus },
      { $set: { status: input.toStatus, statusChangedAt: at, updatedBy: actorId } },
      { returnDocument: 'after', session },
    ).lean<ClaimDoc>();
    if (!updated) {
      throw conflict(
        ERROR_CODES.CLAIM_STATUS_CHANGED,
        'Someone moved this claim meanwhile. Reload the board.',
      );
    }
    const [event] = await ClaimEventModel.create(
      [
        {
          claimId: claim._id,
          type: 'STATUS_CHANGED',
          at,
          actorKind: 'STAFF',
          actorId,
          fromStatus: claim.status,
          toStatus: input.toStatus,
          remark: input.remark,
          changes: [],
          email: null,
          detail: null,
        },
      ],
      { session },
    );
    if (!event) throw new Error('Event was not saved');
    await enqueueStatusEmails(
      updated,
      { eventId: event._id, from: claim.status, to: input.toStatus, remark: input.remark, at },
      session,
    );
    await auditClaim(
      actor,
      AUDIT_ACTIONS.CLAIM_STATUS_CHANGED,
      id,
      { status: claim.status },
      { status: input.toStatus, remark: input.remark },
      session,
    );
  });
  await dispatchClaim(claim._id, deps.transport, deps.logger);
  const detail = await getClaim(id, actor);
  const latestEvent = [...detail.timeline]
    .reverse()
    .find((event) => event.type === 'STATUS_CHANGED');
  return {
    claim: detail,
    notifications: detail.notifications.filter((item) => item.eventId === latestEvent?.id),
  };
}

const FIELD_LABELS: Record<string, string> = {
  hospital: 'Hospital',
  admissionDate: 'Admission date',
  dischargeDate: 'Discharge date',
  claimType: 'Claim type',
  amountClaimed: 'Amount claimed',
  contactEmail: 'Contact email',
  contactPhone: 'Contact phone',
};

/** Corrects a claim's details; the timeline keeps each field's old and new value. */
export async function updateClaim(
  id: string,
  input: UpdateClaimRequest,
  actor: ClaimActor,
): Promise<ClaimDetail> {
  const claim = await loadClaim(id);
  if (!mayEdit(actor, claim))
    throw forbidden(
      'Only the assigned staff member or an Admin can change this claim, and not once Approved.',
    );
  await assertEligible({
    clientId: null,
    ghiCaseId: claim.ghiCaseId.toHexString(),
    employeeMemberId: claim.employee.memberId.toHexString(),
    patientMemberId: claim.patient.memberId.toHexString(),
    admissionDate: input.admissionDate,
    dischargeDate: input.dischargeDate,
    claimType: input.claimType,
  });
  const hospitalText = (hospital: { name: string; city: string | null }) =>
    hospital.city ? `${hospital.name}, ${hospital.city}` : hospital.name;
  const before: Record<string, string | null> = {
    hospital: hospitalText(claim.hospital),
    admissionDate: claim.admissionDate,
    dischargeDate: claim.dischargeDate,
    claimType: CLAIM_TYPE_LABELS[claim.claimType],
    amountClaimed: amountText(claim.amountClaimed),
    contactEmail: claim.contactEmail,
    contactPhone: claim.contactPhone,
  };
  const after: Record<string, string | null> = {
    hospital: hospitalText(input.hospital),
    admissionDate: input.admissionDate,
    dischargeDate: input.dischargeDate,
    claimType: CLAIM_TYPE_LABELS[input.claimType],
    amountClaimed: amountText(input.amountClaimed),
    contactEmail: input.contactEmail.toLowerCase(),
    contactPhone: input.contactPhone,
  };
  const changes = Object.keys(before)
    .filter((key) => before[key] !== after[key])
    .map((key) => ({
      field: FIELD_LABELS[key] ?? key,
      before: before[key] ?? null,
      after: after[key] ?? null,
    }));
  if (changes.length === 0) return getClaim(id, actor);
  const actorId = new Types.ObjectId(actor.id ?? undefined);
  await withTransaction(async (session) => {
    const updated = await ClaimModel.findOneAndUpdate(
      { _id: claim._id, status: { $ne: 'APPROVED' } },
      {
        $set: {
          hospital: input.hospital,
          admissionDate: input.admissionDate,
          dischargeDate: input.dischargeDate,
          claimType: input.claimType,
          amountClaimed: toDecimal128(input.amountClaimed),
          contactEmail: input.contactEmail.toLowerCase(),
          contactPhone: input.contactPhone,
          updatedBy: actorId,
        },
      },
      { returnDocument: 'after', session },
    ).lean<ClaimDoc>();
    if (!updated)
      throw conflict(
        ERROR_CODES.CONFLICT,
        'The claim was approved meanwhile and can no longer change.',
      );
    await ClaimEventModel.create(
      [
        {
          claimId: claim._id,
          type: 'UPDATED',
          at: new Date(),
          actorKind: 'STAFF',
          actorId,
          fromStatus: null,
          toStatus: null,
          remark: null,
          changes,
          email: null,
          detail: null,
        },
      ],
      { session },
    );
    await auditClaim(
      actor,
      AUDIT_ACTIONS.CLAIM_UPDATED,
      id,
      claimAuditView(claim),
      claimAuditView(updated),
      session,
    );
  });
  return getClaim(id, actor);
}

export async function addRemark(
  id: string,
  remark: string,
  actor: ClaimActor,
): Promise<ClaimDetail> {
  const claim = await loadClaim(id);
  if (!mayMove(actor, claim))
    throw forbidden('Only the assigned staff member or an Admin can add remarks to this claim.');
  await withTransaction(async (session) => {
    await ClaimEventModel.create(
      [
        {
          claimId: claim._id,
          type: 'REMARK',
          at: new Date(),
          actorKind: 'STAFF',
          actorId: new Types.ObjectId(actor.id ?? undefined),
          fromStatus: null,
          toStatus: null,
          remark,
          changes: [],
          email: null,
          detail: null,
        },
      ],
      { session },
    );
    await auditClaim(
      actor,
      AUDIT_ACTIONS.CLAIM_REMARK_ADDED,
      id,
      null,
      { status: claim.status },
      session,
    );
  });
  return getClaim(id, actor);
}

/** Changes who processes the claim. Admins only (checked by the route). */
export async function assignClaim(
  id: string,
  assignedTo: string | null,
  actor: ClaimActor,
): Promise<ClaimDetail> {
  const claim = await loadClaim(id);
  const assignee = assignedTo ? await assertAssignee(assignedTo) : null;
  const name = assignee
    ? ((await userNames([assignee])).get(assignee.toHexString()) ?? null)
    : null;
  await withTransaction(async (session) => {
    await ClaimModel.updateOne(
      { _id: claim._id },
      { $set: { assignedTo: assignee, updatedBy: new Types.ObjectId(actor.id ?? undefined) } },
      { session },
    );
    await ClaimEventModel.create(
      [
        {
          claimId: claim._id,
          type: 'ASSIGNED',
          at: new Date(),
          actorKind: 'STAFF',
          actorId: new Types.ObjectId(actor.id ?? undefined),
          fromStatus: null,
          toStatus: null,
          remark: null,
          changes: [],
          email: null,
          detail: name,
        },
      ],
      { session },
    );
    await auditClaim(
      actor,
      AUDIT_ACTIONS.CLAIM_ASSIGNED,
      id,
      { assignedTo: claim.assignedTo?.toHexString() ?? null },
      { assignedTo: assignee?.toHexString() ?? null },
      session,
    );
  });
  return getClaim(id, actor);
}

/** Checks and keeps a supporting document (PDF, PNG or JPEG), as staff or the employee's link. */
export async function storeClaimDocument(
  claim: ClaimDoc,
  kind: ClaimDocumentKind,
  fileName: string,
  data: Buffer,
  actor: ClaimActor,
): Promise<ClaimDocument> {
  const contentType = sniff(data, fileName);
  if (
    contentType !== 'application/pdf' &&
    contentType !== 'image/png' &&
    contentType !== 'image/jpeg'
  ) {
    throw validationError([
      { location: 'body', path: 'file', message: 'Upload a PDF, PNG or JPEG file' },
    ]);
  }
  if ((await ClaimFileModel.countDocuments({ claimId: claim._id })) >= MAX_CLAIM_DOCUMENTS) {
    throw conflict(ERROR_CODES.CONFLICT, `A claim holds at most ${MAX_CLAIM_DOCUMENTS} documents.`);
  }
  const staff = actor.kind === 'STAFF';
  const actorId = staff && actor.id ? new Types.ObjectId(actor.id) : null;
  const saved = await withTransaction(async (session) => {
    const [file] = await ClaimFileModel.create(
      [
        {
          claimId: claim._id,
          kind,
          fileName,
          contentType,
          size: data.length,
          sha256: createHash('sha256').update(data).digest('hex'),
          data,
          uploadedBy: actorId,
          uploadedVia: staff ? 'STAFF' : 'EMPLOYEE_LINK',
        },
      ],
      { session },
    );
    if (!file) throw new Error('Document was not saved');
    await ClaimEventModel.create(
      [
        {
          claimId: claim._id,
          type: 'DOCUMENT_UPLOADED',
          at: new Date(),
          actorKind: actor.kind,
          actorId,
          fromStatus: null,
          toStatus: null,
          remark: null,
          changes: [],
          email: null,
          detail: documentLabel(kind, fileName),
        },
      ],
      { session },
    );
    await auditClaim(
      actor,
      AUDIT_ACTIONS.CLAIM_DOCUMENT_UPLOADED,
      claim._id.toHexString(),
      null,
      { kind, fileName, contentType, size: data.length },
      session,
    );
    const { data: _data, ...rest } = file.toObject();
    return rest;
  });
  return toDocument(saved, await userNames([saved.uploadedBy]));
}

export async function uploadClaimDocument(
  id: string,
  kind: ClaimDocumentKind,
  fileName: string,
  data: Buffer,
  actor: ClaimActor,
): Promise<ClaimDocument> {
  const claim = await loadClaim(id);
  if (!mayEdit(actor, claim))
    throw forbidden(
      'Only the assigned staff member or an Admin can add documents, and not once Approved.',
    );
  return storeClaimDocument(claim, kind, fileName, data, actor);
}

/** A document of this claim, to view or download. Each opening is audited (medical records). */
export async function claimDocument(id: string, fileId: string, actor: ClaimActor) {
  const file = await ClaimFileModel.findOne({
    _id: new Types.ObjectId(fileId),
    claimId: new Types.ObjectId(id),
  }).lean();
  if (!file) throw notFound('Document not found');
  await auditClaim(actor, AUDIT_ACTIONS.CLAIM_DOCUMENT_DOWNLOADED, id, null, {
    kind: file.kind,
    fileName: file.fileName,
  });
  const raw = file.data as unknown as Buffer | { buffer: Uint8Array };
  return {
    fileName: file.fileName,
    contentType: file.contentType,
    data: Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer),
  };
}

// Pickers (C2): placed policies, their employees, and an employee's covered family.

export async function claimPolicies(clientId?: string): Promise<{ items: ClaimPolicy[] }> {
  const cases = await GhiCaseModel.find(
    {
      policy: { $ne: null },
      stage: { $ne: 'CLOSED' },
      ...(clientId ? { clientId: new Types.ObjectId(clientId) } : {}),
    },
    { reference: 1, clientId: 1, policy: 1 },
  )
    .sort({ 'policy.policyStart': -1 })
    .limit(500)
    .lean();
  const [clients, insurers] = await Promise.all([
    ClientModel.find({ _id: { $in: cases.map((item) => item.clientId) } }, { name: 1 }).lean(),
    InsurerModel.find(
      { _id: { $in: cases.map((item) => item.policy!.insurerId) } },
      { company: 1, branch: 1 },
    ).lean(),
  ]);
  return {
    items: cases.map((item) => {
      const insurer = insurers.find((one) => one._id.equals(item.policy!.insurerId));
      return {
        ghiCaseId: item._id.toHexString(),
        caseReference: item.reference,
        clientId: item.clientId.toHexString(),
        clientName:
          clients.find((client) => client._id.equals(item.clientId))?.name ??
          'Client no longer exists',
        policyNumber: item.policy!.policyNumber,
        insurerName: insurer ? `${insurer.company}, ${insurer.branch}` : 'Insurer',
        policyStart: item.policy!.policyStart,
        policyEnd: item.policy!.policyEnd,
      };
    }),
  };
}

const toMember = (member: {
  _id: Types.ObjectId;
  employeeId: string;
  name: string;
  relationship: ClaimMember['relationship'];
  dateOfBirth: string;
}): ClaimMember => ({
  memberId: member._id.toHexString(),
  employeeId: member.employeeId,
  name: member.name,
  relationship: member.relationship,
  dateOfBirth: member.dateOfBirth,
});

export async function policyEmployees(
  caseId: string,
  q?: string,
): Promise<{ items: ClaimMember[] }> {
  const ghiCase = await placedPolicy(caseId, 'caseId');
  const filter: Record<string, unknown> = { caseId: ghiCase._id, relationship: 'SELF' };
  if (q?.trim()) {
    const pattern = new RegExp(escapeRegExp(q.trim()), 'i');
    filter.$or = [{ name: pattern }, { employeeId: pattern }];
  }
  const members = await GhiMemberModel.find(filter).sort({ employeeKey: 1 }).limit(50).lean();
  return { items: members.map(toMember) };
}

/** The employee and their dependants covered under the policy: the patients a claim can be for. */
export async function employeeFamily(
  caseId: string,
  memberId: string,
): Promise<{ items: ClaimMember[] }> {
  const ghiCase = await placedPolicy(caseId, 'caseId');
  const employee = await GhiMemberModel.findOne({
    _id: new Types.ObjectId(memberId),
    caseId: ghiCase._id,
    relationship: 'SELF',
  }).lean();
  if (!employee) throw notFound('Employee not found under this policy');
  const family = await GhiMemberModel.find({
    caseId: ghiCase._id,
    employeeKey: employee.employeeKey,
  }).lean();
  return { items: familyOrder(family).map(toMember) };
}

// HR contacts (C3)

export async function hrContact(clientId: string): Promise<ClaimHrContact> {
  const [client, doc] = await Promise.all([
    ClientModel.findById(clientId, { name: 1 }).lean(),
    ClaimHrContactModel.findOne({ clientId: new Types.ObjectId(clientId) }).lean(),
  ]);
  if (!client) throw notFound('Client not found');
  const names = await userNames([doc?.updatedBy]);
  return {
    clientId,
    clientName: client.name,
    name: doc?.name ?? null,
    email: doc?.email ?? null,
    notify: doc?.notify ?? false,
    updatedAt: doc?.updatedAt.toISOString() ?? null,
    updatedBy: doc ? (names.get(doc.updatedBy.toHexString()) ?? 'Unknown user') : null,
  };
}

export async function setHrContact(
  clientId: string,
  input: SetClaimHrContactRequest,
  actor: ClaimActor,
): Promise<ClaimHrContact> {
  const before = await hrContact(clientId);
  await withTransaction(async (session) => {
    await ClaimHrContactModel.updateOne(
      { clientId: new Types.ObjectId(clientId) },
      {
        $set: {
          name: input.name,
          email: input.email,
          notify: input.notify,
          updatedBy: new Types.ObjectId(actor.id ?? undefined),
        },
      },
      { upsert: true, session },
    );
    await auditClaim(
      actor,
      AUDIT_ACTIONS.CLAIM_HR_CONTACT_UPDATED,
      clientId,
      { name: before.name, email: before.email, notify: before.notify },
      input,
      session,
    );
  });
  return hrContact(clientId);
}
