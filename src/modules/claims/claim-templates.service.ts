import {
  AUDIT_ACTIONS,
  CLAIM_EMAIL_AUDIENCES,
  CLAIM_NOTIFIED_STATUSES,
  ERROR_CODES,
  type ClaimEmailAudience,
  type ClaimEmailTemplate,
  type ClaimStatus,
  type UpdateClaimEmailTemplateRequest,
} from '../../shared/index.ts';
import { Types, mongo } from 'mongoose';
import { withTransaction } from '../../lib/db.ts';
import { conflict, notFound } from '../../lib/errors.ts';
import { auditClaim, userNames, type ClaimActor } from './claim-common.ts';
import { ClaimEmailTemplateModel, type ClaimEmailTemplateDoc } from './claim-settings.model.ts';

// The claim emails (C3): one template per status a claim can be moved into, for the claimant and
// for the company's HR. Installed with neutral wording; Admins edit them.

const DEFAULT_SUBJECT = 'Claim {{claimNumber}}: {{status}}';
const DEFAULT_BODIES: Record<ClaimEmailAudience, string> = {
  CLAIMANT: [
    'Dear {{recipientName}},',
    '',
    'Your group health claim {{claimNumber}} for {{patientName}} at {{hospital}} ({{amount}}) has moved from {{previousStatus}} to {{status}} on {{date}}.',
    '',
    'Remark: {{remark}}',
    '',
    'Regards,',
    'Claims team',
  ].join('\n'),
  HR: [
    'Dear {{recipientName}},',
    '',
    'The group health claim {{claimNumber}} of your employee {{employeeName}} (patient: {{patientName}}, {{hospital}}, {{amount}}) has moved from {{previousStatus}} to {{status}} on {{date}}.',
    '',
    'Remark: {{remark}}',
    '',
    'Regards,',
    'Claims team',
  ].join('\n'),
};

export function defaultClaimTemplate(audience: ClaimEmailAudience) {
  return { subject: DEFAULT_SUBJECT, body: DEFAULT_BODIES[audience] };
}

function isDuplicateKey(error: unknown): boolean {
  return error instanceof mongo.MongoServerError && error.code === 11000;
}

async function ensureOne(status: ClaimStatus, audience: ClaimEmailAudience): Promise<void> {
  if (await ClaimEmailTemplateModel.exists({ status, audience })) return;
  try {
    await ClaimEmailTemplateModel.create({
      status,
      audience,
      ...defaultClaimTemplate(audience),
      version: 1,
      isDefault: true,
      updatedBy: null,
    });
  } catch (error) {
    // Another request created it first.
    if (!isDuplicateKey(error)) throw error;
  }
}

/** Installs the default templates that are missing. Safe to run at every start. */
export async function ensureClaimEmailTemplates(): Promise<void> {
  for (const status of CLAIM_NOTIFIED_STATUSES) {
    for (const audience of CLAIM_EMAIL_AUDIENCES) await ensureOne(status, audience);
  }
}

export async function claimTemplate(
  status: ClaimStatus,
  audience: ClaimEmailAudience,
): Promise<ClaimEmailTemplateDoc> {
  await ensureOne(status, audience);
  const doc = await ClaimEmailTemplateModel.findOne({ status, audience }).lean();
  if (!doc) throw new Error(`Claim email template ${status}/${audience} is missing`);
  return doc;
}

function toTemplate(
  doc: ClaimEmailTemplateDoc,
  names: ReadonlyMap<string, string>,
): ClaimEmailTemplate {
  return {
    status: doc.status,
    audience: doc.audience,
    subject: doc.subject,
    body: doc.body,
    version: doc.version,
    isDefault: doc.isDefault,
    updatedBy: doc.updatedBy ? (names.get(doc.updatedBy.toHexString()) ?? 'Unknown user') : null,
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export async function listClaimTemplates(): Promise<{ items: ClaimEmailTemplate[] }> {
  await ensureClaimEmailTemplates();
  const docs = await ClaimEmailTemplateModel.find({
    status: { $in: CLAIM_NOTIFIED_STATUSES },
  }).lean();
  const names = await userNames(docs.map((doc) => doc.updatedBy));
  const order = (doc: ClaimEmailTemplateDoc) =>
    CLAIM_NOTIFIED_STATUSES.indexOf(doc.status) * 10 + CLAIM_EMAIL_AUDIENCES.indexOf(doc.audience);
  return { items: docs.sort((a, b) => order(a) - order(b)).map((doc) => toTemplate(doc, names)) };
}

/** Saves a template if nobody saved a newer version since the editor loaded it. Audited. */
export async function updateClaimTemplate(
  status: ClaimStatus,
  audience: ClaimEmailAudience,
  input: UpdateClaimEmailTemplateRequest,
  actor: ClaimActor,
): Promise<ClaimEmailTemplate> {
  if (!CLAIM_NOTIFIED_STATUSES.includes(status)) throw notFound('No email is sent for this status');
  const current = await claimTemplate(status, audience);
  const saved = await withTransaction(async (session) => {
    const updated = await ClaimEmailTemplateModel.findOneAndUpdate(
      { status, audience, version: input.expectedVersion },
      {
        $set: {
          subject: input.subject,
          body: input.body,
          isDefault: false,
          updatedBy: new Types.ObjectId(actor.id ?? undefined),
        },
        $inc: { version: 1 },
      },
      { returnDocument: 'after', session },
    ).lean();
    if (!updated) {
      throw conflict(
        ERROR_CODES.TEMPLATE_VERSION_CONFLICT,
        'Someone saved this template while you were editing it. Reload it to see their changes.',
        { currentVersion: current.version },
      );
    }
    await auditClaim(
      actor,
      AUDIT_ACTIONS.CLAIM_EMAIL_TEMPLATE_UPDATED,
      `${status}/${audience}`,
      { subject: current.subject, body: current.body, version: current.version },
      { subject: updated.subject, body: updated.body, version: updated.version },
      session,
    );
    return updated;
  });
  return toTemplate(saved, await userNames([saved.updatedBy]));
}
