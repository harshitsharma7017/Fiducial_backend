import { z } from 'zod';
import { IsoDateTimeSchema, ObjectIdSchema } from './common.ts';
import { MailAttachmentFormatSchema } from './mail.ts';

// Saved copies of a case's documents. Every file of the app is kept in the file store (S3); the
// QCR and placement slip are otherwise generated on each download, so "Save to cloud" keeps a
// copy of one, as it was, with who saved it.

/** The documents a user can save to cloud storage, generated as they download. */
export const CLOUD_DOCUMENT_KINDS = ['RFQ', 'QCR', 'PLACEMENT_SLIP'] as const;
export const CloudDocumentKindSchema = z.enum(CLOUD_DOCUMENT_KINDS);
export type CloudDocumentKind = z.infer<typeof CloudDocumentKindSchema>;
export const CLOUD_DOCUMENT_LABELS: Record<CloudDocumentKind, string> = {
  RFQ: 'RFQ',
  QCR: 'QCR',
  PLACEMENT_SLIP: 'Placement slip',
};

export const SaveCloudDocumentRequestSchema = z.strictObject({
  document: CloudDocumentKindSchema,
  format: MailAttachmentFormatSchema,
});
export type SaveCloudDocumentRequest = z.infer<typeof SaveCloudDocumentRequestSchema>;

export const CloudDocumentSchema = z.object({
  id: ObjectIdSchema,
  document: CloudDocumentKindSchema,
  format: MailAttachmentFormatSchema,
  fileName: z.string(),
  /** Bytes. */
  size: z.number().int().min(0),
  /** What was saved: "v2" for an RFQ version, the QCR's or slip's status. */
  detail: z.string().nullable(),
  savedAt: IsoDateTimeSchema,
  savedBy: z.string(),
});
export type CloudDocument = z.infer<typeof CloudDocumentSchema>;

export const CloudDocumentListSchema = z.object({
  /** False while the server has no cloud storage configured: nothing can be saved. */
  enabled: z.boolean(),
  /** Newest first. */
  items: z.array(CloudDocumentSchema),
});
export type CloudDocumentList = z.infer<typeof CloudDocumentListSchema>;

export const CloudDocumentParamsSchema = z.strictObject({
  id: ObjectIdSchema,
  documentId: ObjectIdSchema,
});
