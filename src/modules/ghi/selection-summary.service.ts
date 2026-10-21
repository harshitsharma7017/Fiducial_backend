import {
  AUDIT_ACTIONS,
  ERROR_CODES,
  EB_PRODUCT_NAMES,
  GHI_CASE_TYPE_LABELS,
  GHI_COVERAGE_TYPE_LABELS,
  GHI_RELATIONSHIP_LABELS,
  NOMINEE_REQUIREMENT_LABELS,
  PDF_CONTENT_TYPE,
  RfqSelectionSummaryResponseSchema,
  XLSX_CONTENT_TYPE,
  basisText,
  buildSelectionSummary,
  dependantRuleOf,
  dependantRuleText,
  formatDate,
  formatIndianNumber,
  nomineeRequirementOf,
  planRelationships,
  selectionProblemsText,
  type RfqSelectionSummaryResponse,
  type SelectionMember,
} from '../../shared/index.ts';
import type { mongo } from 'mongoose';
import { conflict, notFound } from '../../lib/errors.ts';
import { caseBands } from '../age-bands/case-bands.ts';
import { ClientModel } from '../clients/client.model.ts';
import { effectiveSumInsured } from './census-summary.ts';
import { gpaRequirementsOf, gtliRequirementsOf } from './eb-census-context.ts';
import { coverages } from './eb-members.service.ts';
import type { GhiCaseDoc } from './ghi-case.model.ts';
import { GhiMemberModel } from './ghi-census.model.ts';
import { auditCase, loadCase, referenceDateOf, type Actor } from './ghi-common.ts';
import { GhiRfqModel } from './ghi-workflow.model.ts';
import { productOf, type CaseScope } from './products/profile.ts';
import { selectionSummaryDocument } from './selection-summary-document.ts';
import { toPdf, toXlsx } from './ghi-sheet.ts';

// The RFQ Selection Summary Sheet (N7), worked out from the census as stored, the case's age
// bands and reference date, and its product's cover rules: GMC sums insured (a floater family's
// once), GPA amounts by the relationship rules, GTLI sums assured from salary. An RFQ version
// keeps the summary it was generated with; this service never recalculates a stored one.

const rupees = (value: string) => `₹${formatIndianNumber(value, 0)}`;

function periodText(doc: Pick<GhiCaseDoc, 'policyStart' | 'policyEnd'>): string {
  if (!doc.policyStart) return 'Not fixed yet';
  return `${formatDate(doc.policyStart)} to ${doc.policyEnd ? formatDate(doc.policyEnd) : '1 year'}`;
}

/** The cover rules the amounts follow, by product (N7 D). */
function rulesOf(doc: GhiCaseDoc): Array<{ label: string; value: string }> {
  const product = productOf(doc);
  if (product === 'GMC') {
    const requirements = doc.requirements;
    return [
      {
        label: 'Coverage type',
        value: requirements.coverageType
          ? GHI_COVERAGE_TYPE_LABELS[requirements.coverageType]
          : 'Not stated',
      },
      {
        label: 'Sums insured on offer',
        value:
          requirements.sumInsuredOptions.length > 0
            ? requirements.sumInsuredOptions.map(rupees).join(', ')
            : 'Not stated',
      },
    ];
  }
  if (product === 'GPA') {
    const sheet = gpaRequirementsOf(doc);
    const relationships = doc.planAssignment
      ? planRelationships(doc.planAssignment.slots).filter((item) => item !== 'SELF')
      : [];
    return [
      { label: 'Employee’s sum insured', value: basisText(sheet.sumInsuredBasis) },
      ...relationships.map((relationship) => ({
        label: `${GHI_RELATIONSHIP_LABELS[relationship]}’s sum insured`,
        value: dependantRuleText(dependantRuleOf(sheet.dependantBasis, relationship)),
      })),
      { label: 'Nominees', value: NOMINEE_REQUIREMENT_LABELS[nomineeRequirementOf(sheet)] },
    ];
  }
  const sheet = gtliRequirementsOf(doc);
  return [
    { label: 'Sum assured', value: basisText(sheet.sumInsuredBasis) },
    {
      label: 'Free cover limit',
      value: sheet.freeCoverLimit === null ? 'Not asked' : rupees(sheet.freeCoverLimit),
    },
    { label: 'Nominees', value: NOMINEE_REQUIREMENT_LABELS[nomineeRequirementOf(sheet)] },
  ];
}

