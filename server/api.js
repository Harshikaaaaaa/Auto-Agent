import express from 'express';
import cookieParser from 'cookie-parser';
import { setupWorkflowRoutes } from './workflows/routes.js';
import { setupFetchRoutes } from './fetch/routes.js';
import { closeRenderBrowser } from './fetch/render.js';
import { setupOAuthRoutes } from './oauth/routes.js';
import { setupGoogleRoutes } from './google/routes.js';
import { setupWhatsAppBridge, setupWhatsAppDisabled } from './whatsapp/bridge.js';
import { serveFrontend } from './frontend.js';
import {
  closePool,
  ensureDatabaseExists,
  isDatabaseReachable,
  describeConnection,
} from './db/pool.js';
import { importLegacyWorkflows, runMigrations } from './db/migrations.js';
import { OPERATOR_SUBJECT } from './auth/session.js';
import { env, publicAiConfig } from './config/env.js';
import { setupAiRoutes } from './ai/routes.js';
import { setupBillingRoutes } from './billing/routes.js';
import { setupPaymentRoutes, setupPaymentWebhook } from './payments/routes.js';
import { probeConfiguredModel } from './ai/providers.js';
import { logger } from './lib/logger.js';
import {
  buildCors,
  buildHelmet,
  buildLimiters,
  buildRequestLogger,
  errorHandler,
} from './middleware/security.js';
import { requireAdmin, requireSession, setupAuthRoutes } from './auth/session.js';
import { bootstrapAdminIfNeeded } from './db/bootstrapAdmin.js';
import {
  ADMIN_PATHS,
  AI_PATHS,
  BILLING_PATHS,
  CONNECTOR_PATHS,
  FETCH_PATHS,
  WORKFLOW_PATHS,
} from './config/protectedPaths.js';

const app = express();
const PORT = env.PORT;

// Trust exactly one proxy hop so req.ip is the real client behind a load
// balancer. A blanket `true` would let a client spoof X-Forwarded-For and
// defeat rate limiting.
app.set('trust proxy', 1);

const limiters = buildLimiters();

app.use(buildRequestLogger());
app.use(buildHelmet());
app.use(buildCors());
app.use(cookieParser());
// Large body limit so a workflow can hand a whole scraped page to an AI node
// without the app rejecting it as "too large"; only the AI provider's own token
// limit remains. Configurable via JSON_BODY_LIMIT.
//
// The payment webhook is EXCLUDED: its HMAC signature is over the exact raw
// bytes the gateway sent, so it must reach express.raw with the body intact. If
// express.json parsed it first the raw bytes would be gone and every webhook
// would fail verification.
const jsonParser = express.json({ limit: env.JSON_BODY_LIMIT });
app.use((req, res, next) => {
  if (req.path === '/api/billing/webhook') return next();
  return jsonParser(req, res, next);
});

// ---- Public endpoints (no session required) ----

/** Liveness: the process is up. Intentionally cheap and unauthenticated. */
app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
});

/**
 * Readiness: safe to receive traffic.
 *
 * Checks the database, because without it every workflow route fails. Reports no
 * connection details — an unauthenticated probe should not disclose topology.
 */
app.get('/readyz', async (_req, res) => {
  const databaseReachable = await isDatabaseReachable();
  res.status(databaseReachable ? 200 : 503).json({
    status: databaseReachable ? 'ready' : 'degraded',
    database: databaseReachable ? 'up' : 'down',
  });
});

setupAuthRoutes(app, { loginLimiter: limiters.auth });

// ---- Protected endpoints ----
// Everything below requires a session. These routes read saved workflows, spend
// model credits, and send real messages, so none of them may be anonymous.

app.use(AI_PATHS, limiters.ai, requireSession);
app.use(WORKFLOW_PATHS, limiters.general, requireSession);
// Outbound fetch is session-gated and separately budgeted: an unauthenticated or
// unlimited version of it is a network scanning tool.
app.use(FETCH_PATHS, limiters.fetch, requireSession);
// Connecting a Google tool binds a grant to the signed-in operator, and the
// proxy spends it. Anonymous access here would let a stranger send mail from the
// operator's account, so the callback that WRITES the credential is gated too.
app.use(CONNECTOR_PATHS, limiters.google, requireSession);
// The payment webhook is PUBLIC but signature-verified, and needs the RAW body,
// so it is registered BEFORE the /api/billing session guard and before the JSON
// parser matters (it uses express.raw). A gateway is not a signed-in user.
setupPaymentWebhook(app);
// Billing endpoints are session-gated; the admin console is additionally
// role-gated.
app.use(BILLING_PATHS, limiters.general, requireSession);
app.use(ADMIN_PATHS, limiters.general, requireSession, requireAdmin);

// AI backend-for-frontend. Provider credentials live only on this side.
setupAiRoutes(app);

// Billing reads (wallet, ledger, usage, analytics) + payment routes (order
// creation, subscription management, history). Session-gated above.
setupBillingRoutes(app);
setupPaymentRoutes(app);

// Setup workflow routes
setupWorkflowRoutes(app);

