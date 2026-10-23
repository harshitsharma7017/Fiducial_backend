/**
 * Creates the five legacy roles (ADMIN, MANAGER, ACCOUNT_MANAGER, PLACEMENT_EXEC, READ_ONLY) as
 * system roles in the `roles` collection, with exactly the access they had (docs/RBAC.md). The API
 * does the same on every start; this script reports what it would do and checks the data.
 *
 *   npm run roles:migrate              create missing system roles, then report
 *   npm run roles:migrate -- --check   report only (writes nothing)
 *
 * Idempotent: existing roles are never modified and users are never changed (their role keys are
 * the legacy codes). The report lists users whose role keys have no role, and users holding
 * custom roles, who must be moved to a legacy role before rolling back to the fixed-role code.
 */
import { ConfigError, loadScriptEnv } from '../config/env.ts';
import { connectDatabase, disconnectDatabase } from '../lib/db.ts';
import { ensureIndexes } from '../models.ts';
import { ensureSystemRoles } from '../modules/roles/roles.service.ts';

async function main(): Promise<number> {
  const check = process.argv.slice(2).includes('--check');
  const env = loadScriptEnv();
  await connectDatabase(env.MONGODB_URI);
  try {
    if (!check) await ensureIndexes();
    const report = await ensureSystemRoles({ dryRun: check });
    console.log(check ? 'Check only: nothing was written.' : 'Roles migration finished.');
    console.log(
      `${check ? 'Would create' : 'Created'}: ${report.created.join(', ') || 'none'}; already present (unchanged): ${report.existing.join(', ') || 'none'}.`,
    );
    if (report.usersWithUnknownRoles.length > 0) {
      console.log('Users holding role keys that have no role (those keys grant nothing):');
      for (const user of report.usersWithUnknownRoles) {
        console.log(`  ${user.email} (${user.id}): ${user.roles.join(', ')}`);
      }
    }
    console.log(
      `Users holding custom roles: ${report.usersWithCustomRoles.length}. Before rolling back to the fixed-role code, move them to legacy roles.`,
    );
    for (const user of report.usersWithCustomRoles) {
      console.log(`  ${user.email} (${user.id}): ${user.roles.join(', ')}`);
    }
    return report.usersWithUnknownRoles.length > 0 ? 1 : 0;
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
