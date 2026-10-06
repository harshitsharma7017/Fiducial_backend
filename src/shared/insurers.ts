import { z } from 'zod';
import { EmailSchema } from './auth.ts';
import { SearchTextSchema } from './clients.ts';
import {
  CursorSchema,
  IsoDateTimeSchema,
  LimitSchema,
  ObjectIdSchema,
  paginatedSchema,
} from './common.ts';
import { ContactSchema, ContactsInputSchema } from './contacts.ts';

/** RFQ email addresses per insurer branch. */
export const MAX_RFQ_EMAILS = 20;

export const RfqEmailsSchema = z
  .array(EmailSchema)
  .min(1, 'Add at least one email address for RFQs')
  .max(MAX_RFQ_EMAILS, `Add at most ${MAX_RFQ_EMAILS} email addresses`)
  .refine((emails) => new Set(emails).size === emails.length, 'Each email address can appear once');

// Insurer master (M-3): one record per insurance company branch Fiducial places with.

export const CreateInsurerRequestSchema = z.strictObject({
  company: z.string().trim().min(1, 'Enter the insurance company').max(200, 'Name is too long'),
  branch: z.string().trim().min(1, 'Enter the branch').max(200, 'Branch is too long'),
  contacts: ContactsInputSchema,
  /** Where RFQs to this branch are sent. */
  rfqEmails: RfqEmailsSchema,
});
export type CreateInsurerRequest = z.infer<typeof CreateInsurerRequestSchema>;
/** What a form holds before parsing: blank optional fields are "". */
export type CreateInsurerFormValues = z.input<typeof CreateInsurerRequestSchema>;

/** Only the fields sent are changed; contacts and RFQ emails are replaced as a whole. */
export const UpdateInsurerRequestSchema = CreateInsurerRequestSchema.extend({
  active: z.boolean(),
})
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'Provide at least one field to change');
export type UpdateInsurerRequest = z.infer<typeof UpdateInsurerRequestSchema>;

export const InsurerSchema = z.object({
  id: ObjectIdSchema,
  company: z.string(),
  branch: z.string(),
  contacts: z.array(ContactSchema),
  rfqEmails: z.array(z.string()),
  /** Inactive insurers stay on record but are not offered for new RFQs. */
  active: z.boolean(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Insurer = z.infer<typeof InsurerSchema>;

/** Insurers by company then branch. q matches words in either; active filters by status. */
export const InsurerListQuerySchema = z.strictObject({
  q: SearchTextSchema.optional(),
  active: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  limit: LimitSchema,
  cursor: CursorSchema.optional(),
});
export type InsurerListQuery = z.infer<typeof InsurerListQuerySchema>;

export const InsurerListResponseSchema = paginatedSchema(InsurerSchema);
export type InsurerListResponse = z.infer<typeof InsurerListResponseSchema>;

export const InsurerIdParamsSchema = z.strictObject({ id: ObjectIdSchema });
