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

/** A pragmatic email check for the signup/login handle. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * A well-formed scrypt hash of a value no one uses, so the login path can run a
 * verify even when the account does not exist — keeping the timing of "no such
 * user" indistinguishable from "wrong password". (scrypt$N$r$p$salt$hash)
 */
const DUMMY_HASH =
  'scrypt$131072$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

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
  const ha = crypto
    .createHash('sha256')
    .update(String(a ?? ''))
    .digest();
  const hb = crypto
    .createHash('sha256')
    .update(String(b ?? ''))
    .digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Build a signed session token for a subject. */
export function createSessionToken(subject = OPERATOR_SUBJECT, role = 'user', now = Date.now()) {
  const payload = {
    sub: subject,
    role: role === 'admin' ? 'admin' : 'user',
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
  // A token minted before roles existed has no `role`; treat it as a plain user.
  if (payload.role !== 'admin') payload.role = 'user';

  return payload;
}

/** Cookie options shared by set and clear so they always match. */
function cookieOptions() {
  return {
    httpOnly: true,
    secure: env.SESSION_COOKIE_SECURE,
    // 'lax', not 'strict': the Google OAuth callback is a top-level cross-site
    // GET navigation (accounts.google.com -> /api/oauth/google/callback), and
    // that route is session-gated because it writes the credential. Under
    // 'strict' the browser withholds the session cookie on that navigation, so
    // the callback always failed with 'unauthenticated' and no tool could ever
    // connect. 'lax' still withholds the cookie on cross-site POST — every
    // mutating endpoint (/api/ai, /api/google/call, /api/workflows) is a POST,
    // so CSRF on those stays closed. The one state-changing GET, the callback,
    // has its own CSRF defence: the OAuth `state` echo plus PKCE, both checked
    // before anything is written.
    sameSite: 'lax',
    path: '/',
    maxAge: env.SESSION_TTL_HOURS * 3600 * 1000,
  };
}

export function setSessionCookie(res, subject = OPERATOR_SUBJECT, role = 'user') {
  res.cookie(SESSION_COOKIE_NAME, createSessionToken(subject, role), cookieOptions());
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
    // Dev bypass is admin so a local server can reach every route.
    req.session = { sub: DEV_SUBJECT, role: 'admin', authDisabled: true };
    return next();
  }
  const payload = verifySessionToken(req.cookies?.[SESSION_COOKIE_NAME]);
  req.session = payload ? { sub: payload.sub, role: payload.role, exp: payload.exp } : null;
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
    req.session = { sub: DEV_SUBJECT, role: 'admin', authDisabled: true };
    return next();
  }

  const payload = verifySessionToken(req.cookies?.[SESSION_COOKIE_NAME]);
  if (!payload) {
    return res.status(401).json({
      error: 'unauthenticated',
      message: 'Sign in to use this endpoint.',
    });
  }

  req.session = { sub: payload.sub, role: payload.role, exp: payload.exp };
  return next();
}

/**
 * Reject the request unless the session belongs to an admin.
 *
 * Composes AFTER requireSession (which sets req.session). A missing or
 * non-admin session gets 403 — deliberately the same shape for both so a
 * probe cannot distinguish "not logged in" from "not an admin".
 */
export function requireAdmin(req, res, next) {
  if (req.session?.role !== 'admin') {
    return res.status(403).json({
      error: 'forbidden',
      message: 'Administrator access is required.',
    });
  }
  return next();
}

/**
 * Auth routes: email + password accounts backed by the users table.
 *
 * The legacy single-operator `APP_PASSWORD` login is gone; the operator is now
 * a bootstrapped admin *user* (see server/db/bootstrapAdmin.js) and signs in
 * with an email like everyone else. When AUTH_ENABLED is false the dev bypass
 * still short-circuits every route with a synthetic admin session.
 *
 * @param {import('express').Express} app
 * @param {{ loginLimiter?: import('express').RequestHandler }} options
 */
