import {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  linkDecision,
  nameKeyOf,
  type GhiGender,
} from '../../shared/index.ts';
import type { Types } from 'mongoose';
import { withTransaction } from '../../lib/db.ts';
import type { Logger } from '../../lib/logger.ts';
import { writeAudits, type AuditEntry } from '../audit/audit.service.ts';
import { GhiMemberModel } from '../ghi/ghi-census.model.ts';
import { EmployeeIdentityModel, type EmployeeIdentityDoc } from './employee.model.ts';

// The startup link of existing GHI members to employee identities (Requirements 17.10, 17.11).
// Self members without a reference are grouped by company and employee key; a group whose
// members agree with each other and with the key's identity is linked by adding the reference
// only (no other field, no updatedAt change, 16.1). A group that disagrees stays unlinked, which
// makes the employee unresolved. A second run finds nothing to do. Logs carry counts only.

const BATCH = 500;

interface GroupMember {
  id: Types.ObjectId;
  caseId: Types.ObjectId;
  employeeId: string;
  name: string;
  gender: GhiGender;
  dateOfBirth: string;
  dateOfJoining: string | null;
}

interface Group {
  _id: { clientId: Types.ObjectId; key: string };
  members: GroupMember[];
}

export async function linkEmployeeIdentities(
  logger?: Pick<Logger, 'info'>,
): Promise<{ linkedMembers: number; identitiesCreated: number; unresolved: number }> {
  const groups = await GhiMemberModel.aggregate<Group>([
    { $match: { relationship: 'SELF', employeeIdentityId: { $in: [null] } } },
    {
      $lookup: {
        from: 'ghi_cases',
        localField: 'caseId',
        foreignField: '_id',
        as: 'case',
        pipeline: [{ $project: { clientId: 1 } }],
      },
    },
    { $unwind: '$case' },
    {
      $group: {
        _id: { clientId: '$case.clientId', key: '$employeeKey' },
        members: {
          $push: {
            id: '$_id',
            caseId: '$caseId',
            employeeId: '$employeeId',
            name: '$name',
            gender: '$gender',
            dateOfBirth: '$dateOfBirth',
            dateOfJoining: '$dateOfJoining',
          },
        },
      },
    },
    { $sort: { '_id.clientId': 1, '_id.key': 1 } },
  ]);
  let linkedMembers = 0;
  let identitiesCreated = 0;
  let unresolved = 0;
  for (let start = 0; start < groups.length; start += BATCH) {
    const batch = groups.slice(start, start + BATCH);
    const outcome = await withTransaction(async (session) => {
      let linked = 0;
      let created = 0;
      let left = 0;
      const entries: AuditEntry[] = [];
      for (const group of batch) {
        const { clientId, key } = group._id;
        const existing = await EmployeeIdentityModel.findOne({ clientId, employeeKey: key })
          .session(session)
          .lean<EmployeeIdentityDoc>();
        if (linkDecision(group.members, existing) === 'UNRESOLVED') {
          left += 1;
          continue;
        }
        // The ID text and joining date come from the member on the most recent case.
        const latest = [...group.members].sort((a, b) =>
          b.caseId.toHexString().localeCompare(a.caseId.toHexString()),
        )[0]!;
        let identityId = existing?._id ?? null;
        if (!identityId) {
          const now = new Date();
          const result = await EmployeeIdentityModel.updateOne(
            { clientId, employeeKey: key },
            {
              $setOnInsert: {
                clientId,
                employeeKey: key,
                employeeId: latest.employeeId,
                name: latest.name,
                nameKey: nameKeyOf(latest.name),
                gender: latest.gender,
                dateOfBirth: latest.dateOfBirth,
                dateOfJoining: latest.dateOfJoining,
                source: 'STARTUP_LINK',
                createdBy: null,
                updatedBy: null,
                createdAt: now,
                updatedAt: now,
              },
            },
            { upsert: true, session, timestamps: false },
          );
          if (result.upsertedId) {
            identityId = result.upsertedId;
            created += 1;
            entries.push({
              userId: null,
              action: AUDIT_ACTIONS.EB_EMPLOYEE_CREATED,
              entity: AUDIT_ENTITIES.EB_EMPLOYEE,
              entityId: identityId.toHexString(),
              before: null,
              after: {
                employeeId: latest.employeeId,
                name: latest.name,
                gender: latest.gender,
                dateOfBirth: latest.dateOfBirth,
                dateOfJoining: latest.dateOfJoining,
              },
            });
          } else {
            const found = await EmployeeIdentityModel.findOne({ clientId, employeeKey: key })
              .session(session)
              .lean<EmployeeIdentityDoc>();
            identityId = found?._id ?? null;
          }
        }
        if (!identityId) continue;
        const update = await GhiMemberModel.updateMany(
          {
            _id: { $in: group.members.map((member) => member.id) },
            employeeIdentityId: { $in: [null] },
          },
          { $set: { employeeIdentityId: identityId } },
          { session, timestamps: false },
        );
        linked += update.modifiedCount;
        entries.push({
          userId: null,
          action: AUDIT_ACTIONS.EB_EMPLOYEE_LINKED,
          entity: AUDIT_ENTITIES.EB_EMPLOYEE,
          entityId: identityId.toHexString(),
          before: null,
          after: {
            employeeId: latest.employeeId,
            members: update.modifiedCount,
            cases: [...new Set(group.members.map((member) => member.caseId.toHexString()))],
          },
        });
      }
      if (entries.length > 0) await writeAudits(entries, session);
      return { linked, created, left };
    });
    linkedMembers += outcome.linked;
    identitiesCreated += outcome.created;
    unresolved += outcome.left;
  }
  logger?.info({ linkedMembers, identitiesCreated, unresolved }, 'Employee identities linked');
  return { linkedMembers, identitiesCreated, unresolved };
}
