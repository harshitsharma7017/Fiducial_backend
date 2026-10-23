import type { Permission } from '../shared/index.ts';
import type { RequestHandler } from 'express';
import { Types } from 'mongoose';
import { unauthenticated } from '../lib/errors.ts';
import { verifyAccessToken } from '../modules/auth/token.ts';
import { resolvePermissions } from '../modules/roles/roles.service.ts';
import { UserModel } from '../modules/users/user.model.ts';

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  /** Role keys as stored on the user (snapshotted on timelines). */
  roles: string[];
  /** The permissions of the user's active roles, resolved for this request. */
  permissions: ReadonlySet<Permission>;
}

/**
 * Requires a valid "Authorization: Bearer <JWT>" header. The user and their roles are re-read on
 * every request, so deactivation and role or permission changes take effect on the next request,
 * not when the token expires. The token carries only the user id.
 */
export function authenticate(options: { jwtSecret: string }): RequestHandler {
  return async (req, _res, next) => {
    const header = req.get('authorization');
    const match = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;
    const token = match?.[1];
    if (!token) throw unauthenticated();

    const userId = await verifyAccessToken(token, options.jwtSecret);
    if (!userId || !Types.ObjectId.isValid(userId))
      throw unauthenticated('Your session is not valid');

    const user = await UserModel.findById(userId, {
      email: 1,
      name: 1,
      roles: 1,
      active: 1,
    }).lean();
    if (!user?.active) throw unauthenticated('Your session is not valid');

    req.user = {
      id: user._id.toHexString(),
      email: user.email,
      name: user.name,
      roles: [...user.roles],
      permissions: await resolvePermissions(user.roles),
    };
    next();
  };
}
