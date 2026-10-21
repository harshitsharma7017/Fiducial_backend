import { createApp } from './app.ts';
import { ConfigError, loadEnv, type Env } from './config/env.ts';
import { connectDatabase, disconnectDatabase } from './lib/db.ts';
import { createLogger } from './lib/logger.ts';
import { ensureIndexes } from './models.ts';
import { ensureClaimEmailTemplates } from './modules/claims/claim-templates.service.ts';
import { startClaimNotificationWorker } from './modules/claims/claim-notifications.ts';
import { ensureEmailTemplates } from './modules/email-templates/email-templates.service.ts';
import { linkEmployeeIdentities } from './modules/employees/employee-link.ts';
import { ensureDefaultFamilyPlans } from './modules/family-plans/default-plans.ts';
import { ensureDefaultAgeBandSets } from './modules/age-bands/age-bands.service.ts';
import { transportFromEnv } from './modules/mail/transport.ts';

const SHUTDOWN_TIMEOUT_MS = 10_000;

function loadConfigOrExit(): Env {
  try {
    return loadEnv();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

const config = loadConfigOrExit();
const logger = createLogger({ level: config.LOG_LEVEL });

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection');
  process.exit(1);
});

try {
  await connectDatabase(config.MONGODB_URI);
  await ensureIndexes();
  await ensureEmailTemplates();
  await ensureClaimEmailTemplates();
  // Employee Benefits (N2, N1): the seven default family plans, then existing GHI members linked
  // to employee identities. Both leave existing records unchanged and are safe on every start.
  await ensureDefaultFamilyPlans();
  // N4: the default age band sets (Option 1, the custom example, the standard bands), once.
  await ensureDefaultAgeBandSets();
  await linkEmployeeIdentities(logger);
} catch (error) {
  logger.fatal({ err: error }, 'Could not connect to MongoDB');
  process.exit(1);
}

const mailTransport = transportFromEnv(config, logger);
const app = createApp({ config, logger, mailTransport });
// Sends queued claim emails and retries failed ones in the background (C3).
const stopClaimWorker = startClaimNotificationWorker({ transport: mailTransport, logger });
const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT, env: config.NODE_ENV }, 'API listening');
});

let shuttingDown = false;

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down');
  stopClaimWorker();

  const forceExit = setTimeout(() => {
    logger.error('Shutdown timed out; exiting');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  // Stop accepting connections, let in-flight requests finish, then close MongoDB.
  server.close((closeError) => {
    disconnectDatabase()
      .catch((error: unknown) => logger.error({ err: error }, 'Error closing MongoDB'))
      .finally(() => {
        if (closeError) logger.error({ err: closeError }, 'Error closing HTTP server');
        process.exit(closeError ? 1 : 0);
      });
  });
  server.closeIdleConnections();
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
