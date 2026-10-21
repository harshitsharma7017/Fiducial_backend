import {
  EbCaseRecordSchema,
  EbCensusImportSchema,
  EbPaymentsResponseSchema,
  EbPlacementStateSchema,
  EbQcrListResponseSchema,
  EbQuoteListResponseSchema,
  GhiRfqStateSchema,
} from '../src/shared/index.ts';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLogModel } from '../src/modules/audit/audit.model.ts';
import { FamilyPlanModel } from '../src/modules/family-plans/family-plan.model.ts';
import {
  EbPolicySnapshotMemberModel,
  EbPolicySnapshotModel,
} from '../src/modules/ghi/eb-placement.model.ts';
import { GhiCaseModel } from '../src/modules/ghi/ghi-case.model.ts';
import { bearer, createTestApp, useTestDatabase } from './helpers/app.ts';
import {
  binary,
  createEbCase,
  ebPath,
  fillTemplate,
  gpaSheet,
  gpaTerms,
  gtliSheet,
  readWorkbook,
  setUpWorld,
  uploadCaseFile,
  uploadCensus,
  type EbWorld,
} from './helpers/eb.ts';
import { FakeTransport } from './helpers/mail.ts';

// A GPA case end to end (Requirements 3 to 11): plan, Data Sheet, census from the provisional
// template, RFQ approved and sent (which locks the case), quotes, QCR approved by fingerprint,
// the client's decision with the agreed premium, payment, and the placement slip that places
// the case with its snapshot. Then a GTLI case through its Data Sheet and census.

useTestDatabase();
const transport = new FakeTransport();
const app = createTestApp({}, undefined, transport);
let world: EbWorld;
let caseId: string;
const c = (rest = '') => ebPath('GPA', caseId, rest);

const stageOf = async () => (await GhiCaseModel.findById(caseId).lean())?.stage;

beforeAll(async () => {
  world = await setUpWorld(app);
});

