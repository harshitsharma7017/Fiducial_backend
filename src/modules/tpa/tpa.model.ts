import {
  CLAIM_STATUSES,
  GHI_RELATIONSHIPS,
  TPA_BOARD_LINKS,
  TPA_CLAIM_FIELDS,
  TPA_CLAIM_STATUSES,
  TPA_CLAIM_TYPES,
  TPA_IMPORT_POLICIES,
  TPA_IMPORT_STATUSES,
  TPA_MEMBER_MATCHES,
  TPA_PARENT_LINKS,
  TPA_REQUEST_TYPES,
  TPA_ROW_ACTIONS,
  type ClaimStatus,
  type EbProduct,
  type GhiRelationship,
  type TpaBoardLink,
  type TpaClaimField,
  type TpaClaimStatus,
  type TpaClaimType,
  type TpaImportPolicy,
  type TpaImportStatus,
  type TpaMemberMatch,
  type TpaParentLink,
  type TpaRequestType,
  type TpaRowAction,
  type TpaRowIssue,
} from '../../shared/index.ts';
import { Schema, model, type Types } from 'mongoose';

// TPA claims (N9). tpa_formats: how a TPA's export maps to claim fields. tpa_imports and
// tpa_import_rows: an uploaded file, checked row by row (one document per row, so a large file
// never nears the document size limit). tpa_claims: one record per policy, TPA and claim ID
// (unique), updated in place on re-import. tpa_claim_events: its append-only history.

const noId = { _id: false, versionKey: false as const, strict: true as const };
const text = { type: String, default: null };

