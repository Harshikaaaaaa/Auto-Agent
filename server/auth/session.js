import crypto from 'crypto';
import { env } from '../config/env.js';

/**
 * Session handling for the single-operator deployment.
 *
 * Design: a stateless, HMAC-signed cookie. There is no session table, so
 * sessions survive a restart and there is nothing to garbage collect. The
 * trade-off is that an individual session cannot be revoked server-side before
 * it expires — rotating SESSION_SECRET invalidates every session at once, which
 * is the intended break-glass control for a single-operator tool.
 *
 * The cookie is httpOnly (JavaScript cannot read it, so an XSS cannot exfiltrate
 * it), Secure in production, and SameSite=Strict (a cross-site POST cannot carry
 * it, which is what protects state-changing routes from CSRF).
 *
 * Task 13 layers Google OAuth on top of this and stores per-connector refresh
 * tokens keyed to `session.sub`.
 */

export const SESSION_COOKIE_NAME = 'autoagent_session';

/** Subject used when auth is disabled for local development. */
const DEV_SUBJECT = 'local-dev';
/** Subject for the single configured operator. */
export const OPERATOR_SUBJECT = 'operator';

function base64UrlEncode(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function sign(payloadB64) {
  return crypto
    .createHmac('sha256', env.SESSION_SECRET ?? 'unset-secret-auth-disabled')
    .update(payloadB64)
    .digest('base64url');
}

/**
 * Compare two strings without leaking length or content through timing.
 * Both sides are hashed first so `timingSafeEqual` always sees equal lengths.
 */
export function safeCompare(a, b) {
  const ha = crypto.createHash('sha256').update(String(a ?? '')).digest();
  const hb = crypto.createHash('sha256').update(String(b ?? '')).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Build a signed session token for a subject. */
export function createSessionToken(subject = OPERATOR_SUBJECT, now = Date.now()) {
  const payload = {
    sub: subject,
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + env.SESSION_TTL_HOURS * 3600,
  };
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  return `${payloadB64}.${sign(payloadB64)}`;
}

/**
 * Verify a session token.
 * @returns the payload, or null when missing, tampered with, or expired.
 */
export function verifySessionToken(token, now = Date.now()) {
  if (typeof token !== 'string' || !token.includes('.')) return null;

  const [payloadB64, signature] = token.split('.', 2);
  if (!payloadB64 || !signature) return null;

  const expected = sign(payloadB64);
  // Constant-time comparison: comparing with === would leak signature bytes
  // through timing, letting an attacker forge a signature byte by byte.
  try {
    const matches = crypto.timingSafeEqual(
      Buffer.from(signature, 'base64url'),
      Buffer.from(expected, 'base64url'),
    );
    if (!matches) return null;
  } catch {
    return null; // Length mismatch means it cannot be valid.
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (!payload?.sub || typeof payload.exp !== 'number') return null;
  if (payload.exp * 1000 <= now) return null;

  return payload;
}

/** Cookie options shared by set and clear so they always match. */
function cookieOptions() {
  return {
    httpOnly: true,
    secure: env.SESSION_COOKIE_SECURE,
    sameSite: 'strict',
    path: '/',
    maxAge: env.SESSION_TTL_HOURS * 3600 * 1000,
  };
}

export function setSessionCookie(res, subject = OPERATOR_SUBJECT) {
  res.cookie(SESSION_COOKIE_NAME, createSessionToken(subject), cookieOptions());
}

export function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE_NAME, { ...cookieOptions(), maxAge: undefined });
}

/**
 * Attach `req.session` when a valid cookie is present. Never rejects.
 * Useful for routes that behave differently but do not require a login.
 */
export function attachSession(req, _res, next) {
  if (!env.AUTH_ENABLED) {
    req.session = { sub: DEV_SUBJECT, authDisabled: true };
    return next();
  }
  const payload = verifySessionToken(req.cookies?.[SESSION_COOKIE_NAME]);
  req.session = payload ? { sub: payload.sub, exp: payload.exp } : null;
  return next();
}

/**
 * Reject the request unless a valid session is present.
 *
 * When AUTH_ENABLED is false this passes through with a synthetic dev session.
 * That combination is rejected at startup for production (see env.js), so it can
 * only ever weaken a local development server.
 */
export function requireSession(req, res, next) {
  if (!env.AUTH_ENABLED) {
    req.session = { sub: DEV_SUBJECT, authDisabled: true };
    return next();
  }

  const payload = verifySessionToken(req.cookies?.[SESSION_COOKIE_NAME]);
  if (!payload) {
    return res.status(401).json({
      error: 'unauthenticated',
      message: 'Sign in to use this endpoint.',
    });
  }

  req.session = { sub: payload.sub, exp: payload.exp };
  return next();
}

/**
 * Auth routes.
 * @param {import('express').Express} app
 * @param {{ loginLimiter?: import('express').RequestHandler }} options
 */
export function setupAuthRoutes(app, { loginLimiter } = {}) {
  const limiters = loginLimiter ? [loginLimiter] : [];

  app.post('/api/auth/login', ...limiters, (req, res) => {
    if (!env.AUTH_ENABLED) {
      return res.json({ authenticated: true, user: { id: DEV_SUBJECT }, authDisabled: true });
    }

    const password = req.body?.password;
    if (typeof password !== 'string' || password.length === 0) {
      return res.status(400).json({ error: 'invalid_request', message: 'Password is required.' });
    }

    if (!safeCompare(password, env.APP_PASSWORD)) {
      // Deliberately generic: do not reveal whether a password was close.
      return res.status(401).json({ error: 'invalid_credentials', message: 'Incorrect password.' });
    }

    setSessionCookie(res, OPERATOR_SUBJECT);
    return res.json({ authenticated: true, user: { id: OPERATOR_SUBJECT } });
  });

  app.post('/api/auth/logout', (req, res) => {
    clearSessionCookie(res);
    return res.json({ authenticated: false });
  });

  app.get('/api/auth/me', attachSession, (req, res) => {
    if (!req.session) {
      return res.status(401).json({ authenticated: false, authRequired: true });
    }
    return res.json({
      authenticated: true,
      user: { id: req.session.sub },
      authDisabled: Boolean(req.session.authDisabled),
    });
  });
}
