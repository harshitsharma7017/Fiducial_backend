import type { EbProduct } from '../../shared/index.ts';
import { Types } from 'mongoose';
import { Decimal } from '../../lib/decimal.ts';
import { notFound } from '../../lib/errors.ts';
import { istDay } from '../../lib/ist-day.ts';
import { ClientModel } from '../clients/client.model.ts';
import { EbPolicySnapshotModel } from '../ghi/eb-placement.model.ts';
import { GhiCaseModel, type GhiCaseDoc } from '../ghi/ghi-case.model.ts';
import { insurerNames } from '../ghi/ghi-common.ts';
import { GhiQuoteModel } from '../ghi/ghi-workflow.model.ts';

// A placed policy's facts for reports (N8 to N10): number, period, insurer and premium, read from
// what placing recorded and never changed by a report. GMC: the policy recorded on the case and
// its final agreed quote. GPA and GTLI: the placement snapshot (append-only).

export interface InsuredPolicy {
  caseId: string;
  clientId: string;
  clientName: string;
  product: EbProduct;
  reference: string;
  policyNumber: string | null;
  insurerId: string;
  insurerName: string;
  policyStart: string;
  policyEnd: string;
  /** Premium before GST, rupees with paise; null when not recorded. */
  basePremium: string | null;
  gst: string | null;
  totalPremium: string | null;
}

const money = (value: { toString(): string } | null | undefined) =>
  value === null || value === undefined ? null : new Decimal(value.toString()).toFixed(2);

/** One year less a day after the start (the policy end when none is recorded). */
function yearEnd(start: string): string {
  const date = new Date(`${start}T00:00:00Z`);
  date.setUTCFullYear(date.getUTCFullYear() + 1);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export async function insuredPolicyOf(doc: GhiCaseDoc): Promise<InsuredPolicy | null> {
  const product = doc.product ?? 'GMC';
  const client = await ClientModel.findById(doc.clientId, { name: 1 }).lean();
  const base = {
    caseId: doc._id.toHexString(),
    clientId: doc.clientId.toHexString(),
    clientName: client?.name ?? 'Company',
    product,
    reference: doc.reference,
  };
  if (product === 'GMC') {
    if (!doc.policy) return null;
    const quote = await GhiQuoteModel.findOne({ _id: doc.policy.quoteId, caseId: doc._id }).lean();
    const names = await insurerNames([doc.policy.insurerId]);
    return {
      ...base,
      policyNumber: doc.policy.policyNumber,
      insurerId: doc.policy.insurerId.toHexString(),
      insurerName: names.get(doc.policy.insurerId.toHexString()) ?? 'Insurer',
      policyStart: doc.policy.policyStart,
      policyEnd: doc.policy.policyEnd,
      basePremium: money(quote?.basePremium),
      gst: money(quote?.gst),
      totalPremium: money(quote?.totalPremium),
    };
  }
  if (!doc.placement) return null;
  const snapshot = await EbPolicySnapshotModel.findOne({ caseId: doc._id }).lean();
  if (!snapshot) return null;
  const names = await insurerNames([snapshot.insurerId]);
  const start = snapshot.policyStart ?? doc.policyStart ?? istDay(snapshot.issuedAt);
  return {
    ...base,
    policyNumber: snapshot.policyNumber,
    insurerId: snapshot.insurerId.toHexString(),
    insurerName: names.get(snapshot.insurerId.toHexString()) ?? 'Insurer',
    policyStart: start,
    policyEnd: snapshot.policyEnd ?? doc.policyEnd ?? yearEnd(start),
    basePremium: money(snapshot.basePremium),
    gst: money(snapshot.gst),
    totalPremium: money(snapshot.agreedTotal),
  };
}

/** The placed case and its policy, or 404 (also for a case that is not placed). */
export async function loadInsuredPolicy(
  caseId: string,
): Promise<{ doc: GhiCaseDoc; policy: InsuredPolicy }> {
  const doc = Types.ObjectId.isValid(caseId)
    ? await GhiCaseModel.findById(caseId).lean<GhiCaseDoc>()
    : null;
  const policy = doc ? await insuredPolicyOf(doc) : null;
  if (!doc || !policy) throw notFound('No placed policy found for this case');
  return { doc, policy };
}

/** The placed policies of a company (and product), latest first. */
export async function insuredPolicies(filter: {
  clientId?: string;
  product?: EbProduct;
}): Promise<InsuredPolicy[]> {
  const docs = await GhiCaseModel.find({
    ...(filter.clientId ? { clientId: new Types.ObjectId(filter.clientId) } : {}),
    ...(filter.product === 'GMC'
      ? { product: { $in: [null, 'GMC'] }, policy: { $ne: null } }
      : filter.product
        ? { product: filter.product, placement: { $ne: null } }
        : { $or: [{ policy: { $ne: null } }, { placement: { $ne: null } }] }),
  })
    .sort({ _id: -1 })
    .limit(500)
    .lean<GhiCaseDoc[]>();
  const policies = await Promise.all(docs.map((doc) => insuredPolicyOf(doc)));
  return policies
    .filter((policy): policy is InsuredPolicy => policy !== null)
    .sort((a, b) => b.policyStart.localeCompare(a.policyStart));
}
