import { z } from 'zod';
import { ADDON_LISTS } from './addon-lists.ts';
import { OccupancyRefSchema } from './clients.ts';
import {
  CursorSchema,
  IsoDateTimeSchema,
  LimitSchema,
  ObjectIdSchema,
  blankAsNull,
  paginatedSchema,
} from './common.ts';
import { AddressSchema } from './contacts.ts';
import { EqZoneSchema } from './masters.ts';

// New-business proposals, from creation to the RFQ (milestones M2 and M3 in part). Renewals are
// not served by this API yet. Typed amounts are whole rupees as digit strings; areas and rates per
// square foot are decimal strings. A building priced as area × rate is kept exact (it can carry
// paise, as in Excel), and so are the totals that include it; screens and the RFQ show them to the
// rupee, as the client's sheets do.

/** New business, or the renewal of an existing policy. */
export const PROPOSAL_TYPES = ['NEW', 'EXISTING'] as const;
export const ProposalTypeSchema = z.enum(PROPOSAL_TYPES);
export type ProposalType = z.infer<typeof ProposalTypeSchema>;

/**
 * The 9 stages of every case, in order. Draft, Data Sheet and RFQ Sent follow from the work
 * itself; the later ones are moved to by the team, one at a time; a case can be closed (lost or
 * not renewed) at any stage before Placed.
 */
export const PROPOSAL_STAGES = [
  'DRAFT',
  'DATA_SHEET',
  'RFQ_SENT',
  'QUOTES_RECEIVED',
  'QCR',
  'CLIENT_APPROVAL',
  'PLACEMENT_SLIP',
  'PLACED',
  'CLOSED',
] as const;
export const ProposalStageSchema = z.enum(PROPOSAL_STAGES);
export type ProposalStage = z.infer<typeof ProposalStageSchema>;
export const PROPOSAL_STAGE_LABELS: Record<ProposalStage, string> = {
  DRAFT: 'Draft',
  DATA_SHEET: 'Data Sheet',
  RFQ_SENT: 'RFQ Sent',
  QUOTES_RECEIVED: 'Quotes Received',
  QCR: 'QCR',
  CLIENT_APPROVAL: 'Client Approval',
  PLACEMENT_SLIP: 'Placement Slip',
  PLACED: 'Placed',
  CLOSED: 'Closed',
};
/** The stages that follow from the Data Sheet and the RFQ; the rest are set by the team. */
export const AUTOMATIC_STAGES: readonly ProposalStage[] = ['DRAFT', 'DATA_SHEET', 'RFQ_SENT'];

/** The Fire lines of the RFQ schedule, in its order, with the client's wording. */
export const FIRE_GROUPS = [
  'BUILDING',
  'FFF',
  'OFFICE_EQUIPMENT',
  'ELECTRICAL',
  'PLANT_MACHINERY',
  'STOCKS',
  'OTHER',
] as const;
export type FireGroup = (typeof FIRE_GROUPS)[number];
export const FIRE_GROUP_LABELS: Record<FireGroup, string> = {
  BUILDING:
    'All Building & all type of civil structures Including Plinth & Foundation, Compound wall, False ceiling and Interiors',
  FFF: 'Furniture, Fixtures and Fittings',
  OFFICE_EQUIPMENT:
    'Office equipments and all communication systems like computer systems, computer peripherals, telephones, etc.',
  ELECTRICAL:
    'Entire power & Electrical Installations with all its accessories such as sub systems, cables, panels, etc.',
  PLANT_MACHINERY: 'All types of Plant and Machinery and all its accessories',
  STOCKS: 'All types of stock pertaining to insured business',
  OTHER: 'Any other items specifically not mentioned in the above',
};

/**
 * The Data Sheet's "Fire & Burglary" items per location, numbered and worded as in the client's
 * Data Sheet: 7 items, with sub-items under 1 (buildings), 5 (plant and machinery) and 6 (stock).
 * Buildings are measured: their sum insured is area × rate, as in the sheet's Sq. Feet and
 * Rate / sq ft columns.
 */
