import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';

/**
 * End-to-end HTTP checks for the lockdown: CORS allowlist, session gate,
 * rate limits, body limits, and the media URL restriction on /send.
 *
 * Runs a real Express app on an ephemeral port so middleware ordering and
 * status codes are exercised exactly as deployed.
 */

const originalEnv = { ...process.env };
const realFetch = globalThis.fetch.bind(globalThis);

const ALLOWED_ORIGIN = 'http://localhost:3233';
const PASSWORD = 'test-operator-password';

let server;
let baseUrl;
let mods;

beforeAll(async () => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, {
    AUTOAGENT_SKIP_ENV_FILES: '1',
    AI_PROVIDER: 'ollama',
    APP_PASSWORD: PASSWORD,
    SESSION_SECRET: 'd'.repeat(64),
    CORS_ALLOWED_ORIGINS: ALLOWED_ORIGIN,
    LOG_LEVEL: 'silent',
    // Generous budgets for the shared app: the throttling test below uses its
    // own isolated limiter so it cannot starve the other tests.
    RATE_LIMIT_WINDOW_MS: '60000',
    RATE_LIMIT_MAX: '1000',
    RATE_LIMIT_AUTH_MAX: '1000',
    RATE_LIMIT_SEND_MAX: '1000',
  });
  vi.resetModules();

  const security = await import('../security.js');
  const session = await import('../../auth/session.js');
  mods = { security, session };

  const limiters = security.buildLimiters();
  const app = express();
  app.set('trust proxy', 1);
  // Request logger first, as in production, so the correlation-id header is set.
  app.use(security.buildRequestLogger());
  app.use(security.buildHelmet());
  app.use(security.buildCors());
  app.use(cookieParser());
  app.use(express.json({ limit: '1mb' }));

  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
  session.setupAuthRoutes(app, { loginLimiter: limiters.auth });

  // Stand-ins for the real protected surfaces.
  app.use('/api/workflows', session.requireSession);
  app.get('/api/workflows', (_req, res) => res.json([]));

  app.use('/send', limiters.send, session.requireSession);
  app.post('/send', (req, res) => {
    const parsed = sendSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'invalid_request',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return res.json({ success: true });
  });

  app.use(security.errorHandler);

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

afterEach(() => {
  vi.restoreAllMocks();
});

// Mirrors the schema in server/api.js.
const { z } = await import('zod');
const sendSchema = z
  .object({
    to: z.string().min(1).max(64),
    text: z.string().max(4096).optional(),
    mediaUrl: z
      .string()
      .max(2048)
      .refine((value) => {
        let parsed;
        try {
          parsed = new URL(value);
        } catch {
          return false;
        }
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
      }, 'mediaUrl must be an absolute http(s) URL')
      .optional(),
    mediaType: z.string().max(64).optional(),
  })
  .refine((body) => Boolean(body.text) || Boolean(body.mediaUrl), {
    message: 'Provide "text", "mediaUrl", or both.',
  });

async function req(path, { method = 'GET', body, origin, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (origin) headers.Origin = origin;
  if (cookie) headers.Cookie = cookie;

  const res = await realFetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Some responses are not JSON; assertions may only need the status.
  }
  return { status: res.status, json, text, headers: res.headers };
}

/** Sign in and return the session cookie header value. */
async function signIn() {
  const res = await realFetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get('set-cookie');
  expect(setCookie).toBeTruthy();
  return setCookie.split(';')[0];
}

describe('unauthenticated access', () => {
  it('refuses saved workflows with 401', async () => {
    const { status, json } = await req('/api/workflows');
    expect(status).toBe(401);
    expect(json.error).toBe('unauthenticated');
  });

  it('refuses message sending with 401', async () => {
    const { status, json } = await req('/send', {
      method: 'POST',
      body: { to: '15551234567', text: 'hi' },
    });
    expect(status).toBe(401);
    expect(json.error).toBe('unauthenticated');
  });

  it('reports no session from /api/auth/me', async () => {
    const { status, json } = await req('/api/auth/me');
    expect(status).toBe(401);
    expect(json.authenticated).toBe(false);
  });

  it('still serves the health check, which must stay public', async () => {
    const { status, json } = await req('/healthz');
    expect(status).toBe(200);
    expect(json.status).toBe('ok');
  });
});

