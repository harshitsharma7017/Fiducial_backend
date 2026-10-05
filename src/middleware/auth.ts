import type { Role } from '../shared/index.ts';
import type { RequestHandler } from 'express';
import { Types } from 'mongoose';
import { unauthenticated } from '../lib/errors.ts';
import { verifyAccessToken } from '../modules/auth/token.ts';
import { UserModel } from '../modules/users/user.model.ts';

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  roles: Role[];
}

/**
 * Requires a valid "Authorization: Bearer <JWT>" header. The user is re-read on every request
 * so deactivation and role changes take effect immediately, not when the token expires.
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
      roles: user.roles,
    };
    next();
  };
}
