import {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  EB_PRODUCT_NAMES,
  RenewalAnalysisSchema,
  fromPaise,
  formatDate,
  paidAndOutstanding,
  bucketOf,
  renewalChanges,
  renewalQuotes,
  renewalYear,
  toPaise,
  type EbProduct,
  type PolicyYearFigures,
  type RecordedPolicyYear,
  type RecordedPolicyYearInput,
  type RenewalAnalysis,
  type RenewalAnalysisRequest,
} from '../../shared/index.ts';
import { Types } from 'mongoose';
import { withTransaction } from '../../lib/db.ts';
import { Decimal, toDecimal128 } from '../../lib/decimal.ts';
import { notFound, validationError } from '../../lib/errors.ts';
import { istDay } from '../../lib/ist-day.ts';
import { writeAudit } from '../audit/audit.service.ts';
import { ClientModel } from '../clients/client.model.ts';
import { effectiveSumInsured } from '../ghi/census-summary.ts';
import { EbPolicySnapshotMemberModel } from '../ghi/eb-placement.model.ts';
import { GhiCaseModel, type GhiCaseDoc } from '../ghi/ghi-case.model.ts';
import { GhiMemberModel } from '../ghi/ghi-census.model.ts';
import { insurerNames, nameOf, userNames, type Actor } from '../ghi/ghi-common.ts';
import { GhiQuoteModel } from '../ghi/ghi-workflow.model.ts';
import {
  insuredPolicies,
  loadInsuredPolicy,
  type InsuredPolicy,
} from '../insured-policies/insured-policies.service.ts';
import { TpaClaimModel, TpaImportModel } from '../tpa/tpa.model.ts';
import {
  RecordedPolicyYearModel,
  RenewalReportModel,
  type RecordedPolicyYearDoc,
} from './renewal.model.ts';

// The benefit and cost analysis for a renewal (N8). A placed policy's year is read from what
// placing recorded (census, premium) and its imported TPA claims; a year recorded by hand from
// its record. Figures are worked out by the shared renewalYear/renewalChanges, so screen and
// files agree. Nothing here writes to a policy.

const money = (value: Types.Decimal128 | null) =>
  value === null ? null : new Decimal(value.toString()).toFixed(2);

function yearLabel(start: string, end: string): string {
  return `${formatDate(start)} to ${formatDate(end)}`;
}

// Recorded years

function recordedView(
  doc: RecordedPolicyYearDoc,
  names: ReadonlyMap<string, string>,
): RecordedPolicyYear {
  return {
    id: doc._id.toHexString(),
    clientId: doc.clientId.toHexString(),
    product: doc.product,
    policyStart: doc.policyStart,
    policyEnd: doc.policyEnd,
    insurerName: doc.insurerName,
    policyNumber: doc.policyNumber,
    employees: doc.employees,
    lives: doc.lives,
    totalSumInsured: money(doc.totalSumInsured),
    bySumInsured: doc.bySumInsured,
    premiumBeforeGst: money(doc.premiumBeforeGst),
    gst: money(doc.gst),
    claimsPaid: money(doc.claimsPaid),
    claimsOutstanding: money(doc.claimsOutstanding),
    claimsCount: doc.claimsCount,
    claimsAsOf: doc.claimsAsOf,
    source: doc.source,
    updatedAt: doc.updatedAt.toISOString(),
    updatedBy: nameOf(names, doc.updatedBy),
  };
}

const decimalOrNull = (value: string | null) => (value === null ? null : toDecimal128(value));

function recordedFields(input: RecordedPolicyYearInput) {
  return {
    ...input,
    clientId: new Types.ObjectId(input.clientId),
    totalSumInsured: decimalOrNull(input.totalSumInsured),
    premiumBeforeGst: decimalOrNull(input.premiumBeforeGst),
    gst: decimalOrNull(input.gst),
    claimsPaid: decimalOrNull(input.claimsPaid),
    claimsOutstanding: decimalOrNull(input.claimsOutstanding),
  };
}

async function assertClient(clientId: string): Promise<string> {
  const client = await ClientModel.findById(clientId, { name: 1 }).lean();
  if (!client)
    throw validationError([{ location: 'body', path: 'clientId', message: 'Client not found' }]);
  return client.name;
}

export async function listRecordedYears(clientId: string, product?: EbProduct) {
  const docs = await RecordedPolicyYearModel.find({
    clientId: new Types.ObjectId(clientId),
    ...(product ? { product } : {}),
  })
    .sort({ policyStart: -1 })
    .lean<RecordedPolicyYearDoc[]>();
  const names = await userNames(docs.map((doc) => doc.updatedBy));
  return { items: docs.map((doc) => recordedView(doc, names)) };
}