export const FIRE_ITEMS = [
  {
    key: 'BUILDING_1',
    group: 'BUILDING',
    number: '1a',
    label: 'Building 1 (if applicable)',
    measured: true,
  },
  {
    key: 'BUILDING_2',
    group: 'BUILDING',
    number: '1b',
    label: 'Building 2 (if applicable)',
    measured: true,
  },
  { key: 'COMPOUND_WALL', group: 'BUILDING', number: '1c', label: 'Compound wall', measured: true },
  { key: 'FALSE_CEILING', group: 'BUILDING', number: '1d', label: 'False ceiling', measured: true },
  {
    key: 'PLINTH_FOUNDATION',
    group: 'BUILDING',
    number: '1e',
    label: 'Plinth & Foundation',
    measured: true,
  },
  { key: 'INTERIOR', group: 'BUILDING', number: '1f', label: 'Interior', measured: true },
  {
    key: 'FFF',
    group: 'FFF',
    number: '2',
    label: 'Furniture, Fixtures and Fittings',
    measured: false,
  },
  {
    key: 'OFFICE_EQUIPMENT',
    group: 'OFFICE_EQUIPMENT',
    number: '3',
    label:
      'Office equipments and all communication systems like computer systems, computer peripherals, Air conditioner, EPBX and allied Items',
    measured: false,
  },
  {
    key: 'ELECTRICAL',
    group: 'ELECTRICAL',
    number: '4',
    label:
      'Entire power & Electrical Installations with all its accessories such as sub systems, UPS, cables and all electrical/ Light fittings other than specifically insured',
    measured: false,
  },
  {
    key: 'GENSET',
    group: 'PLANT_MACHINERY',
    number: '5a',
    label: 'Genset and all its accessories',
    measured: false,
  },
  {
    key: 'COMPRESSOR',
    group: 'PLANT_MACHINERY',
    number: '5b',
    label: 'Compressor and all its accessories',
    measured: false,
  },
  {
    key: 'TRANSFORMER',
    group: 'PLANT_MACHINERY',
    number: '5c',
    label: 'Transformer and all its accessories',
    measured: false,
  },
  {
    key: 'OTHER_MACHINERY',
    group: 'PLANT_MACHINERY',
    number: '5d',
    label: 'All other machineries and all its accessories',
    measured: false,
  },
  {
    key: 'STOCKS',
    group: 'STOCKS',
    number: '6',
    label: 'All types of stock pertaining to insured business',
    measured: false,
  },
  {
    key: 'STOCKS_THIRD_PARTY',
    group: 'STOCKS',
    number: '6a',
    label: 'Any other stocks kept at third party job work location',
    measured: false,
  },
  {
    key: 'OTHER',
    group: 'OTHER',
    number: '7',
    label: 'Any other items specifically not mentioned in the above',
    measured: false,
  },
] as const satisfies readonly {
  key: string;
  group: FireGroup;
  number: string;
  label: string;
  measured: boolean;
}[];

/** The Data Sheet's heading rows for items 1 and 5, whose sum insured is that of their sub-items. */
export const FIRE_ITEM_HEADINGS: Partial<Record<FireGroup, { number: string; label: string }>> = {
  BUILDING: {
    number: '1',
    label:
      'All Building & all type of civil structures Including Plinth & Foundation, Compound wall, False Ceiling and all Allied Building',
  },
  PLANT_MACHINERY: {
    number: '5',
    label: 'All types of Plant and Machinery and all its accessories',
  },
};

/** The Data Sheet's wording of the two fields after the Fire total (D-7). */
export const HYPOTHECATION_LABEL = 'Hypothecation if any - Please specify';
export const OPEN_STOCK_LABEL = 'Stock kept at open space if any - Please Specify';

export type FireItemKey = (typeof FIRE_ITEMS)[number]['key'];
export const FIRE_ITEM_KEYS = FIRE_ITEMS.map((item) => item.key) as [FireItemKey, ...FireItemKey[]];

/** The coverage sections other than Fire, captured by sum insured in this round. */
export const OTHER_SECTIONS = [
  'BURGLARY',
  'FIRE_FLOATER',
  'BURGLARY_FLOATER',
  'FIRE_LOSS_OF_PROFIT',
  'MONEY',
  'FIDELITY_GUARANTEE',
  'PLATE_GLASS',
  'NEON_GLOW_SIGN',
  'ALL_RISK',
  'EEI',
  'MECHANICAL_BREAKDOWN',
  'BOILER_PRESSURE_PLANT',
  'PUBLIC_LIABILITY',
] as const;
export type OtherSection = (typeof OTHER_SECTIONS)[number];
export const OTHER_SECTION_LABELS: Record<OtherSection, string> = {
  BURGLARY: 'Burglary',
  FIRE_FLOATER: 'Fire Floater',
  BURGLARY_FLOATER: 'Burglary Floater',
  FIRE_LOSS_OF_PROFIT: 'Fire Loss of Profit',
  MONEY: 'Money',
  FIDELITY_GUARANTEE: 'Fidelity Guarantee',
  PLATE_GLASS: 'Plate Glass',
  NEON_GLOW_SIGN: 'Neon / Glow Sign',
  ALL_RISK: 'All Risk',
  EEI: 'EEI',
  MECHANICAL_BREAKDOWN: 'Mechanical Breakdown',
  BOILER_PRESSURE_PLANT: 'Boiler and Pressure Plant',
  PUBLIC_LIABILITY: 'Public Liability',
};

/**
 * The lines the client's Data Sheet asks for under some sections (D-4), worded as the sheet.
 * All are numbers: rupee amounts, or a count. FLOP's only line is its sum insured.
 */
