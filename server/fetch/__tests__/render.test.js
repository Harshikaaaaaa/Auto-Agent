import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The render tier (tier-2 headless-browser fetch).
 *
 * Two things must hold, and both are tested here WITHOUT a real browser by
 * mocking the `playwright` module with a fake whose `page.route` handler we can
 * drive:
 *
 *   1. Every request the browser makes — the navigation AND every subresource —
 *      is re-validated against the SSRF policy, because Chromium does its own
 *      DNS and our socket-pinning guard cannot reach it. A request to a blocked
 *      address must be ABORTED, not continued.
 *   2. A successful render returns the same contract as the plain fetch.
 *
 * The `looksLikeEmptyShell` heuristic is a pure function and is tested directly.
 */

const originalEnv = { ...process.env };

/** Requests the fake browser was asked to make, and what the guard decided. */
let routed;

/**
 * A fake Playwright `chromium` whose page records every URL passed through the
 * route handler and whether it was continued or aborted. `page.content()`
 * returns the HTML the test sets.
 */
function makeFakePlaywright(renderedHtml, subresourceUrls = []) {
  let routeHandler = null;

  const page = {
    route: vi.fn(async (_pattern, handler) => {
      routeHandler = handler;
    }),
    goto: vi.fn(async (url) => {
      // Drive the navigation and any subresources through the registered guard,
      // exactly as a real browser would.
      for (const requestUrl of [url, ...subresourceUrls]) {
        const route = {
          request: () => ({ url: () => requestUrl }),
          continue: vi.fn(() => routed.push({ url: requestUrl, action: 'continue' })),
          abort: vi.fn(() => routed.push({ url: requestUrl, action: 'abort' })),
        };
        // eslint-disable-next-line no-await-in-loop
        await routeHandler(route);
      }
      return {
        status: () => 200,
        headers: () => ({ 'content-type': 'text/html; charset=utf-8' }),
      };
    }),
    waitForLoadState: vi.fn(async () => {}),
    url: vi.fn(() => 'https://rendered.example/'),
    content: vi.fn(async () => renderedHtml),
  };

  const context = { newPage: vi.fn(async () => page), close: vi.fn(async () => {}) };
  const browser = { newContext: vi.fn(async () => context), close: vi.fn(async () => {}) };

  return { chromium: { launch: vi.fn(async () => browser) }, __page: page };
}

beforeAll(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, {
    AUTOAGENT_SKIP_ENV_FILES: '1',
    AI_PROVIDER: 'ollama',
    APP_PASSWORD: 'test-operator-password',
    SESSION_SECRET: 'h'.repeat(64),
    LOG_LEVEL: 'silent',
    FETCH_RENDER_ENABLED: 'true',
    FETCH_RENDER_TIMEOUT_MS: '5000',
    FETCH_RENDER_SETTLE_MS: '0',
    FETCH_MAX_BYTES: '2000000',
  });
});

afterAll(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  vi.resetModules();
  vi.doUnmock('playwright');
});

afterEach(() => {
  routed = [];
  vi.resetModules();
  vi.doUnmock('playwright');
});

/**
 * A resolver that allows one fake public host and defers everything else to the
 * real policy — so the "blocked subresource" case is judged by the real guard,
 * not a stub, which is what makes the test meaningful.
 */
const ALLOWED_HOST = 'good.example';
const resolveForRender = async (hostname) => {
  if (hostname === ALLOWED_HOST) return [{ address: '93.184.216.34', family: 4 }];
  const { resolveAllowedAddresses } = await import('../../lib/ssrfGuard.js');
  return resolveAllowedAddresses(hostname);
};

