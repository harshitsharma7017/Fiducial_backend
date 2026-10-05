import { pino, type Logger, type LevelWithSilent } from 'pino';

export type { Logger };

/** Paths that must never reach the logs. */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'password',
  'passwordHash',
  'accessToken',
  'token',
  '*.password',
  '*.passwordHash',
  '*.accessToken',
  '*.token',
];

export function createLogger(options: { level: LevelWithSilent; name?: string }): Logger {
  return pino({
    level: options.level,
    base: { service: options.name ?? 'property-erp-api' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  });
}
