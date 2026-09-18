import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Task 18: the server serves the built SPA from its own origin.
 *
 * These assert the mount behaviour that the single-container deploy relies on:
 * a real file is served, an unknown client route falls back to the app shell,
 * /api and health paths are NOT swallowed by that fallback, and the whole thing
 * is a no-op when there is no build.
 */

const originalEnv = { ...process.env };

let serveFrontend;
let tmpDist;

beforeAll(async () => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, {
    AUTOAGENT_SKIP_ENV_FILES: '1',
    AI_PROVIDER: 'ollama',
    AUTH_ENABLED: 'false',
    APP_PASSWORD: 'test-operator-password',
    SESSION_SECRET: 'c'.repeat(64),
    LOG_LEVEL: 'silent',
  });
  ({ serveFrontend } = await import('../frontend.js'));
});

afterAll(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

afterEach(() => {
  if (tmpDist && fs.existsSync(tmpDist)) fs.rmSync(tmpDist, { recursive: true, force: true });
  tmpDist = undefined;
});

function makeDist() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoagent-dist-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>AutoAgent</title>');
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'assets', 'app-abc123.js'), 'console.log("app");');
  return dir;
}

async function listen(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { server, baseUrl };
}

describe('serveFrontend', () => {
  it('is a no-op when no build exists', async () => {
    const app = express();
    const mounted = serveFrontend(app, path.join(os.tmpdir(), 'does-not-exist-autoagent'));
    expect(mounted).toBe(false);
  });

  it('serves the app shell and static assets, and falls back for client routes', async () => {
    tmpDist = makeDist();
    const app = express();

    // A stand-in API route registered BEFORE the frontend, as in api.js.
    app.get('/api/ping', (_req, res) => res.json({ ok: true }));
    app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

    const mounted = serveFrontend(app, tmpDist);
    expect(mounted).toBe(true);

    const { server, baseUrl } = await listen(app);
    try {
      // A real static asset is served with a long cache.
      const asset = await fetch(`${baseUrl}/assets/app-abc123.js`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get('cache-control')).toContain('max-age=31536000');

      // An unknown client route returns the app shell (SPA history fallback).
      const route = await fetch(`${baseUrl}/some/client/route`);
      expect(route.status).toBe(200);
      expect(await route.text()).toContain('AutoAgent');
      expect(route.headers.get('cache-control')).toContain('no-cache');

      // The API route still wins — the fallback must not swallow it.
      const api = await fetch(`${baseUrl}/api/ping`);
      expect(api.status).toBe(200);
      expect((await api.json()).ok).toBe(true);

      // An unknown /api path is a genuine 404, not the HTML shell.
      const missingApi = await fetch(`${baseUrl}/api/nope`);
      expect(missingApi.status).toBe(404);
      expect(await missingApi.text()).not.toContain('AutoAgent');

      // Health paths are excluded from the fallback too.
      const health = await fetch(`${baseUrl}/healthz`);
      expect(health.status).toBe(200);
      expect((await health.json()).status).toBe('ok');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
