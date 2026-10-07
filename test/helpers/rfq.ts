import type { Express } from 'express';
import request from 'supertest';
import { bearer } from './app.ts';

/**
 * Generates the case's RFQ and has it approved (R-5): an RFQ is sent to insurers only once its
 * latest version is approved. Returns the version.
 */
export async function approveRfq(
  app: Express,
  caseId: string,
  editor: string,
  approver: string,
): Promise<number> {
  const generated = await request(app)
    .post(`/api/v1/proposals/${caseId}/rfq/versions`)
    .set(bearer(editor))
    .expect(201);
  const version = generated.body.current.version as number;
  const base = `/api/v1/proposals/${caseId}/rfq/versions/${version}`;
  await request(app).post(`${base}/submit`).set(bearer(editor)).send({}).expect(200);
  await request(app).post(`${base}/approve`).set(bearer(approver)).send({}).expect(200);
  return version;
}