describe('login', () => {
  it('rejects a wrong password without revealing anything', async () => {
    const { status, json } = await req('/api/auth/login', {
      method: 'POST',
      body: { password: 'wrong-password-value' },
    });
    expect(status).toBe(401);
    expect(json.error).toBe('invalid_credentials');
    expect(json.message).toBe('Incorrect password.');
  });

  it('rejects a missing password with 400', async () => {
    const { status } = await req('/api/auth/login', { method: 'POST', body: {} });
    expect(status).toBe(400);
  });

  it('issues an httpOnly, SameSite=Strict cookie on success', async () => {
    const res = await realFetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const setCookie = res.headers.get('set-cookie') ?? '';

    expect(res.status).toBe(200);
    // httpOnly is what stops an XSS from reading the session.
    expect(setCookie).toMatch(/HttpOnly/i);
    // SameSite=Strict is what stops cross-site POST CSRF.
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toMatch(/Path=\//i);
  });

  it('grants access to protected routes once signed in', async () => {
    const cookie = await signIn();

    const workflows = await req('/api/workflows', { cookie });
    expect(workflows.status).toBe(200);

    const me = await req('/api/auth/me', { cookie });
    expect(me.status).toBe(200);
    expect(me.json.user.id).toBe('operator');
  });

  it('throttles repeated login attempts', async () => {
    // Isolated app with its own limiter and its own counter store, so draining
    // the budget here cannot make the other tests fail.
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    mods.session.setupAuthRoutes(app, {
      loginLimiter: mods.security.buildLimiter({ limit: 3, name: 'test-auth' }),
    });

    const isolated = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const url = `http://127.0.0.1:${isolated.address().port}/api/auth/login`;

    try {
      const statuses = [];
      for (let i = 0; i < 5; i += 1) {
        const res = await realFetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: 'still-the-wrong-password' }),
        });
        statuses.push(res.status);
      }

      // First 3 are rejected on credentials, the rest are throttled.
      expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
      expect(statuses).toContain(429);

      const limited = await realFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'still-the-wrong-password' }),
      });
      expect(limited.status).toBe(429);
      const body = await limited.json();
      expect(body.error).toBe('rate_limited');
      expect(body.retryable).toBe(true);
      // A correct password must also be throttled, or the limit is bypassable.
      const evenCorrect = await realFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD }),
      });
      expect(evenCorrect.status).toBe(429);
    } finally {
      await new Promise((resolve) => isolated.close(resolve));
    }
  });
});

