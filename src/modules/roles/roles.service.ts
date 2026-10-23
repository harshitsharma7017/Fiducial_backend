import {
  ADMIN_ROLE_KEY,
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  ERROR_CODES,
  PERMISSIONS,
  ROLES,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  hasPermission,
  isLegacyRole,
  legacyRolePermissions,
  normalizeRoleName,
  roleKeyFromName,
  type CreateRoleRequest,
  type Permission,
  type RoleRecord,
  type UpdateRoleRequest,
} from '../../shared/index.ts';
import { Types, mongo } from 'mongoose';
import { withTransaction } from '../../lib/db.ts';
import { AppError, conflict, notFound, validationError } from '../../lib/errors.ts';
import { writeAudit } from '../audit/audit.service.ts';
import { CounterModel } from '../proposals/proposal.model.ts';
import { UserModel } from '../users/user.model.ts';
import { RoleModel, type RoleDoc } from './role.model.ts';

/** Who is acting, with the permissions resolved for this request. */
export interface RoleActor {
  id: string | null;
  permissions: ReadonlySet<Permission>;
  requestId: string | null;
}

type Session = mongo.ClientSession | undefined;

// Resolution ----------------------------------------------------------------------------------

/**
 * The effective permissions of a set of role keys: the union of the permissions of the ACTIVE
 * roles among them (an allPermissions role gives the whole catalog). Unknown keys grant nothing.
 * Read from the database on every call, so a change applies to the next request.
 */
export async function resolvePermissions(
  roleKeys: readonly string[],
  session?: Session,
): Promise<Set<Permission>> {
  if (roleKeys.length === 0) return new Set();
  const roles = await RoleModel.find(
    { key: { $in: [...roleKeys] }, active: true },
    { permissions: 1, allPermissions: 1 },
  )
    .session(session ?? null)
    .lean();
  if (roles.some((role) => role.allPermissions)) return new Set(PERMISSIONS);
  const granted = new Set<Permission>();
  for (const role of roles) for (const permission of role.permissions) granted.add(permission);
  return granted;
}

/** The keys of the active roles that grant a permission. */
export async function roleKeysGranting(
  permission: Permission,
  session?: Session,
): Promise<string[]> {
  const roles = await RoleModel.find(
    { active: true, $or: [{ allPermissions: true }, { permissions: permission }] },
    { key: 1 },
  )
    .session(session ?? null)
    .lean();
  return roles.map((role) => role.key);
}

/** The filter for active users holding a permission through one of their active roles. */
export async function usersWithPermission(permission: Permission, session?: Session) {
  return { active: true, roles: { $in: await roleKeysGranting(permission, session) } };
}

/** Role key → display name, for every role (a small collection). */
export async function roleNameMap(session?: Session): Promise<Map<string, string>> {
  const roles = await RoleModel.find({}, { key: 1, name: 1 })
    .session(session ?? null)
    .lean();
  return new Map(roles.map((role) => [role.key, role.name]));
}

/** The display names of role keys, in order; the legacy label or the key for an unknown role. */
export function roleNamesOf(
  roles: readonly string[],
  names: ReadonlyMap<string, string>,
): string[] {
  return roles.map((role) => names.get(role) ?? (isLegacyRole(role) ? ROLE_LABELS[role] : role));
}

const permissionsOf = (role: Pick<RoleDoc, 'permissions' | 'allPermissions'>): Permission[] =>
  role.allPermissions ? [...PERMISSIONS] : role.permissions;

function escalation(missing: readonly Permission[]): AppError {
  return new AppError(
    403,
    ERROR_CODES.PERMISSION_ESCALATION,
    `You can only grant permissions you hold yourself. Missing: ${missing.join(', ')}.`,
    { missing },
  );
}

/** Refuses when any of the permissions is not held by the actor. */
export function assertWithinActor(actor: RoleActor, permissions: readonly Permission[]): void {
  const missing = permissions.filter((permission) => !hasPermission(actor.permissions, permission));
  if (missing.length > 0) throw escalation(missing);
}

/**
 * Checks role keys a user is about to receive: each must exist and be active, and the roles newly
 * added (not already held) must grant only permissions the actor holds.
 */