describe('GPA case from creation to placement', () => {
  it('is created with its own reference and no plan when the company has no default', async () => {
    const created = await createEbCase(app, world.manager, 'GPA', world.clientId);
    caseId = created.id;
    expect(created.reference).toMatch(/^GPA-\d{4}-0001$/);
    const record = EbCaseRecordSchema.parse(
      (await request(app).get(c()).set(bearer(world.readOnly)).expect(200)).body,
    );
    expect(record).toMatchObject({ product: 'GPA', stage: 'CREATED', plan: null, placed: false });
    expect(record.nextStep).toBe('Next: fill and save the Data Sheet.');
  });

  it('refuses a census upload until a plan is assigned', async () => {
    const response = await uploadCensus(
      app,
      world.manager,
      c(),
      Buffer.from('PK\u0003\u0004'),
    ).expect(409);
    expect(response.body.code).toBe('EB_PLAN_REQUIRED');
  });

  it('assigns GPA 1+3 and saves the Data Sheet, reaching Data Sheet', async () => {
    const plan = (await FamilyPlanModel.findOne({ product: 'GPA', code: '1+3' }).lean())!;
    const gmcPlan = (await FamilyPlanModel.findOne({ product: 'GMC', code: '1+3' }).lean())!;
    await request(app)
      .put(c('/plan'))
      .set(bearer(world.manager))
      .send({ planId: gmcPlan._id.toHexString() })
      .expect(400);
    const assigned = await request(app)
      .put(c('/plan'))
      .set(bearer(world.manager))
      .send({ planId: plan._id.toHexString() })
      .expect(200);
    expect(assigned.body.plan).toMatchObject({
      code: '1+3',
      versionNumber: 1,
      clientConfirmed: false,
      source: 'USER',
    });
    const saved = await request(app)
      .put(c('/requirements'))
      .set(bearer(world.manager))
      .send(gpaSheet())
      .expect(200);
    expect(saved.body).toMatchObject({
      stage: 'DATA_SHEET',
      missingItems: [{ field: 'dependantBasis' }],
    });
    const complete = await request(app)
      .put(c('/requirements'))
      .set(bearer(world.manager))
      .send(gpaSheet({ dependantBasis: { kind: 'EMPLOYEE_SUM_INSURED' } }))
      .expect(200);
    expect(complete.body.missingItems).toEqual([]);
    const foreign = await request(app)
      .put(c('/requirements'))
      .set(bearer(world.manager))
      .send({ ...gpaSheet(), maternity: { covered: true } })
      .expect(400);
    expect(foreign.body.code).toBe('VALIDATION_ERROR');
  });

  it('imports the census from the case’s provisional template, creating identities', async () => {
    const template = await binary(
      request(app)
        .get(`/api/v1/eb/census-templates?product=GPA&caseId=${caseId}`)
        .set(bearer(world.readOnly)),
    ).expect(200);
    expect(template.headers['content-disposition']).toContain('Provisional-GPA-1+3-v1.xlsx');
    const workbook = await readWorkbook(template.body as Buffer);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      'Instructions',
      'Census',
      '_fiducial',
    ]);
    const filled = await fillTemplate(template.body as Buffer, [
      ['E1', 'Ravi Kumar', 'Male', '01/02/1985', 'Self', '01/04/2015', 500000],
      ['E1', 'Meena Kumar', 'Female', '05/06/1988', 'Spouse', null, null],
      ['E1', 'Anu Kumar', 'Female', '10/10/2015', 'Child', null, null],
      ['E2', 'Sita Rao', 'Female', '12/12/1990', 'Self', '01/01/2020', 500000],
      ['E3', 'John Dsouza', 'Male', '03/04/1990', 'Self', null, 500000],
    ]);
    const preview = EbCensusImportSchema.parse(
      (await uploadCensus(app, world.manager, c(), filled).expect(201)).body,
    );
    expect(preview.fileWarnings).toEqual([]);
    expect(preview.marker).toEqual({ product: 'GPA', planCode: '1+3', planVersion: 1 });
    expect(preview.counts).toMatchObject({ rows: 5, valid: 5, invalid: 0 });
    expect(preview.rows.find((row) => row.values.employeeId === 'E3')?.values.dateOfBirth).toBe(
      '03/04/1990',
    );
    const commit = await request(app)
      .post(c(`/census/imports/${preview.id}/commit`))
      .set(bearer(world.manager))
      .send({ policy: 'ALL_VALID' })
      .expect(200);
    expect(commit.body.result).toMatchObject({
      added: 5,
      updated: 0,
      unchanged: 0,
      skipped: 0,
      identitiesCreated: 3,
      identitiesReused: 0,
    });
    const members = (
      await request(app).get(c('/members?q=E3')).set(bearer(world.readOnly)).expect(200)
    ).body;
    // 03/04/1990 is read day first: 3 April 1990 (Requirement 20.6).
    expect(members.items[0]).toMatchObject({
      dateOfBirth: '1990-04-03',
      coveredSumInsured: '500000',
    });
  });

  it('generates, approves and sends the RFQ, which locks the case', async () => {
    await request(app)
      .put(c('/insurers'))
      .set(bearer(world.manager))
      .send({ insurerIds: world.insurers })
      .expect(200);
    const generated = GhiRfqStateSchema.parse(
      (await request(app).post(c('/rfq/generate')).set(bearer(world.manager)).expect(201)).body,
    );
    expect(generated.current).toMatchObject({ version: 1, status: 'DRAFT', stale: false });
    expect(await stageOf()).toBe('RFQ');
    await request(app).post(c('/rfq/submit')).set(bearer(world.manager)).expect(200);
    await request(app)
      .post(c('/rfq/decision'))
      .set(bearer(world.manager))
      .send({ decision: 'APPROVED', comment: null })
      .expect(403);
    await request(app)
      .post(c('/rfq/decision'))
      .set(bearer(world.approver))
      .send({ decision: 'APPROVED', comment: null })
      .expect(200);
    const document = await binary(
      request(app).get(c('/rfq/document?format=xlsx')).set(bearer(world.exec)),
    ).expect(200);
    const rfq = await readWorkbook(document.body as Buffer);
    expect(rfq.worksheets[0]?.name).toBe('GPA Data Sheet');
    const emailed = await request(app)
      .post(c('/rfq/email'))
      .set(bearer(world.exec))
      .send({
        sendId: crypto.randomUUID(),
        insurerIds: [world.insurers[0]],
        dueDate: '2026-11-20',
        format: 'pdf',
      })
      .expect(200);
    expect(emailed.body.results[0]).toMatchObject({ outcome: 'SENT' });
    expect(emailed.body.case.locked).toBe(true);
    await request(app)
      .post(c('/rfq/sent'))
      .set(bearer(world.exec))
      .send({ insurerIds: [world.insurers[1], world.insurers[2]], dueDate: '2026-11-20' })
      .expect(200);
    const locked = await request(app)
      .put(c('/requirements'))
      .set(bearer(world.manager))
      .send(gpaSheet())
      .expect(409);
    expect(locked.body.code).toBe('GHI_LOCKED');
    const plan = (await FamilyPlanModel.findOne({ product: 'GPA', code: 'SELF' }).lean())!;
    await request(app)
      .put(c('/plan'))
      .set(bearer(world.manager))
      .send({ planId: plan._id.toHexString() })
      .expect(409);
    await request(app)
      .post(c('/members'))
      .set(bearer(world.manager))
      .send({
        employeeId: 'E9',
        name: 'Late Joiner',
        gender: 'MALE',
        dateOfBirth: '1990-01-01',
        relationship: 'SELF',
        dateOfJoining: '',
        sumInsured: '500000',
      })
      .expect(409);
  });

  it('records quotes with GST from the API, deviations, versions and a decline', async () => {
    const fileId = await uploadCaseFile(app, world.manager, c(), 'QUOTE');
    const noFile = await request(app)
      .post(c('/quotes'))
      .set(bearer(world.manager))
      .send({
        insurerId: world.insurers[0],
        basePremium: '1000.05',
        statedRate: '0.5 per mille',
        terms: gpaTerms(),
        otherTerms: null,
        validUntil: null,
        reason: null,
        attachmentIds: [],
        finalize: true,
      })
      .expect(400);
    expect(noFile.body.details[0].path).toBe('attachmentIds');
    const first = await request(app)
      .post(c('/quotes'))
      .set(bearer(world.manager))
      .send({
        insurerId: world.insurers[0],
        basePremium: '1000.05',
        statedRate: '0.5 per mille',
        terms: gpaTerms(),
        otherTerms: null,
        validUntil: null,
        reason: null,
        attachmentIds: [fileId],
        finalize: true,
      })
      .expect(201);
    expect(first.body).toMatchObject({
      basePremium: '1000.05',
      gst: '180.01',
      totalPremium: '1180.06',
      statedRate: '0.5 per mille',
      status: 'FINAL',
    });
    expect(first.body.deviations).toEqual([]);
    expect(await stageOf()).toBe('QCR');
    const terms = gpaTerms();
    terms.covers.permanentTotal = { offer: 'NOT_OFFERED', limitAmount: null, limitText: null };
    const second = await request(app)
      .post(c('/quotes'))
      .set(bearer(world.manager))
      .send({
        insurerId: world.insurers[1],
        basePremium: '950',
        statedRate: null,
        terms,
        otherTerms: null,
        validUntil: null,
        reason: null,
        attachmentIds: [fileId],
        finalize: true,
      })
      .expect(201);
    expect(second.body.deviations).toEqual([
      expect.objectContaining({ field: 'covers.permanentTotal', kind: 'DEVIATION' }),
    ]);
    await request(app)
      .post(c('/quotes'))
      .set(bearer(world.manager))
      .send({
        insurerId: world.insurers[1],
        basePremium: '960',
        statedRate: null,
        terms,
        otherTerms: null,
        validUntil: null,
        reason: null,
        attachmentIds: [fileId],
        finalize: true,
      })
      .expect(400);
    const revised = await request(app)
      .post(c('/quotes'))
      .set(bearer(world.manager))
      .send({
        insurerId: world.insurers[1],
        basePremium: '1100',
        statedRate: null,
        terms: gpaTerms(),
        otherTerms: null,
        validUntil: null,
        reason: 'Revised after negotiation',
        attachmentIds: [fileId],
        finalize: true,
      })
      .expect(201);
    expect(revised.body.version).toBe(2);
    await request(app)
      .put(c(`/quotes/${second.body.id as string}`))
      .set(bearer(world.manager))
      .send({
        basePremium: '1',
        statedRate: null,
        terms,
        otherTerms: null,
        validUntil: null,
        reason: null,
        attachmentIds: [fileId],
        finalize: false,
      })
      .expect(409);
    await request(app)
      .post(c(`/insurers/${world.insurers[2]}/decline`))
      .set(bearer(world.manager))
      .send({ reason: 'Not writing this occupation' })
      .expect(200);
    const quotes = EbQuoteListResponseSchema.parse(
      (await request(app).get(c('/quotes')).set(bearer(world.readOnly)).expect(200)).body,
    );
    expect(quotes.items.filter((quote) => quote.latest)).toHaveLength(2);
  });

  let qcrId: string;
  let fingerprint: string;

  it('prepares the QCR from each insurer’s latest recorded quote and approves it by fingerprint', async () => {
    const created = await request(app)
      .post(c('/qcrs'))
      .set(bearer(world.manager))
      .send({ recommendedInsurerId: world.insurers[0], remarks: 'Lowest with all covers' })
      .expect(201);
    qcrId = created.body.id as string;
    expect(
      created.body.columns.map((column: { quoteVersion: number }) => column.quoteVersion),
    ).toEqual([1, 2]);
    // 1,180.06 against 1,298.00 (the revised 1,100 + 18% GST): the first is lowest.
    expect(created.body.columns.map((column: { lowest: boolean }) => column.lowest)).toEqual([
      true,
      false,
    ]);
    await request(app)
      .post(c(`/qcrs/${qcrId}/submit`))
      .set(bearer(world.manager))
      .expect(200);
    expect(await stageOf()).toBe('APPROVAL');
    const list = EbQcrListResponseSchema.parse(
      (await request(app).get(c('/qcrs')).set(bearer(world.approver)).expect(200)).body,
    );
    fingerprint = list.items[0]!.fingerprint;
    const stale = await request(app)
      .post(c(`/qcrs/${qcrId}/decision`))
      .set(bearer(world.approver))
      .send({ decision: 'APPROVED', comment: null, fingerprint: 'a'.repeat(64) })
      .expect(409);
    expect(stale.body.code).toBe('QCR_CHANGED');
    await request(app)
      .post(c(`/qcrs/${qcrId}/decision`))
      .set(bearer(world.approver))
      .send({ decision: 'APPROVED', comment: null, fingerprint })
      .expect(200);
    const mailed = await request(app)
      .post(c(`/qcrs/${qcrId}/email`))
      .set(bearer(world.exec))
      .send({ sendId: crypto.randomUUID(), to: ['someone@else.example'], format: 'pdf' })
      .expect(400);
    expect(mailed.body.details[0].path).toBe('to');
  });

  it('refuses a payment before the client’s decision, then records the acceptance with the agreed premium', async () => {
    const proof = await uploadCaseFile(app, world.manager, c(), 'PAYMENT');
    const early = await request(app)
      .post(c('/payments'))
      .set(bearer(world.manager))
      .send({
        amount: '1180.06',
        paidOn: '2026-10-01',
        reference: 'UTR1',
        mode: 'NEFT',
        status: 'RECEIVED',
        payer: null,
        note: null,
        fileIds: [proof],
      })
      .expect(409);
    expect(early.body.code).toBe('EB_STAGE');
    const decisionFile = await uploadCaseFile(app, world.manager, c(), 'CLIENT_DECISION');
    const accepted = await request(app)
      .post(c(`/qcrs/${qcrId}/client-decision`))
      .set(bearer(world.manager))
      .send({
        decision: 'ACCEPTED',
        insurerId: world.insurers[0],
        decidedOn: '2026-10-10',
        confirmedBy: 'Ravi HR',
        note: null,
        fileIds: [decisionFile],
        fingerprint,
      })
      .expect(200);
    expect(accepted.body.clientDecision).toMatchObject({
      decision: 'ACCEPTED',
      agreedPremium: '1180.06',
      quoteVersion: 1,
    });
    expect(await stageOf()).toBe('PAYMENT');
    const rejectAtPayment = await request(app)
      .post(c(`/qcrs/${qcrId}/client-decision`))
      .set(bearer(world.manager))
      .send({
        decision: 'REJECTED',
        decidedOn: '2026-10-10',
        confirmedBy: 'Ravi HR',
        reason: 'Changed mind',
        fileIds: [],
        fingerprint,
      })
      .expect(409);
    expect(rejectAtPayment.body.code).toBe('EB_STAGE');
  });

  it('moves to Placement Slip once RECEIVED payments cover the agreed premium; failed ones never count', async () => {
    const proof = await uploadCaseFile(app, world.manager, c(), 'PAYMENT');
    const failed = EbPaymentsResponseSchema.parse(
      (
        await request(app)
          .post(c('/payments'))
          .set(bearer(world.manager))
          .send({
            amount: '1180.06',
            paidOn: '2026-10-11',
            reference: 'CHQ1',
            mode: 'CHEQUE',
            status: 'FAILED',
            payer: null,
            note: 'Bounced',
            fileIds: [proof],
          })
          .expect(201)
      ).body,
    );
    expect(failed).toMatchObject({
      agreedPremium: '1180.06',
      received: '0.00',
      outstanding: '1180.06',
      covered: false,
    });
    expect(await stageOf()).toBe('PAYMENT');
    const future = await request(app)
      .post(c('/payments'))
      .set(bearer(world.manager))
      .send({
        amount: '1180.06',
        paidOn: '2099-01-01',
        reference: 'UTR2',
        mode: 'NEFT',
        status: 'RECEIVED',
        payer: null,
        note: null,
        fileIds: [],
      })
      .expect(400);
    expect(future.body.details[0].path).toBe('paidOn');
    const paid = await request(app)
      .post(c('/payments'))
      .set(bearer(world.manager))
      .send({
        amount: '1180.06',
        paidOn: '2026-10-12',
        reference: 'UTR2',
        mode: 'NEFT',
        status: 'RECEIVED',
        payer: null,
        note: null,
        fileIds: [],
      })
      .expect(201);
    expect(paid.body).toMatchObject({ received: '1180.06', outstanding: '0.00', covered: true });
    expect(await stageOf()).toBe('PLACEMENT_SLIP');
    const decisionChange = await request(app)
      .post(c(`/qcrs/${qcrId}/client-decision`))
      .set(bearer(world.manager))
      .send({
        decision: 'ACCEPTED',
        insurerId: world.insurers[1],
        decidedOn: '2026-10-10',
        confirmedBy: 'Ravi HR',
        note: null,
        fileIds: [await uploadCaseFile(app, world.manager, c(), 'CLIENT_DECISION')],
        fingerprint,
      })
      .expect(409);
    expect(decisionChange.body.code).toBe('EB_STAGE');
  });

  it('issues the placement slip: placed with a frozen snapshot, then nothing changes', async () => {
    const state = EbPlacementStateSchema.parse(
      (await request(app).get(c('/placement')).set(bearer(world.readOnly)).expect(200)).body,
    );
    expect(state).toMatchObject({
      ready: true,
      placed: false,
      agreedPremium: '1180.06',
      quoteVersion: 1,
    });
    const slip = await binary(
      request(app).get(c('/placement-slip?format=xlsx')).set(bearer(world.exec)),
    ).expect(200);
    expect((await readWorkbook(slip.body as Buffer)).worksheets[0]?.name).toBe('Placement Slip');
    await request(app)
      .post(c('/placement'))
      .set(bearer(world.manager))
      .send({ policyNumber: 'x'.repeat(51), policyStart: null, policyEnd: null })
      .expect(400);
    await request(app)
      .post(c('/placement'))
      .set(bearer(world.manager))
      .send({ policyNumber: null, policyStart: '2026-12-01', policyEnd: '2026-11-01' })
      .expect(400);
    const placed = await request(app)
      .post(c('/placement'))
      .set(bearer(world.manager))
      .send({ policyNumber: 'GPA/123', policyStart: '2026-12-01', policyEnd: '2027-11-30' })
      .expect(200);
    expect(placed.body).toMatchObject({
      placed: true,
      nextStep: null,
      placement: { policyNumber: 'GPA/123' },
    });
    const snapshot = await EbPolicySnapshotModel.findOne({ caseId }).lean();
    expect(snapshot).toMatchObject({
      product: 'GPA',
      quoteVersion: 1,
      census: { employees: 3, lives: 5 },
    });
    expect(await EbPolicySnapshotMemberModel.countDocuments({ caseId })).toBe(5);
    // N4 to N6: the rules the cover followed and the age bands are frozen with the placement.
    expect(snapshot).toMatchObject({
      requirements: { sumInsuredBasis: { kind: 'FLAT', amount: '500000' } },
      ageBands: { name: 'Standard (0–18 to 66+)', setId: null },
    });
    const placedMembers = await EbPolicySnapshotMemberModel.find({ caseId }).lean();
    expect(placedMembers.every((member) => typeof member.coverageBasis === 'string')).toBe(true);
    const again = await request(app)
      .post(c('/placement'))
      .set(bearer(world.manager))
      .send({ policyNumber: null, policyStart: null, policyEnd: null })
      .expect(409);
    expect(again.body.code).toBe('EB_PLACED');
    await request(app)
      .post(c('/close'))
      .set(bearer(world.manager))
      .send({ reason: 'Lost' })
      .expect(409);
    await request(app)
      .post(c('/payments'))
      .set(bearer(world.manager))
      .send({
        amount: '1',
        paidOn: '2026-10-12',
        reference: 'X',
        mode: 'NEFT',
        status: 'PENDING',
        payer: null,
        note: null,
        fileIds: [],
      })
      .expect(409);
    const after = (await request(app).get(c('/placement')).set(bearer(world.readOnly)).expect(200))
      .body;
    expect(after).toMatchObject({
      placed: true,
      policyNumber: 'GPA/123',
      agreedPremium: '1180.06',
    });
    const audits = new Set(
      (await AuditLogModel.find({ entity: 'eb_case', entityId: caseId }).lean()).map(
        (entry) => entry.action,
      ),
    );
    for (const action of [
      'EB_CASE_CREATED',
      'EB_PLAN_ASSIGNED',
      'EB_REQUIREMENTS_SAVED',
      'EB_CENSUS_IMPORTED',
      'EB_RFQ_GENERATED',
      'EB_RFQ_APPROVED',
      'EB_RFQ_EMAILED',
      'EB_QUOTE_FINALIZED',
      'EB_QCR_APPROVED',
      'EB_CLIENT_DECISION_RECORDED',
      'EB_PAYMENT_RECORDED',
      'EB_PLACEMENT_ISSUED',
      'EB_CENSUS_TEMPLATE_DOWNLOADED',
    ]) {
      expect(audits).toContain(action);
    }
  });

  it('never offers a GPA case to claims, and a GMC route does not open it', async () => {
    const policies = await request(app)
      .get(`/api/v1/claims/policies?clientId=${world.clientId}`)
      .set(bearer(world.admin))
      .expect(200);
    expect(policies.body.items).toEqual([]);
    const missing = await request(app)
      .get(`/api/v1/ghi/cases/${caseId}`)
      .set(bearer(world.readOnly))
      .expect(404);
    const none = await request(app)
      .get('/api/v1/ghi/cases/0123456789abcdef01234567')
      .set(bearer(world.readOnly))
      .expect(404);
    expect(missing.body).toEqual(none.body);
  });
});

