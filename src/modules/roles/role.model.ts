import { PERMISSIONS, type Permission } from '../../shared/index.ts';
import { Schema, model, type Types } from 'mongoose';

export interface RoleDoc {
  _id: Types.ObjectId;
  /** Stable identifier stored on users; never changes. The legacy codes are system role keys. */
  key: string;
  name: string;
  /** Trimmed, single-spaced, lower case: unique. */
  normalizedName: string;
  description: string;
  /** Catalog permissions only. Ignored when allPermissions is true. */
  permissions: Permission[];
  /** Every permission, including ones added to the catalog later (the Administrator role). */
  allPermissions: boolean;
  isSystem: boolean;
  /** Cannot be edited or deactivated. */
  locked: boolean;
  /** An inactive role grants nothing. */
  active: boolean;
  /** Incremented on every change; edits name the version they were made against. */
  version: number;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const roleSchema = new Schema<RoleDoc>(
  {
    key: {
      type: String,
      required: true,
      immutable: true,
      match: /^[A-Z][A-Z0-9_]{1,39}$/,
    },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    normalizedName: { type: String, required: true },
    description: { type: String, default: '', maxlength: 500 },
    permissions: {
      type: [{ type: String, enum: PERMISSIONS }],
      default: [],
      validate: {
        validator: (permissions: string[]) => new Set(permissions).size === permissions.length,
        message: 'Each permission can be listed once',
      },
    },
    allPermissions: { type: Boolean, required: true, default: false },
    isSystem: { type: Boolean, required: true, default: false, immutable: true },
    locked: { type: Boolean, required: true, default: false },
    active: { type: Boolean, required: true, default: true },
    version: { type: Number, required: true, default: 0, min: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { collection: 'roles', timestamps: true, strict: 'throw' },
);

roleSchema.index({ key: 1 }, { unique: true });
roleSchema.index({ normalizedName: 1 }, { unique: true });
roleSchema.index({ active: 1, permissions: 1 });

export const RoleModel = model<RoleDoc>('Role', roleSchema);
