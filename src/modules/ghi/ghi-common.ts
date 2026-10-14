import {
  AUDIT_ENTITIES,
  ERROR_CODES,
  GHI_STAGES,
  GHI_STAGE_LABELS,
  GHI_WAIVERS,
  GHI_WAIVER_LABELS,
  type AuditAction,
  type GhiCaseRecord,
  type GhiCensusSummary,
  type GhiRequirements,
  type GhiRequirementsInput,
  type GhiStage,
} from '../../shared/index.ts';
import { Types, type mongo } from 'mongoose';
import { Decimal } from '../../lib/decimal.ts';
import { conflict, notFound, type AppError } from '../../lib/errors.ts';
import { istDay } from '../../lib/ist-day.ts';
import { writeAudit } from '../audit/audit.service.ts';
import { ClientModel } from '../clients/client.model.ts';
import { InsurerModel } from '../insurers/insurer.model.ts';
import { UserModel } from '../users/user.model.ts';
import type { CensusSettings } from './census-rules.ts';
import { summarizeCensus } from './census-summary.ts';
import { GhiCaseModel, type GhiCaseDoc } from './ghi-case.model.ts';
import { GhiMemberModel } from './ghi-census.model.ts';
import { GhiFileModel } from './ghi-workflow.model.ts';

export interface Actor {
  id: string;
  requestId: string | null;
}

export const ghiCaseNotFound = (): AppError => notFound('Group health case not found');

export async function loadCase(id: string, session?: mongo.ClientSession): Promise<GhiCaseDoc> {
  const doc = await GhiCaseModel.findById(id)
    .session(session ?? null)
    .lean<GhiCaseDoc>();
  if (!doc) throw ghiCaseNotFound();
  return doc;
}

/** True once the RFQ has gone to an insurer: the Data Sheet and census then stay as sent. */
export function isLocked(doc: Pick<GhiCaseDoc, 'insurers'>): boolean {
  return doc.insurers.some((insurer) => insurer.sentAt !== null);
}

export function assertOpen(doc: Pick<GhiCaseDoc, 'stage' | 'policy'>): void {
  if (doc.stage === 'CLOSED') throw conflict(ERROR_CODES.GHI_LOCKED, 'This case is closed.');
}

/** The Data Sheet and census can change: the case is open and no insurer has the RFQ yet. */
export function assertEditable(doc: GhiCaseDoc): void {
  assertOpen(doc);
  if (isLocked(doc)) {
    throw conflict(
      ERROR_CODES.GHI_LOCKED,
      'The RFQ has gone to an insurer, so the Data Sheet and census can no longer change. Changes after this are endorsements, which are not handled in the app yet.',
    );
  }
}

/** The date ages are worked out on: the Data Sheet's, else the policy start, else the case's creation. */
export function referenceDateOf(
  doc: Pick<GhiCaseDoc, 'requirements' | 'policyStart' | 'createdAt'>,
): string {
  return doc.requirements.ageReferenceDate ?? doc.policyStart ?? istDay(doc.createdAt);
}

export function censusSettingsOf(doc: GhiCaseDoc): CensusSettings {
  const requirements = doc.requirements;
  return {
    familyDefinition: requirements.familyDefinition,
    coverageType: requirements.coverageType,
    sumInsuredOptions: requirements.sumInsuredOptions,
    ageLimits: requirements.ageLimits,
    referenceDate: referenceDateOf(doc),
    today: istDay(new Date()),
  };
}

/** The census summary (G4), from the members as they are now. */
export async function loadSummary(
  doc: GhiCaseDoc,
  session?: mongo.ClientSession,
): Promise<GhiCensusSummary> {
  const members = await GhiMemberModel.find(
    { caseId: doc._id },
    { employeeKey: 1, relationship: 1, dateOfBirth: 1, sumInsured: 1 },
  )
    .session(session ?? null)
    .lean();
  return summarizeCensus(
    members.map((member) => ({
      employeeKey: member.employeeKey,
      relationship: member.relationship,
      dateOfBirth: member.dateOfBirth,
      sumInsured: member.sumInsured?.toString() ?? null,
    })),
    {
      coverageType: doc.requirements.coverageType,
      referenceDate: referenceDateOf(doc),
      declaredEmployees: doc.requirements.employeeCount,
      revision: doc.censusRevision,
    },
  );
}

