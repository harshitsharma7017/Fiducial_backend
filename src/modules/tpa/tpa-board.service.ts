import {
  AUDIT_ACTIONS,
  CLAIM_STATUSES,
  CLAIM_STATUS_LABELS,
  DEFAULT_CLAIM_IMPORT_SETTINGS,
  boardStatusFor,
  type ClaimImportSettings,
  type ClaimStatus,
} from '../../shared/index.ts';
import { Schema, Types, model } from 'mongoose';
import { withTransaction } from '../../lib/db.ts';
import { Decimal } from '../../lib/decimal.ts';
import { writeAudit } from '../audit/audit.service.ts';
import { auditClaim } from '../claims/claim-common.ts';
import { ClaimEventModel, ClaimModel, type ClaimDoc } from '../claims/claim.model.ts';
import { dispatchClaim, enqueueStatusEmails } from '../claims/claim-notifications.ts';
import { claimAuditView, nextClaimNumber } from '../claims/claims.service.ts';
import { GhiCaseModel, type GhiCaseDoc } from '../ghi/ghi-case.model.ts';
import { GhiMemberModel } from '../ghi/ghi-census.model.ts';
import { nameOf, userNames, type Actor } from '../ghi/ghi-common.ts';
import type { MailTransport } from '../mail/transport.ts';
import { TpaClaimModel, type TpaClaimDoc, type TpaImportDoc } from './tpa.model.ts';

// TPA claims on the claims board (N11). After an import, each created or updated TPA record
// moves its board claim to the column its TPA status maps to (only forward, by default), records
// its settlement apart from the column, and keeps its TPA provenance. A matched GMC claim that is
// not on the board is added. Board details staff maintain are never changed. Every real change
// is a timeline event and an audit entry; emails follow the import settings (off by default).

// Settings

