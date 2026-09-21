import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';

import {
  TEST_DB_NAME,
  isMysqlAvailable,
  loadDbModules,
  restoreEnv,
  truncateAll,
} from '../../test/dbTestHelper.js';

/**
 * The admin console API against real MySQL.
 *
 * These are the guarantees that keep the admin surface safe:
 *   - The whole /api/admin prefix is behind requireAdmin, so a plain user gets a
 *     403 and never sees another account's data.
 *   - A manual credit adjustment writes exactly one ADMIN_ADJUSTMENT ledger row
 *     that names the admin and the reason — nothing changes silently.
 *   - A negative adjustment debits (and cannot overdraw); a positive one credits.
 *   - Editing the rate card moves NEW charges only; a historical ai_usage row
 *     keeps the rate it was billed at.
 */

const originalEnv = { ...process.env };
const mysqlAvailable = await isMysqlAvailable();
const realFetch = globalThis.fetch.bind(globalThis);

let pool;
let wallet;
let aiUsage;
let rateCard;
let settings;
let users;
let subscriptions;
let server;
let baseUrl;

const ADMIN = 'operator';
const USER = 'owner-user-1';

// Swappable session the fake middleware injects, so one server can act as an
// admin or a plain user across tests.
let currentSession = { sub: ADMIN, role: 'admin' };

async function req(method, path, body) {
  const res = await realFetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // leave null
  }
  return { status: res.status, json };
}

beforeAll(async () => {
  if (!mysqlAvailable) {
    console.warn('[adminRoutes.test] MySQL not reachable — skipping');
    return;
  }
  const m = await loadDbModules(vi, { DB_NAME: `${TEST_DB_NAME}_admin` });
  pool = m.pool;
  wallet = m.wallet;
  aiUsage = m.aiUsage;
  rateCard = m.rateCard;
  settings = m.settings;
  users = m.users;
  subscriptions = m.subscriptions;
  await settings.loadSettingsCache();

  const { requireAdmin } = await import('../../auth/session.js');
  const { setupAdminRoutes } = await import('../routes.js');

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  // Stand in for requireSession: attach whatever currentSession holds, then run
  // the REAL requireAdmin so the authz behaviour under test is the production one.
  app.use('/api/admin', (reqObj, _res, next) => {
    reqObj.session = currentSession;
    next();
  });
  app.use('/api/admin', requireAdmin);
  setupAdminRoutes(app);

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  currentSession = { sub: ADMIN, role: 'admin' };
  if (mysqlAvailable && pool) {
    await truncateAll(pool);
    if (settings) await settings.loadSettingsCache();
  }
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (mysqlAvailable && pool) await pool.closePool();
  restoreEnv(originalEnv);
});

describe.skipIf(!mysqlAvailable)('admin authorization', () => {
  it('rejects a non-admin session with 403 on every admin route', async () => {
    currentSession = { sub: USER, role: 'user' };
    for (const path of ['/api/admin/users', '/api/admin/plans', '/api/admin/rates']) {
      const res = await req('GET', path);
      expect(res.status).toBe(403);
    }
  });

  it('allows an admin session through', async () => {
    const res = await req('GET', '/api/admin/plans');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json.plans)).toBe(true);
  });
});

describe.skipIf(!mysqlAvailable)('manual credit adjustment', () => {
  it('grants credits and writes one audited ADMIN_ADJUSTMENT ledger row', async () => {
    const res = await req('POST', `/api/admin/users/${USER}/adjust`, {
      amount: 5000,
      reason: 'goodwill credit for outage',
      bucket: 'bonus',
    });
    expect(res.status).toBe(200);
    expect(res.json.wallet.bonusCredits).toBe(5000);

    const tx = await wallet.listTransactions(USER);
    const adjustments = tx.filter((t) => t.type === 'ADMIN_ADJUSTMENT');
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0].credits).toBe(5000);

    // The reason + admin identity are recorded (metadata + description).
    const [rows] = await pool
      .getPool()
      .query('SELECT description, metadata FROM credit_transactions WHERE owner_id = ?', [USER]);
    expect(rows[0].description).toContain('goodwill credit for outage');
    // metadata is a JSON column; mysql2 returns it already parsed.
    const meta =
      typeof rows[0].metadata === 'string' ? JSON.parse(rows[0].metadata) : rows[0].metadata;
    expect(meta.adminId).toBe(ADMIN);
    expect(meta.reason).toBe('goodwill credit for outage');
  });

  it('removes credits with a negative amount (debit path)', async () => {
    await wallet.creditWallet(USER, 'bonus', 3000, { type: 'ADMIN_ADJUSTMENT' });
    const res = await req('POST', `/api/admin/users/${USER}/adjust`, {
      amount: -1000,
      reason: 'clawback of erroneous grant',
    });
    expect(res.status).toBe(200);
    expect(res.json.wallet.totalCredits).toBe(2000);
  });

  it('refuses to remove more than the user holds', async () => {
    await wallet.creditWallet(USER, 'bonus', 500, { type: 'ADMIN_ADJUSTMENT' });
    const res = await req('POST', `/api/admin/users/${USER}/adjust`, {
      amount: -1000,
      reason: 'over-clawback',
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('insufficient_credits');
  });

  it('requires a non-zero amount and a reason', async () => {
    expect(
      (await req('POST', `/api/admin/users/${USER}/adjust`, { amount: 0, reason: 'x' })).status,
    ).toBe(400);
    expect(
      (await req('POST', `/api/admin/users/${USER}/adjust`, { amount: 100, reason: '  ' })).status,
    ).toBe(400);
  });
});

