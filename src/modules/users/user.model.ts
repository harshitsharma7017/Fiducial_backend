import { ROLES, type Role } from '../../shared/index.ts';
import { Schema, model, type Types } from 'mongoose';

export interface UserDoc {
  _id: Types.ObjectId;
  email: string;
  name: string;
  /** argon2id hash. Never selected unless asked for explicitly. */
  passwordHash: string;
  roles: Role[];
  active: boolean;
  failedLoginCount: number;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
  createdBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<UserDoc>(
  {
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    passwordHash: { type: String, required: true, select: false },
    roles: {
      type: [{ type: String, enum: ROLES }],
      required: true,
      validate: {
        validator: (roles: Role[]) => roles.length > 0,
        message: 'A user needs at least one role',
      },
    },
    active: { type: Boolean, required: true, default: true },
    failedLoginCount: { type: Number, required: true, default: 0, min: 0 },
    lockedUntil: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { collection: 'users', timestamps: true, strict: 'throw' },
);

userSchema.index({ email: 1 }, { unique: true });

export const UserModel = model<UserDoc>('User', userSchema);