interface ClaimImportSettingsDoc {
  _id: string;
  notifyOnImportStatusChange: boolean;
  notifyOnImportCreate: boolean;
  updatedAt: Date;
  updatedBy: Types.ObjectId | null;
}
const settingsSchema = new Schema<ClaimImportSettingsDoc>(
  {
    _id: { type: String, required: true },
    notifyOnImportStatusChange: { type: Boolean, required: true },
    notifyOnImportCreate: { type: Boolean, required: true },
    updatedAt: { type: Date, required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { collection: 'claim_import_settings', versionKey: false, strict: 'throw' },
);
export const ClaimImportSettingsModel = model<ClaimImportSettingsDoc>(
  'ClaimImportSettings',
  settingsSchema,
);

export async function claimImportSettings() {
  const doc = await ClaimImportSettingsModel.findById('default').lean();
  if (!doc) return { ...DEFAULT_CLAIM_IMPORT_SETTINGS, updatedAt: null, updatedBy: null };
  const names = await userNames([doc.updatedBy]);
  return {
    notifyOnImportStatusChange: doc.notifyOnImportStatusChange,
    notifyOnImportCreate: doc.notifyOnImportCreate,
    updatedAt: doc.updatedAt.toISOString(),
    updatedBy: doc.updatedBy ? nameOf(names, doc.updatedBy) : null,
  };
}

export async function setClaimImportSettings(input: ClaimImportSettings, actor: Actor) {
  const before = await claimImportSettings();
  await withTransaction(async (session) => {
    await ClaimImportSettingsModel.updateOne(
      { _id: 'default' },
      { $set: { ...input, updatedAt: new Date(), updatedBy: new Types.ObjectId(actor.id) } },
      { upsert: true, session },
    );
    await writeAudit(
      {
        userId: actor.id,
        action: AUDIT_ACTIONS.CLAIM_IMPORT_SETTINGS_UPDATED,
        entity: 'claim',
        entityId: 'import-settings',
        before: {
          notifyOnImportStatusChange: before.notifyOnImportStatusChange,
          notifyOnImportCreate: before.notifyOnImportCreate,
        },
        after: input,
        requestId: actor.requestId,
      },
      session,
    );
  });
  return claimImportSettings();
}

// Board sync

export interface BoardResult {
  created: number;
  moved: number;
  settlementUpdated: number;
  unchanged: number;
  notMapped: number;
  review: number;
  failed: number;
  emailsQueued: number;
  unmapped: Map<string, number>;
}
export const emptyBoardResult = (): BoardResult => ({
  created: 0,
  moved: 0,
  settlementUpdated: 0,
  unchanged: 0,
  notMapped: 0,
  review: 0,
  failed: 0,
  emailsQueued: 0,
  unmapped: new Map(),
});

const rank = (status: ClaimStatus) => CLAIM_STATUSES.indexOf(status);
const money = (value: Types.Decimal128 | null | undefined) =>
  value ? new Decimal(value.toString()).toFixed(2) : null;

function settlementOf(record: TpaClaimDoc, now: Date) {
  return {
    state: record.status === 'SETTLED' ? ('SETTLED' as const) : ('NOT_SETTLED' as const),
    amount: record.status === 'SETTLED' ? record.settledAmount : null,
    date: record.status === 'SETTLED' ? record.settlementDate : null,
    tpaStatus: record.sourceStatus,
    updatedAt: now,
  };
}

const sameSettlement = (a: ClaimDoc['settlement'], b: ReturnType<typeof settlementOf>) =>
  Boolean(a) &&
  a!.state === b.state &&
  money(a!.amount) === money(b.amount) &&
  a!.date === b.date &&
  a!.tpaStatus === b.tpaStatus;

/** Why a record cannot go on the board, or null when it can. */
function blockerOf(record: TpaClaimDoc, doc: GhiCaseDoc): string | null {
  if ((doc.product ?? 'GMC') !== 'GMC' || !doc.policy)
    return 'The claims board holds placed GMC policies only';
  if (record.board.state === 'AMBIGUOUS')
    return 'Several board claims fit this claim, or its board claim follows another TPA claim: link it by hand';
  if (record.member.match !== 'MATCHED' || !record.member.memberId)
    return 'The patient is not matched to the census: review it';
  if (record.requestType === 'PRE_AUTH' && record.parent.id) return null;
  const missing = [
    record.admissionDate ? null : 'admission date',
    record.hospital ? null : 'hospital',
    record.claimType ? null : 'cashless or reimbursement',
    record.claimedAmount && new Decimal(record.claimedAmount.toString()).gt(0)
      ? null
      : 'claimed amount',
  ].filter(Boolean);
  return missing.length > 0
    ? `Not added to the board: the TPA file has no ${missing.join(', ')}`
    : null;
}

/**
 * Brings the board in line with the TPA records an import created or updated. Each record is
 * handled in its own transaction (its board claim, events and audit together); a failure is
 * counted and leaves the TPA record as imported.
 */
export async function syncBoard(
  importDoc: TpaImportDoc,
  ids: readonly Types.ObjectId[],
  actor: Actor,
  transport: MailTransport | null,
): Promise<BoardResult> {
  const result = emptyBoardResult();
  if (ids.length === 0) return result;
  const settings = await claimImportSettings();
  const doc = await GhiCaseModel.findById(importDoc.caseId).lean<GhiCaseDoc>();
  if (!doc) return result;
  const rules = {
    boardStatusMap: importDoc.format.boardStatusMap ?? [],
    boardStatusOverrides: importDoc.format.boardStatusOverrides ?? [],
  };
  const forwardOnly = (importDoc.format.boardUpdate ?? 'FORWARD_ONLY') === 'FORWARD_ONLY';
  const actorId = new Types.ObjectId(actor.id);
  // Only attribution: the import already checked the user's permission.
  const claimActor = {
    id: actor.id,
    permissions: new Set<never>(),
    requestId: actor.requestId,
    kind: 'STAFF' as const,
  };
  const toDispatch: Types.ObjectId[] = [];
  const records = await TpaClaimModel.find({ _id: { $in: ids } }).lean<TpaClaimDoc[]>();
  for (const record of records) {
    const target = boardStatusFor(rules, doc.clientId.toHexString(), record.sourceStatus);
    if (!target)
      result.unmapped.set(record.sourceStatus, (result.unmapped.get(record.sourceStatus) ?? 0) + 1);
    try {
      await withTransaction(async (session) => {
        const now = new Date();
        const settlement = settlementOf(record, now);
        const provenance = {
          tpaClaimRecordId: record._id,
          tpaCode: record.tpaCode,
          tpaClaimId: record.tpaClaimId,
          sourceStatus: record.sourceStatus,
          importId: importDoc._id,
          importedAt: now,
        };
        const decisionText = (willEmail: boolean, setting: string) =>
          willEmail ? 'emails queued' : `no email: ${setting} is off (open question N11-2)`;
        if (record.board.claimId) {
          const claim = await ClaimModel.findById(record.board.claimId)
            .session(session)
            .lean<ClaimDoc>();
          if (!claim) {
            result.review += 1;
            return;
          }
          const move =
            target !== null &&
            importDoc.format.boardUpdate !== 'NEVER' &&
            (forwardOnly ? rank(target) > rank(claim.status) : target !== claim.status);
          const settlementChanged = !sameSettlement(claim.settlement, settlement);
          const tpaChanged = claim.tpa?.sourceStatus !== record.sourceStatus || !claim.tpa;
          if (!move && !settlementChanged && !tpaChanged) {
            result.unchanged += 1;
            if (!target) result.notMapped += 1;
            return;
          }
          const set: Record<string, unknown> = { settlement, tpa: provenance, updatedBy: actorId };
          if (move) Object.assign(set, { status: target, statusChangedAt: now });
          const updated = await ClaimModel.findOneAndUpdate(
            { _id: claim._id, status: claim.status },
            { $set: set },
            { session, returnDocument: 'after' },
          ).lean<ClaimDoc>();
          if (!updated) throw new Error('The board claim changed meanwhile');
          const willEmail = move && settings.notifyOnImportStatusChange;
          const changes = [
            ...(settlementChanged
              ? [
                  {
                    field: 'settlement',
                    before: claim.settlement?.state ?? null,
                    after: `${settlement.state}${settlement.amount ? ` ₹${money(settlement.amount)}` : ''}`,
                  },
                ]
              : []),
            ...(tpaChanged
              ? [
                  {
                    field: 'tpaStatus',
                    before: claim.tpa?.sourceStatus ?? null,
                    after: record.sourceStatus,
                  },
                ]
              : []),
          ];
          const [event] = await ClaimEventModel.create(
            [
              {
                claimId: claim._id,
                type: 'TPA_IMPORT',
                at: now,
                actorKind: 'SYSTEM',
                actorId,
                fromStatus: claim.status,
                toStatus: move ? target : claim.status,
                remark: null,
                changes,
                email: null,
                detail: `${importDoc.fileName}, TPA status "${record.sourceStatus}"${move ? `; ${decisionText(willEmail, 'import status-change email')}` : ''}${!target ? '; the TPA status has no board column' : ''}`,
              },
            ],
            { session },
          );
          if (move) {
            result.moved += 1;
            await auditClaim(
              claimActor,
              AUDIT_ACTIONS.CLAIM_STATUS_CHANGED,
              claim._id.toHexString(),
              { status: claim.status },
              { status: target, source: 'TPA_IMPORT', importId: importDoc._id.toHexString() },
              session,
            );
            if (willEmail && target) {
              await enqueueStatusEmails(
                updated,
                {
                  eventId: event!._id,
                  from: claim.status,
                  to: target,
                  remark: `Updated by ${record.tpaCode}`,
                  at: now,
                },
                session,
              );
              result.emailsQueued += 1;
              toDispatch.push(claim._id);
            }
          } else if (settlementChanged) result.settlementUpdated += 1;
          else result.unchanged += 1;
          if (!target) result.notMapped += 1;
          return;
        }
        // Not on the board yet.
        const blocker = blockerOf(record, doc);
        if (record.requestType === 'PRE_AUTH' && record.parent.id && !blocker) {
          // A pre-authorisation of a main claim follows its main claim on the board.
          result.unchanged += 1;
          return;
        }
        if (blocker || !target || importDoc.format.createBoardClaims === false) {
          const note =
            blocker ??
            (!target
              ? `The TPA status "${record.sourceStatus}" has no board column: map it in the TPA format`
              : 'This format does not add claims to the board');
          await TpaClaimModel.updateOne(
            { _id: record._id },
            { $set: { boardNote: note } },
            { session },
          );
          if (!target && !blocker) result.notMapped += 1;
          else result.review += 1;
          return;
        }
        // One operation at a time: a transaction's session takes no parallel commands.
        const patient = await GhiMemberModel.findById(record.member.memberId)
          .session(session)
          .lean();
        const employee = await GhiMemberModel.findOne({
          caseId: doc._id,
          relationship: 'SELF',
          employeeKey: record.employeeId ? record.employeeId.replace(/\s+/g, '').toUpperCase() : '',
        })
          .session(session)
          .lean();
        const self = employee ?? (patient?.relationship === 'SELF' ? patient : null);
        if (!patient || !self) {
          await TpaClaimModel.updateOne(
            { _id: record._id },
            { $set: { boardNote: 'The employee’s own census row is not found: review it' } },
            { session },
          );
          result.review += 1;
          return;
        }
        const claimId = new Types.ObjectId();
        const created = {
          _id: claimId,
          claimNumber: await nextClaimNumber(session),
          status: target,
          statusChangedAt: now,
          source: 'TPA_IMPORT' as const,
          linkId: null,
          clientId: doc.clientId,
          ghiCaseId: doc._id,
          policy: {
            policyNumber: doc.policy!.policyNumber,
            insurerId: doc.policy!.insurerId,
            policyStart: doc.policy!.policyStart,
            policyEnd: doc.policy!.policyEnd,
          },
          employee: { memberId: self._id, employeeId: self.employeeId, name: self.name },
          patient: {
            memberId: patient._id,
            name: patient.name,
            relationship: patient.relationship,
            gender: patient.gender,
            dateOfBirth: patient.dateOfBirth,
          },
          hospital: { name: record.hospital!, city: record.hospitalCity },
          admissionDate: record.admissionDate!,
          dischargeDate: record.dischargeDate ?? record.admissionDate!,
          claimType: record.claimType!,
          amountClaimed: record.claimedAmount!,
          contactEmail: null,
          contactPhone: null,
          assignedTo: null,
          settlement,
          tpa: provenance,
          createdBy: actorId,
          updatedBy: actorId,
        };
        await ClaimModel.create([created], { session });
        const willEmail = settings.notifyOnImportCreate && target !== 'FORM';
        const [event] = await ClaimEventModel.create(
          [
            {
              claimId,
              type: 'CREATED',
              at: now,
              actorKind: 'SYSTEM',
              actorId,
              fromStatus: null,
              toStatus: target,
              remark: null,
              changes: [],
              email: null,
              detail: `From TPA import ${importDoc.fileName} (TPA status "${record.sourceStatus}"); ${decisionText(willEmail, 'import creation email')}`,
            },
          ],
          { session },
        );
        await TpaClaimModel.updateOne(
          { _id: record._id },
          { $set: { board: { state: 'LINKED', claimId }, boardNote: null } },
          { session },
        );
        await auditClaim(
          claimActor,
          AUDIT_ACTIONS.CLAIM_CREATED,
          claimId.toHexString(),
          null,
          {
            ...claimAuditView(created),
            source: 'TPA_IMPORT',
            importId: importDoc._id.toHexString(),
          },
          session,
        );
        if (willEmail) {
          await enqueueStatusEmails(
            created as unknown as ClaimDoc,
            {
              eventId: event!._id,
              from: target,
              to: target,
              remark: `Added by ${record.tpaCode}`,
              at: now,
            },
            session,
          );
          result.emailsQueued += 1;
          toDispatch.push(claimId);
        }
        result.created += 1;
      });
    } catch {
      // Counted, and left for review on the record; the error itself may quote data, so it is not kept.
      result.failed += 1;
      await TpaClaimModel.updateOne(
        { _id: record._id },
        {
          $set: {
            boardNote:
              'The claims board could not be updated for this claim: import the file again or link it by hand',
          },
        },
      ).catch(() => undefined);
    }
  }
  if (transport) for (const id of toDispatch) await dispatchClaim(id, transport);
  return result;
}

export const boardStatusLabel = (status: ClaimStatus) => CLAIM_STATUS_LABELS[status];