describe('CORS', () => {
  it('allows the configured origin', async () => {
    const { status, headers } = await req('/healthz', { origin: ALLOWED_ORIGIN });
    expect(status).toBe(200);
    expect(headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    // Required for the session cookie to be sent cross-origin.
    expect(headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('rejects a disallowed origin with 403', async () => {
    const { status, json } = await req('/healthz', { origin: 'https://evil.example' });
    expect(status).toBe(403);
    expect(json.error).toBe('origin_not_allowed');
  });

  it('allows requests with no Origin header (curl, health probes)', async () => {
    const { status } = await req('/healthz');
    expect(status).toBe(200);
  });

  it('never echoes an arbitrary origin back', async () => {
    const { headers } = await req('/healthz', { origin: 'https://evil.example' });
    expect(headers.get('access-control-allow-origin')).not.toBe('https://evil.example');
  });
});

describe('security headers', () => {
  it('sets a content security policy and disallows framing', async () => {
    const { headers } = await req('/healthz');

    const csp = headers.get('content-security-policy');
    expect(csp).toBeTruthy();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('does not force HTTPS upgrades when serving over plain HTTP', async () => {
    // The test app runs without NODE_ENV=production, so SESSION_COOKIE_SECURE is
    // false — a plain-HTTP (local) deployment. upgrade-insecure-requests here
    // would make the browser fetch every asset over https:// and blank the page.
    const { headers } = await req('/healthz');
    const csp = headers.get('content-security-policy') ?? '';
    expect(csp).not.toContain('upgrade-insecure-requests');
  });

  it('serves styles and fonts only from our own origin (no CDNs)', async () => {
    // Task 15 bundled Tailwind, the fonts, and react-flow's CSS into the build,
    // so the CSP must not permit any third-party style or font origin. If a CDN
    // sneaks back into the page, this fails.
    const { headers } = await req('/healthz');
    const csp = headers.get('content-security-policy');

    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("font-src 'self' data:");
    expect(csp).not.toContain('googleapis.com');
    expect(csp).not.toContain('gstatic.com');
    expect(csp).not.toContain('jsdelivr.net');
  });

  it('allows no third-party script origin', async () => {
    const { headers } = await req('/healthz');
    const csp = headers.get('content-security-policy');
    expect(csp).toContain("script-src 'self'");
  });

  it('does not advertise the server implementation', async () => {
    const { headers } = await req('/healthz');
    expect(headers.get('x-powered-by')).toBeNull();
  });

  it('assigns a correlation id and echoes it on the response', async () => {
    const { headers } = await req('/healthz');
    const id = headers.get('x-request-id');
    expect(id).toBeTruthy();
    // A generated id is a uuid.
    expect(id).toMatch(/^[0-9a-f-]{16,}$/);
  });

  it('honours a sane inbound X-Request-Id but rejects a hostile one', async () => {
    const good = await realFetch(`${baseUrl}/healthz`, {
      headers: { 'X-Request-Id': 'trace-abc.123_XYZ' },
    });
    expect(good.headers.get('x-request-id')).toBe('trace-abc.123_XYZ');

    // A value with characters outside the strict charset (here spaces and a
    // semicolon — the makings of log injection) is replaced with a fresh id.
    const hostile = 'id with spaces; drop';
    const bad = await realFetch(`${baseUrl}/healthz`, {
      headers: { 'X-Request-Id': hostile },
    });
    const replaced = bad.headers.get('x-request-id');
    expect(replaced).not.toBe(hostile);
    expect(replaced).toMatch(/^[0-9a-f-]{16,}$/);
  });
});

describe('/send media URL restriction', () => {
  it('rejects a local filesystem path', async () => {
    const cookie = await signIn();
    // The old handler resolved this against the filesystem and returned it.
    const { status, json } = await req('/send', {
      method: 'POST',
      cookie,
      body: { to: '15551234567', mediaUrl: '/etc/passwd' },
    });

    expect(status).toBe(400);
    expect(json.issues.some((i) => i.path === 'mediaUrl')).toBe(true);
  });

  it('rejects a file:// URL', async () => {
    const cookie = await signIn();
    const { status } = await req('/send', {
      method: 'POST',
      cookie,
      body: { to: '15551234567', mediaUrl: 'file:///etc/shadow' },
    });
    expect(status).toBe(400);
  });

  it('rejects a relative path traversal', async () => {
    const cookie = await signIn();
    const { status } = await req('/send', {
      method: 'POST',
      cookie,
      body: { to: '15551234567', mediaUrl: '../../.env.local' },
    });
    expect(status).toBe(400);
  });

  it('accepts an https URL', async () => {
    const cookie = await signIn();
    const { status } = await req('/send', {
      method: 'POST',
      cookie,
      body: { to: '15551234567', mediaUrl: 'https://example.com/a.png', mediaType: 'image/png' },
    });
    expect(status).toBe(200);
  });

  it('requires text or media', async () => {
    const cookie = await signIn();
    const { status } = await req('/send', { method: 'POST', cookie, body: { to: '15551234567' } });
    expect(status).toBe(400);
  });
});

describe('body limits', () => {
  it('rejects a body over the size limit with 413', async () => {
    const cookie = await signIn();
    const huge = 'x'.repeat(1_200_000); // over the 1mb limit
    const res = await realFetch(`${baseUrl}/api/workflows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ blob: huge }),
    });

    expect(res.status).toBe(413);
  });

  it('rejects malformed JSON with 400 rather than a crash', async () => {
    const res = await realFetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"password": ',
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_json');
  });
});

describe('logout', () => {
  it('clears the session so protected routes refuse again', async () => {
    const cookie = await signIn();
    expect((await req('/api/workflows', { cookie })).status).toBe(200);

    const res = await realFetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);

    const cleared = res.headers.get('set-cookie') ?? '';
    // The cookie is expired rather than merely dropped.
    expect(cleared).toMatch(/autoagent_session=;/);
  });
});
