import {
  ERROR_CODES,
  type CreateUserRequest,
  type Paginated,
  type UpdateUserRequest,
  type User,
  type UserListQuery,
} from '../../shared/index.ts';
import { Types, mongo, type QueryFilter } from 'mongoose';
import { withTransaction } from '../../lib/db.ts';
import { conflict, notFound, type AppError } from '../../lib/errors.ts';
import type { AuthenticatedUser } from '../../middleware/auth.ts';
import { AUDIT_ACTIONS, AUDIT_ENTITIES } from '../audit/audit.model.ts';
import { writeAudit } from '../audit/audit.service.ts';
import { hashPassword } from '../auth/password.ts';
import { toUserAuditView, toUserDto } from './user.mapper.ts';
import { UserModel, type UserDoc } from './user.model.ts';

interface Actor {
  id: string | null;
  requestId: string | null;
}

function emailTaken(): AppError {
  return conflict(ERROR_CODES.EMAIL_TAKEN, 'A user with this email already exists');
}

export async function listUsers(query: UserListQuery): Promise<Paginated<User>> {
  const filter: QueryFilter<UserDoc> = {};
  if (query.cursor) filter._id = { $gt: new Types.ObjectId(query.cursor) };
  const docs = await UserModel.find(filter)
    .sort({ _id: 1 })
    .limit(query.limit + 1)
    .lean();
  const page = docs.slice(0, query.limit);
  const last = page.at(-1);
  return {
    items: page.map((doc) => toUserDto(doc)),
    nextCursor: docs.length > query.limit && last ? last._id.toHexString() : null,
  };
}

export async function getUser(id: string): Promise<User> {
  const doc = await UserModel.findById(id).lean();
  if (!doc) throw notFound('User not found');
  return toUserDto(doc);
}

export async function createUser(input: CreateUserRequest, actor: Actor): Promise<User> {
  const passwordHash = await hashPassword(input.password);
  try {
    return await withTransaction(async (session) => {
      if (await UserModel.exists({ email: input.email }).session(session)) throw emailTaken();
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
      const user = toUserDto(doc);
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

export async function updateUser(
  id: string,
  changes: UpdateUserRequest,
  actor: AuthenticatedUser,
  requestId: string | null,
): Promise<User> {
  if (id === actor.id) {
    if (changes.active === false) {
      throw conflict(ERROR_CODES.SELF_UPDATE_NOT_ALLOWED, 'You cannot deactivate your own account');
    }
    if (changes.roles && actor.roles.includes('ADMIN') && !changes.roles.includes('ADMIN')) {
      throw conflict(ERROR_CODES.SELF_UPDATE_NOT_ALLOWED, 'You cannot remove your own Admin role');
    }
  }

  return withTransaction(async (session) => {
    const before = await UserModel.findById(id).session(session).lean();
    if (!before) throw notFound('User not found');

    const set: Partial<Pick<UserDoc, 'name' | 'roles' | 'active'>> = {};
    if (changes.name !== undefined) set.name = changes.name;
    if (changes.roles !== undefined) set.roles = changes.roles;
    if (changes.active !== undefined) set.active = changes.active;

    const after = await UserModel.findByIdAndUpdate(
      id,
      { $set: set },
      { returnDocument: 'after', runValidators: true, session },
    ).lean();
    if (!after) throw notFound('User not found');

    const beforeDto = toUserDto(before);
    const afterDto = toUserDto(after);
    await writeAudit(
      {
        userId: actor.id,
        action: AUDIT_ACTIONS.USER_UPDATED,
        entity: AUDIT_ENTITIES.USER,
        entityId: id,
        before: toUserAuditView(beforeDto),
        after: toUserAuditView(afterDto),
        requestId,
      },
      session,
    );
    return afterDto;
  });
}
