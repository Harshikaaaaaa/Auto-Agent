import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  TEST_DB_NAME,
  isMysqlAvailable,
  loadDbModules,
  restoreEnv,
  truncateAll,
} from '../../test/dbTestHelper.js';

/**
 * The money core, against a real MySQL: wallet debit priority + immutable
 * ledger, reservation reserve/capture/release idempotency, concurrent-spend
 * safety (FOR UPDATE), and reconcile-time rate immutability. Skips without a DB.
 */

const originalEnv = { ...process.env };
const mysqlAvailable = await isMysqlAvailable();

let pool;
let wallet;
let reservations;
let aiUsage;
let creditMath;

const OWNER = 'owner-billing-test';

beforeAll(async () => {
  if (!mysqlAvailable) {
    console.warn('[billingEngine.test] MySQL not reachable — skipping');
    return;
  }
  const m = await loadDbModules(vi, { DB_NAME: `${TEST_DB_NAME}_billing` });
  pool = m.pool;
  wallet = m.wallet;
  reservations = m.reservations;
  aiUsage = m.aiUsage;
  creditMath = await import('../creditMath.js');
});

afterEach(async () => {
  if (mysqlAvailable && pool) await truncateAll(pool);
});

afterAll(async () => {
  if (mysqlAvailable && pool) await pool.closePool();
  restoreEnv(originalEnv);
});

// Seed a wallet with explicit per-bucket balances.
async function seedWallet({ sub = 0, bonus = 0, purchased = 0 }) {
  const now = new Date();
  await pool
    .getPool()
    .query('INSERT INTO owners (id, created_at) VALUES (?, ?) ON DUPLICATE KEY UPDATE id = id', [
      OWNER,
      now,
    ]);
  await pool.getPool().query(
    `INSERT INTO credit_wallets
       (owner_id, subscription_credits, bonus_credits, purchased_credits, used_this_month, lifetime_used, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, 0, ?, ?)
     ON DUPLICATE KEY UPDATE subscription_credits = VALUES(subscription_credits),
       bonus_credits = VALUES(bonus_credits), purchased_credits = VALUES(purchased_credits)`,
    [OWNER, sub, bonus, purchased, now, now],
  );
}

describe.skipIf(!mysqlAvailable)('wallet debit priority + ledger', () => {
  it('spends subscription, then bonus, then purchased', async () => {
    await seedWallet({ sub: 100, bonus: 50, purchased: 200 });

    // Debit 130: 100 from subscription, 30 from bonus, 0 from purchased.
    await wallet.debitCredits(OWNER, 130, { type: 'AI_USAGE' });
    const w = await wallet.getWallet(OWNER);
    expect(w.subscriptionCredits).toBe(0);
    expect(w.bonusCredits).toBe(20);
    expect(w.purchasedCredits).toBe(200); // untouched — purchased is spent last
    expect(w.totalCredits).toBe(220);
  });

  it('writes one ledger row per debit with before/after', async () => {
    await seedWallet({ sub: 100 });
    await wallet.debitCredits(OWNER, 40, { type: 'AI_USAGE', model: 'x' });
    const tx = await wallet.listTransactions(OWNER);
    expect(tx).toHaveLength(1);
    expect(tx[0].type).toBe('AI_USAGE');
    expect(tx[0].credits).toBe(-40);
    expect(tx[0].balanceAfter).toBe(60);
  });

  it('rejects a debit that would overdraw and leaves the wallet unchanged', async () => {
    await seedWallet({ sub: 10 });
    await expect(wallet.debitCredits(OWNER, 25)).rejects.toMatchObject({
      name: 'InsufficientCreditsError',
    });
    const w = await wallet.getWallet(OWNER);
    expect(w.totalCredits).toBe(10);
    expect(await wallet.listTransactions(OWNER)).toHaveLength(0);
  });

  it('credits a bucket and records a ledger row', async () => {
    await seedWallet({});
    await wallet.creditWallet(OWNER, 'purchased', 500, { type: 'TOPUP' });
    const w = await wallet.getWallet(OWNER);
    expect(w.purchasedCredits).toBe(500);
    const tx = await wallet.listTransactions(OWNER);
    expect(tx[0].type).toBe('TOPUP');
    expect(tx[0].credits).toBe(500);
  });
});

