import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import express from 'express';
import cookieParser from 'cookie-parser';
import { z } from 'zod';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { setupWorkflowRoutes } from './workflows/routes.js';
import { setupFetchRoutes } from './fetch/routes.js';
import { setupOAuthRoutes } from './oauth/routes.js';
import { setupGoogleRoutes } from './google/routes.js';
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
import { probeConfiguredModel } from './ai/providers.js';
import { logger } from './lib/logger.js';
import {
  buildCors,
  buildHelmet,
  buildLimiters,
  buildRequestLogger,
  errorHandler,
} from './middleware/security.js';
import { requireSession, setupAuthRoutes } from './auth/session.js';
import {
  AI_PATHS,
  CONNECTOR_PATHS,
  FETCH_PATHS,
  WHATSAPP_PATHS,
  WORKFLOW_PATHS,
} from './config/protectedPaths.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
app.use(express.json({ limit: '1mb' }));

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

// AI backend-for-frontend. Provider credentials live only on this side.
setupAiRoutes(app);

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

let sock;
let qrCodeData = null;
let connectionStatus = 'disconnected';
let lastDisconnectReason = null;

// Ensure auth directory exists
const AUTH_DIR = path.join(__dirname, '.wa-auth');
if (!fs.existsSync(AUTH_DIR)) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

// Simple in-memory store for recent incoming messages demonstration
const recentMessages = [];

/**
 * Outbound message payload.
 *
 * `mediaUrl` is restricted to http/https. A local path, `file://`, or any other
 * scheme is rejected outright — the old handler resolved such values against the
 * filesystem and returned their contents.
 */
const sendMessageSchema = z
  .object({
    to: z.string().min(1).max(64),
    text: z.string().max(4096).optional(),
    mediaUrl: z
      .string()
      .max(2048)
      .refine((value) => {
        let parsed;
        try {
          parsed = new URL(value);
        } catch {
          return false;
        }
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
      }, 'mediaUrl must be an absolute http(s) URL')
      .optional(),
    mediaType: z.string().max(64).optional(),
  })
  .refine((body) => Boolean(body.text) || Boolean(body.mediaUrl), {
    message: 'Provide "text", "mediaUrl", or both.',
  });

