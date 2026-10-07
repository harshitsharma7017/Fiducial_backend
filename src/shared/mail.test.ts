import { describe, expect, it } from 'vitest';
import {
  MERGE_FIELDS,
  SAMPLE_MERGE_VALUES,
  SendRfqRequestSchema,
  UpdateEmailTemplateRequestSchema,
  escapeHtml,
  mergeValuesFor,
  parseTemplate,
  policyPeriodText,
  renderMail,
  type MergeField,
  type MergeValues,
} from './mail.ts';

// Generated cases come from a seeded generator, so a failure always reproduces with its seed.
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RUNS = 300;
const VALUE_CHARS = [
  'a',
  'Z',
  '7',
  ' ',
  '<',
  '>',
  '&',
  '"',
  "'",
  '\n',
  '\r',
  '{',
  '}',
  '₹',
  'é',
  '/',
  '=',
];
// Template text has no braces of its own; template() adds single braces deliberately.
const TEXT_CHARS = ['a', 'b', ' ', '\n', ',', '.', '<', '&', '"', '₹'];

function pick<T>(next: () => number, items: readonly T[]): T {
  const item = items[Math.floor(next() * items.length)];
  if (item === undefined) throw new Error('empty list');
  return item;
}

function text(next: () => number, chars: readonly string[], max: number): string {
  let out = '';
  const length = Math.floor(next() * max);
  for (let index = 0; index < length; index += 1) out += pick(next, chars);
  return out;
}

function plainText(next: () => number): string {
  return text(next, TEXT_CHARS, 12);
}

function values(next: () => number): MergeValues {
  return Object.fromEntries(
    MERGE_FIELDS.map((field) => [field, text(next, VALUE_CHARS, 15)]),
  ) as MergeValues;
}

/** A valid template, and the text it must render to for the given values. */
function template(next: () => number, filled: MergeValues): { source: string; expected: string } {
  let source = '';
  let expected = '';
  const pieces = 1 + Math.floor(next() * 6);
  for (let index = 0; index < pieces; index += 1) {
    const chunk = plainText(next);
    source += chunk;
    expected += chunk;
    if (next() < 0.7) {
      const field: MergeField = pick(next, MERGE_FIELDS);
      source += pick(next, [`{{${field}}}`, `{{ ${field} }}`, `{{${field} }}`]);
      expected += filled[field];
    }
    // A single brace next to a field is ordinary text (a space keeps two from forming {{).
    if (next() < 0.1) {
      source += ' {';
      expected += ' {';
    }
    if (next() < 0.1) {
      source += '} ';
      expected += '} ';
    }
  }
  return { source, expected };
}

