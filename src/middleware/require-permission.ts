import { hasAnyPermission, hasPermission, type Permission } from '../shared/index.ts';
import type { Request, RequestHandler, Response } from 'express';
import { forbidden, unauthenticated } from '../lib/errors.ts';
import type { AuthenticatedUser } from './auth.ts';

/**
 * Access policies (deny by default). Every route declares how it may be reached with one of the
 * middlewares below; route() refuses to run a handler that none of them granted, and
 * test/access-policy.test.ts fails on any route without one. The permissions are the user's,
 * resolved from their active roles on this request (authenticate()).
 */

/** Marks a middleware as an access policy, for the router-stack check. */
export const ACCESS_POLICY = Symbol.for('fiducial.accessPolicy');

export interface AccessPolicy {
  kind: 'public' | 'authenticated' | 'permission';
  /** The permission(s), or why the route is public or open to every signed-in user. */
  detail: string;
}

function grant(res: Response): void {
  res.locals.accessGranted = true;
}

/** True once an access policy has let this request through. */
export function accessGranted(res: Response): boolean {
  return res.locals.accessGranted === true;
}

function withPolicy(handler: RequestHandler, policy: AccessPolicy): RequestHandler {
  Object.defineProperty(handler, ACCESS_POLICY, { value: policy });
  return handler;
}

export function accessPolicyOf(handler: unknown): AccessPolicy | undefined {
  return typeof handler === 'function'
    ? (handler as unknown as Record<symbol, AccessPolicy | undefined>)[ACCESS_POLICY]
    : undefined;
}

/** Allows the request when the user holds the permission. Mount it after authenticate(). */
export function requirePermission(permission: Permission): RequestHandler {
  return withPolicy(
    (req, res, next) => {
      const user = req.user;
      if (!user) throw unauthenticated();
      if (!hasPermission(user.permissions, permission)) throw forbidden();
      grant(res);
      next();
    },
    { kind: 'permission', detail: permission },
  );
}

/**
 * Allows the request when the user holds at least one of the permissions; the handler then checks
 * the one that applies (assertPermission), for example the product named in the body.
 */
export function requireAnyPermission(permissions: readonly Permission[]): RequestHandler {
  return withPolicy(
    (req, res, next) => {
      const user = req.user;
      if (!user) throw unauthenticated();
      if (!hasAnyPermission(user.permissions, permissions)) throw forbidden();
      grant(res);
      next();
    },
    { kind: 'permission', detail: permissions.join(' | ') },
  );
}

/**
 * As requirePermission, for claim data (N12): a refusal is also written to the audit log (who,
 * which permission, which route), before the 403. Nothing from the request body is logged.
 */
export function requireClaimPermission(
  permission: Permission | readonly Permission[],
): RequestHandler {
  const allowed: readonly Permission[] = typeof permission === 'string' ? [permission] : permission;
  return withPolicy(
    async (req, res, next) => {
      const user = req.user;
      if (!user) throw unauthenticated();
      if (!hasAnyPermission(user.permissions, allowed)) {
        const { writeAudit } = await import('../modules/audit/audit.service.ts');
        await writeAudit({
          userId: user.id,
          action: 'CLAIM_ACCESS_DENIED',
          entity: 'claim',
          entityId: 'access',
          before: null,
          after: {
            permission: allowed.join(' | '),
            method: req.method,
            route: req.baseUrl + ((req.route as { path?: string } | undefined)?.path ?? req.path),
            outcome: 'DENIED',
          },
          requestId: req.requestId ?? null,
        });
        throw forbidden();
      }
      grant(res);
      next();
    },
    { kind: 'permission', detail: allowed.join(' | ') },
  );
}

/**
 * Open to every signed-in user, for routes that act only on the caller's own records (their
 * notifications, their profile, signing out). The reason is documented on the policy.
 */
export function authenticatedAccess(reason: string): RequestHandler {
  return withPolicy(
    (req, res, next) => {
      if (!req.user) throw unauthenticated();
      grant(res);
      next();
    },
    { kind: 'authenticated', detail: reason },
  );
}

/** No sign-in, by design (sign-in, health, the employee claim link). The reason is documented. */
export function publicAccess(reason: string): RequestHandler {
  return withPolicy(
    (_req, res, next) => {
      grant(res);
      next();
    },
    { kind: 'public', detail: reason },
  );
}

/** The signed-in user, for handlers mounted behind authenticate(). */
export function currentUser(req: Request): AuthenticatedUser {
  if (!req.user) throw unauthenticated();
  return req.user;
}

/** Whether the signed-in user holds the permission. */
export function userCan(req: Request, permission: Permission): boolean {
  return hasPermission(currentUser(req).permissions, permission);
}

/** Refuses (403) when the signed-in user does not hold the permission. */
export function assertPermission(req: Request, permission: Permission): void {
  if (!userCan(req, permission)) throw forbidden();
}
