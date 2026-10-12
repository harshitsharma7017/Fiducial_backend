/**
 * Completely drops the MongoDB database specified in MONGODB_URI.
 *
 *   node --env-file-if-exists=.env src/scripts/drop-db.ts
 *   node --env-file-if-exists=.env dist/scripts/drop-db.js
 */
import mongoose from 'mongoose';
import { loadScriptEnv } from '../config/env.ts';
import { connectDatabase, disconnectDatabase } from '../lib/db.ts';

async function main(): Promise<void> {
  const env = loadScriptEnv();
  console.log('Connecting to database...');
  await connectDatabase(env.MONGODB_URI);
  try {
    const dbName = mongoose.connection.db?.databaseName;
    console.log(`Dropping entire database "${dbName}"...`);
    await mongoose.connection.dropDatabase();
    console.log(`Database "${dbName}" dropped successfully.`);
  } finally {
    await disconnectDatabase();
  }
}

main().catch((err: unknown) => {
  console.error('Failed to drop database:', err);
  process.exit(1);
});
