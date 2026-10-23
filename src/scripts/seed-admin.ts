/**
 * Creates the first admin user from SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD
 * (optional SEED_ADMIN_NAME). Refuses to run without a password. Does nothing if a user with
 * that email already exists.
 *
 *   SEED_ADMIN_EMAIL=admin@example.com SEED_ADMIN_PASSWORD='a long passphrase' npm run seed:admin
 */
import {
  ADMIN_ROLE_KEY,
  EmailSchema,
  PERMISSIONS,
  PasswordSchema,
  UserNameSchema,
} from '../shared/index.ts';
import { z } from 'zod';
import { ConfigError, loadScriptEnv } from '../config/env.ts';
import { connectDatabase, disconnectDatabase } from '../lib/db.ts';
import { ensureIndexes } from '../models.ts';
import { ensureSystemRoles } from '../modules/roles/roles.service.ts';
import { UserModel } from '../modules/users/user.model.ts';
import { createUser } from '../modules/users/users.service.ts';

const SeedSchema = z.object({
  SEED_ADMIN_EMAIL: EmailSchema,
  SEED_ADMIN_PASSWORD: PasswordSchema,
  SEED_ADMIN_NAME: UserNameSchema.default('Administrator'),
});

async function main(): Promise<number> {
  if (!process.env.SEED_ADMIN_PASSWORD) {
    console.error(
      'SEED_ADMIN_PASSWORD is not set. Refusing to create an admin without a password.',
    );
    return 2;
  }
  const parsed = SeedSchema.safeParse(process.env);
  if (!parsed.success) {
    // Messages only; the password itself is never printed.
    for (const issue of parsed.error.issues)
      console.error(`${issue.path.join('.')}: ${issue.message}`);
    return 2;
  }
  const {
    SEED_ADMIN_EMAIL: email,
    SEED_ADMIN_PASSWORD: password,
    SEED_ADMIN_NAME: name,
  } = parsed.data;

  const env = loadScriptEnv();
  await connectDatabase(env.MONGODB_URI);
  try {
    await ensureIndexes();
    // The Administrator role must exist before it is assigned.
    await ensureSystemRoles();
    const existing = await UserModel.findOne({ email }).lean();
    if (existing) {
      console.log(
        `A user with the email ${email} already exists (roles: ${existing.roles.join(', ')}). Nothing changed.`,
      );
      return 0;
    }
    const otherAdmins = await UserModel.countDocuments({ roles: ADMIN_ROLE_KEY, active: true });
    const user = await createUser(
      { email, name, password, roles: [ADMIN_ROLE_KEY] },
      // A script run with database access: it may assign any role.
      { id: null, permissions: new Set(PERMISSIONS), requestId: 'seed-admin' },
    );
    console.log(`Created admin ${user.email} (id ${user.id}).`);
    if (otherAdmins > 0) console.log(`Note: ${otherAdmins} other active admin(s) already existed.`);
    return 0;
  } finally {
    await disconnectDatabase();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof ConfigError ? error.message : error);
    process.exitCode = 1;
  },
);
