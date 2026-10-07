import {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  EMAIL_TEMPLATE_KINDS,
  ERROR_CODES,
  type EmailTemplate,
  type EmailTemplateKind,
  type EmailTemplateListResponse,
  type UpdateEmailTemplateRequest,
} from '../../shared/index.ts';
import { Types, mongo } from 'mongoose';
import { withTransaction } from '../../lib/db.ts';
import { conflict } from '../../lib/errors.ts';
import { writeAudit } from '../audit/audit.service.ts';
import type { Actor } from '../clients/clients.service.ts';
import { UserModel } from '../users/user.model.ts';
import { DEFAULT_EMAIL_TEMPLATES } from './default-templates.ts';
import { EmailTemplateModel, type EmailTemplateDoc } from './email-template.model.ts';

type TemplateFields = Pick<
  EmailTemplateDoc,
  'kind' | 'subject' | 'body' | 'version' | 'isDefault' | 'updatedBy' | 'updatedAt'
>;

function toDto(doc: TemplateFields, users: ReadonlyMap<string, string>): EmailTemplate {
  return {
    kind: doc.kind,
    subject: doc.subject,
    body: doc.body,
    version: doc.version,
    isDefault: doc.isDefault,
    updatedBy: doc.updatedBy ? (users.get(doc.updatedBy.toHexString()) ?? 'Unknown user') : null,
    updatedAt: doc.updatedAt.toISOString(),
  };
}

async function userNames(ids: readonly (Types.ObjectId | null)[]): Promise<Map<string, string>> {
  const present = ids.filter((id): id is Types.ObjectId => id !== null);
  if (present.length === 0) return new Map();
  const users = await UserModel.find({ _id: { $in: present } }, { name: 1 }).lean();
  return new Map(users.map((user) => [user._id.toHexString(), user.name]));
}

function isDuplicateKey(error: unknown): boolean {
  return error instanceof mongo.MongoServerError && error.code === 11000;
}

/** Inserts the default wording of a kind when it has no template yet; never touches an edited one. */
async function ensureKind(kind: EmailTemplateKind): Promise<void> {
  if (await EmailTemplateModel.exists({ kind })) return;
  try {
    await EmailTemplateModel.create({
      kind,
      ...DEFAULT_EMAIL_TEMPLATES[kind],
      version: 1,
      isDefault: true,
      updatedBy: null,
    });
  } catch (error) {
    // Another process inserted it first: the unique index on kind keeps a single template.
    if (!isDuplicateKey(error)) throw error;
  }
}

/** Seeds every kind's default template. Runs at startup; safe to run on every start. */
export async function ensureEmailTemplates(): Promise<void> {
  for (const kind of EMAIL_TEMPLATE_KINDS) await ensureKind(kind);
}

export async function listEmailTemplates(): Promise<EmailTemplateListResponse> {
  await ensureEmailTemplates();
  const docs = await EmailTemplateModel.find({}).lean();
  const users = await userNames(docs.map((doc) => doc.updatedBy));
  const byKind = new Map(docs.map((doc) => [doc.kind, doc]));
  return {
    items: EMAIL_TEMPLATE_KINDS.flatMap((kind) => {
      const doc = byKind.get(kind);
      return doc ? [toDto(doc, users)] : [];
    }),
  };
}

/** The template mails of a kind are built from (seeded with the default when missing). */
export async function getEmailTemplate(kind: EmailTemplateKind): Promise<EmailTemplateDoc> {
  await ensureKind(kind);
  const doc = await EmailTemplateModel.findOne({ kind }).lean();
  if (!doc) throw new Error(`Email template ${kind} is missing`);
  return doc;
}

function versionConflict(currentVersion: number | null) {
  return conflict(
    ERROR_CODES.TEMPLATE_VERSION_CONFLICT,
    'Someone saved this template while you were editing it. Reload it to see their changes.',
    { currentVersion },
  );
}

/**
 * Saves a template when nobody has saved a newer version since the editor loaded it
 * (expectedVersion). The save and its audit entry commit together.
 */
export async function updateEmailTemplate(
  kind: EmailTemplateKind,
  input: UpdateEmailTemplateRequest,
  actor: Actor,
): Promise<EmailTemplate> {
  await ensureKind(kind);
  const saved = await withTransaction(async (session) => {
    const before = await EmailTemplateModel.findOne({ kind }).session(session).lean();
    if (!before || before.version !== input.expectedVersion) {
      throw versionConflict(before?.version ?? null);
    }
    const doc = await EmailTemplateModel.findOneAndUpdate(
      { kind, version: input.expectedVersion },
      {
        $set: {
          subject: input.subject,
          body: input.body,
          isDefault: false,
          updatedBy: new Types.ObjectId(actor.id),
        },
        $inc: { version: 1 },
      },
      { returnDocument: 'after', session },
    ).lean();
    if (!doc) throw versionConflict(null);
    await writeAudit(
      {
        userId: actor.id,
        action: AUDIT_ACTIONS.EMAIL_TEMPLATE_UPDATED,
        entity: AUDIT_ENTITIES.EMAIL_TEMPLATE,
        entityId: kind,
        before: { subject: before.subject, body: before.body, version: before.version },
        after: { subject: doc.subject, body: doc.body, version: doc.version },
        requestId: actor.requestId,
      },
      session,
    );
    return doc;
  });
  return toDto(saved, await userNames([saved.updatedBy]));
}
