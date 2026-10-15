import {
  CLAIM_EMAIL_AUDIENCES,
  CLAIM_STATUSES,
  type ClaimEmailAudience,
  type ClaimStatus,
} from '../../shared/index.ts';
import { Schema, model, type Types } from 'mongoose';

/**
 * A single-purpose link for an employee to submit claims (C2): for one employee of one placed
 * policy, until it expires or its claims are used. Only the token's SHA-256 hash is kept.
 */
export interface ClaimLinkDoc {
  _id: Types.ObjectId;
  tokenHash: string;
  ghiCaseId: Types.ObjectId;
  clientId: Types.ObjectId;
  employeeMemberId: Types.ObjectId;
  expiresAt: Date;
  maxClaims: number;
  usedClaims: number;
  revokedAt: Date | null;
  revokedBy: Types.ObjectId | null;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const claimLinkSchema = new Schema<ClaimLinkDoc>(
  {
    tokenHash: { type: String, required: true },
    ghiCaseId: { type: Schema.Types.ObjectId, ref: 'GhiCase', required: true },
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true },
    employeeMemberId: { type: Schema.Types.ObjectId, ref: 'GhiMember', required: true },
    expiresAt: { type: Date, required: true },
    maxClaims: { type: Number, required: true, min: 1 },
    usedClaims: { type: Number, required: true, default: 0, min: 0 },
    revokedAt: { type: Date, default: null },
    revokedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { collection: 'claim_links', timestamps: true, strict: 'throw' },
);
claimLinkSchema.index({ tokenHash: 1 }, { unique: true });
claimLinkSchema.index({ ghiCaseId: 1, createdAt: -1 });

export const ClaimLinkModel = model<ClaimLinkDoc>('ClaimLink', claimLinkSchema);

/** An Admin-edited claim email, per status moved into and audience (C3). */
export interface ClaimEmailTemplateDoc {
  _id: Types.ObjectId;
  status: ClaimStatus;
  audience: ClaimEmailAudience;
  subject: string;
  body: string;
  version: number;
  isDefault: boolean;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const claimEmailTemplateSchema = new Schema<ClaimEmailTemplateDoc>(
  {
    status: { type: String, enum: CLAIM_STATUSES, required: true },
    audience: { type: String, enum: CLAIM_EMAIL_AUDIENCES, required: true },
    subject: { type: String, required: true },
    body: { type: String, required: true },
    version: { type: Number, required: true, min: 1 },
    isDefault: { type: Boolean, required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { collection: 'claim_email_templates', timestamps: true, strict: 'throw' },
);
claimEmailTemplateSchema.index({ status: 1, audience: 1 }, { unique: true });

export const ClaimEmailTemplateModel = model<ClaimEmailTemplateDoc>(
  'ClaimEmailTemplate',
  claimEmailTemplateSchema,
);

/** The company's HR contact for claim emails (C3), per client. */
export interface ClaimHrContactDoc {
  _id: Types.ObjectId;
  clientId: Types.ObjectId;
  name: string | null;
  email: string | null;
  notify: boolean;
  updatedBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const claimHrContactSchema = new Schema<ClaimHrContactDoc>(
  {
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true },
    name: { type: String, default: null },
    email: { type: String, default: null },
    notify: { type: Boolean, required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { collection: 'claim_hr_contacts', timestamps: true, strict: 'throw' },
);
claimHrContactSchema.index({ clientId: 1 }, { unique: true });

export const ClaimHrContactModel = model<ClaimHrContactDoc>('ClaimHrContact', claimHrContactSchema);
