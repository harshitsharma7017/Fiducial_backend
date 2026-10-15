import {
  AUDIT_ACTIONS,
  ERROR_CODES,
  type ClaimDocumentKind,
  type ClaimLink,
  type ClaimLinkStatus,
  type CreateClaimLinkRequest,
  type CreateClaimLinkResponse,
  type PublicClaimLink,
  type PublicClaimSubmitRequest,
} from '../../shared/index.ts';
import { createHash, randomBytes } from 'node:crypto';
import { Types } from 'mongoose';
import { AppError, conflict, notFound, validationError } from '../../lib/errors.ts';
import { withTransaction } from '../../lib/db.ts';
import { ClientModel } from '../clients/client.model.ts';
import { GhiCaseModel } from '../ghi/ghi-case.model.ts';
import { GhiMemberModel } from '../ghi/ghi-census.model.ts';
import { InsurerModel } from '../insurers/insurer.model.ts';
import {
  assertEligible,
  auditClaim,
  familyOrder,
  missingDocuments,
  placedPolicy,
  userNames,
  type ClaimActor,
} from './claim-common.ts';
import { ClaimEventModel, ClaimFileModel, ClaimModel } from './claim.model.ts';
import { ClaimLinkModel, type ClaimLinkDoc } from './claim-settings.model.ts';
import {
  claimAuditView,
  newClaimDoc,
  nextClaimNumber,
  storeClaimDocument,
} from './claims.service.ts';

// Employee submission links (C2). A link is single-purpose: it creates claims for one employee of
// one placed policy, for that employee's covered family only, until it expires, is revoked or its
// claims are used. Its token is shown once; only a SHA-256 hash is stored. Claims it creates land
// in Form; the employee can add their documents while the claim is in Form, and nothing else.

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

function linkStatus(link: ClaimLinkDoc, now = new Date()): ClaimLinkStatus {
  if (link.revokedAt) return 'REVOKED';
  if (link.expiresAt <= now) return 'EXPIRED';
  if (link.usedClaims >= link.maxClaims) return 'USED';
  return 'ACTIVE';
}

async function toLinks(links: readonly ClaimLinkDoc[]): Promise<ClaimLink[]> {
  const [cases, clients, members, names] = await Promise.all([
    GhiCaseModel.find(
      { _id: { $in: links.map((link) => link.ghiCaseId) } },
      { reference: 1 },
    ).lean(),
    ClientModel.find({ _id: { $in: links.map((link) => link.clientId) } }, { name: 1 }).lean(),
    GhiMemberModel.find(
      { _id: { $in: links.map((link) => link.employeeMemberId) } },
      { employeeId: 1, name: 1 },
    ).lean(),
    userNames(links.map((link) => link.createdBy)),
  ]);
  return links.map((link) => {
    const member = members.find((item) => item._id.equals(link.employeeMemberId));
    return {
      id: link._id.toHexString(),
      ghiCaseId: link.ghiCaseId.toHexString(),
      caseReference: cases.find((item) => item._id.equals(link.ghiCaseId))?.reference ?? '',
      clientName: clients.find((item) => item._id.equals(link.clientId))?.name ?? '',
      employee: {
        employeeId: member?.employeeId ?? '',
        name: member?.name ?? 'Member no longer exists',
      },
      status: linkStatus(link),
      expiresAt: link.expiresAt.toISOString(),
      maxClaims: link.maxClaims,
      usedClaims: link.usedClaims,
      createdAt: link.createdAt.toISOString(),
      createdBy: names.get(link.createdBy.toHexString()) ?? 'Unknown user',
    };
  });
}

