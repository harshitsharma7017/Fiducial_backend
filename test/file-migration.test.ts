import mongoose, { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { MemoryCloudStore } from '../src/modules/cloud-storage/cloud-store.ts';
import { readFile, useFileStore } from '../src/modules/files/file-store.ts';
import { migrateFiles } from '../src/modules/files/migrate-files.ts';
import { QuoteAttachmentModel } from '../src/modules/quotes/quote.model.ts';
import { RfqVersionModel } from '../src/modules/rfq/rfq.model.ts';
import { useTestDatabase } from './helpers/app.ts';

// Files saved before files moved to S3 are moved by `npm run files:to-s3`: put in the store, then
// the record keeps the key and loses the bytes; a second run finds nothing to move.

useTestDatabase();

describe('moving files from the database to the file store', () => {
  it('counts without changing anything, then moves, and finds nothing the second time', async () => {
    const store = new MemoryCloudStore();
    useFileStore(store, true);
    const quote = Buffer.from('%PDF-1.4 legacy quote');
    const xlsx = Buffer.from('PK legacy rfq');
    const pdf = Buffer.from('%PDF-1.4 legacy rfq');
    const quoteId = new Types.ObjectId();
    const versionId = new Types.ObjectId();
    // Records as the app stored them before: the bytes in the database.
    await mongoose.connection.collection('quote_attachments').insertOne({
      _id: quoteId,
      proposalId: new Types.ObjectId(),
      insurerId: new Types.ObjectId(),
      fileName: 'quote.pdf',
      contentType: 'application/pdf',
      size: quote.length,
      sha256: 'x',
      data: quote,
      uploadedBy: new Types.ObjectId(),
      createdAt: new Date(),
    });
    await mongoose.connection.collection('rfq_versions').insertOne({
      _id: versionId,
      proposalId: new Types.ObjectId(),
      version: 1,
      fileName: 'RFQ-PRP-2026-0001-v1',
      xlsx,
      pdf,
    });

    const lines: string[] = [];
    const counted = await migrateFiles(false, (line) => lines.push(line));
    expect(counted.files).toBe(0);
    expect(store.objects.size).toBe(0);
    expect(lines.some((line) => /Quote attachments\s+1 in the database/.test(line))).toBe(true);

    const moved = await migrateFiles(true, () => undefined);
    expect(moved).toEqual({ files: 3, bytes: quote.length + xlsx.length + pdf.length, failed: 0 });

    const attachment = await QuoteAttachmentModel.findById(quoteId).lean();
    expect(attachment?.data).toBeUndefined();
    expect(await readFile(attachment!)).toEqual(quote);
    const version = await RfqVersionModel.findById(versionId).lean();
    expect([version?.xlsx, version?.pdf]).toEqual([undefined, undefined]);
    expect(await readFile({ storageKey: version!.pdfKey })).toEqual(pdf);
    expect(store.objects.get(version!.xlsxKey!)?.key).toMatch(
      /\/rfq\/.*RFQ-PRP-2026-0001-v1\.xlsx$/,
    );

    expect(await migrateFiles(true, () => undefined)).toEqual({ files: 0, bytes: 0, failed: 0 });
  });
});