export async function assertAssignableRoles(
  keys: readonly string[],
  alreadyHeld: readonly string[],
  actor: RoleActor,
  session?: Session,
): Promise<void> {
  const roles = await RoleModel.find({ key: { $in: [...keys] } })
    .session(session ?? null)
    .lean();
  const byKey = new Map(roles.map((role) => [role.key, role]));
  const issues: { location: 'body'; path: string; message: string }[] = [];
  keys.forEach((key, index) => {
    const role = byKey.get(key);
    if (!role)
      issues.push({ location: 'body', path: `roles.${index}`, message: `There is no role ${key}` });
    else if (!role.active) {
      issues.push({
        location: 'body',
        path: `roles.${index}`,
        message: `The role ${role.name} is inactive and cannot be assigned`,
      });
    }
  });
  if (issues.length > 0) throw validationError(issues);
  const added = keys.filter((key) => !alreadyHeld.includes(key));
  const granted = new Set(added.flatMap((key) => permissionsOf(byKey.get(key)!)));
  assertWithinActor(actor, [...granted]);
}

/**
 * Serialises changes that can affect who administers the system: every such transaction writes
 * the same document, so two concurrent ones conflict and the retry sees the other's change.
 */
export async function lockAdministration(session: mongo.ClientSession): Promise<void> {
  await CounterModel.updateOne(
    { _id: 'rbac-administration' },
    { $inc: { seq: 1 } },
    { upsert: true, session },
  );
}

/** Refuses (inside the transaction) when no active user holds an active Administrator role. */
export async function assertAdministratorRemains(session: mongo.ClientSession): Promise<void> {
  const adminKeys = (
    await RoleModel.find({ active: true, allPermissions: true }, { key: 1 }).session(session).lean()
  ).map((role) => role.key);
  const admins = await UserModel.countDocuments({
    active: true,
    roles: { $in: adminKeys },
  }).session(session);
  if (admins === 0) {
    throw conflict(
      ERROR_CODES.LAST_ADMIN,
      'At least one active user must keep the Administrator role.',
    );
  }
}

// Records -------------------------------------------------------------------------------------

async function userCounts(session?: Session): Promise<Map<string, number>> {
  const rows = await UserModel.aggregate<{ _id: string; count: number }>([
    { $unwind: '$roles' },
    { $group: { _id: '$roles', count: { $sum: 1 } } },
  ]).session(session ?? null);
  return new Map(rows.map((row) => [row._id, row.count]));
}

function toRecord(role: RoleDoc, userCount: number): RoleRecord {
  return {
    id: role._id.toHexString(),
    key: role.key,
    name: role.name,
    description: role.description,
    permissions: permissionsOf(role),
    allPermissions: role.allPermissions,
    isSystem: role.isSystem,
    locked: role.locked,
    active: role.active,
    userCount,
    version: role.version,
    createdAt: role.createdAt.toISOString(),
    updatedAt: role.updatedAt.toISOString(),
  };
}

/** What the audit log keeps of a role. */
function auditView(
  role: Pick<RoleDoc, 'key' | 'name' | 'description' | 'active'> & {
    permissions: readonly Permission[];
  },
) {
  return {
    key: role.key,
    name: role.name,
    description: role.description,
    permissions: [...role.permissions],
    active: role.active,
  };
}

export async function listRoles(): Promise<{ items: RoleRecord[] }> {
  const [roles, counts] = await Promise.all([
    RoleModel.find({}).sort({ isSystem: -1, name: 1 }).lean(),
    userCounts(),
  ]);
  return { items: roles.map((role) => toRecord(role, counts.get(role.key) ?? 0)) };
}

async function loadRole(key: string, session?: Session): Promise<RoleDoc> {
  const role = await RoleModel.findOne({ key })
    .session(session ?? null)
    .lean();
  if (!role) throw notFound('Role not found');
  return role;
}

export async function getRole(key: string): Promise<RoleRecord> {
  const role = await loadRole(key);
  const count = await UserModel.countDocuments({ roles: key });
  return toRecord(role, count);
}

function nameTaken(): AppError {
  return conflict(ERROR_CODES.ROLE_NAME_TAKEN, 'Another role already has this name.');
}

async function uniqueKey(name: string, session: mongo.ClientSession): Promise<string> {
  const base = roleKeyFromName(name);
  for (let suffix = 1; suffix < 1000; suffix += 1) {
    const key = suffix === 1 ? base : `${base.slice(0, 35)}_${suffix}`;
    if (!(await RoleModel.exists({ key }).session(session))) return key;
  }
  throw new Error('Could not find a free role key');
}

