import express from 'express';
import cookieParser from 'cookie-parser';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  TEST_DB_NAME,
  isMysqlAvailable,
  loadDbModules,
  restoreEnv,
  truncateAll,
} from '../../test/dbTestHelper.js';

/**
 * DB-backed auth flow: signup -> login -> me, and the credential-verification
 * semantics that moved here from the middleware suite when login started
 * checking the users table.
 */

const originalEnv = { ...process.env };
const mysqlAvailable = await isMysqlAvailable();

let pool;
let baseUrl;
let server;

const realFetch = globalThis.fetch;

beforeAll(async () => {
  if (!mysqlAvailable) {
    console.warn('[authRoutes.test] MySQL not reachable — skipping');
    return;
  }
  const modules = await loadDbModules(vi, { DB_NAME: `${TEST_DB_NAME}_auth` });
  pool = modules.pool;
  const session = await import('../session.js');

  const app = express();
  app.set('trust proxy', 1);
  app.use(cookieParser());
  app.use(express.json());
  session.setupAuthRoutes(app);

  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  if (mysqlAvailable && pool) await truncateAll(pool);
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (mysqlAvailable && pool) await pool.closePool();
  restoreEnv(originalEnv);
});

async function post(path, body, cookie) {
  const res = await realFetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json().catch(() => ({}));
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, json, setCookie };
}

describe.skipIf(!mysqlAvailable)('auth routes (DB-backed)', () => {
  it('signs up a new user, sets a cookie, and provisions free credits', async () => {
    const res = await post('/api/auth/signup', {
      email: 'new@example.com',
      password: 'hunter2hunter2',
    });
    expect(res.status).toBe(201);
    expect(res.json.user.email).toBe('new@example.com');
    expect(res.json.user.role).toBe('user');
    expect(res.setCookie).toMatch(/HttpOnly/i);
    expect(res.setCookie).toMatch(/SameSite=Lax/i);

    const [wallet] = await pool
      .getPool()
      .query('SELECT bonus_credits FROM credit_wallets WHERE owner_id = ?', [res.json.user.id]);
    expect(Number(wallet[0].bonus_credits)).toBe(1000);
  });

  it('rejects a weak password and a duplicate email', async () => {
    expect((await post('/api/auth/signup', { email: 'a@b.com', password: 'short' })).status).toBe(
      400,
    );
    await post('/api/auth/signup', { email: 'dup@example.com', password: 'hunter2hunter2' });
    expect(
      (await post('/api/auth/signup', { email: 'dup@example.com', password: 'hunter2hunter2' }))
        .status,
    ).toBe(409);
  });

  it('logs in with correct credentials and rejects wrong ones without enumeration', async () => {
    await post('/api/auth/signup', { email: 'login@example.com', password: 'hunter2hunter2' });

    const ok = await post('/api/auth/login', {
      email: 'login@example.com',
      password: 'hunter2hunter2',
    });
    expect(ok.status).toBe(200);
    expect(ok.setCookie).toBeTruthy();

    // Wrong password and unknown email return the SAME generic 401.
    const wrongPw = await post('/api/auth/login', {
      email: 'login@example.com',
      password: 'wrong-password',
    });
    const noUser = await post('/api/auth/login', {
      email: 'nobody@example.com',
      password: 'whatever12345',
    });
    expect(wrongPw.status).toBe(401);
    expect(noUser.status).toBe(401);
    expect(wrongPw.json.message).toBe(noUser.json.message);
    expect(wrongPw.json.error).toBe('invalid_credentials');
  });

  it('reports the signed-in user (with role) from /api/auth/me', async () => {
    const signup = await post('/api/auth/signup', {
      email: 'me@example.com',
      password: 'hunter2hunter2',
    });
    const cookie = signup.setCookie.split(';')[0];
    const res = await realFetch(`${baseUrl}/api/auth/me`, { headers: { cookie } });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.authenticated).toBe(true);
    expect(json.user.email).toBe('me@example.com');
    expect(json.user.role).toBe('user');
  });
});
