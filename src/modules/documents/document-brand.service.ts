import {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  DEFAULT_DOCUMENT_BRAND,
  type DocumentBrand,
  type DocumentBrandInput,
} from '../../shared/index.ts';
import { Schema, Types, model } from 'mongoose';
import { withTransaction } from '../../lib/db.ts';
import { writeAudit } from '../audit/audit.service.ts';
import type { Actor } from '../clients/clients.service.ts';
import { UserModel } from '../users/user.model.ts';

// The header and footer of every generated PDF, as an Admin sets them in Settings (one record).
// Until it is saved, the documents print Fiducial's letterhead (DEFAULT_DOCUMENT_BRAND).

interface DocumentBrandDoc extends DocumentBrandInput {
  _id: string;
  updatedAt: Date;
  updatedBy: Types.ObjectId | null;
}

const brandSchema = new Schema<DocumentBrandDoc>(
  {
    _id: { type: String, required: true },
    companyName: { type: String, required: true },
    addressLines: { type: [String], default: [] },
    telephone: { type: String, default: '' },
    email: { type: String, default: '' },
    website: { type: String, default: '' },
    footerNote: { type: String, default: '' },
    updatedAt: { type: Date, required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { collection: 'document_brand', versionKey: false, strict: 'throw' },
);

const DocumentBrandModel = model<DocumentBrandDoc>('DocumentBrand', brandSchema);

const ID = 'default';

const fieldsOf = (doc: DocumentBrandInput): DocumentBrandInput => ({
  companyName: doc.companyName,
  addressLines: [...doc.addressLines],
  telephone: doc.telephone,
  email: doc.email,
  website: doc.website,
  footerNote: doc.footerNote,
});

/** The header and footer the documents print, with who last changed them. */
export async function documentBrand(): Promise<DocumentBrand> {
  const doc = await DocumentBrandModel.findById(ID).lean();
  if (!doc) return { ...DEFAULT_DOCUMENT_BRAND, isDefault: true, updatedAt: null, updatedBy: null };
  const user = doc.updatedBy ? await UserModel.findById(doc.updatedBy, { name: 1 }).lean() : null;
  return {
    ...fieldsOf(doc),
    isDefault: false,
    updatedAt: doc.updatedAt.toISOString(),
    updatedBy: user?.name ?? null,
  };
}

/** Only the printed fields, for drawing a document. */
export async function documentBrandFields(): Promise<DocumentBrandInput> {
  const doc = await DocumentBrandModel.findById(ID).lean();
  return doc ? fieldsOf(doc) : DEFAULT_DOCUMENT_BRAND;
}

/** Saves the header and footer; the save and its audit entry commit together. */
export async function updateDocumentBrand(
  input: DocumentBrandInput,
  actor: Actor,
): Promise<DocumentBrand> {
  const before = await documentBrandFields();
  await withTransaction(async (session) => {
    await DocumentBrandModel.updateOne(
      { _id: ID },
      {
        $set: {
          ...fieldsOf(input),
          updatedAt: new Date(),
          updatedBy: new Types.ObjectId(actor.id),
        },
      },
      { upsert: true, session },
    );
    await writeAudit(
      {
        userId: actor.id,
        action: AUDIT_ACTIONS.DOCUMENT_BRAND_UPDATED,
        entity: AUDIT_ENTITIES.DOCUMENT_TEMPLATE,
        entityId: 'HEADER_FOOTER',
        before,
        after: fieldsOf(input),
        requestId: actor.requestId,
      },
      session,
    );
  });
  return documentBrand();
}