export const SECTION_LINES = {
  FIRE_LOSS_OF_PROFIT: [{ key: 'annualGrossProfit', label: 'Annual Gross Profit', kind: 'rupees' }],
  MONEY: [
    { key: 'cashInSafe', label: 'Cash in safe / counter', kind: 'rupees' },
    {
      key: 'cashInTransitSingle',
      label: 'Cash in transit - Single carrying limit',
      kind: 'rupees',
    },
    {
      key: 'cashInTransitAnnual',
      label: 'Cash in transit - Annual carrying limit',
      kind: 'rupees',
    },
  ],
  FIDELITY_GUARANTEE: [
    { key: 'employees', label: 'No of Employees', kind: 'count' },
    { key: 'limitPerEmployee', label: 'Limit of liability per Employee', kind: 'rupees' },
    { key: 'limitPerPeriod', label: 'Limit of liability per policy period', kind: 'rupees' },
  ],
  PUBLIC_LIABILITY: [
    { key: 'anyOneAccident', label: 'Any One Accident Limit', kind: 'rupees' },
    { key: 'aggregateLimit', label: 'Aggregate Limit Per Policy Period', kind: 'rupees' },
  ],
} as const satisfies Partial<
  Record<OtherSection, readonly { key: string; label: string; kind: 'rupees' | 'count' }[]>
>;
export type SectionWithLines = keyof typeof SECTION_LINES;
export const SECTION_LINE_KEYS = Object.values(SECTION_LINES).flatMap((lines) =>
  lines.map((line) => line.key),
) as [string, ...string[]];
/** The section whose sum insured is one of its lines (FLOP: the annual gross profit). */
export const SUM_INSURED_LINE: Partial<Record<OtherSection, string>> = {
  FIRE_LOSS_OF_PROFIT: 'annualGrossProfit',
};

/** The annexure grids (D-5), with the client's Annexure sheet columns. Sum Insured is always last. */
export const ANNEXURE_COLUMNS = {
  description: 'Description',
  quantity: 'No of Plate Glass',
  dimensions: 'Dimension (L x B x H)',
  makeModel: 'Make & Model',
  serialNo: 'Serial No',
  year: 'Year of Make / Purchase',
} as const;
export type AnnexureColumn = keyof typeof ANNEXURE_COLUMNS;
const EQUIPMENT_COLUMNS = ['description', 'makeModel', 'serialNo', 'year'] as const;
export const ANNEXURE_SECTIONS = {
  PLATE_GLASS: {
    title: 'Plate Glass',
    columns: ['description', 'quantity', 'dimensions'],
    quantityLabel: 'No of Plate Glass',
  },
  NEON_GLOW_SIGN: {
    title: 'Neon / Glow Sign',
    columns: ['description', 'quantity', 'dimensions'],
    quantityLabel: 'No of Sign Board',
  },
  ALL_RISK: {
    title: 'All Risk (for mobile phones & laptops)',
    columns: EQUIPMENT_COLUMNS,
    quantityLabel: null,
  },
  EEI: {
    title: 'Electronic Equipment Insurance (EEI) (for electronic based equipments)',
    columns: EQUIPMENT_COLUMNS,
    quantityLabel: null,
  },
  MECHANICAL_BREAKDOWN: {
    title: 'Mechanical Breakdown (MBD) (for electrical / mechanical based equipments)',
    columns: EQUIPMENT_COLUMNS,
    quantityLabel: null,
  },
  BOILER_PRESSURE_PLANT: {
    title: 'Boiler & Pressure Plant Insurance',
    columns: EQUIPMENT_COLUMNS,
    quantityLabel: null,
  },
} as const satisfies Partial<
  Record<
    OtherSection,
    { title: string; columns: readonly AnnexureColumn[]; quantityLabel: string | null }
  >
>;
export type AnnexureSection = keyof typeof ANNEXURE_SECTIONS;
export const MAX_ANNEXURE_ROWS = 200;

export function isAnnexureSection(code: string): code is AnnexureSection {
  return code in ANNEXURE_SECTIONS;
}

/** The label of an annexure column in a section (the count column differs by section). */
export function annexureColumnLabel(code: AnnexureSection, column: AnnexureColumn): string {
  return column === 'quantity'
    ? (ANNEXURE_SECTIONS[code].quantityLabel ?? ANNEXURE_COLUMNS.quantity)
    : ANNEXURE_COLUMNS[column];
}

/**
 * The basis of a Burglary sum insured (C-3), as in the RFQ schedule's optional rows: the full
 * value, or a first loss of 25, 50 or 75% of it.
 */
export const BURGLARY_BASES = ['FULL', 'FIRST_LOSS_25', 'FIRST_LOSS_50', 'FIRST_LOSS_75'] as const;
export type BurglaryBasis = (typeof BURGLARY_BASES)[number];
export const BURGLARY_BASIS_PERCENT: Record<BurglaryBasis, number> = {
  FULL: 100,
  FIRST_LOSS_25: 25,
  FIRST_LOSS_50: 50,
  FIRST_LOSS_75: 75,
};
export const BURGLARY_BASIS_LABELS: Record<BurglaryBasis, string> = {
  FULL: '100% of sum insured',
  FIRST_LOSS_25: '1st loss basis 25% of sum insured',
  FIRST_LOSS_50: '1st loss basis 50% of sum insured',
  FIRST_LOSS_75: '1st loss basis 75% of sum insured',
};
/** The sections with a basis. Burglary's sum insured is the Fire contents (all but buildings). */
export const BASIS_SECTIONS = [
  'BURGLARY',
  'BURGLARY_FLOATER',
] as const satisfies readonly OtherSection[];
export function hasBasis(code: string): code is (typeof BASIS_SECTIONS)[number] {
  return (BASIS_SECTIONS as readonly string[]).includes(code);
}

