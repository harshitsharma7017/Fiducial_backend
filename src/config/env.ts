import { MAIL_TRANSPORTS } from '../shared/index.ts';
import { z } from 'zod';

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
