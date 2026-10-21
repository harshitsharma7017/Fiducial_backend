import { z } from 'zod';
import { IsoDateTimeSchema, ObjectIdSchema } from './common.ts';

// The Age Band Master (N4): named sets of age bands, each band a label with its first and last
// age in completed years. A case uses a copy of the set it was given, so editing the master
// never changes a case or an RFQ already generated; an RFQ version keeps the bands it used.
// No scheme is fixed in code: the "standard" bands are only what a case without a set uses.

export const MAX_AGE = 120;
export const MAX_AGE_BANDS = 30;
export const MAX_AGE_BAND_LABEL = 20;

export interface AgeBand {
  label: string;
  min: number;
  /** Null: no upper age (only the last band). */
  max: number | null;
}

export interface AgeBandSetInput {
  name: string;
  description: string | null;
  bands: AgeBand[];
}

/** What a band looks like before the rules are checked (any value of the right JSON type). */
const RawBandSchema = z.strictObject({
  label: z.string(),
  min: z.number(),
  max: z.number().nullable(),
});

export interface AgeBandIssue {
  path: (string | number)[];
  message: string;
}

const whole = (value: number, min: number, max: number) =>
  Number.isInteger(value) && value >= min && value <= max;

/** "0–18", or "86+" for an open last band. */
export function bandRangeText(band: Pick<AgeBand, 'min' | 'max'>): string {
  return band.max === null ? `${band.min}+` : `${band.min}–${band.max}`;
}

const bandName = (index: number, band: { label: string; min: number; max: number | null }) =>
  `Band ${index + 1}${band.label.trim() ? ` (${band.label.trim()})` : ''}`;

/**
 * Every rule at once (N4.1 to N4.3): 1 to 30 bands in increasing order, whole ages 0 to 120,
 * each band's first age not above its last, labels unique, no overlap and no gap between one
 * band and the next. Only the last band may have no upper age. A set may start above 0 or end
 * below 120: members outside it are reported, never put in the nearest band.
 */
export function ageBandIssues(input: {
  name: string;
  bands: ReadonlyArray<z.infer<typeof RawBandSchema>>;
}): AgeBandIssue[] {
  const issues: AgeBandIssue[] = [];
  const add = (path: (string | number)[], message: string) => issues.push({ path, message });
  const name = input.name.trim();
  if (!name) add(['name'], 'Name the age band set');
  else if (name.length > 80) add(['name'], 'Use at most 80 characters');

  const bands = input.bands;
  if (bands.length < 1 || bands.length > MAX_AGE_BANDS) {
    add(['bands'], `Give the set 1 to ${MAX_AGE_BANDS} bands`);
  }
  const labels = new Map<string, number>();
  bands.forEach((band, index) => {
    const what = bandName(index, band);
    const label = band.label.trim();
    if (!label) add(['bands', index, 'label'], `${what}: enter a label, for example 19–25`);
    else if (label.length > MAX_AGE_BAND_LABEL) {
      add(['bands', index, 'label'], `${what}: use at most ${MAX_AGE_BAND_LABEL} characters`);
    } else {
      const first = labels.get(label.toLowerCase());
      if (first !== undefined) {
        add(['bands', index, 'label'], `${what}: band ${first + 1} already has this label`);
      } else labels.set(label.toLowerCase(), index);
    }
    const minOk = whole(band.min, 0, MAX_AGE);
    if (!minOk)
      add(
        ['bands', index, 'min'],
        `${what}: the first age must be a whole number from 0 to ${MAX_AGE}`,
      );
    if (band.max === null) {
      if (index !== bands.length - 1) {
        add(['bands', index, 'max'], `${what}: only the last band may have no upper age`);
      }
    } else if (!whole(band.max, 0, MAX_AGE)) {
      add(
        ['bands', index, 'max'],
        `${what}: the last age must be a whole number from 0 to ${MAX_AGE}`,
      );
    } else if (minOk && band.max < band.min) {
      add(
        ['bands', index, 'max'],
        `${what}: the last age (${band.max}) is below the first (${band.min})`,
      );
    }
    if (index === 0 || !minOk) return;
    const previous = bands[index - 1]!;
    if (!whole(previous.min, 0, MAX_AGE)) return;
    if (band.min <= previous.min) {
      add(
        ['bands', index, 'min'],
        `${what}: bands must be in increasing order of age; it starts at or below band ${index} (${bandRangeText(previous)})`,
      );
      return;
    }
    if (previous.max === null || !whole(previous.max, 0, MAX_AGE)) return;
    if (band.min <= previous.max) {
      add(
        ['bands', index, 'min'],
        `${what}: overlaps band ${index} (${bandRangeText(previous)}); start it at ${previous.max + 1}`,
      );
    } else if (band.min > previous.max + 1) {
      add(
        ['bands', index, 'min'],
        `${what}: ages ${previous.max + 1}${band.min - 1 > previous.max + 1 ? ` to ${band.min - 1}` : ''} fall in no band; start it at ${previous.max + 1}`,
      );
    }
  });
  return issues;
}

