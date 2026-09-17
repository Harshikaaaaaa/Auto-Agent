import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Session token integrity.
 *
 * These tests exist because the cookie is the only thing standing between the
 * internet and routes that send email and read saved data. A forgeable or
 * non-expiring token would defeat every other control in Task 3.
 */

const originalEnv = { ...process.env };
const SECRET = 'b'.repeat(64);

async function loadSession(overrides = {}) {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, {
    AUTOAGENT_SKIP_ENV_FILES: '1',
    AI_PROVIDER: 'ollama',
    APP_PASSWORD: 'test-operator-password',
    SESSION_SECRET: SECRET,
    LOG_LEVEL: 'silent',
    ...overrides,
  });
  vi.resetModules();
  return import('../session.js');
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  vi.restoreAllMocks();
});

describe('session tokens', () => {
  it('round-trips a token it just signed', async () => {
    const { createSessionToken, verifySessionToken, OPERATOR_SUBJECT } = await loadSession();

    const token = createSessionToken();
    const payload = verifySessionToken(token);

    expect(payload).not.toBeNull();
    expect(payload.sub).toBe(OPERATOR_SUBJECT);
  });

  it('rejects a token whose payload was tampered with', async () => {
    const { createSessionToken, verifySessionToken } = await loadSession();

    const token = createSessionToken();
    const [, signature] = token.split('.');
    // Swap the subject but keep the original signature.
    const forgedPayload = Buffer.from(
      JSON.stringify({ sub: 'attacker', iat: 0, exp: Math.floor(Date.now() / 1000) + 999 }),
    ).toString('base64url');

    expect(verifySessionToken(`${forgedPayload}.${signature}`)).toBeNull();
  });

  it('rejects a token signed with a different secret', async () => {
    const first = await loadSession();
    const token = first.createSessionToken();

    // Rotating SESSION_SECRET must invalidate every existing session.
    const second = await loadSession({ SESSION_SECRET: 'c'.repeat(64) });
    expect(second.verifySessionToken(token)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const { createSessionToken, verifySessionToken } = await loadSession({
      SESSION_TTL_HOURS: '1',
    });

    const issuedAt = Date.now();
    const token = createSessionToken(undefined, issuedAt);

    // Valid just after issue, invalid an hour and a second later.
    expect(verifySessionToken(token, issuedAt + 1000)).not.toBeNull();
    expect(verifySessionToken(token, issuedAt + 3_601_000)).toBeNull();
  });

  it('rejects malformed input without throwing', async () => {
    const { verifySessionToken } = await loadSession();

    for (const bad of [undefined, null, '', 'nodot', 'a.b.c.d', '.', 'x.', '.y', 123, {}]) {
      expect(verifySessionToken(bad)).toBeNull();
    }
  });

  it('rejects a signature of a different length without throwing', async () => {
    const { createSessionToken, verifySessionToken } = await loadSession();
    const [payload] = createSessionToken().split('.');
    // timingSafeEqual throws on length mismatch; it must be caught.
    expect(verifySessionToken(`${payload}.tooshort`)).toBeNull();
  });
});

describe('safeCompare', () => {
  it('matches identical values and rejects different ones', async () => {
    const { safeCompare } = await loadSession();

    expect(safeCompare('hunter2hunter2', 'hunter2hunter2')).toBe(true);
    expect(safeCompare('hunter2hunter2', 'hunter2hunter3')).toBe(false);
    // Different lengths must not throw (raw timingSafeEqual would).
    expect(safeCompare('short', 'a-much-longer-value')).toBe(false);
    expect(safeCompare(undefined, 'value')).toBe(false);
  });
});

describe('requireSession', () => {
  function mockRes() {
    return {
      statusCode: 200,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        return this;
      },
    };
  }

  it('rejects a request with no cookie', async () => {
    const { requireSession } = await loadSession();
    const res = mockRes();
    const next = vi.fn();

    requireSession({ cookies: {} }, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('unauthenticated');
  });

  it('allows a request with a valid cookie and attaches the subject', async () => {
    const { requireSession, createSessionToken, SESSION_COOKIE_NAME } = await loadSession();
    const req = { cookies: { [SESSION_COOKIE_NAME]: createSessionToken() } };
    const res = mockRes();
    const next = vi.fn();

    requireSession(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.session.sub).toBe('operator');
  });

  it('passes through with a dev subject when auth is disabled', async () => {
    const { requireSession } = await loadSession({ AUTH_ENABLED: 'false' });
    const req = { cookies: {} };
    const next = vi.fn();

    requireSession(req, mockRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.session.authDisabled).toBe(true);
  });
});