/** Fire's add-on covers on the RFQ until the coverage section master gives them. */
export const DEFAULT_FIRE_COVERS = [
  'Earthquake',
  'Storm, Tempest, Flood & Inundation',
  'Terrorism',
];

/** The RFQ's "risk details" per location. */
export const RISK_DETAIL_FIELDS = [
  { key: 'fireFighting', label: 'Fire fighting arrangement' },
  { key: 'buildingAge', label: 'Age of building' },
  { key: 'construction', label: 'Type of construction' },
  { key: 'electrical', label: 'Electrical installation at risk premises' },
  { key: 'claimExperience', label: 'Claim experience' },
  { key: 'watchAndWard', label: 'Watch and ward' },
  { key: 'workingHours', label: 'Working hours / shifts' },
  { key: 'stockComposition', label: 'Stock composition' },
  { key: 'basementExposure', label: 'Basement exposure towards contents' },
] as const;
export type RiskDetailKey = (typeof RISK_DETAIL_FIELDS)[number]['key'];

export const MAX_PROPOSAL_INSURERS = 5;
export const MAX_CLAIM_ROWS = 3;

/** Whole rupees; blank is no amount. */
export const WholeRupeesSchema = z
  .string()
  .trim()
  .regex(/^\d{1,13}$/, 'Enter whole rupees, digits only');
const OptionalRupees = blankAsNull(WholeRupeesSchema);
const Area = blankAsNull(
  z
    .string()
    .trim()
    .regex(/^\d{1,9}(\.\d{1,2})?$/, 'Enter the area in sq ft, up to 2 decimals'),
);
const OptionalText = (max: number) => blankAsNull(z.string().trim().max(max, 'This is too long'));

export const FireItemInputSchema = z.strictObject({
  key: z.enum(FIRE_ITEM_KEYS),
  sqFt: Area,
  ratePerSqFt: OptionalRupees,
  /** Typed amount. Blank on a measured item means area × rate. */
  amount: OptionalRupees,
});

const RiskDetailsInputSchema = z.strictObject(
  Object.fromEntries(RISK_DETAIL_FIELDS.map((field) => [field.key, OptionalText(300)])) as Record<
    RiskDetailKey,
    ReturnType<typeof OptionalText>
  >,
);

/** One row of an annexure grid. Columns a section does not have are left blank. */
export const AnnexureRowInputSchema = z.strictObject({
  description: z.string().trim().min(1, 'Describe the item').max(300, 'This is too long'),
  quantity: blankAsNull(
    z
      .string()
      .trim()
      .regex(/^\d{1,6}$/, 'Enter a number'),
  ),
  dimensions: OptionalText(100),
  makeModel: OptionalText(200),
  serialNo: OptionalText(100),
  year: blankAsNull(
    z
      .string()
      .trim()
      .regex(/^(19|20)\d{2}$/, 'Enter the year, for example 2021'),
  ),
  sumInsured: WholeRupeesSchema,
});
export type AnnexureRowInput = z.infer<typeof AnnexureRowInputSchema>;

/** A section's add-on cover (C-6: earthquake, STFI, terrorism, floater...): asked for or not. */
export const CoverInputSchema = z.strictObject({
  name: z.string().trim().min(1, 'Name the cover').max(300, 'This is too long'),
  required: z.boolean(),
});
export type CoverInput = z.infer<typeof CoverInputSchema>;

/** An add-on cover chosen from the product's add-on lists (C-4). */
export const ChosenAddonSchema = z.strictObject({
  list: z.enum(ADDON_LISTS),
  name: z.string().trim().min(1, 'Name the add-on').max(300, 'This is too long'),
});
export type ChosenAddon = z.infer<typeof ChosenAddonSchema>;
export const MAX_CHOSEN_ADDONS = 400;

/** A client's favourite add-on covers (C-4), offered first on each of its cases. */
export const AddonFavouritesSchema = z.object({
  items: z.array(z.object({ list: z.enum(ADDON_LISTS), name: z.string() })),
  updatedAt: IsoDateTimeSchema.nullable(),
});
export type AddonFavourites = z.infer<typeof AddonFavouritesSchema>;
export const SetAddonFavouritesRequestSchema = z.strictObject({
  items: z
    .array(ChosenAddonSchema)
    .max(MAX_CHOSEN_ADDONS)
    .refine(
      (items) =>
        new Set(items.map((item) => `${item.list}|${item.name.toLowerCase()}`)).size ===
        items.length,
      'Each add-on can be a favourite once',
    ),
});
export type SetAddonFavouritesRequest = z.infer<typeof SetAddonFavouritesRequestSchema>;

const LineValues = z
  .partialRecord(
    z.enum(SECTION_LINE_KEYS),
    blankAsNull(
      z
        .string()
        .trim()
        .regex(/^\d{1,13}$/, 'Enter a whole number, digits only'),
    ),
  )
  .default({});

const ProductCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Z][A-Z0-9_]{1,39}$/, 'Choose a product');

export const LocationDataInputSchema = z.strictObject({
  locationId: ObjectIdSchema,
  fire: z.array(FireItemInputSchema).max(FIRE_ITEMS.length),
  hypothecation: OptionalText(300),
  openStock: OptionalText(300),
  risk: RiskDetailsInputSchema,
});

export const DataSheetInputSchema = z
  .strictObject({
    dueDate: z.iso.date({ error: 'Enter the date quotes are needed by' }),
    policyStart: blankAsNull(z.iso.date({ error: 'Enter a date' })),
    policyEnd: blankAsNull(z.iso.date({ error: 'Enter a date' })),
    locations: z.array(LocationDataInputSchema).max(200),
    /** Proposed Option 2 for each Fire line; blank when there is no second option. */
    fireOption2: z.array(z.strictObject({ group: z.enum(FIRE_GROUPS), amount: OptionalRupees })),
    /** Fire's add-on covers asked for (C-6). */
    fireCovers: z.array(CoverInputSchema).max(50).default([]),
    /**
     * The product (C-1): blank follows the suggestion from the Fire sum insured. A product the
     * suggestion does not hold needs the reason.
     */
    product: z
      .strictObject({ code: blankAsNull(ProductCodeSchema), reason: OptionalText(300) })
      .default({ code: null, reason: null }),
    /** Add-on covers chosen from the product's lists (C-4). */
    addons: z.array(ChosenAddonSchema).max(MAX_CHOSEN_ADDONS).default([]),
    /**
     * Renewals: last year's policy as the Existing column (C-2). Starts as the policy software's
     * copy; what is typed here is used instead. Blank throughout: the software's copy.
     */
    existing: z
      .strictObject({
        insurer: OptionalText(200),
        policyNumber: OptionalText(100),
        fireLines: z
          .array(z.strictObject({ group: z.enum(FIRE_GROUPS), amount: OptionalRupees }))
          .max(FIRE_GROUPS.length),
        /** The Fire total when no line is given. */
        fireTotal: OptionalRupees,
      })
      .nullable()
      .default(null),
    sections: z.array(
      z.strictObject({
        code: z.enum(OTHER_SECTIONS),
        included: z.boolean(),
        proposed1: OptionalRupees,
        proposed2: OptionalRupees,
        /** Renewals: last year's sum insured (C-2). */
        existing: OptionalRupees.default(null),
        /** The section's lines (SECTION_LINES), by key: digits, blank for none. */
        lines: LineValues,
        /** Option 2 of the lines (C-2). */
        lines2: LineValues,
        /** Renewals: last year's lines (C-2). */
        existingLines: LineValues,
        /** Burglary and Burglary Floater: 100% or first loss (C-3). */
        basis: z.enum(BURGLARY_BASES).nullable().default(null),
        /** The section's add-on covers asked for (C-6). */
        covers: z.array(CoverInputSchema).max(50).default([]),
        /** The annexure grid of an annexure section (ANNEXURE_SECTIONS). */
        annexure: z.array(AnnexureRowInputSchema).max(MAX_ANNEXURE_ROWS).default([]),
      }),
    ),
    claims: z
      .array(
        z.strictObject({
          period: z.string().trim().min(1, 'Enter the policy period').max(20),
          policyType: OptionalText(100),
          sumInsured: OptionalRupees,
          premium: OptionalRupees,
          claimedAmount: OptionalRupees,
          remarks: OptionalText(300),
          insurer: OptionalText(200),
        }),
      )
      .max(MAX_CLAIM_ROWS, `Add at most ${MAX_CLAIM_ROWS} years of claims`),
    notes: OptionalText(1000),
  })
  .superRefine((sheet, context) => {
    checkPeriod(sheet, context);
    sheet.sections.forEach((section, index) => {
      const allowed = new Set<string>(
        (SECTION_LINES[section.code as SectionWithLines] ?? []).map((line) => line.key),
      );
      for (const field of ['lines', 'lines2', 'existingLines'] as const) {
        for (const key of Object.keys(section[field])) {
          if (!allowed.has(key)) {
            context.addIssue({
              code: 'custom',
              path: ['sections', index, field, key],
              message: `${OTHER_SECTION_LABELS[section.code]} has no such line`,
            });
          }
        }
      }
      if (section.basis !== null && !hasBasis(section.code)) {
        context.addIssue({
          code: 'custom',
          path: ['sections', index, 'basis'],
          message: `${OTHER_SECTION_LABELS[section.code]} has no basis`,
        });
      }
      if (section.annexure.length > 0 && !isAnnexureSection(section.code)) {
        context.addIssue({
          code: 'custom',
          path: ['sections', index, 'annexure'],
          message: `${OTHER_SECTION_LABELS[section.code]} has no annexure`,
        });
      }
    });
    const chosen = sheet.addons.map((addon) => `${addon.list}|${addon.name.toLowerCase()}`);
    if (new Set(chosen).size !== chosen.length) {
      context.addIssue({
        code: 'custom',
        path: ['addons'],
        message: 'Each add-on can be chosen once',
      });
    }
    if (sheet.product.code === null && sheet.product.reason !== null) {
      context.addIssue({
        code: 'custom',
        path: ['product', 'code'],
        message: 'Choose the product the reason is for',
      });
    }
    // Typed Existing figures need the policy they come from.
    if (sheet.existing && sheet.existing.insurer === null && hasExistingFigures(sheet)) {
      context.addIssue({
        code: 'custom',
        path: ['existing', 'insurer'],
        message: 'Enter last year’s insurer',
      });
    }
    const ids = sheet.locations.map((location) => location.locationId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: 'custom',
        path: ['locations'],
        message: 'Each location can be added once',
      });
    }
  });
