import cors from 'cors';
import helmet from 'helmet';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import pinoHttp from 'pino-http';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * Baseline HTTP hardening.
 *
 * Replaces the previous `cors()` with no arguments, which allowed every origin
 * on the internet to call this API from a victim's browser.
 */

/** Header and body values that must never reach the logs. */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-goog-api-key"]',
  'res.headers["set-cookie"]',
  'req.body.password',
  'req.body.accessToken',
  'req.body.refreshToken',
];

/**
 * CORS restricted to an explicit origin allowlist.
 *
 * `credentials: true` is required for the session cookie, and the CORS spec
 * forbids combining that with a wildcard origin — so an allowlist is mandatory,
 * not optional.
 */
export function buildCors() {
  const allowed = new Set(env.CORS_ALLOWED_ORIGINS);

  // Delegate form so the decision can see the request, not just the Origin
  // string — needed to recognise a SAME-origin request and never block it.
  return cors((req, callback) => {
    const origin = req.headers.origin;
    const base = {
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Accept'],
      maxAge: 600,
    };

    // Non-browser clients (curl, health checks) send no Origin. Allowed; the
    // session check still applies.
    if (!origin) return callback(null, { ...base, origin: true });

    // Same-origin requests are never a CORS threat — CORS exists to guard
    // against OTHER origins. The browser sends an Origin header even on
    // same-origin script/module and fetch requests, so an app served on a host
    // that is not in the allowlist would otherwise block its own assets. Allow
    // when the Origin matches the host the request came in on.
    const host = req.headers.host;
    if (host && (origin === `http://${host}` || origin === `https://${host}`)) {
      return callback(null, { ...base, origin: true });
    }

    // Cross-origin: only the configured allowlist.
    if (allowed.has(origin)) return callback(null, { ...base, origin: true });
    return callback(new CorsOriginError(origin));
  });
}

/** Raised for a disallowed Origin so the error handler can return 403. */
export class CorsOriginError extends Error {
  constructor(origin) {
    super('Origin not allowed by CORS policy.');
    this.name = 'CorsOriginError';
    this.origin = origin;
    this.status = 403;
  }
}

/** Helmet with a CSP tuned for this app's real dependencies. */
export function buildHelmet() {
  return helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // No Google origins here any more. The Google Identity Services script
        // used to be loaded into the page to run OAuth in the browser; Task 13
        // moved the whole flow to the server, so the page loads no third-party
        // script and makes no cross-origin request to Google. Consent happens in
        // a top-level popup, which CSP does not govern.
        scriptSrc: ["'self'"],
        // No CDN style or font origins any more. Task 15 moved Tailwind into a
        // PostCSS build, self-hosted the fonts via bundled @fontsource packages,
        // and imported react-flow's CSS through Vite, so every stylesheet and
        // font is served from our own origin.
        //
        // 'unsafe-inline' stays for styles only: the React tree uses inline
        // `style={...}` attributes and react-flow injects inline styles at
        // runtime to position nodes. Unlike script-src, an inline-style
        // allowance does not permit code execution, so this is a low-risk
        // relaxation and the only one the app genuinely needs.
        styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'", 'data:'],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        connectSrc: ["'self'"],
        frameSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        // Only force-upgrade subresource requests to HTTPS when we are actually
        // serving over HTTPS. Helmet adds this directive by default, but over a
        // plain-HTTP deployment (a local run) it makes the browser request every
        // asset over https:// — which the server does not speak — so the page
        // loads with all its JS/CSS blocked. `null` tells Helmet to omit it.
        // SESSION_COOKIE_SECURE is true exactly when the deployment is HTTPS.
        upgradeInsecureRequests: env.SESSION_COOKIE_SECURE ? [] : null,
      },
    },
    // The app fetches cross-origin images/fonts, so the strictest COEP would
    // break rendering. Kept explicit rather than silently defaulted.
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'no-referrer' },
    hsts: env.NODE_ENV === 'production' ? { maxAge: 15_552_000, includeSubDomains: true } : false,
  });
}

