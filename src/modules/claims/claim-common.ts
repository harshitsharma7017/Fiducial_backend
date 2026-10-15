import {
  AUDIT_ENTITIES,
  CLAIM_DOCUMENT_KIND_LABELS,
  CLAIM_STATUS_LABELS,
  CLAIM_TRANSITIONS,
  GHI_RELATIONSHIP_LABELS,
  REQUIRED_CLAIM_DOCUMENTS,
  can,
  type AuditAction,
  type ClaimCard,
  type ClaimDocument,
  type ClaimDocumentKind,
  type ClaimEvent,
  type ClaimNotification,
  type ClaimRecord,
  type ClaimStatus,
  type Role,
} from '../../shared/index.ts';
import { Types, type mongo } from 'mongoose';
import { Decimal, moneyString } from '../../lib/decimal.ts';
import { notFound, validationError } from '../../lib/errors.ts';
import { istDay } from '../../lib/ist-day.ts';
import { writeAudit } from '../audit/audit.service.ts';
import { ClientModel } from '../clients/client.model.ts';
import { GhiCaseModel, type GhiCaseDoc } from '../ghi/ghi-case.model.ts';
import { GhiMemberModel, type GhiMemberDoc } from '../ghi/ghi-census.model.ts';
import { InsurerModel } from '../insurers/insurer.model.ts';
import { UserModel } from '../users/user.model.ts';
import {
  ClaimFileModel,
  ClaimModel,
  type ClaimDoc,
  type ClaimEventDoc,
  type ClaimFileDoc,
  type ClaimNotificationDoc,
} from './claim.model.ts';

/** Who is acting: a signed-in staff member (with their roles), or the employee's link. */
export interface ClaimActor {
  id: string | null;
  roles: readonly Role[];
  requestId: string | null;
  kind: 'STAFF' | 'EMPLOYEE';
}

export const claimNotFound = () => notFound('Claim not found');

/** Admins move any claim; claims staff move the claims assigned to them (C1, security). */
export function mayMove(actor: ClaimActor, claim: Pick<ClaimDoc, 'assignedTo'>): boolean {
  if (actor.kind !== 'STAFF') return false;
  if (can(actor.roles, 'claims.admin')) return true;
  return (
    can(actor.roles, 'claims.process') &&
    actor.id !== null &&
    claim.assignedTo?.toHexString() === actor.id
  );
}

/** The moves this actor may make on the claim now. */
export function allowedMoves(actor: ClaimActor, claim: ClaimDoc): ClaimStatus[] {
  return mayMove(actor, claim) ? [...CLAIM_TRANSITIONS[claim.status]] : [];
}

export async function loadClaim(id: string, session?: mongo.ClientSession): Promise<ClaimDoc> {
  const claim = await ClaimModel.findById(id)
    .session(session ?? null)
    .lean<ClaimDoc>();
  if (!claim) throw claimNotFound();
  return claim;
}

export async function auditClaim(
  actor: ClaimActor | null,
  action: AuditAction,
  claimId: string,
  before: unknown,
  after: unknown,
  session?: mongo.ClientSession,
): Promise<void> {
  await writeAudit(
    {
      userId: actor?.kind === 'STAFF' ? actor.id : null,
      action,
      entity: AUDIT_ENTITIES.CLAIM,
      entityId: claimId,
      before,
      after,
      requestId: actor?.requestId ?? null,
    },
    session,
  );
}

const fail = (path: string, message: string) =>
  validationError([{ location: 'body', path, message }], message);

export interface EligibleClaim {
  ghiCase: GhiCaseDoc & { policy: NonNullable<GhiCaseDoc['policy']> };
  employee: GhiMemberDoc;
  patient: GhiMemberDoc;
}

/** A GHI case whose policy is recorded (placed) and that is not closed: a policy claims are made on. */
export async function placedPolicy(ghiCaseId: string, path = 'ghiCaseId') {
  const ghiCase = await GhiCaseModel.findById(ghiCaseId).lean<GhiCaseDoc>();
  if (!ghiCase) throw fail(path, 'Choose a group health policy');
  if (!ghiCase.policy || ghiCase.stage === 'CLOSED') {
    throw fail(
      path,
      'Claims are made on a placed policy: record the policy on the group health case first',
    );
  }
  return ghiCase as EligibleClaim['ghiCase'];
}

