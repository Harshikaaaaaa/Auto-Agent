import crypto from 'crypto';
import { getPool, withTransaction } from './pool.js';
import { InsufficientCreditsError, ensureWallet } from './walletRepository.js';

/**
 * Credit reservations — the R in RESERVE -> EXECUTE -> RECONCILE.
 *
 * Before an AI call, the worst-case cost is HELD against the wallet so a
 * concurrent request cannot spend the same balance and so the user cannot start
 * a call they cannot afford. Holding is done by locking the wallet row FOR
 * UPDATE, checking the available balance minus already-active reservations, and
 * recording a RESERVED row keyed by the unique request_id (so a retried request
 * reuses its hold rather than double-reserving).
 *
 * After the call, `capture(actualCredits)` debits the real cost and releases the
 * rest, or `release()` frees the whole hold when the call produced no billable
 * usage. Abandoned holds are swept by `expireStale`.
 *
 * A reservation is NOT itself a debit — the wallet balance is only reduced at
 * capture time. The "available" figure a reserve checks is
 * total_balance − sum(active reservations), so two in-flight requests see each
 * other's holds.
 */

const RESERVATION_TTL_MS = 10 * 60 * 1000;

function toIsoString(value) {
  if (!value) return null;
  const asDate = value instanceof Date ? value : new Date(`${String(value).replace(' ', 'T')}Z`);
  return Number.isNaN(asDate.getTime()) ? null : asDate.toISOString();
}

const walletTotal = (row) =>
  Number(row.subscription_credits) + Number(row.bonus_credits) + Number(row.purchased_credits);

/**
 * Hold `credits` for a request, if the wallet can cover it net of existing
 * active holds. Idempotent on request_id: calling again returns the existing
 * reservation instead of creating a second.
 *
 * @throws {InsufficientCreditsError} when available < requested.
 * @returns {Promise<{ id, requestId, reservedCredits, status }>}
 */
export async function reserveCredits(
  ownerId,
  requestId,
  credits,
  { now = new Date(), ttlMs = RESERVATION_TTL_MS } = {},
) {
  const amount = Math.max(0, Math.round(Number(credits) || 0));
  return withTransaction(async (conn) => {
    await ensureWallet(conn, ownerId, now);

    // Reuse an existing hold for this request id (a retry), so we never
    // double-reserve for one logical request.
    const [existing] = await conn.query(
      'SELECT id, reserved_credits, status FROM credit_reservations WHERE request_id = ? FOR UPDATE',
      [requestId],
    );
    if (existing.length > 0) {
      return {
        id: existing[0].id,
        requestId,
        reservedCredits: Number(existing[0].reserved_credits),
        status: existing[0].status,
        reused: true,
      };
    }

    const [walletRows] = await conn.query(
      'SELECT * FROM credit_wallets WHERE owner_id = ? FOR UPDATE',
      [ownerId],
    );
    const total = walletTotal(walletRows[0]);

    // Sum of credits already held by this owner's active reservations.
    const [heldRows] = await conn.query(
      "SELECT COALESCE(SUM(reserved_credits),0) AS held FROM credit_reservations WHERE owner_id = ? AND status = 'RESERVED'",
      [ownerId],
    );
    const held = Number(heldRows[0].held);
    const available = total - held;
    if (amount > available) throw new InsufficientCreditsError(available, amount);

    const id = crypto.randomUUID();
    const expiresAt = new Date(now.getTime() + ttlMs);
    await conn.query(
      `INSERT INTO credit_reservations
         (id, owner_id, request_id, reserved_credits, status, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'RESERVED', ?, ?, ?)`,
      [id, ownerId, requestId, amount, expiresAt, now, now],
    );
    return { id, requestId, reservedCredits: amount, status: 'RESERVED', reused: false };
  });
}

/**
 * Capture a reservation at the ACTUAL cost: debit that from the wallet (spending
 * subscription -> bonus -> purchased), mark the reservation CAPTURED, and write
 * an AI_USAGE ledger row. The unused remainder of the hold is simply released by
 * marking the reservation done — the hold was never a debit.
 *
 * Idempotent: a reservation not in RESERVED state is a no-op, so a retried
 * reconcile cannot bill twice.
 *
 * @returns {Promise<{ captured: boolean, credits: number }>}
 */