/** Each member with the amount that covers them, by product (never mixing the measures). */
async function selectionMembers(
  doc: GhiCaseDoc,
  session?: mongo.ClientSession,
): Promise<{ members: SelectionMember[]; floater: boolean }> {
  const stored = await GhiMemberModel.find({ caseId: doc._id })
    .sort({ employeeKey: 1, _id: 1 })
    .session(session ?? null)
    .lean();
  if (productOf(doc) === 'GMC') {
    const coverageType = doc.requirements.coverageType;
    const families = new Map<string, string | null>();
    for (const member of stored) {
      if (member.relationship === 'SELF') {
        families.set(member.employeeKey, member.sumInsured?.toString() ?? null);
      }
    }
    return {
      floater: coverageType === 'FLOATER',
      members: stored.map((member) => ({
        employeeKey: member.employeeKey,
        relationship: member.relationship,
        gender: member.gender,
        dateOfBirth: member.dateOfBirth,
        cover: effectiveSumInsured(
          {
            employeeKey: member.employeeKey,
            relationship: member.relationship,
            dateOfBirth: member.dateOfBirth,
            sumInsured: member.sumInsured?.toString() ?? null,
          },
          families,
          coverageType,
        ),
      })),
    };
  }
  const covered = await coverages(doc, stored, session);
  return {
    floater: false,
    members: stored.map((member) => ({
      employeeKey: member.employeeKey,
      relationship: member.relationship,
      gender: member.gender,
      dateOfBirth: member.dateOfBirth,
      cover: covered.get(member._id.toHexString())?.amount ?? null,
    })),
  };
}

/** The summary as the census and the case's configuration are now. */
export async function currentSelectionSummary(
  doc: GhiCaseDoc,
  session?: mongo.ClientSession,
): Promise<RfqSelectionSummaryResponse> {
  const product = productOf(doc);
  const bands = caseBands(doc);
  const referenceDate = referenceDateOf(doc);
  const [{ members, floater }, client] = await Promise.all([
    selectionMembers(doc, session),
    ClientModel.findById(doc.clientId, { name: 1 })
      .session(session ?? null)
      .lean(),
  ]);
  const plan = doc.planAssignment;
  return {
    header: {
      company: client?.name ?? 'Company',
      reference: doc.reference,
      product,
      productName: EB_PRODUCT_NAMES[product],
      caseType: GHI_CASE_TYPE_LABELS[doc.type],
      policyPeriod: periodText(doc),
      referenceDate,
      generatedAt: new Date().toISOString(),
      ageBands: { name: bands.name, revision: bands.revision },
      plan: plan ? `${plan.name} (code ${plan.code}), version ${plan.versionNumber}` : null,
      rules: rulesOf(doc),
      censusRevision: doc.censusRevision,
    },
    summary: buildSelectionSummary({
      product,
      floater,
      bands: bands.bands,
      referenceDate,
      members,
    }),
    source: 'CURRENT',
    rfqVersion: null,
  };
}

/** The summary for the case's screen (problems listed, never refused). */
export async function caseSelectionSummary(
  scope: CaseScope,
  id: string,
): Promise<RfqSelectionSummaryResponse> {
  const doc = await loadCase(id, undefined, scope);
  return currentSelectionSummary(doc);
}

/** The summary an RFQ version was generated with, as stored (N7: never recalculated). */
export async function rfqVersionSelectionSummary(
  scope: CaseScope,
  id: string,
  rfqId: string,
): Promise<RfqSelectionSummaryResponse> {
  const doc = await loadCase(id, undefined, scope);
  const rfq = await GhiRfqModel.findOne({ _id: rfqId, caseId: doc._id }).lean();
  if (!rfq) throw notFound('RFQ version not found');
  if (!rfq.selectionSummary) {
    throw notFound(`RFQ v${rfq.version} was generated before the selection summary existed.`);
  }
  return RfqSelectionSummaryResponseSchema.parse(rfq.selectionSummary);
}

/**
 * The summary as Excel or A4 PDF (N7 E). Refused while the summary is incomplete (members
 * without cover, without a valid date of birth or outside the bands), so no misleading totals
 * are handed out.
 */
export async function selectionSummaryFile(
  scope: CaseScope,
  id: string,
  format: 'xlsx' | 'pdf',
  actor: Actor,
  letterhead: Parameters<typeof toPdf>[1],
) {
  const doc = await loadCase(id, undefined, scope);
  const response = await currentSelectionSummary(doc);
  if (response.summary.problems.length > 0) {
    throw conflict(
      ERROR_CODES.EB_SUMMARY_INCOMPLETE,
      `The selection summary is not complete: ${selectionProblemsText(response.summary)}`,
      { problems: response.summary.problems },
    );
  }
  const model = selectionSummaryDocument(response);
  const file =
    format === 'pdf'
      ? {
          fileName: `${model.fileBase}.pdf`,
          contentType: PDF_CONTENT_TYPE,
          data: await toPdf(model, letterhead),
        }
      : {
          fileName: `${model.fileBase}.xlsx`,
          contentType: XLSX_CONTENT_TYPE,
          data: await toXlsx(model),
        };
  await auditCase(
    actor,
    AUDIT_ACTIONS.GHI_SELECTION_SUMMARY_DOWNLOADED,
    id,
    null,
    {
      format,
      employees: response.summary.coverage.employees,
      lives: response.summary.coverage.lives,
      total: response.summary.coverage.total,
      ageBands: response.header.ageBands,
      censusRevision: doc.censusRevision,
    },
    undefined,
    scope,
  );
  return file;
}