/**
 * The checks that tie a claim together, all on the server (C2): the policy is placed and is the
 * company's; the employee is an employee (Self) of that policy's census; the patient is that
 * employee or one of their covered dependants; the admission falls in the policy period.
 */
export async function assertEligible(input: {
  clientId: string | null;
  ghiCaseId: string;
  employeeMemberId: string;
  patientMemberId: string;
  admissionDate: string;
  dischargeDate: string;
  claimType: 'CASHLESS' | 'REIMBURSEMENT';
}): Promise<EligibleClaim> {
  const ghiCase = await placedPolicy(input.ghiCaseId);
  if (input.clientId !== null && ghiCase.clientId.toHexString() !== input.clientId) {
    throw fail('ghiCaseId', 'This policy is not the chosen company’s');
  }
  const [employee, patient] = await Promise.all([
    GhiMemberModel.findOne({
      _id: new Types.ObjectId(input.employeeMemberId),
      caseId: ghiCase._id,
    }).lean(),
    GhiMemberModel.findOne({
      _id: new Types.ObjectId(input.patientMemberId),
      caseId: ghiCase._id,
    }).lean(),
  ]);
  if (!employee || employee.relationship !== 'SELF') {
    throw fail('employeeMemberId', 'Choose an employee insured under this policy');
  }
  if (!patient || patient.employeeKey !== employee.employeeKey) {
    throw fail(
      'patientMemberId',
      'Choose the employee or one of their family members covered under this policy',
    );
  }
  const policy = ghiCase.policy;
  if (input.admissionDate < policy.policyStart || input.admissionDate > policy.policyEnd) {
    throw fail(
      'admissionDate',
      `The admission date is outside the policy period (${policy.policyStart} to ${policy.policyEnd})`,
    );
  }
  const today = istDay(new Date());
  if (input.admissionDate > today)
    throw fail('admissionDate', 'The admission date cannot be in the future');
  // A cashless claim may give the expected discharge; a reimbursement is made after discharge.
  if (input.claimType === 'REIMBURSEMENT' && input.dischargeDate > today) {
    throw fail(
      'dischargeDate',
      'A reimbursement claim is made after discharge: the date cannot be in the future',
    );
  }
  return { ghiCase, employee, patient };
}

export function missingDocuments(
  files: readonly Pick<ClaimFileDoc, 'kind'>[],
): ClaimDocumentKind[] {
  const have = new Set(files.map((file) => file.kind));
  return REQUIRED_CLAIM_DOCUMENTS.filter((kind) => !have.has(kind));
}

export const daysSince = (at: Date, now = new Date()) =>
  Math.max(0, Math.floor((now.getTime() - at.getTime()) / 86_400_000));

export const amountText = (value: Types.Decimal128 | string) =>
  moneyString(new Decimal(value.toString()));

export async function userNames(ids: readonly (Types.ObjectId | null | undefined)[]) {
  const wanted = [
    ...new Set(ids.filter((id): id is Types.ObjectId => Boolean(id)).map((id) => id.toHexString())),
  ];
  const users = await UserModel.find(
    { _id: { $in: wanted.map((id) => new Types.ObjectId(id)) } },
    { name: 1 },
  ).lean();
  return new Map(users.map((user) => [user._id.toHexString(), user.name]));
}

async function clientNames(ids: readonly Types.ObjectId[]) {
  const clients = await ClientModel.find({ _id: { $in: ids } }, { name: 1 }).lean();
  return new Map(clients.map((client) => [client._id.toHexString(), client.name]));
}

