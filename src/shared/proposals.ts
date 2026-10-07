import { z } from 'zod';
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
// not served by this API yet. Amounts are whole rupees as digit strings; areas and rates per
// square foot are decimal strings.

export const PROPOSAL_STAGES = ['DRAFT', 'DATA_SHEET', 'RFQ_SENT'] as const;
export const ProposalStageSchema = z.enum(PROPOSAL_STAGES);
export type ProposalStage = z.infer<typeof ProposalStageSchema>;

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

/** The Data Sheet's Fire items per location. Measured items are priced as area × rate. */
export const FIRE_ITEMS = [
  { key: 'BUILDING_1', group: 'BUILDING', label: 'Building 1', measured: true },
  { key: 'BUILDING_2', group: 'BUILDING', label: 'Building 2', measured: true },
  { key: 'COMPOUND_WALL', group: 'BUILDING', label: 'Compound wall', measured: true },
  { key: 'FALSE_CEILING', group: 'BUILDING', label: 'False ceiling', measured: true },
  { key: 'PLINTH_FOUNDATION', group: 'BUILDING', label: 'Plinth & foundation', measured: true },
  { key: 'INTERIOR', group: 'BUILDING', label: 'Interior', measured: true },
  { key: 'FFF', group: 'FFF', label: 'Furniture, fixtures and fittings', measured: false },
  {
    key: 'OFFICE_EQUIPMENT',
    group: 'OFFICE_EQUIPMENT',
    label: 'Office equipment and communication systems',
    measured: false,
  },
  {
    key: 'ELECTRICAL',
    group: 'ELECTRICAL',
    label: 'Power and electrical installations',
    measured: false,
  },
  { key: 'GENSET', group: 'PLANT_MACHINERY', label: 'Genset and accessories', measured: false },
  {
    key: 'COMPRESSOR',
    group: 'PLANT_MACHINERY',
    label: 'Compressor and accessories',
    measured: false,
  },
  {
    key: 'TRANSFORMER',
    group: 'PLANT_MACHINERY',
    label: 'Transformer and accessories',
    measured: false,
  },
  {
    key: 'OTHER_MACHINERY',
    group: 'PLANT_MACHINERY',
    label: 'All other machinery',
    measured: false,
  },
  { key: 'STOCKS', group: 'STOCKS', label: 'Stocks of the insured business', measured: false },
  {
    key: 'STOCKS_THIRD_PARTY',
    group: 'STOCKS',
    label: 'Stocks at third-party job-work locations',
    measured: false,
  },
  { key: 'OTHER', group: 'OTHER', label: 'Any other items', measured: false },
] as const satisfies readonly { key: string; group: FireGroup; label: string; measured: boolean }[];
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
    locations: z.array(LocationDataInputSchema).max(200),
    /** Proposed Option 2 for each Fire line; blank when there is no second option. */
    fireOption2: z.array(z.strictObject({ group: z.enum(FIRE_GROUPS), amount: OptionalRupees })),
    sections: z.array(
      z.strictObject({
        code: z.enum(OTHER_SECTIONS),
        included: z.boolean(),
        proposed1: OptionalRupees,
        proposed2: OptionalRupees,
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
export type DataSheetFormValues = z.input<typeof DataSheetInputSchema>;

export const CreateProposalRequestSchema = z.strictObject({
  clientId: ObjectIdSchema,
  locationIds: z.array(ObjectIdSchema).max(200),
  dueDate: z.iso.date({ error: 'Enter the date quotes are needed by' }),
});
export type CreateProposalRequest = z.infer<typeof CreateProposalRequestSchema>;

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
  /** The amount used: typed, or area × rate for a measured item. */
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

export const ProposalRecordSchema = z.object({
  id: ObjectIdSchema,
  reference: z.string(),
  type: z.literal('NEW'),
  stage: ProposalStageSchema,
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
  locations: z.array(ProposalLocationSchema),
  fire: z.object({
    groups: z.array(
      z.object({
        group: z.enum(FIRE_GROUPS),
        proposed1: z.string(),
        proposed2: z.string().nullable(),
      }),
    ),
    proposed1: z.string(),
    /** Null when no Fire line has a second option. */
    proposed2: z.string().nullable(),
  }),
  /**
   * The other sections in the coverage section master's order and wording. A section switched off
   * in the master is left out unless this proposal already includes it.
   */
  sections: z.array(
    z.object({
      code: z.enum(OTHER_SECTIONS),
      name: z.string(),
      included: z.boolean(),
      proposed1: z.string().nullable(),
      proposed2: z.string().nullable(),
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
  stage: ProposalStageSchema.optional(),
  clientId: ObjectIdSchema.optional(),
  limit: LimitSchema,
  cursor: CursorSchema.optional(),
});
export type ProposalListQuery = z.infer<typeof ProposalListQuerySchema>;

export const ProposalListResponseSchema = paginatedSchema(ProposalRecordSchema);
export type ProposalListResponse = z.infer<typeof ProposalListResponseSchema>;

export const ProposalIdParamsSchema = z.strictObject({ id: ObjectIdSchema });