/** What the Data Sheet still needs before an RFQ can be generated (G2). */
export function missingRequirements(doc: GhiCaseDoc): string[] {
  const requirements = doc.requirements;
  const missing: string[] = [];
  if (!doc.requirementsSaved) return ['Save the Data Sheet'];
  if (requirements.employeeCount === null) missing.push('Employees to be covered');
  if (requirements.coverageType === null)
    missing.push('Coverage type (family floater or individual)');
  if (requirements.sumInsuredOptions.length === 0) missing.push('Sums insured on offer');
  if (requirements.maternity.covered === null) missing.push('Maternity: covered or not');
  if (requirements.maternity.covered) {
    if (requirements.maternity.normalLimit === null)
      missing.push('Maternity limit: normal delivery');
    if (requirements.maternity.cesareanLimit === null) missing.push('Maternity limit: caesarean');
  }
  if (requirements.preExistingDiseases.covered === null) {
    missing.push('Pre-existing diseases: covered or not');
  }
  if (requirements.roomRent.kind === null) missing.push('Room rent');
  else if (requirements.roomRent.kind !== 'NO_LIMIT') {
    if (requirements.roomRent.normal === null) missing.push('Room rent: normal room limit');
    if (requirements.roomRent.icu === null) missing.push('Room rent: ICU limit');
  }
  for (const waiver of GHI_WAIVERS) {
    if (requirements.waivers[waiver] === null) missing.push(GHI_WAIVER_LABELS[waiver]);
  }
  if (
    requirements.familyDefinition.parents !== 'NONE' &&
    requirements.parentsCoPayPercent === null
  ) {
    missing.push('Co-payment for parents');
  }
  if (doc.type === 'RENEWAL' && requirements.claims.length === 0) {
    missing.push('Previous years’ premium and claims (renewal)');
  }
  return missing;
}

/** What the census still needs before an RFQ can be generated (G3, G4). */
export function missingCensus(summary: GhiCensusSummary): string[] {
  const missing: string[] = [];
  if (summary.employees === 0) missing.push('Add the employee census');
  if (summary.missingSumInsured > 0) {
    missing.push(`Sum insured for ${summary.missingSumInsured} census member(s)`);
  }
  return missing;
}

/** The Data Sheet as the API returns it: the claims with their ratio worked out. */
export function requirementsOut(requirements: GhiRequirementsInput): GhiRequirements {
  return {
    ...requirements,
    claims: requirements.claims.map((claim) => {
      const premium = claim.premium === null ? null : new Decimal(claim.premium);
      const claimed =
        claim.claimsPaid === null && claim.claimsOutstanding === null
          ? null
          : new Decimal(claim.claimsPaid ?? 0).plus(claim.claimsOutstanding ?? 0);
      return {
        ...claim,
        claimsRatioPercent:
          premium && claimed && !premium.isZero()
            ? claimed.dividedBy(premium).times(100).toFixed(2)
            : null,
      };
    }),
  };
}

const NEXT_STEP: Record<GhiStage, string | null> = {
  CREATED: 'Next: fill and save the Data Sheet.',
  DATA_SHEET: 'Next: complete the Data Sheet and the census, then generate the RFQ.',
  RFQ: 'Next: approve the RFQ, send it to the insurers and record their quotes.',
  QCR: 'Next: prepare the QCR from the insurers’ final quotes and submit it for approval.',
  APPROVAL: 'Next: approve the QCR, send it to the client and record the client’s decision.',
  FINAL_QCR: 'Next: record the final agreed terms with the selected insurer.',
  PAYMENT: 'Next: record the premium received.',
  PLACEMENT_SLIP: 'Next: issue the placement slip and record the policy.',
  CLOSED: null,
};

export function stageIndex(stage: GhiStage): number {
  return GHI_STAGES.indexOf(stage);
}

/**
 * Moves the case forward to a stage when the work reaches it, in the caller's transaction. A
 * case at or past the stage, or closed, is left as it is.
 */
export async function advanceStage(
  caseId: Types.ObjectId,
  target: GhiStage,
  actorId: Types.ObjectId,
  session: mongo.ClientSession,
): Promise<boolean> {
  const before = GHI_STAGES.slice(0, stageIndex(target));
  const result = await GhiCaseModel.updateOne(
    { _id: caseId, stage: { $in: before.filter((stage) => stage !== 'CLOSED') } },
    {
      $set: { stage: target, updatedBy: actorId },
      $push: {
        activity: { at: new Date(), actorId, message: `Stage: ${GHI_STAGE_LABELS[target]}` },
      },
    },
    { session },
  );
  return result.modifiedCount > 0;
}