describe.skipIf(!mysqlAvailable)('rate card immutability', () => {
  it('editing a rate leaves a historical ai_usage row untouched', async () => {
    // ai_usage has an FK to owners; recordUsage uses INSERT IGNORE, so without
    // the owner row the insert is silently dropped. Seed it first.
    await pool
      .getPool()
      .query('INSERT INTO owners (id, created_at) VALUES (?, ?) ON DUPLICATE KEY UPDATE id = id', [
        USER,
        new Date(),
      ]);

    // Record a usage row at the seeded rate (markup ×2.5 = x10 25).
    await aiUsage.recordUsage({
      requestId: 'req-history-1',
      ownerId: USER,
      provider: 'openrouter',
      model: 'openai/gpt-oss-120b',
      inputTokens: 1000,
      outputTokens: 500,
      providerCostUsdMicros: 1_000_000,
      markupMultiplierX10: 25,
      creditsCharged: 25000,
    });

    // Find that rate and bump its markup to ×5 (x10 50) via the admin API.
    const rate = (await rateCard.listRates()).find(
      (r) => r.provider === 'openrouter' && r.modelId === 'openai/gpt-oss-120b',
    );
    const res = await req('PUT', `/api/admin/rates/${rate.id}`, { markup_multiplier_x10: 50 });
    expect(res.status).toBe(200);
    expect(res.json.rate.markup_multiplier_x10).toBe(50);

    // The historical row still carries the rate + credits it was billed at.
    const history = await aiUsage.getUsage('req-history-1');
    expect(history.markupMultiplierX10).toBe(25);
    expect(history.creditsCharged).toBe(25000);
  });
});

describe.skipIf(!mysqlAvailable)('runtime settings', () => {
  it('403s a non-admin on both settings routes', async () => {
    currentSession = { sub: USER, role: 'user' };
    expect((await req('GET', '/api/admin/settings')).status).toBe(403);
    expect((await req('PUT', '/api/admin/settings', { OPENAI_MODEL: 'x' })).status).toBe(403);
  });

  it('stores a value, reflects it as db-sourced, and never returns the secret', async () => {
    const put = await req('PUT', '/api/admin/settings', {
      RAZORPAY_KEY_ID: 'rzp_test_abc',
      RAZORPAY_KEY_SECRET: 'super-secret-value-9999',
    });
    expect(put.status).toBe(200);
    expect(put.json.updated).toEqual(
      expect.arrayContaining(['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET']),
    );

    // The secret is stored encrypted, not echoed back.
    expect(JSON.stringify(put.json.settings)).not.toContain('super-secret-value-9999');
    const secret = put.json.settings.find((s) => s.key === 'RAZORPAY_KEY_SECRET');
    expect(secret.configured).toBe(true);
    expect(secret.source).toBe('db');
    expect(secret.masked).toBe('••••9999');

    // A non-secret text value IS returned so the field can be pre-filled.
    const keyId = put.json.settings.find((s) => s.key === 'RAZORPAY_KEY_ID');
    expect(keyId.value).toBe('rzp_test_abc');
  });

  it('ignores a masked echo so an untouched secret is not overwritten', async () => {
    await req('PUT', '/api/admin/settings', { RAZORPAY_KEY_SECRET: 'real-secret-1234' });
    // Re-save sending only the mask back (as the UI would if untouched).
    await req('PUT', '/api/admin/settings', { RAZORPAY_KEY_SECRET: '••••1234' });
    // The real value survives.
    expect(await settings.getSetting('RAZORPAY_KEY_SECRET')).toBe('real-secret-1234');
  });

  it('rejects a key that is not admin-manageable', async () => {
    const res = await req('PUT', '/api/admin/settings', { CREDENTIAL_SECRET: 'nope' });
    expect(res.status).toBe(400);
  });

  it('clears an override when given an empty value', async () => {
    await req('PUT', '/api/admin/settings', { OPENAI_MODEL: 'gpt-4o' });
    expect(await settings.getSetting('OPENAI_MODEL')).toBe('gpt-4o');
    await req('PUT', '/api/admin/settings', { OPENAI_MODEL: '' });
    expect(await settings.getSetting('OPENAI_MODEL')).toBeNull();
  });
});