export interface TpaFormatDoc {
  _id: Types.ObjectId;
  name: string;
  nameKey: string;
  tpaCode: string;
  description: string | null;
  sheetName: string | null;
  headerRow: number;
  mappings: Array<{ field: TpaClaimField; header: string; required: boolean }>;
  statusMap: Array<{ source: string; status: TpaClaimStatus }>;
  requestTypeMap: Array<{ source: string; requestType: TpaRequestType }>;
  claimTypeMap: Array<{ source: string; claimType: TpaClaimType }>;
  relationshipMap: Array<{ source: string; relationship: GhiRelationship }>;
  keepColumns: string[];
  requireMemberMatch: boolean;
  /** N11: board columns for TPA statuses; missing on formats saved before N11 (none mapped). */
  boardStatusMap?: Array<{ source: string; boardStatus: ClaimStatus }>;
  boardStatusOverrides?: Array<{ clientId: string; source: string; boardStatus: ClaimStatus }>;
  boardUpdate?: 'FORWARD_ONLY' | 'NEVER';
  createBoardClaims?: boolean;
  active: boolean;
  revision: number;
  createdBy: Types.ObjectId;
  updatedBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const tpaFormatSchema = new Schema<TpaFormatDoc>(
  {
    name: { type: String, required: true },
    nameKey: { type: String, required: true },
    tpaCode: { type: String, required: true },
    description: text,
    sheetName: text,
    headerRow: { type: Number, required: true, min: 1 },
    mappings: [
      new Schema(
        {
          field: { type: String, enum: TPA_CLAIM_FIELDS, required: true },
          header: { type: String, required: true },
          required: { type: Boolean, required: true },
        },
        noId,
      ),
    ],
    statusMap: [
      new Schema(
        {
          source: { type: String, required: true },
          status: { type: String, enum: TPA_CLAIM_STATUSES, required: true },
        },
        noId,
      ),
    ],
    requestTypeMap: [
      new Schema(
        {
          source: { type: String, required: true },
          requestType: { type: String, enum: TPA_REQUEST_TYPES, required: true },
        },
        noId,
      ),
    ],
    claimTypeMap: [
      new Schema(
        {
          source: { type: String, required: true },
          claimType: { type: String, enum: TPA_CLAIM_TYPES, required: true },
        },
        noId,
      ),
    ],
    relationshipMap: [
      new Schema(
        {
          source: { type: String, required: true },
          relationship: { type: String, enum: GHI_RELATIONSHIPS, required: true },
        },
        noId,
      ),
    ],
    keepColumns: { type: [String], default: [] },
    requireMemberMatch: { type: Boolean, required: true, default: false },
    boardStatusMap: [
      new Schema(
        {
          source: { type: String, required: true },
          boardStatus: { type: String, enum: CLAIM_STATUSES, required: true },
        },
        noId,
      ),
    ],
    boardStatusOverrides: [
      new Schema(
        {
          clientId: { type: String, required: true },
          source: { type: String, required: true },
          boardStatus: { type: String, enum: CLAIM_STATUSES, required: true },
        },
        noId,
      ),
    ],
    boardUpdate: { type: String, enum: ['FORWARD_ONLY', 'NEVER'], default: 'FORWARD_ONLY' },
    createBoardClaims: { type: Boolean, default: true },
    active: { type: Boolean, required: true, default: true },
    revision: { type: Number, required: true, default: 1 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { collection: 'tpa_formats', timestamps: true, strict: 'throw', minimize: false },
);
tpaFormatSchema.index({ nameKey: 1 }, { unique: true });
tpaFormatSchema.index({ tpaCode: 1, active: 1 });
export const TpaFormatModel = model<TpaFormatDoc>('TpaFormat', tpaFormatSchema);

export interface TpaImportDoc {
  _id: Types.ObjectId;
  caseId: Types.ObjectId;
  clientId: Types.ObjectId;
  formatId: Types.ObjectId;
  /** The format as it was when the file was checked (a later edit does not change this import). */
  format: Omit<
    TpaFormatDoc,
    '_id' | 'createdBy' | 'updatedBy' | 'createdAt' | 'updatedAt' | 'nameKey'
  >;
  tpaCode: string;
  fileName: string;
  sha256: string;
  size: number;
  status: TpaImportStatus;
  fileIssues: string[];
  counts: {
    rows: number;
    valid: number;
    invalid: number;
    warnings: number;
    create: number;
    update: number;
    unchanged: number;
  };
  policy: TpaImportPolicy | null;
  result: {
    created: number;
    updated: number;
    unchanged: number;
    skipped: number;
    failed: number;
    failures: Array<{ row: number; message: string }>;
  } | null;
  /** Set while committing: a second commit for the same policy and TPA waits (unique index). */
  committing: string | null;
  uploadedBy: Types.ObjectId;
  importedAt: Date | null;
  importedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const tpaImportSchema = new Schema<TpaImportDoc>(
  {
    caseId: { type: Schema.Types.ObjectId, ref: 'GhiCase', required: true },
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true },
    formatId: { type: Schema.Types.ObjectId, ref: 'TpaFormat', required: true },
    format: { type: Schema.Types.Mixed, required: true },
    tpaCode: { type: String, required: true },
    fileName: { type: String, required: true },
    sha256: { type: String, required: true },
    size: { type: Number, required: true },
    status: { type: String, enum: TPA_IMPORT_STATUSES, required: true },
    fileIssues: { type: [String], default: [] },
    counts: { type: Schema.Types.Mixed, required: true },
    policy: { type: String, enum: [...TPA_IMPORT_POLICIES, null], default: null },
    result: { type: Schema.Types.Mixed, default: null },
    committing: text,
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    importedAt: { type: Date, default: null },
    importedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { collection: 'tpa_imports', timestamps: true, strict: 'throw', minimize: false },
);
tpaImportSchema.index({ caseId: 1, _id: -1 });
// One commit at a time per policy and TPA, also across API instances.
tpaImportSchema.index(
  { caseId: 1, tpaCode: 1 },
  { unique: true, partialFilterExpression: { status: 'IMPORTING' } },
);
export const TpaImportModel = model<TpaImportDoc>('TpaImport', tpaImportSchema);

export interface TpaImportRowDoc {
  _id: Types.ObjectId;
  importId: Types.ObjectId;
  row: number;
  claimKey: string | null;
  tpaClaimId: string | null;
  action: TpaRowAction;
  issues: TpaRowIssue[];
  /** Normalised values (TpaNormalisedRow) when the row reads; null when it cannot be imported. */
  values: Record<string, unknown> | null;
  /** The kept extra source columns. */
  extra: Record<string, string>;
}

const tpaImportRowSchema = new Schema<TpaImportRowDoc>(
  {
    importId: { type: Schema.Types.ObjectId, ref: 'TpaImport', required: true },
    row: { type: Number, required: true },
    claimKey: text,
    tpaClaimId: text,
    action: { type: String, enum: TPA_ROW_ACTIONS, required: true },
    issues: { type: Schema.Types.Mixed, default: [] },
    values: { type: Schema.Types.Mixed, default: null },
    extra: { type: Schema.Types.Mixed, default: {} },
  },
  { collection: 'tpa_import_rows', versionKey: false, strict: 'throw', minimize: false },
);
tpaImportRowSchema.index({ importId: 1, row: 1 }, { unique: true });
tpaImportRowSchema.index({ importId: 1, action: 1, row: 1 });
export const TpaImportRowModel = model<TpaImportRowDoc>('TpaImportRow', tpaImportRowSchema);

export interface TpaClaimDoc {
  _id: Types.ObjectId;
  caseId: Types.ObjectId;
  clientId: Types.ObjectId;
  product: EbProduct;
  tpaCode: string;
  claimKey: string;
  tpaClaimId: string;
  requestType: TpaRequestType;
  sourceRequestType: string | null;
  parentClaimId: string | null;
  parent: { state: TpaParentLink; id: Types.ObjectId | null };
  employeeId: string | null;
  memberName: string | null;
  tpaMemberId: string | null;
  relationship: GhiRelationship | null;
  sourceRelationship: string | null;
  gender: 'MALE' | 'FEMALE' | 'OTHER' | null;
  dateOfBirth: string | null;
  age: number | null;
  /** The census member the record was matched to (employee ID and relationship, never a name alone). */
  member: { match: TpaMemberMatch; memberId: Types.ObjectId | null };
  board: { state: TpaBoardLink; claimId: Types.ObjectId | null };
  admissionDate: string | null;
  dischargeDate: string | null;
  diagnosis: string | null;
  icdCode: string | null;
  claimType: TpaClaimType | null;
  sourceClaimType: string | null;
  hospital: string | null;
  hospitalCity: string | null;
  claimedAmount: Types.Decimal128 | null;
  sanctionedAmount: Types.Decimal128 | null;
  settledAmount: Types.Decimal128 | null;
  disallowedAmount: Types.Decimal128 | null;
  status: TpaClaimStatus;
  sourceStatus: string;
  rejectionReason: string | null;
  settlementDate: string | null;
  /** N12: kept in full; masked in every response and file unless the user is claims.admin. */
  bankAccount?: string | null;
  /** N11: why the claim is not on the board (unmapped status, not matched, missing details). */
  boardNote?: string | null;
  extra: Record<string, string>;
  /** Kept by staff; an import never changes it. */
  reviewNote: string | null;
  firstImportId: Types.ObjectId;
  lastImportId: Types.ObjectId;
  importedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const tpaClaimSchema = new Schema<TpaClaimDoc>(
  {
    caseId: { type: Schema.Types.ObjectId, ref: 'GhiCase', required: true },
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true },
    product: { type: String, required: true },
    tpaCode: { type: String, required: true },
    claimKey: { type: String, required: true },
    tpaClaimId: { type: String, required: true },
    requestType: { type: String, enum: TPA_REQUEST_TYPES, required: true },
    sourceRequestType: text,
    parentClaimId: text,
    parent: {
      type: new Schema(
        {
          state: { type: String, enum: TPA_PARENT_LINKS, required: true },
          id: { type: Schema.Types.ObjectId, ref: 'TpaClaim', default: null },
        },
        noId,
      ),
      required: true,
    },
    employeeId: text,
    memberName: text,
    tpaMemberId: text,
    relationship: { type: String, enum: [...GHI_RELATIONSHIPS, null], default: null },
    sourceRelationship: text,
    gender: { type: String, enum: ['MALE', 'FEMALE', 'OTHER', null], default: null },
    dateOfBirth: text,
    age: { type: Number, default: null },
    member: {
      type: new Schema(
        {
          match: { type: String, enum: TPA_MEMBER_MATCHES, required: true },
          memberId: { type: Schema.Types.ObjectId, ref: 'GhiMember', default: null },
        },
        noId,
      ),
      required: true,
    },
    board: {
      type: new Schema(
        {
          state: { type: String, enum: TPA_BOARD_LINKS, required: true },
          claimId: { type: Schema.Types.ObjectId, ref: 'Claim', default: null },
        },
        noId,
      ),
      required: true,
    },
    admissionDate: text,
    dischargeDate: text,
    diagnosis: text,
    icdCode: text,
    claimType: { type: String, enum: [...TPA_CLAIM_TYPES, null], default: null },
    sourceClaimType: text,
    hospital: text,
    hospitalCity: text,
    claimedAmount: { type: Schema.Types.Decimal128, default: null },
    sanctionedAmount: { type: Schema.Types.Decimal128, default: null },
    settledAmount: { type: Schema.Types.Decimal128, default: null },
    disallowedAmount: { type: Schema.Types.Decimal128, default: null },
    status: { type: String, enum: TPA_CLAIM_STATUSES, required: true },
    sourceStatus: { type: String, required: true },
    rejectionReason: text,
    settlementDate: text,
    bankAccount: text,
    boardNote: text,
    extra: { type: Schema.Types.Mixed, default: {} },
    reviewNote: text,
    firstImportId: { type: Schema.Types.ObjectId, ref: 'TpaImport', required: true },
    lastImportId: { type: Schema.Types.ObjectId, ref: 'TpaImport', required: true },
    importedAt: { type: Date, required: true },
  },
  { collection: 'tpa_claims', timestamps: true, strict: 'throw', minimize: false },
);
// The stable identity: one record per policy, TPA and claim ID, also under concurrent imports.
tpaClaimSchema.index({ caseId: 1, tpaCode: 1, claimKey: 1 }, { unique: true });
tpaClaimSchema.index({ caseId: 1, admissionDate: 1 });
tpaClaimSchema.index({ caseId: 1, status: 1 });
tpaClaimSchema.index({ clientId: 1, caseId: 1 });
tpaClaimSchema.index(
  { 'board.claimId': 1 },
  { partialFilterExpression: { 'board.claimId': { $type: 'objectId' } } },
);
export const TpaClaimModel = model<TpaClaimDoc>('TpaClaim', tpaClaimSchema);

/** One change to a TPA record. Append-only. */
export interface TpaClaimEventDoc {
  _id: Types.ObjectId;
  claimId: Types.ObjectId;
  type: 'CREATED' | 'UPDATED' | 'LINKED' | 'NOTE';
  at: Date;
  actorId: Types.ObjectId | null;
  importId: Types.ObjectId | null;
  /** Changed fields (diagnosis details as "changed", never their text). */
  changes: Array<{ field: string; before: string | null; after: string | null }>;
  fromStatus: TpaClaimStatus | null;
  toStatus: TpaClaimStatus | null;
}

const tpaClaimEventSchema = new Schema<TpaClaimEventDoc>(
  {
    claimId: { type: Schema.Types.ObjectId, ref: 'TpaClaim', required: true },
    type: { type: String, enum: ['CREATED', 'UPDATED', 'LINKED', 'NOTE'], required: true },
    at: { type: Date, required: true },
    actorId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    importId: { type: Schema.Types.ObjectId, ref: 'TpaImport', default: null },
    changes: { type: Schema.Types.Mixed, default: [] },
    fromStatus: { type: String, enum: [...TPA_CLAIM_STATUSES, null], default: null },
    toStatus: { type: String, enum: [...TPA_CLAIM_STATUSES, null], default: null },
  },
  { collection: 'tpa_claim_events', versionKey: false, strict: 'throw' },
);
tpaClaimEventSchema.index({ claimId: 1, at: 1 });
const reject = () => {
  throw new Error('tpa_claim_events is append-only: updates and deletes are not allowed');
};
tpaClaimEventSchema.pre(
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
  reject,
);
export const TpaClaimEventModel = model<TpaClaimEventDoc>('TpaClaimEvent', tpaClaimEventSchema);

/** Premium additions and deletions of a placed policy (N10 F). Voided, never deleted. */
export interface PremiumAdjustmentDoc {
  _id: Types.ObjectId;
  caseId: Types.ObjectId;
  kind: 'ADDITION' | 'DELETION';
  amount: Types.Decimal128;
  effectiveDate: string;
  reference: string;
  note: string | null;
  voided: boolean;
  voidedAt: Date | null;
  voidedBy: Types.ObjectId | null;
  createdBy: Types.ObjectId;
  createdAt: Date;
}

const premiumAdjustmentSchema = new Schema<PremiumAdjustmentDoc>(
  {
    caseId: { type: Schema.Types.ObjectId, ref: 'GhiCase', required: true },
    kind: { type: String, enum: ['ADDITION', 'DELETION'], required: true },
    amount: { type: Schema.Types.Decimal128, required: true },
    effectiveDate: { type: String, required: true },
    reference: { type: String, required: true },
    note: text,
    voided: { type: Boolean, required: true, default: false },
    voidedAt: { type: Date, default: null },
    voidedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  {
    collection: 'policy_premium_adjustments',
    timestamps: { createdAt: true, updatedAt: false },
    strict: 'throw',
  },
);
premiumAdjustmentSchema.index({ caseId: 1, effectiveDate: 1 });
export const PremiumAdjustmentModel = model<PremiumAdjustmentDoc>(
  'PremiumAdjustment',
  premiumAdjustmentSchema,
);
