import { describe, expect, it } from 'vitest';
import { ConfigError, loadEnv, loadScriptEnv } from './env.ts';

const VALID = {
  MONGODB_URI: 'mongodb://localhost:27017/property_erp?directConnection=true',
  JWT_SECRET: 'a'.repeat(32),
  JWT_EXPIRES_IN_SECONDS: '28800',
  CORS_ORIGIN: 'http://localhost:3000',
};

describe('loadEnv', () => {
  it('applies defaults', () => {
    const env = loadEnv(VALID);
    expect(env.PORT).toBe(4000);
    expect(env.NODE_ENV).toBe('development');
    expect(env.CORS_ORIGIN).toEqual(['http://localhost:3000']);
    expect(env.TRUST_PROXY).toBe('loopback');
    expect(env.GST_RATE_PERCENT).toBe('18');
  });

  it('fails fast with every problem listed, without echoing values', () => {
    let error: unknown;
    try {
      loadEnv({ ...VALID, JWT_SECRET: 'short-secret', MONGODB_URI: 'postgres://x' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as ConfigError).message;
    expect(message).toContain('JWT_SECRET');
    expect(message).toContain('MONGODB_URI');
    expect(message).not.toContain('short-secret');
  });

  it('requires the JWT lifetime and CORS origin', () => {
    const { JWT_EXPIRES_IN_SECONDS: _ttl, CORS_ORIGIN: _cors, ...rest } = VALID;
    expect(() => loadEnv(rest)).toThrow(/JWT_EXPIRES_IN_SECONDS[\s\S]*CORS_ORIGIN/);
  });

  it('parses a list of CORS origins and rejects paths', () => {
    expect(
      loadEnv({ ...VALID, CORS_ORIGIN: 'http://localhost:3000, https://erp.example.com' })
        .CORS_ORIGIN,
    ).toEqual(['http://localhost:3000', 'https://erp.example.com']);
    expect(() => loadEnv({ ...VALID, CORS_ORIGIN: 'http://localhost:3000/' })).toThrow(ConfigError);
  });

  it('refuses the example secret in production', () => {
    expect(() =>
      loadEnv({
        ...VALID,
        NODE_ENV: 'production',
        JWT_SECRET: 'dev-only-secret-change-me-0123456789abcdef',
      }),
    ).toThrow(/production/);
  });

  it('parses trust proxy values', () => {
    expect(loadEnv({ ...VALID, TRUST_PROXY: 'false' }).TRUST_PROXY).toBe(false);
    expect(loadEnv({ ...VALID, TRUST_PROXY: '1' }).TRUST_PROXY).toBe(1);
  });
});

describe('loadScriptEnv', () => {
  it('needs only the database URI', () => {
    expect(loadScriptEnv({ MONGODB_URI: VALID.MONGODB_URI }).MONGODB_URI).toBe(VALID.MONGODB_URI);
    expect(() => loadScriptEnv({})).toThrow(ConfigError);
  });
});
