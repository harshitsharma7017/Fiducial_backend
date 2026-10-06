import {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  LOGIN_LOCKOUT_MINUTES,
  LOGIN_MAX_FAILED_ATTEMPTS,
  type LoginRequest,
  type LoginResponse,
} from '../../shared/index.ts';
import { withTransaction } from '../../lib/db.ts';
import { invalidCredentials } from '../../lib/errors.ts';
import type { AuthenticatedUser } from '../../middleware/auth.ts';
import { writeAudit } from '../audit/audit.service.ts';
import { toUserDto } from '../users/user.mapper.ts';
import { UserModel, type UserDoc } from '../users/user.model.ts';
import { verifyAgainstDummyHash, verifyPassword } from './password.ts';
import { signAccessToken } from './token.ts';

export interface LoginContext {
  requestId: string;
  ip: string | undefined;
}

export interface TokenSettings {
  jwtSecret: string;
  expiresInSeconds: number;
}

type FailureReason = 'UNKNOWN_USER' | 'INACTIVE' | 'LOCKED' | 'WRONG_PASSWORD';

/**
 * Checks credentials and issues an access token.
 * Unknown user, inactive user, locked account and wrong password all produce the same error.
 * Five consecutive wrong passwords lock the account for 15 minutes.
 */
export async function login(
  credentials: LoginRequest,
  context: LoginContext,
  tokens: TokenSettings,
): Promise<LoginResponse> {
  const now = new Date();
  const user = await UserModel.findOne({ email: credentials.email }).select('+passwordHash').lean();

  let blockedReason: FailureReason | null = null;
  if (!user) blockedReason = 'UNKNOWN_USER';
  else if (!user.active) blockedReason = 'INACTIVE';
  else if (user.lockedUntil && user.lockedUntil > now) blockedReason = 'LOCKED';

  if (!user || blockedReason) {
    // The password is not checked, but the same work is done so timing reveals nothing.
    await verifyAgainstDummyHash(credentials.password);
    await writeAudit({
      action: AUDIT_ACTIONS.LOGIN_FAILED,
      entity: AUDIT_ENTITIES.USER,
      entityId: user ? user._id.toHexString() : null,
      after: { email: credentials.email, reason: blockedReason, ip: context.ip ?? null },
      requestId: context.requestId,
    });
    throw invalidCredentials();
  }

  if (!(await verifyPassword(user.passwordHash, credentials.password))) {
    await recordFailedPassword(user, now, credentials.email, context);
    throw invalidCredentials();
  }

  const updated = await withTransaction(async (session) => {
    const doc = await UserModel.findByIdAndUpdate(
      user._id,
      { $set: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now } },
      { returnDocument: 'after', session },
    ).lean();
    await writeAudit(
      {
        userId: user._id.toHexString(),
        action: AUDIT_ACTIONS.LOGIN_SUCCEEDED,
        entity: AUDIT_ENTITIES.USER,
        entityId: user._id.toHexString(),
        after: { email: credentials.email, ip: context.ip ?? null },
        requestId: context.requestId,
      },
      session,
    );
    return doc;
  });
  if (!updated) throw invalidCredentials();

  const accessToken = await signAccessToken(
    updated._id.toHexString(),
    tokens.jwtSecret,
    tokens.expiresInSeconds,
  );
  return { accessToken, expiresIn: tokens.expiresInSeconds, user: toUserDto(updated, now) };
}

async function recordFailedPassword(
  user: Pick<UserDoc, '_id' | 'lockedUntil'>,
  now: Date,
  email: string,
  context: LoginContext,
): Promise<void> {
  await withTransaction(async (session) => {
    // An expired lock is cleared and counting starts again.
    const lockExpired = user.lockedUntil !== null && user.lockedUntil <= now;
    const counted = await UserModel.findByIdAndUpdate(
      user._id,
      lockExpired
        ? { $set: { failedLoginCount: 1, lockedUntil: null } }
        : { $inc: { failedLoginCount: 1 } },
      { returnDocument: 'after', session, projection: { failedLoginCount: 1 } },
    ).lean();
    const attempts = counted?.failedLoginCount ?? 1;

    let lockedUntil: Date | null = null;
    if (attempts >= LOGIN_MAX_FAILED_ATTEMPTS) {
      lockedUntil = new Date(now.getTime() + LOGIN_LOCKOUT_MINUTES * 60_000);
      await UserModel.updateOne(
        { _id: user._id },
        { $set: { lockedUntil, failedLoginCount: 0 } },
        { session },
      );
    }

    await writeAudit(
      {
        action: AUDIT_ACTIONS.LOGIN_FAILED,
        entity: AUDIT_ENTITIES.USER,
        entityId: user._id.toHexString(),
        after: {
          email,
          reason: 'WRONG_PASSWORD' satisfies FailureReason,
          failedAttempts: attempts,
          lockedUntil: lockedUntil?.toISOString() ?? null,
          ip: context.ip ?? null,
        },
        requestId: context.requestId,
      },
      session,
    );
  });
}

/** Tokens are stateless, so logout only records the event; the client discards the token. */
export async function recordLogout(user: AuthenticatedUser, requestId: string): Promise<void> {
  await writeAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.LOGOUT,
    entity: AUDIT_ENTITIES.USER,
    entityId: user.id,
    requestId,
  });
}
