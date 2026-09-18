import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import {
  BlockedRequestError,
  assertAllowedUrl,
  assertNavigationAllowed,
} from '../lib/ssrfGuard.js';

/**
 * Tier-2 fetch: render a page with a headless browser so JavaScript-built
 * content (React/Next/Vue SPAs, lazy-loaded articles) is present before we read
 * the DOM. Tier-1 (server/fetch/routes.js) does a plain HTTP GET and gets only
 * the server-sent HTML — an empty shell for a client-rendered page. This module
 * fills that gap.
 *
 * SECURITY — why this needs its own guard.
 *
 * The tier-1 guard pins Node's socket to an already-validated IP so DNS
 * rebinding cannot reach a private address. That primitive does NOT reach
 * Chromium: the browser resolves DNS itself and follows its own redirects and
 * subresource loads. So this tier re-validates EVERY request the browser makes
 * — the top-level navigation and every image/script/xhr — through the same SSRF
 * policy, and aborts anything that resolves to a blocked address. A page cannot
 * use the browser to reach loopback, an RFC1918 host, or the cloud metadata
 * endpoint, because each of those requests is checked and aborted.
 *
 * Playwright is imported lazily so this module (and the whole server) loads even
 * when Playwright is not installed and rendering is disabled — the default,
 * slim deployment never pays for it.
 */

/** The shared browser, launched on first use and reused across requests. */
let browserPromise = null;

/**
 * Load Playwright's chromium launcher, or explain why it is unavailable.
 * Kept out of the module's static imports so a build without Playwright works.
 */
async function loadChromium() {
  try {
    const mod = await import('playwright');
    return mod.chromium;
  } catch {
    throw new BlockedRequestError(
      'JavaScript rendering is enabled but Playwright is not installed in this image.',
      { reason: 'render_unavailable' },
    );
  }
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = (async () => {
      const chromium = await loadChromium();
      return chromium.launch({
        headless: true,
        // Hardening flags for running Chromium in a container as an unprivileged
        // user. --no-sandbox is required when the kernel user-namespace sandbox
        // is unavailable in the container; the SSRF request guard below, not the
        // Chromium sandbox, is what contains where the browser may connect.
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      });
    })().catch((err) => {
      // Let the next call retry a failed launch rather than caching the failure.
      browserPromise = null;
      throw err;
    });
  }
  return browserPromise;
}

/** Close the shared browser. Called on shutdown; safe to call when never launched. */
export async function closeRenderBrowser() {
  if (!browserPromise) return;
  const pending = browserPromise;
  browserPromise = null;
  try {
    const browser = await pending;
    await browser.close();
  } catch {
    // Already gone, or never fully launched. Nothing to clean up.
  }
}

/**
 * Render a URL and return the SAME contract as the plain fetch:
 * `{ status, headers, contentType, body, bytes, finalUrl, redirects }`.
 *
 * `resolveAddresses` is injectable for tests (mirroring guardedFetch), so a fake
 * public host can point at a local server while the real policy still judges
 * every other host.
 *
 * @param {{ url: string, resolveAddresses?: Function }} options
 */
export async function renderFetch({ url: rawUrl, resolveAddresses }) {
  // Validate the entry URL up front with the full policy (shape + DNS), so an
  // obviously-blocked target fails before we spin up a page.
  const entry = await assertNavigationAllowed(rawUrl, resolveAddresses);
  if (!entry.allowed) {
    throw new BlockedRequestError(entry.message, { reason: entry.reason, url: String(rawUrl) });
  }
  const startUrl = assertAllowedUrl(rawUrl);

  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: 'AutoAgentBot/1.0 (+workflow render node)',
    javaScriptEnabled: true,
    // Do not carry or persist any cookies/storage between renders.
    storageState: undefined,
  });

  try {
    const page = await context.newPage();

    // Re-validate EVERY request the browser makes against the SSRF policy. This
    // is the guarantee that Chromium's own DNS/redirects/subresources cannot be
    // used to reach an internal address.
    await page.route('**/*', async (route) => {
      const requestUrl = route.request().url();
      // data: and about: are inert and never hit the network.
      if (requestUrl.startsWith('data:') || requestUrl.startsWith('about:')) {
        return route.continue();
      }
      const verdict = await assertNavigationAllowed(requestUrl, resolveAddresses);
      if (verdict.allowed) return route.continue();
      logger.warn(
        { url: requestUrl, reason: verdict.reason },
        'render tier aborted a request to a blocked address',
      );
      return route.abort('blockedbyclient');
    });

    let response;
    try {
      response = await page.goto(startUrl.href, {
        waitUntil: 'domcontentloaded',
        timeout: env.FETCH_RENDER_TIMEOUT_MS,
      });
    } catch {
      throw new BlockedRequestError(
        `The page could not be rendered within ${env.FETCH_RENDER_TIMEOUT_MS}ms.`,
        { reason: 'render_timeout', url: startUrl.href },
      );
    }

    // Give client-side scripts a moment to populate the DOM, best-effort: a page
    // that never goes idle should still return whatever rendered by the timeout.
    if (env.FETCH_RENDER_SETTLE_MS > 0) {
      await page
        .waitForLoadState('networkidle', { timeout: env.FETCH_RENDER_SETTLE_MS })
        .catch(() => {});
    }

    const finalUrl = page.url();
    // The rendered DOM as HTML — this is what the existing extractor reads.
    const body = await page.content();

    // Enforce the same size ceiling as tier-1, measured on the rendered output.
    const bytes = Buffer.byteLength(body, 'utf8');
    if (bytes > env.FETCH_MAX_BYTES) {
      throw new BlockedRequestError(
        `The rendered page is ${bytes} bytes, over the ${env.FETCH_MAX_BYTES} byte limit.`,
        { reason: 'response_too_large', url: finalUrl },
      );
    }

    const status = response?.status() ?? 200;
    const contentType = response?.headers()?.['content-type'] ?? 'text/html; charset=utf-8';

    return {
      status,
      headers: { 'content-type': contentType },
      contentType,
      body,
      bytes,
      finalUrl,
      // The browser followed redirects internally; the final URL captures them.
      redirects: finalUrl === startUrl.href ? [] : [finalUrl],
      rendered: true,
    };
  } finally {
    await context.close();
  }
}

/**
 * Does this HTML look like an empty client-rendered shell — the case tier-2 is
 * for? A React/Next/Vue app served without SSR returns a page that is almost all
 * `<script>` and a near-empty `<body>`, so the extractor finds no text. The
 * heuristic: little visible text AND scripts present. Deliberately conservative,
 * so a genuinely short static page is not needlessly re-rendered.
 *
 * @param {string} html Raw HTML from the plain fetch.
 * @returns {boolean}
 */
export function looksLikeEmptyShell(html) {
  const source = String(html ?? '');
  if (source.trim().length === 0) return true;

  const hasScript = /<script[\s>]/i.test(source);
  if (!hasScript) return false; // No JS to run: rendering would not add anything.

  // Strip script/style/head, then tags, and see how much visible text is left.
  const body = source
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Under ~200 visible characters on a script-bearing page is almost always a
  // shell waiting for JavaScript to fill it in.
  return body.length < 200;
}
