import crypto from 'crypto';
import { withTransaction } from '../db/pool.js';
import { env } from '../config/env.js';

/**
 * Provision a brand-new account's wallet.
 *
 * A signup gets: a credit wallet, SIGNUP_FREE_CREDITS as bonus credits (with a
 * matching immutable ledger row), and an ACTIVE Free subscription if the Free
 * plan exists. All in one transaction so a new user is never left with a
 * half-provisioned wallet.
 *
 * Signup credits are granted as BONUS credits (not subscription credits) so
 * they are not wiped by the first subscription reset — they are a one-time gift.
 *
 * Idempotent: a wallet is only created if absent, and the grant ledger row is
 * keyed so re-running does not double-grant.
 */
export async function grantSignupCredits(ownerId, { now = new Date() } = {}) {
  if (!ownerId) throw new Error('grantSignupCredits requires an ownerId');
  const freeCredits = BigInt(env.SIGNUP_FREE_CREDITS ?? 0);

  return withTransaction(async (conn) => {
    await conn.query(
      'INSERT INTO owners (id, created_at) VALUES (?, ?) ON DUPLICATE KEY UPDATE id = id',
      [ownerId, now],
    );

    // Create the wallet only if it does not already exist.
    const [walletRows] = await conn.query(
      'SELECT owner_id FROM credit_wallets WHERE owner_id = ? FOR UPDATE',
      [ownerId],
    );
    if (walletRows.length > 0) {
      return { granted: 0n, alreadyProvisioned: true };
    }

    await conn.query(
      `INSERT INTO credit_wallets
         (owner_id, subscription_credits, bonus_credits, purchased_credits,
          used_this_month, lifetime_used, created_at, updated_at)
       VALUES (?, 0, ?, 0, 0, 0, ?, ?)`,
      [ownerId, freeCredits.toString(), now, now],
    );

    if (freeCredits > 0n) {
      await conn.query(
        `INSERT INTO credit_transactions
           (id, owner_id, transaction_type, credits, balance_before, balance_after,
            bonus_credits_change, description, created_at)
         VALUES (?, ?, 'BONUS', ?, 0, ?, ?, 'Signup credits', ?)`,
        [
          crypto.randomUUID(),
          ownerId,
          freeCredits.toString(),
          freeCredits.toString(),
          freeCredits.toString(),
          now,
        ],
      );
    }

    // Attach the Free plan if it is present (seeded in migration 007).
    const [planRows] = await conn.query(
      "SELECT id, included_credits, billing_cycle FROM subscription_plans WHERE code = 'free' LIMIT 1",
    );
    if (planRows.length > 0) {
      const plan = planRows[0];
      await conn.query(
        `INSERT INTO subscriptions
           (id, owner_id, plan_id, status, billing_cycle, price_paise, included_credits,
            current_period_start, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, 0, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          ownerId,
          plan.id,
          plan.billing_cycle,
          plan.included_credits,
          now,
          now,
          now,
        ],
      );
    }

    return { granted: freeCredits, alreadyProvisioned: false };
  });
}