export async function recordPolicyYear(
  input: RecordedPolicyYearInput,
  actor: Actor,
): Promise<RecordedPolicyYear> {
  await assertClient(input.clientId);
  const actorId = new Types.ObjectId(actor.id);
  const id = await withTransaction(async (session) => {
    const [doc] = await RecordedPolicyYearModel.create(
      [{ ...recordedFields(input), createdBy: actorId, updatedBy: actorId }],
      { session },
    );
    await writeAudit(
      {
        userId: actor.id,
        action: AUDIT_ACTIONS.POLICY_YEAR_RECORDED,
        entity: AUDIT_ENTITIES.RENEWAL,
        entityId: input.clientId,
        before: null,
        after: input,
        requestId: actor.requestId,
      },
      session,
    );
    return doc!._id;
  });
  const doc = await RecordedPolicyYearModel.findById(id).lean<RecordedPolicyYearDoc>();
  return recordedView(doc!, await userNames([doc!.updatedBy]));
}

export async function updatePolicyYear(
  id: string,
  input: RecordedPolicyYearInput,
  actor: Actor,
): Promise<RecordedPolicyYear> {
  const before = Types.ObjectId.isValid(id)
    ? await RecordedPolicyYearModel.findById(id).lean<RecordedPolicyYearDoc>()
    : null;
  if (!before || before.clientId.toHexString() !== input.clientId)
    throw notFound('Policy year not found');
  await withTransaction(async (session) => {
    await RecordedPolicyYearModel.updateOne(
      { _id: before._id },
      { $set: { ...recordedFields(input), updatedBy: new Types.ObjectId(actor.id) } },
      { session },
    );
    await writeAudit(
      {
        userId: actor.id,
        action: AUDIT_ACTIONS.POLICY_YEAR_UPDATED,
        entity: AUDIT_ENTITIES.RENEWAL,
        entityId: input.clientId,
        before: recordedView(before, new Map()),
        after: input,
        requestId: actor.requestId,
      },
      session,
    );
  });
  const doc = await RecordedPolicyYearModel.findById(id).lean<RecordedPolicyYearDoc>();
  return recordedView(doc!, await userNames([doc!.updatedBy]));
}

// Options

export async function renewalOptions(clientId: string, product: EbProduct) {
  await assertClient(clientId);
  const [policies, recorded, open] = await Promise.all([
    insuredPolicies({ clientId, product }),
    RecordedPolicyYearModel.find({ clientId: new Types.ObjectId(clientId), product })
      .sort({ policyStart: -1 })
      .lean<RecordedPolicyYearDoc[]>(),
    GhiCaseModel.find({
      clientId: new Types.ObjectId(clientId),
      ...(product === 'GMC'
        ? { product: { $in: [null, 'GMC'] }, policy: null }
        : { product, placement: { $in: [null] } }),
      stage: { $ne: 'CLOSED' },
    })
      .sort({ _id: -1 })
      .limit(50)
      .lean<GhiCaseDoc[]>(),
  ]);
  const quoteCounts = await GhiQuoteModel.aggregate<{ _id: Types.ObjectId; count: number }>([
    { $match: { caseId: { $in: open.map((doc) => doc._id) }, status: 'FINAL' } },
    { $group: { _id: '$caseId', count: { $sum: 1 } } },
  ]);
  return {
    years: [
      ...policies.map((policy) => ({
        source: 'POLICY' as const,
        id: policy.caseId,
        label: `${yearLabel(policy.policyStart, policy.policyEnd)} · ${policy.insurerName} (in the app, ${policy.reference})`,
        policyStart: policy.policyStart,
        policyEnd: policy.policyEnd,
        insurerName: policy.insurerName,
        policyNumber: policy.policyNumber,
      })),
      ...recorded.map((doc) => ({
        source: 'RECORDED' as const,
        id: doc._id.toHexString(),
        label: `${yearLabel(doc.policyStart, doc.policyEnd)} · ${doc.insurerName} (recorded)`,
        policyStart: doc.policyStart,
        policyEnd: doc.policyEnd,
        insurerName: doc.insurerName,
        policyNumber: doc.policyNumber,
      })),
    ].sort((a, b) => b.policyStart.localeCompare(a.policyStart)),
    upcoming: open.map((doc) => ({
      caseId: doc._id.toHexString(),
      reference: doc.reference,
      type: doc.type,
      quotes: quoteCounts.find((item) => item._id.equals(doc._id))?.count ?? 0,
    })),
  };
}

