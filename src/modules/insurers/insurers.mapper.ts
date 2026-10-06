import type { Insurer } from '../../shared/index.ts';
import { toContactDto } from '../clients/clients.mapper.ts';
import type { InsurerDoc } from './insurer.model.ts';

export function toInsurerDto(doc: InsurerDoc): Insurer {
  return {
    id: doc._id.toHexString(),
    company: doc.company,
    branch: doc.branch,
    contacts: doc.contacts.map(toContactDto),
    rfqEmails: [...doc.rfqEmails],
    active: doc.active,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

/** The fields recorded in audit before/after snapshots for an insurer. */
export function toInsurerAuditView(insurer: Insurer) {
  return {
    company: insurer.company,
    branch: insurer.branch,
    contacts: insurer.contacts,
    rfqEmails: insurer.rfqEmails,
    active: insurer.active,
  };
}
