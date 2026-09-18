import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { z } from 'zod';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../lib/logger.js';
import { requireSession } from '../auth/session.js';
import { WHATSAPP_PATHS } from '../config/protectedPaths.js';

/**
 * The WhatsApp bridge.
 *
 * This is an OPT-IN feature (WHATSAPP_ENABLED, default off — Task 17). Before,
 * Baileys connected on every boot whether or not anyone used WhatsApp, printed a
 * QR code to the console, and retried a failing connection forever — noise in the
 * logs of a deployment that has nothing to do with WhatsApp, and a linked-device
 * socket nobody asked for.
 *
 * `setupWhatsAppBridge` starts Baileys and registers the six live endpoints.
 * `setupWhatsAppDisabled` registers stubs that report the feature is off, so the
 * frontend connector degrades cleanly (a clear "disabled" status) instead of
 * hitting 404s. Both keep the endpoints session-gated.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Auth material lives beside the server, next to where it always has.
const AUTH_DIR = path.join(__dirname, '..', '.wa-auth');

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

/** Shared QR page chrome so the three states render consistently. */
function qrPage({ statusColor, statusText, hint, image }) {
  const imageBlock = image ? `<img src="${image}" alt="WhatsApp QR Code" />` : '';
  return `
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>WhatsApp QR Code</title>
        <style>
          body { background: #050505; color: #fff; font-family: Inter, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
          .card { background: rgba(15, 23, 42, 0.92); border: 1px solid rgba(255,255,255,0.08); border-radius: 24px; padding: 32px; max-width: 420px; width: 100%; text-align: center; }
          .status { margin-bottom: 18px; color: ${statusColor}; font-weight: 700; }
          .hint { color: #cbd5e1; margin-top: 14px; font-size: 0.95rem; }
          .refresh { margin-top: 20px; display: inline-flex; gap: 8px; align-items: center; padding: 12px 18px; border-radius: 999px; background: rgba(255,255,255,0.08); color: #fff; text-decoration: none; font-weight: 600; }
          img { max-width: 100%; height: auto; border-radius: 20px; background: #fff; padding: 16px; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="status">${statusText}</div>
          ${imageBlock}
          <div class="hint">${hint}</div>
          <a class="refresh" href="/qr">Refresh</a>
        </div>
      </body>
    </html>
  `;
}

/**
 * Register the bridge on the app and start the Baileys socket.
 *
 * @param {import('express').Express} app
 * @param {{ limiters: { general: import('express').RequestHandler, send: import('express').RequestHandler } }} deps
 */
export async function setupWhatsAppBridge(app, { limiters }) {
  let sock;
  let qrCodeData = null;
  let connectionStatus = 'disconnected';
  let lastDisconnectReason = null;
  const recentMessages = [];

  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  const startSock = async () => {
    sock = makeWASocket({ auth: state, syncFullHistory: false });

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
          // Printed raw: an ASCII QR code is unreadable through a structured
          // logger, and operators scan this from the console.
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

    sock.ev.on('messages.upsert', async (m) => {
      if (m.type === 'notify') {
        for (const msg of m.messages) {
          if (!msg.message) continue;
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

          if (recentMessages.length > 50) recentMessages.pop();
        }
      }
    });
  };

  await startSock();

  // All endpoints session-gated. Before this, anyone who could reach the port
  // could send from the linked account, read messages, or wipe credentials.
  app.use(WHATSAPP_PATHS, limiters.general, requireSession);

  app.get('/status', (_req, res) =>
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
        return res.send(
          qrPage({
            statusColor: '#34d399',
            statusText: 'WhatsApp already connected',
            hint: 'To switch devices, disconnect from the API and scan again.',
          }),
        );
      }
      return res.status(400).json({ error: 'Connected' });
    }

    if (!qrCodeData) {
      if (req.accepts('html')) {
        return res.send(
          qrPage({
            statusColor: '#fbbf24',
            statusText: 'Waiting for QR code...',
            hint: 'The bridge is initializing. Reload this page after a moment.',
          }),
        );
      }
      return res.status(503).json({ error: 'Generating QR...' });
    }

    if (req.accepts('html')) {
      return res.send(
        qrPage({
          statusColor: '#fff',
          statusText: 'Scan this QR code with WhatsApp',
          hint: 'Open WhatsApp → Linked Devices → Link a Device → Scan QR.',
          image: qrCodeData,
        }),
      );
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
        // Normalize mediaType: "image/jpg" -> "image", "video/mp4" -> "video".
        let rawType = (mediaType || 'image').toString().toLowerCase().trim();
        if (rawType.includes('/')) rawType = rawType.split('/')[0];
        const typeMap = { image: 'image', video: 'video', audio: 'audio', document: 'document' };
        const type = typeMap[rawType] || 'image';

        logger.info({ type, host: safeHost(mediaUrl) }, 'sending WhatsApp media');

        // Only remote http(s) media is accepted. The previous implementation
        // fell back to treating mediaUrl as a filesystem path and read it with
        // readFileSync, which let any caller exfiltrate arbitrary server files.
        await sock.sendMessage(jid, { [type]: { url: mediaUrl }, caption: text || '' });
      } else {
        await sock.sendMessage(jid, { text });
      }

      res.json({ success: true, to: jid });
    } catch (e) {
      logger.error({ err: e }, 'WhatsApp send failed');
      res.status(500).json({ error: 'send_failed', message: 'Could not send the message.' });
    }
  });

  app.get('/messages', (req, res) => {
    const { jid } = req.query;
    let msgs = recentMessages;
    if (jid) {
      msgs = msgs.filter((m) => m.from === jid || (m.fromMe && jid === sock?.user?.id));
    }
    res.json({ messages: msgs.slice(0, 20) });
  });

  app.post('/disconnect', async (_req, res) => {
    try {
      await sock.logout();
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  logger.info('WhatsApp bridge enabled');
}

/**
 * Register stub endpoints for when the bridge is disabled.
 *
 * The endpoints stay session-gated and answer honestly: /status reports
 * `disabled` (which the frontend connector treats as offline), and the
 * action routes return 503 `bridge_disabled` rather than 404, so a client that
 * calls them gets a clear reason instead of a confusing not-found.
 */
export function setupWhatsAppDisabled(app, { limiters }) {
  app.use(WHATSAPP_PATHS, limiters.general, requireSession);

  const disabledBody = {
    error: 'bridge_disabled',
    message: 'The WhatsApp bridge is turned off. Set WHATSAPP_ENABLED=true to enable it.',
  };

  app.get('/status', (_req, res) =>
    res.json({ status: 'disabled', user: null, qrAvailable: false, qrUrl: null }),
  );
  app.get('/qr', (_req, res) => res.status(503).json(disabledBody));
  app.post('/send', (_req, res) => res.status(503).json(disabledBody));
  app.get('/messages', (_req, res) => res.json({ messages: [] }));
  app.post('/disconnect', (_req, res) => res.json({ success: true }));

  logger.info('WhatsApp bridge disabled (WHATSAPP_ENABLED=false)');
}
