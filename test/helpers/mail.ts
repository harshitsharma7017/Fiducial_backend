import type {
  MailTransport,
  OutgoingMail,
  TransportResult,
} from '../../src/modules/mail/transport.ts';

/**
 * A transport for tests: keeps every mail it is handed, and fails the mails addressed to any
 * address in `failFor` (as an SMTP server refusing them would).
 */
export class FakeTransport implements MailTransport {
  readonly name = 'smtp' as const;
  readonly from = 'rfq@broker.example';
  readonly host = 'smtp.test.invalid';
  readonly sent: OutgoingMail[] = [];
  readonly failFor = new Set<string>();
  /** Every send() call, including the failed ones. */
  calls = 0;

  send(mail: OutgoingMail): Promise<TransportResult> {
    this.calls += 1;
    const failing = mail.to.find((address) => this.failFor.has(address.toLowerCase()));
    if (failing) {
      return Promise.resolve({
        ok: false,
        reason: `The mail server refused the mail (550 ${failing} unknown)`,
      });
    }
    this.sent.push(mail);
    return Promise.resolve({
      ok: true,
      result: 'DELIVERED',
      messageId: `<fake-${this.sent.length}@test>`,
    });
  }

  reset(): void {
    this.sent.length = 0;
    this.failFor.clear();
    this.calls = 0;
  }
}
