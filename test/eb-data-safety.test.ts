import { emptyGhiRequirements } from '../src/shared/index.ts';
import mongoose, { Types } from 'mongoose';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensureIndexes } from '../src/models.ts';
import { GhiCaseModel } from '../src/modules/ghi/ghi-case.model.ts';
import { bearer, createTestApp, useTestDatabase } from './helpers/app.ts';
import { setUpWorld, type EbWorld } from './helpers/eb.ts';

// Data safety (Requirements 16, 25.5, 25.6): the new collections and indexes are added without
// dropping any, and a GHI case stored before N1 (no product) reads, lists and edits as GMC while
// its stored fields stay as they were.

useTestDatabase();
const app = createTestApp();
let world: EbWorld;
let legacyId: Types.ObjectId;

beforeAll(async () => {
  world = await setUpWorld(app);
  const owner = await mongoose.connection.collection('users').findOne({});
  const inserted = await GhiCaseModel.collection.insertOne({
    reference: 'GHI-2025-0999',
    type: 'NEW',
    stage: 'DATA_SHEET',
    closedReason: null,
    clientId: new Types.ObjectId(world.clientId),
    ownerId: owner!._id,
    policyStart: '2025-04-01',
    policyEnd: '2026-03-31',
    dueDate: '2025-03-15',
    existingInsurer: null,
    existingPolicyNumber: null,
    gstRatePercent: Types.Decimal128.fromString('18'),
    requirements: emptyGhiRequirements(),
    requirementsSaved: true,
    requirementsRevision: 1,
    censusRevision: 0,
    insurers: [],
    finalQcr: null,
    policy: null,
    activity: [],
    createdBy: owner!._id,
    updatedBy: owner!._id,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
  });
  legacyId = inserted.insertedId;
});

describe('data safety', () => {
  it('creates the new indexes and keeps every existing one', async () => {
    const before = new Map<string, string[]>();
    for (const name of ['ghi_cases', 'ghi_members', 'ghi_census_imports', 'audit_logs']) {
      before.set(
        name,
        (await mongoose.connection.collection(name).indexes()).map((index) => index.name!),
      );
    }
    await ensureIndexes();
    for (const [name, indexes] of before) {
      const after = (await mongoose.connection.collection(name).indexes()).map(
        (index) => index.name!,
      );
      for (const index of indexes) expect(after).toContain(index);
    }
    const caseIndexes = (await mongoose.connection.collection('ghi_cases').indexes()).map(
      (index) => index.key,
    );
    expect(caseIndexes).toEqual(
      expect.arrayContaining([
        { product: 1, updatedAt: -1, _id: -1 },
        { 'planAssignment.planId': 1, stage: 1 },
      ]),
    );
    const importIndexes = await mongoose.connection.collection('eb_census_imports').indexes();
    expect(importIndexes.some((index) => index.unique)).toBe(false);
    const ghiImports = await mongoose.connection.collection('ghi_census_imports').indexes();
    expect(ghiImports.some((index) => index.unique && index.key.sha256 === 1)).toBe(true);
    for (const name of [
      'family_plans',
      'eb_client_plan_defaults',
      'eb_employees',
      'eb_policy_snapshots',
      'eb_policy_snapshot_members',
    ]) {
      expect((await mongoose.connection.db!.listCollections({ name }).toArray()).length).toBe(1);
    }
  });

  it('reads a product-less GHI case as GMC without writing to it', async () => {
    const stored = await GhiCaseModel.collection.findOne({ _id: legacyId });
    const record = (
      await request(app)
        .get(`/api/v1/ghi/cases/${legacyId.toHexString()}`)
        .set(bearer(world.readOnly))
        .expect(200)
    ).body;
    expect(record).toMatchObject({ product: 'GMC', reference: 'GHI-2025-0999', plan: null });
    const listed = (
      await request(app)
        .get('/api/v1/ghi/cases?q=GHI-2025-0999')
        .set(bearer(world.readOnly))
        .expect(200)
    ).body;
    expect(listed.items[0]).toMatchObject({ product: 'GMC' });
    const all = (
      await request(app)
        .get('/api/v1/eb/cases?product=GMC&q=GHI-2025-0999')
        .set(bearer(world.readOnly))
        .expect(200)
    ).body;
    expect(all.total).toBe(1);
    expect(await GhiCaseModel.collection.findOne({ _id: legacyId })).toEqual(stored);
    expect(stored).not.toHaveProperty('product');
  });

  it('edits a product-less case through /ghi, adding no product field', async () => {
    const record = (
      await request(app)
        .get(`/api/v1/ghi/cases/${legacyId.toHexString()}`)
        .set(bearer(world.readOnly))
        .expect(200)
    ).body;
    await request(app)
      .put(`/api/v1/ghi/cases/${legacyId.toHexString()}`)
      .set(bearer(world.manager))
      .send({
        ownerId: record.owner.id,
        policyStart: '2025-04-01',
        policyEnd: '2026-03-31',
        dueDate: '2025-03-20',
        existingInsurer: null,
        existingPolicyNumber: null,
      })
      .expect(200);
    const stored = await GhiCaseModel.collection.findOne({ _id: legacyId });
    expect(stored).toMatchObject({ dueDate: '2025-03-20' });
    expect(stored).not.toHaveProperty('product');
    expect(stored).not.toHaveProperty('planAssignment');
  });
});
