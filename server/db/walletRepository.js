import crypto from 'crypto';
import { getPool, withTransaction } from './pool.js';

/**
 * The credit wallet: three balances (subscription, bonus, purchased) plus the
 * immutable ledger. This is the money core, so every rule here matters:
 *
 *   - Deduction priority is subscription -> bonus -> purchased. Purchased
 *     credits (which the user paid cash for and never expire) are spent LAST,
 *     after the monthly allowance and any promo credits.
 *   - Every balance change is one transaction that BOTH updates the cached
 *     balances AND appends one credit_transactions row with balance_before /
 *     balance_after. The ledger is the source of truth; the wallet columns are a
 *     fast-read cache that is never allowed to drift from it.
 *   - A debit locks the wallet row FOR UPDATE, so two concurrent AI requests
 *     cannot both read the same balance and both spend it. A balance can never
 *     go negative — a debit that would overdraw is rejected.
 *
 * All amounts are BigInt-safe integers. The DB columns are BIGINT.
 */

/** Raised when a debit would take a balance below zero. */
export class InsufficientCreditsError extends Error {
  constructor(available, requested) {
    super('Insufficient credits. Add credits or choose a lower-cost AI model.');
    this.name = 'InsufficientCreditsError';
    this.available = available;
    this.requested = requested;
  }
}

function toIsoString(value) {
  if (!value) return null;
  const asDate = value instanceof Date ? value : new Date(`${String(value).replace(' ', 'T')}Z`);
  return Number.isNaN(asDate.getTime()) ? null : asDate.toISOString();
}

