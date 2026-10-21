import {
  CLAIM_ACTOR_KINDS,
  CLAIM_SOURCES,
  CLAIM_DOCUMENT_KINDS,
  CLAIM_EMAIL_AUDIENCES,
  CLAIM_EVENT_TYPES,
  CLAIM_NOTIFICATION_STATUSES,
  CLAIM_STATUSES,
  CLAIM_TYPES,
  GHI_RELATIONSHIPS,
  type ClaimActorKind,
  type ClaimDocumentKind,
  type ClaimEmailAudience,
  type ClaimEventType,
  type ClaimNotificationStatus,
  type ClaimSource,
  type ClaimStatus,
  type ClaimType,
  type GhiRelationship,
} from '../../shared/index.ts';
import { Schema, model, type Types } from 'mongoose';

// Group health claims (C1 to C4). The claim holds its current state; claim_events is the
// append-only history (status changes, edits, remarks, every email attempt); claim_notifications
// is the queue of emails a status change owes, sent after the change is saved.

const noId = { _id: false, versionKey: false as const, strict: true as const };
const text = { type: String, default: null };

export interface ClaimDoc {
  _id: Types.ObjectId;
  claimNumber: string;
  status: ClaimStatus;
  statusChangedAt: Date;
  source: ClaimSource;
  linkId: Types.ObjectId | null;
  clientId: Types.ObjectId;
  ghiCaseId: Types.ObjectId;
  /** The policy as it was when the claim was made. */
  policy: {
    policyNumber: string;
    insurerId: Types.ObjectId;
    policyStart: string;
    policyEnd: string;
  };
  employee: { memberId: Types.ObjectId; employeeId: string; name: string };
  patient: {
    memberId: Types.ObjectId;
    name: string;
    relationship: GhiRelationship;
    gender: string;
    dateOfBirth: string;
  };
  hospital: { name: string; city: string | null };
  admissionDate: string;
  dischargeDate: string;
  claimType: ClaimType;
  amountClaimed: Types.Decimal128;
  /** Null on a claim added by a TPA import (N11): the TPA gives no email. */
  contactEmail: string | null;
  contactPhone: string | null;
  /** N11: settlement as the TPA reports it, apart from the board status; missing before N11. */
  settlement?: {
    state: 'SETTLED' | 'NOT_SETTLED';
    amount: Types.Decimal128 | null;
    date: string | null;
    tpaStatus: string;
    updatedAt: Date;
  } | null;
  /** N11: the TPA record the claim's TPA data comes from. */
  tpa?: {
    tpaClaimRecordId: Types.ObjectId;
    tpaCode: string;
    tpaClaimId: string;
    sourceStatus: string;
    importId: Types.ObjectId;
    importedAt: Date;
  } | null;
  assignedTo: Types.ObjectId | null;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const claimSchema = new Schema<ClaimDoc>(
  {
    claimNumber: { type: String, required: true },
    status: { type: String, enum: CLAIM_STATUSES, required: true },
    statusChangedAt: { type: Date, required: true },
    source: { type: String, enum: CLAIM_SOURCES, required: true },
    linkId: { type: Schema.Types.ObjectId, ref: 'ClaimLink', default: null },
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true },
    ghiCaseId: { type: Schema.Types.ObjectId, ref: 'GhiCase', required: true },
    policy: {
      type: new Schema(
        {
          policyNumber: { type: String, required: true },
          insurerId: { type: Schema.Types.ObjectId, ref: 'Insurer', required: true },
          policyStart: { type: String, required: true },
          policyEnd: { type: String, required: true },
        },
        noId,
      ),
      required: true,
    },
    employee: {
      type: new Schema(
        {
          memberId: { type: Schema.Types.ObjectId, ref: 'GhiMember', required: true },
          employeeId: { type: String, required: true },
          name: { type: String, required: true },
        },
        noId,
      ),
      required: true,
    },
    patient: {
      type: new Schema(
        {
          memberId: { type: Schema.Types.ObjectId, ref: 'GhiMember', required: true },
          name: { type: String, required: true },
          relationship: { type: String, enum: GHI_RELATIONSHIPS, required: true },
          gender: { type: String, required: true },
          dateOfBirth: { type: String, required: true },
        },
        noId,
      ),
      required: true,
    },
    hospital: {
      type: new Schema({ name: { type: String, required: true }, city: text }, noId),
      required: true,
    },
    admissionDate: { type: String, required: true },
    dischargeDate: { type: String, required: true },
    claimType: { type: String, enum: CLAIM_TYPES, required: true },
    amountClaimed: { type: Schema.Types.Decimal128, required: true },
    contactEmail: text,
    contactPhone: text,
    settlement: {
      type: new Schema(
        {
          state: { type: String, enum: ['SETTLED', 'NOT_SETTLED'], required: true },
          amount: { type: Schema.Types.Decimal128, default: null },
          date: text,
          tpaStatus: { type: String, required: true },
          updatedAt: { type: Date, required: true },
        },
        noId,
      ),
      default: undefined,
    },
    tpa: {
      type: new Schema(
        {
          tpaClaimRecordId: { type: Schema.Types.ObjectId, ref: 'TpaClaim', required: true },
          tpaCode: { type: String, required: true },
          tpaClaimId: { type: String, required: true },
          sourceStatus: { type: String, required: true },
          importId: { type: Schema.Types.ObjectId, ref: 'TpaImport', required: true },
          importedAt: { type: Date, required: true },
        },
        noId,
      ),
      default: undefined,
    },
    assignedTo: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { collection: 'claims', timestamps: true, strict: 'throw' },
);
claimSchema.index({ claimNumber: 1 }, { unique: true });
claimSchema.index({ status: 1, statusChangedAt: 1 });
claimSchema.index({ clientId: 1, createdAt: -1 });
claimSchema.index({ createdAt: -1, _id: -1 });
claimSchema.index({ linkId: 1 });
// N11: the board claims of a policy's census member on an admission date (linking TPA records).
claimSchema.index({ ghiCaseId: 1, 'patient.memberId': 1, admissionDate: 1 });

export const ClaimModel = model<ClaimDoc>('Claim', claimSchema);

/** A supporting document. Read back only through its claim, by staff who may view claims. */
export interface ClaimFileDoc {
  _id: Types.ObjectId;
  claimId: Types.ObjectId;
  kind: ClaimDocumentKind;
  fileName: string;
  contentType: string;
  size: number;
  sha256: string;
  data: Buffer;
  uploadedBy: Types.ObjectId | null;
  uploadedVia: 'STAFF' | 'EMPLOYEE_LINK';
  createdAt: Date;
}

const claimFileSchema = new Schema<ClaimFileDoc>(
  {
    claimId: { type: Schema.Types.ObjectId, ref: 'Claim', required: true },
    kind: { type: String, enum: CLAIM_DOCUMENT_KINDS, required: true },
    fileName: { type: String, required: true },
    contentType: { type: String, required: true },
    size: { type: Number, required: true },
    sha256: { type: String, required: true },
    data: { type: Buffer, required: true },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    uploadedVia: { type: String, enum: ['STAFF', 'EMPLOYEE_LINK'], required: true },
  },
  { collection: 'claim_files', timestamps: { createdAt: true, updatedAt: false }, strict: 'throw' },
);
claimFileSchema.index({ claimId: 1, _id: 1 });

export const ClaimFileModel = model<ClaimFileDoc>('ClaimFile', claimFileSchema);

/** One event in a claim's history. Append-only: an event is never changed or removed. */
export interface ClaimEventDoc {
  _id: Types.ObjectId;
  claimId: Types.ObjectId;
  type: ClaimEventType;
  at: Date;
  actorKind: ClaimActorKind;
  actorId: Types.ObjectId | null;
  fromStatus: ClaimStatus | null;
  toStatus: ClaimStatus | null;
  remark: string | null;
  changes: Array<{ field: string; before: string | null; after: string | null }>;
  email: {
    notificationId: Types.ObjectId;
    audience: ClaimEmailAudience;
    recipient: string;
    subject: string;
    attempt: number;
    result: 'ACCEPTED' | 'OUTBOX' | 'FAILED';
    error: string | null;
    messageId: string | null;
  } | null;
  /** Free detail for the description (a document's name, the assignee's name). */
  detail: string | null;
}

const claimEventSchema = new Schema<ClaimEventDoc>(
  {
    claimId: { type: Schema.Types.ObjectId, ref: 'Claim', required: true },
    type: { type: String, enum: CLAIM_EVENT_TYPES, required: true },
    at: { type: Date, required: true },
    actorKind: { type: String, enum: CLAIM_ACTOR_KINDS, required: true },
    actorId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    fromStatus: { type: String, enum: [...CLAIM_STATUSES, null], default: null },
    toStatus: { type: String, enum: [...CLAIM_STATUSES, null], default: null },
    remark: text,
    changes: [
      new Schema({ field: { type: String, required: true }, before: text, after: text }, noId),
    ],
    email: {
      type: new Schema(
        {
          notificationId: { type: Schema.Types.ObjectId, ref: 'ClaimNotification', required: true },
          audience: { type: String, enum: CLAIM_EMAIL_AUDIENCES, required: true },
          recipient: { type: String, required: true },
          subject: { type: String, required: true },
          attempt: { type: Number, required: true },
          result: { type: String, enum: ['ACCEPTED', 'OUTBOX', 'FAILED'], required: true },
          error: text,
          messageId: text,
        },
        noId,
      ),
      default: null,
    },
    detail: text,
  },
  { collection: 'claim_events', versionKey: false, minimize: false, strict: 'throw' },
);
claimEventSchema.index({ claimId: 1, at: 1, _id: 1 });

function rejectMutation(): never {
  throw new Error('claim_events is append-only: updates and deletes are not allowed');
}
claimEventSchema.pre(
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
claimEventSchema.pre(['updateOne', 'deleteOne'], { document: true, query: false }, rejectMutation);
claimEventSchema.pre('save', function rejectResave() {
  if (!this.isNew) rejectMutation();
});

export const ClaimEventModel = model<ClaimEventDoc>('ClaimEvent', claimEventSchema);

/**
 * An email a status change owes one recipient. Written in the same transaction as the change,
 * then sent; its content is fixed when queued. One per event and address, so a retry can never
 * queue the same mail twice.
 */
export interface ClaimNotificationDoc {
  _id: Types.ObjectId;
  claimId: Types.ObjectId;
  eventId: Types.ObjectId;
  audience: ClaimEmailAudience;
  recipient: string;
  recipientName: string | null;
  toStatus: ClaimStatus;
  templateVersion: number;
  subject: string;
  text: string;
  html: string;
  status: ClaimNotificationStatus;
  attempts: number;
  lastAttemptAt: Date | null;
  nextAttemptAt: Date | null;
  /** Set while being sent; a send left half-way (a crash) is retried after it goes stale. */
  sendingSince: Date | null;
  error: string | null;
  messageId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const claimNotificationSchema = new Schema<ClaimNotificationDoc>(
  {
    claimId: { type: Schema.Types.ObjectId, ref: 'Claim', required: true },
    eventId: { type: Schema.Types.ObjectId, ref: 'ClaimEvent', required: true },
    audience: { type: String, enum: CLAIM_EMAIL_AUDIENCES, required: true },
    recipient: { type: String, required: true },
    recipientName: text,
    toStatus: { type: String, enum: CLAIM_STATUSES, required: true },
    templateVersion: { type: Number, required: true },
    subject: { type: String, required: true },
    text: { type: String, required: true },
    html: { type: String, required: true },
    status: { type: String, enum: CLAIM_NOTIFICATION_STATUSES, required: true },
    attempts: { type: Number, required: true, default: 0 },
    lastAttemptAt: { type: Date, default: null },
    nextAttemptAt: { type: Date, default: null },
    sendingSince: { type: Date, default: null },
    error: text,
    messageId: text,
  },
  { collection: 'claim_notifications', timestamps: true, strict: 'throw' },
);
claimNotificationSchema.index({ eventId: 1, recipient: 1 }, { unique: true });
claimNotificationSchema.index({ claimId: 1, createdAt: 1 });
claimNotificationSchema.index({ status: 1, nextAttemptAt: 1 });

export const ClaimNotificationModel = model<ClaimNotificationDoc>(
  'ClaimNotification',
  claimNotificationSchema,
);
