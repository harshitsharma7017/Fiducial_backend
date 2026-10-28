import { describe, expect, it } from 'vitest';
import { MemoryCloudStore } from '../cloud-storage/cloud-store.ts';
import { putFile, readFile, removeFile, useFileStore } from './file-store.ts';

// Every file of the app is kept in the file store (S3 in production); records keep its key.

describe('file store', () => {
  const store = new MemoryCloudStore();
  useFileStore(store, true);

  it('keeps a file under <area>/<year>/<month>/<id>/<name> and reads it back by key', async () => {
    const data = Buffer.from('%PDF-1.4 policy');
    const key = await putFile('placement', data, 'application/pdf', 'Policy 2026.pdf');
    expect(key).toMatch(/^test\/placement\/\d{4}\/\d{2}\/[0-9a-f-]{36}\/Policy_2026\.pdf$/);
    expect(store.objects.get(key)).toMatchObject({ contentType: 'application/pdf' });
    expect(await readFile({ storageKey: key })).toEqual(data);
    await removeFile(key);
    expect(store.objects.has(key)).toBe(false);
    // Removing what is already gone is not an error.
    await expect(removeFile(key)).resolves.toBeUndefined();
  });

  it('reads a record saved before the move to S3 from its bytes until it is migrated', async () => {
    const legacy = Buffer.from('old bytes');
    expect(await readFile({ storageKey: null }, legacy)).toEqual(legacy);
    // A lean read gives the driver's Binary.
    expect(await readFile({}, { buffer: new Uint8Array(legacy) })).toEqual(legacy);
    await expect(readFile({ storageKey: null }, undefined)).rejects.toThrow('not in storage');
  });
});
