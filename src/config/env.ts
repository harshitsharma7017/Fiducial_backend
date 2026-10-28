import { MAIL_TRANSPORTS } from '../shared/index.ts';
import { z } from 'zod';

/** Who reads quote files for the auto-fill (Q1): the built-in text-PDF reader, or Gemini. */
export const OCR_PROVIDERS = ['none', 'gemini'] as const;
export type OcrProvider = (typeof OCR_PROVIDERS)[number];

/**
 * Where every file goes: uploads (quotes, policies, templates, claims, chat…), RFQ versions, mail
 * attachments and documents users save. s3: an Amazon S3 bucket, required in production; the
 * database keeps only each file's key. memory: kept in the process for development and tests
 * only (lost on restart). Nothing is ever stored on the server's disk or in the database.
 */
export const CLOUD_STORAGES = ['memory', 's3'] as const;

/** Express "trust proxy": false, true, a hop count, or a list such as "loopback, 10.0.0.0/8". */
const TrustProxySchema = z
  .string()
  .trim()
  .transform((value): boolean | number | string => {
    if (value === '' || value === 'false') return false;
    if (value === 'true') return true;
    if (/^\d+$/.test(value)) return Number(value);
    return value;
  });

/** Comma-separated list of exact origins, for example "http://localhost:3000". */
const CorsOriginsSchema = z.string().transform((value, ctx) => {
  const origins = value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (origins.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'List at least one origin' });
    return z.NEVER;
  }
  for (const origin of origins) {
    let parsed: URL | null;
    try {
      parsed = new URL(origin);
    } catch {
      parsed = null;
    }
    if (!parsed || parsed.origin !== origin) {
      ctx.addIssue({
        code: 'custom',
        message: `"${origin}" is not an origin such as http://localhost:3000 (no path or trailing slash)`,
      });
      return z.NEVER;
    }
  }
  return origins;
});

