import {
  DEFAULT_FIRE_COVERS,
  OTHER_SECTION_LABELS,
  OTHER_SECTIONS,
  RISK_DETAIL_FIELDS,
  SECTION_LINES,
  addonListsForProduct,
  hasBasis,
  hasRfq,
  isOverdue,
  productRangeText,
  suggestProducts,
  wholeRupees,
  type CatalogItem,
  type Cover,
  type OtherSection,
  type SectionWithLines,
  type ProposalRecord,
} from '../../shared/index.ts';
import type { Types } from 'mongoose';
import { decimal128ToString } from '../../lib/decimal.ts';
import { istDay } from '../../lib/ist-day.ts';
import { catalogItems } from '../catalog/catalog.service.ts';
import type { ClientLocationDoc } from '../clients/client-location.model.ts';
import { ClientLocationModel } from '../clients/client-location.model.ts';
import { ClientModel, type ClientDoc } from '../clients/client.model.ts';
import { toAddressDto } from '../clients/clients.mapper.ts';
import { InsurerModel, type InsurerDoc } from '../insurers/insurer.model.ts';
import { UserModel } from '../users/user.model.ts';
import { Decimal } from '../../lib/decimal.ts';
import {
  contentsTotals,
  fireTotals,
  itemSumInsured,
  missingForRfq,
  nextStageOf,
  onBasis,
  stageOf,
  sumOf,
  type FireItemValues,
} from './proposal-calc.ts';
import type { CoverDoc, ProposalDoc } from './proposal.model.ts';

/** The records a page of proposals refers to, read in one query per collection. */
export interface ProposalContext {
  clients: ReadonlyMap<string, ClientDoc>;
  locations: ReadonlyMap<string, ClientLocationDoc>;
  insurers: ReadonlyMap<string, InsurerDoc>;
  users: ReadonlyMap<string, string>;
  /** The product and coverage section masters, in their order. */
  products: readonly CatalogItem<'products'>[];
  sections: readonly CatalogItem<'sections'>[];
  /** When the records are read, for the Overdue flags (India date). */
  now: Date;
}

const key = (id: Types.ObjectId) => id.toHexString();

export async function loadContext(docs: readonly ProposalDoc[]): Promise<ProposalContext> {
  const clientIds = new Set(docs.map((doc) => key(doc.clientId)));
  const locationIds = new Set(docs.flatMap((doc) => doc.locations.map((l) => key(l.locationId))));
  const insurerIds = new Set(docs.flatMap((doc) => doc.insurers.map((i) => key(i.insurerId))));
  const userIds = new Set(
    docs.flatMap((doc) => [
      key(doc.ownerId),
      ...doc.insurers.flatMap((i) => (i.sentBy ? [key(i.sentBy)] : [])),
      ...doc.insurers.flatMap((i) => (i.response ? [key(i.response.by)] : [])),
      ...doc.activity.flatMap((a) => (a.actorId ? [key(a.actorId)] : [])),
      ...(doc.deleted ? [key(doc.deleted.by)] : []),
    ]),
  );
  const [clients, locations, insurers, users, products, sections] = await Promise.all([
    ClientModel.find({ _id: { $in: [...clientIds] } }).lean(),
    ClientLocationModel.find({ _id: { $in: [...locationIds] } }).lean(),
    InsurerModel.find({ _id: { $in: [...insurerIds] } }).lean(),
    UserModel.find({ _id: { $in: [...userIds] } }, { name: 1 }).lean(),
    catalogItems('products'),
    catalogItems('sections'),
  ]);
  return {
    clients: new Map(clients.map((doc) => [key(doc._id), doc])),
    locations: new Map(locations.map((doc) => [key(doc._id), doc])),
    insurers: new Map(insurers.map((doc) => [key(doc._id), doc])),
    users: new Map(users.map((doc) => [key(doc._id), doc.name])),
    products,
    sections,
    now: new Date(),
  };
}