describe.skipIf(!mysqlAvailable)('user role + status actions', () => {
  it('changes a role and suspends/reactivates a real user', async () => {
    const { user } = await users.createUser({
      email: 'target@example.com',
      password: 'pw12345678',
    });
    const oid = user.ownerId;

    const promote = await req('PUT', `/api/admin/users/${oid}/role`, { role: 'admin' });
    expect(promote.status).toBe(200);
    expect(promote.json.user.role).toBe('admin');

    const suspend = await req('PUT', `/api/admin/users/${oid}/status`, { status: 'suspended' });
    expect(suspend.status).toBe(200);
    expect(suspend.json.user.status).toBe('suspended');

    const reactivate = await req('PUT', `/api/admin/users/${oid}/status`, { status: 'active' });
    expect(reactivate.json.user.status).toBe('active');
  });

  it('rejects an unknown role/status and a missing user', async () => {
    const { user } = await users.createUser({ email: 't2@example.com', password: 'pw12345678' });
    expect(
      (await req('PUT', `/api/admin/users/${user.ownerId}/role`, { role: 'root' })).status,
    ).toBe(400);
    expect((await req('PUT', `/api/admin/users/nope/status`, { status: 'active' })).status).toBe(
      404,
    );
  });

  it('403s a non-admin', async () => {
    currentSession = { sub: USER, role: 'user' };
    expect((await req('PUT', `/api/admin/users/x/role`, { role: 'admin' })).status).toBe(403);
  });
});

describe.skipIf(!mysqlAvailable)('assign plan', () => {
  it('activates a plan and resets the subscription credit bucket', async () => {
    const { user } = await users.createUser({ email: 'plan@example.com', password: 'pw12345678' });
    const plans = await subscriptions.listPlans({ includeDisabled: true });
    const pro = plans.find((p) => p.code === 'pro');

    const res = await req('PUT', `/api/admin/users/${user.ownerId}/plan`, { planId: pro.id });
    expect(res.status).toBe(200);
    expect(res.json.subscription.planCode).toBe('pro');
    expect(res.json.wallet.subscriptionCredits).toBe(pro.includedCredits);
  });
});

describe.skipIf(!mysqlAvailable)('plans / packages / coupons CRUD', () => {
  // Unique per run so re-running against a persistent DB never hits a stale
  // duplicate-code row (plans/packages/coupons are not truncated between tests).
  const uniq = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  it('creates and updates a plan', async () => {
    const create = await req('POST', '/api/admin/plans', {
      code: `team_${uniq()}`,
      displayName: 'Team',
      pricePaise: 499900,
      includedCredits: 500000,
    });
    expect(create.status).toBe(201);
    const id = create.json.plan.id;

    const upd = await req('PUT', `/api/admin/plans/${id}`, { pricePaise: 399900, enabled: false });
    expect(upd.status).toBe(200);
    expect(upd.json.plan.pricePaise).toBe(399900);
    expect(upd.json.plan.enabled).toBe(false);
  });

  it('rejects a duplicate plan code', async () => {
    const code = `dup_${uniq()}`;
    await req('POST', '/api/admin/plans', { code, displayName: 'Dup' });
    const again = await req('POST', '/api/admin/plans', { code, displayName: 'Dup2' });
    expect(again.status).toBe(409);
  });

  it('creates and updates a package', async () => {
    const create = await req('POST', '/api/admin/packages', {
      code: `pack_${uniq()}`,
      displayName: 'Test pack',
      pricePaise: 9900,
      credits: 10000,
    });
    expect(create.status).toBe(201);
    const upd = await req('PUT', `/api/admin/packages/${create.json.package.id}`, {
      enabled: false,
    });
    expect(upd.json.package.enabled).toBe(false);
  });

  it('creates a coupon and toggles it', async () => {
    const create = await req('POST', '/api/admin/coupons', {
      code: `SAVE_${uniq()}`,
      couponType: 'percentage',
      percentBps: 1000,
    });
    expect(create.status).toBe(201);
    const id = create.json.coupon.id;
    const off = await req('PUT', `/api/admin/coupons/${id}`, { enabled: false });
    expect(off.json.coupon.enabled).toBe(false);
  });

  it('rejects a coupon with an invalid type', async () => {
    const res = await req('POST', '/api/admin/coupons', {
      code: `BAD_${uniq()}`,
      couponType: 'weird',
    });
    expect(res.status).toBe(400);
  });
});

describe.skipIf(!mysqlAvailable)('dashboard metrics', () => {
  it('returns the metric shape', async () => {
    const res = await req('GET', '/api/admin/dashboard');
    expect(res.status).toBe(200);
    expect(res.json.metrics).toHaveProperty('users');
    expect(res.json.metrics).toHaveProperty('mrrPaise');
    expect(res.json.metrics).toHaveProperty('creditsOutstanding');
    expect(Array.isArray(res.json.recentPayments)).toBe(true);
  });

  it('403s a non-admin', async () => {
    currentSession = { sub: USER, role: 'user' };
    expect((await req('GET', '/api/admin/dashboard')).status).toBe(403);
  });
});