// Figures of a year

async function policyFigures(
  policy: InsuredPolicy,
  doc: GhiCaseDoc,
  asOf: string,
): Promise<PolicyYearFigures> {
  const notes: string[] = [];
  let lives: Array<{ relationship: string; cover: string | null }>;
  let floater = false;
  if (policy.product === 'GMC') {
    const members = await GhiMemberModel.find(
      { caseId: doc._id },
      { employeeKey: 1, relationship: 1, dateOfBirth: 1, sumInsured: 1 },
    ).lean();
    const families = new Map<string, string | null>();
    for (const member of members) {
      if (member.relationship === 'SELF')
        families.set(member.employeeKey, member.sumInsured?.toString() ?? null);
    }
    floater = doc.requirements.coverageType === 'FLOATER';
    lives = members.map((member) => ({
      relationship: member.relationship,
      cover: effectiveSumInsured(
        {
          employeeKey: member.employeeKey,
          relationship: member.relationship,
          dateOfBirth: member.dateOfBirth,
          sumInsured: member.sumInsured?.toString() ?? null,
        },
        families,
        doc.requirements.coverageType,
      ),
    }));
    if (doc.policy && doc.policy.census.revision !== doc.censusRevision) {
      notes.push(
        'The census changed after the policy was recorded: the figures are the census as it is now.',
      );
    }
  } else {
    const members = await EbPolicySnapshotMemberModel.find(
      { caseId: doc._id },
      { relationship: 1, coveredSumInsured: 1 },
    ).lean();
    lives = members.map((member) => ({
      relationship: member.relationship,
      cover: member.coveredSumInsured?.toString() ?? null,
    }));
  }
  const byAmount = new Map<string, { families: number; lives: number }>();
  let total = 0n;
  let unknownCover = 0;
  for (const life of lives) {
    if (life.cover === null) {
      unknownCover += 1;
      continue;
    }
    const key = new Decimal(life.cover).toFixed(0);
    const entry = byAmount.get(key) ?? { families: 0, lives: 0 };
    entry.lives += 1;
    if (life.relationship === 'SELF') entry.families += 1;
    byAmount.set(key, entry);
    if (!floater || life.relationship === 'SELF') total += toPaise(key);
  }
  if (unknownCover > 0)
    notes.push(
      `${unknownCover} insured life/lives without a sum insured are left out of the sum insured figures.`,
    );
  const imported = await TpaImportModel.exists({ caseId: doc._id, status: 'IMPORTED' });
  let claims: PolicyYearFigures['claims'] = {
    toDate: null,
    paid: null,
    outstanding: null,
    count: null,
    asOf: null,
    source: 'NONE',
  };
  if (imported) {
    const records = await TpaClaimModel.find(
      { caseId: doc._id },
      {
        status: 1,
        requestType: 1,
        parent: 1,
        claimedAmount: 1,
        sanctionedAmount: 1,
        settledAmount: 1,
        disallowedAmount: 1,
        admissionDate: 1,
      },
    ).lean();
    let paid = 0n;
    let outstanding = 0n;
    let count = 0;
    for (const record of records) {
      if (record.admissionDate && record.admissionDate > asOf) continue;
      const claim = {
        status: record.status,
        requestType: record.requestType,
        parentLinked: record.parent.id !== null,
        claimedAmount: money(record.claimedAmount),
        sanctionedAmount: money(record.sanctionedAmount),
        settledAmount: money(record.settledAmount),
        disallowedAmount: money(record.disallowedAmount),
      };
      if (bucketOf(claim) === 'NOT_COUNTED') continue;
      const split = paidAndOutstanding(claim, 'SANCTIONED_ELSE_CLAIMED');
      paid += split.paid;
      outstanding += split.outstanding;
      count += 1;
    }
    claims = {
      toDate: fromPaise(paid + outstanding),
      paid: fromPaise(paid),
      outstanding: fromPaise(outstanding),
      count,
      asOf,
      source: 'TPA',
    };
  } else notes.push('No TPA claims have been imported for this policy.');
  return {
    source: 'POLICY',
    sourceId: policy.caseId,
    label: yearLabel(policy.policyStart, policy.policyEnd),
    product: policy.product,
    policyNumber: policy.policyNumber,
    insurerName: policy.insurerName,
    policyStart: policy.policyStart,
    policyEnd: policy.policyEnd,
    employees: lives.filter((life) => life.relationship === 'SELF').length,
    lives: lives.length,
    bySumInsured: [...byAmount.entries()]
      .sort(([a], [b]) => (BigInt(a) < BigInt(b) ? -1 : 1))
      .map(([amount, entry]) => ({ amount, ...entry })),
    totalSumInsured: lives.length === unknownCover ? null : fromPaise(total),
    premiumBeforeGst: policy.basePremium,
    gst: policy.gst,
    claims,
    incomplete: asOf < policy.policyEnd,
    notes,
  };
}