// Outbound fetch, behind the SSRF policy in server/lib/ssrfGuard.js.
setupFetchRoutes(app);

// Connected-tool OAuth, and the only route through which the browser reaches
// Google. Access tokens are stored encrypted and never sent to the client.
setupOAuthRoutes(app);
setupGoogleRoutes(app);

/**
 * Startup probe for the configured model.
 *
 * Non-fatal by design: a network blip, or a dev machine without Ollama running,
 * must not stop the server from booting. The outcome is logged here and served
 * from /api/ai/health so a misconfiguration is visible instead of silent.
 */
async function reportAiConfiguration() {
  const cfg = publicAiConfig();
  const configured = Object.entries(cfg.providers)
    .filter(([, v]) => v.configured)
    .map(([k]) => k);
  logger.info(
    {
      provider: cfg.defaultProvider,
      configured,
      override: cfg.allowProviderOverride ? 'allowed' : 'locked',
    },
    'AI configuration',
  );

  const probe = await probeConfiguredModel();
  if (probe.ok) {
    logger.info({ provider: probe.provider, model: probe.model }, 'model check passed');
  } else {
    logger.warn(
      { provider: probe.provider, model: probe.model, detail: probe.detail },
      'MODEL CHECK FAILED — AI features will fail until this is fixed (see GET /api/ai/health)',
    );
  }

  if (!env.AUTH_ENABLED) {
    logger.warn(
      'AUTH_ENABLED=false — every API route is unauthenticated. ' +
        'This is for local development only and is rejected in production.',
    );
  }
}

/**
 * Prepare the database before serving traffic.
 *
 * Creating the schema on boot is convenient for local development and for a
 * single-container deployment. Set DB_AUTO_MIGRATE=false to run migrations as a
 * separate deployment step instead.
 */
async function prepareDatabase() {
  if (!env.DB_AUTO_MIGRATE) {
    logger.info('DB_AUTO_MIGRATE is off; skipping schema setup');
    return;
  }

  await ensureDatabaseExists();
  const applied = await runMigrations();
  logger.info({ ...describeConnection(), migrationsApplied: applied }, 'database ready');

  // Move single-operator -> multi-user without losing data: bind the first
  // admin account to owner_id='operator' so its existing workflows/credentials
  // are inherited. No-op once any user exists, or when not configured.
  await bootstrapAdminIfNeeded();

  // One-time move off the legacy JSON file. Uses INSERT IGNORE, so this is a
  // no-op once the rows exist, and the source file is left in place.
  const imported = await importLegacyWorkflows({ ownerId: OPERATOR_SUBJECT });
  if (imported.imported > 0) {
    logger.info(
      { imported: imported.imported, skipped: imported.skipped },
      'imported workflows from the legacy JSON file',
    );
  }
}

async function startServer() {
  try {
    await prepareDatabase();
  } catch (err) {
    // Without a database every workflow route fails, so refusing to start is
    // clearer than serving an app that cannot save anything.
    logger.error(
      { err, ...describeConnection() },
      'could not prepare the database; refusing to start',
    );
    process.exitCode = 1;
    return;
  }

  // WhatsApp bridge is opt-in (Task 17). When off, Baileys never starts — no
  // linked-device socket, no console QR, no forever-retrying connection log
  // spam — and the endpoints answer with a clear "disabled" instead of 404 so
  // the frontend degrades cleanly. Enable with WHATSAPP_ENABLED=true.
  if (env.WHATSAPP_ENABLED) {
    try {
      await setupWhatsAppBridge(app, { limiters });
    } catch (err) {
      // A bridge that fails to initialise must not take the whole API down; the
      // rest of the app has nothing to do with WhatsApp. Fall back to the
      // disabled stubs so the routes still answer.
      logger.error({ err }, 'WhatsApp bridge failed to start; serving disabled stubs');
      setupWhatsAppDisabled(app, { limiters });
    }
  } else {
    setupWhatsAppDisabled(app, { limiters });
  }

  // Serve the built frontend from this origin (single-container deploy).
  // Registered after every API and bridge route so real endpoints win over the
  // SPA history fallback, and before the error handler. A no-op if dist/ is
  // absent (e.g. the Vite dev server is serving the app instead).
  serveFrontend(app);

  // Terminal error handler. Registered last so it sees errors from every
  // route and from CORS rejections.
  app.use(errorHandler);

  const server = app.listen(PORT, () => {
    logger.info({ port: PORT, authEnabled: env.AUTH_ENABLED }, 'AutoAgent server listening');
    void reportAiConfiguration();
  });

  // Graceful shutdown: stop accepting connections, then release the database
  // pool so in-flight transactions are not cut mid-write.
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    const forceExit = setTimeout(() => {
      logger.warn('shutdown timed out; exiting');
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    server.close(async () => {
      try {
        await closePool();
      } catch (err) {
        logger.error({ err }, 'failed to close the database pool');
      }
      try {
        // Release the headless browser if the render tier ever launched one.
        await closeRenderBrowser();
      } catch (err) {
        logger.error({ err }, 'failed to close the render browser');
      }
      clearTimeout(forceExit);
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

startServer();
