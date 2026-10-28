/**
 * Moves every file still held in the database to the file store (S3): quote attachments, policies
 * and cover notes, client approvals, document templates, RFQ versions, mail attachments, claim
 * documents, group health files and chat files. Each file is put in S3 first, then its record gets
 * the key and loses the bytes; a record already moved is skipped, so it can be run again safely.
 *
 * Needs the API's .env with CLOUD_STORAGE=s3, S3_BUCKET and S3_REGION (and AWS access). Lists what
 * it would move unless --yes is given:
 *
 *   npm run files:to-s3            # counts the files still in the database
 *   npm run files:to-s3 -- --yes   # moves them to S3
 */
import { ConfigError, loadEnv } from '../config/env.ts';
import { connectDatabase, disconnectDatabase } from '../lib/db.ts';
import { createLogger } from '../lib/logger.ts';
import { cloudStoreFromEnv } from '../modules/cloud-storage/cloud-store.ts';
import { useFileStore } from '../modules/files/file-store.ts';
import { migrateFiles } from '../modules/files/migrate-files.ts';

async function main(): Promise<number> {
  const apply = process.argv.includes('--yes');
  const env = loadEnv();
  if (env.CLOUD_STORAGE !== 's3') {
    console.error('Set CLOUD_STORAGE=s3, S3_BUCKET and S3_REGION in .env first.');
    return 1;
  }
  const store = cloudStoreFromEnv(env, createLogger({ level: 'warn' }));
  useFileStore(store, true);
  const host = env.MONGODB_URI.replace(/^mongodb(\+srv)?:\/\/([^@]*@)?/, '').split(/[/?]/)[0];
  console.log(`${apply ? 'Moving' : 'Would move'} files from ${host} to ${store.location}:`);
  await connectDatabase(env.MONGODB_URI);
  let result;
  try {
    result = await migrateFiles(apply, (line) => console.log(line));
  } finally {
    await disconnectDatabase();
  }
  if (apply) {
    console.log(
      `Moved ${result.files} files (${(result.bytes / 1024 / 1024).toFixed(1)} MB) to S3${result.failed ? `; ${result.failed} failed (run again)` : ''}.`,
    );
  } else {
    console.log('Nothing changed. Run with --yes to move them.');
  }
  return result.failed > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof ConfigError ? error.message : error);
    process.exit(1);
  });
