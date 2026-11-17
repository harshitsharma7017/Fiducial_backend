import {
  WC_DEFAULT_CATEGORIES,
  WC_DEFAULT_CLAUSES,
  WC_DEFAULT_CONDITIONS,
  WC_DEFAULT_COVERAGE_OPTIONS,
} from '../src/shared/index.ts';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLogModel } from '../src/modules/audit/audit.model.ts';
import { bearer, createTestApp, useTestDatabase } from './helpers/app.ts';
import { binary, readWorkbook, setUpWorld, type EbWorld } from './helpers/eb.ts';

useTestDatabase();
const app = createTestApp();
let world: EbWorld;
let caseId: string;
const c = (rest = '') => `/api/v1/wc/cases/${caseId}${rest}`;

/** The Data Sheet as the client's format fills it: two categories, three coverage options. */
const sheet = (overrides: Record<string, unknown> = {}) => ({
  policyPeriod: 'One year from the payment date',
  natureOfBusiness: 'Supply and installation of rooftop solar power plants',
  workingHeight: 'Above 9 Meter',
  riskLocation: 'Anywhere in India',
  categoryDescription: 'All types of employees including contract and sub-contract workers',
  categories: [
    { id: 'c1', designation: 'Skilled Workers', persons: 8, monthlyWage: '20000' },
    { id: 'c2', designation: 'Contract Workers', persons: 10, monthlyWage: '15000' },
  ],
  coverageOptions: [
    { id: 'o1', label: 'Without Medical Expenses' },
    { id: 'o2', label: 'With 1 Lakh Medical Expenses' },
    { id: 'o3', label: 'With 5 Lakh Medical Expenses' },
  ],
  clauses: ['Policy on Designation Basis', 'WC Act / Employers Liability Law is Covered'],
  conditions: ['Occupational Diseases not covered under this scope of coverage'],
  expiringPolicy: null,
  ...overrides,
});

const texts = async (kind: string) => {
  const response = await binary(
    request(app)
      .get(c(`/documents/${kind}?format=xlsx`))
      .set(bearer(world.manager)),
  ).expect(200);
  const workbook = await readWorkbook(response.body as Buffer);
  const rows: string[][] = [];
  workbook.worksheets[0]!.eachRow((row) => {
    const cells: string[] = [];
    row.eachCell((cell) => {
      if (cell.isMerged && cell.master !== cell) return;
      cells.push(cell.text.trim());
    });
    rows.push(cells);
  });
  return rows;
};

beforeAll(async () => {
  world = await setUpWorld(app);
});