/** A safe request-correlation id: accept an inbound one only if it looks sane. */
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/** Request logging with credentials redacted, and a correlation id per request. */
export function buildRequestLogger() {
  return pinoHttp({
    logger,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    // Correlate every log line for a request, and echo the id back on the
    // response so a client (or a load balancer) can quote it in a bug report.
    // An inbound X-Request-Id is honoured only when it matches a strict charset,
    // so a caller cannot smuggle log-injection or unbounded strings into ours.
    genReqId(req, res) {
      const inbound = req.headers['x-request-id'];
      const id =
        typeof inbound === 'string' && REQUEST_ID_RE.test(inbound) ? inbound : crypto.randomUUID();
      res.setHeader('X-Request-Id', id);
      return id;
    },
    // Health checks are frequent and uninteresting; keep them out of the logs.
    autoLogging: {
      ignore: (req) => req.url === '/healthz' || req.url === '/readyz',
    },
    customLogLevel(_req, res, err) {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
  });
}

/**
 * Build a rate limiter.
 *
 * `ipKeyGenerator` is used rather than a raw `req.ip` so IPv6 addresses are
 * normalised to a subnet — otherwise a single client can trivially rotate
 * through addresses in its own /64 and bypass the limit.
 */
export function buildLimiter({ limit, name }) {
  return rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    // express-rate-limit v7+ uses `limit`; the old `max` option is deprecated
    // and silently ineffective here, which would leave routes unlimited.
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // ipKeyGenerator takes the IP string and normalises IPv6 to a subnet, so a
    // client cannot rotate through its own /64 to reset the counter.
    keyGenerator: (req) => ipKeyGenerator(req.ip ?? 'unknown'),
    handler(req, res) {
      logger.warn({ limiter: name, ip: req.ip, path: req.originalUrl }, 'rate limit exceeded');
      res.status(429).json({
        error: 'rate_limited',
        message: 'Too many requests. Slow down and try again shortly.',
        retryable: true,
      });
    },
  });
}

export function buildLimiters() {
  return {
    /** Broad budget applied to the whole API surface. */
    general: buildLimiter({ limit: env.RATE_LIMIT_MAX, name: 'general' }),
    /** Tighter budget for model calls, which cost money. */
    ai: buildLimiter({ limit: env.RATE_LIMIT_AI_MAX, name: 'ai' }),
    /** Hard budget for login attempts to slow credential guessing. */
    auth: buildLimiter({ limit: env.RATE_LIMIT_AUTH_MAX, name: 'auth' }),
    /** Budget for outbound sends, to cap spam blast radius. */
    send: buildLimiter({ limit: env.RATE_LIMIT_SEND_MAX, name: 'send' }),
    /** Budget for outbound fetches, to cap use as a scanner or scraper. */
    fetch: buildLimiter({ limit: env.RATE_LIMIT_FETCH_MAX, name: 'fetch' }),
    /**
     * Budget for proxied Google calls. Separate from `general` because these
     * spend the operator's own API quota and can send mail.
     */
    google: buildLimiter({ limit: env.RATE_LIMIT_GOOGLE_MAX, name: 'google' }),
  };
}

/**
 * Terminal error handler.
 *
 * Returns a CORS rejection as 403 and never leaks a stack trace to the client —
 * a stack can contain file paths and, in the worst case, credential material.
 */
export function errorHandler(err, req, res, _next) {
  if (res.headersSent) return;

  if (err instanceof CorsOriginError || err?.name === 'CorsOriginError') {
    logger.warn({ origin: err.origin, path: req.originalUrl }, 'blocked disallowed CORS origin');
    return res.status(403).json({
      error: 'origin_not_allowed',
      message: 'This origin is not allowed to call the API.',
    });
  }

  // Body parser failures: malformed JSON or a body over the size limit.
  if (err?.type === 'entity.too.large') {
    return res
      .status(413)
      .json({ error: 'payload_too_large', message: 'Request body is too large.' });
  }
  if (err?.type === 'entity.parse.failed') {
    return res
      .status(400)
      .json({ error: 'invalid_json', message: 'Request body is not valid JSON.' });
  }

  logger.error({ err, path: req.originalUrl }, 'unhandled request error');
  return res.status(500).json({ error: 'internal_error', message: 'Something went wrong.' });
}