function mapWallet(row) {
  const sub = Number(row.subscription_credits);
  const bonus = Number(row.bonus_credits);
  const purchased = Number(row.purchased_credits);
  return {
    ownerId: row.owner_id,
    subscriptionCredits: sub,
    bonusCredits: bonus,
    purchasedCredits: purchased,
    totalCredits: sub + bonus + purchased,
    usedThisMonth: Number(row.used_this_month),
    lifetimeUsed: Number(row.lifetime_used),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

async function ensureWallet(conn, ownerId, now) {
  await conn.query(
    'INSERT INTO owners (id, created_at) VALUES (?, ?) ON DUPLICATE KEY UPDATE id = id',
    [ownerId, now],
  );
  await conn.query(
    `INSERT INTO credit_wallets
       (owner_id, subscription_credits, bonus_credits, purchased_credits,
        used_this_month, lifetime_used, created_at, updated_at)
     VALUES (?, 0, 0, 0, 0, 0, ?, ?)
     ON DUPLICATE KEY UPDATE owner_id = owner_id`,
    [ownerId, now, now],
  );
}

/** Read a wallet (no lock). Returns null when the owner has none yet. */
export async function getWallet(ownerId) {
  const [rows] = await getPool().query('SELECT * FROM credit_wallets WHERE owner_id = ?', [
    ownerId,
  ]);
  return rows.length > 0 ? mapWallet(rows[0]) : null;
}

/**
 * Append one ledger row inside an existing transaction. Does NOT touch balances
 * — the caller updates them in the same transaction so the two never diverge.
 */
async function appendLedger(conn, entry) {
  await conn.query(
    `INSERT INTO credit_transactions
       (id, owner_id, transaction_type, credits, balance_before, balance_after,
        subscription_credits_change, purchased_credits_change, bonus_credits_change,
        provider, model, input_tokens, cached_input_tokens, output_tokens, reasoning_tokens,
        provider_cost_usd_micros, customer_cost_credits, ai_request_id, payment_id,
        subscription_id, description, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      crypto.randomUUID(),
      entry.ownerId,
      entry.type,
      String(entry.credits ?? 0),
      String(entry.balanceBefore ?? 0),
      String(entry.balanceAfter ?? 0),
      String(entry.subscriptionChange ?? 0),
      String(entry.purchasedChange ?? 0),
      String(entry.bonusChange ?? 0),
      entry.provider ?? null,
      entry.model ?? null,
      entry.inputTokens ?? null,
      entry.cachedInputTokens ?? null,
      entry.outputTokens ?? null,
      entry.reasoningTokens ?? null,
      entry.providerCostUsdMicros ?? null,
      entry.customerCostCredits ?? null,
      entry.aiRequestId ?? null,
      entry.paymentId ?? null,
      entry.subscriptionId ?? null,
      entry.description ?? null,
      entry.metadata ? JSON.stringify(entry.metadata) : null,
      entry.now,
    ],
  );
}

const totalOf = (row) =>
  Number(row.subscription_credits) + Number(row.bonus_credits) + Number(row.purchased_credits);

/**
 * Debit `credits` from a wallet, spending subscription -> bonus -> purchased,
 * and write a ledger row. Atomic and concurrency-safe (FOR UPDATE).
 *
 * @throws {InsufficientCreditsError} when the total balance is too low.
 * @returns the new wallet snapshot.
 */
export async function debitCredits(ownerId, credits, ledger = {}, { now = new Date() } = {}) {
  const amount = Math.max(0, Math.round(Number(credits) || 0));
  return withTransaction(async (conn) => {
    await ensureWallet(conn, ownerId, now);
    const [rows] = await conn.query('SELECT * FROM credit_wallets WHERE owner_id = ? FOR UPDATE', [
      ownerId,
    ]);
    const row = rows[0];
    const before = totalOf(row);
    if (amount > before) throw new InsufficientCreditsError(before, amount);

    let remaining = amount;
    const spendFrom = (current) => {
      const take = Math.min(remaining, current);
      remaining -= take;
      return take;
    };
    const subSpend = spendFrom(Number(row.subscription_credits));
    const bonusSpend = spendFrom(Number(row.bonus_credits));
    const purchasedSpend = spendFrom(Number(row.purchased_credits));

    const newSub = Number(row.subscription_credits) - subSpend;
    const newBonus = Number(row.bonus_credits) - bonusSpend;
    const newPurchased = Number(row.purchased_credits) - purchasedSpend;

    await conn.query(
      `UPDATE credit_wallets
         SET subscription_credits = ?, bonus_credits = ?, purchased_credits = ?,
             used_this_month = used_this_month + ?, lifetime_used = lifetime_used + ?,
             updated_at = ?
       WHERE owner_id = ?`,
      [newSub, newBonus, newPurchased, amount, amount, now, ownerId],
    );

    await appendLedger(conn, {
      ownerId,
      type: ledger.type ?? 'AI_USAGE',
      credits: -amount,
      balanceBefore: before,
      balanceAfter: before - amount,
      subscriptionChange: -subSpend,
      bonusChange: -bonusSpend,
      purchasedChange: -purchasedSpend,
      customerCostCredits: amount,
      now,
      ...ledger,
    });

    return mapWallet({
      ...row,
      subscription_credits: newSub,
      bonus_credits: newBonus,
      purchased_credits: newPurchased,
      used_this_month: Number(row.used_this_month) + amount,
      lifetime_used: Number(row.lifetime_used) + amount,
    });
  });
}

/**
 * Credit a wallet into one of the three buckets, writing a ledger row. Used for
 * top-ups (purchased), subscription grants (subscription), and bonuses (bonus).
 *
 * @param {'subscription'|'bonus'|'purchased'} bucket
 */
export async function creditWallet(
  ownerId,
  bucket,
  credits,
  ledger = {},
  { now = new Date() } = {},
) {
  const amount = Math.max(0, Math.round(Number(credits) || 0));
  const column =
    bucket === 'subscription'
      ? 'subscription_credits'
      : bucket === 'purchased'
        ? 'purchased_credits'
        : 'bonus_credits';

  return withTransaction(async (conn) => {
    await ensureWallet(conn, ownerId, now);
    const [rows] = await conn.query('SELECT * FROM credit_wallets WHERE owner_id = ? FOR UPDATE', [
      ownerId,
    ]);
    const row = rows[0];
    const before = totalOf(row);

    await conn.query(
      `UPDATE credit_wallets SET ${column} = ${column} + ?, updated_at = ? WHERE owner_id = ?`,
      [amount, now, ownerId],
    );

    await appendLedger(conn, {
      ownerId,
      type: ledger.type ?? 'ADMIN_ADJUSTMENT',
      credits: amount,
      balanceBefore: before,
      balanceAfter: before + amount,
      subscriptionChange: bucket === 'subscription' ? amount : 0,
      bonusChange: bucket === 'bonus' ? amount : 0,
      purchasedChange: bucket === 'purchased' ? amount : 0,
      now,
      ...ledger,
    });

    row[column] = Number(row[column]) + amount;
    return mapWallet(row);
  });
}

/**
 * Reset the subscription bucket to a plan's monthly allowance (a billing-cycle
 * renewal). Purchased and bonus buckets are untouched; used_this_month resets.
 */
export async function resetSubscriptionCredits(
  ownerId,
  credits,
  ledger = {},
  { now = new Date() } = {},
) {
  const amount = Math.max(0, Math.round(Number(credits) || 0));
  return withTransaction(async (conn) => {
    await ensureWallet(conn, ownerId, now);
    const [rows] = await conn.query('SELECT * FROM credit_wallets WHERE owner_id = ? FOR UPDATE', [
      ownerId,
    ]);
    const row = rows[0];
    const before = totalOf(row);
    const prevSub = Number(row.subscription_credits);

    await conn.query(
      `UPDATE credit_wallets
         SET subscription_credits = ?, used_this_month = 0, updated_at = ?
       WHERE owner_id = ?`,
      [amount, now, ownerId],
    );

    await appendLedger(conn, {
      ownerId,
      type: 'SUBSCRIPTION_RESET',
      credits: amount - prevSub,
      balanceBefore: before,
      balanceAfter: before - prevSub + amount,
      subscriptionChange: amount - prevSub,
      description: ledger.description ?? 'Monthly subscription credit reset',
      now,
      ...ledger,
    });

    row.subscription_credits = amount;
    row.used_this_month = 0;
    return mapWallet(row);
  });
}

/** The ledger for a user, newest first — the transaction-history surface. */
export async function listTransactions(ownerId, { limit = 50 } = {}) {
  const safeLimit = Math.min(Math.max(Math.round(Number(limit) || 50), 1), 500);
  const [rows] = await getPool().query(
    `SELECT id, transaction_type, credits, balance_after, provider, model,
            customer_cost_credits, description, created_at
       FROM credit_transactions WHERE owner_id = ? ORDER BY created_at DESC LIMIT ?`,
    [ownerId, safeLimit],
  );
  return rows.map((r) => ({
    id: r.id,
    type: r.transaction_type,
    credits: Number(r.credits),
    balanceAfter: Number(r.balance_after),
    provider: r.provider,
    model: r.model,
    description: r.description,
    createdAt: toIsoString(r.created_at),
  }));
}

export { ensureWallet };