describe('GTLI case: the default plan, a salary-multiple census and the free cover limit', () => {
  let gtliId: string;
  const g = (rest = '') => ebPath('GTLI', gtliId, rest);

  it('gets GTLI Self only when the company has no default (Requirement 5.2)', async () => {
    const created = await createEbCase(app, world.manager, 'GTLI', world.clientId);
    gtliId = created.id;
    expect(created.reference).toMatch(/^GTLI-\d{4}-0001$/);
    const record = (await request(app).get(g()).set(bearer(world.readOnly)).expect(200)).body;
    expect(record.plan).toMatchObject({
      code: 'SELF',
      source: 'GTLI_DEFAULT',
      openQuestions: [6, 16],
    });
  });

  it('downloads a template with Annual Salary only, imports it and flags members above the free cover limit', async () => {
    await request(app)
      .put(g('/requirements'))
      .set(bearer(world.manager))
      .send(gtliSheet())
      .expect(200);
    const template = await binary(
      request(app)
        .get(`/api/v1/eb/census-templates?product=GTLI&caseId=${gtliId}`)
        .set(bearer(world.readOnly)),
    ).expect(200);
    const workbook = await readWorkbook(template.body as Buffer);
    const headers = (workbook.getWorksheet('Census')!.getRow(1).values as unknown[]).filter(
      Boolean,
    );
    expect(headers).toEqual([
      'Employee ID *',
      'Name *',
      'Gender *',
      'Date of Birth *',
      'Date of Joining',
      'Annual Salary *',
    ]);
    const filled = await fillTemplate(template.body as Buffer, [
      ['T1', 'Asha Patil', 'Female', new Date(Date.UTC(1984, 6, 1)), null, 400000],
      ['T2', 'Vikram Shah', 'Male', '15/08/1979', null, 900000],
    ]);
    const preview = (await uploadCensus(app, world.manager, g(), filled).expect(201)).body;
    expect(preview.counts).toMatchObject({ rows: 2, valid: 2, invalid: 0, warnings: 1 });
    const t2 = preview.rows.find(
      (row: { values: { employeeId: string } }) => row.values.employeeId === 'T2',
    );
    expect(t2.issues[0]).toMatchObject({ severity: 'WARNING', code: 'ABOVE_FREE_COVER_LIMIT' });
    await request(app)
      .post(g(`/census/imports/${preview.id as string}/commit`))
      .set(bearer(world.manager))
      .send({ policy: 'ALL_VALID' })
      .expect(200);
    const summary = (
      await request(app).get(g('/census/summary')).set(bearer(world.readOnly)).expect(200)
    ).body;
    expect(summary).toMatchObject({
      employees: 2,
      freeCoverLimit: '1500000',
      aboveFreeCoverLimit: 1,
      totalSumInsured: '3900000',
    });
  });
});
