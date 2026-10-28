import type { Model } from 'mongoose';
import { ChatFileModel } from '../chat/chat.model.ts';
import { ClaimFileModel } from '../claims/claim.model.ts';
import { ClientApprovalFileModel } from '../client-approval/client-approval.model.ts';
import { DocumentTemplateModel } from '../documents/document-template.model.ts';
import { GhiFileModel } from '../ghi/ghi-workflow.model.ts';
import { MailAttachmentModel } from '../mail/mail-attachment.model.ts';
import { PlacementFileModel } from '../placement-slip/placement-slip.model.ts';
import { QuoteAttachmentModel } from '../quotes/quote.model.ts';
import { RfqVersionModel } from '../rfq/rfq.model.ts';
import { bytesOf, putFile, type FileArea } from './file-store.ts';

// Moves the files still held in the database (records saved before files went to S3) into the
// file store: each file is put in the store first, then its record gets the key and loses the
// bytes, so a failure leaves the record as it was and a run can be repeated. Used by
// scripts/migrate-files-to-s3.ts.

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

interface FileField {
  label: string;
  model: Model<never>;
  area: FileArea;
  /** The field with the bytes, and the one that gets the key. */
  data: string;
  key: string;
  fileName: (doc: Record<string, unknown>) => string;
  contentType: (doc: Record<string, unknown>) => string;
}

const text = (value: unknown, fallback: string) => (typeof value === 'string' ? value : fallback);
const own = (doc: Record<string, unknown>) => text(doc.fileName, 'file');
const typeOf = (doc: Record<string, unknown>) => text(doc.contentType, 'application/octet-stream');

const FIELDS: FileField[] = [
  ...(
    [
      ['Quote attachments', QuoteAttachmentModel, 'quotes'],
      ['Policies and cover notes', PlacementFileModel, 'placement'],
      ['Client approval files', ClientApprovalFileModel, 'client-approval'],
      ['Mail attachments', MailAttachmentModel, 'mail'],
      ['Claim documents', ClaimFileModel, 'claims'],
      ['Group health files', GhiFileModel, 'ghi'],
      ['Chat files', ChatFileModel, 'chat'],
    ] as const
  ).map(([label, model, area]) => ({
    label,
    model: model as unknown as Model<never>,
    area,
    data: 'data',
    key: 'storageKey',
    fileName: own,
    contentType: typeOf,
  })),
  {
    label: 'Document templates',
    model: DocumentTemplateModel as unknown as Model<never>,
    area: 'templates',
    data: 'data',
    key: 'storageKey',
    fileName: own,
    contentType: () => XLSX,
  },
  {
    label: 'RFQ versions (Excel)',
    model: RfqVersionModel as unknown as Model<never>,
    area: 'rfq',
    data: 'xlsx',
    key: 'xlsxKey',
    fileName: (doc) => `${own(doc)}.xlsx`,
    contentType: () => XLSX,
  },
  {
    label: 'RFQ versions (PDF)',
    model: RfqVersionModel as unknown as Model<never>,
    area: 'rfq',
    data: 'pdf',
    key: 'pdfKey',
    fileName: (doc) => `${own(doc)}.pdf`,
    contentType: () => 'application/pdf',
  },
];

export interface MigrationResult {
  files: number;
  bytes: number;
  failed: number;
}

/** Counts (apply false) or moves (apply true) the files still in the database. */
export async function migrateFiles(
  apply: boolean,
  log: (line: string) => void,
): Promise<MigrationResult> {
  const result: MigrationResult = { files: 0, bytes: 0, failed: 0 };
  for (const field of FIELDS) {
    // The driver's collection: the records are read and changed as stored, bytes and all.
    const collection = field.model.collection;
    const filter = { [field.data]: { $exists: true } };
    const count = await collection.countDocuments(filter);
    log(`  ${field.label.padEnd(28)} ${count} in the database`);
    if (!apply || count === 0) continue;
    for await (const doc of collection.find(filter)) {
      const record = doc as Record<string, unknown>;
      const data = bytesOf(record[field.data]);
      if (!data) continue;
      try {
        const key = await putFile(
          field.area,
          data,
          field.contentType(record),
          field.fileName(record),
        );
        await collection.updateOne(
          { _id: doc._id },
          { $set: { [field.key]: key }, $unset: { [field.data]: '' } },
        );
        result.files += 1;
        result.bytes += data.length;
      } catch (error) {
        result.failed += 1;
        log(`    ${String(doc._id)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return result;
}
