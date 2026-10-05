import { Types, type mongo } from 'mongoose';
import { AuditLogModel, type AuditAction, type AuditEntity } from './audit.model.ts';

export interface AuditEntry {
  userId?: string | null;
  action: AuditAction;
  entity: AuditEntity;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  requestId?: string | null;
}

/**
 * Appends one audit entry. Pass the session when the audited change runs in a transaction,
 * so the change and its audit entry commit or roll back together.
 */
export async function writeAudit(entry: AuditEntry, session?: mongo.ClientSession): Promise<void> {
  await AuditLogModel.create(
    [
      {
        at: new Date(),
        userId: entry.userId ? new Types.ObjectId(entry.userId) : null,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId ?? null,
        before: entry.before ?? null,
        after: entry.after ?? null,
        requestId: entry.requestId ?? null,
      },
    ],
    { session },
  );
}