function unescape(html: string): string {
  return html
    .replace(/^<div>/, '')
    .replace(/<\/div>$/, '')
    .replace(/<br>\n/g, '\n')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

describe('renderMail', () => {
  // Feature: rfq-email, Property 1: Rendering fills every field
  it('replaces every merge field with its value', () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const next = random(seed);
      const filled = values(next);
      // Each value's line breaks become \n as it is inserted into the body.
      const asInserted = Object.fromEntries(
        MERGE_FIELDS.map((field) => [field, filled[field].replace(/\r\n?/g, '\n')]),
      ) as MergeValues;
      const body = template(next, asInserted);
      const mail = renderMail({ subject: 'Subject', body: body.source }, filled);
      expect(mail.text, `seed ${seed}`).toBe(body.expected);
      expect(mail.text).not.toContain('\r');
    }
  });

  // Feature: rfq-email, Property 2: Rendering is safe
  it('escapes every character in the HTML part and keeps the subject on one line', () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const next = random(seed);
      const filled = values(next);
      const subject = template(next, filled);
      const body = template(next, filled);
      const mail = renderMail({ subject: subject.source, body: body.source }, filled);

      expect(mail.subject, `seed ${seed}`).not.toMatch(/[\r\n]/);
      expect(mail.subject).toBe(subject.expected.replace(/\s+/g, ' ').trim());

      expect(mail.html.startsWith('<div>') && mail.html.endsWith('</div>')).toBe(true);
      const inner = mail.html.slice(5, -6).replace(/<br>\n/g, '');
      expect(inner, `seed ${seed}`).not.toMatch(/[<>"']/);
      expect(inner.replace(/&(amp|lt|gt|quot|#39);/g, '')).not.toContain('&');
      expect(unescape(mail.html)).toBe(mail.text);
    }
  });

  it('keeps a client name with markup as text', () => {
    const mail = renderMail(
      { subject: 'RFQ for {{insuredName}}', body: 'Dear {{contactName}},\nFor {{insuredName}}.' },
      { ...SAMPLE_MERGE_VALUES, insuredName: '<b>A & B</b>', contactName: '' },
    );
    expect(mail.subject).toBe('RFQ for <b>A & B</b>');
    expect(mail.text).toBe('Dear ,\nFor <b>A & B</b>.');
    expect(mail.html).toBe('<div>Dear ,<br>\nFor &lt;b&gt;A &amp; B&lt;/b&gt;.</div>');
  });

  it('turns line breaks in values into spaces in the subject', () => {
    const mail = renderMail(
      { subject: '{{insuredName}}  ({{reference}})', body: 'x' },
      { ...SAMPLE_MERGE_VALUES, insuredName: 'Line one\r\nLine two' },
    );
    expect(mail.subject).toBe('Line one Line two (PRP-2026-0001)');
  });

  it('refuses a template that does not parse', () => {
    expect(() => renderMail({ subject: '{{nope}}', body: 'x' }, SAMPLE_MERGE_VALUES)).toThrow(
      /Invalid email template/,
    );
  });
});

describe('parseTemplate', () => {
  const KNOWN = new RegExp(`\\{\\{\\s*(${MERGE_FIELDS.join('|')})\\s*\\}\\}`, 'g');
  /**
   * The reference rule: mark every known field; no {{ or }} may be left in the text around them.
   * The mark keeps the braces on either side of a field apart, as they are in the template.
   */
  const valid = (source: string) => {
    const rest = source.replace(KNOWN, '\u0000');
    return !rest.includes('{{') && !rest.includes('}}');
  };

  // Feature: rfq-email, Property 3: Template validation is exact
  it('accepts a template exactly when every {{...}} is a known field and no brace is stray', () => {
    const tokens = [
      ...MERGE_FIELDS.map((field) => `{{${field}}}`),
      '{{ dueDate }}',
      '{{unknownField}}',
      '{{due date}}',
      '{{',
      '}}',
      '{',
      '}',
      'Dear ',
      'Regards\n',
      'a',
      ' ',
    ];
    for (let seed = 1; seed <= RUNS * 3; seed += 1) {
      const next = random(seed);
      const length = Math.floor(next() * 8);
      let source = '';
      for (let index = 0; index < length; index += 1) source += pick(next, tokens);
      expect(parseTemplate(source).ok, `seed ${seed}: ${JSON.stringify(source)}`).toBe(
        valid(source),
      );
    }
  });

  it('names an unknown field and lists the known ones', () => {
    const parsed = parseTemplate('Dear {{contact}},');
    expect(parsed).toEqual({
      ok: false,
      errors: [
        expect.stringMatching(/^\{\{contact\}\} is not a merge field\. Use one of: insuredName/),
      ],
    });
  });

  it('reports a {{ that is not closed and a }} with no opening', () => {
    const open = parseTemplate('Due by {{dueDate');
    expect(open.ok).toBe(false);
    if (!open.ok) expect(open.errors[0]).toContain('"{{dueDate" is not a merge field');
    const close = parseTemplate('Due by dueDate}}');
    expect(close).toEqual({ ok: false, errors: ['"}}" has no merge field before it'] });
  });

  it('keeps single braces as text', () => {
    expect(parseTemplate('{a} {{ reference }}}')).toEqual({
      ok: true,
      parts: [
        { type: 'text', text: '{a} ' },
        { type: 'field', field: 'reference' },
        { type: 'text', text: '}' },
      ],
    });
  });
});

describe('UpdateEmailTemplateRequestSchema', () => {
  it('reports template problems on the field they are in', () => {
    const result = UpdateEmailTemplateRequestSchema.safeParse({
      subject: 'RFQ {{refrence}}',
      body: 'Body {{dueDate',
      expectedVersion: 1,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join('.'))).toEqual(['subject', 'body']);
    }
  });

  it('accepts a valid template and needs the version', () => {
    const valid = { subject: 'RFQ {{reference}}', body: 'Due {{ dueDate }}', expectedVersion: 2 };
    expect(UpdateEmailTemplateRequestSchema.safeParse(valid).success).toBe(true);
    expect(
      UpdateEmailTemplateRequestSchema.safeParse({ ...valid, expectedVersion: undefined }).success,
    ).toBe(false);
    expect(UpdateEmailTemplateRequestSchema.safeParse({ ...valid, body: '   ' }).success).toBe(
      false,
    );
  });
});

describe('SendRfqRequestSchema', () => {
  const insurer = { insurerId: '0123456789abcdef01234567', to: ['rfq@kavach.example'] };
  const valid = {
    sendId: '7d4b3a3c-6f1e-4d0a-9b8e-2f5c1a9d0e11',
    insurers: [insurer],
    dueDate: '2026-10-20',
    format: 'xlsx',
  };

  it('accepts one mail per insurer with its own addresses', () => {
    expect(SendRfqRequestSchema.safeParse(valid).success).toBe(true);
  });

  it('refuses repeated insurers or addresses, no address, and a missing send id', () => {
    expect(SendRfqRequestSchema.safeParse({ ...valid, insurers: [insurer, insurer] }).success).toBe(
      false,
    );
    expect(
      SendRfqRequestSchema.safeParse({
        ...valid,
        insurers: [{ ...insurer, to: ['a@x.example', 'A@x.example'] }],
      }).success,
    ).toBe(false);
    expect(
      SendRfqRequestSchema.safeParse({ ...valid, insurers: [{ ...insurer, to: [] }] }).success,
    ).toBe(false);
    expect(SendRfqRequestSchema.safeParse({ ...valid, sendId: 'abc' }).success).toBe(false);
    expect(SendRfqRequestSchema.safeParse({ ...valid, cc: ['x@y.example'] }).success).toBe(false);
  });
});

describe('merge values', () => {
  const record = {
    reference: 'PRP-2026-0007',
    client: {
      id: '0123456789abcdef01234567',
      name: 'Kesar Valley Spices LLP',
      gstin: null,
      city: 'Kochi',
      state: 'Kerala',
    },
    policyStart: '2026-11-01',
    policyEnd: '2027-10-31',
  };

  it('fills every field for one insurer', () => {
    expect(
      mergeValuesFor({
        record,
        insurer: { company: 'Kavach General Insurance', branch: 'Pune' },
        contactName: 'Meera Shah',
        dueDate: '2026-10-20',
        senderName: 'Priya Nair',
      }),
    ).toEqual({
      insuredName: 'Kesar Valley Spices LLP',
      policyPeriod: '01 Nov 2026 to 31 Oct 2027',
      dueDate: '20 Oct 2026',
      reference: 'PRP-2026-0007',
      insurerName: 'Kavach General Insurance, Pune',
      contactName: 'Meera Shah',
      senderName: 'Priya Nair',
    });
  });

  it('leaves the contact name empty without a chosen contact', () => {
    expect(
      mergeValuesFor({
        record,
        insurer: { company: 'Kavach', branch: 'Pune' },
        contactName: null,
        dueDate: '2026-10-20',
        senderName: 'P',
      }).contactName,
    ).toBe('');
  });

  it('states the policy period with and without its dates', () => {
    expect(policyPeriodText(null, null)).toBe('1 year from the date of payment');
    expect(policyPeriodText('2026-11-01', null)).toBe('01 Nov 2026 to 31 Oct 2027');
    // A leap year: a year less a day after 1 March 2027 is 29 Feb 2028.
    expect(policyPeriodText('2027-03-01', null)).toBe('01 Mar 2027 to 28 Feb 2028');
    expect(policyPeriodText('2026-11-01', '2027-04-30')).toBe('01 Nov 2026 to 30 Apr 2027');
  });

  it('escapes HTML characters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
  });
});
