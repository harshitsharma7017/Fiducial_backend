import mongoose from 'mongoose';

/** Connects Mongoose. Transactions need a replica set (see docker-compose.yml). */
export async function connectDatabase(uri: string): Promise<typeof mongoose> {
  // Unknown fields in filters are dropped rather than passed to MongoDB.
  mongoose.set('strictQuery', true);
  return mongoose.connect(uri, {
    appName: 'property-erp-api',
    autoIndex: false,
    serverSelectionTimeoutMS: 10_000,
  });
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
}

/** Pings MongoDB with a short timeout. Used by the health endpoint. */
export async function pingDatabase(timeoutMs = 2_000): Promise<boolean> {
  const db = mongoose.connection.db;
  if (mongoose.connection.readyState !== mongoose.ConnectionStates.connected || !db) return false;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db.admin().ping(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('ping timed out')), timeoutMs);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Runs work in a multi-document transaction, retrying transient errors. */
export async function withTransaction<T>(
  work: (session: mongoose.mongo.ClientSession) => Promise<T>,
): Promise<T> {
  return mongoose.connection.transaction(work);
}
