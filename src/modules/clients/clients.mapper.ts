import type { Address, Client, ClientLocation, Contact, OccupancyRef } from '../../shared/index.ts';
import type { ClientLocationDoc } from './client-location.model.ts';
import type { AddressDoc, ClientDoc, ContactDoc, OccupancyRefDoc } from './client.model.ts';

export function toContactDto(contact: ContactDoc): Contact {
  return {
    name: contact.name,
    designation: contact.designation,
    email: contact.email,
    phone: contact.phone,
  };
}

export function toAddressDto(address: AddressDoc): Address {
  return {
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    state: address.state,
    pincode: address.pincode,
  };
}

function toOccupancyRefDto(occupancy: OccupancyRefDoc): OccupancyRef {
  return { tacCode: occupancy.tacCode, description: occupancy.description };
}

export function toClientDto(doc: ClientDoc, locationCount: number): Client {
  return {
    id: doc._id.toHexString(),
    name: doc.name,
    gstin: doc.gstin,
    address: toAddressDto(doc.address),
    contacts: doc.contacts.map(toContactDto),
    natureOfBusiness: doc.natureOfBusiness,
    occupancy: toOccupancyRefDto(doc.occupancy),
    locationCount,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

/** The fields recorded in audit before/after snapshots for a client. */
export function toClientAuditView(client: Client) {
  return {
    name: client.name,
    gstin: client.gstin,
    address: client.address,
    contacts: client.contacts,
    natureOfBusiness: client.natureOfBusiness,
    occupancy: client.occupancy,
  };
}

export function toClientLocationDto(doc: ClientLocationDoc): ClientLocation {
  return {
    id: doc._id.toHexString(),
    clientId: doc.clientId.toHexString(),
    name: doc.name,
    address: toAddressDto(doc.address),
    district: doc.district,
    eqZone: doc.eqZone,
    occupancy: doc.occupancy ? toOccupancyRefDto(doc.occupancy) : null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

/** The fields recorded in audit before/after snapshots for a risk location. */
export function toClientLocationAuditView(location: ClientLocation) {
  return {
    clientId: location.clientId,
    name: location.name,
    address: location.address,
    district: location.district,
    eqZone: location.eqZone,
    occupancy: location.occupancy,
  };
}
