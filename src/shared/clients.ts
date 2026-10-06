import { z } from 'zod';
import {
  CursorSchema,
  IsoDateTimeSchema,
  LimitSchema,
  ObjectIdSchema,
  blankAsNull,
  paginatedSchema,
} from './common.ts';
import {
  AddressInputSchema,
  AddressLineSchema,
  AddressSchema,
  CitySchema,
  ContactSchema,
  ContactsInputSchema,
} from './contacts.ts';
import { GstinSchema } from './gst.ts';
import { EqZoneSchema, PincodeValueSchema, TacCodeSchema } from './masters.ts';

/** An occupancy as it was in the master when chosen: the code and its description. */
export const OccupancyRefSchema = z.object({
  tacCode: z.string(),
  description: z.string(),
});
export type OccupancyRef = z.infer<typeof OccupancyRefSchema>;

export const SearchTextSchema = z.string().trim().max(100, 'Search text is too long');

// Client master (M-1): the insured, as the Data Sheet names it.

export const CreateClientRequestSchema = z.strictObject({
  /** "Name of the Insured" on the Data Sheet. */
  name: z.string().trim().min(1, 'Enter the insured name').max(200, 'Name is too long'),
  /** Null for an insured without GST registration. Unique across clients when present. */
  gstin: blankAsNull(GstinSchema),
  /** "Communication Address" on the Data Sheet. */
  address: AddressInputSchema,
  contacts: ContactsInputSchema,
  natureOfBusiness: z
    .string()
    .trim()
    .min(1, 'Describe the nature of business')
    .max(300, 'Nature of business is too long'),
  /** TAC code in the active occupancy master. */
  occupancyCode: TacCodeSchema,
});
export type CreateClientRequest = z.infer<typeof CreateClientRequestSchema>;
/** What a form holds before parsing: blank optional fields are "". */
export type CreateClientFormValues = z.input<typeof CreateClientRequestSchema>;

/** Only the fields sent are changed; contacts are replaced as a whole. */
export const UpdateClientRequestSchema = CreateClientRequestSchema.partial().refine(
  (body) => Object.keys(body).length > 0,
  'Provide at least one field to change',
);
export type UpdateClientRequest = z.infer<typeof UpdateClientRequestSchema>;

export const ClientSchema = z.object({
  id: ObjectIdSchema,
  name: z.string(),
  gstin: z.string().nullable(),
  address: AddressSchema,
  contacts: z.array(ContactSchema),
  natureOfBusiness: z.string(),
  occupancy: OccupancyRefSchema,
  locationCount: z.number().int(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Client = z.infer<typeof ClientSchema>;

/** Clients in name order. q matches words in the name or the start of the GSTIN. */
export const ClientListQuerySchema = z.strictObject({
  q: SearchTextSchema.optional(),
  limit: LimitSchema,
  cursor: CursorSchema.optional(),
});
export type ClientListQuery = z.infer<typeof ClientListQuerySchema>;

export const ClientListResponseSchema = paginatedSchema(ClientSchema);
export type ClientListResponse = z.infer<typeof ClientListResponseSchema>;

export const ClientIdParamsSchema = z.strictObject({ id: ObjectIdSchema });

// Risk locations (M-2): any number per client.

export const CreateClientLocationRequestSchema = z.strictObject({
  /** How the client refers to the site, for example "Plant 2" or "Bhiwandi godown". */
  name: z
    .string()
    .trim()
    .min(1, 'Name the location, for example Plant 2')
    .max(120, 'Name is too long'),
  line1: AddressLineSchema,
  line2: blankAsNull(z.string().trim().max(200, 'Address line is too long')),
  city: CitySchema,
  /** Must be in the active pincode master, which supplies the state, district and EQ zone. */
  pincode: PincodeValueSchema,
  /** Null when the location has the client's occupancy. */
  occupancyCode: blankAsNull(TacCodeSchema),
});
export type CreateClientLocationRequest = z.infer<typeof CreateClientLocationRequestSchema>;
/** What a form holds before parsing: blank optional fields are "". */
export type CreateClientLocationFormValues = z.input<typeof CreateClientLocationRequestSchema>;

export const UpdateClientLocationRequestSchema = CreateClientLocationRequestSchema.partial().refine(
  (body) => Object.keys(body).length > 0,
  'Provide at least one field to change',
);
export type UpdateClientLocationRequest = z.infer<typeof UpdateClientLocationRequestSchema>;

export const ClientLocationSchema = z.object({
  id: ObjectIdSchema,
  clientId: ObjectIdSchema,
  name: z.string(),
  address: AddressSchema,
  district: z.string(),
  eqZone: EqZoneSchema.nullable(),
  /** Null when the location has the client's occupancy. */
  occupancy: OccupancyRefSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type ClientLocation = z.infer<typeof ClientLocationSchema>;

/** Locations in the order they were added. */
export const ClientLocationListQuerySchema = z.strictObject({
  limit: LimitSchema,
  cursor: CursorSchema.optional(),
});
export type ClientLocationListQuery = z.infer<typeof ClientLocationListQuerySchema>;

export const ClientLocationListResponseSchema = paginatedSchema(ClientLocationSchema);
export type ClientLocationListResponse = z.infer<typeof ClientLocationListResponseSchema>;

export const ClientLocationParamsSchema = z.strictObject({
  id: ObjectIdSchema,
  locationId: ObjectIdSchema,
});
