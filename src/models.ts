import { AuditLogModel } from './modules/audit/audit.model.ts';
import { CatalogItemModel } from './modules/catalog/catalog-item.model.ts';
import { DocumentTemplateModel } from './modules/documents/document-template.model.ts';
import { AddonFavouritesModel } from './modules/clients/addon-favourites.model.ts';
import { ClientLocationModel } from './modules/clients/client-location.model.ts';
import { ClientModel } from './modules/clients/client.model.ts';
import { InsurerModel } from './modules/insurers/insurer.model.ts';
import { CounterModel, ProposalModel } from './modules/proposals/proposal.model.ts';
import { MasterVersionModel } from './modules/masters/master-version.model.ts';
import { OccupancyModel } from './modules/masters/occupancy.model.ts';
import { PincodeModel } from './modules/masters/pincode.model.ts';
import { UserModel } from './modules/users/user.model.ts';

const MODELS = [
  UserModel,
  AuditLogModel,
  MasterVersionModel,
  OccupancyModel,
  PincodeModel,
  ClientModel,
  ClientLocationModel,
  InsurerModel,
  ProposalModel,
  CounterModel,
  CatalogItemModel,
  DocumentTemplateModel,
  AddonFavouritesModel,
];

/**
 * Creates collections and the indexes declared on the schemas (autoIndex is off). Collections
 * must exist up front because they cannot be created inside a transaction on every server
 * version. Safe to run on every start.
 */
export async function ensureIndexes(): Promise<void> {
  for (const model of MODELS) {
    await model.createCollection();
    await model.createIndexes();
  }
}