/** Sends the case back to a stage (a rejected QCR goes back to QCR). */
export async function returnToStage(
  caseId: Types.ObjectId,
  target: GhiStage,
  from: readonly GhiStage[],
  actorId: Types.ObjectId,
  session: mongo.ClientSession,
): Promise<void> {
  await GhiCaseModel.updateOne(
    { _id: caseId, stage: { $in: from } },
    {
      $set: { stage: target, updatedBy: actorId },
      $push: {
        activity: {
          at: new Date(),
          actorId,
          message: `Stage: back to ${GHI_STAGE_LABELS[target]}`,
        },
      },
    },
    { session },
  );
}

export async function pushActivity(
  caseId: Types.ObjectId,
  actorId: Types.ObjectId,
  message: string,
  session: mongo.ClientSession,
  set: Record<string, unknown> = {},
): Promise<void> {
  await GhiCaseModel.updateOne(
    { _id: caseId },
    {
      $set: { ...set, updatedBy: actorId },
      $push: { activity: { at: new Date(), actorId, message } },
    },
    { session },
  );
}

export async function auditCase(
  actor: Actor,
  action: AuditAction,
  caseId: string,
  before: unknown,
  after: unknown,
  session?: mongo.ClientSession,
): Promise<void> {
  await writeAudit(
    {
      userId: actor.id,
      action,
      entity: AUDIT_ENTITIES.GHI_CASE,
      entityId: caseId,
      before,
      after,
      requestId: actor.requestId,
    },
    session,
  );
}

/** Names of users by id, for "by" fields. */
export async function userNames(ids: readonly (Types.ObjectId | null | undefined)[]) {
  const wanted = [...new Set(ids.filter(Boolean).map((id) => id!.toHexString()))];
  const users = await UserModel.find(
    { _id: { $in: wanted.map((id) => new Types.ObjectId(id)) } },
    { name: 1 },
  ).lean();
  return new Map(users.map((user) => [user._id.toHexString(), user.name]));
}

export function nameOf(names: ReadonlyMap<string, string>, id: Types.ObjectId | null | undefined) {
  return id ? (names.get(id.toHexString()) ?? 'Unknown user') : 'System';
}

/** Insurer names ("Company, Branch") by id. */
export async function insurerNames(ids: readonly Types.ObjectId[]) {
  const insurers = await InsurerModel.find(
    {
      _id: {
        $in: [...new Set(ids.map((id) => id.toHexString()))].map((id) => new Types.ObjectId(id)),
      },
    },
    { company: 1, branch: 1 },
  ).lean();
  return new Map(
    insurers.map((insurer) => [insurer._id.toHexString(), `${insurer.company}, ${insurer.branch}`]),
  );
}