/** Host only, for logs: a full media URL can carry a signed token in the query. */
function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-url';
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

  // Shared state
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  const startSock = async () => {
    sock = makeWASocket({
      // Removed .default as per successful import logic
      auth: state,
      syncFullHistory: false, // keep it light
      // implement a basic msg retry handler if needed
    });

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        QRCode.toDataURL(qr, (err, url) => {
          if (!err) {
            qrCodeData = url;
            connectionStatus = 'scan_qr';
          }
        });
        QRCode.toString(qr, { type: 'terminal', small: true }, (err, url) => {
          // Printed raw: an ASCII QR code is unreadable through a
          // structured logger, and operators scan this from the console.
          if (!err) process.stdout.write(`${url}\n`);
        });
      }
      if (connection === 'close') {
        const shouldReconnect =
          lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        logger.warn({ shouldReconnect }, 'WhatsApp connection closed');
        connectionStatus = 'disconnected';
        lastDisconnectReason = lastDisconnect?.error?.message;

        if (shouldReconnect) {
          setTimeout(startSock, 2000);
        } else {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          setTimeout(startSock, 1000);
        }
      } else if (connection === 'open') {
        logger.info('WhatsApp connected');
        connectionStatus = 'connected';
        qrCodeData = null;
      }
    });

    sock.ev.on('creds.update', saveCreds);

    // Simple message listener to populate a volatile 'recentMessages' list for testing
    sock.ev.on('messages.upsert', async (m) => {
      if (m.type === 'notify') {
        for (const msg of m.messages) {
          if (!msg.message) continue;
          // Extract text
          const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
          const from = msg.key.remoteJid;
          const pushName = msg.pushName;

          recentMessages.unshift({
            id: msg.key.id,
            from,
            pushName,
            text,
            timestamp: msg.messageTimestamp,
            fromMe: msg.key.fromMe,
          });

          // Keep list small
          if (recentMessages.length > 50) recentMessages.pop();
        }
      }
    });
  };

  await startSock();

  // ---- WhatsApp bridge endpoints ----
  // All of these are session-gated. Before this, anyone who could reach the
  // port could send messages from the linked account (/send), read recent
  // messages (/messages), or wipe its credentials (/disconnect).
  app.use(WHATSAPP_PATHS, limiters.general, requireSession);

  app.get('/status', (req, res) =>
    res.json({
      status: connectionStatus,
      user: sock?.user,
      lastDisconnectReason,
      qrAvailable: !!qrCodeData,
      qrUrl: qrCodeData ? '/qr' : null,
    }),
  );

  app.get('/qr', (req, res) => {
    if (connectionStatus === 'connected') {
      if (req.accepts('html')) {
        return res.send(`
                    <html lang="en">
                        <head>
                            <meta charset="UTF-8" />
                            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
                            <title>WhatsApp QR Code</title>
                            <style>
                                body { background: #050505; color: #fff; font-family: Inter, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
                                .card { background: rgba(15, 23, 42, 0.92); border: 1px solid rgba(255,255,255,0.08); border-radius: 24px; padding: 32px; max-width: 420px; width: 100%; text-align: center; }
                                .status { margin-bottom: 18px; color: #34d399; font-weight: 700; }
                                .hint { color: #cbd5e1; margin-top: 14px; font-size: 0.95rem; }
                                .refresh { margin-top: 20px; display: inline-flex; gap: 8px; align-items: center; padding: 12px 18px; border-radius: 999px; background: rgba(255,255,255,0.08); color: #fff; text-decoration: none; font-weight: 600; }
                            </style>
                        </head>
                        <body>
                            <div class="card">
                                <div class="status">WhatsApp already connected</div>
                                <div class="hint">If you want to switch devices, logout or disconnect from the API and scan again.</div>
                                <a class="refresh" href="/qr">Refresh status</a>
                            </div>
                        </body>
                    </html>
                `);
      }
      return res.status(400).json({ error: 'Connected' });
    }

    if (!qrCodeData) {
      if (req.accepts('html')) {
        return res.send(`
                    <html lang="en">
                        <head>
                            <meta charset="UTF-8" />
                            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
                            <title>WhatsApp QR Code</title>
                            <style>
                                body { background: #050505; color: #fff; font-family: Inter, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
                                .card { background: rgba(15, 23, 42, 0.92); border: 1px solid rgba(255,255,255,0.08); border-radius: 24px; padding: 32px; max-width: 420px; width: 100%; text-align: center; }
                                .status { margin-bottom: 18px; color: #fbbf24; font-weight: 700; }
                                .hint { color: #cbd5e1; margin-top: 14px; font-size: 0.95rem; }
                                .refresh { margin-top: 20px; display: inline-flex; gap: 8px; align-items: center; padding: 12px 18px; border-radius: 999px; background: rgba(255,255,255,0.08); color: #fff; text-decoration: none; font-weight: 600; }
                            </style>
                        </head>
                        <body>
                            <div class="card">
                                <div class="status">Waiting for QR code...</div>
                                <div class="hint">The bridge is initializing. Reload this page after a moment.</div>
                                <a class="refresh" href="/qr">Refresh</a>
                            </div>
                        </body>
                    </html>
                `);
      }
      return res.status(503).json({ error: 'Generating QR...' });
    }

    if (req.accepts('html')) {
      return res.send(`
                <html lang="en">
                    <head>
                        <meta charset="UTF-8" />
                        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
                        <title>WhatsApp QR Code</title>
                        <style>
                            body { background: #050505; color: #fff; font-family: Inter, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
                            .card { background: rgba(15, 23, 42, 0.92); border: 1px solid rgba(255,255,255,0.08); border-radius: 24px; padding: 32px; max-width: 420px; width: 100%; text-align: center; }
                            .title { font-size: 1.2rem; font-weight: 700; margin-bottom: 20px; }
                            .hint { color: #cbd5e1; margin-top: 16px; font-size: 0.95rem; }
                            .refresh { margin-top: 20px; display: inline-flex; gap: 8px; align-items: center; padding: 12px 18px; border-radius: 999px; background: rgba(255,255,255,0.08); color: #fff; text-decoration: none; font-weight: 600; }
                            img { max-width: 100%; height: auto; border-radius: 20px; background: #fff; padding: 16px; }
                            .footer { margin-top: 18px; color: #94a3b8; font-size: 0.9rem; }
                        </style>
                    </head>
                    <body>
                        <div class="card">
                            <div class="title">Scan this QR code with WhatsApp</div>
                            <img src="${qrCodeData}" alt="WhatsApp QR Code" />
                            <div class="hint">Open WhatsApp → Linked Devices → Link a Device → Scan QR.</div>
                            <div class="footer">Reload if the code expires.</div>
                            <a class="refresh" href="/qr">Refresh</a>
                        </div>
                    </body>
                </html>
            `);
    }

    res.json({ qr: qrCodeData });
  });

  app.post('/send', limiters.send, async (req, res) => {
    // Validate before checking connectivity: a malformed or hostile payload
    // should be rejected on its own merits, not incidentally masked by the
    // bridge happening to be offline.
    const parsed = sendMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'invalid_request',
        message: 'Provide "to" plus "text" and/or an http(s) "mediaUrl".',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const { to, text, mediaUrl, mediaType } = parsed.data;

    if (connectionStatus !== 'connected') {
      return res.status(503).json({
        error: 'bridge_not_connected',
        message: 'The WhatsApp bridge is not connected.',
      });
    }

    try {
      const jid = to.includes('@s.whatsapp.net') ? to : `${to.replace(/\D/g, '')}@s.whatsapp.net`;

      if (mediaUrl) {
        // Normalize mediaType: "image/jpg" -> "image", "video/mp4" -> "video", etc.
        let rawType = (mediaType || 'image').toString().toLowerCase().trim();
        if (rawType.includes('/')) rawType = rawType.split('/')[0];
        // Map to Baileys-supported keys
        const typeMap = { image: 'image', video: 'video', audio: 'audio', document: 'document' };
        const type = typeMap[rawType] || 'image';

        logger.info({ type, host: safeHost(mediaUrl) }, 'sending WhatsApp media');

        // Only remote http(s) media is accepted.
        //
        // The previous implementation fell back to treating mediaUrl as a
        // filesystem path and read it with path.resolve + readFileSync,
        // which let any caller exfiltrate arbitrary server files. It also
        // used CommonJS require() inside this ES module, so that branch
        // threw at runtime regardless. Both are gone; the schema rejects
        // anything that is not an http(s) URL.
        await sock.sendMessage(jid, { [type]: { url: mediaUrl }, caption: text || '' });
      } else {
        // Send text only
        await sock.sendMessage(jid, { text });
      }

      res.json({ success: true, to: jid });
    } catch (e) {
      logger.error({ err: e }, 'WhatsApp send failed');
      res.status(500).json({ error: 'send_failed', message: 'Could not send the message.' });
    }
  });

  app.get('/messages', (req, res) => {
    // Return in-memory recent messages
    // Optional filter: ?jid=...
    const { jid } = req.query;
    let msgs = recentMessages;
    if (jid) {
      msgs = msgs.filter((m) => m.from === jid || (m.fromMe && jid === sock?.user?.id)); // loose filter
    }
    res.json({ messages: msgs.slice(0, 20) });
  });

  app.post('/disconnect', async (req, res) => {
    try {
      await sock.logout();
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      res.json({ success: true });
      // The connection.close handler will likely restart the socket logic to generate a new QR
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

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
      clearTimeout(forceExit);
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

startServer();
