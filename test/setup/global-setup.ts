import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { TestProject } from 'vitest/node';

/** Matches docker-compose.yml. Override with MONGOMS_VERSION. */
const MONGODB_VERSION = process.env.MONGOMS_VERSION ?? '7.0.43';

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
  }
}

/** A single-node replica set, because the API relies on multi-document transactions. */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    binary: { version: MONGODB_VERSION },
  });
  project.provide('mongoUri', replSet.getUri());
  return async () => {
    await replSet.stop();
  };
}
