import { AuditLogModel } from './modules/audit/audit.model.ts';
import {
  ClaimEventModel,
  ClaimFileModel,
  ClaimModel,
  ClaimNotificationModel,
} from './modules/claims/claim.model.ts';
import {
  ClaimEmailTemplateModel,
  ClaimHrContactModel,
  ClaimLinkModel,
} from './modules/claims/claim-settings.model.ts';
import { CatalogItemModel } from './modules/catalog/catalog-item.model.ts';
import { CloudDocumentModel } from './modules/cloud-storage/cloud-document.model.ts';
import { ChatFileModel, ChatMessageModel, ConversationModel } from './modules/chat/chat.model.ts';
import { DocumentTemplateModel } from './modules/documents/document-template.model.ts';
import { EmailTemplateModel } from './modules/email-templates/email-template.model.ts';
import { MailAttachmentModel } from './modules/mail/mail-attachment.model.ts';
import { MailLogModel } from './modules/mail/mail-log.model.ts';
import { NotificationModel } from './modules/notifications/notification.model.ts';
import { AddonFavouritesModel } from './modules/clients/addon-favourites.model.ts';
import { ClientLocationModel } from './modules/clients/client-location.model.ts';
import { ClientModel } from './modules/clients/client.model.ts';
import { GhiCaseModel } from './modules/ghi/ghi-case.model.ts';
import {
  EbCensusImportModel,
  GhiCensusImportModel,
  GhiMemberModel,
} from './modules/ghi/ghi-census.model.ts';
import {
  EbPolicySnapshotMemberModel,
  EbPolicySnapshotModel,
} from './modules/ghi/eb-placement.model.ts';
import { EmployeeIdentityModel } from './modules/employees/employee.model.ts';
import { ClientPlanDefaultModel } from './modules/family-plans/client-plan-default.model.ts';
import { FamilyPlanModel } from './modules/family-plans/family-plan.model.ts';
import { AgeBandSetModel } from './modules/age-bands/age-band-set.model.ts';
import { RecordedPolicyYearModel, RenewalReportModel } from './modules/renewal/renewal.model.ts';
import {
  PremiumAdjustmentModel,
  TpaClaimEventModel,
  TpaClaimModel,
  TpaFormatModel,
  TpaImportModel,
  TpaImportRowModel,
} from './modules/tpa/tpa.model.ts';
import {
  GhiDispatchModel,
  GhiFileModel,
  GhiPaymentModel,
  GhiQcrModel,
  GhiQuoteModel,
  GhiRfqModel,
} from './modules/ghi/ghi-workflow.model.ts';
import { InsurerModel } from './modules/insurers/insurer.model.ts';
import { CounterModel, ProposalModel } from './modules/proposals/proposal.model.ts';
import { MasterVersionModel } from './modules/masters/master-version.model.ts';
import { OccupancyModel } from './modules/masters/occupancy.model.ts';
import { PincodeModel } from './modules/masters/pincode.model.ts';
import { QcrModel } from './modules/qcr/qcr.model.ts';
import { RfqStateModel, RfqVersionModel } from './modules/rfq/rfq.model.ts';
import { QuoteAttachmentModel, QuoteModel } from './modules/quotes/quote.model.ts';
import { RoleModel } from './modules/roles/role.model.ts';
import { UserModel } from './modules/users/user.model.ts';

const MODELS = [
  UserModel,
  // Database-driven roles (docs/RBAC.md).
  RoleModel,
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
  CloudDocumentModel,
  ConversationModel,
  ChatMessageModel,
  ChatFileModel,
  DocumentTemplateModel,
  AddonFavouritesModel,
  EmailTemplateModel,
  MailLogModel,
  MailAttachmentModel,
  NotificationModel,
  QuoteModel,
  QuoteAttachmentModel,
  QcrModel,
  RfqStateModel,
  RfqVersionModel,
  // Group health (GHI): new collections only; nothing above changes.
  GhiCaseModel,
  GhiMemberModel,
  GhiCensusImportModel,
  GhiRfqModel,
  GhiQuoteModel,
  GhiQcrModel,
  GhiPaymentModel,
  GhiFileModel,
  GhiDispatchModel,
  // Group health claims: new collections only.
  ClaimModel,
  ClaimFileModel,
  ClaimEventModel,
  ClaimNotificationModel,
  ClaimLinkModel,
  ClaimEmailTemplateModel,
  ClaimHrContactModel,
  // Employee Benefits (GPA, GTLI), family plans and employee identities: new collections only.
  EbCensusImportModel,
  FamilyPlanModel,
  AgeBandSetModel,
  TpaFormatModel,
  TpaImportModel,
  TpaImportRowModel,
  TpaClaimModel,
  TpaClaimEventModel,
  PremiumAdjustmentModel,
  RecordedPolicyYearModel,
  RenewalReportModel,
  ClientPlanDefaultModel,
  EmployeeIdentityModel,
  EbPolicySnapshotModel,
  EbPolicySnapshotMemberModel,
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
