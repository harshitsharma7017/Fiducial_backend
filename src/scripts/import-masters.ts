/**
 * Imports the IIB workbook (sheets "IIB Code" and "Pincode") as DRAFT master versions and
 * prints a validation report. Activates only with --activate.
 *
 * For operators: the usual way is the web app's Import data page (Admin). The workbook is not
 * kept in the repository; pass the path of the client's file.
 *
 *   npm run import:masters -- /path/to/IIB_Code_Master.xlsx [--activate] [--effective-from 2026-10-05]
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ConfigError, loadScriptEnv } from '../config/env.ts';
import { connectDatabase, disconnectDatabase } from '../lib/db.ts';
import { AppError } from '../lib/errors.ts';
import { ensureIndexes } from '../models.ts';
import { formatImportReport } from '../modules/masters/import/format-report.ts';
import { ImportStructureError } from '../modules/masters/import/iib-workbook.ts';
import { importMasters } from '../modules/masters/import/import-masters.ts';
import { parseEffectiveFrom } from '../modules/masters/masters.service.ts';
import { UserModel } from '../modules/users/user.model.ts';

const USAGE = `Usage: npm run import:masters -- <path-to-workbook.xlsx> [options]

Options:
  --activate              Activate the imported versions after the report is printed
  --effective-from DATE   Effective date for activation (YYYY-MM-DD, India time); default now
  --by EMAIL              Attribute the import to this user in the audit log
  --force                 Import even if this exact file was imported before
  -h, --help              Show this help`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      activate: { type: 'boolean', default: false },
      'effective-from': { type: 'string' },
      by: { type: 'string' },
      force: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const [fileArgument] = positionals;
  if (!fileArgument || positionals.length > 1) {
    console.error(USAGE);
    return 2;
  }

  // Resolve relative paths from where npm was invoked, not from the script's folder.
  const baseDirectory = process.env.INIT_CWD ?? process.cwd();
  const filePath = isAbsolute(fileArgument) ? fileArgument : resolve(baseDirectory, fileArgument);
  if (!existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    return 2;
  }

  const effectiveFrom = values['effective-from'];
  if (effectiveFrom !== undefined) parseEffectiveFrom(effectiveFrom);

  const env = loadScriptEnv();
  await connectDatabase(env.MONGODB_URI);
  try {
    await ensureIndexes();

    let importedBy: string | null = null;
    if (values.by) {
      const user = await UserModel.findOne({ email: values.by.trim().toLowerCase() }).lean();
      if (!user) {
        console.error(`No user has the email ${values.by}.`);
        return 2;
      }
      importedBy = user._id.toHexString();
    }

    const result = await importMasters({
      data: await readFile(filePath),
      sourceFileName: basename(filePath),
      activate: values.activate,
      effectiveFrom,
      importedBy,
      force: values.force,
    });

    console.log(formatImportReport(result.report));
    console.log('');
    if (result.alreadyImported) {
      console.log(
        'This file was imported before, so no new versions were created. Use --force to import it again.',
      );
    }
    for (const version of [result.occupancyVersion, result.pincodeVersion]) {
      console.log(
        `${version.type.padEnd(10)} version ${version.id}  ${version.status.padEnd(10)}  ${version.stats.recordsImported} records`,
      );
    }
    if (values.activate && !result.activated) {
      console.log('Nothing was activated: these versions are not drafts.');
    } else if (!values.activate) {
      console.log(
        'Review the report, then activate with --activate, or as an admin with ' +
          'POST /api/v1/masters/versions/{id}/activate.',
      );
    }
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
    if (error instanceof ImportStructureError || error instanceof ConfigError) {
      console.error(error.message);
    } else if (error instanceof AppError) {
      console.error(
        `${error.message}${error.details ? `\n${JSON.stringify(error.details, null, 2)}` : ''}`,
      );
    } else {
      console.error('Import failed:', error);
    }
    process.exitCode = 1;
  },
);