export async function createRole(input: CreateRoleRequest, actor: RoleActor): Promise<RoleRecord> {
  const permissions = [...(input.permissions ?? [])];
  assertWithinActor(actor, permissions);
  const normalizedName = normalizeRoleName(input.name);
  try {
    return await withTransaction(async (session) => {
      if (await RoleModel.exists({ normalizedName }).session(session)) throw nameTaken();
      const key = await uniqueKey(input.name, session);
      const actorId = actor.id ? new Types.ObjectId(actor.id) : null;
      const [doc] = await RoleModel.create(
        [
          {
            key,
            name: input.name.trim().replace(/\s+/g, ' '),
            normalizedName,
            description: input.description ?? '',
            permissions: PERMISSIONS.filter((permission) => permissions.includes(permission)),
            allPermissions: false,
            isSystem: false,
            locked: false,
            active: true,
            version: 0,
            createdBy: actorId,
            updatedBy: actorId,
          },
        ],
        { session },
      );
      if (!doc) throw new Error('Role was not created');
      const role = doc.toObject() as RoleDoc;
      await writeAudit(
        {
          userId: actor.id,
          action: AUDIT_ACTIONS.ROLE_CREATED,
          entity: AUDIT_ENTITIES.ROLE,
          entityId: key,
          before: null,
          after: auditView(role),
          requestId: actor.requestId,
        },
        session,
      );
      return toRecord(role, 0);
    });
  } catch (error) {
    if (error instanceof mongo.MongoServerError && error.code === 11000) throw nameTaken();
    throw error;
  }
}

function lockedRole(): AppError {
  return conflict(
    ERROR_CODES.ROLE_LOCKED,
    'The Administrator role always holds every permission; it cannot be changed or deactivated.',
  );
}

function staleRole(): AppError {
  return conflict(
    ERROR_CODES.ROLE_VERSION_CONFLICT,
    'Someone changed this role since you opened it. Reload it and try again.',
  );
}

/**
 * Edits a role. Renaming and the description need roles.update and permissions
 * roles.assign_permissions (checked by the route against the fields sent); added permissions must
 * be held by the actor. System roles keep their names.
 */
export async function updateRole(
  key: string,
  input: UpdateRoleRequest,
  actor: RoleActor,
): Promise<RoleRecord> {
  try {
    return await withTransaction(async (session) => {
      const before = await loadRole(key, session);
      if (before.locked) throw lockedRole();
      if (before.version !== input.expectedVersion) throw staleRole();
      const set: Partial<RoleDoc> = {};
      if (input.name !== undefined && input.name.trim() !== before.name) {
        if (before.isSystem) {
          throw conflict(ERROR_CODES.ROLE_LOCKED, 'System roles keep their names.');
        }
        const normalizedName = normalizeRoleName(input.name);
        if (await RoleModel.exists({ normalizedName, key: { $ne: key } }).session(session)) {
          throw nameTaken();
        }
        set.name = input.name.trim().replace(/\s+/g, ' ');
        set.normalizedName = normalizedName;
      }
      if (input.description !== undefined) set.description = input.description;
      if (input.permissions !== undefined) {
        const added = input.permissions.filter((p) => !before.permissions.includes(p));
        assertWithinActor(actor, added);
        set.permissions = PERMISSIONS.filter((permission) =>
          input.permissions!.includes(permission),
        );
      }
      await lockAdministration(session);
      const after = await RoleModel.findOneAndUpdate(
        { key, version: input.expectedVersion },
        {
          $set: { ...set, updatedBy: actor.id ? new Types.ObjectId(actor.id) : null },
          $inc: { version: 1 },
        },
        { returnDocument: 'after', runValidators: true, session },
      ).lean();
      if (!after) throw staleRole();
      await assertAdministratorRemains(session);
      await writeAudit(
        {
          userId: actor.id,
          action: AUDIT_ACTIONS.ROLE_UPDATED,
          entity: AUDIT_ENTITIES.ROLE,
          entityId: key,
          before: auditView({ ...before, permissions: permissionsOf(before) }),
          after: auditView({ ...after, permissions: permissionsOf(after) }),
          requestId: actor.requestId,
        },
        session,
      );
      return toRecord(after, await UserModel.countDocuments({ roles: key }).session(session));
    });
  } catch (error) {
    if (error instanceof mongo.MongoServerError && error.code === 11000) throw nameTaken();
    throw error;
  }
}

/**
 * Activates or deactivates a role. A role assigned to any user (active or not) cannot be
 * deactivated: reassign those users first. An inactive role grants nothing.
 */
