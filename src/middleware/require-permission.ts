import { can, type Permission } from '../shared/index.ts';
import type { Request, RequestHandler } from 'express';
import { forbidden, unauthenticated } from '../lib/errors.ts';
import type { AuthenticatedUser } from './auth.ts';

/**
 * Allows the request when the user's roles hold the permission (src/shared/permissions.ts).
 * Mount it after authenticate(); the roles are the ones re-read from the database.
 */
export function requirePermission(permission: Permission): RequestHandler {
  return (req, _res, next) => {
    const user = req.user;
    if (!user) throw unauthenticated();
    if (!can(user.roles, permission)) throw forbidden();
    next();
  };
}

/** The signed-in user, for handlers mounted behind authenticate(). */
export function currentUser(req: Request): AuthenticatedUser {
  if (!req.user) throw unauthenticated();
  return req.user;
}