function recordedFigures(doc: RecordedPolicyYearDoc, asOf: string): PolicyYearFigures {
  const paid = money(doc.claimsPaid);
  const outstanding = money(doc.claimsOutstanding);
  const hasClaims = paid !== null || outstanding !== null;
  return {
    source: 'RECORDED',
    sourceId: doc._id.toHexString(),
    label: yearLabel(doc.policyStart, doc.policyEnd),
    product: doc.product,
    policyNumber: doc.policyNumber,
    insurerName: doc.insurerName,
    policyStart: doc.policyStart,
    policyEnd: doc.policyEnd,
    employees: doc.employees,
    lives: doc.lives,
    bySumInsured: doc.bySumInsured,
    totalSumInsured: money(doc.totalSumInsured),
    premiumBeforeGst: money(doc.premiumBeforeGst),
    gst: money(doc.gst),
    claims: {
      toDate: hasClaims ? fromPaise(toPaise(paid) + toPaise(outstanding)) : null,
      paid,
      outstanding,
      count: doc.claimsCount,
      asOf: doc.claimsAsOf,
      source: hasClaims ? 'RECORDED' : 'NONE',
    },
    incomplete: (doc.claimsAsOf ?? asOf) < doc.policyEnd,
    notes: [`Recorded by hand: ${doc.source}`],
  };
}

export async function renewalAnalysis(request: RenewalAnalysisRequest): Promise<RenewalAnalysis> {
  const company = await assertClient(request.clientId);
  const asOf = request.asOf ?? istDay(new Date());
  const figures: PolicyYearFigures[] = [];
  for (const ref of request.years) {
    if (ref.source === 'POLICY') {
      const { doc, policy } = await loadInsuredPolicy(ref.id);
      if (policy.clientId !== request.clientId || policy.product !== request.product) {
        throw validationError([
          {
            location: 'body',
            path: 'years',
            message: `Policy ${policy.reference} is not a ${request.product} policy of this company`,
          },
        ]);
      }
      figures.push(await policyFigures(policy, doc, asOf));
    } else {
      const doc = Types.ObjectId.isValid(ref.id)
        ? await RecordedPolicyYearModel.findById(ref.id).lean<RecordedPolicyYearDoc>()
        : null;
      if (
        !doc ||
        doc.clientId.toHexString() !== request.clientId ||
        doc.product !== request.product
      ) {
        throw validationError([
          {
            location: 'body',
            path: 'years',
            message: 'A recorded year is not of this company and product',
          },
        ]);
      }
      figures.push(recordedFigures(doc, asOf));
    }
  }
  figures.sort((a, b) => a.policyStart.localeCompare(b.policyStart));
  const years = figures.map(renewalYear);
  const warnings: string[] = [];
  for (let index = 1; index < figures.length; index += 1) {
    if (figures[index]!.policyStart <= figures[index - 1]!.policyEnd) {
      warnings.push(
        `${figures[index - 1]!.label} and ${figures[index]!.label} overlap: check the years chosen.`,
      );
    }
  }
  for (const year of years)
    if (year.incomplete)
      warnings.push(`${year.label} is not over on ${formatDate(asOf)}: its claims are not final.`);
  let upcoming: RenewalAnalysis['upcoming'] = null;
  if (request.upcomingCaseId) {
    const doc = await GhiCaseModel.findById(request.upcomingCaseId).lean<GhiCaseDoc>();
    if (
      !doc ||
      doc.clientId.toHexString() !== request.clientId ||
      (doc.product ?? 'GMC') !== request.product
    ) {
      throw validationError([
        {
          location: 'body',
          path: 'upcomingCaseId',
          message: 'Choose an open case of this company and product',
        },
      ]);
    }
    const quotes = await GhiQuoteModel.find({ caseId: doc._id, status: 'FINAL' })
      .sort({ version: -1 })
      .lean();
    const latest = new Map<string, (typeof quotes)[number]>();
    for (const quote of quotes)
      if (!latest.has(quote.insurerId.toHexString()))
        latest.set(quote.insurerId.toHexString(), quote);
    const names = await insurerNames([...latest.values()].map((quote) => quote.insurerId));
    upcoming = {
      caseId: doc._id.toHexString(),
      reference: doc.reference,
      policyStart: doc.policyStart,
      quotes: renewalQuotes(
        [...latest.values()].map((quote) => ({
          insurerName: names.get(quote.insurerId.toHexString()) ?? 'Insurer',
          quoteVersion: quote.version,
          basePremium: money(quote.basePremium),
          gst: money(quote.gst),
          totalPremium: money(quote.totalPremium),
        })),
        years.at(-1)?.premiumBeforeGst.value ?? null,
      ),
    };
    if (upcoming.quotes.length === 0) warnings.push(`${doc.reference} has no recorded quote yet.`);
  }
  return RenewalAnalysisSchema.parse({
    company,
    clientId: request.clientId,
    product: request.product,
    asOf,
    generatedAt: new Date().toISOString(),
    years,
    changes: years.slice(1).map((year, index) => renewalChanges(years[index]!, year)),
    upcoming,
    parameters: [
      { label: 'Product', value: `${request.product} (${EB_PRODUCT_NAMES[request.product]})` },
      { label: 'Claims counted to', value: formatDate(asOf) },
      {
        label: 'Claims to date',
        value:
          'Paid (settled amount of settled claims) + outstanding (sanctioned, else claimed, amount of open claims), from the imported TPA claims; a pre-authorisation linked to its main claim is not counted twice',
      },
      { label: 'Claims ratio', value: 'Claims to date ÷ premium before GST × 100' },
      { label: 'Average premium per family', value: 'Premium before GST ÷ employees' },
      {
        label: 'Average premium per person',
        value: 'Premium before GST ÷ insured lives (employees and dependants)',
      },
      {
        label: 'Premium per lakh of sum insured',
        value:
          'Premium before GST ÷ (total sum insured ÷ 1,00,000); floater: each family’s sum insured once',
      },
      {
        label: 'Changes',
        value:
          'Each year against the year before it; a percentage change is not shown when the earlier year is zero or missing, and ratios change in percentage points',
      },
      { label: 'Rounding', value: 'Amounts to the paisa and percentages to 2 decimals, half up' },
    ],
    warnings,
  });
}