const AgeBandSetBaseSchema = z.strictObject({
  name: z.string({ error: 'Name the age band set' }),
  description: z
    .string()
    .trim()
    .max(500, 'Use at most 500 characters')
    .nullable()
    .default(null)
    .transform((value) => (value === '' ? null : value)),
  bands: z.array(RawBandSchema),
});

/** A set as created or edited, with every rule of N4.2 (all issues at once). */
export const AgeBandSetInputSchema = AgeBandSetBaseSchema.superRefine((input, context) => {
  for (const issue of ageBandIssues(input)) {
    context.addIssue({ code: 'custom', path: issue.path, message: issue.message });
  }
}).transform((input): AgeBandSetInput => ({
  name: input.name.trim(),
  description: input.description,
  bands: input.bands.map((band) => ({ label: band.label.trim(), min: band.min, max: band.max })),
}));
export type AgeBandSetFormValues = z.input<typeof AgeBandSetInputSchema>;

export const AgeBandSchema = z.object({
  label: z.string(),
  min: z.number().int(),
  max: z.number().int().nullable(),
});

export const AgeBandSetSchema = z.object({
  id: ObjectIdSchema,
  name: z.string(),
  description: z.string().nullable(),
  bands: z.array(AgeBandSchema),
  active: z.boolean(),
  /** Each edit raises it; a case's copy names the revision it was taken from. */
  revision: z.number().int(),
  /** A set created at startup (N4: Option 1 and the custom example). */
  seeded: z.boolean(),
  updatedAt: IsoDateTimeSchema,
  updatedBy: z.string(),
});
export type AgeBandSet = z.infer<typeof AgeBandSetSchema>;
export const AgeBandSetListResponseSchema = z.object({ items: z.array(AgeBandSetSchema) });
export const AgeBandSetParamsSchema = z.strictObject({ setId: ObjectIdSchema });

/** The set a case uses: a copy of the master's bands at one revision (N4.7, N4.8). */
export const AgeBandSelectionSchema = z.object({
  setId: ObjectIdSchema,
  name: z.string(),
  revision: z.number().int(),
  bands: z.array(AgeBandSchema),
  selectedAt: IsoDateTimeSchema,
  selectedBy: z.string(),
});
export type AgeBandSelection = z.infer<typeof AgeBandSelectionSchema>;

/** Choose a set for a case (its current revision), or null for the standard bands. */
export const SelectAgeBandsRequestSchema = z.strictObject({ setId: ObjectIdSchema.nullable() });

/** The bands a case without a set uses: the census summary's bands before N4, unchanged. */
export const STANDARD_AGE_BANDS: readonly AgeBand[] = [
  { label: '0–18', min: 0, max: 18 },
  { label: '19–35', min: 19, max: 35 },
  { label: '36–45', min: 36, max: 45 },
  { label: '46–55', min: 46, max: 55 },
  { label: '56–65', min: 56, max: 65 },
  { label: '66+', min: 66, max: null },
];
export const STANDARD_AGE_BANDS_NAME = 'Standard (0–18 to 66+)';