/**
 * The other sections in the master's order, with its names. Without a section master, the
 * built-in order and names. A section switched off is shown only when the proposal includes it.
 */
function orderedSections(
  context: ProposalContext,
): { code: OtherSection; name: string; active: boolean }[] {
  const fromMaster = context.sections.flatMap((section) =>
    section.code === 'FIRE'
      ? []
      : [{ code: section.code, name: section.name, active: section.active }],
  );
  const listed = new Set(fromMaster.map((section) => section.code));
  return [
    ...fromMaster,
    ...OTHER_SECTIONS.filter((code) => !listed.has(code)).map((code) => ({
      code,
      name: OTHER_SECTION_LABELS[code],
      active: true,
    })),
  ];
}

const str = (value: Types.Decimal128 | null) => decimal128ToString(value);

const coverKey = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * A section's add-on covers (C-6): the master's, in its order, with the answers saved (null when
 * not yet answered). Covers answered before the master dropped them are kept after them.
 */
function coversOf(names: readonly string[], saved: readonly CoverDoc[] | undefined): Cover[] {
  const answers = new Map((saved ?? []).map((cover) => [coverKey(cover.name), cover.required]));
  const known = new Set(names.map(coverKey));
  return [
    ...names.map((name) => ({ name, required: answers.get(coverKey(name)) ?? null })),
    ...(saved ?? [])
      .filter((cover) => !known.has(coverKey(cover.name)))
      .map((cover) => ({ name: cover.name, required: cover.required })),
  ];
}

const linesRecord = (
  code: OtherSection,
  entries: readonly { key: string; value: Types.Decimal128 }[] | undefined,
) =>
  Object.fromEntries(
    (SECTION_LINES[code as SectionWithLines] ?? []).map((line) => [
      line.key,
      str(entries?.find((entry) => entry.key === line.key)?.value ?? null),
    ]),
  );

/**
 * A renewal's Existing column (C-2): the figures typed on the Data Sheet, else the policy
 * software's copy. New business has none.
 */
function existingColumn(doc: ProposalDoc) {
  if (doc.type !== 'EXISTING') return null;
  const figures = doc.existingFigures ?? null;
  const copy = doc.existingPolicy ?? null;
  if (figures) {
    const lines = figures.fireLines.map((line) => ({ group: line.group, value: str(line.amount) }));
    return {
      header: {
        insurer: figures.insurer,
        policyNumber: figures.policyNumber,
        source: 'DATA_SHEET' as const,
      },
      fireLine: (group: string) => lines.find((line) => line.group === group)?.value ?? null,
      fireTotal:
        lines.length > 0
          ? sumOf(lines.map((line) => new Decimal(line.value ?? '0'))).toFixed()
          : str(figures.fireTotal),
      section: (code: string) => {
        const entry = figures.sections.find((section) => section.code === code);
        return { sumInsured: str(entry?.sumInsured ?? null), lines: entry?.lines ?? [] };
      },
    };
  }
  if (!copy) return null;
  return {
    header: {
      insurer: copy.insurer,
      policyNumber: copy.policyNumber,
      source: 'POLICY_SOFTWARE' as const,
    },
    fireLine: (group: string) =>
      copy.fireLines.find((line) => line.group === group)?.sumInsured.toString() ?? null,
    fireTotal:
      copy.sections.find((section) => section.code === 'FIRE')?.sumInsured.toString() ?? null,
    section: (code: string) => ({
      sumInsured:
        copy.sections.find((section) => section.code === code)?.sumInsured.toString() ?? null,
      lines: [],
    }),
  };
}

function fireValues(doc: ProposalDoc['locations'][number]): FireItemValues[] {
  return doc.fire.map((item) => ({
    key: item.key,
    sqFt: str(item.sqFt),
    ratePerSqFt: str(item.ratePerSqFt),
    amount: str(item.amount),
  }));
}

