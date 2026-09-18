import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';

/**
 * Task 17: the WhatsApp bridge is opt-in.
 *
 * When WHATSAPP_ENABLED is off, Baileys must NOT start, but the endpoints must
 * still answer honestly so the frontend connector degrades cleanly. These tests
 * exercise the disabled stubs against a real Express app. They do not start the
 * live bridge, so no socket is opened.
 */

const originalEnv = { ...process.env };

let server;
let baseUrl;
const realFetch = globalThis.fetch.bind(globalThis);

beforeAll(async () => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, {
    AUTOAGENT_SKIP_ENV_FILES: '1',
    AI_PROVIDER: 'ollama',
    AUTH_ENABLED: 'false', // so requireSession admits the request without a cookie
    APP_PASSWORD: 'test-operator-password',
    SESSION_SECRET: 'e'.repeat(64),
    LOG_LEVEL: 'silent',
  });

  const { setupWhatsAppDisabled } = await import('../bridge.js');
  const { buildLimiter } = await import('../../middleware/security.js');

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());

  const limiters = {
    general: buildLimiter({ limit: 1000, name: 'test-general' }),
    send: buildLimiter({ limit: 1000, name: 'test-send' }),
  };
  setupWhatsAppDisabled(app, { limiters });

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

async function req(path, init = {}) {
  const res = await realFetch(`${baseUrl}${path}`, init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // some responses are not JSON
  }
  return { status: res.status, json };
}

describe('WhatsApp bridge disabled stubs', () => {
  it('reports status "disabled" rather than a live status', async () => {
    const { status, json } = await req('/status');
    expect(status).toBe(200);
    expect(json.status).toBe('disabled');
    expect(json.qrAvailable).toBe(false);
  });

  it('refuses /send with 503 bridge_disabled', async () => {
    const { status, json } = await req('/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: '15551234567', text: 'hi' }),
    });
    expect(status).toBe(503);
    expect(json.error).toBe('bridge_disabled');
  });

  it('refuses /qr with 503 bridge_disabled', async () => {
    const { status, json } = await req('/qr', {
      headers: { Accept: 'application/json' },
    });
    expect(status).toBe(503);
    expect(json.error).toBe('bridge_disabled');
  });

  it('returns an empty message list', async () => {
    const { status, json } = await req('/messages');
    expect(status).toBe(200);
    expect(json.messages).toEqual([]);
  });

  it('treats disconnect as a no-op success', async () => {
    const { status, json } = await req('/disconnect', { method: 'POST' });
    expect(status).toBe(200);
    expect(json.success).toBe(true);
  });
});