export async function setRoleActive(
  key: string,
  active: boolean,
  actor: RoleActor,
): Promise<RoleRecord> {
  return withTransaction(async (session) => {
    const before = await loadRole(key, session);
    if (before.locked) throw lockedRole();
    if (before.active === active)
      return toRecord(before, await UserModel.countDocuments({ roles: key }).session(session));
    if (!active) {
      const holders = await UserModel.countDocuments({ roles: key }).session(session);
      if (holders > 0) {
        throw conflict(
          ERROR_CODES.ROLE_IN_USE,
          `${holders} user${holders === 1 ? ' has' : 's have'} this role. Change their roles before deactivating it.`,
          { userCount: holders },
        );
      }
    }
    await lockAdministration(session);
    const after = await RoleModel.findOneAndUpdate(
      { key },
      {
        $set: { active, updatedBy: actor.id ? new Types.ObjectId(actor.id) : null },
        $inc: { version: 1 },
      },
      { returnDocument: 'after', session },
    ).lean();
    if (!after) throw notFound('Role not found');
    await assertAdministratorRemains(session);
    await writeAudit(
      {
        userId: actor.id,
        action: active ? AUDIT_ACTIONS.ROLE_ACTIVATED : AUDIT_ACTIONS.ROLE_DEACTIVATED,
        entity: AUDIT_ENTITIES.ROLE,
        entityId: key,
        before: { active: before.active },
        after: { active: after.active },
        requestId: actor.requestId,
      },
      session,
    );
    return toRecord(after, 0);
  });
}

// Migration -----------------------------------------------------------------------------------

export interface SystemRolesReport {
  /** System roles created by this run (none on a repeated run). */
  created: string[];
  /** System roles already present: left exactly as they are. */
  existing: string[];
  /** Users holding a role key that has no role record (they get no permission from it). */
  usersWithUnknownRoles: { id: string; email: string; roles: string[] }[];
  /** Users holding roles other than the five legacy ones (relevant to a code rollback). */
  usersWithCustomRoles: { id: string; email: string; roles: string[] }[];
}

/** The record a legacy role is migrated to: the access it had, nothing more. */
export function legacyRoleRecord(key: (typeof ROLES)[number]) {
  const admin = key === ADMIN_ROLE_KEY;
  return {
    key,
    name: ROLE_LABELS[key],
    normalizedName: normalizeRoleName(ROLE_LABELS[key]),
    description: ROLE_DESCRIPTIONS[key],
    permissions: legacyRolePermissions(key),
    allPermissions: admin,
    isSystem: true,
    locked: admin,
    active: true,
    version: 0,
    createdBy: null,
    updatedBy: null,
  };
}

/**
 * Creates the five legacy roles as system roles when they are missing. Idempotent: an existing
 * role (by key) is never modified, so an administrator's changes survive restarts. Users are not
 * touched: their role keys are the legacy codes. With dryRun nothing is written.
 */
export async function ensureSystemRoles(
  options: { dryRun?: boolean } = {},
): Promise<SystemRolesReport> {
  const existingKeys = new Set(
    (await RoleModel.find({ key: { $in: [...ROLES] } }, { key: 1 }).lean()).map((role) => role.key),
  );
  const created: string[] = [];
  for (const key of ROLES) {
    if (existingKeys.has(key) || options.dryRun) continue;
    const result = await RoleModel.updateOne(
      { key },
      { $setOnInsert: legacyRoleRecord(key) },
      { upsert: true },
    );
    if (result.upsertedCount === 1) {
      created.push(key);
      await writeAudit({
        userId: null,
        action: AUDIT_ACTIONS.ROLE_SEEDED,
        entity: AUDIT_ENTITIES.ROLE,
        entityId: key,
        before: null,
        after: auditView({ ...legacyRoleRecord(key), permissions: legacyRolePermissions(key) }),
        requestId: 'roles-migration',
      });
    }
  }
  const allKeys = new Set((await RoleModel.find({}, { key: 1 }).lean()).map((role) => role.key));
  if (options.dryRun) for (const key of ROLES) allKeys.add(key);
  const users = await UserModel.find({}, { email: 1, roles: 1 }).lean();
  const view = (user: (typeof users)[number]) => ({
    id: user._id.toHexString(),
    email: user.email,
    roles: [...user.roles],
  });
  return {
    created: options.dryRun ? ROLES.filter((key) => !existingKeys.has(key)) : created,
    existing: ROLES.filter((key) => existingKeys.has(key)),
    usersWithUnknownRoles: users.filter((u) => u.roles.some((r) => !allKeys.has(r))).map(view),
    usersWithCustomRoles: users.filter((u) => u.roles.some((r) => !isLegacyRole(r))).map(view),
  };
}
