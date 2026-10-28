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

describe('mail settings', () => {
  const SMTP = {
    MAIL_TRANSPORT: 'smtp',
    MAIL_FROM: 'rfq@broker.example',
    SMTP_HOST: 'smtp.broker.example',
    SMTP_PORT: '587',
  };

  it('keeps mail in the outbox by default, and turns it off in production', () => {
    expect(loadEnv(VALID).MAIL_TRANSPORT).toBe('outbox');
    expect(loadEnv({ ...VALID, NODE_ENV: 'test' }).MAIL_TRANSPORT).toBe('outbox');
    expect(loadEnv({ ...VALID, NODE_ENV: 'production' }).MAIL_TRANSPORT).toBe('off');
    expect(
      loadEnv({ ...VALID, NODE_ENV: 'production', MAIL_TRANSPORT: 'outbox' }).MAIL_TRANSPORT,
    ).toBe('outbox');
  });

  it('reads the smtp settings', () => {
    const env = loadEnv({ ...VALID, ...SMTP, SMTP_SECURE: 'true', SMTP_USER: 'mailer' });
    expect(env).toMatchObject({
      MAIL_TRANSPORT: 'smtp',
      SMTP_PORT: 587,
      SMTP_SECURE: true,
      SMTP_USER: 'mailer',
    });
    expect(loadEnv({ ...VALID, ...SMTP }).SMTP_SECURE).toBe(false);
  });

  it.each(['MAIL_FROM', 'SMTP_HOST', 'SMTP_PORT'] as const)('needs %s for smtp', (name) => {
    const { [name]: _missing, ...rest } = SMTP;
    expect(() => loadEnv({ ...VALID, ...rest })).toThrow(
      new RegExp(`${name}: Required when MAIL_TRANSPORT=smtp`),
    );
  });

  it('refuses a password without a user, without echoing it', () => {
    let error: unknown;
    try {
      loadEnv({ ...VALID, ...SMTP, SMTP_PASSWORD: 'smtp-secret-password' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toContain('SMTP_PASSWORD');
    expect((error as ConfigError).message).not.toContain('smtp-secret-password');
  });

  it('refuses an unknown transport, a bad From and a bad SMTP_SECURE', () => {
    expect(() => loadEnv({ ...VALID, MAIL_TRANSPORT: 'sendmail' })).toThrow(/MAIL_TRANSPORT/);
    expect(() => loadEnv({ ...VALID, MAIL_FROM: 'not-an-address' })).toThrow(/MAIL_FROM/);
    expect(() => loadEnv({ ...VALID, SMTP_SECURE: 'yes' })).toThrow(/SMTP_SECURE/);
  });
});

describe('quote reading (Q1) settings', () => {
  it('uses the built-in reader by default and needs no key for it', () => {
    const env = loadEnv(VALID);
    expect(env.OCR_PROVIDER).toBe('none');
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.GEMINI_MODEL).toBe('gemini-3.5-flash');
    expect(env.GEMINI_TIMEOUT_MS).toBe(60_000);
  });

  it('reads the Gemini settings', () => {
    const env = loadEnv({
      ...VALID,
      OCR_PROVIDER: 'gemini',
      GEMINI_API_KEY: 'test-gemini-key',
      GEMINI_MODEL: 'gemini-3.6-flash',
      GEMINI_TIMEOUT_MS: '30000',
    });
    expect(env).toMatchObject({
      OCR_PROVIDER: 'gemini',
      GEMINI_API_KEY: 'test-gemini-key',
      GEMINI_MODEL: 'gemini-3.6-flash',
      GEMINI_TIMEOUT_MS: 30_000,
    });
  });

  it('keeps cloud storage off unless an S3 bucket and region are given', () => {
    expect(loadEnv(VALID)).toMatchObject({ CLOUD_STORAGE: 'off', S3_PREFIX: 'fiducial' });
    expect(() => loadEnv({ ...VALID, CLOUD_STORAGE: 's3' })).toThrow(
      /S3_BUCKET: Required when CLOUD_STORAGE=s3[\s\S]*S3_REGION: Required when CLOUD_STORAGE=s3/,
    );
    expect(
      loadEnv({
        ...VALID,
        CLOUD_STORAGE: 's3',
        S3_BUCKET: 'fiducial-documents',
        S3_REGION: 'ap-south-1',
        S3_PREFIX: 'prod/cases',
      }),
    ).toMatchObject({
      CLOUD_STORAGE: 's3',
      S3_BUCKET: 'fiducial-documents',
      S3_REGION: 'ap-south-1',
      S3_PREFIX: 'prod/cases',
    });
    expect(() =>
      loadEnv({ ...VALID, CLOUD_STORAGE: 's3', S3_BUCKET: 'Bad_Bucket', S3_REGION: 'mumbai' }),
    ).toThrow(/S3_BUCKET[\s\S]*S3_REGION/);
  });

  it('fails fast when Gemini is chosen without a key', () => {
    expect(() => loadEnv({ ...VALID, OCR_PROVIDER: 'gemini' })).toThrow(
      /GEMINI_API_KEY: Required when OCR_PROVIDER=gemini/,
    );
    expect(() => loadEnv({ ...VALID, OCR_PROVIDER: 'gemini', GEMINI_API_KEY: '  ' })).toThrow(
      /GEMINI_API_KEY/,
    );
  });

  it('refuses an unknown provider, a bad model code and a bad timeout, without echoing the key', () => {
    let error: unknown;
    try {
      loadEnv({
        ...VALID,
        OCR_PROVIDER: 'tesseract',
        GEMINI_API_KEY: 'secret-gemini-key-value',
        GEMINI_MODEL: 'models/../x y',
        GEMINI_TIMEOUT_MS: '10',
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as ConfigError).message;
    expect(message).toMatch(/OCR_PROVIDER[\s\S]*GEMINI_MODEL[\s\S]*GEMINI_TIMEOUT_MS/);
    expect(message).not.toContain('secret-gemini-key-value');
  });
});

describe('loadScriptEnv', () => {
  it('needs only the database URI', () => {
    expect(loadScriptEnv({ MONGODB_URI: VALID.MONGODB_URI }).MONGODB_URI).toBe(VALID.MONGODB_URI);
    expect(() => loadScriptEnv({})).toThrow(ConfigError);
  });
});
