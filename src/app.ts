import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import type { Env } from './config/env.ts';
import type { Logger } from './lib/logger.ts';
import { buildOpenApiDocument } from './lib/openapi.ts';
import { errorHandler } from './middleware/error-handler.ts';
import { notFound } from './middleware/not-found.ts';
import { requestId } from './middleware/request-id.ts';
import { createAuditRouter } from './modules/audit/audit.routes.ts';
import { createAuthRouter } from './modules/auth/auth.routes.ts';
import { createClaimLinksRouter } from './modules/claims/claim-links.routes.ts';
import { createClaimsRouter } from './modules/claims/claims.routes.ts';
import { createClientsRouter } from './modules/clients/clients.routes.ts';
import { createHealthRouter } from './modules/health/health.routes.ts';
import { createImportsRouter } from './modules/imports/imports.routes.ts';
import { createInsurersRouter } from './modules/insurers/insurers.routes.ts';
import { createCatalogRouter } from './modules/catalog/catalog.routes.ts';
import { createTemplatesRouter } from './modules/documents/templates.routes.ts';
import { createGhiRouter } from './modules/ghi/ghi.routes.ts';
import { createGhiWorkflowRouter } from './modules/ghi/ghi-workflow.routes.ts';
import { createEbProductRouter } from './modules/ghi/eb-product.routes.ts';
import { createAgeBandsRouter } from './modules/age-bands/age-bands.routes.ts';
import { createAnalysisRouter } from './modules/claims-analysis/analysis.routes.ts';
import { createTpaRouter } from './modules/tpa/tpa.routes.ts';
import { createCaseConfigurationRouter } from './modules/ghi/case-configuration.routes.ts';
import { toEbCaseRecord } from './modules/ghi/eb-cases.service.ts';
import { getCase } from './modules/ghi/ghi-cases.service.ts';
import { loadCase } from './modules/ghi/ghi-common.ts';
import { GMC_SCOPE, GPA_SCOPE, GTLI_SCOPE } from './modules/ghi/products/profile.ts';
import { createEbRouter } from './modules/ghi/eb.routes.ts';
import { createEmailTemplatesRouter } from './modules/email-templates/email-templates.routes.ts';
import { createFamilyPlansRouter } from './modules/family-plans/family-plans.routes.ts';
import {
  httpExistingPolicySource,
  notConfiguredSource,
  type ExistingPolicySource,
} from './modules/proposals/existing-policy-source.ts';
import { createProposalsRouter, liveCaseOnly } from './modules/proposals/proposals.routes.ts';
import { createClientApprovalRouter } from './modules/client-approval/client-approval.routes.ts';
import { createPlacementSlipRouter } from './modules/placement-slip/placement-slip.routes.ts';
import { createCoverageConfirmationRouter } from './modules/coverage-confirmation/coverage-confirmation.routes.ts';
import { createCloudDocumentsRouter } from './modules/cloud-storage/cloud-documents.routes.ts';
import { ChatHub } from './modules/chat/chat-hub.ts';
import { createChatRouter } from './modules/chat/chat.routes.ts';
import { cloudStoreFromEnv, type CloudStore } from './modules/cloud-storage/cloud-store.ts';
import { useFileStore } from './modules/files/file-store.ts';
import { createQcrRouter } from './modules/qcr/qcr.routes.ts';
import { createWorklistsRouter } from './modules/worklists/worklists.routes.ts';
import { quoteReaderFromEnv, type QuoteReader } from './modules/quotes/quote-reader.ts';
import { createQuotesRouter } from './modules/quotes/quotes.routes.ts';
import { createRfqRouter } from './modules/rfq/rfq.routes.ts';
import { createMailRouter } from './modules/mail/mail.routes.ts';
import { createNotificationsRouter } from './modules/notifications/notifications.routes.ts';
import { transportFromEnv, type MailTransport } from './modules/mail/transport.ts';
import { createMastersRouter } from './modules/masters/masters.routes.ts';
import { createRolesRouter } from './modules/roles/roles.routes.ts';
import { createUsersRouter } from './modules/users/users.routes.ts';
import { publicAccess } from './middleware/require-permission.ts';
import { route } from './middleware/validate.ts';

