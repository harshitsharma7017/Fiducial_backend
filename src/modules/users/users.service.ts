import {
  ADMIN_ROLE_KEY,
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  ERROR_CODES,
  type CreateUserRequest,
  type Paginated,
  type Permission,
  type UpdateUserRequest,
  type User,
  type UserListQuery,
} from '../../shared/index.ts';
import { Types, mongo, type QueryFilter } from 'mongoose';
import { withTransaction } from '../../lib/db.ts';
import { conflict, notFound, type AppError } from '../../lib/errors.ts';
import { writeAudit } from '../audit/audit.service.ts';
import { hashPassword } from '../auth/password.ts';
import {
  assertAdministratorRemains,
  assertAssignableRoles,
  assertWithinActor,
  lockAdministration,
  resolvePermissions,
  roleNameMap,
} from '../roles/roles.service.ts';
import { toUserAuditView, toUserDto } from './user.mapper.ts';
import { UserModel, type UserDoc } from './user.model.ts';

/** Who is acting, with the permissions resolved for this request. */
export interface UserActor {
  id: string | null;
  permissions: ReadonlySet<Permission>;
  requestId: string | null;
}

function emailTaken(): AppError {
  return conflict(ERROR_CODES.EMAIL_TAKEN, 'A user with this email already exists');
}

export async function listUsers(query: UserListQuery): Promise<Paginated<User>> {
  const filter: QueryFilter<UserDoc> = {};
  if (query.cursor) filter._id = { $gt: new Types.ObjectId(query.cursor) };
  const [docs, names] = await Promise.all([
    UserModel.find(filter)
      .sort({ _id: 1 })
      .limit(query.limit + 1)
      .lean(),
    roleNameMap(),
  ]);
  const page = docs.slice(0, query.limit);
  const last = page.at(-1);
  return {
    items: page.map((doc) => toUserDto(doc, new Date(), names)),
    nextCursor: docs.length > query.limit && last ? last._id.toHexString() : null,
  };
}

export async function getUser(id: string): Promise<User> {
  const doc = await UserModel.findById(id).lean();
  if (!doc) throw notFound('User not found');
  return toUserDto(doc, new Date(), await roleNameMap());
}

/**
 * Creates a user. The roles must exist, be active, and grant only permissions the actor holds
 * (no escalation by assignment).
 */
export async function createUser(input: CreateUserRequest, actor: UserActor): Promise<User> {
  const passwordHash = await hashPassword(input.password);
  try {
    return await withTransaction(async (session) => {
      if (await UserModel.exists({ email: input.email }).session(session)) throw emailTaken();
      await assertAssignableRoles(input.roles, [], actor, session);
      const [doc] = await UserModel.create(
        [
          {
            email: input.email,
            name: input.name,
            passwordHash,
            roles: input.roles,
            active: true,
            createdBy: actor.id ? new Types.ObjectId(actor.id) : null,
          },
        ],
        { session },
      );
      if (!doc) throw new Error('User was not created');
      const user = toUserDto(doc, new Date(), await roleNameMap(session));
      await writeAudit(
        {
          userId: actor.id,
          action: AUDIT_ACTIONS.USER_CREATED,
          entity: AUDIT_ENTITIES.USER,
          entityId: user.id,
          before: null,
          after: toUserAuditView(user),
          requestId: actor.requestId,
        },
        session,
      );
      return user;
    });
  } catch (error) {
    // Two concurrent creates can both pass the exists() check; the unique index decides.
    if (error instanceof mongo.MongoServerError && error.code === 11000) throw emailTaken();
    throw error;
  }
}

/**
 * Renames, re-roles, deactivates or reactivates a user. The route checks the permission of each
 * field sent (users.update, users.assign_roles, users.deactivate). Here:
 * - nobody deactivates themselves or removes their own Administrator role (ids compared as
 *   ObjectIds, so no spelling of the id gets round it);
 * - the actor may only manage a user whose access is within their own;
 * - roles added must exist, be active and grant nothing the actor lacks;
 * - at least one active user keeps the active Administrator role.
 */
export async function updateUser(
  id: string,
  changes: UpdateUserRequest,
  actor: UserActor,
): Promise<User> {
  const self = actor.id !== null && new Types.ObjectId(id).equals(new Types.ObjectId(actor.id));
  if (self && changes.active === false) {
    throw conflict(ERROR_CODES.SELF_UPDATE_NOT_ALLOWED, 'You cannot deactivate your own account');
  }

  return withTransaction(async (session) => {
    const before = await UserModel.findById(id).session(session).lean();
    if (!before) throw notFound('User not found');

    if (!self) assertWithinActor(actor, [...(await resolvePermissions(before.roles, session))]);
    if (changes.roles) {
      if (
        self &&
        before.roles.includes(ADMIN_ROLE_KEY) &&
        !changes.roles.includes(ADMIN_ROLE_KEY)
      ) {
        throw conflict(
          ERROR_CODES.SELF_UPDATE_NOT_ALLOWED,
          'You cannot remove your own Administrator role',
        );
      }
      await assertAssignableRoles(changes.roles, before.roles, actor, session);
    }

    const set: Partial<Pick<UserDoc, 'name' | 'roles' | 'active'>> = {};
    if (changes.name !== undefined) set.name = changes.name;
    if (changes.roles !== undefined) set.roles = changes.roles;
    if (changes.active !== undefined) set.active = changes.active;

    await lockAdministration(session);
    const after = await UserModel.findByIdAndUpdate(
      id,
      { $set: set },
      { returnDocument: 'after', runValidators: true, session },
    ).lean();
    if (!after) throw notFound('User not found');
    await assertAdministratorRemains(session);

    const names = await roleNameMap(session);
    const beforeDto = toUserDto(before, new Date(), names);
    const afterDto = toUserDto(after, new Date(), names);
    await writeAudit(
      {
        userId: actor.id,
        action: AUDIT_ACTIONS.USER_UPDATED,
        entity: AUDIT_ENTITIES.USER,
        entityId: id,
        before: toUserAuditView(beforeDto),
        after: toUserAuditView(afterDto),
        requestId: actor.requestId,
      },
      session,
    );
    return afterDto;
  });
}
