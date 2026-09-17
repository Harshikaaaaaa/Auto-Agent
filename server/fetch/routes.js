import http from 'http';
import https from 'https';
import { z } from 'zod';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import {
  BlockedRequestError,
  assertAllowedUrl,
  createPinnedLookup,
  resolveAllowedAddresses,
} from '../lib/ssrfGuard.js';

/**
 * Guarded outbound fetch, so workflows can read a web page without the server
 * becoming an open proxy into its own network. See `ssrfGuard.js` for the address
 * policy; this module owns the transport limits.
 *
 * Deliberately narrow:
 *   - GET and HEAD only, so this cannot be used to drive state-changing requests
 *   - text-like responses only, so it cannot be used to smuggle binaries
 *   - hard caps on redirects, time, and bytes
 *   - no caller-supplied headers except a small allowlist, so it cannot forge
 *     Authorization or Cookie against an internal service
 */

/** Response content types that may be returned. */
const ALLOWED_CONTENT_TYPES = [
  'text/',
  'application/json',
  'application/xml',
  'application/xhtml+xml',
  'application/rss+xml',
  'application/atom+xml',
  'application/javascript',
  'application/ld+json',
];

/** Request headers a caller may set. Anything else is dropped. */
const ALLOWED_REQUEST_HEADERS = new Set(['accept', 'accept-language', 'user-agent']);

const DEFAULT_USER_AGENT = 'AutoAgentBot/1.0 (+workflow fetch node)';

const fetchRequestSchema = z.object({
  url: z.string().min(1).max(2048),
  method: z.enum(['GET', 'HEAD']).optional().default('GET'),
  headers: z.record(z.string().max(64), z.string().max(1024)).optional().default({}),
  /** Byte ceiling for this request; capped by FETCH_MAX_BYTES regardless. */
  maxBytes: z.number().int().positive().max(20_000_000).optional(),
});

/** Response headers worth returning. The rest is noise or leaks infrastructure. */
const EXPOSED_RESPONSE_HEADERS = ['content-type', 'content-length', 'last-modified', 'etag'];

function pickResponseHeaders(headers) {
  const picked = {};
  for (const name of EXPOSED_RESPONSE_HEADERS) {
    if (headers[name] !== undefined) picked[name] = headers[name];
  }
  return picked;
}

function isAllowedContentType(contentType) {
  if (!contentType) return true; // Absent is common; the size cap still applies.
  const normalized = String(contentType).toLowerCase();
  return ALLOWED_CONTENT_TYPES.some((prefix) => normalized.startsWith(prefix));
}

function sanitizeRequestHeaders(headers) {
  const safe = { 'user-agent': DEFAULT_USER_AGENT, accept: '*/*' };
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = name.toLowerCase();
    if (ALLOWED_REQUEST_HEADERS.has(lower)) safe[lower] = value;
  }
  return safe;
}

/**
 * Perform one hop, with the destination address pinned.
 * Resolves with either a redirect instruction or the response body.
 */
function requestOnce({ url, method, headers, maxBytes, timeoutMs, resolveAddresses }) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;

    resolveAddresses(url.hostname).then((allowedAddresses) => {
      const request = transport.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method,
          headers: { ...headers, host: url.host },
          // Only ever connects to an address that already passed the policy.
          lookup: createPinnedLookup(allowedAddresses),
          timeout: timeoutMs,
        },
        (response) => {
          const status = response.statusCode ?? 0;
          const location = response.headers.location;

          // Redirects are followed by the caller so each hop is re-validated.
          if (status >= 300 && status < 400 && location) {
            response.resume(); // Drain so the socket can be reused.
            resolve({ kind: 'redirect', status, location });
            return;
          }

          const contentType = response.headers['content-type'];
          if (!isAllowedContentType(contentType)) {
            response.destroy();
            reject(
              new BlockedRequestError(
                `That URL returned "${contentType}", which this node cannot read. Only text-like content is supported.`,
                { reason: 'content_type_not_allowed', url: url.href },
              ),
            );
            return;
          }

          // Reject on the declared length before downloading anything.
          const declaredLength = Number(response.headers['content-length'] ?? NaN);
          if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
            response.destroy();
            reject(
              new BlockedRequestError(
                `That response is ${declaredLength} bytes, over the ${maxBytes} byte limit.`,
                { reason: 'response_too_large', url: url.href },
              ),
            );
            return;
          }

          const chunks = [];
          let received = 0;
          let truncated = false;

          response.on('data', (chunk) => {
            received += chunk.length;
            if (received > maxBytes) {
              // A lying or absent Content-Length is caught here.
              truncated = true;
              response.destroy();
              return;
            }
            chunks.push(chunk);
          });

          response.on('close', () => {
            if (!truncated) return;
            reject(
              new BlockedRequestError(`That response exceeded the ${maxBytes} byte limit.`, {
                reason: 'response_too_large',
                url: url.href,
              }),
            );
          });

          response.on('end', () => {
            if (truncated) return;
            resolve({
              kind: 'response',
              status,
              headers: pickResponseHeaders(response.headers),
              contentType: contentType ?? null,
              body: Buffer.concat(chunks).toString('utf8'),
              bytes: received,
            });
          });

          response.on('error', (err) => reject(err));
        },
      );

      request.on('timeout', () => {
        request.destroy(
          new BlockedRequestError(`That URL did not respond within ${timeoutMs}ms.`, {
            reason: 'timeout',
            url: url.href,
          }),
        );
      });

      request.on('error', (err) => reject(err));
      request.end();
    }, reject);
  });
}

