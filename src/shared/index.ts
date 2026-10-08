/**
 * API contracts shared by both repos: Zod schemas, enums, types and display formatters.
 *
 * Fiducial_backend/src/shared is the source of truth. Fiducial_frontend/src/shared is an exact
 * copy: after changing anything here, run `npm run shared:sync` in Fiducial_frontend
 * (`npm run shared:check` there reports any difference).
 */
export * from './addon-lists.ts';
export * from './audit.ts';
export * from './auth.ts';
export * from './catalog.ts';
export * from './client-approval.ts';
export * from './clients.ts';
export * from './common.ts';
export * from './contacts.ts';
export * from './documents.ts';
export * from './errors.ts';
export * from './format.ts';
export * from './gst.ts';
export * from './health.ts';
export * from './imports.ts';
export * from './insurers.ts';
export * from './mail.ts';
export * from './masters.ts';
export * from './permissions.ts';
export * from './placement-slip.ts';
export * from './proposals.ts';
export * from './qcr.ts';
export * from './quotes.ts';
export * from './rfq.ts';
export * from './rating.ts';
export * from './risk-types.ts';
export * from './roles.ts';
export * from './users.ts';