const MongoUriSchema = z
  .string()
  .trim()
  .regex(/^mongodb(\+srv)?:\/\//, 'Must start with mongodb:// or mongodb+srv://');

const LogLevelSchema = z
  .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
  .default('info');

const NodeEnvSchema = z.enum(['development', 'test', 'production']).default('development');

export const EnvSchema = z
  .object({
    NODE_ENV: NodeEnvSchema,
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    MONGODB_URI: MongoUriSchema,
    JWT_SECRET: z.string().min(32, 'Must be at least 32 characters'),
    JWT_EXPIRES_IN_SECONDS: z.coerce.number().int().min(300).max(86_400),
    CORS_ORIGIN: CorsOriginsSchema,
    LOG_LEVEL: LogLevelSchema,
    TRUST_PROXY: TrustProxySchema.default('loopback'),
    LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(20),
    LOGIN_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).default(900),
    GST_RATE_PERCENT: z
      .string()
      .trim()
      .regex(/^\d{1,2}(\.\d{1,2})?$/, 'Must be a percentage such as 18')
      .default('18'),
    /** The policy administration software's public API, for renewals' existing policies. */
    EXISTING_POLICY_API_URL: z
      .url({ protocol: /^https?$/, error: 'Must be an http(s) URL' })
      .optional(),
    EXISTING_POLICY_API_KEY: z.string().min(1).optional(),
    EXISTING_POLICY_API_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),
    /** How that software is named on screen, for example "PolicyDesk". */
    EXISTING_POLICY_SOURCE_NAME: z.string().trim().min(1).max(60).default('the policy software'),
    /**
     * A4: days before a placed policy's end date to raise the "renewal due" notification. The scan
     * runs periodically; 0 turns it off. Deduplicated per policy expiry, so it fires once.
     */
    RENEWAL_REMINDER_DAYS: z.coerce.number().int().min(0).max(365).default(30),
    /** How often the renewal-due scan runs, in minutes (0 with RENEWAL_REMINDER_DAYS=0 is off). */
    RENEWAL_SCAN_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1440).default(360),
    /**
     * Q1: who reads insurers' quote files for the quote form's auto-fill. none: the built-in reader
     * (text PDFs only, nothing leaves the server). gemini: Google's Gemini API reads text PDFs,
     * scanned PDFs and pictures; the file or its text is sent to Google.
     */
    OCR_PROVIDER: z.enum(OCR_PROVIDERS).default('none'),
    /** Server-side only; required when OCR_PROVIDER=gemini. Never sent to the browser or logged. */
    GEMINI_API_KEY: z.string().trim().min(1).optional(),
    /** A stable Gemini model that reads PDFs and pictures and answers to a JSON schema. */
    GEMINI_MODEL: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9.-]{2,80}$/, 'Must be a model code such as gemini-3.5-flash')
      .default('gemini-3.5-flash'),
    /** How long one request to Gemini may take before it is abandoned. */
    GEMINI_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(180_000).default(60_000),
    /**
     * How RFQ mails leave: smtp delivers them, outbox only keeps them in the mail log, off refuses
     * to send. Unset means outbox, except off in production, so nothing is mailed by accident.
     */
    MAIL_TRANSPORT: z.enum(MAIL_TRANSPORTS).optional(),
    /** The From address of every mail; required for smtp. */
    MAIL_FROM: z.email('Must be an email address such as rfq@example.com').optional(),
    SMTP_HOST: z.string().trim().min(1).optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).optional(),
    /** true: TLS from the start (port 465); false: STARTTLS when the server offers it. */
    SMTP_SECURE: z
      .enum(['true', 'false'], 'Must be true or false')
      .default('false')
      .transform((value) => value === 'true'),
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASSWORD: z.string().min(1).optional(),
    CLOUD_STORAGE: z.enum(CLOUD_STORAGES).default('memory'),
    /** The bucket and its region; required for s3. */
    S3_BUCKET: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'Must be an S3 bucket name')
      .optional(),
    S3_REGION: z
      .string()
      .trim()
      .regex(/^[a-z]{2}(-[a-z]+)+-\d$/, 'Must be an AWS region such as ap-south-1')
      .optional(),
    /** The folder (key prefix) the documents go under in the bucket. */
    S3_PREFIX: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9!_.*'()-]+(\/[A-Za-z0-9!_.*'()-]+)*$/, 'Must be a folder such as fiducial')
      .default('fiducial'),
    /**
     * Credentials come from the server's IAM role (preferred on EC2) or the standard
     * AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY variables, read by the AWS SDK itself; they are never
     * part of this configuration or logged.
     */
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.JWT_SECRET.startsWith('dev-only')) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_SECRET'],
        message: 'The example development secret cannot be used in production',
      });
    }
    if (env.MAIL_TRANSPORT === 'smtp') {
      const required = {
        MAIL_FROM: env.MAIL_FROM,
        SMTP_HOST: env.SMTP_HOST,
        SMTP_PORT: env.SMTP_PORT,
      };
      for (const [name, value] of Object.entries(required)) {
        if (value === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [name],
            message: 'Required when MAIL_TRANSPORT=smtp',
          });
        }
      }
    }
    if (env.OCR_PROVIDER === 'gemini' && env.GEMINI_API_KEY === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['GEMINI_API_KEY'],
        message: 'Required when OCR_PROVIDER=gemini',
      });
    }
    if (env.NODE_ENV === 'production' && env.CLOUD_STORAGE !== 's3') {
      ctx.addIssue({
        code: 'custom',
        path: ['CLOUD_STORAGE'],
        message:
          'Files are stored in S3 in production: set CLOUD_STORAGE=s3, S3_BUCKET and S3_REGION',
      });
    }
    if (env.CLOUD_STORAGE === 's3') {
      for (const [name, value] of Object.entries({
        S3_BUCKET: env.S3_BUCKET,
        S3_REGION: env.S3_REGION,
      })) {
        if (value === undefined) {
          ctx.addIssue({ code: 'custom', path: [name], message: 'Required when CLOUD_STORAGE=s3' });
        }
      }
    }
    if (env.SMTP_PASSWORD !== undefined && env.SMTP_USER === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['SMTP_PASSWORD'],
        message: 'Set SMTP_USER as well, or leave SMTP_PASSWORD unset',
      });
    }
  })
  .transform((env) => ({
    ...env,
    MAIL_TRANSPORT:
      env.MAIL_TRANSPORT ??
      (env.NODE_ENV === 'production' ? ('off' as const) : ('outbox' as const)),
  }));

export type Env = z.output<typeof EnvSchema>;

/** The subset the CLI scripts need: they only talk to the database. */
export const ScriptEnvSchema = z.object({
  NODE_ENV: NodeEnvSchema,
  MONGODB_URI: MongoUriSchema,
  LOG_LEVEL: LogLevelSchema,
});
export type ScriptEnv = z.output<typeof ScriptEnvSchema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function parseOrThrow<T extends z.ZodType>(schema: T, source: NodeJS.ProcessEnv): z.output<T> {
  const result = schema.safeParse(source);
  if (result.success) return result.data;
  // Issue messages never include the offending values, so secrets are not echoed.
  const problems = result.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  throw new ConfigError(`Invalid environment configuration:\n${problems}`);
}

/** Validates the API environment and fails fast with a readable list of problems. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return parseOrThrow(EnvSchema, source);
}

export function loadScriptEnv(source: NodeJS.ProcessEnv = process.env): ScriptEnv {
  return parseOrThrow(ScriptEnvSchema, source);
}
