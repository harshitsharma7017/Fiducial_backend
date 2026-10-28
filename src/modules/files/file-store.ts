import { randomUUID } from 'node:crypto';
import { CloudStoreError, type CloudStore } from '../cloud-storage/cloud-store.ts';

// Every file of the app lives in the file store (S3 in production): quote attachments, policies
// and cover notes, client approvals, document templates, RFQ versions, mail attachments, claim
// documents, group health files and chat files. A record keeps only the file's key. createApp sets
// the store once; the services read and write through these functions.

/** The areas files are kept under in the store (the key's first folder). */
export type FileArea =
  | 'quotes'
  | 'placement'
  | 'client-approval'
  | 'templates'
  | 'rfq'
  | 'mail'
  | 'claims'
  | 'ghi'
  | 'chat';

let current: CloudStore | null = null;

/**
 * Sets the store the app's files go to. The first store set stays unless `replace` (an app built
 * with an injected store, as in tests).
 */
export function useFileStore(store: CloudStore, replace = false): void {
  if (!current || replace) current = store;
}

/** The configured store. */
export function fileStore(): CloudStore {
  if (!current) throw new Error('File storage is not configured');
  return current;
}

/** Keeps a file in the store and returns its key: <area>/<yyyy>/<mm>/<uuid>/<file name>. */
export async function putFile(
  area: FileArea,
  data: Buffer,
  contentType: string,
  fileName: string,
): Promise<string> {
  const store = fileStore();
  const now = new Date();
  const key = store.keyFor([
    area,
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    randomUUID(),
    fileName,
  ]);
  await store.put({ key, data, contentType, metadata: { area } });
  return key;
}

/** A Buffer, from what a lean (or driver) read of a legacy record's binary field gives. */
export function bytesOf(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return value;
  if (value && typeof value === 'object' && 'buffer' in value) {
    const bytes = value.buffer;
    if (bytes instanceof Uint8Array) return Buffer.from(bytes);
  }
  return null;
}

/**
 * A stored file's bytes: from the store by its key. A record saved before files moved to S3 still
 * holds its bytes until `npm run files:to-s3` moves them; it is read from there meanwhile.
 */
export async function readFile(
  record: { storageKey?: string | null },
  legacy?: unknown,
): Promise<Buffer> {
  if (record.storageKey) return fileStore().get(record.storageKey);
  const bytes = bytesOf(legacy);
  if (bytes) return bytes;
  throw new CloudStoreError('The file is not in storage');
}

/** Deletes a file from the store; a missing one is not an error. */
export async function removeFile(key: string | null | undefined): Promise<void> {
  if (!key) return;
  try {
    await fileStore().remove(key);
  } catch {
    // Already gone, or the store refused: the record no longer points at it either way.
  }
}
