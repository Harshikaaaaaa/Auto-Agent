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

  return cors({
    origin(origin, callback) {
      // Same-origin requests and non-browser clients (curl, health checks) send
      // no Origin header. Those are allowed; the session check still applies.
      if (!origin) return callback(null, true);
      if (allowed.has(origin)) return callback(null, true);
      return callback(new CorsOriginError(origin));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Accept'],
    maxAge: 600,
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
        // Task 15 removes the remaining CDN styles/fonts; until then they are
        // required for the page to render at all.
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdn.jsdelivr.net'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        connectSrc: ["'self'"],
        frameSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
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

/** Request logging with credentials redacted. */
export function buildRequestLogger() {
  return pinoHttp({
    logger,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
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
    return res.status(413).json({ error: 'payload_too_large', message: 'Request body is too large.' });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid_json', message: 'Request body is not valid JSON.' });
  }

  logger.error({ err, path: req.originalUrl }, 'unhandled request error');
  return res.status(500).json({ error: 'internal_error', message: 'Something went wrong.' });
}
