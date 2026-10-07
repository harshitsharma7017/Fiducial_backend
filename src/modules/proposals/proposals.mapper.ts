import { OTHER_SECTIONS, RISK_DETAIL_FIELDS, type ProposalRecord } from '../../shared/index.ts';
import type { Types } from 'mongoose';
import { decimal128ToString } from '../../lib/decimal.ts';
import type { ClientLocationDoc } from '../clients/client-location.model.ts';
import { ClientLocationModel } from '../clients/client-location.model.ts';
import { ClientModel, type ClientDoc } from '../clients/client.model.ts';
import { toAddressDto } from '../clients/clients.mapper.ts';
import { InsurerModel, type InsurerDoc } from '../insurers/insurer.model.ts';
import { UserModel } from '../users/user.model.ts';
import {
  fireTotals,
  itemSumInsured,
  missingForRfq,
  stageOf,
  sumOf,
  type FireItemValues,
} from './proposal-calc.ts';
import type { ProposalDoc } from './proposal.model.ts';

/** The records a page of proposals refers to, read in one query per collection. */
export interface ProposalContext {
  clients: ReadonlyMap<string, ClientDoc>;
  locations: ReadonlyMap<string, ClientLocationDoc>;
  insurers: ReadonlyMap<string, InsurerDoc>;
  users: ReadonlyMap<string, string>;
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
      ...doc.activity.flatMap((a) => (a.actorId ? [key(a.actorId)] : [])),
    ]),
  );
  const [clients, locations, insurers, users] = await Promise.all([
    ClientModel.find({ _id: { $in: [...clientIds] } }).lean(),
    ClientLocationModel.find({ _id: { $in: [...locationIds] } }).lean(),
    InsurerModel.find({ _id: { $in: [...insurerIds] } }).lean(),
    UserModel.find({ _id: { $in: [...userIds] } }, { name: 1 }).lean(),
  ]);
  return {
    clients: new Map(clients.map((doc) => [key(doc._id), doc])),
    locations: new Map(locations.map((doc) => [key(doc._id), doc])),
    insurers: new Map(insurers.map((doc) => [key(doc._id), doc])),
    users: new Map(users.map((doc) => [key(doc._id), doc.name])),
  };
}

const str = (value: Types.Decimal128 | null) => decimal128ToString(value);

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
  const sections = OTHER_SECTIONS.map((code) => {
    const section = byCode.get(code);
    return {
      code,
      included: section?.included ?? false,
      proposed1: section ? str(section.proposed1) : null,
      proposed2: section ? str(section.proposed2) : null,
    };
  });
  const missing = missingForRfq({ locations, fireProposed1: totals.proposed1, sections });
  const anySent = doc.insurers.some((insurer) => insurer.status === 'SENT');

  return {
    id: key(doc._id),
    reference: doc.reference,
    type: 'NEW',
    stage: stageOf(missing, anySent),
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
    locations: locations.map((location) => location.record),
    fire: {
      groups: totals.groups.map((line) => ({
        group: line.group,
        proposed1: line.proposed1.toFixed(),
        proposed2: line.proposed2?.toFixed() ?? null,
      })),
      proposed1: totals.proposed1.toFixed(),
      proposed2: totals.proposed2?.toFixed() ?? null,
    },
    sections,
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
    locked: anySent,
    insurers: doc.insurers.map((entry) => {
      const insurer = context.insurers.get(key(entry.insurerId));
      return {
        insurerId: key(entry.insurerId),
        company: insurer?.company ?? 'Unknown insurer',
        branch: insurer?.branch ?? '',
        rfqEmails: insurer ? [...insurer.rfqEmails] : [],
        active: insurer?.active ?? false,
        status: entry.status,
        sentAt: entry.sentAt?.toISOString() ?? null,
        sentBy: entry.sentBy ? userName(entry.sentBy) : null,
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
    stage: record.stage,
    dueDate: record.dueDate,
    policyStart: record.policyStart,
    locations: record.locations.map((l) => `${l.location?.name ?? l.locationId}: ${l.fireTotal}`),
    fireProposed1: record.fire.proposed1,
    fireProposed2: record.fire.proposed2,
    sectionsIncluded: record.sections
      .filter((section) => section.included)
      .map(
        (section) => `${section.code}: ${section.proposed1 ?? '—'} / ${section.proposed2 ?? '—'}`,
      ),
    claims: record.claims.length,
    insurers: record.insurers.map(
      (insurer) => `${insurer.company}, ${insurer.branch} (${insurer.status})`,
    ),
  };
}
