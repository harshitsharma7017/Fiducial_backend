import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { Env } from '../../config/env.ts';
import type { Logger } from '../../lib/logger.ts';

// Where every file of the app is kept: an S3 bucket (production), or memory (development, tests).
// The database keeps only each file's key (files/file-store.ts). Tests inject a MemoryCloudStore
// and never reach AWS.

export interface StoredObject {
  key: string;
  data: Buffer;
  contentType: string;
  /** Plain-ASCII object metadata (S3 user metadata). */
  metadata: Record<string, string>;
}

export interface CloudStore {
  readonly name: 's3' | 'memory';
  /** Where the objects go, for the audit log ("s3://bucket"). */
  readonly location: string;
  /** The key under the store's folder for a new object. */
  keyFor(parts: readonly string[]): string;
  put(object: StoredObject): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

/** A reason without credentials or request details, safe to show and log. */
export class CloudStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudStoreError';
  }
}

const safePart = (part: string) => part.replace(/[^A-Za-z0-9!_.*'()-]+/g, '_');

/** An Amazon S3 bucket; objects are encrypted at rest (SSE-S3) and private to the bucket. */
export class S3CloudStore implements CloudStore {
  readonly name = 's3' as const;
  readonly location: string;
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly logger: Logger;

  constructor(bucket: string, region: string, prefix: string, logger: Logger) {
    // Credentials from the default chain: the EC2 instance role, or AWS_ACCESS_KEY_ID and
    // AWS_SECRET_ACCESS_KEY in the environment. They never pass through the app's own config.
    this.client = new S3Client({ region });
    this.bucket = bucket;
    this.prefix = prefix;
    this.logger = logger;
    this.location = `s3://${bucket}`;
  }

  keyFor(parts: readonly string[]): string {
    return [this.prefix, ...parts.map(safePart)].join('/');
  }

  async put(object: StoredObject): Promise<void> {
    await this.call('save', object.key, () =>
      this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: object.key,
          Body: object.data,
          ContentType: object.contentType,
          Metadata: object.metadata,
          ServerSideEncryption: 'AES256',
        }),
      ),
    );
  }

  async get(key: string): Promise<Buffer> {
    const response = await this.call('read', key, () =>
      this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key })),
    );
    if (!response.Body) throw new CloudStoreError('The file is empty in cloud storage');
    return Buffer.from(await response.Body.transformToByteArray());
  }

  async remove(key: string): Promise<void> {
    await this.call('remove', key, () =>
      this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })),
    );
  }

  private async call<T>(verb: string, key: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      const name = error instanceof Error ? error.name : 'Error';
      this.logger.error({ err: { name }, key, bucket: this.bucket }, `S3 ${verb} failed`);
      throw new CloudStoreError(
        name === 'NoSuchKey'
          ? 'The file is no longer in cloud storage'
          : `Cloud storage could not ${verb} the file (${name})`,
      );
    }
  }
}

/** An in-memory store, for development without AWS and for tests (lost on restart). */
export class MemoryCloudStore implements CloudStore {
  readonly name = 'memory' as const;
  readonly location = 'memory://';
  readonly objects = new Map<string, StoredObject>();

  keyFor(parts: readonly string[]): string {
    return ['test', ...parts.map(safePart)].join('/');
  }

  put(object: StoredObject): Promise<void> {
    this.objects.set(object.key, object);
    return Promise.resolve();
  }

  get(key: string): Promise<Buffer> {
    const object = this.objects.get(key);
    return object
      ? Promise.resolve(object.data)
      : Promise.reject(new CloudStoreError('The file is no longer in cloud storage'));
  }

  remove(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }
}

/** The store CLOUD_STORAGE configures (S3 is enforced in production by the config). */
export function cloudStoreFromEnv(config: Env, logger: Logger): CloudStore {
  if (config.CLOUD_STORAGE === 's3' && config.S3_BUCKET && config.S3_REGION) {
    logger.info({ bucket: config.S3_BUCKET, region: config.S3_REGION }, 'File storage: S3');
    return new S3CloudStore(config.S3_BUCKET, config.S3_REGION, config.S3_PREFIX, logger);
  }
  if (config.NODE_ENV !== 'test') {
    logger.warn(
      'File storage: in memory (CLOUD_STORAGE=memory). Uploaded files are lost when the API restarts; set CLOUD_STORAGE=s3 to keep them.',
    );
  }
  return new MemoryCloudStore();
}
