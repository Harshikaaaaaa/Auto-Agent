import crypto from 'crypto';
import { getPool, withTransaction } from './pool.js';

/**
 * Payment records. A payment moves PENDING -> PAID (or FAILED), and PAID is set
 * exactly once per gateway payment id: the `gateway_payment_id` column is UNIQUE
 * and the transition is guarded FOR UPDATE, so a webhook delivered twice cannot
 * grant credits twice. That idempotency is the whole point of this table.
 */

function toIsoString(value) {
  if (!value) return null;
  const asDate = value instanceof Date ? value : new Date(`${String(value).replace(' ', 'T')}Z`);
  return Number.isNaN(asDate.getTime()) ? null : asDate.toISOString();
}

function mapPayment(row) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    gateway: row.payment_gateway,
    orderId: row.gateway_order_id,
    paymentId: row.gateway_payment_id,
    type: row.type,
    amountPaise: Number(row.amount_paise),
    currency: row.currency,
    creditsPurchased: row.credits_purchased === null ? null : Number(row.credits_purchased),
    subscriptionPlanId: row.subscription_plan_id,
    packageId: row.package_id,
    status: row.status,
    failureReason: row.failure_reason,
    createdAt: toIsoString(row.created_at),
    paidAt: toIsoString(row.paid_at),
  };
}

/**
 * Create a PENDING payment for an order. Called when the user starts checkout.
 * @returns the payment id.
 */
export async function createPendingPayment(input, { now = new Date() } = {}) {
  const id = crypto.randomUUID();
  await getPool().query(
    'INSERT INTO owners (id, created_at) VALUES (?, ?) ON DUPLICATE KEY UPDATE id = id',
    [input.ownerId, now],
  );
  await getPool().query(
    `INSERT INTO payments
       (id, owner_id, payment_gateway, gateway_order_id, gateway_payment_id, type,
        amount_paise, currency, credits_purchased, subscription_plan_id, package_id,
        coupon_id, status, metadata, created_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
    [
      id,
      input.ownerId,
      input.gateway ?? 'razorpay',
      input.orderId,
      input.type,
      Math.round(Number(input.amountPaise)),
      input.currency ?? 'INR',
      input.creditsPurchased ?? null,
      input.subscriptionPlanId ?? null,
      input.packageId ?? null,
      input.couponId ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      now,
    ],
  );
  return id;
}

export async function findPaymentByOrderId(orderId) {
  const [rows] = await getPool().query(
    'SELECT * FROM payments WHERE gateway_order_id = ? ORDER BY created_at DESC LIMIT 1',
    [orderId],
  );
  return rows.length > 0 ? mapPayment(rows[0]) : null;
}

/**
 * Mark a payment PAID, exactly once, and run `onFirstPaid(payment, conn)` inside
 * the SAME transaction — that callback grants the credits / activates the plan.
 * If the payment is already PAID (a duplicate webhook), the callback does NOT
 * run and the function reports `alreadyPaid: true`. This is the idempotency
 * guarantee: credits are granted on the FIRST transition only.
 *
 * @returns {Promise<{ paid: boolean, alreadyPaid: boolean, payment: object|null }>}
 */
export async function markPaidOnce(
  orderId,
  gatewayPaymentId,
  onFirstPaid,
  { now = new Date() } = {},
) {
  return withTransaction(async (conn) => {
    const [rows] = await conn.query(
      'SELECT * FROM payments WHERE gateway_order_id = ? ORDER BY created_at DESC LIMIT 1 FOR UPDATE',
      [orderId],
    );
    if (rows.length === 0) return { paid: false, alreadyPaid: false, payment: null };
    const row = rows[0];

    if (row.status === 'PAID') {
      return { paid: false, alreadyPaid: true, payment: mapPayment(row) };
    }

    await conn.query(
      `UPDATE payments SET status = 'PAID', gateway_payment_id = ?, paid_at = ? WHERE id = ?`,
      [gatewayPaymentId, now, row.id],
    );

    const payment = mapPayment({
      ...row,
      status: 'PAID',
      gateway_payment_id: gatewayPaymentId,
      paid_at: now,
    });
    if (onFirstPaid) await onFirstPaid(payment, conn);
    return { paid: true, alreadyPaid: false, payment };
  });
}

/** Mark a payment FAILED with a reason. */
export async function markFailed(orderId, reason) {
  await getPool().query(
    `UPDATE payments SET status = 'FAILED', failure_reason = ? WHERE gateway_order_id = ? AND status = 'PENDING'`,
    [String(reason ?? '').slice(0, 500), orderId],
  );
  return findPaymentByOrderId(orderId);
}

/** A user's payments, newest first — the payment-history surface. */
export async function listPayments(ownerId, { limit = 50 } = {}) {
  const safeLimit = Math.min(Math.max(Math.round(Number(limit) || 50), 1), 500);
  const [rows] = await getPool().query(
    'SELECT * FROM payments WHERE owner_id = ? ORDER BY created_at DESC LIMIT ?',
    [ownerId, safeLimit],
  );
  return rows.map(mapPayment);
}

/** Whether the owner has ever completed a payment (for first-payment coupons). */
export async function hasPaidBefore(ownerId) {
  const [rows] = await getPool().query(
    "SELECT COUNT(*) AS n FROM payments WHERE owner_id = ? AND status = 'PAID'",
    [ownerId],
  );
  return Number(rows[0].n) > 0;
}

export { mapPayment };
