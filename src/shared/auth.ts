import { z } from 'zod';
import { IsoDateTimeSchema, ObjectIdSchema } from './common.ts';
import { RoleSchema } from './roles.ts';

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/** Failed sign-ins allowed before the account is locked, and for how long. */
export const LOGIN_MAX_FAILED_ATTEMPTS = 5;
export const LOGIN_LOCKOUT_MINUTES = 15;

/** Emails are trimmed and lower-cased before validation and storage. */
export const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, 'Email is too long')
  .pipe(z.email({ error: 'Enter a valid email address' }));

export const PasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Use at most ${PASSWORD_MAX_LENGTH} characters`);

export const LoginRequestSchema = z.strictObject({
  email: EmailSchema,
  // Not checked against the policy here: a sign-in must not reveal password rules.
  password: z.string().min(1, 'Enter your password').max(PASSWORD_MAX_LENGTH),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const UserSchema = z.object({
  id: ObjectIdSchema,
  email: z.string(),
  name: z.string(),
  roles: z.array(RoleSchema),
  active: z.boolean(),
  lockedUntil: IsoDateTimeSchema.nullable(),
  lastLoginAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type User = z.infer<typeof UserSchema>;

export const LoginResponseSchema = z.object({
  accessToken: z.string(),
  /** Token lifetime in seconds. */
  expiresIn: z.number().int().positive(),
  user: UserSchema,
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

/** What the web app's backend-for-frontend returns to the browser after sign-in (no token). */
export const SessionResponseSchema = z.object({ user: UserSchema });
export type SessionResponse = z.infer<typeof SessionResponseSchema>;