/**
 * Fetch a URL, following redirects with the policy re-applied at every hop.
 *
 * `resolveAddresses` is injectable so tests can point a fake public hostname at a
 * local test server and exercise the transport limits over real HTTP. The HTTP
 * route never passes it, so the production path always uses the guarded
 * resolver. URL validation is deliberately NOT injectable: every hop, including
 * every redirect target, is checked by the real policy.
 */
export async function guardedFetch({
  url: rawUrl,
  method = 'GET',
  headers = {},
  maxBytes,
  resolveAddresses = resolveAllowedAddresses,
}) {
  const effectiveMaxBytes = Math.min(maxBytes ?? env.FETCH_MAX_BYTES, env.FETCH_MAX_BYTES);
  const safeHeaders = sanitizeRequestHeaders(headers);

  let currentUrl = assertAllowedUrl(rawUrl);
  const visited = [currentUrl.href];

  for (let hop = 0; hop <= env.FETCH_MAX_REDIRECTS; hop += 1) {
    const result = await requestOnce({
      url: currentUrl,
      method,
      headers: safeHeaders,
      maxBytes: effectiveMaxBytes,
      timeoutMs: env.FETCH_TIMEOUT_MS,
      resolveAddresses,
    });

    if (result.kind === 'response') {
      return { ...result, finalUrl: currentUrl.href, redirects: visited.slice(1) };
    }

    // A redirect target is fully re-validated: this is the case where a public
    // host bounces the request to 127.0.0.1 or the metadata endpoint.
    const nextUrl = assertAllowedUrl(new URL(result.location, currentUrl).href);

    if (visited.includes(nextUrl.href)) {
      throw new BlockedRequestError('That URL redirects in a loop.', {
        reason: 'redirect_loop',
        url: nextUrl.href,
      });
    }

    visited.push(nextUrl.href);
    currentUrl = nextUrl;
  }

  throw new BlockedRequestError(`That URL redirected more than ${env.FETCH_MAX_REDIRECTS} times.`, {
    reason: 'too_many_redirects',
  });
}

export function setupFetchRoutes(app) {
  app.post('/api/fetch', async (req, res) => {
    const parsed = fetchRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'invalid_request',
        message: 'Provide a "url" to fetch.',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }

    const { url, method, headers, maxBytes } = parsed.data;

    try {
      const result = await guardedFetch({ url, method, headers, maxBytes });
      logger.info(
        { host: new URL(result.finalUrl).host, status: result.status, bytes: result.bytes },
        'fetched external URL',
      );
      return res.json(result);
    } catch (err) {
      if (err instanceof BlockedRequestError) {
        // Deliberately explicit about the reason: an operator needs to know a
        // fetch was refused by policy rather than silently failing.
        logger.warn({ reason: err.reason, url: err.url }, 'blocked outbound fetch');
        return res.status(err.status ?? 400).json({
          error: 'fetch_blocked',
          reason: err.reason,
          message: err.message,
        });
      }

      logger.warn({ err }, 'outbound fetch failed');
      return res.status(502).json({
        error: 'fetch_failed',
        message: 'Could not fetch that URL.',
        retryable: true,
      });
    }
  });
}
