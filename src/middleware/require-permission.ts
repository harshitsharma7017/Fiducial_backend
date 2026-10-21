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

/**
 * As requirePermission, for claim data (N12): a refusal is also written to the audit log (who,
 * which permission, which route), before the 403. Nothing from the request body is logged.
 */
export function requireClaimPermission(permission: Permission): RequestHandler {
  return async (req, _res, next) => {
    const user = req.user;
    if (!user) throw unauthenticated();
    if (!can(user.roles, permission)) {
      const { writeAudit } = await import('../modules/audit/audit.service.ts');
      await writeAudit({
        userId: user.id,
        action: 'CLAIM_ACCESS_DENIED',
        entity: 'claim',
        entityId: 'access',
        before: null,
        after: {
          permission,
          method: req.method,
          route: req.baseUrl + ((req.route as { path?: string } | undefined)?.path ?? req.path),
          outcome: 'DENIED',
        },
        requestId: req.requestId ?? null,
      });
      throw forbidden();
    }
    next();
  };
}

/** The signed-in user, for handlers mounted behind authenticate(). */
export function currentUser(req: Request): AuthenticatedUser {
  if (!req.user) throw unauthenticated();
  return req.user;
}