export async function captureReservation(
  requestId,
  actualCredits,
  ledger = {},
  { now = new Date() } = {},
) {
  const amount = Math.max(0, Math.round(Number(actualCredits) || 0));
  return withTransaction(async (conn) => {
    const [rows] = await conn.query(
      'SELECT * FROM credit_reservations WHERE request_id = ? FOR UPDATE',
      [requestId],
    );
    if (rows.length === 0 || rows[0].status !== 'RESERVED') {
      return { captured: false, credits: 0, reason: 'not_reserved' };
    }
    const reservation = rows[0];
    const ownerId = reservation.owner_id;

    // Debit the actual amount from the wallet (priced elsewhere), then mark the
    // hold captured. Both in this transaction so a crash cannot leave a captured
    // hold without a matching debit.
    const [walletRows] = await conn.query(
      'SELECT * FROM credit_wallets WHERE owner_id = ? FOR UPDATE',
      [ownerId],
    );
    const w = walletRows[0];
    const before = walletTotal(w);
    const charge = Math.min(amount, before); // never overdraw; the reserve guaranteed cover

    let remaining = charge;
    const take = (cur) => {
      const t = Math.min(remaining, cur);
      remaining -= t;
      return t;
    };
    const subSpend = take(Number(w.subscription_credits));
    const bonusSpend = take(Number(w.bonus_credits));
    const purchasedSpend = take(Number(w.purchased_credits));

    await conn.query(
      `UPDATE credit_wallets
         SET subscription_credits = subscription_credits - ?,
             bonus_credits = bonus_credits - ?,
             purchased_credits = purchased_credits - ?,
             used_this_month = used_this_month + ?,
             lifetime_used = lifetime_used + ?,
             updated_at = ?
       WHERE owner_id = ?`,
      [subSpend, bonusSpend, purchasedSpend, charge, charge, now, ownerId],
    );

    await conn.query(
      "UPDATE credit_reservations SET status = 'CAPTURED', updated_at = ? WHERE id = ?",
      [now, reservation.id],
    );

    if (charge > 0) {
      await conn.query(
        `INSERT INTO credit_transactions
           (id, owner_id, transaction_type, credits, balance_before, balance_after,
            subscription_credits_change, purchased_credits_change, bonus_credits_change,
            provider, model, input_tokens, cached_input_tokens, output_tokens, reasoning_tokens,
            provider_cost_usd_micros, customer_cost_credits, ai_request_id, description, created_at)
         VALUES (?, ?, 'AI_USAGE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          ownerId,
          String(-charge),
          String(before),
          String(before - charge),
          String(-subSpend),
          String(-purchasedSpend),
          String(-bonusSpend),
          ledger.provider ?? null,
          ledger.model ?? null,
          ledger.inputTokens ?? null,
          ledger.cachedInputTokens ?? null,
          ledger.outputTokens ?? null,
          ledger.reasoningTokens ?? null,
          ledger.providerCostUsdMicros ?? null,
          charge,
          requestId,
          ledger.description ?? 'AI usage',
          now,
        ],
      );
    }

    return { captured: true, credits: charge };
  });
}

/** Release a reservation without charging (the call produced no billable usage). */
export async function releaseReservation(requestId, { now = new Date() } = {}) {
  const [result] = await getPool().query(
    "UPDATE credit_reservations SET status = 'RELEASED', updated_at = ? WHERE request_id = ? AND status = 'RESERVED'",
    [now, requestId],
  );
  return result.affectedRows > 0;
}

/** Expire holds past their TTL, so an abandoned request frees its credits. */
export async function expireStaleReservations({ now = new Date() } = {}) {
  const [result] = await getPool().query(
    "UPDATE credit_reservations SET status = 'EXPIRED', updated_at = ? WHERE status = 'RESERVED' AND expires_at < ?",
    [now, now],
  );
  return result.affectedRows;
}

/** A reservation by request id, for tests/diagnostics. */
export async function getReservation(requestId) {
  const [rows] = await getPool().query(
    'SELECT id, owner_id, request_id, reserved_credits, status, expires_at, created_at FROM credit_reservations WHERE request_id = ?',
    [requestId],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    ownerId: r.owner_id,
    requestId: r.request_id,
    reservedCredits: Number(r.reserved_credits),
    status: r.status,
    expiresAt: toIsoString(r.expires_at),
    createdAt: toIsoString(r.created_at),
  };
}