// Saved analyses

export async function saveRenewalReport(
  request: RenewalAnalysisRequest & { title: string },
  actor: Actor,
) {
  const { title, ...rest } = request;
  const analysis = await renewalAnalysis(rest);
  const id = await withTransaction(async (session) => {
    const [doc] = await RenewalReportModel.create(
      [
        {
          clientId: new Types.ObjectId(rest.clientId),
          product: rest.product,
          title,
          request: rest,
          analysis,
          createdBy: new Types.ObjectId(actor.id),
        },
      ],
      { session },
    );
    await writeAudit(
      {
        userId: actor.id,
        action: AUDIT_ACTIONS.RENEWAL_REPORT_SAVED,
        entity: AUDIT_ENTITIES.RENEWAL,
        entityId: rest.clientId,
        before: null,
        after: { reportId: doc!._id.toHexString(), title, years: rest.years },
        requestId: actor.requestId,
      },
      session,
    );
    return doc!._id.toHexString();
  });
  return getRenewalReport(id);
}

export async function getRenewalReport(id: string) {
  const doc = Types.ObjectId.isValid(id) ? await RenewalReportModel.findById(id).lean() : null;
  if (!doc) throw notFound('Saved analysis not found');
  const names = await userNames([doc.createdBy]);
  return {
    id: doc._id.toHexString(),
    title: doc.title,
    createdAt: doc.createdAt.toISOString(),
    createdBy: nameOf(names, doc.createdBy),
    analysis: RenewalAnalysisSchema.parse(doc.analysis),
  };
}

export async function listRenewalReports(clientId: string) {
  const docs = await RenewalReportModel.find({ clientId: new Types.ObjectId(clientId) })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();
  const names = await userNames(docs.map((doc) => doc.createdBy));
  return {
    items: docs.map((doc) => ({
      id: doc._id.toHexString(),
      title: doc.title,
      createdAt: doc.createdAt.toISOString(),
      createdBy: nameOf(names, doc.createdBy),
      product: doc.product,
      years: ((doc.analysis as { years?: Array<{ label: string }> }).years ?? []).map(
        (year) => year.label,
      ),
    })),
  };
}
