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
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.JWT_SECRET.startsWith('dev-only')) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_SECRET'],
        message: 'The example development secret cannot be used in production',
      });
    }
  });

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