export async function toCards(
  claims: readonly ClaimDoc[],
  actor: ClaimActor,
): Promise<ClaimCard[]> {
  const [clients, users] = await Promise.all([
    clientNames(claims.map((claim) => claim.clientId)),
    userNames(claims.map((claim) => claim.assignedTo)),
  ]);
  const now = new Date();
  return claims.map((claim) => ({
    id: claim._id.toHexString(),
    claimNumber: claim.claimNumber,
    status: claim.status,
    clientName: clients.get(claim.clientId.toHexString()) ?? 'Client no longer exists',
    employeeName: claim.employee.name,
    patientName: claim.patient.name,
    relationship: claim.patient.relationship,
    hospital: claim.hospital.city
      ? `${claim.hospital.name}, ${claim.hospital.city}`
      : claim.hospital.name,
    amountClaimed: amountText(claim.amountClaimed),
    claimType: claim.claimType,
    admissionDate: claim.admissionDate,
    daysInStage: daysSince(claim.statusChangedAt, now),
    assignedTo: claim.assignedTo
      ? {
          id: claim.assignedTo.toHexString(),
          name: users.get(claim.assignedTo.toHexString()) ?? 'Unknown user',
        }
      : null,
    canMove: mayMove(actor, claim) && CLAIM_TRANSITIONS[claim.status].length > 0,
    createdAt: claim.createdAt.toISOString(),
  }));
}

export function toDocument(
  file: Omit<ClaimFileDoc, 'data'>,
  names: ReadonlyMap<string, string>,
): ClaimDocument {
  return {
    id: file._id.toHexString(),
    kind: file.kind,
    fileName: file.fileName,
    contentType: file.contentType,
    size: file.size,
    uploadedAt: file.createdAt.toISOString(),
    uploadedBy:
      file.uploadedVia === 'EMPLOYEE_LINK'
        ? 'Employee (submission link)'
        : (names.get(file.uploadedBy?.toHexString() ?? '') ?? 'Unknown user'),
  };
}

/** The claim as the API returns it, for this actor. */
export async function toRecord(claim: ClaimDoc, actor: ClaimActor): Promise<ClaimRecord> {
  const [files, ghiCase, client, insurer, names] = await Promise.all([
    ClaimFileModel.find({ claimId: claim._id }, { data: 0 }).sort({ _id: 1 }).lean(),
    GhiCaseModel.findById(claim.ghiCaseId, { reference: 1 }).lean(),
    ClientModel.findById(claim.clientId, { name: 1 }).lean(),
    InsurerModel.findById(claim.policy.insurerId, { company: 1, branch: 1 }).lean(),
    userNames([claim.assignedTo, claim.createdBy]),
  ]);
  const fileNames = await userNames(files.map((file) => file.uploadedBy));
  const editable = actor.kind === 'STAFF' && mayEdit(actor, claim);
  return {
    id: claim._id.toHexString(),
    claimNumber: claim.claimNumber,
    status: claim.status,
    statusChangedAt: claim.statusChangedAt.toISOString(),
    daysInStage: daysSince(claim.statusChangedAt),
    source: claim.source,
    client: { id: claim.clientId.toHexString(), name: client?.name ?? 'Client no longer exists' },
    policy: {
      ghiCaseId: claim.ghiCaseId.toHexString(),
      caseReference: ghiCase?.reference ?? '',
      policyNumber: claim.policy.policyNumber,
      insurerName: insurer ? `${insurer.company}, ${insurer.branch}` : 'Insurer',
      policyStart: claim.policy.policyStart,
      policyEnd: claim.policy.policyEnd,
    },
    employee: {
      memberId: claim.employee.memberId.toHexString(),
      employeeId: claim.employee.employeeId,
      name: claim.employee.name,
    },
    patient: {
      memberId: claim.patient.memberId.toHexString(),
      name: claim.patient.name,
      relationship: claim.patient.relationship,
      gender: claim.patient.gender,
      dateOfBirth: claim.patient.dateOfBirth,
    },
    hospital: claim.hospital,
    admissionDate: claim.admissionDate,
    dischargeDate: claim.dischargeDate,
    claimType: claim.claimType,
    amountClaimed: amountText(claim.amountClaimed),
    contactEmail: claim.contactEmail,
    contactPhone: claim.contactPhone,
    assignedTo: claim.assignedTo
      ? {
          id: claim.assignedTo.toHexString(),
          name: names.get(claim.assignedTo.toHexString()) ?? 'Unknown user',
        }
      : null,
    documents: files.map((file) => toDocument(file, fileNames)),
    missingDocuments: missingDocuments(files),
    allowedMoves: allowedMoves(actor, claim),
    canEdit: editable,
    createdAt: claim.createdAt.toISOString(),
    createdBy:
      claim.source === 'EMPLOYEE_LINK'
        ? 'Employee (submission link)'
        : (names.get(claim.createdBy?.toHexString() ?? '') ?? 'Unknown user'),
    updatedAt: claim.updatedAt.toISOString(),
  };
}