describe('workmen compensation cases', () => {
  it('starts from the client’s format', async () => {
    await request(app)
      .post('/api/v1/wc/cases')
      .set(bearer(world.readOnly))
      .send({ clientId: world.clientId, type: 'NEW' })
      .expect(403);
    const created = await request(app)
      .post('/api/v1/wc/cases')
      .set(bearer(world.manager))
      .send({ clientId: world.clientId, type: 'NEW' })
      .expect(201);
    caseId = created.body.id as string;
    expect(created.body.reference).toMatch(/^WC-\d{4}-0001$/);
    expect(created.body.categories.map((row: { designation: string }) => row.designation)).toEqual([
      ...WC_DEFAULT_CATEGORIES,
    ]);
    expect(created.body.coverageOptions.map((row: { label: string }) => row.label)).toEqual([
      ...WC_DEFAULT_COVERAGE_OPTIONS,
    ]);
    expect(created.body.clauses).toEqual([...WC_DEFAULT_CLAUSES]);
    expect(created.body.conditions).toEqual([...WC_DEFAULT_CONDITIONS]);
    expect(created.body.natureOfBusiness).toBe('Manufacturing');
    expect(created.body.expiringPolicy).toBeNull();
    expect(created.body.missing).toEqual(['Enter the number of persons']);

    const list = await request(app).get('/api/v1/wc/cases').set(bearer(world.readOnly)).expect(200);
    expect(list.body.items).toContainEqual(
      expect.objectContaining({ id: caseId, reference: created.body.reference, ready: false }),
    );
    expect(await AuditLogModel.countDocuments({ action: 'WC_CASE_CREATED' })).toBe(1);
  });

  it('saves any number of categories, coverage options, clauses and conditions', async () => {
    const bad = await request(app)
      .put(c('/data-sheet'))
      .set(bearer(world.manager))
      .send(
        sheet({
          coverageOptions: [],
          clauses: ['Same clause', 'same clause'],
          categories: [
            { id: 'c1', designation: '', persons: 1, monthlyWage: '100' },
            { id: 'c1', designation: 'Twice', persons: 1, monthlyWage: '100' },
          ],
        }),
      )
      .expect(400);
    const problems = JSON.stringify(bad.body.details);
    expect(problems).toContain('Keep at least one coverage option');
    expect(problems).toContain('Each clause once');
    expect(problems).toContain('Each category once');
    expect(problems).toContain('Enter the category of workers');
    await request(app).put(c('/data-sheet')).set(bearer(world.readOnly)).send(sheet()).expect(403);

    const saved = await request(app)
      .put(c('/data-sheet'))
      .set(bearer(world.manager))
      .send(sheet())
      .expect(200);
    expect(saved.body.totals).toEqual({
      persons: 18,
      monthlyWages: '310000',
      annualWages: '3720000',
    });
    expect(saved.body.missing).toEqual([]);
    expect(saved.body.clauses).toEqual([
      'Policy on Designation Basis',
      'WC Act / Employers Liability Law is Covered',
    ]);
  });

  it('records each insurer’s premium per coverage option and compares them', async () => {
    const [alpha, beta, gamma] = world.insurers as [string, string, string];
    // Only insurers on the RFQ quote.
    await request(app)
      .put(c('/rfq'))
      .set(bearer(world.manager))
      .send({
        insurers: [
          { insurerId: alpha, sentOn: null },
          { insurerId: beta, sentOn: null },
        ],
      })
      .expect(200);
    const notOnRfq = await request(app)
      .put(c('/quotes'))
      .set(bearer(world.manager))
      .send({
        quotes: [{ insurerId: gamma, paymentInFavourOf: null, premiums: [] }],
        recommendedInsurerId: null,
        remarks: null,
      })
      .expect(400);
    expect(JSON.stringify(notOnRfq.body.details)).toContain(
      'Add the insurer on the Insurers and RFQ tab before its quote',
    );
    const unknown = await request(app)
      .put(c('/quotes'))
      .set(bearer(world.manager))
      .send({
        quotes: [
          {
            insurerId: alpha,
            paymentInFavourOf: null,
            premiums: [{ optionId: 'x9', premium: '1' }],
          },
        ],
        recommendedInsurerId: null,
        remarks: null,
      })
      .expect(400);
    expect(JSON.stringify(unknown.body.details)).toContain('no longer on the case');

    const saved = await request(app)
      .put(c('/quotes'))
      .set(bearer(world.manager))
      .send({
        quotes: [
          {
            insurerId: alpha,
            paymentInFavourOf: 'M/s Alpha General Insurance Co Ltd',
            premiums: [
              { optionId: 'o1', premium: '14891.60' },
              { optionId: 'o2', premium: '17000' },
              { optionId: 'o3', premium: null },
            ],
          },
          {
            insurerId: beta,
            paymentInFavourOf: null,
            premiums: [
              { optionId: 'o1', premium: '13500' },
              { optionId: 'o2', premium: '18000' },
            ],
          },
        ],
        recommendedInsurerId: beta,
        remarks: 'Beta is lowest without medical expenses.',
      })
      .expect(200);
    expect(saved.body.quotes).toHaveLength(2);
    expect(saved.body.recommendedInsurerId).toBe(beta);

    // Removing a coverage option removes its premiums.
    const trimmed = await request(app)
      .put(c('/data-sheet'))
      .set(bearer(world.manager))
      .send(sheet({ coverageOptions: sheet().coverageOptions.slice(0, 2) }))
      .expect(200);
    expect(trimmed.body.quotes[0].premiums.map((p: { optionId: string }) => p.optionId)).toEqual([
      'o1',
      'o2',
    ]);
  });

  it('prints the Data Sheet, RFQ and quote comparison in the client’s format', async () => {
    // Amounts are numbers in the Excel (shown in Indian grouping by its number format).
    const data = await texts('data-sheet');
    expect(data).toContainEqual(['Data Sheet for Workmen Compensation Insurance']);
    expect(data).toContainEqual(['1', 'Skilled Workers', '8', '160000', '1920000']);
    expect(data).toContainEqual(['Total', '18', '310000', '3720000']);
    expect(data.some((row) => row[1]?.startsWith('Only Non-ESI Employees'))).toBe(true);

    const rfq = await texts('rfq');
    expect(rfq).toContainEqual(['Policy No: Fresh · Ref: ' + rfq[0]![0]!.split('Ref: ')[1]]);
    expect(rfq).toContainEqual(['Working Height', 'Above 9 Meter']);
    expect(rfq).toContainEqual(['2', 'Contract Workers', '10', '15000', '1800000']);
    expect(rfq).toContainEqual(['S No', 'Coverage', 'Premium Incl GST 18%']);
    expect(rfq).toContainEqual(['1', 'Without Medical Expenses']);
    expect(rfq).toContainEqual(['Clauses to be attached']);
    expect(rfq).toContainEqual(['2', 'WC Act / Employers Liability Law is Covered']);
    // No insurer's premium on the RFQ.
    expect(JSON.stringify(rfq)).not.toContain('14891');

    const qcr = await texts('qcr');
    expect(qcr).toContainEqual(['Quote Sheet for Workmen Compensation Insurance']);
    expect(qcr.find((row) => row[1] === 'Without Medical Expenses')).toEqual([
      '1',
      'Without Medical Expenses',
      '14891.6',
      '13500',
    ]);
    expect(
      qcr.some((row) => row[0] === 'Without Medical Expenses' && row[1]?.includes('₹13,500')),
    ).toBe(true);
    expect(qcr.some((row) => row[0] === 'Our recommendation')).toBe(true);

    const pdf = await binary(
      request(app).get(c('/documents/qcr')).set(bearer(world.manager)),
    ).expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    // Downloading needs wc.export, which Read-only users do not have (as on the other lines).
    await request(app).get(c('/documents/rfq')).set(bearer(world.readOnly)).expect(403);
    expect(
      await AuditLogModel.countDocuments({ action: 'WC_DOCUMENT_DOWNLOADED' }),
    ).toBeGreaterThan(0);
  });

  it('moves through the stages to placed, as the other lines', async () => {
    const [alpha, beta] = world.insurers as [string, string];
    // Data Sheet complete, quotes recorded and Beta recommended (tests above): the QCR stage.
    expect((await request(app).get(c()).set(bearer(world.manager)).expect(200)).body.stage).toBe(
      'QCR',
    );
    const rfq = await request(app)
      .put(c('/rfq'))
      .set(bearer(world.manager))
      .send({
        insurers: [
          { insurerId: alpha, sentOn: '2026-11-17' },
          { insurerId: beta, sentOn: null },
        ],
      })
      .expect(200);
    // Sent to an insurer: the Data Sheet is locked, as on the other lines.
    expect(rfq.body.locked).toBe(true);
    const locked = await request(app)
      .put(c('/data-sheet'))
      .set(bearer(world.manager))
      .send(sheet())
      .expect(409);
    expect(locked.body.message).toContain('Data Sheet is locked');
    expect(rfq.body.rfqInsurers).toEqual([
      expect.objectContaining({ insurerId: alpha, sentOn: '2026-11-17' }),
      expect.objectContaining({ insurerId: beta, sentOn: null }),
    ]);
    // No placement yet: no placement slip.
    await request(app).get(c('/documents/placement-slip')).set(bearer(world.manager)).expect(409);
    const unquoted = await request(app)
      .put(c('/placement'))
      .set(bearer(world.manager))
      .send({
        insurerId: beta,
        optionId: 'o3',
        policyNumber: null,
        policyStart: null,
        policyEnd: null,
      })
      .expect(400);
    expect(JSON.stringify(unquoted.body.details)).toContain('with a premium quoted');

    const chosen = await request(app)
      .put(c('/placement'))
      .set(bearer(world.manager))
      .send({
        insurerId: beta,
        optionId: 'o1',
        policyNumber: null,
        policyStart: null,
        policyEnd: null,
      })
      .expect(200);
    expect(chosen.body.stage).toBe('PLACEMENT_SLIP');
    expect(chosen.body.placement).toMatchObject({
      insurerId: beta,
      optionLabel: 'Without Medical Expenses',
      premium: '13500',
    });
    const slip = await texts('placement-slip');
    expect(slip).toContainEqual(['Placement Slip for Workmen Compensation Insurance']);
    expect(slip).toContainEqual(['Coverage', 'Without Medical Expenses']);
    expect(slip).toContainEqual(['Premium Incl GST 18%', '₹13,500']);

    const placed = await request(app)
      .put(c('/placement'))
      .set(bearer(world.manager))
      .send({
        insurerId: beta,
        optionId: 'o1',
        policyNumber: 'WC/2026/001',
        policyStart: '2026-12-01',
        policyEnd: '2027-11-30',
      })
      .expect(200);
    expect(placed.body.stage).toBe('PLACED');
    expect(await texts('placement-slip')).toContainEqual(['Policy No', 'WC/2026/001']);
    const list = await request(app).get('/api/v1/wc/cases').set(bearer(world.manager)).expect(200);
    expect(list.body.items.find((item: { id: string }) => item.id === caseId).stage).toBe('PLACED');
  });

  it('treats a roll over as a renewal: it keeps the expiring policy', async () => {
    const rollover = await request(app)
      .post('/api/v1/wc/cases')
      .set(bearer(world.manager))
      .send({ clientId: world.clientId, type: 'ROLLOVER' })
      .expect(201);
    expect(rollover.body.type).toBe('ROLLOVER');
    expect(rollover.body.expiringPolicy).not.toBeNull();
  });

  it('keeps the expiring policy on a renewal only', async () => {
    const renewal = await request(app)
      .post('/api/v1/wc/cases')
      .set(bearer(world.manager))
      .send({ clientId: world.clientId, type: 'RENEWAL' })
      .expect(201);
    const expiringPolicy = {
      policyYear: '2024-25',
      policyNumber: 'WC/2024/77',
      insurer: 'Iffco Tokio',
      persons: 10,
      sumInsured: '2520000',
      premiumInclGst: '14891.60',
      coverageOption: 'Unlimited medical expenses',
      claimAmount: '50000',
      changes: null,
    };
    const saved = await request(app)
      .put(`/api/v1/wc/cases/${renewal.body.id as string}/data-sheet`)
      .set(bearer(world.manager))
      .send(sheet({ expiringPolicy }))
      .expect(200);
    expect(saved.body.expiringPolicy).toEqual(expiringPolicy);
    // New business drops it.
    const newCase = await request(app)
      .post('/api/v1/wc/cases')
      .set(bearer(world.manager))
      .send({ clientId: world.clientId, type: 'NEW' })
      .expect(201);
    const fresh = await request(app)
      .put(`/api/v1/wc/cases/${newCase.body.id as string}/data-sheet`)
      .set(bearer(world.manager))
      .send(sheet({ expiringPolicy }))
      .expect(200);
    expect(fresh.body.expiringPolicy).toBeNull();
  });
});