export type DataSheetInput = z.infer<typeof DataSheetInputSchema>;

/** True when the Data Sheet types any Existing figure (C-2). */
export function hasExistingFigures(sheet: {
  existing: { fireLines: { amount: string | null }[]; fireTotal: string | null } | null;
  sections: {
    existing?: string | null;
    existingLines?: Partial<Record<string, string | null | undefined>>;
  }[];
}): boolean {
  return (
    Boolean(sheet.existing?.fireTotal) ||
    Boolean(sheet.existing?.fireLines.some((line) => line.amount)) ||
    sheet.sections.some(
      (section) =>
        Boolean(section.existing) ||
        Object.values(section.existingLines ?? {}).some((value) => Boolean(value)),
    )
  );
}
export type DataSheetFormValues = z.input<typeof DataSheetInputSchema>;

/** Policy period checks shared by creation and the Data Sheet. */
function checkPeriod(
  period: { policyStart: string | null; policyEnd: string | null },
  context: z.RefinementCtx,
) {
  if (period.policyEnd && !period.policyStart) {
    context.addIssue({
      code: 'custom',
      path: ['policyStart'],
      message: 'Enter the start of the policy period',
    });
  }
  if (period.policyStart && period.policyEnd && period.policyEnd <= period.policyStart) {
    context.addIssue({
      code: 'custom',
      path: ['policyEnd'],
      message: 'The policy period must end after it starts',
    });
  }
}

export const CreateProposalRequestSchema = z
  .strictObject({
    type: ProposalTypeSchema.default('NEW'),
    clientId: ObjectIdSchema,
    locationIds: z.array(ObjectIdSchema).max(200),
    /** Assigned staff; the creator when left out. */
    ownerId: ObjectIdSchema.optional(),
    /** New business may leave both blank: 1 year from the date of payment. */
    policyStart: blankAsNull(z.iso.date({ error: 'Enter a date' })).default(null),
    policyEnd: blankAsNull(z.iso.date({ error: 'Enter a date' })).default(null),
    dueDate: z.iso.date({ error: 'Enter the date quotes are needed by' }),
  })
  .superRefine((body, context) => {
    checkPeriod(body, context);
    if (body.type === 'EXISTING' && (!body.policyStart || !body.policyEnd)) {
      context.addIssue({
        code: 'custom',
        path: [body.policyStart ? 'policyEnd' : 'policyStart'],
        message: 'A renewal needs its policy period',
      });
    }
  });
export type CreateProposalRequest = z.infer<typeof CreateProposalRequestSchema>;
export type CreateProposalFormValues = z.input<typeof CreateProposalRequestSchema>;

/** Moves a case to the next stage, or closes it (with the reason). */
export const MoveProposalStageRequestSchema = z
  .strictObject({
    stage: ProposalStageSchema,
    reason: blankAsNull(z.string().trim().max(300, 'This is too long')).default(null),
  })
  .refine((body) => body.stage !== 'CLOSED' || body.reason !== null, {
    path: ['reason'],
    message: 'Say why the case is closed',
  });
export type MoveProposalStageRequest = z.infer<typeof MoveProposalStageRequestSchema>;

// The existing policy of a renewal, from the policy administration software (public API).

const POLICY_SECTION_CODES = ['FIRE', ...OTHER_SECTIONS] as const;

/** Last year's policy as copied onto a renewal: the "Existing" column. Whole rupees as strings. */
export const ExistingPolicySchema = z.object({
  /** Where it came from, for example the software's name. */
  source: z.string(),
  fetchedAt: IsoDateTimeSchema,
  insurer: z.string(),
  policyNumber: z.string(),
  product: z.string().nullable(),
  periodStart: z.iso.date().nullable(),
  periodEnd: z.iso.date().nullable(),
  /** Sum insured and premium per section; FIRE is the Fire & Allied Perils total. */
  sections: z.array(
    z.object({
      code: z.enum(POLICY_SECTION_CODES),
      sumInsured: z.string(),
      premium: z.string().nullable(),
    }),
  ),
  /** The Fire sum insured by RFQ line, when the source gives it. */
  fireLines: z.array(z.object({ group: z.enum(FIRE_GROUPS), sumInsured: z.string() })),
  totalSumInsured: z.string(),
  netPremium: z.string().nullable(),
  gst: z.string().nullable(),
  totalPremium: z.string().nullable(),
});
export type ExistingPolicy = z.infer<typeof ExistingPolicySchema>;

