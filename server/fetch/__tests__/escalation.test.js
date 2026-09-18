import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'http';

/**
 * The tier-1 -> tier-2 decision in `fetchWithOptionalRender`.
 *
 * A real local HTTP server stands in for the remote site (so tier-1 runs for
 * real over HTTP), and `renderImpl` is injected so tier-2 is observed without a
 * browser. `resolveAddresses` points the fake public host at the local server,
 * exactly as guardedFetch.test.js does.
 */

const originalEnv = { ...process.env };
const TEST_HOST = 'test-site.example';

let server;
let port;
let mod;
let handler = (_req, res) => res.end('ok');

const SHELL =
  '<html><head><title>App</title></head><body><div id="root"></div><script src="/a.js"></script></body></html>';
const FULL =
  '<html><body><h1>Real Article</h1><p>' +
  'This page was served with all of its content already present. '.repeat(6) +
  '</p></body></html>';

async function loadModule({ renderEnabled }) {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, {
    AUTOAGENT_SKIP_ENV_FILES: '1',
    AI_PROVIDER: 'ollama',
    APP_PASSWORD: 'test-operator-password',
    SESSION_SECRET: 'h'.repeat(64),
    LOG_LEVEL: 'silent',
    FETCH_MAX_BYTES: '2000000',
    FETCH_MAX_REDIRECTS: '3',
    FETCH_TIMEOUT_MS: '2000',
    FETCH_RENDER_ENABLED: renderEnabled ? 'true' : 'false',
  });
  vi.resetModules();
  return import('../routes.js');
}

beforeAll(async () => {
  server = http.createServer((req, res) => handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  vi.resetModules();
});

afterEach(() => {
  handler = (_req, res) => res.end('ok');
});

const resolveToTestServer = async (hostname) => {
  if (hostname === TEST_HOST) return [{ address: '127.0.0.1', family: 4 }];
  const { resolveAllowedAddresses } = await import('../../lib/ssrfGuard.js');
  return resolveAllowedAddresses(hostname);
};

/** A renderImpl that records it was called and returns a rendered page. */
function fakeRender(html = '<html><body>rendered by browser</body></html>') {
  const impl = vi.fn(async ({ url }) => ({
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    contentType: 'text/html; charset=utf-8',
    body: html,
    bytes: Buffer.byteLength(html),
    finalUrl: url,
    redirects: [],
    rendered: true,
  }));
  return impl;
}

const call = (routes, opts = {}) =>
  routes.fetchWithOptionalRender(
    { url: `http://${TEST_HOST}:${port}/page`, method: 'GET', headers: {}, ...opts },
    { renderImpl: opts.renderImpl, resolveAddresses: resolveToTestServer },
  );

describe('when rendering is disabled', () => {
  it('never renders, even for a JS shell', async () => {
    mod = await loadModule({ renderEnabled: false });
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(SHELL);
    };
    const render = fakeRender();

    const result = await call(mod, { render: 'auto', renderImpl: render });

    expect(render).not.toHaveBeenCalled();
    expect(result.body).toContain('id="root"'); // the plain shell, unrendered
    expect(result.rendered).toBeUndefined();
  });
});

describe('when rendering is enabled', () => {
  it('escalates a JS shell to the render tier (render=auto)', async () => {
    mod = await loadModule({ renderEnabled: true });
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(SHELL);
    };
    const render = fakeRender();

    const result = await call(mod, { render: 'auto', renderImpl: render });

    expect(render).toHaveBeenCalledTimes(1);
    expect(result.rendered).toBe(true);
    expect(result.body).toContain('rendered by browser');
  });

  it('does NOT escalate a page that already has content (render=auto)', async () => {
    mod = await loadModule({ renderEnabled: true });
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(FULL);
    };
    const render = fakeRender();

    const result = await call(mod, { render: 'auto', renderImpl: render });

    expect(render).not.toHaveBeenCalled();
    expect(result.body).toContain('Real Article');
  });

  it('renders straight away when render=always', async () => {
    mod = await loadModule({ renderEnabled: true });
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(FULL); // even though tier-1 would have content
    };
    const render = fakeRender();

    const result = await call(mod, { render: 'always', renderImpl: render });

    expect(render).toHaveBeenCalledTimes(1);
    expect(result.rendered).toBe(true);
  });

  it('never renders when render=never', async () => {
    mod = await loadModule({ renderEnabled: true });
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(SHELL);
    };
    const render = fakeRender();

    const result = await call(mod, { render: 'never', renderImpl: render });

    expect(render).not.toHaveBeenCalled();
    expect(result.body).toContain('id="root"');
  });

  it('falls back to the plain result when rendering throws', async () => {
    mod = await loadModule({ renderEnabled: true });
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(SHELL);
    };
    const render = vi.fn(async () => {
      throw new Error('browser crashed');
    });

    // A partial success must not become a hard failure.
    const result = await call(mod, { render: 'auto', renderImpl: render });

    expect(render).toHaveBeenCalledTimes(1);
    expect(result.body).toContain('id="root"'); // the plain shell survived
  });

  it('does not render a non-HTML response', async () => {
    mod = await loadModule({ renderEnabled: true });
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"data":[]}');
    };
    const render = fakeRender();

    const result = await call(mod, { render: 'auto', renderImpl: render });

    expect(render).not.toHaveBeenCalled();
    expect(result.body).toContain('"data"');
  });
});
