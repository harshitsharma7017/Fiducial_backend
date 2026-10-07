import {
  FIRE_GROUPS,
  FIRE_GROUP_LABELS,
  OTHER_SECTION_LABELS,
  OTHER_SECTIONS,
  type ExistingPolicy,
  type FireGroup,
} from '../../shared/index.ts';
import { z } from 'zod';
import { Decimal } from '../../lib/decimal.ts';

// A renewal's existing policy comes from the policy administration software, through its public
// API (D-2). This file is the only place that knows that API: change the request or the mapping
// below when its documentation arrives. Until EXISTING_POLICY_API_URL is set, lookups report
// NOT_CONFIGURED and renewals are created without an Existing column.
//
// Contract assumed for now:
//   GET {EXISTING_POLICY_API_URL}/policies/latest?gstin=27AAAAA0000A1Z5&name=Example%20Mills
//   Authorization: Bearer {EXISTING_POLICY_API_KEY}
//   200 → { insurer, policyNumber, product?, periodStart?, periodEnd?,
//           sections: [{ section, sumInsured, premium? }],
//           fireLines?: [{ line, sumInsured }], netPremium?, gst?, totalPremium? }
//   404 → the client has no policy.
// Sections and Fire lines may be named by our codes (BURGLARY) or by their names (Burglary).
// Amounts may be numbers or strings; dates YYYY-MM-DD or a full ISO date-time.

export interface ExistingPolicyQuery {
  gstin: string | null;
  clientName: string;
}

export type ExistingPolicyResult =
  | { status: 'FOUND'; policy: Omit<ExistingPolicy, 'fetchedAt'> }
  | { status: 'NOT_FOUND' | 'UNAVAILABLE' | 'NOT_CONFIGURED'; message: string };

export interface ExistingPolicySource {
  latest(query: ExistingPolicyQuery): Promise<ExistingPolicyResult>;
}

const Amount = z.union([z.number(), z.string()]).transform((value, context) => {
  const text = String(value).replace(/,/g, '').trim();
  if (!/^\d+(\.\d+)?$/.test(text)) {
    context.addIssue({ code: 'custom', message: `Not an amount: ${String(value)}` });
    return z.NEVER;
  }
  return new Decimal(text).toFixed();
});
const OptionalAmount = Amount.nullish().transform((value) => value ?? null);
const DateText = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}/, 'Not a date')
  .transform((value) => value.slice(0, 10))
  .nullish()
  .transform((value) => value ?? null);

const ExternalPolicySchema = z.object({
  insurer: z.string().trim().min(1),
  policyNumber: z.string().trim().min(1),
  product: z.string().trim().nullish(),
  periodStart: DateText,
  periodEnd: DateText,
  sections: z.array(z.object({ section: z.string(), sumInsured: Amount, premium: OptionalAmount })),
  fireLines: z
    .array(z.object({ line: z.string(), sumInsured: Amount }))
    .nullish()
    .transform((value) => value ?? []),
  netPremium: OptionalAmount,
  gst: OptionalAmount,
  totalPremium: OptionalAmount,
});

const normalise = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const SECTION_NAMES = new Map<string, string>([
  ['fire', 'FIRE'],
  ['fire allied perils', 'FIRE'],
  ['fire and allied perils', 'FIRE'],
  ...OTHER_SECTIONS.flatMap((code) => [
    [normalise(code), code] as [string, string],
    [normalise(OTHER_SECTION_LABELS[code]), code] as [string, string],
  ]),
]);
const LINE_NAMES = new Map<string, FireGroup>(
  FIRE_GROUPS.flatMap((group) => [
    [normalise(group), group] as [string, FireGroup],
    [normalise(FIRE_GROUP_LABELS[group]), group] as [string, FireGroup],
  ]),
);

/** The source's answer in our shape; unknown sections are reported, not guessed. */
export function mapExternalPolicy(
  body: unknown,
  sourceName: string,
): { ok: true; policy: Omit<ExistingPolicy, 'fetchedAt'> } | { ok: false; message: string } {
  const parsed = ExternalPolicySchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      message: `The policy software's answer could not be read (${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'}).`,
    };
  }
  const external = parsed.data;
  const sections: ExistingPolicy['sections'] = [];
  for (const entry of external.sections) {
    const code = SECTION_NAMES.get(normalise(entry.section));
    if (!code) {
      return {
        ok: false,
        message: `The policy software sent an unknown section: "${entry.section}".`,
      };
    }
    sections.push({
      code: code as ExistingPolicy['sections'][number]['code'],
      sumInsured: entry.sumInsured,
      premium: entry.premium,
    });
  }
  const fireLines: ExistingPolicy['fireLines'] = [];
  for (const line of external.fireLines) {
    const group = LINE_NAMES.get(normalise(line.line));
    if (group) fireLines.push({ group, sumInsured: line.sumInsured });
  }
  const total = sections.reduce((sum, section) => sum.plus(section.sumInsured), new Decimal(0));
  return {
    ok: true,
    policy: {
      source: sourceName,
      insurer: external.insurer,
      policyNumber: external.policyNumber,
      product: external.product ?? null,
      periodStart: external.periodStart,
      periodEnd: external.periodEnd,
      sections,
      fireLines,
      totalSumInsured: total.toFixed(),
      netPremium: external.netPremium,
      gst: external.gst,
      totalPremium: external.totalPremium,
    },
  };
}

export const notConfiguredSource: ExistingPolicySource = {
  latest: () =>
    Promise.resolve({
      status: 'NOT_CONFIGURED',
      message:
        'The link to the policy software is not set up yet, so last year’s policy cannot be fetched.',
    }),
};

/** The policy software over HTTP, with a timeout. Network and server errors are UNAVAILABLE. */
export function httpExistingPolicySource(options: {
  baseUrl: string;
  apiKey: string | null;
  timeoutMs: number;
  sourceName: string;
}): ExistingPolicySource {
  return {
    async latest(query) {
      const url = new URL(
        'policies/latest',
        options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`,
      );
      if (query.gstin) url.searchParams.set('gstin', query.gstin);
      url.searchParams.set('name', query.clientName);
      let response: Response;
      try {
        response = await fetch(url, {
          headers: {
            Accept: 'application/json',
            ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
          },
          signal: AbortSignal.timeout(options.timeoutMs),
        });
      } catch {
        return {
          status: 'UNAVAILABLE',
          message: `The policy software (${options.sourceName}) did not answer. Try again later.`,
        };
      }
      if (response.status === 404) {
        return {
          status: 'NOT_FOUND',
          message: `${options.sourceName} has no policy for this client.`,
        };
      }
      if (!response.ok) {
        return {
          status: 'UNAVAILABLE',
          message: `The policy software (${options.sourceName}) answered with an error (${response.status}).`,
        };
      }
      const body: unknown = await response.json().catch(() => null);
      const mapped = mapExternalPolicy(body, options.sourceName);
      return mapped.ok
        ? { status: 'FOUND', policy: mapped.policy }
        : { status: 'UNAVAILABLE', message: mapped.message };
    },
  };
}
