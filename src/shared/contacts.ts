import { z } from 'zod';
import { EmailSchema } from './auth.ts';
import { blankAsNull } from './common.ts';
import { PincodeValueSchema } from './masters.ts';

/** Contacts per client or insurer. */
export const MAX_CONTACTS = 20;

export const PhoneSchema = z
  .string()
  .trim()
  .regex(
    /^\+?\d[\d ()-]{5,19}$/,
    'Enter a phone number using digits, spaces, brackets, - or a leading +',
  );

export const ContactInputSchema = z
  .strictObject({
    name: z.string().trim().min(1, 'Enter the contact name').max(120, 'Name is too long'),
    designation: blankAsNull(z.string().trim().max(120, 'Designation is too long')),
    email: blankAsNull(EmailSchema),
    phone: blankAsNull(PhoneSchema),
  })
  .refine((contact) => contact.email !== null || contact.phone !== null, {
    message: 'Enter an email or a phone number',
    path: ['email'],
  });
export type ContactFormValues = z.input<typeof ContactInputSchema>;

export const ContactSchema = z.object({
  name: z.string(),
  designation: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
});
export type Contact = z.infer<typeof ContactSchema>;

export const ContactsInputSchema = z
  .array(ContactInputSchema)
  .max(MAX_CONTACTS, `Add at most ${MAX_CONTACTS} contacts`);

/** States and union territories, for the state of a communication address. */
export const INDIAN_STATES = [
  'Andhra Pradesh',
  'Arunachal Pradesh',
  'Assam',
  'Bihar',
  'Chhattisgarh',
  'Goa',
  'Gujarat',
  'Haryana',
  'Himachal Pradesh',
  'Jharkhand',
  'Karnataka',
  'Kerala',
  'Madhya Pradesh',
  'Maharashtra',
  'Manipur',
  'Meghalaya',
  'Mizoram',
  'Nagaland',
  'Odisha',
  'Punjab',
  'Rajasthan',
  'Sikkim',
  'Tamil Nadu',
  'Telangana',
  'Tripura',
  'Uttar Pradesh',
  'Uttarakhand',
  'West Bengal',
  'Andaman and Nicobar Islands',
  'Chandigarh',
  'Dadra and Nagar Haveli and Daman and Diu',
  'Delhi',
  'Jammu and Kashmir',
  'Ladakh',
  'Lakshadweep',
  'Puducherry',
] as const;
export const IndianStateSchema = z.enum(INDIAN_STATES, {
  error: 'Choose a state or union territory',
});

export const AddressLineSchema = z
  .string()
  .trim()
  .min(1, 'Enter the address')
  .max(200, 'Address line is too long');
export const CitySchema = z.string().trim().min(1, 'Enter the city').max(100, 'City is too long');

export const AddressInputSchema = z.strictObject({
  line1: AddressLineSchema,
  line2: blankAsNull(z.string().trim().max(200, 'Address line is too long')),
  city: CitySchema,
  state: IndianStateSchema,
  pincode: PincodeValueSchema,
});
export type AddressFormValues = z.input<typeof AddressInputSchema>;

export const AddressSchema = z.object({
  line1: z.string(),
  line2: z.string().nullable(),
  city: z.string(),
  state: z.string(),
  pincode: z.string(),
});
export type Address = z.infer<typeof AddressSchema>;