const fiveYearBands = (from: number, to: number): AgeBand[] => {
  const bands: AgeBand[] = [];
  for (let min = from; min <= to; min += 5) {
    bands.push({ label: `${min}–${min + 4}`, min, max: min + 4 });
  }
  return bands;
};

export interface DefaultAgeBandSet {
  seedKey: string;
  name: string;
  description: string;
  bands: AgeBand[];
}

/**
 * The sets created once at startup (never changed by a later start). Option 2 is not created:
 * the client's example of it overlaps, so its boundaries wait for the client (open question
 * AB-1) and an Admin defines it.
 */
export const DEFAULT_AGE_BAND_SETS: readonly DefaultAgeBandSet[] = [
  {
    seedKey: 'OPTION_1',
    name: 'Option 1: 0–18, 19–25, 26–35, then five-year bands to 90',
    description:
      'From the client’s Option 1: 0–18, 19–25, 26–35, then 36–40 and five-year bands through 86–90.',
    bands: [
      { label: '0–18', min: 0, max: 18 },
      { label: '19–25', min: 19, max: 25 },
      { label: '26–35', min: 26, max: 35 },
      ...fiveYearBands(36, 86),
    ],
  },
  {
    seedKey: 'CUSTOM_EXAMPLE',
    name: 'Example: 0–35, 36–45, 46–50',
    description: 'The client’s custom example. Members older than 50 are outside it.',
    bands: [
      { label: '0–35', min: 0, max: 35 },
      { label: '36–45', min: 36, max: 45 },
      { label: '46–50', min: 46, max: 50 },
    ],
  },
  {
    seedKey: 'CLAIMS_ANALYSIS',
    name: 'Claims analysis: 0–10 to Above 70',
    description:
      'The claims analysis bands (N10): ten-year bands to 61–70, then Above 70. The client’s exact boundaries await confirmation (CA-1).',
    bands: [
      { label: '0–10', min: 0, max: 10 },
      { label: '11–20', min: 11, max: 20 },
      { label: '21–30', min: 21, max: 30 },
      { label: '31–40', min: 31, max: 40 },
      { label: '41–50', min: 41, max: 50 },
      { label: '51–60', min: 51, max: 60 },
      { label: '61–70', min: 61, max: 70 },
      { label: 'Above 70', min: 71, max: null },
    ],
  },
  {
    seedKey: 'STANDARD',
    name: STANDARD_AGE_BANDS_NAME,
    description:
      'The bands the census summary used before the Age Band Master; a case without a set uses them.',
    bands: [...STANDARD_AGE_BANDS],
  },
];

/** The index of the band holding an age, or null when the age is in none (N4.3, N4.5). */
export function bandIndexOf(age: number, bands: readonly AgeBand[]): number | null {
  const index = bands.findIndex(
    (band) => age >= band.min && (band.max === null || age <= band.max),
  );
  return index === -1 ? null : index;
}

/** The ages a set covers, as text: "0 to 90", "0 and above". */
export function bandsRangeText(bands: readonly AgeBand[]): string {
  if (bands.length === 0) return 'no ages';
  const first = bands[0]!;
  const last = bands[bands.length - 1]!;
  return last.max === null ? `${first.min} and above` : `${first.min} to ${last.max}`;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real YYYY-MM-DD date. */
export function isRealIsoDate(value: string | null | undefined): value is string {
  if (!value) return false;
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/**
 * Completed years on the reference date (N4.4), as the census has always counted them (0 for a
 * child born after it), or null when the date of birth is missing or not a real date: such a
 * member is reported, never given an age.
 */
export function completedAge(
  dateOfBirth: string | null | undefined,
  referenceDate: string,
): number | null {
  if (!isRealIsoDate(dateOfBirth) || !isRealIsoDate(referenceDate)) return null;
  if (dateOfBirth > referenceDate) return 0;
  const [by, bm, bd] = dateOfBirth.split('-').map(Number) as [number, number, number];
  const [ry, rm, rd] = referenceDate.split('-').map(Number) as [number, number, number];
  return ry - by - (rm < bm || (rm === bm && rd < bd) ? 1 : 0);
}
