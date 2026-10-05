import { Schema, model, type Types } from 'mongoose';

export const AUDIT_ACTIONS = {
  LOGIN_SUCCEEDED: 'AUTH_LOGIN_SUCCEEDED',
  LOGIN_FAILED: 'AUTH_LOGIN_FAILED',
  LOGOUT: 'AUTH_LOGOUT',
  USER_CREATED: 'USER_CREATED',
  USER_UPDATED: 'USER_UPDATED',
  MASTER_IMPORTED: 'MASTER_IMPORTED',
  MASTER_ACTIVATED: 'MASTER_ACTIVATED',
} as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export const AUDIT_ENTITIES = {
  USER: 'user',
  MASTER_VERSION: 'master_version',
} as const;
export type AuditEntity = (typeof AUDIT_ENTITIES)[keyof typeof AUDIT_ENTITIES];

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

auditLogSchema.index({ at: -1 });
auditLogSchema.index({ entity: 1, entityId: 1, at: -1 });
auditLogSchema.index({ userId: 1, at: -1 });

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