export async function createClaimLink(
  input: CreateClaimLinkRequest,
  actor: ClaimActor,
): Promise<CreateClaimLinkResponse> {
  const ghiCase = await placedPolicy(input.ghiCaseId);
  const employee = await GhiMemberModel.findOne({
    _id: new Types.ObjectId(input.employeeMemberId),
    caseId: ghiCase._id,
    relationship: 'SELF',
  }).lean();
  if (!employee) {
    throw validationError([
      {
        location: 'body',
        path: 'employeeMemberId',
        message: 'Choose an employee insured under this policy',
      },
    ]);
  }
  const token = randomBytes(32).toString('base64url');
  const link = await withTransaction(async (session) => {
    const [created] = await ClaimLinkModel.create(
      [
        {
          tokenHash: hashToken(token),
          ghiCaseId: ghiCase._id,
          clientId: ghiCase.clientId,
          employeeMemberId: employee._id,
          expiresAt: new Date(Date.now() + input.expiresInDays * 86_400_000),
          maxClaims: input.maxClaims,
          usedClaims: 0,
          revokedAt: null,
          revokedBy: null,
          createdBy: new Types.ObjectId(actor.id ?? undefined),
        },
      ],
      { session },
    );
    if (!created) throw new Error('Link was not saved');
    // The token itself is never written anywhere but the response.
    await auditClaim(
      actor,
      AUDIT_ACTIONS.CLAIM_LINK_CREATED,
      created._id.toHexString(),
      null,
      {
        ghiCase: ghiCase.reference,
        employeeId: employee.employeeId,
        expiresAt: created.expiresAt.toISOString(),
        maxClaims: created.maxClaims,
      },
      session,
    );
    return created.toObject();
  });
  const [view] = await toLinks([link]);
  return { link: view!, token };
}

export async function listClaimLinks(ghiCaseId?: string): Promise<{ items: ClaimLink[] }> {
  const links = await ClaimLinkModel.find(
    ghiCaseId ? { ghiCaseId: new Types.ObjectId(ghiCaseId) } : {},
  )
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();
  return { items: await toLinks(links) };
}

export async function revokeClaimLink(linkId: string, actor: ClaimActor): Promise<ClaimLink> {
  const updated = await withTransaction(async (session) => {
    const link = await ClaimLinkModel.findOneAndUpdate(
      { _id: new Types.ObjectId(linkId), revokedAt: null },
      { $set: { revokedAt: new Date(), revokedBy: new Types.ObjectId(actor.id ?? undefined) } },
      { returnDocument: 'after', session },
    ).lean();
    if (!link) {
      if (!(await ClaimLinkModel.exists({ _id: new Types.ObjectId(linkId) }).session(session)))
        throw notFound('Link not found');
      throw conflict(ERROR_CODES.CONFLICT, 'This link is already revoked.');
    }
    await auditClaim(
      actor,
      AUDIT_ACTIONS.CLAIM_LINK_REVOKED,
      linkId,
      { revoked: false },
      { revoked: true },
      session,
    );
    return link;
  });
  const [view] = await toLinks([updated]);
  return view!;
}

// Public side: the employee holding the link. Every answer comes from the link alone.

function invalidLink(
  message = 'This link is not valid. Ask your HR team or broker for a new one.',
) {
  return new AppError(403, ERROR_CODES.CLAIM_LINK_INVALID, message);
}

/** The link for a token, if it can still be used (expired and revoked links cannot). */
async function usableLink(token: string): Promise<ClaimLinkDoc> {
  const link = await ClaimLinkModel.findOne({ tokenHash: hashToken(token) }).lean();
  if (!link) throw invalidLink();
  const status = linkStatus(link);
  if (status === 'REVOKED')
    throw invalidLink('This link has been withdrawn. Ask your HR team or broker for a new one.');
  if (status === 'EXPIRED')
    throw invalidLink('This link has expired. Ask your HR team or broker for a new one.');
  return link;
}

const EMPLOYEE: ClaimActor = { id: null, roles: [], requestId: null, kind: 'EMPLOYEE' };