export interface AppDependencies {
  config: Env;
  logger: Logger;
  /** Where renewals get last year's policy; from the config when not given (tests pass a fake). */
  existingPolicySource?: ExistingPolicySource;
  /** How mail leaves; from the config when not given (tests pass a fake). */
  mailTransport?: MailTransport;
  /** Q1: who reads quote files for the auto-fill; from OCR_PROVIDER when not given (tests pass a fake). */
  quoteReader?: QuoteReader;
  /** Where every file goes (S3); from CLOUD_STORAGE when not given (tests pass a memory store). */
  cloudStore?: CloudStore;
  /** The chat's live delivery; a new one when not given (tests pass theirs to watch it). */
  chatHub?: ChatHub;
  /** How often the chat's live connection is pinged (tests use a short one). */
  chatPingMs?: number;
}

/** Builds the Express app without listening, so tests can drive it with Supertest. */
export function createApp({
  config,
  logger,
  existingPolicySource,
  mailTransport,
  quoteReader,
  cloudStore,
  chatHub,
  chatPingMs,
}: AppDependencies): Express {
  const transport = mailTransport ?? transportFromEnv(config, logger);
  const store = cloudStore ?? cloudStoreFromEnv(config, logger);
  // Every file of the app goes to this store (S3 in production); the database keeps only keys.
  useFileStore(store, cloudStore !== undefined);
  const reader = quoteReader ?? quoteReaderFromEnv(config, logger);
  const policySource =
    existingPolicySource ??
    (config.EXISTING_POLICY_API_URL
      ? httpExistingPolicySource({
          baseUrl: config.EXISTING_POLICY_API_URL,
          apiKey: config.EXISTING_POLICY_API_KEY ?? null,
          timeoutMs: config.EXISTING_POLICY_API_TIMEOUT_MS,
          sourceName: config.EXISTING_POLICY_SOURCE_NAME,
        })
      : notConfiguredSource);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY);
  // Plain key=value query strings only: no nested objects that could carry Mongo operators.
  app.set('query parser', 'simple');

  app.use(requestId());
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request).requestId,
      customLogLevel: (_req, res, error) => {
        if (error || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      // Headers and bodies are never logged, so tokens and passwords cannot leak into logs.
      serializers: {
        req: (req: { id: unknown; method: string; url: string }) => ({
          id: req.id,
          method: req.method,
          url: req.url,
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
      autoLogging: { ignore: (req) => req.url === '/api/v1/health' },
    }),
  );
  app.use(helmet());
  app.use(
    cors({
      origin: config.CORS_ORIGIN,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: ['Authorization', 'Content-Type', 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id'],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: '1mb' }));

  const jwt = { jwtSecret: config.JWT_SECRET };
  const api = express.Router();
  api.use('/health', createHealthRouter());
  api.use('/auth', createAuthRouter(config));
  api.use('/users', createUsersRouter(jwt));
  // Database-driven roles and their permissions (docs/RBAC.md).
  api.use('/roles', createRolesRouter(jwt));
  api.use('/masters', createMastersRouter(jwt));
  api.use('/clients', createClientsRouter(jwt));
  api.use('/insurers', createInsurersRouter(jwt));
  api.use('/catalog', createCatalogRouter(jwt));
  api.use('/templates', createTemplatesRouter(jwt));
  api.use('/email-templates', createEmailTemplatesRouter(jwt));
  api.use('/imports', createImportsRouter(jwt));
  api.use('/mail', createMailRouter({ ...jwt, transport }));
  // A4: the signed-in user's in-app notifications.
  api.use('/notifications', createNotificationsRouter(jwt));
  // The internal chat: direct messages, groups and file sharing, delivered live.
  api.use('/chat', createChatRouter({ ...jwt, hub: chatHub ?? new ChatHub(), pingMs: chatPingMs }));
  api.use('/proposals/:id', liveCaseOnly());
  api.use(
    '/proposals',
    createProposalsRouter({
      ...jwt,
      gstRatePercent: config.GST_RATE_PERCENT,
      policySource,
      mailTransport: transport,
    }),
  );
  api.use(
    '/proposals',
    createQuotesRouter({ ...jwt, gstRatePercent: config.GST_RATE_PERCENT, quoteReader: reader }),
  );
  api.use('/proposals', createRfqRouter({ ...jwt, gstRatePercent: config.GST_RATE_PERCENT }));
  api.use(
    '/proposals',
    createQcrRouter({ ...jwt, gstRatePercent: config.GST_RATE_PERCENT, mailTransport: transport }),
  );
  api.use(
    '/proposals',
    createClientApprovalRouter({ ...jwt, gstRatePercent: config.GST_RATE_PERCENT }),
  );
  api.use(
    '/proposals',
    createPlacementSlipRouter({
      ...jwt,
      gstRatePercent: config.GST_RATE_PERCENT,
      mailTransport: transport,
    }),
  );
  // Q4: the coverage confirmation (letter / email to the insured), after the case is placed.
  api.use(
    '/proposals',
    createCoverageConfirmationRouter({
      ...jwt,
      gstRatePercent: config.GST_RATE_PERCENT,
      mailTransport: transport,
    }),
  );
  // Documents users save to cloud storage (S3); everything else stays in the database.
  api.use(
    '/proposals',
    createCloudDocumentsRouter({ ...jwt, gstRatePercent: config.GST_RATE_PERCENT, store }),
  );
  // Group health (GHI): its own cases and routes beside Property's proposals.
  api.use('/ghi', createGhiRouter({ ...jwt, gstRatePercent: config.GST_RATE_PERCENT }));
  api.use('/ghi', createGhiWorkflowRouter({ ...jwt, mailTransport: transport }));
  // Employee Benefits (N1 to N3): GPA and GTLI cases, the cross-product routes, the Family
  // Plan Master. GMC stays on /ghi above.
  api.use('/eb/gpa', createEbProductRouter('GPA', { ...jwt, mailTransport: transport }));
  api.use('/eb/gtli', createEbProductRouter('GTLI', { ...jwt, mailTransport: transport }));
  api.use('/eb', createEbRouter({ ...jwt, gstRatePercent: config.GST_RATE_PERCENT }));
  api.use('/family-plans', createFamilyPlansRouter(jwt));
  // N4 and N7: the Age Band Master, and each case's age bands and RFQ selection summary.
  api.use('/age-bands', createAgeBandsRouter(jwt));
  // N8 to N10: TPA claims, claims analysis, renewal analysis.
  api.use('/tpa', createTpaRouter({ ...jwt, mailTransport: transport }));
  api.use('/', createAnalysisRouter(jwt));
  api.use('/ghi', createCaseConfigurationRouter({ ...jwt, scope: GMC_SCOPE, record: getCase }));
  for (const [path, scope] of [
    ['/eb/gpa', GPA_SCOPE],
    ['/eb/gtli', GTLI_SCOPE],
  ] as const) {
    api.use(
      path,
      createCaseConfigurationRouter({
        ...jwt,
        scope,
        record: async (id) => toEbCaseRecord(await loadCase(id, undefined, scope)),
      }),
    );
  }
  // Group health claims: staff routes, and the public side of employee submission links.
  api.use('/claims', createClaimsRouter({ ...jwt, mailTransport: transport, logger }));
  api.use('/claim-links', createClaimLinksRouter());
  api.use('/', createWorklistsRouter({ ...jwt, gstRatePercent: config.GST_RATE_PERCENT }));
  api.use('/audit', createAuditRouter(jwt));
  app.use('/api/v1', api);

  const openApiDocument = buildOpenApiDocument();
  // Public by design (audit F-09 is still open): the API description, served without sign-in.
  app.get(
    '/api/openapi.json',
    publicAccess('OpenAPI description of the API'),
    route({}, (_input, _req, res) => {
      res.json(openApiDocument);
    }),
  );
  app.use(
    '/api/docs',
    swaggerUi.serve,
    swaggerUi.setup(openApiDocument, { customSiteTitle: 'Fiducial API docs' }),
  );

  app.use(notFound());
  app.use(errorHandler());
  return app;
}