export function setupAuthRoutes(app, { loginLimiter } = {}) {
  const limiters = loginLimiter ? [loginLimiter] : [];

  app.post('/api/auth/signup', ...limiters, async (req, res) => {
    if (!env.AUTH_ENABLED) {
      return res.json({ authenticated: true, user: { id: DEV_SUBJECT, role: 'admin' } });
    }
    const email = req.body?.email;
    const password = req.body?.password;
    if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
      return res
        .status(400)
        .json({ error: 'invalid_request', message: 'A valid email is required.' });
    }
    if (typeof password !== 'string' || password.length < 8) {
      return res
        .status(400)
        .json({ error: 'invalid_request', message: 'Password must be at least 8 characters.' });
    }

    try {
      const { createUser } = await import('../db/userRepository.js');
      const { grantSignupCredits } = await import('../billing/signupGrant.js');
      const { user } = await createUser({ email, password, role: 'user' });
      // A new account gets its wallet, free signup credits, and Free plan.
      await grantSignupCredits(user.ownerId);
      setSessionCookie(res, user.ownerId, user.role);
      return res.status(201).json({
        authenticated: true,
        user: { id: user.ownerId, email: user.email, role: user.role },
      });
    } catch (err) {
      if (err?.name === 'EmailTakenError') {
        return res.status(409).json({ error: 'email_taken', message: err.message });
      }
      return res
        .status(500)
        .json({ error: 'internal_error', message: 'Could not create the account.' });
    }
  });

  app.post('/api/auth/login', ...limiters, async (req, res) => {
    if (!env.AUTH_ENABLED) {
      return res.json({ authenticated: true, user: { id: DEV_SUBJECT, role: 'admin' } });
    }

    const email = req.body?.email;
    const password = req.body?.password;
    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
      return res
        .status(400)
        .json({ error: 'invalid_request', message: 'Email and password are required.' });
    }

    const { findAuthByEmail } = await import('../db/userRepository.js');
    const { verifyPassword } = await import('./password.js');
    const row = await findAuthByEmail(email);
    // Verify against a dummy hash even when the user is absent, so a missing
    // account and a wrong password take the same time (no user enumeration).
    const ok = row
      ? verifyPassword(password, row.password_hash)
      : verifyPassword(password, DUMMY_HASH) && false;
    if (!row || !ok) {
      return res
        .status(401)
        .json({ error: 'invalid_credentials', message: 'Incorrect email or password.' });
    }
    if (row.status !== 'active') {
      return res
        .status(403)
        .json({ error: 'account_disabled', message: 'This account is not active.' });
    }

    setSessionCookie(res, row.owner_id, row.role);
    return res.json({
      authenticated: true,
      user: { id: row.owner_id, email: row.email, role: row.role },
    });
  });

  app.get('/api/auth/verify', async (req, res) => {
    const { verifyEmailToken } = await import('../db/userRepository.js');
    const ownerId = await verifyEmailToken(String(req.query.token ?? ''));
    if (!ownerId) {
      return res
        .status(400)
        .json({ error: 'invalid_token', message: 'That verification link is invalid or expired.' });
    }
    return res.json({ verified: true });
  });

  app.post('/api/auth/logout', (req, res) => {
    clearSessionCookie(res);
    return res.json({ authenticated: false });
  });

  app.get('/api/auth/me', attachSession, async (req, res) => {
    if (!req.session) {
      return res.status(401).json({ authenticated: false, authRequired: true });
    }
    if (req.session.authDisabled) {
      return res.json({
        authenticated: true,
        user: { id: req.session.sub, role: 'admin' },
        authDisabled: true,
      });
    }
    const { findUserByOwnerId } = await import('../db/userRepository.js');
    const user = await findUserByOwnerId(req.session.sub);
    return res.json({
      authenticated: true,
      user: user
        ? {
            id: user.ownerId,
            email: user.email,
            role: user.role,
            emailVerified: user.emailVerified,
          }
        : { id: req.session.sub, role: req.session.role },
    });
  });
}
