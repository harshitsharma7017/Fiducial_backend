import { createTransport } from 'nodemailer';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../config/env.ts';
import { createLogger } from '../../lib/logger.ts';
import {
  failureReason,
  headerValue,
  mailStatusOf,
  outboxTransport,
  smtpTransport,
  transportFromEnv,
  type Mailer,
  type OutgoingMail,
} from './transport.ts';

const logger = createLogger({ level: 'silent' });

const MAIL: OutgoingMail = {
  from: 'rfq@broker.example',
  replyTo: 'manager@broker.example',
  to: ['rfq@insurer-a.example', 'pune@insurer-a.example'],
  subject: 'Request for quotation:\r\nBcc: attacker@evil.example',
  text: 'Dear Asha,\nPlease quote.',
  html: '<div>Dear Asha,<br>\nPlease quote.</div>',
  attachment: {
    fileName: 'RFQ-2026-0001.xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    data: Buffer.from('workbook bytes'),
  },
};

interface JsonMessage {
  from: { address: string };
  to: { address: string }[];
  cc?: unknown;
  bcc?: unknown;
  replyTo?: { address: string }[];
  subject: string;
  attachments: { filename: string }[];
  headers?: Record<string, unknown>;
}

/** The smtp transport on nodemailer's jsonTransport, which builds the message but sends nothing. */
function jsonSmtp() {
  const json = createTransport({ jsonTransport: true });
  const messages: JsonMessage[] = [];
  const mailer: Mailer = {
    async sendMail(options) {
      const info = await json.sendMail(options);
      messages.push(JSON.parse(info.message) as JsonMessage);
      return info;
    },
  };
  return {
    messages,
    transport: smtpTransport({ from: MAIL.from, host: 'smtp.test', mailer, logger }),
  };
}

describe('smtp transport', () => {
  it('sends to exactly the given addresses, with no Cc or Bcc and a one-line subject', async () => {
    const { messages, transport } = jsonSmtp();
    const result = await transport.send(MAIL);
    expect(result).toMatchObject({ ok: true, result: 'DELIVERED' });
    expect(result.ok && result.messageId).toMatch(/^<.+>$/);

    const [message] = messages;
    expect(message?.to.map((to) => to.address)).toEqual(MAIL.to);
    expect(message?.cc).toBeUndefined();
    expect(message?.bcc).toBeUndefined();
    expect(message?.subject).toBe('Request for quotation: Bcc: attacker@evil.example');
    expect(message?.subject).not.toMatch(/[\r\n]/);
    expect(message?.replyTo?.map((to) => to.address)).toEqual(['manager@broker.example']);
    expect(message?.attachments.map((file) => file.filename)).toEqual(['RFQ-2026-0001.xlsx']);
  });

  it('sends without Reply-To or an attachment when there is none', async () => {
    const { messages, transport } = jsonSmtp();
    await transport.send({ ...MAIL, replyTo: null, attachment: null });
    expect(messages[0]?.replyTo).toBeUndefined();
    expect(messages[0]?.attachments ?? []).toEqual([]);
  });

  it('maps a refused mail to a reason without the password', async () => {
    const secret = 'smtp-secret-password';
    const mailer: Mailer = {
      sendMail() {
        const error = Object.assign(new Error(`Invalid login for user with pass ${secret}`), {
          code: 'EAUTH',
          responseCode: 535,
          response: `535 5.7.8 Authentication failed ${secret}`,
        });
        return Promise.reject(error);
      },
    };
    const transport = smtpTransport({ from: MAIL.from, host: 'h', mailer, logger, secret });
    const result = await transport.send(MAIL);
    expect(result.ok).toBe(false);
    const reason = result.ok ? '' : result.reason;
    expect(reason).toContain('535 5.7.8 Authentication failed');
    expect(reason).not.toContain(secret);
  });
});

describe('failureReason', () => {
  it.each([
    [{ code: 'ETIMEDOUT' }, 'did not answer in time'],
    [{ code: 'ECONNECTION' }, 'could not be reached'],
    [{ code: 'EAUTH' }, 'did not accept the sign-in'],
    [{ code: 'ETLS' }, 'secure connection'],
    [
      { responseCode: 550, response: '550 5.1.1 No such user\r\nhere' },
      '550 5.1.1 No such user here',
    ],
    [new Error('anything else'), 'The mail could not be sent'],
    [undefined, 'The mail could not be sent'],
  ])('%o', (error, expected) => {
    expect(failureReason(error)).toContain(expected);
  });
});

describe('transportFromEnv', () => {
  const base = {
    MONGODB_URI: 'mongodb://localhost:27017/x',
    JWT_SECRET: 'a'.repeat(32),
    JWT_EXPIRES_IN_SECONDS: '3600',
    CORS_ORIGIN: 'http://localhost:3000',
  };

  it('builds each transport and reports it without credentials', () => {
    const smtp = transportFromEnv(
      loadEnv({
        ...base,
        MAIL_TRANSPORT: 'smtp',
        MAIL_FROM: 'rfq@broker.example',
        SMTP_HOST: 'smtp.broker.example',
        SMTP_PORT: '465',
        SMTP_USER: 'mailer',
        SMTP_PASSWORD: 'smtp-secret-password',
      }),
      logger,
    );
    expect(mailStatusOf(smtp)).toEqual({
      transport: 'smtp',
      from: 'rfq@broker.example',
      host: 'smtp.broker.example',
    });
    expect(mailStatusOf(transportFromEnv(loadEnv(base), logger))).toEqual({
      transport: 'outbox',
      from: 'rfq@outbox.invalid',
      host: null,
    });
    expect(
      mailStatusOf(transportFromEnv(loadEnv({ ...base, NODE_ENV: 'production' }), logger)),
    ).toEqual({ transport: 'off', from: null, host: null });
  });

  it('keeps outbox mails without delivering them', async () => {
    expect(await outboxTransport().send(MAIL)).toEqual({
      ok: true,
      result: 'OUTBOX',
      messageId: null,
    });
  });
});

describe('headerValue', () => {
  it('puts a value on one line', () => {
    expect(headerValue(' a\r\nb\nc\r ')).toBe('a b c');
  });
});