export const EXISTING_POLICY_STATUSES = [
  'FOUND',
  'NOT_FOUND',
  'UNAVAILABLE',
  'NOT_CONFIGURED',
] as const;
/** What the last lookup of the existing policy found. */
export const ExistingPolicyLookupSchema = z.object({
  status: z.enum(EXISTING_POLICY_STATUSES),
  policy: ExistingPolicySchema.nullable(),
  /** Why nothing was found, for the screen. */
  message: z.string().nullable(),
  checkedAt: IsoDateTimeSchema,
});
export type ExistingPolicyLookup = z.infer<typeof ExistingPolicyLookupSchema>;
export const LastPolicyQuerySchema = z.strictObject({ clientId: ObjectIdSchema });

/** Staff a case can be assigned to: active users who may edit proposals. */
export const ProposalOwnersResponseSchema = z.object({
  items: z.array(z.object({ id: ObjectIdSchema, name: z.string(), email: z.string() })),
});
export type ProposalOwnersResponse = z.infer<typeof ProposalOwnersResponseSchema>;

export const SetProposalInsurersRequestSchema = z.strictObject({
  insurerIds: z
    .array(ObjectIdSchema)
    .max(MAX_PROPOSAL_INSURERS, `Choose at most ${MAX_PROPOSAL_INSURERS} insurers`)
    .refine((ids) => new Set(ids).size === ids.length, 'Each insurer can be chosen once'),
});
export type SetProposalInsurersRequest = z.infer<typeof SetProposalInsurersRequestSchema>;

export const MarkRfqSentRequestSchema = z.strictObject({
  insurerIds: z
    .array(ObjectIdSchema)
    .min(1, 'Choose the insurers the RFQ was sent to')
    .max(MAX_PROPOSAL_INSURERS),
});
export type MarkRfqSentRequest = z.infer<typeof MarkRfqSentRequestSchema>;

// Responses

const FireItemSchema = z.object({
  key: z.enum(FIRE_ITEM_KEYS),
  sqFt: z.string().nullable(),
  ratePerSqFt: z.string().nullable(),
  /** As typed. */
  amount: z.string().nullable(),
  /** The amount used: typed, or area × rate (exact) for a measured item. */
  sumInsured: z.string(),
});

export const ProposalLocationSchema = z.object({
  locationId: ObjectIdSchema,
  /** The risk location as it is now in the client master. Null if it no longer exists. */
  location: z
    .object({
      name: z.string(),
      address: AddressSchema,
      district: z.string(),
      eqZone: EqZoneSchema.nullable(),
      /** The location's own occupancy, or the client's. */
      occupancy: OccupancyRefSchema,
    })
    .nullable(),
  fire: z.array(FireItemSchema),
  fireTotal: z.string(),
  hypothecation: z.string().nullable(),
  openStock: z.string().nullable(),
  risk: z.record(z.string(), z.string().nullable()),
});
export type ProposalLocation = z.infer<typeof ProposalLocationSchema>;

export const ProposalInsurerSchema = z.object({
  insurerId: ObjectIdSchema,
  company: z.string(),
  branch: z.string(),
  rfqEmails: z.array(z.string()),
  active: z.boolean(),
  status: z.enum(['NOT_SENT', 'SENT']),
  sentAt: IsoDateTimeSchema.nullable(),
  sentBy: z.string().nullable(),
});
export type ProposalInsurer = z.infer<typeof ProposalInsurerSchema>;

/** A section's add-on cover: asked for, not asked for, or not yet answered (null). */
const CoverSchema = z.object({ name: z.string(), required: z.boolean().nullable() });
export type Cover = z.infer<typeof CoverSchema>;

export const PRODUCT_SOURCES = ['SUGGESTED', 'CHOSEN', 'OVERRIDE'] as const;
export type ProductSource = (typeof PRODUCT_SOURCES)[number];

