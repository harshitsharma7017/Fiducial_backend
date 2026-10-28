import {
  AUDIT_ACTIONS,
  GHI_FILE_PURPOSE_LABELS,
  QUOTE_ATTACHMENT_TYPES,
  type GhiFile,
  type GhiFilePurpose,
} from '../../shared/index.ts';
import { createHash } from 'node:crypto';
import { Types, type mongo } from 'mongoose';
import { withTransaction } from '../../lib/db.ts';
import { notFound, validationError } from '../../lib/errors.ts';
import { putFile, readFile, removeFile } from '../files/file-store.ts';
import { sniff } from '../quotes/quotes.service.ts';
import {
  assertWritable,
  auditCase,
  loadCase,
  nameOf,
  userNames,
  type Actor,
} from './ghi-common.ts';
import { GMC_SCOPE, type CaseScope } from './products/profile.ts';
import { GhiFileModel, type GhiFileDoc } from './ghi-workflow.model.ts';

// Files kept on a GHI case. Each is read back only through its own case, so a file id from one
// case can never open another case's file.

function toFile(
  doc: Omit<GhiFileDoc, 'data' | 'sha256'>,
  names: ReadonlyMap<string, string>,
): GhiFile {
  return {
    id: doc._id.toHexString(),
    purpose: doc.purpose === 'RFQ' ? 'OTHER' : doc.purpose,
    fileName: doc.fileName,
    contentType: doc.contentType,
    size: doc.size,
    uploadedAt: doc.createdAt.toISOString(),
    uploadedBy: nameOf(names, doc.uploadedBy),
  };
}

export async function uploadFile(
  id: string,
  purpose: GhiFilePurpose,
  fileName: string,
  data: Buffer,
  actor: Actor,
  scope: CaseScope = GMC_SCOPE,
): Promise<GhiFile> {
  const doc = await loadCase(id, undefined, scope);
  assertWritable(doc);
  // The insurer's PDF or mail, a scan or photo: the same kinds as Property quotes and placements.
  const contentType = sniff(data, fileName);
  if (!contentType) {
    throw validationError([
      {
        location: 'body',
        path: 'file',
        message: `Attach a PDF, the mail (.eml or .msg), or a PNG or JPEG (${Object.values(QUOTE_ATTACHMENT_TYPES).join(', ')})`,
      },
    ]);
  }
  // The file goes to the file store (S3); the record keeps its key.
  const storageKey = await putFile('ghi', data, contentType, fileName);
  const saved = await withTransaction(async (session) => {
    const [file] = await GhiFileModel.create(
      [
        {
          caseId: doc._id,
          purpose,
          fileName,
          contentType,
          size: data.length,
          sha256: createHash('sha256').update(data).digest('hex'),
          storageKey,
          uploadedBy: new Types.ObjectId(actor.id),
        },
      ],
      { session },
    );
    if (!file) throw new Error('File was not saved');
    await auditCase(
      actor,
      AUDIT_ACTIONS.GHI_FILE_UPLOADED,
      id,
      null,
      {
        purpose: GHI_FILE_PURPOSE_LABELS[purpose],
        fileName,
        contentType,
        size: data.length,
      },
      session,
      scope,
    );
    return file.toObject();
  }).catch(async (error: unknown) => {
    await removeFile(storageKey);
    throw error;
  });
  return toFile(saved, await userNames([saved.uploadedBy]));
}

export async function listFiles(
  id: string,
  scope: CaseScope = GMC_SCOPE,
): Promise<{ items: GhiFile[] }> {
  const doc = await loadCase(id, undefined, scope);
  const files = await GhiFileModel.find(
    { caseId: doc._id, purpose: { $ne: 'RFQ' } },
    { data: 0, sha256: 0 },
  )
    .sort({ _id: -1 })
    .lean();
  const names = await userNames(files.map((file) => file.uploadedBy));
  return { items: files.map((file) => toFile(file, names)) };
}

/** A kept file of this case, to download. */
export async function caseFile(
  id: string,
  fileId: string,
  scope: CaseScope = GMC_SCOPE,
): Promise<{ fileName: string; contentType: string; data: Buffer }> {
  const doc = await loadCase(id, undefined, scope);
  const file = await GhiFileModel.findOne({
    _id: new Types.ObjectId(fileId),
    caseId: doc._id,
  }).lean();
  if (!file) throw notFound('File not found');
  return {
    fileName: file.fileName,
    contentType: file.contentType,
    data: await readFile(file, file.data),
  };
}

/** Every id is a file of this case kept for this purpose; else a field error on `path`. */
export async function assertCaseFiles(
  caseId: Types.ObjectId,
  ids: readonly string[],
  purpose: GhiFilePurpose,
  path: string,
  session?: mongo.ClientSession,
): Promise<Types.ObjectId[]> {
  const objectIds = ids.map((fileId) => new Types.ObjectId(fileId));
  if (objectIds.length === 0) return [];
  const found = await GhiFileModel.countDocuments({
    _id: { $in: objectIds },
    caseId,
    purpose,
  }).session(session ?? null);
  if (found !== new Set(ids).size) {
    throw validationError([
      {
        location: 'body',
        path,
        message: `Attach files uploaded to this case as “${GHI_FILE_PURPOSE_LABELS[purpose]}”`,
      },
    ]);
  }
  return objectIds;
}

export async function fileNames(ids: readonly Types.ObjectId[]) {
  const files = await GhiFileModel.find({ _id: { $in: ids } }, { fileName: 1 }).lean();
  return new Map(files.map((file) => [file._id.toHexString(), file.fileName]));
}
