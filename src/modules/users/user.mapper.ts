import { ROLE_LABELS, isLegacyRole, type User } from '../../shared/index.ts';
import type { UserDoc } from './user.model.ts';

type UserFields = Pick<
  UserDoc,
  | '_id'
  | 'email'
  | 'name'
  | 'roles'
  | 'active'
  | 'lockedUntil'
  | 'lastLoginAt'
  | 'createdAt'
  | 'updatedAt'
>;

/**
 * Public view of a user. Never includes the password hash or the failed-attempt counter. Role
 * names come from `names` (the roles collection); without it, legacy labels or the key.
 */
export function toUserDto(
  user: UserFields,
  now: Date = new Date(),
  names?: ReadonlyMap<string, string>,
): User {
  const locked = user.lockedUntil && user.lockedUntil > now ? user.lockedUntil : null;
  return {
    id: user._id.toHexString(),
    email: user.email,
    name: user.name,
    roles: [...user.roles],
    roleNames: user.roles.map(
      (role) => names?.get(role) ?? (isLegacyRole(role) ? ROLE_LABELS[role] : role),
    ),
    active: user.active,
    lockedUntil: locked ? locked.toISOString() : null,
    lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

/** The fields recorded in audit before/after snapshots for a user. */
export function toUserAuditView(user: User): Pick<User, 'email' | 'name' | 'roles' | 'active'> {
  return { email: user.email, name: user.name, roles: user.roles, active: user.active };
}