export const ProposalRecordSchema = z.object({
  id: ObjectIdSchema,
  reference: z.string(),
  type: ProposalTypeSchema,
  stage: ProposalStageSchema,
  /** The stage the team can move the case to next; null while the stage follows the work. */
  nextStage: ProposalStageSchema.nullable(),
  /** Why the case was closed. */
  closedReason: z.string().nullable(),
  client: z.object({
    id: ObjectIdSchema,
    name: z.string(),
    gstin: z.string().nullable(),
    city: z.string(),
    state: z.string(),
  }),
  owner: z.object({ id: ObjectIdSchema, name: z.string() }),
  dueDate: z.iso.date(),
  policyStart: z.iso.date().nullable(),
  /** Null with a null start: 1 year from the date of payment. */
  policyEnd: z.iso.date().nullable(),
  /** Renewals: last year's policy (the Existing column), and what its lookup found. */
  existingPolicy: ExistingPolicySchema.nullable(),
  existingPolicyLookup: ExistingPolicyLookupSchema.omit({ policy: true }).nullable(),
  /**
   * Renewals: the Existing column's policy (C-2). Its figures are on the Fire lines and sections:
   * typed on the Data Sheet, else the policy software's copy. Null when there is neither.
   */
  existing: z
    .object({
      insurer: z.string(),
      policyNumber: z.string().nullable(),
      source: z.enum(['POLICY_SOFTWARE', 'DATA_SHEET']),
    })
    .nullable(),
  locations: z.array(ProposalLocationSchema),
  fire: z.object({
    groups: z.array(
      z.object({
        group: z.enum(FIRE_GROUPS),
        /** Renewals: last year's sum insured for the line. */
        existing: z.string().nullable(),
        proposed1: z.string(),
        proposed2: z.string().nullable(),
      }),
    ),
    existing: z.string().nullable(),
    proposed1: z.string(),
    /** Null when no Fire line has a second option. */
    proposed2: z.string().nullable(),
    /** Fire's add-on covers (C-6), from the coverage section master. */
    covers: z.array(CoverSchema),
  }),
  /**
   * The product (C-1): the one chosen, else the first the Fire sum insured suggests. OVERRIDE is a
   * product the suggestion does not hold (it carries the reason). Null until there is either.
   */
  product: z
    .object({
      code: z.string(),
      name: z.string(),
      source: z.enum(PRODUCT_SOURCES),
      reason: z.string().nullable(),
    })
    .nullable(),
  /** The add-on lists the product offers, and the add-ons chosen from them (C-4). */
  addonLists: z.array(z.enum(ADDON_LISTS)),
  addons: z.array(z.object({ list: z.enum(ADDON_LISTS), name: z.string() })),
  /**
   * The other sections in the coverage section master's order and wording. A section switched off
   * in the master is left out unless this proposal already includes it.
   */
  sections: z.array(
    z.object({
      code: z.enum(OTHER_SECTIONS),
      name: z.string(),
      included: z.boolean(),
      /** Renewals: last year's sum insured. */
      existing: z.string().nullable(),
      /**
       * For an annexure section with rows, their total; for FLOP, the annual gross profit; for
       * Burglary with a basis, the Fire contents (Option 2: the contents lines given a second figure).
       */
      proposed1: z.string().nullable(),
      proposed2: z.string().nullable(),
      /** The section's lines by key (every line of the section, null when blank). */
      lines: z.record(z.string(), z.string().nullable()),
      /** The lines' Option 2 and last year's figures (C-2). */
      lines2: z.record(z.string(), z.string().nullable()),
      existingLines: z.record(z.string(), z.string().nullable()),
      /** Burglary and Burglary Floater (C-3): the basis and the sum insured on it per option. */
      basis: z.enum(BURGLARY_BASES).nullable(),
      basisAmounts: z
        .object({ proposed1: z.string().nullable(), proposed2: z.string().nullable() })
        .nullable(),
      /** The section's add-on covers (C-6), from the coverage section master. */
      covers: z.array(CoverSchema),
      annexure: z.array(
        z.object({
          description: z.string(),
          quantity: z.string().nullable(),
          dimensions: z.string().nullable(),
          makeModel: z.string().nullable(),
          serialNo: z.string().nullable(),
          year: z.string().nullable(),
          sumInsured: z.string(),
        }),
      ),
    }),
  ),
  /** Products whose range in the product master holds the Fire Option 1 sum insured. */
  suggestedProducts: z.array(z.object({ code: z.string(), name: z.string(), range: z.string() })),
  /**
   * GST % from the tax master when the proposal was created; it does not change when the rate
   * does. Null for proposals created before the tax master existed.
   */
  gstRatePercent: z.string().nullable(),
  claims: z.array(
    z.object({
      period: z.string(),
      policyType: z.string().nullable(),
      sumInsured: z.string().nullable(),
      premium: z.string().nullable(),
      claimedAmount: z.string().nullable(),
      remarks: z.string().nullable(),
      insurer: z.string().nullable(),
    }),
  ),
  notes: z.string().nullable(),
  /** What the Data Sheet still needs before the RFQ; empty when complete. */
  missing: z.array(z.string()),
  /** The Data Sheet can no longer change: the RFQ has gone to at least one insurer. */
  locked: z.boolean(),
  insurers: z.array(ProposalInsurerSchema),
  activity: z.array(z.object({ at: IsoDateTimeSchema, actor: z.string(), message: z.string() })),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type ProposalRecord = z.infer<typeof ProposalRecordSchema>;

export const ProposalListQuerySchema = z.strictObject({
  type: ProposalTypeSchema.optional(),
  stage: ProposalStageSchema.optional(),
  clientId: ObjectIdSchema.optional(),
  limit: LimitSchema,
  cursor: CursorSchema.optional(),
});
export type ProposalListQuery = z.infer<typeof ProposalListQuerySchema>;

export const ProposalListResponseSchema = paginatedSchema(ProposalRecordSchema);
export type ProposalListResponse = z.infer<typeof ProposalListResponseSchema>;

export const ProposalIdParamsSchema = z.strictObject({ id: ObjectIdSchema });
