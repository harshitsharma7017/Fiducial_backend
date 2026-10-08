import { z } from 'zod';
import { IsoDateTimeSchema } from './common.ts';

// Document templates (R-3, R-4): the client's own Excel formats, uploaded by an Admin and filled
// by the document engine for the RFQ, the QCR and the Placement Slip. The PDF is drawn
// from the filled workbook, with the broker's letterhead (logo and address) from the template.

export const DOCUMENT_KINDS = ['RFQ', 'QCR', 'PLACEMENT_SLIP'] as const;
export const DocumentKindSchema = z.enum(DOCUMENT_KINDS);
export type DocumentKind = z.infer<typeof DocumentKindSchema>;
export const DOCUMENT_KIND_LABELS: Record<DocumentKind, string> = {
  RFQ: 'RFQ',
  QCR: 'QCR',
  PLACEMENT_SLIP: 'Placement Slip',
};
/** Which document kinds the engine fills today; the others are stored for when they are built. */
export const FILLED_DOCUMENT_KINDS: readonly DocumentKind[] = ['RFQ', 'QCR', 'PLACEMENT_SLIP'];

/** Largest template accepted, in bytes. */
export const MAX_TEMPLATE_BYTES = 5 * 1024 * 1024;

/** What the engine found in a template: the sheets and labels it fills by. */
export const TemplateCheckSchema = z.object({
  ok: z.boolean(),
  /** What is missing, in words; empty when ok. */
  problems: z.array(z.string()),
  sheets: z.array(z.string()),
  /** The letterhead found: a logo image and the broker's address text. */
  letterhead: z.object({ logo: z.boolean(), address: z.string().nullable() }),
});
export type TemplateCheck = z.infer<typeof TemplateCheckSchema>;

export const DocumentTemplateSchema = z.object({
  kind: DocumentKindSchema,
  fileName: z.string(),
  size: z.number().int(),
  sha256: z.string(),
  uploadedAt: IsoDateTimeSchema,
  uploadedBy: z.string(),
  check: TemplateCheckSchema,
});
export type DocumentTemplate = z.infer<typeof DocumentTemplateSchema>;

/** Every kind, with its template when one has been uploaded. */
export const DocumentTemplateListSchema = z.object({
  items: z.array(
    z.object({
      kind: DocumentKindSchema,
      label: z.string(),
      filled: z.boolean(),
      template: DocumentTemplateSchema.nullable(),
    }),
  ),
});
export type DocumentTemplateList = z.infer<typeof DocumentTemplateListSchema>;

export const DocumentKindParamsSchema = z.strictObject({ kind: DocumentKindSchema });
export const TemplateUploadQuerySchema = z.strictObject({
  fileName: z.string().trim().min(1).max(200).default('template.xlsx'),
});

/** The result of an upload: saved, or the problems that stopped it. */
export const TemplateUploadResultSchema = z.object({
  saved: z.boolean(),
  check: TemplateCheckSchema,
  template: DocumentTemplateSchema.nullable(),
});
export type TemplateUploadResult = z.infer<typeof TemplateUploadResultSchema>;

export const DOCUMENT_FORMATS = ['xlsx', 'pdf'] as const;
export const DocumentFormatQuerySchema = z.strictObject({
  format: z.enum(DOCUMENT_FORMATS).default('xlsx'),
});
export const PDF_CONTENT_TYPE = 'application/pdf';