describe('looksLikeEmptyShell', () => {
  it('flags a script-bearing page with almost no visible text', async () => {
    const { looksLikeEmptyShell } = await import('../render.js');
    const shell =
      '<html><head><title>App</title></head><body><div id="root"></div>' +
      '<script src="/app.js"></script></body></html>';
    expect(looksLikeEmptyShell(shell)).toBe(true);
  });

  it('flags an empty or whitespace document', async () => {
    const { looksLikeEmptyShell } = await import('../render.js');
    expect(looksLikeEmptyShell('')).toBe(true);
    expect(looksLikeEmptyShell('   \n  ')).toBe(true);
  });

  it('does NOT flag a static page that already has its content', async () => {
    const { looksLikeEmptyShell } = await import('../render.js');
    const full =
      '<html><body><h1>Product Reviews</h1><p>' +
      'The widget arrived quickly and works exactly as described. '.repeat(6) +
      '</p></body></html>';
    expect(looksLikeEmptyShell(full)).toBe(false);
  });

  it('does NOT flag a short page that has no scripts to run', async () => {
    const { looksLikeEmptyShell } = await import('../render.js');
    // Nothing for a browser to execute, so rendering would add nothing.
    expect(looksLikeEmptyShell('<html><body>Hi</body></html>')).toBe(false);
  });
});

describe('renderFetch re-validates every browser request against the SSRF policy', () => {
  it('continues an allowed navigation and returns the rendered contract', async () => {
    routed = [];
    vi.doMock('playwright', () => makeFakePlaywright('<html><body>rendered content</body></html>'));
    vi.resetModules();
    const { renderFetch } = await import('../render.js');

    const result = await renderFetch({
      url: `https://${ALLOWED_HOST}/page`,
      resolveAddresses: resolveForRender,
    });

    // The navigation was allowed.
    expect(routed).toContainEqual({ url: `https://${ALLOWED_HOST}/page`, action: 'continue' });
    // Same success contract as the plain fetch, plus the rendered marker.
    expect(result.status).toBe(200);
    expect(result.body).toContain('rendered content');
    expect(result.contentType).toContain('text/html');
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.rendered).toBe(true);
    expect(typeof result.finalUrl).toBe('string');
  });

  it('ABORTS a subresource that resolves to the cloud metadata endpoint', async () => {
    routed = [];
    // The page tries to load a subresource from the metadata IP — the classic
    // SSRF target. The real policy must reject it even though the top-level
    // navigation host is allowed.
    vi.doMock('playwright', () =>
      makeFakePlaywright('<html><body>ok</body></html>', [
        'http://169.254.169.254/latest/meta-data/',
      ]),
    );
    vi.resetModules();
    const { renderFetch } = await import('../render.js');

    await renderFetch({
      url: `https://${ALLOWED_HOST}/page`,
      resolveAddresses: resolveForRender,
    });

    const metadata = routed.find((r) => r.url.includes('169.254.169.254'));
    expect(metadata).toBeDefined();
    expect(metadata.action).toBe('abort');
  });

  it('ABORTS a subresource pointing at a private RFC1918 address', async () => {
    routed = [];
    vi.doMock('playwright', () =>
      makeFakePlaywright('<html><body>ok</body></html>', ['http://10.0.0.5/internal']),
    );
    vi.resetModules();
    const { renderFetch } = await import('../render.js');

    await renderFetch({
      url: `https://${ALLOWED_HOST}/page`,
      resolveAddresses: resolveForRender,
    });

    const internal = routed.find((r) => r.url.includes('10.0.0.5'));
    expect(internal.action).toBe('abort');
  });

  it('refuses a blocked entry URL before launching a page', async () => {
    routed = [];
    const fake = makeFakePlaywright('<html><body>never</body></html>');
    vi.doMock('playwright', () => fake);
    vi.resetModules();
    const { renderFetch } = await import('../render.js');

    await expect(
      renderFetch({ url: 'http://169.254.169.254/latest/meta-data/' }),
    ).rejects.toMatchObject({ name: 'BlockedRequestError' });

    // No browser work happened for a target that never passes the entry gate.
    expect(fake.chromium.launch).not.toHaveBeenCalled();
  });
});