/** The case as the API returns it. */
export async function toCaseRecord(doc: GhiCaseDoc): Promise<GhiCaseRecord> {
  const [client, insurers, names, policyFile] = await Promise.all([
    ClientModel.findById(doc.clientId).lean(),
    InsurerModel.find({ _id: { $in: doc.insurers.map((item) => item.insurerId) } }).lean(),
    userNames([
      doc.ownerId,
      ...doc.activity.map((item) => item.actorId),
      ...doc.insurers.map((item) => item.sentBy),
      doc.finalQcr?.recordedBy,
      doc.policy?.recordedBy,
    ]),
    doc.policy ? GhiFileModel.findById(doc.policy.fileId, { fileName: 1 }).lean() : null,
  ]);
  const insurerById = new Map(insurers.map((insurer) => [insurer._id.toHexString(), insurer]));
  const address = client?.address;
  const policyInsurer = doc.policy
    ? insurerById.get(doc.policy.insurerId.toHexString())
    : undefined;
  const policyInsurerName = doc.policy
    ? policyInsurer
      ? `${policyInsurer.company}, ${policyInsurer.branch}`
      : ((await insurerNames([doc.policy.insurerId])).get(doc.policy.insurerId.toHexString()) ??
        'Insurer')
    : '';
  const missing = missingRequirements(doc);
  return {
    id: doc._id.toHexString(),
    reference: doc.reference,
    type: doc.type,
    stage: doc.stage,
    closedReason: doc.closedReason,
    placed: doc.policy !== null,
    client: {
      id: doc.clientId.toHexString(),
      name: client?.name ?? 'Client no longer exists',
      gstin: client?.gstin ?? null,
      address: address
        ? [address.line1, address.line2, address.city, address.state, address.pincode]
            .filter(Boolean)
            .join(', ')
        : '',
      city: address?.city ?? '',
      state: address?.state ?? '',
      natureOfBusiness: client?.natureOfBusiness ?? '',
      contacts: (client?.contacts ?? []).flatMap((contact) =>
        contact.email ? [{ name: contact.name, email: contact.email }] : [],
      ),
    },
    owner: { id: doc.ownerId.toHexString(), name: nameOf(names, doc.ownerId) },
    policyStart: doc.policyStart,
    policyEnd: doc.policyEnd,
    dueDate: doc.dueDate,
    existingInsurer: doc.existingInsurer,
    existingPolicyNumber: doc.existingPolicyNumber,
    gstRatePercent: new Decimal(doc.gstRatePercent.toString()).toFixed(),
    requirements: requirementsOut(doc.requirements),
    missing,
    ageReferenceDate: referenceDateOf(doc),
    locked: isLocked(doc),
    requirementsRevision: doc.requirementsRevision,
    censusRevision: doc.censusRevision,
    insurers: doc.insurers.map((item) => {
      const insurer = insurerById.get(item.insurerId.toHexString());
      return {
        insurerId: item.insurerId.toHexString(),
        company: insurer?.company ?? 'Insurer no longer exists',
        branch: insurer?.branch ?? '',
        rfqEmails: insurer?.rfqEmails ?? [],
        active: insurer?.active ?? false,
        status: item.status,
        sentVia: item.sentVia,
        sentAt: item.sentAt?.toISOString() ?? null,
        sentBy: item.sentBy ? nameOf(names, item.sentBy) : null,
        dueDate: item.dueDate,
        lastDispatch: item.lastDispatch
          ? {
              at: item.lastDispatch.at.toISOString(),
              result: item.lastDispatch.result,
              error: item.lastDispatch.error,
            }
          : null,
        declineReason: item.declineReason,
      };
    }),
    finalQcr: doc.finalQcr
      ? {
          quoteId: doc.finalQcr.quoteId.toHexString(),
          qcrId: doc.finalQcr.qcrId.toHexString(),
          insurerId: doc.finalQcr.insurerId.toHexString(),
          recordedAt: doc.finalQcr.recordedAt.toISOString(),
          recordedBy: nameOf(names, doc.finalQcr.recordedBy),
        }
      : null,
    policy: doc.policy
      ? {
          policyNumber: doc.policy.policyNumber,
          issuedOn: doc.policy.issuedOn,
          policyStart: doc.policy.policyStart,
          policyEnd: doc.policy.policyEnd,
          renewalDate: doc.policy.renewalDate,
          insurerId: doc.policy.insurerId.toHexString(),
          insurerName: policyInsurerName,
          quoteId: doc.policy.quoteId.toHexString(),
          qcrId: doc.policy.qcrId.toHexString(),
          file: { id: doc.policy.fileId.toHexString(), fileName: policyFile?.fileName ?? 'Policy' },
          census: {
            employees: doc.policy.census.employees,
            lives: doc.policy.census.lives,
            totalSumInsured: new Decimal(doc.policy.census.totalSumInsured.toString()).toFixed(0),
            revision: doc.policy.census.revision,
          },
          recordedAt: doc.policy.recordedAt.toISOString(),
          recordedBy: nameOf(names, doc.policy.recordedBy),
        }
      : null,
    nextStep:
      doc.policy !== null
        ? null
        : doc.stage === 'DATA_SHEET' && missing.length > 0
          ? `Next: complete the Data Sheet (${missing.length} item${missing.length === 1 ? '' : 's'} missing) and the census.`
          : NEXT_STEP[doc.stage],
    activity: [...doc.activity].reverse().map((item) => ({
      at: item.at.toISOString(),
      actor: nameOf(names, item.actorId),
      message: item.message,
    })),
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

/** A short snapshot of a case for the audit log. */
export function caseAuditView(doc: GhiCaseDoc) {
  return {
    reference: doc.reference,
    type: doc.type,
    stage: doc.stage,
    clientId: doc.clientId.toHexString(),
    ownerId: doc.ownerId.toHexString(),
    policyStart: doc.policyStart,
    policyEnd: doc.policyEnd,
    dueDate: doc.dueDate,
    existingInsurer: doc.existingInsurer,
    existingPolicyNumber: doc.existingPolicyNumber,
  };
}