describe.skipIf(!mysqlAvailable)('reservations', () => {
  it('reserve -> capture charges the actual amount and releases the remainder', async () => {
    await seedWallet({ sub: 1000 });
    await reservations.reserveCredits(OWNER, 'req-1', 500);

    // While reserved, the held 500 is unavailable to a second reserve...
    await expect(reservations.reserveCredits(OWNER, 'req-2', 600)).rejects.toMatchObject({
      name: 'InsufficientCreditsError',
    });

    // Capture the ACTUAL 287; balance goes 1000 -> 713, remainder released.
    const cap = await reservations.captureReservation('req-1', 287, { model: 'x' });
    expect(cap.captured).toBe(true);
    expect(cap.credits).toBe(287);
    const w = await wallet.getWallet(OWNER);
    expect(w.totalCredits).toBe(713);

    // The hold is gone, so the second reserve now fits.
    const r2 = await reservations.reserveCredits(OWNER, 'req-2', 600);
    expect(r2.status).toBe('RESERVED');
  });

  it('reserve -> release charges nothing', async () => {
    await seedWallet({ sub: 1000 });
    await reservations.reserveCredits(OWNER, 'req-fail', 500);
    expect(await reservations.releaseReservation('req-fail')).toBe(true);
    const w = await wallet.getWallet(OWNER);
    expect(w.totalCredits).toBe(1000); // untouched
  });

  it('is idempotent: the same request_id cannot be captured twice', async () => {
    await seedWallet({ sub: 1000 });
    await reservations.reserveCredits(OWNER, 'req-once', 500);
    const first = await reservations.captureReservation('req-once', 200);
    const second = await reservations.captureReservation('req-once', 200);
    expect(first.captured).toBe(true);
    expect(second.captured).toBe(false); // already captured
    const w = await wallet.getWallet(OWNER);
    expect(w.totalCredits).toBe(800); // charged once
  });

  it('reusing a request_id returns the existing reservation, not a second hold', async () => {
    await seedWallet({ sub: 1000 });
    const a = await reservations.reserveCredits(OWNER, 'req-retry', 300);
    const b = await reservations.reserveCredits(OWNER, 'req-retry', 300);
    expect(b.reused).toBe(true);
    expect(b.id).toBe(a.id);
  });
});

describe.skipIf(!mysqlAvailable)('concurrent spend safety', () => {
  it('two simultaneous reservations cannot overspend one balance', async () => {
    await seedWallet({ sub: 100 });
    // Each wants 60; only one can win (100 < 120).
    const results = await Promise.allSettled([
      reservations.reserveCredits(OWNER, 'c-1', 60),
      reservations.reserveCredits(OWNER, 'c-2', 60),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].reason.name).toBe('InsufficientCreditsError');
  });
});

describe.skipIf(!mysqlAvailable)('reconcile rate immutability', () => {
  it('a usage row keeps its snapshotted markup after the rate card changes', async () => {
    await seedWallet({}); // ensures the owner row exists for the ai_usage FK
    await aiUsage.recordUsage({
      requestId: 'u-1',
      ownerId: OWNER,
      provider: 'openai',
      model: 'gpt-4o-mini',
      inputTokens: 100,
      outputTokens: 50,
      providerCostUsdMicros: 1_000_000,
      markupMultiplierX10: 25,
      billingExchangeRatePaiseUsd: 10000,
      creditsCharged: 25000,
    });
    // Admin later doubles the markup on the live rate card.
    await pool
      .getPool()
      .query("UPDATE ai_model_rates SET markup_multiplier_x10 = 50 WHERE model_id = 'gpt-4o-mini'");

    const usage = await aiUsage.getUsage('u-1');
    // The historical row is unchanged: it snapshotted the rate at request time.
    expect(usage.markupMultiplierX10).toBe(25);
    expect(usage.creditsCharged).toBe(25000);
  });

  it('recordUsage is idempotent on request_id', async () => {
    await seedWallet({}); // owner row for the ai_usage FK
    const entry = {
      requestId: 'u-dup',
      ownerId: OWNER,
      provider: 'gemini',
      model: 'g',
      creditsCharged: 10,
    };
    expect(await aiUsage.recordUsage(entry)).toBe(true);
    expect(await aiUsage.recordUsage(entry)).toBe(false); // no second row
  });
});

describe.skipIf(!mysqlAvailable)('credit math against the seeded rate card', () => {
  it('prices $1 of OpenRouter cost at 26,375 credits using the real seed row', async () => {
    const rate = await (
      await import('../../db/rateCardRepository.js')
    ).getModelRate('openrouter', 'openai/gpt-oss-120b');
    expect(rate).not.toBeNull();
    const usage = { provider: 'openrouter', model: rate.modelId, providerCostUsdMicros: 1_000_000 };
    expect(creditMath.usageToCredits(usage, rate)).toBe(26_375);
  });
});