/** The API view of a proposal, with live client, location and insurer details. */
export function toProposalRecord(doc: ProposalDoc, context: ProposalContext): ProposalRecord {
  const client = context.clients.get(key(doc.clientId));
  const userName = (id: Types.ObjectId | null) =>
    id ? (context.users.get(key(id)) ?? 'Unknown user') : 'System';

  const locations = doc.locations.map((entry) => {
    const location = context.locations.get(key(entry.locationId));
    const fire = fireValues(entry);
    return {
      entry,
      name: location?.name ?? 'Removed location',
      fire,
      record: {
        locationId: key(entry.locationId),
        location:
          location && client
            ? {
                name: location.name,
                address: toAddressDto(location.address),
                district: location.district,
                eqZone: location.eqZone,
                occupancy: location.occupancy ?? client.occupancy,
              }
            : null,
        fire: fire.map((item) => ({ ...item, sumInsured: itemSumInsured(item).toFixed() })),
        fireTotal: sumOf(fire.map(itemSumInsured)).toFixed(),
        hypothecation: entry.hypothecation,
        openStock: entry.openStock,
        risk: Object.fromEntries(
          RISK_DETAIL_FIELDS.map((field) => [field.key, entry.risk?.[field.key] ?? null]),
        ),
      },
    };
  });

  const totals = fireTotals(
    locations,
    new Map(doc.fireOption2.map((line) => [line.group, str(line.amount)])),
  );
  const byCode = new Map(doc.sections.map((section) => [section.code, section]));
  const existing = existingColumn(doc);
  const coverNames = new Map(context.sections.map((section) => [section.code, section.addons]));
  const contents = contentsTotals(totals);
  const sections = orderedSections(context).flatMap(({ code, name, active }) => {
    const section = byCode.get(code);
    const included = section?.included ?? false;
    if (!active && !included) return [];
    const basis = hasBasis(code) ? (section?.basis ?? null) : null;
    // C-3: with a basis, Burglary's sum insured is the Fire contents, so it follows them.
    const fromContents = code === 'BURGLARY' && basis !== null;
    const proposed1 = fromContents
      ? contents.proposed1.toFixed()
      : section
        ? str(section.proposed1)
        : null;
    const proposed2 = fromContents
      ? (contents.proposed2?.toFixed() ?? null)
      : section
        ? str(section.proposed2)
        : null;
    const last = existing?.section(code);
    return [
      {
        code,
        name,
        included,
        existing: last?.sumInsured ?? null,
        proposed1,
        proposed2,
        lines: linesRecord(code, section?.lines),
        lines2: linesRecord(code, section?.lines2),
        existingLines: linesRecord(code, last?.lines),
        basis,
        basisAmounts: basis
          ? {
              proposed1:
                onBasis(proposed1 === null ? null : new Decimal(proposed1), basis)?.toFixed() ??
                null,
              proposed2:
                onBasis(proposed2 === null ? null : new Decimal(proposed2), basis)?.toFixed() ??
                null,
            }
          : null,
        covers: coversOf(coverNames.get(code) ?? [], section?.covers),
        annexure: (section?.annexure ?? []).map((row) => ({
          description: row.description,
          quantity: row.quantity === null ? null : String(row.quantity),
          dimensions: row.dimensions,
          makeModel: row.makeModel,
          serialNo: row.serialNo,
          year: row.year,
          sumInsured: row.sumInsured.toString(),
        })),
      },
    ];
  });
  // C-1: the chosen product, else the first one the Fire sum insured suggests.
  const suggested = totals.proposed1.isZero()
    ? []
    : suggestProducts(context.products, wholeRupees(totals.proposed1.toFixed()));
  const chosen = doc.product ?? null;
  const chosenMaster = chosen
    ? context.products.find((product) => product.code === chosen.code)
    : undefined;
  const productMaster = chosen ? chosenMaster : suggested[0];
  const product = chosen
    ? {
        code: chosen.code,
        name: chosenMaster?.name ?? chosen.code,
        // Before the Fire sum insured nothing is suggested, so any product may be chosen.
        source:
          suggested.length === 0 || suggested.some((item) => item.code === chosen.code)
            ? ('CHOSEN' as const)
            : ('OVERRIDE' as const),
        reason: chosen.reason,
      }
    : suggested[0]
      ? {
          code: suggested[0].code,
          name: suggested[0].name,
          source: 'SUGGESTED' as const,
          reason: null,
        }
      : null;

  const missing = missingForRfq({ locations, fireProposed1: totals.proposed1, sections, product });
  const anySent = doc.insurers.some((insurer) => hasRfq(insurer.status));
  const stage = stageOf(missing, anySent, doc.stageOverride ?? null);
  const today = istDay(context.now);
  const copy = doc.existingPolicy ?? null;
  const lookup = doc.existingPolicyLookup ?? null;
  const fireMaster = context.sections.find((section) => section.code === 'FIRE');

  return {
    id: key(doc._id),
    reference: doc.reference,
    type: doc.type,
    stage,
    nextStage: nextStageOf(stage),
    closedReason: doc.closedReason ?? null,
    deleted: doc.deleted
      ? { at: doc.deleted.at.toISOString(), by: userName(doc.deleted.by) }
      : null,
    client: {
      id: key(doc.clientId),
      name: client?.name ?? 'Unknown client',
      gstin: client?.gstin ?? null,
      city: client?.address.city ?? '',
      state: client?.address.state ?? '',
    },
    owner: { id: key(doc.ownerId), name: userName(doc.ownerId) },
    dueDate: doc.dueDate,
    policyStart: doc.policyStart,
    policyEnd: doc.policyEnd ?? null,
    existingPolicy: copy
      ? {
          source: copy.source,
          fetchedAt: copy.fetchedAt.toISOString(),
          insurer: copy.insurer,
          policyNumber: copy.policyNumber,
          product: copy.product,
          periodStart: copy.periodStart,
          periodEnd: copy.periodEnd,
          sections: copy.sections.map((section) => ({
            code: section.code as NonNullable<
              ProposalRecord['existingPolicy']
            >['sections'][number]['code'],
            sumInsured: section.sumInsured.toString(),
            premium: str(section.premium),
          })),
          fireLines: copy.fireLines.map((line) => ({
            group: line.group,
            sumInsured: line.sumInsured.toString(),
          })),
          totalSumInsured: copy.totalSumInsured.toString(),
          netPremium: str(copy.netPremium),
          gst: str(copy.gst),
          totalPremium: str(copy.totalPremium),
        }
      : null,
    existingPolicyLookup: lookup
      ? {
          status: lookup.status,
          message: lookup.message,
          checkedAt: lookup.checkedAt.toISOString(),
        }
      : null,
    existing: existing?.header ?? null,
    locations: locations.map((location) => location.record),
    fire: {
      groups: totals.groups.map((line) => ({
        group: line.group,
        existing: existing?.fireLine(line.group) ?? null,
        proposed1: line.proposed1.toFixed(),
        proposed2: line.proposed2?.toFixed() ?? null,
      })),
      existing: existing?.fireTotal ?? null,
      proposed1: totals.proposed1.toFixed(),
      proposed2: totals.proposed2?.toFixed() ?? null,
      covers: coversOf(fireMaster ? fireMaster.addons : DEFAULT_FIRE_COVERS, doc.fireCovers),
    },
    product,
    addonLists: productMaster
      ? addonListsForProduct(productMaster)
      : chosen
        ? addonListsForProduct({ code: chosen.code })
        : [],
    addons: (doc.addons ?? []).map((addon) => ({ list: addon.list, name: addon.name })),
    sections,
    // Nothing is suggested until the Fire sums insured are entered.
    suggestedProducts: suggested.map((item) => ({
      code: item.code,
      name: item.name,
      range: productRangeText(item),
    })),
    gstRatePercent: str(doc.gstRatePercent ?? null),
    claims: doc.claims.map((claim) => ({
      period: claim.period,
      policyType: claim.policyType,
      sumInsured: str(claim.sumInsured),
      premium: str(claim.premium),
      claimedAmount: str(claim.claimedAmount),
      remarks: claim.remarks,
      insurer: claim.insurer,
    })),
    notes: doc.notes,
    missing,
    // Sending the RFQ fixes the figures; a closed case changes no more.
    locked: anySent || stage === 'CLOSED',
    insurers: doc.insurers.map((entry) => {
      const insurer = context.insurers.get(key(entry.insurerId));
      const dueDate = entry.dueDate ?? null;
      const response = entry.response ?? null;
      const lastMail = entry.lastMail ?? null;
      return {
        insurerId: key(entry.insurerId),
        company: insurer?.company ?? 'Unknown insurer',
        branch: insurer?.branch ?? '',
        rfqEmails: insurer ? [...insurer.rfqEmails] : [],
        contacts: (insurer?.contacts ?? []).flatMap((contact) =>
          contact.email
            ? [{ name: contact.name, designation: contact.designation, email: contact.email }]
            : [],
        ),
        active: insurer?.active ?? false,
        status: entry.status,
        sentVia: entry.sentVia ?? (hasRfq(entry.status) ? 'OUTSIDE' : null),
        sentAt: entry.sentAt?.toISOString() ?? null,
        sentBy: entry.sentBy ? userName(entry.sentBy) : null,
        dueDate,
        overdue: isOverdue({ status: entry.status, dueDate }, today),
        reminderCount: entry.reminderCount ?? 0,
        lastRemindedAt: entry.lastRemindedAt?.toISOString() ?? null,
        response: response
          ? {
              status: response.status,
              note: response.note,
              at: response.at.toISOString(),
              by: userName(response.by),
            }
          : null,
        lastMail: lastMail
          ? {
              id: key(lastMail.id),
              kind: lastMail.kind,
              at: lastMail.at.toISOString(),
              result: lastMail.result,
            }
          : null,
      };
    }),
    activity: [...doc.activity]
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .map((entry) => ({
        at: entry.at.toISOString(),
        actor: userName(entry.actorId),
        message: entry.message,
      })),
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

/** The fields recorded in audit snapshots: what changed, not every keystroke of the sheet. */
export function toProposalAuditView(record: ProposalRecord) {
  return {
    type: record.type,
    stage: record.stage,
    closedReason: record.closedReason,
    owner: record.owner.name,
    dueDate: record.dueDate,
    policyStart: record.policyStart,
    policyEnd: record.policyEnd,
    existingPolicy: record.existingPolicy
      ? `${record.existingPolicy.policyNumber}, ${record.existingPolicy.insurer}: SI ${record.existingPolicy.totalSumInsured}, premium ${record.existingPolicy.totalPremium ?? '—'}`
      : null,
    existing: record.existing
      ? `${record.existing.insurer} ${record.existing.policyNumber ?? ''} (${record.existing.source === 'DATA_SHEET' ? 'typed' : 'policy software'}): Fire ${record.fire.existing ?? '—'}`
      : null,
    product: record.product
      ? `${record.product.code} (${record.product.source.toLowerCase()})${record.product.reason ? `: ${record.product.reason}` : ''}`
      : null,
    addons: record.addons.map((addon) => `${addon.list}: ${addon.name}`),
    locations: record.locations.map((l) => `${l.location?.name ?? l.locationId}: ${l.fireTotal}`),
    fireProposed1: record.fire.proposed1,
    fireProposed2: record.fire.proposed2,
    sectionsIncluded: record.sections
      .filter((section) => section.included)
      .map(
        (section) =>
          `${section.code}: ${section.existing ? `${section.existing} / ` : ''}${section.proposed1 ?? '—'} / ${section.proposed2 ?? '—'}${section.basis ? ` (${section.basis})` : ''}${section.annexure.length > 0 ? ` (${section.annexure.length} annexure rows)` : ''}`,
      ),
    claims: record.claims.length,
    insurers: record.insurers.map(
      (insurer) => `${insurer.company}, ${insurer.branch} (${insurer.status})`,
    ),
  };
}
