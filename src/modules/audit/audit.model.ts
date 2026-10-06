import {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  type AuditAction,
  type AuditEntity,
} from '../../shared/index.ts';
import { Schema, model, type Types } from 'mongoose';

// The action and entity vocabularies live in src/shared/audit.ts, so the web app can label and
// filter them.

export interface AuditLogDoc {
  _id: Types.ObjectId;
  at: Date;
  /** Who acted. Null for unauthenticated events (failed sign-in) and CLI runs without --by. */
  userId: Types.ObjectId | null;
  action: AuditAction;
  entity: AuditEntity;
  entityId: string | null;
  before: unknown;
  after: unknown;
  requestId: string | null;
}

const auditLogSchema = new Schema<AuditLogDoc>(
  {
    at: { type: Date, required: true, default: () => new Date() },
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    action: { type: String, required: true, enum: Object.values(AUDIT_ACTIONS) },
    entity: { type: String, required: true, enum: Object.values(AUDIT_ENTITIES) },
    entityId: { type: String, default: null },
    before: { type: Schema.Types.Mixed, default: null },
    after: { type: Schema.Types.Mixed, default: null },
    requestId: { type: String, default: null },
  },
  { collection: 'audit_logs', versionKey: false, minimize: false, strict: 'throw' },
);

// Newest first, by record, by actor and by action (the log's filters).
auditLogSchema.index({ at: -1 });
auditLogSchema.index({ entity: 1, entityId: 1, at: -1 });
auditLogSchema.index({ userId: 1, at: -1 });
auditLogSchema.index({ action: 1, at: -1 });

// The audit log is append-only. There is no update or delete code path; these hooks make an
// accidental one fail loudly. (Production should also grant the app insert and read rights only.)
function rejectMutation(): never {
  throw new Error('audit_logs is append-only: updates and deletes are not allowed');
}

auditLogSchema.pre(
  [
    'updateOne',
    'updateMany',
    'findOneAndUpdate',
    'findOneAndReplace',
    'replaceOne',
    'deleteOne',
    'deleteMany',
    'findOneAndDelete',
  ],
  { document: false, query: true },
  rejectMutation,
);
auditLogSchema.pre(['updateOne', 'deleteOne'], { document: true, query: false }, rejectMutation);
auditLogSchema.pre('save', function rejectResave() {
  if (!this.isNew) rejectMutation();
});

export const AuditLogModel = model<AuditLogDoc>('AuditLog', auditLogSchema);
