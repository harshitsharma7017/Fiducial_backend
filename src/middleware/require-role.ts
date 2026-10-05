import { hasRole, type Role } from '../shared/index.ts';
import type { Request, RequestHandler } from 'express';
import { forbidden, unauthenticated } from '../lib/errors.ts';
import type { AuthenticatedUser } from './auth.ts';

/** Allows the request when the user holds any of the roles. ADMIN passes every check. */
export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    const user = req.user;
    if (!user) throw unauthenticated();
    if (!hasRole(user.roles, ...roles)) throw forbidden();
    next();
  };
}

/** The signed-in user, for handlers mounted behind authenticate(). */
export function currentUser(req: Request): AuthenticatedUser {
  if (!req.user) throw unauthenticated();
  return req.user;
}
