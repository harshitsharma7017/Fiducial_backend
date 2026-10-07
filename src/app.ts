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
import { createClientsRouter } from './modules/clients/clients.routes.ts';
import { createHealthRouter } from './modules/health/health.routes.ts';
import { createImportsRouter } from './modules/imports/imports.routes.ts';
import { createInsurersRouter } from './modules/insurers/insurers.routes.ts';
import { createCatalogRouter } from './modules/catalog/catalog.routes.ts';
import { createProposalsRouter } from './modules/proposals/proposals.routes.ts';
import { createMastersRouter } from './modules/masters/masters.routes.ts';
import { createRatingRouter } from './modules/rating/rating.routes.ts';
import { createUsersRouter } from './modules/users/users.routes.ts';

export interface AppDependencies {
  config: Env;
  logger: Logger;
}

/** Builds the Express app without listening, so tests can drive it with Supertest. */
export function createApp({ config, logger }: AppDependencies): Express {
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
  api.use('/masters', createMastersRouter(jwt));
  api.use('/clients', createClientsRouter(jwt));
  api.use('/insurers', createInsurersRouter(jwt));
  api.use('/catalog', createCatalogRouter(jwt));
  api.use('/imports', createImportsRouter(jwt));
  api.use('/proposals', createProposalsRouter({ ...jwt, gstRatePercent: config.GST_RATE_PERCENT }));
  api.use('/rating', createRatingRouter({ ...jwt, gstRatePercent: config.GST_RATE_PERCENT }));
  api.use('/audit', createAuditRouter(jwt));
  app.use('/api/v1', api);

  const openApiDocument = buildOpenApiDocument();
  app.get('/api/openapi.json', (_req, res) => {
    res.json(openApiDocument);
  });
  app.use(
    '/api/docs',
    swaggerUi.serve,
    swaggerUi.setup(openApiDocument, { customSiteTitle: 'Fiducial API docs' }),
  );

  app.use(notFound());
  app.use(errorHandler());
  return app;
}
