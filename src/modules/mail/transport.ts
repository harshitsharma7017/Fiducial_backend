import type { MailStatus, MailTransportName } from '../../shared/index.ts';
import { createTransport, type NodemailerError, type SendMailOptions } from 'nodemailer';
import type { Env } from '../../config/env.ts';
import type { Logger } from '../../lib/logger.ts';

/**
 * One mail as the services hand it over. There is deliberately no cc or bcc: each insurer gets
 * its own mail, so no insurer can see another's address.
 */
export interface OutgoingMail {
  from: string;
  replyTo: string | null;
  to: string[];
  subject: string;
  text: string;
  html: string;
  attachment: { fileName: string; contentType: string; data: Buffer } | null;
}

export type TransportResult =
  | { ok: true; result: 'DELIVERED' | 'OUTBOX'; messageId: string | null }
  | { ok: false; reason: string };

export interface MailTransport {
  readonly name: MailTransportName;
  /** The From address of every mail; null only when mail is off and none is configured. */
  readonly from: string | null;
  /** The SMTP host, shown on Settings; null for outbox and off. */
  readonly host: string | null;
  send(mail: OutgoingMail): Promise<TransportResult>;
}

/** The From address outbox mails carry when MAIL_FROM is unset; they are never delivered. */
export const OUTBOX_FROM = 'rfq@outbox.invalid';

const SMTP_TIMEOUT_MS = 30_000;

/** A header value on one line, so a value can never add a header (header injection). */
export function headerValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/** The part of nodemailer the smtp transport uses; tests pass one built on jsonTransport. */
export interface Mailer {
  sendMail(options: SendMailOptions): Promise<{ messageId?: string | undefined }>;
}

/**
 * Why a mail was not sent, in words a user can act on. Built from the SMTP reply code and text
 * only, never from the error object, which can carry the connection settings; any occurrence
 * of the password is removed all the same.
 */
export function failureReason(error: unknown, secret?: string): string {
  const failure = (error ?? {}) as NodemailerError;
  let reason: string;
  if (typeof failure.responseCode === 'number') {
    const reply = headerValue(String(failure.response ?? '')).slice(0, 200);
    reason = `The mail server refused the mail (${reply || failure.responseCode})`;
  } else {
    switch (failure.code) {
      case 'EAUTH':
      case 'ENOAUTH':
        reason = 'The mail server did not accept the sign-in. Check SMTP_USER and SMTP_PASSWORD.';
        break;
      case 'ETIMEDOUT':
        reason = 'The mail server did not answer in time';
        break;
      case 'ECONNECTION':
      case 'ESOCKET':
      case 'EDNS':
        reason = 'The mail server could not be reached';
        break;
      case 'ETLS':
        reason = 'A secure connection to the mail server could not be made';
        break;
      case 'EENVELOPE':
        reason = 'The mail server refused an address';
        break;
      default:
        reason = 'The mail could not be sent';
    }
  }
  return secret ? reason.split(secret).join('[hidden]') : reason;
}

/** Delivers through an SMTP server (nodemailer). */
export function smtpTransport(options: {
  from: string;
  host: string;
  mailer: Mailer;
  logger: Logger;
  secret?: string;
}): MailTransport {
  const { mailer, logger, secret } = options;
  return {
    name: 'smtp',
    from: options.from,
    host: options.host,
    async send(mail) {
      // Only these fields: never cc or bcc, and no headers taken from user input.
      const message: SendMailOptions = {
        from: headerValue(mail.from),
        to: mail.to.map(headerValue),
        subject: headerValue(mail.subject),
        text: mail.text,
        html: mail.html,
        attachments: mail.attachment
          ? [
              {
                filename: headerValue(mail.attachment.fileName),
                content: mail.attachment.data,
                contentType: mail.attachment.contentType,
              },
            ]
          : [],
      };
      if (mail.replyTo) message.replyTo = headerValue(mail.replyTo);
      try {
        const info = await mailer.sendMail(message);
        return { ok: true, result: 'DELIVERED', messageId: info.messageId ?? null };
      } catch (error) {
        const failure = (error ?? {}) as NodemailerError;
        logger.warn(
          { code: failure.code ?? null, responseCode: failure.responseCode ?? null },
          'SMTP did not accept a mail',
        );
        return { ok: false, reason: failureReason(error, secret) };
      }
    },
  };
}

/** Keeps mails in the mail log only (development and test); nothing is delivered. */
export function outboxTransport(from: string = OUTBOX_FROM): MailTransport {
  return {
    name: 'outbox',
    from,
    host: null,
    send() {
      return Promise.resolve({ ok: true, result: 'OUTBOX', messageId: null });
    },
  };
}

/** Mail is turned off: the services refuse to send (409 MAIL_DISABLED) before calling this. */
export function offTransport(from: string | null = null): MailTransport {
  return {
    name: 'off',
    from,
    host: null,
    send() {
      return Promise.resolve({ ok: false, reason: 'Sending mail is turned off' });
    },
  };
}

/** The transport the environment asks for. env.ts guarantees the smtp settings are present. */
export function transportFromEnv(env: Env, logger: Logger): MailTransport {
  switch (env.MAIL_TRANSPORT) {
    case 'smtp': {
      const host = env.SMTP_HOST ?? '';
      const mailer = createTransport({
        host,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
        connectionTimeout: SMTP_TIMEOUT_MS,
        greetingTimeout: SMTP_TIMEOUT_MS,
        socketTimeout: SMTP_TIMEOUT_MS,
        // Attachments are always buffers built by the API: never read files or URLs.
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      return smtpTransport({
        from: env.MAIL_FROM ?? '',
        host,
        mailer,
        logger,
        secret: env.SMTP_PASSWORD,
      });
    }
    case 'outbox':
      return outboxTransport(env.MAIL_FROM);
    case 'off':
      return offTransport(env.MAIL_FROM ?? null);
  }
}

/** What Settings shows about mail; never the user name or password. */
export function mailStatusOf(transport: MailTransport): MailStatus {
  return { transport: transport.name, from: transport.from, host: transport.host };
}