export async function publicClaimLink(token: string): Promise<PublicClaimLink> {
  const link = await usableLink(token);
  const ghiCase = await placedPolicy(link.ghiCaseId.toHexString());
  const employee = await GhiMemberModel.findOne({
    _id: link.employeeMemberId,
    caseId: ghiCase._id,
  }).lean();
  if (!employee) throw invalidLink();
  const [client, insurer, family, claims] = await Promise.all([
    ClientModel.findById(link.clientId, { name: 1 }).lean(),
    InsurerModel.findById(ghiCase.policy.insurerId, { company: 1 }).lean(),
    GhiMemberModel.find(
      { caseId: ghiCase._id, employeeKey: employee.employeeKey },
      { name: 1, relationship: 1, dateOfBirth: 1 },
    ).lean(),
    ClaimModel.find({ linkId: link._id }, { claimNumber: 1, status: 1, 'patient.name': 1 })
      .sort({ createdAt: 1 })
      .lean(),
  ]);
  const files = await ClaimFileModel.find(
    { claimId: { $in: claims.map((claim) => claim._id) } },
    { claimId: 1, kind: 1, fileName: 1 },
  ).lean();
  return {
    clientName: client?.name ?? '',
    policyNumber: ghiCase.policy.policyNumber,
    insurerName: insurer?.company ?? '',
    policyStart: ghiCase.policy.policyStart,
    policyEnd: ghiCase.policy.policyEnd,
    employee: { employeeId: employee.employeeId, name: employee.name },
    members: familyOrder(family).map((member) => ({
      memberId: member._id.toHexString(),
      name: member.name,
      relationship: member.relationship,
    })),
    expiresAt: link.expiresAt.toISOString(),
    remainingClaims: Math.max(0, link.maxClaims - link.usedClaims),
    claims: claims.map((claim) => {
      const mine = files.filter((file) => file.claimId.equals(claim._id));
      return {
        claimNumber: claim.claimNumber,
        patientName: claim.patient.name,
        documents: mine.map((file) => ({ kind: file.kind, fileName: file.fileName })),
        missingDocuments: missingDocuments(mine),
        open: claim.status === 'FORM',
      };
    }),
  };
}

/** The employee submits a claim through the link. It lands in Form, assigned to the link's issuer. */
export async function submitThroughLink(
  token: string,
  input: PublicClaimSubmitRequest,
  requestId: string | null,
) {
  const link = await usableLink(token);
  if (link.usedClaims >= link.maxClaims) {
    throw invalidLink(
      'This link has been used for all the claims it allows. Ask your HR team or broker for a new one.',
    );
  }
  const eligible = await assertEligible({
    clientId: link.clientId.toHexString(),
    ghiCaseId: link.ghiCaseId.toHexString(),
    employeeMemberId: link.employeeMemberId.toHexString(),
    patientMemberId: input.patientMemberId,
    admissionDate: input.admissionDate,
    dischargeDate: input.dischargeDate,
    claimType: input.claimType,
  });
  const actor: ClaimActor = { ...EMPLOYEE, requestId };
  const now = new Date();
  const claim = await withTransaction(async (session) => {
    // Counts the use first, guarded, so two submissions at once cannot exceed the link's limit.
    const used = await ClaimLinkModel.updateOne(
      {
        _id: link._id,
        revokedAt: null,
        expiresAt: { $gt: now },
        $expr: { $lt: ['$usedClaims', '$maxClaims'] },
      },
      { $inc: { usedClaims: 1 } },
      { session },
    );
    if (used.modifiedCount === 0) throw invalidLink('This link can no longer be used.');
    const [created] = await ClaimModel.create(
      [
        newClaimDoc(
          eligible,
          input,
          {
            claimNumber: await nextClaimNumber(session),
            source: 'EMPLOYEE_LINK',
            linkId: link._id,
            assignedTo: link.createdBy,
            createdBy: null,
          },
          now,
        ),
      ],
      { session },
    );
    if (!created) throw new Error('Claim was not saved');
    await ClaimEventModel.create(
      [
        {
          claimId: created._id,
          type: 'CREATED',
          at: now,
          actorKind: 'EMPLOYEE',
          actorId: null,
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
      AUDIT_ACTIONS.CLAIM_SUBMITTED_BY_EMPLOYEE,
      created._id.toHexString(),
      null,
      { ...claimAuditView(created), linkId: link._id.toHexString() },
      session,
    );
    return created;
  });
  return { claimNumber: claim.claimNumber, missingDocuments: missingDocuments([]) };
}

/** The employee adds a document to a claim made through this link, while it is in Form. */
export async function uploadThroughLink(
  token: string,
  claimNumber: string,
  kind: ClaimDocumentKind,
  fileName: string,
  data: Buffer,
  requestId: string | null,
) {
  const link = await usableLink(token);
  const claim = await ClaimModel.findOne({ claimNumber, linkId: link._id }).lean();
  if (!claim) throw notFound('Claim not found');
  if (claim.status !== 'FORM') {
    throw conflict(
      ERROR_CODES.CONFLICT,
      'This claim is being processed; send further documents to your HR team or broker.',
    );
  }
  const saved = await storeClaimDocument(claim, kind, fileName, data, { ...EMPLOYEE, requestId });
  return { kind: saved.kind, fileName: saved.fileName };
}
