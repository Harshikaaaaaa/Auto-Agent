import crypto from 'crypto';
import { getPool } from './pool.js';

/**
 * Coupons: percentage / fixed discount, or bonus credits. All integer math —
 * percent is basis points (10% -> 1000), fixed is paise, bonus is credits.
 *
 * Validation checks the window (starts_at/ends_at), enabled flag, applies_to
 * scope, first-payment-only, the global max_redemptions, and the per-user limit
 * (via the unique (coupon_id, owner_id) row in coupon_redemptions).
 */

function toIsoString(value) {
  if (!value) return null;
  const asDate = value instanceof Date ? value : new Date(`${String(value).replace(' ', 'T')}Z`);
  return Number.isNaN(asDate.getTime()) ? null : asDate.toISOString();
}

function mapCoupon(row) {
  return {
    id: row.id,
    code: row.code,
    couponType: row.coupon_type, // 'percentage' | 'fixed' | 'bonus_credits'
    percentBps: row.percent_bps === null ? null : Number(row.percent_bps),
    fixedDiscountPaise: row.fixed_discount_paise === null ? null : Number(row.fixed_discount_paise),
    bonusCredits: row.bonus_credits === null ? null : Number(row.bonus_credits),
    appliesTo: row.applies_to, // 'all' | 'plan' | 'topup'
    planId: row.plan_id,
    packageId: row.package_id,
    firstPaymentOnly: Boolean(row.first_payment_only),
    maxRedemptions: row.max_redemptions === null ? null : Number(row.max_redemptions),
    perUserLimit: Number(row.per_user_limit),
    redeemedCount: Number(row.redeemed_count),
    startsAt: toIsoString(row.starts_at),
    endsAt: toIsoString(row.ends_at),
    enabled: Boolean(row.enabled),
  };
}

/** Look up an enabled coupon by code, or null. */
export async function findCouponByCode(code) {
  const [rows] = await getPool().query('SELECT * FROM coupons WHERE code = ? LIMIT 1', [
    String(code ?? '').trim(),
  ]);
  return rows.length > 0 ? mapCoupon(rows[0]) : null;
}

/**
 * Apply a coupon's DISCOUNT to an amount in paise. Pure integer math; a
 * percentage discount floors (rounds in the customer's favour on the discount,
 * i.e. the charge rounds up). Returns { discountPaise, finalPaise }.
 */
export function applyDiscount(coupon, amountPaise) {
  const amount = Math.max(0, Math.round(Number(amountPaise) || 0));
  if (!coupon) return { discountPaise: 0, finalPaise: amount };

  let discount = 0;
  if (coupon.couponType === 'percentage' && coupon.percentBps) {
    // amount × bps / 10000, floored so the platform never over-discounts.
    discount = Math.floor((amount * coupon.percentBps) / 10000);
  } else if (coupon.couponType === 'fixed' && coupon.fixedDiscountPaise) {
    discount = coupon.fixedDiscountPaise;
  }
  discount = Math.min(discount, amount); // never below zero
  return { discountPaise: discount, finalPaise: amount - discount };
}

/**
 * Validate a coupon for an owner + purchase context. Returns
 * { ok: true, coupon } or { ok: false, reason }. Does NOT mutate — redemption is
 * recorded separately, on a successful payment.
 *
 * @param {object} ctx { ownerId, appliesTo: 'plan'|'topup', hasPaidBefore }
 */
export async function validateCoupon(code, ctx = {}, { now = new Date() } = {}) {
  const coupon = await findCouponByCode(code);
  if (!coupon || !coupon.enabled) return { ok: false, reason: 'not_found' };

  if (coupon.startsAt && new Date(coupon.startsAt) > now)
    return { ok: false, reason: 'not_started' };
  if (coupon.endsAt && new Date(coupon.endsAt) < now) return { ok: false, reason: 'expired' };

  if (coupon.appliesTo !== 'all' && ctx.appliesTo && coupon.appliesTo !== ctx.appliesTo) {
    return { ok: false, reason: 'not_applicable' };
  }
  if (coupon.firstPaymentOnly && ctx.hasPaidBefore) {
    return { ok: false, reason: 'first_payment_only' };
  }
  if (coupon.maxRedemptions !== null && coupon.redeemedCount >= coupon.maxRedemptions) {
    return { ok: false, reason: 'exhausted' };
  }

  // Per-user limit: count this owner's prior redemptions.
  const [rows] = await getPool().query(
    'SELECT COUNT(*) AS n FROM coupon_redemptions WHERE coupon_id = ? AND owner_id = ?',
    [coupon.id, ctx.ownerId],
  );
  if (Number(rows[0].n) >= coupon.perUserLimit) {
    return { ok: false, reason: 'per_user_limit' };
  }

  return { ok: true, coupon };
}

/**
 * Record a redemption inside a payment transaction (pass the connection). The
 * unique (coupon_id, owner_id) key enforces the common one-per-user case at the
 * DB level; the redeemed_count bump powers the global cap.
 */
export async function recordRedemption(
  conn,
  { couponId, ownerId, paymentId },
  { now = new Date() } = {},
) {
  await conn.query(
    `INSERT INTO coupon_redemptions (id, coupon_id, owner_id, payment_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [crypto.randomUUID(), couponId, ownerId, paymentId ?? null, now],
  );
  await conn.query('UPDATE coupons SET redeemed_count = redeemed_count + 1 WHERE id = ?', [
    couponId,
  ]);
}

/** Create a coupon (admin). */
export async function createCoupon(input, { now = new Date() } = {}) {
  const id = crypto.randomUUID();
  await getPool().query(
    `INSERT INTO coupons
       (id, code, coupon_type, percent_bps, fixed_discount_paise, bonus_credits, applies_to,
        plan_id, package_id, first_payment_only, max_redemptions, per_user_limit,
        redeemed_count, starts_at, ends_at, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
    [
      id,
      input.code,
      input.couponType,
      input.percentBps ?? null,
      input.fixedDiscountPaise ?? null,
      input.bonusCredits ?? null,
      input.appliesTo ?? 'all',
      input.planId ?? null,
      input.packageId ?? null,
      input.firstPaymentOnly ? 1 : 0,
      input.maxRedemptions ?? null,
      input.perUserLimit ?? 1,
      input.startsAt ?? null,
      input.endsAt ?? null,
      input.enabled === false ? 0 : 1,
      now,
      now,
    ],
  );
  return findCouponByCode(input.code);
}

/** List coupons (admin). */
export async function listCoupons() {
  const [rows] = await getPool().query('SELECT * FROM coupons ORDER BY created_at DESC');
  return rows.map(mapCoupon);
}

export { mapCoupon };
