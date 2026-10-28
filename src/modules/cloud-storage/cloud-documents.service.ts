import {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  CLOUD_DOCUMENT_LABELS,
  ERROR_CODES,
  type CloudDocument,
  type CloudDocumentList,
  type SaveCloudDocumentRequest,
} from '../../shared/index.ts';
import { createHash, randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { AppError, conflict, notFound } from '../../lib/errors.ts';
import { writeAudit } from '../audit/audit.service.ts';
import { placementSlipFile } from '../placement-slip/placement-slip.service.ts';
import {
  activityEntry,
  actorRolesOf,
  loadDoc,
  type Actor,
} from '../proposals/proposals.service.ts';
import { ProposalModel } from '../proposals/proposal.model.ts';
import { qcrFile } from '../qcr/qcr.service.ts';
import { latestRfqFile } from '../rfq/rfq.service.ts';
import { UserModel } from '../users/user.model.ts';
import { CloudDocumentModel, type CloudDocumentDoc } from './cloud-document.model.ts';
import { CloudStoreError, type CloudStore } from './cloud-store.ts';

// A case's documents saved to cloud storage (client review, 27 Oct 2026). Nothing reaches the
// store but what a user saves here: the document is generated as it downloads (the latest RFQ
// version, the QCR, the placement slip), put in the store, and recorded with who saved it.

export interface CloudDeps {
  store: CloudStore;
  defaultGstRatePercent: string;
}

const failed = (error: unknown) =>
  error instanceof CloudStoreError
    ? new AppError(502, ERROR_CODES.CLOUD_STORAGE_FAILED, error.message)
    : error;

function off(store: CloudStore) {
  if (store.name === 'off') {
    throw conflict(
      ERROR_CODES.CLOUD_STORAGE_OFF,
      'Cloud storage is not set up on this server. Documents stay in the app; ask an Admin to configure the S3 bucket.',
    );
  }
}

async function namesOf(ids: readonly Types.ObjectId[]): Promise<Map<string, string>> {
  const users = await UserModel.find(
    { _id: { $in: [...new Set(ids.map((id) => id.toHexString()))] } },
    { name: 1 },
  ).lean();
  return new Map(users.map((user) => [user._id.toHexString(), user.name]));
}

function toCloudDocument(doc: CloudDocumentDoc, names: Map<string, string>): CloudDocument {
  return {
    id: doc._id.toHexString(),
    document: doc.document,
    format: doc.format,
    fileName: doc.fileName,
    size: doc.size,
    detail: doc.detail,
    savedAt: doc.savedAt.toISOString(),
    savedBy: names.get(doc.savedBy.toHexString()) ?? 'Unknown user',
  };
}

/** The case's documents in cloud storage, newest first, and whether saving is possible. */
export async function listCloudDocuments(
  id: string,
  deps: Pick<CloudDeps, 'store'>,
): Promise<CloudDocumentList> {
  await loadDoc(id);
  const docs = await CloudDocumentModel.find({
    proposalId: new Types.ObjectId(id),
    removed: null,
  })
    .sort({ savedAt: -1 })
    .lean();
  const names = await namesOf(docs.map((doc) => doc.savedBy));
  return {
    enabled: deps.store.name !== 'off',
    items: docs.map((doc) => toCloudDocument(doc, names)),
  };
}

async function generate(id: string, input: SaveCloudDocumentRequest, deps: CloudDeps) {
  if (input.document === 'RFQ') {
    const file = await latestRfqFile(id, input.format, deps.defaultGstRatePercent);
    return { ...file, detail: `v${file.version}` };
  }
  const options = { defaultGstRatePercent: deps.defaultGstRatePercent };
  const file =
    input.document === 'QCR'
      ? await qcrFile(id, input.format, options)
      : await placementSlipFile(id, input.format, options);
  return { ...file, detail: file.status.toLowerCase() };
}

/** Saves a document of the case to cloud storage, on the user's request. Audited as an export. */
export async function saveCloudDocument(
  id: string,
  input: SaveCloudDocumentRequest,
  actor: Actor,
  deps: CloudDeps,
): Promise<CloudDocument> {
  off(deps.store);
  const proposal = await loadDoc(id);
  const file = await generate(id, input, deps);
  const sha256 = createHash('sha256').update(file.data).digest('hex');
  const key = deps.store.keyFor(['proposals', id, randomUUID(), file.fileName]);
  try {
    await deps.store.put({
      key,
      data: file.data,
      contentType: file.contentType,
      metadata: { proposal: proposal.reference, document: input.document, sha256 },
    });
  } catch (error) {
    throw failed(error);
  }
  const at = new Date();
  const created = await CloudDocumentModel.create({
    proposalId: proposal._id,
    document: input.document,
    format: input.format,
    fileName: file.fileName,
    contentType: file.contentType,
    size: file.data.length,
    sha256,
    location: deps.store.location ?? '',
    key,
    detail: file.detail,
    savedBy: new Types.ObjectId(actor.id),
    savedAt: at,
    removed: null,
  });
  await ProposalModel.updateOne(
    { _id: proposal._id },
    {
      $push: {
        activity: activityEntry(
          actor,
          at,
          `${CLOUD_DOCUMENT_LABELS[input.document]} (${input.format.toUpperCase()}) saved to cloud storage`,
        ),
      },
    },
  );
  await writeAudit({
    userId: actor.id,
    actorRoles: actorRolesOf(actor),
    action: AUDIT_ACTIONS.CLOUD_DOCUMENT_SAVED,
    entity: AUDIT_ENTITIES.PROPOSAL,
    entityId: id,
    before: null,
    after: {
      reference: proposal.reference,
      document: input.document,
      format: input.format,
      fileName: file.fileName,
      detail: file.detail,
      size: file.data.length,
      sha256,
      location: deps.store.location,
    },
    requestId: actor.requestId,
  });
  return toCloudDocument(created.toObject(), await namesOf([created.savedBy]));
}

async function savedDoc(id: string, documentId: string) {
  const doc = await CloudDocumentModel.findOne({
    _id: new Types.ObjectId(documentId),
    proposalId: new Types.ObjectId(id),
    removed: null,
  }).lean();
  if (!doc) throw notFound('This document is not in cloud storage');
  return doc;
}

/** A saved document, read back from cloud storage. Audited as an export. */
export async function cloudDocumentFile(
  id: string,
  documentId: string,
  actor: Actor,
  deps: Pick<CloudDeps, 'store'>,
): Promise<{ fileName: string; contentType: string; data: Buffer }> {
  off(deps.store);
  const doc = await savedDoc(id, documentId);
  let data: Buffer;
  try {
    data = await deps.store.get(doc.key);
  } catch (error) {
    throw failed(error);
  }
  await writeAudit({
    userId: actor.id,
    actorRoles: actorRolesOf(actor),
    action: AUDIT_ACTIONS.CLOUD_DOCUMENT_DOWNLOADED,
    entity: AUDIT_ENTITIES.PROPOSAL,
    entityId: id,
    after: { document: doc.document, format: doc.format, fileName: doc.fileName },
    requestId: actor.requestId,
  });
  return { fileName: doc.fileName, contentType: doc.contentType, data };
}

/** Removes a saved document from cloud storage; its record stays, marked removed. Audited. */
export async function removeCloudDocument(
  id: string,
  documentId: string,
  actor: Actor,
  deps: Pick<CloudDeps, 'store'>,
): Promise<void> {
  off(deps.store);
  const doc = await savedDoc(id, documentId);
  try {
    await deps.store.remove(doc.key);
  } catch (error) {
    throw failed(error);
  }
  const at = new Date();
  await CloudDocumentModel.updateOne(
    { _id: doc._id },
    { $set: { removed: { at, by: new Types.ObjectId(actor.id) } } },
  );
  await ProposalModel.updateOne(
    { _id: doc.proposalId },
    {
      $push: {
        activity: activityEntry(
          actor,
          at,
          `${CLOUD_DOCUMENT_LABELS[doc.document]} ${doc.fileName} removed from cloud storage`,
        ),
      },
    },
  );
  await writeAudit({
    userId: actor.id,
    actorRoles: actorRolesOf(actor),
    action: AUDIT_ACTIONS.CLOUD_DOCUMENT_REMOVED,
    entity: AUDIT_ENTITIES.PROPOSAL,
    entityId: id,
    before: { document: doc.document, format: doc.format, fileName: doc.fileName },
    after: null,
    requestId: actor.requestId,
  });
}