/** Details, documents and remarks change by the same people who move the claim, until it is Approved. */
export function mayEdit(
  actor: ClaimActor,
  claim: Pick<ClaimDoc, 'assignedTo' | 'status'>,
): boolean {
  return mayMove(actor, claim) && claim.status !== 'APPROVED';
}

const statusLabel = (status: ClaimStatus | null) => (status ? CLAIM_STATUS_LABELS[status] : '');

export function describeEvent(event: ClaimEventDoc): string {
  switch (event.type) {
    case 'CREATED':
      return event.actorKind === 'EMPLOYEE'
        ? 'Claim submitted by the employee through the link'
        : 'Claim created';
    case 'UPDATED':
      return 'Claim details edited';
    case 'STATUS_CHANGED':
      return `Moved from ${statusLabel(event.fromStatus)} to ${statusLabel(event.toStatus)}`;
    case 'REMARK':
      return 'Remark added';
    case 'ASSIGNED':
      return event.detail ? `Assigned to ${event.detail}` : 'Assignment removed';
    case 'DOCUMENT_UPLOADED':
      return `Document uploaded: ${event.detail ?? ''}`;
    case 'EMAIL_SENT':
      return event.email?.result === 'OUTBOX'
        ? `Email kept in the outbox (not delivered): ${event.email.recipient}`
        : `Email accepted by the mail server: ${event.email?.recipient ?? ''}`;
    case 'EMAIL_FAILED':
      return `Email failed: ${event.email?.recipient ?? ''}`;
    case 'EMAIL_RETRY_REQUESTED':
      return `Email retry requested: ${event.detail ?? ''}`;
  }
}

export function toEvent(event: ClaimEventDoc, names: ReadonlyMap<string, string>): ClaimEvent {
  return {
    id: event._id.toHexString(),
    type: event.type,
    at: event.at.toISOString(),
    actor: {
      kind: event.actorKind,
      name:
        event.actorKind === 'EMPLOYEE'
          ? 'Employee (submission link)'
          : event.actorKind === 'SYSTEM'
            ? 'System'
            : (names.get(event.actorId?.toHexString() ?? '') ?? 'Unknown user'),
    },
    description: describeEvent(event),
    fromStatus: event.fromStatus,
    toStatus: event.toStatus,
    remark: event.remark,
    changes: event.changes,
    email: event.email
      ? {
          audience: event.email.audience,
          recipient: event.email.recipient,
          subject: event.email.subject,
          attempt: event.email.attempt,
          result: event.email.result,
          error: event.email.error,
        }
      : null,
  };
}

export function toNotification(doc: ClaimNotificationDoc): ClaimNotification {
  return {
    id: doc._id.toHexString(),
    eventId: doc.eventId.toHexString(),
    audience: doc.audience,
    recipient: doc.recipient,
    toStatus: doc.toStatus,
    subject: doc.subject,
    status: doc.status,
    attempts: doc.attempts,
    lastAttemptAt: doc.lastAttemptAt?.toISOString() ?? null,
    nextAttemptAt: doc.nextAttemptAt?.toISOString() ?? null,
    error: doc.error,
    createdAt: doc.createdAt.toISOString(),
  };
}

/** Labels of a document kind and relationship, for event details. */
export const documentLabel = (kind: ClaimDocumentKind, fileName: string) =>
  `${CLAIM_DOCUMENT_KIND_LABELS[kind]}: ${fileName}`;
export const relationshipLabel = (relationship: keyof typeof GHI_RELATIONSHIP_LABELS) =>
  GHI_RELATIONSHIP_LABELS[relationship];

/** A family in the order screens show it: the employee, spouse, children (eldest first), parents. */
export function familyOrder<T extends { relationship: string; dateOfBirth: string }>(
  members: readonly T[],
): T[] {
  const order = ['SELF', 'SPOUSE', 'CHILD', 'FATHER', 'MOTHER', 'FATHER_IN_LAW', 'MOTHER_IN_LAW'];
  return [...members].sort(
    (a, b) =>
      order.indexOf(a.relationship) - order.indexOf(b.relationship) ||
      a.dateOfBirth.localeCompare(b.dateOfBirth),
  );
}
