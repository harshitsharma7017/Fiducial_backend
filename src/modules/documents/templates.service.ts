import {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  DOCUMENT_KINDS,
  DOCUMENT_KIND_LABELS,
  FILLED_DOCUMENT_KINDS,
  type DocumentKind,
  type DocumentTemplate,
  type DocumentTemplateList,
  type TemplateCheck,
  type TemplateUploadResult,
} from '../../shared/index.ts';
import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import { withTransaction } from '../../lib/db.ts';
import type { Logger } from '../../lib/logger.ts';
import { writeAudit } from '../audit/audit.service.ts';
import type { Actor } from '../clients/clients.service.ts';
import { checkQcrTemplate } from '../qcr/qcr-template.ts';
import { checkRfqTemplate } from '../proposals/rfq-template.ts';
import { UserModel } from '../users/user.model.ts';
import { DocumentTemplateModel, type DocumentTemplateDoc } from './document-template.model.ts';
import { openTemplate } from './excel-template.ts';
import { letterheadOf } from './sheet-pdf.ts';

/** What the engine needs from a template of each kind; kinds not filled yet need a workbook. */
async function checkTemplate(
  kind: DocumentKind,
  data: Buffer,
  log?: Logger,
): Promise<TemplateCheck> {
  const unreadable = (problem: string): TemplateCheck => ({
    ok: false,
    problems: [problem],
    sheets: [],
    letterhead: { logo: false, address: null },
  });
  if (data.length < 4 || data.readUInt32LE(0) !== 0x04034b50) {
    return unreadable(
      'This is not an Excel workbook (.xlsx). Save the file as .xlsx and try again.',
    );
  }
  let workbook;
  try {
    workbook = await openTemplate(data);
  } catch (cause) {
    log?.warn({ err: cause }, 'Template could not be read');
    return unreadable(
      'The workbook could not be read. Open it in Excel, save it as .xlsx and try again.',
    );
  }
  if (kind === 'RFQ') return checkRfqTemplate(workbook);
  if (kind === 'QCR') return checkQcrTemplate(workbook);
  const letterhead = letterheadOf(workbook);
  return {
    ok: true,
    problems: [],
    sheets: workbook.worksheets.map((sheet) => sheet.name),
    letterhead: { logo: letterhead.logo !== null, address: letterhead.address },
  };
}

function toDto(doc: Omit<DocumentTemplateDoc, 'data'>, uploadedBy: string): DocumentTemplate {
  return {
    kind: doc.kind,
    fileName: doc.fileName,
    size: doc.size,
    sha256: doc.sha256,
    uploadedAt: doc.updatedAt.toISOString(),
    uploadedBy,
    check: doc.check,
  };
}

export async function listTemplates(): Promise<DocumentTemplateList> {
  const docs = await DocumentTemplateModel.find({}, { data: 0 }).lean();
  const users = new Map(
    (
      await UserModel.find({ _id: { $in: docs.map((doc) => doc.uploadedBy) } }, { name: 1 }).lean()
    ).map((user) => [user._id.toHexString(), user.name]),
  );
  const byKind = new Map(docs.map((doc) => [doc.kind, doc]));
  return {
    items: DOCUMENT_KINDS.map((kind) => {
      const doc = byKind.get(kind);
      return {
        kind,
        label: DOCUMENT_KIND_LABELS[kind],
        filled: FILLED_DOCUMENT_KINDS.includes(kind),
        template: doc
          ? toDto(doc, users.get(doc.uploadedBy.toHexString()) ?? 'Unknown user')
          : null,
      };
    }),
  };
}

/** The template file of a kind, or null when none has been uploaded. */
export async function templateFile(
  kind: DocumentKind,
): Promise<{ data: Buffer; fileName: string } | null> {
  const doc = await DocumentTemplateModel.findOne({ kind }, { data: 1, fileName: 1 }).lean();
  if (!doc) return null;
  // Read without Mongoose documents, a stored file comes back as a BSON Binary.
  const raw: unknown = doc.data;
  const data = Buffer.isBuffer(raw) ? raw : Buffer.from((raw as { buffer: Uint8Array }).buffer);
  return { data, fileName: doc.fileName };
}

/** Checks an uploaded template and, when the engine can fill it, keeps it as the kind's template. */
export async function uploadTemplate(
  kind: DocumentKind,
  data: Buffer,
  fileName: string,
  actor: Actor,
  log?: Logger,
): Promise<TemplateUploadResult> {
  const check = await checkTemplate(kind, data, log);
  if (!check.ok) return { saved: false, check, template: null };
  const sha256 = createHash('sha256').update(data).digest('hex');
  const saved = await withTransaction(async (session) => {
    const before = await DocumentTemplateModel.findOne({ kind }, { data: 0 })
      .session(session)
      .lean();
    const doc = await DocumentTemplateModel.findOneAndUpdate(
      { kind },
      {
        $set: {
          kind,
          fileName,
          data,
          size: data.length,
          sha256,
          check,
          uploadedBy: new Types.ObjectId(actor.id),
        },
      },
      { upsert: true, returnDocument: 'after', session, projection: { data: 0 } },
    ).lean();
    if (!doc) throw new Error('Template was not saved');
    await writeAudit(
      {
        userId: actor.id,
        action: AUDIT_ACTIONS.TEMPLATE_UPLOADED,
        entity: AUDIT_ENTITIES.DOCUMENT_TEMPLATE,
        entityId: kind,
        before: before
          ? { fileName: before.fileName, sha256: before.sha256, size: before.size }
          : null,
        after: { fileName, sha256, size: data.length, sheets: check.sheets.join(', ') },
        requestId: actor.requestId,
      },
      session,
    );
    return doc;
  });
  const user = await UserModel.findById(actor.id, { name: 1 }).lean();
  return { saved: true, check, template: toDto(saved, user?.name ?? 'Unknown user') };
}
