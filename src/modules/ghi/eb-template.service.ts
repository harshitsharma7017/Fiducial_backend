import {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  DEFAULT_NOMINEE_REQUIREMENT,
  ERROR_CODES,
  XLSX_CONTENT_TYPE,
  dependantsGiveOwnAmount,
  nomineeRequirementOf,
  templateColumns,
  templateNameOf,
  versionOn,
  type EbCensusTemplateQuery,
} from '../../shared/index.ts';
import { Types } from 'mongoose';
import { conflict, validationError } from '../../lib/errors.ts';
import { istDay } from '../../lib/ist-day.ts';
import { writeAudit } from '../audit/audit.service.ts';
import { FamilyPlanModel, type FamilyPlanDoc } from '../family-plans/family-plan.model.ts';
import { buildCensusTemplate } from './census-workbook.ts';
import { gpaRequirementsOf, gtliRequirementsOf } from './eb-census-context.ts';
import { buildEbCensusTemplate, type TemplatePlan } from './eb-census-template.ts';
import { GhiCaseModel, type GhiCaseDoc } from './ghi-case.model.ts';
import { auditCase, type Actor } from './ghi-common.ts';
import { productFilter, scopeOf } from './products/profile.ts';

// The census template download (Requirement 19.3, 19.8, 19.9): a product and an active plan of
// it in the version in effect today, or a case's plan copy and Data Sheet basis. A GMC case with
// no plan gets the template GHI built before, unchanged and without plan metadata.

const refuse = (path: string, message: string) =>
  validationError([{ location: 'query', path, message }], message);

export async function censusTemplateFile(
  query: EbCensusTemplateQuery,
  actor: Actor,
): Promise<{ fileName: string; contentType: string; data: Buffer }> {
  const product = query.product;
  let doc: GhiCaseDoc | null = null;
  if (query.caseId) {
    doc = await GhiCaseModel.findOne({
      _id: new Types.ObjectId(query.caseId),
      ...productFilter(product),
    }).lean<GhiCaseDoc>();
    if (!doc) throw refuse('caseId', `No ${product} case has this id`);
  }

  if (doc && !doc.planAssignment) {
    if (product !== 'GMC') {
      throw conflict(
        ERROR_CODES.EB_PLAN_REQUIRED,
        'Assign a family plan to the case before downloading its template.',
      );
    }
    // GMC without a plan: the template GHI has always built (19.8).
    const data = await buildCensusTemplate();
    await auditCase(
      actor,
      AUDIT_ACTIONS.EB_CENSUS_TEMPLATE_DOWNLOADED,
      doc._id.toHexString(),
      null,
      { product, template: 'GHI census (no plan)', format: 'xlsx' },
    );
    return { fileName: 'GHI-Census-Template.xlsx', contentType: XLSX_CONTENT_TYPE, data };
  }

  let planDoc: FamilyPlanDoc | null;
  let plan: TemplatePlan;
  if (doc?.planAssignment) {
    const assignment = doc.planAssignment;
    if (query.planId && query.planId !== assignment.planId.toHexString()) {
      throw refuse(
        'planId',
        `The case uses ${assignment.name}; download its template, or leave the case out`,
      );
    }
    planDoc = await FamilyPlanModel.findById(assignment.planId).lean<FamilyPlanDoc>();
    const version = planDoc?.versions.find((item) => item.number === assignment.versionNumber);
    plan = {
      code: assignment.code,
      name: assignment.name,
      versionNumber: assignment.versionNumber,
      slots: assignment.slots,
      parentsAndInLawsMixed: assignment.parentsAndInLawsMixed,
      clientConfirmed: version?.clientConfirmed ?? false,
      openQuestions: assignment.openQuestions,
    };
  } else {
    if (!query.planId) throw refuse('planId', 'Choose the family plan');
    planDoc = await FamilyPlanModel.findById(query.planId).lean<FamilyPlanDoc>();
    if (!planDoc) throw refuse('planId', 'Choose a family plan from the Family Plan Master');
    if (planDoc.product !== product) {
      throw refuse(
        'planId',
        `"${planDoc.name}" is a ${planDoc.product} plan; choose a ${product} plan`,
      );
    }
    if (!planDoc.active) throw refuse('planId', `"${planDoc.name}" is inactive`);
    const today = istDay(new Date());
    const version = versionOn(planDoc, today);
    if (!version) throw refuse('planId', `"${planDoc.name}" has no Active version in effect today`);
    plan = {
      code: planDoc.code,
      name: planDoc.name,
      versionNumber: version.number,
      slots: version.slots,
      parentsAndInLawsMixed: version.parentsAndInLawsMixed,
      clientConfirmed: version.clientConfirmed,
      openQuestions: planDoc.openQuestions,
    };
  }

  const basis =
    product === 'GMC' || !doc
      ? 'UNKNOWN'
      : ((product === 'GPA' ? gpaRequirementsOf(doc) : gtliRequirementsOf(doc)).sumInsuredBasis ??
        'UNKNOWN');
  const ownAmount = Boolean(
    doc && product === 'GPA' && dependantsGiveOwnAmount(gpaRequirementsOf(doc).dependantBasis),
  );
  // A template for a plan alone follows what a new case starts with (open question NM-1).
  const nominees =
    product === 'GMC'
      ? undefined
      : doc
        ? nomineeRequirementOf(product === 'GPA' ? gpaRequirementsOf(doc) : gtliRequirementsOf(doc))
        : DEFAULT_NOMINEE_REQUIREMENT;
  const columns = templateColumns(product, plan.slots, basis, {
    dependantsOwnAmount: ownAmount,
    nominees,
  });
  const templateName = templateNameOf({ product, code: plan.code });
  const file = await buildEbCensusTemplate({
    product,
    templateName,
    plan,
    columns,
    caseReference: doc?.reference ?? null,
  });
  const after = {
    product,
    plan: plan.code,
    planVersion: plan.versionNumber,
    template: templateName,
    columns: columns.map((column) => column.key),
    format: 'xlsx',
  };
  if (doc) {
    await auditCase(
      actor,
      AUDIT_ACTIONS.EB_CENSUS_TEMPLATE_DOWNLOADED,
      doc._id.toHexString(),
      null,
      after,
      undefined,
      scopeOf(product),
    );
  } else {
    await writeAudit({
      userId: actor.id,
      action: AUDIT_ACTIONS.EB_CENSUS_TEMPLATE_DOWNLOADED,
      entity: AUDIT_ENTITIES.FAMILY_PLAN,
      entityId: planDoc?._id.toHexString() ?? null,
      before: null,
      after,
      requestId: actor.requestId,
    });
  }
  return { fileName: file.fileName, contentType: XLSX_CONTENT_TYPE, data: file.data };
}
