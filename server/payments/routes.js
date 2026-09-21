import express from 'express';
import { logger } from '../lib/logger.js';
import * as razorpay from './razorpay.js';
import { GatewayNotConfiguredError } from './gateway.js';
import {
  createPendingPayment,
  findPaymentByOrderId,
  hasPaidBefore,
  markFailed,
  markPaidOnce,
  listPayments,
} from '../db/paymentRepository.js';
import { listPlans, getPlanById, activatePlan } from '../db/subscriptionRepository.js';
import { listPackages, getPackageById } from '../db/creditPackageRepository.js';
import {
  applyDiscount,
  findCouponByCode,
  recordRedemption,
  validateCoupon,
} from '../db/couponRepository.js';

/**
 * Payment routes.
 *
 * TWO mount points, on purpose:
 *  - The WEBHOOK is public but signature-verified, and must be registered
 *    BEFORE the /api/billing session guard (setupBillingWebhook), because a
 *    gateway is not a signed-in user. It also needs the RAW body to verify the
 *    HMAC, so it uses express.raw, not the JSON parser.
 *  - Everything else (order creation, subscription management, history) is
 *    session-gated and lives under /api/billing (setupPaymentRoutes), mounted
 *    after the guard in api.js.
 *
 * Credits/plan activation happen ONLY from the verified webhook, never from a
 * browser callback — the frontend is never trusted with payment success.
 */

function ownerOf(req) {
  return req.session?.sub ?? 'unknown';
}

function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof GatewayNotConfiguredError) {
        return res.status(503).json({ error: 'gateway_not_configured', message: err.message });
      }
      if (err?.status === 502) {
        return res.status(502).json({ error: 'gateway_error', message: err.message });
      }
      logger.error({ err, path: req.originalUrl }, 'payment route failed');
      return res.status(500).json({ error: 'internal_error', message: 'Something went wrong.' });
    }
  };
}

// ------------------------------------------------------------ public webhook

/**
 * The verified-webhook handler. Exported for direct testing without a live
 * gateway. Grants credits / activates the plan exactly once per order via
 * markPaidOnce, which is idempotent under a duplicate delivery.
 */
export async function handleVerifiedWebhook(parsed, { now = new Date() } = {}) {
  if (!parsed.orderId) return { handled: false, reason: 'no_order' };

  // A captured payment grants; a failed one marks the pending payment FAILED so
  // the history reflects it (a captured order later still settles idempotently).
  if (parsed.status === 'failed') {
    await markFailed(parsed.orderId, parsed.event ?? 'payment.failed');
    return { handled: true, failed: true };
  }
  if (parsed.status !== 'captured') {
    return { handled: false, reason: 'not_captured' };
  }
  return settlePaidOrder(parsed.orderId, parsed.paymentId, { now });
}

/**
 * The one place a paid order grants its credits / activates its plan. Runs
 * inside markPaidOnce, so it fires EXACTLY ONCE per order no matter how many
 * confirmations arrive — the webhook AND the browser verify callback both funnel
 * through here, and whichever lands first wins; the rest are no-ops. That is why
 * the webhook is not mandatory: on localhost the verify callback settles the
 * order, and in production the webhook does — either way, once.
 */
export async function settlePaidOrder(orderId, paymentId, { now = new Date() } = {}) {
  const result = await markPaidOnce(
    orderId,
    paymentId,
    async (payment, conn) => {
      if (payment.type === 'CREDIT_TOPUP') {
        const pkg = payment.packageId ? await getPackageById(payment.packageId) : null;
        const credits = pkg ? pkg.credits : (payment.creditsPurchased ?? 0);
        const bonus = pkg ? pkg.bonusCredits : 0;
        // Purchased credits go in the purchased bucket; package bonus in bonus.
        await creditWalletTx(conn, payment.ownerId, 'purchased', credits, {
          type: 'TOPUP',
          paymentId: payment.id,
          description: 'Credit top-up',
          now,
        });
        if (bonus > 0) {
          await creditWalletTx(conn, payment.ownerId, 'bonus', bonus, {
            type: 'BONUS',
            paymentId: payment.id,
            description: 'Top-up bonus credits',
            now,
          });
        }
      } else if (payment.type === 'SUBSCRIPTION') {
        const plan = payment.subscriptionPlanId
          ? await getPlanById(payment.subscriptionPlanId)
          : null;
        if (plan) {
          await activatePlan(conn, { ownerId: payment.ownerId, plan }, { now });
          await resetSubscriptionCreditsTx(conn, payment.ownerId, plan.includedCredits, {
            paymentId: payment.id,
            now,
          });
        }
      }

      // Record a coupon redemption if one rode along on the payment.
      if (payment.couponId) {
        await recordRedemption(
          conn,
          {
            couponId: payment.couponId,
            ownerId: payment.ownerId,
            paymentId: payment.id,
          },
          { now },
        );
      }
    },
    { now },
  );

  return { handled: result.paid, alreadyPaid: result.alreadyPaid };
}

/**
 * Credit a wallet bucket inside an EXISTING transaction (the webhook's). Mirrors
 * walletRepository.creditWallet but reuses the connection so the grant and the
 * PAID transition commit together.
 */
async function creditWalletTx(conn, ownerId, bucket, credits, ledger, { now = new Date() } = {}) {
  const crypto = await import('crypto');
  const amount = Math.max(0, Math.round(Number(credits) || 0));
  const column =
    bucket === 'subscription'
      ? 'subscription_credits'
      : bucket === 'purchased'
        ? 'purchased_credits'
        : 'bonus_credits';
  await conn.query(
    'INSERT INTO owners (id, created_at) VALUES (?, ?) ON DUPLICATE KEY UPDATE id = id',
    [ownerId, now],
  );
  await conn.query(
    `INSERT INTO credit_wallets (owner_id, subscription_credits, bonus_credits, purchased_credits, used_this_month, lifetime_used, created_at, updated_at)
     VALUES (?, 0, 0, 0, 0, 0, ?, ?) ON DUPLICATE KEY UPDATE owner_id = owner_id`,
    [ownerId, now, now],
  );
  const [rows] = await conn.query('SELECT * FROM credit_wallets WHERE owner_id = ? FOR UPDATE', [
    ownerId,
  ]);
  const w = rows[0];
  const before =
    Number(w.subscription_credits) + Number(w.bonus_credits) + Number(w.purchased_credits);
  await conn.query(
    `UPDATE credit_wallets SET ${column} = ${column} + ?, updated_at = ? WHERE owner_id = ?`,
    [amount, now, ownerId],
  );
  await conn.query(
    `INSERT INTO credit_transactions
       (id, owner_id, transaction_type, credits, balance_before, balance_after,
        subscription_credits_change, purchased_credits_change, bonus_credits_change,
        payment_id, description, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      crypto.randomUUID(),
      ownerId,
      ledger.type ?? 'TOPUP',
      String(amount),
      String(before),
      String(before + amount),
      String(bucket === 'subscription' ? amount : 0),
      String(bucket === 'purchased' ? amount : 0),
      String(bucket === 'bonus' ? amount : 0),
      ledger.paymentId ?? null,
      ledger.description ?? null,
      now,
    ],
  );
}

/** Reset the subscription bucket inside the webhook transaction. */
async function resetSubscriptionCreditsTx(
  conn,
  ownerId,
  credits,
  { paymentId, now = new Date() } = {},
) {
  const crypto = await import('crypto');
  const amount = Math.max(0, Math.round(Number(credits) || 0));
  // Ensure the wallet row exists before locking it — a first-time subscriber may
  // have no wallet yet (the top-up path creates one; this path must too).
  await conn.query(
    'INSERT INTO owners (id, created_at) VALUES (?, ?) ON DUPLICATE KEY UPDATE id = id',
    [ownerId, now],
  );
  await conn.query(
    `INSERT INTO credit_wallets (owner_id, subscription_credits, bonus_credits, purchased_credits, used_this_month, lifetime_used, created_at, updated_at)
     VALUES (?, 0, 0, 0, 0, 0, ?, ?) ON DUPLICATE KEY UPDATE owner_id = owner_id`,
    [ownerId, now, now],
  );
  const [rows] = await conn.query('SELECT * FROM credit_wallets WHERE owner_id = ? FOR UPDATE', [
    ownerId,
  ]);
  const w = rows[0] ?? { subscription_credits: 0, bonus_credits: 0, purchased_credits: 0 };
  const before =
    Number(w.subscription_credits) + Number(w.bonus_credits) + Number(w.purchased_credits);
  const prevSub = Number(w.subscription_credits ?? 0);
  await conn.query(
    'UPDATE credit_wallets SET subscription_credits = ?, used_this_month = 0, updated_at = ? WHERE owner_id = ?',
    [amount, now, ownerId],
  );
  await conn.query(
    `INSERT INTO credit_transactions
       (id, owner_id, transaction_type, credits, balance_before, balance_after,
        subscription_credits_change, payment_id, description, created_at)
     VALUES (?, ?, 'SUBSCRIPTION_CREDIT', ?, ?, ?, ?, ?, 'Subscription credits', ?)`,
    [
      crypto.randomUUID(),
      ownerId,
      String(amount - prevSub),
      String(before),
      String(before - prevSub + amount),
      String(amount - prevSub),
      paymentId ?? null,
      now,
    ],
  );
}

/** Register the PUBLIC, signature-verified webhook. Call BEFORE the guard. */
export function setupPaymentWebhook(app) {
  app.post('/api/billing/webhook', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    const signature = req.get('x-razorpay-signature');
    const rawBody = req.body; // Buffer, thanks to express.raw
    if (!razorpay.verifyWebhookSignature(rawBody, signature)) {
      logger.warn({ path: req.originalUrl }, 'rejected a webhook with a bad signature');
      return res.status(400).json({ error: 'invalid_signature' });
    }
    let body;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'invalid_body' });
    }
    try {
      const parsed = razorpay.parseWebhook(body);
      await handleVerifiedWebhook(parsed);
      // Always 200 to a verified webhook so the gateway does not retry a
      // duplicate we have already handled idempotently.
      return res.json({ received: true });
    } catch (err) {
      logger.error({ err }, 'webhook processing failed after verification');
      // 500 so the gateway retries — markPaidOnce makes the retry safe.
      return res.status(500).json({ error: 'processing_failed' });
    }
  });
}

// ------------------------------------------------------ session-gated routes

export function setupPaymentRoutes(app) {
  /** Public catalogue: plans and packages for the pricing / add-credits pages. */
  app.get(
    '/api/billing/plans',
    handle(async (_req, res) => {
      res.json({ plans: await listPlans() });
    }),
  );

  app.get(
    '/api/billing/packages',
    handle(async (_req, res) => {
      res.json({ packages: await listPackages() });
    }),
  );

  /** Validate a coupon against a context, for the checkout UI. */
  app.post(
    '/api/billing/coupon/validate',
    handle(async (req, res) => {
      const code = String(req.body?.code ?? '');
      const appliesTo = req.body?.appliesTo === 'plan' ? 'plan' : 'topup';
      const paid = await hasPaidBefore(ownerOf(req));
      const result = await validateCoupon(code, {
        ownerId: ownerOf(req),
        appliesTo,
        hasPaidBefore: paid,
      });
      if (!result.ok)
        return res.status(400).json({ error: 'invalid_coupon', reason: result.reason });
      res.json({ ok: true, coupon: { code: result.coupon.code, type: result.coupon.couponType } });
    }),
  );

  /** Start a credit top-up: create a PENDING payment + a gateway order. */
  app.post(
    '/api/billing/topup/order',
    handle(async (req, res) => {
      if (!razorpay.isConfigured()) throw new GatewayNotConfiguredError('razorpay');
      const pkg = await getPackageById(String(req.body?.packageId ?? ''));
      if (!pkg || !pkg.enabled) {
        return res
          .status(400)
          .json({ error: 'invalid_package', message: 'Unknown credit package.' });
      }

      const { finalPaise, couponId } = await priceWithOptionalCoupon(req, pkg.pricePaise, 'topup');
      const order = await razorpay.createOrder({
        amountPaise: finalPaise,
        receipt: `topup-${pkg.code}-${Date.now()}`,
        notes: { ownerId: ownerOf(req), type: 'CREDIT_TOPUP', packageId: pkg.id },
      });
      await createPendingPayment({
        ownerId: ownerOf(req),
        orderId: order.orderId,
        type: 'CREDIT_TOPUP',
        amountPaise: finalPaise,
        creditsPurchased: pkg.credits + pkg.bonusCredits,
        packageId: pkg.id,
        couponId,
      });
      res.json({ order });
    }),
  );

  /** Start a subscription: create a PENDING payment + a gateway order. */
  app.post(
    '/api/billing/subscribe/order',
    handle(async (req, res) => {
      if (!razorpay.isConfigured()) throw new GatewayNotConfiguredError('razorpay');
      const plan = await getPlanById(String(req.body?.planId ?? ''));
      if (!plan || !plan.enabled) {
        return res.status(400).json({ error: 'invalid_plan', message: 'Unknown plan.' });
      }
      if (plan.pricePaise <= 0) {
        return res
          .status(400)
          .json({ error: 'free_plan', message: 'The Free plan needs no payment.' });
      }

      const { finalPaise, couponId } = await priceWithOptionalCoupon(req, plan.pricePaise, 'plan');
      const order = await razorpay.createOrder({
        amountPaise: finalPaise,
        receipt: `sub-${plan.code}-${Date.now()}`,
        notes: { ownerId: ownerOf(req), type: 'SUBSCRIPTION', planId: plan.id },
      });
      await createPendingPayment({
        ownerId: ownerOf(req),
        orderId: order.orderId,
        type: 'SUBSCRIPTION',
        amountPaise: finalPaise,
        subscriptionPlanId: plan.id,
        couponId,
      });
      res.json({ order });
    }),
  );

  /**
   * Confirm a payment straight from the browser checkout callback.
   *
   * Razorpay's checkout handler returns { order_id, payment_id, signature }; the
   * signature is HMAC(order_id|payment_id) keyed by the key secret, so a browser
   * cannot forge it. We verify it server-side and, if valid, settle the order
   * through the SAME idempotent path the webhook uses. This is what lets a local
   * deployment (where Razorpay cannot reach the webhook) still credit the wallet
   * — and it stays safe and exactly-once because settlePaidOrder is idempotent,
   * so a later webhook for the same order simply no-ops.
   */
  app.post(
    '/api/billing/verify',
    handle(async (req, res) => {
      const orderId = String(req.body?.razorpay_order_id ?? '');
      const paymentId = String(req.body?.razorpay_payment_id ?? '');
      const signature = String(req.body?.razorpay_signature ?? '');

      if (!razorpay.verifyPaymentSignature({ orderId, paymentId, signature })) {
        return res.status(400).json({ error: 'invalid_signature' });
      }

      // The order must belong to the caller — never settle another user's order.
      const payment = await findPaymentByOrderId(orderId);
      if (!payment || payment.ownerId !== ownerOf(req)) {
        return res.status(404).json({ error: 'not_found', message: 'No such order.' });
      }

      const result = await settlePaidOrder(orderId, paymentId);
      res.json({ ok: true, credited: result.handled, alreadyCredited: result.alreadyPaid });
    }),
  );

  /** Cancel at period end (keeps access until the period ends). */
  app.post(
    '/api/billing/subscription/cancel',
    handle(async (req, res) => {
      const { setCancelAtPeriodEnd } = await import('../db/subscriptionRepository.js');
      const ok = await setCancelAtPeriodEnd(ownerOf(req), true);
      res.json({ cancelAtPeriodEnd: ok });
    }),
  );

  /** Resume a subscription flagged to cancel. */
  app.post(
    '/api/billing/subscription/resume',
    handle(async (req, res) => {
      const { setCancelAtPeriodEnd } = await import('../db/subscriptionRepository.js');
      const ok = await setCancelAtPeriodEnd(ownerOf(req), false);
      res.json({ cancelAtPeriodEnd: !ok });
    }),
  );

  /** Payment history. */
  app.get(
    '/api/billing/payments',
    handle(async (req, res) => {
      const limit = Number(req.query.limit);
      res.json({
        payments: await listPayments(ownerOf(req), {
          limit: Number.isFinite(limit) ? limit : undefined,
        }),
      });
    }),
  );

  // Marked unused-friendly: referenced by the two order routes above.
  async function priceWithOptionalCoupon(req, basePaise, appliesTo) {
    const code = req.body?.couponCode;
    if (!code) return { finalPaise: basePaise, couponId: null };
    const paid = await hasPaidBefore(ownerOf(req));
    const result = await validateCoupon(code, {
      ownerId: ownerOf(req),
      appliesTo,
      hasPaidBefore: paid,
    });
    if (!result.ok) return { finalPaise: basePaise, couponId: null };
    const { finalPaise } = applyDiscount(result.coupon, basePaise);
    return { finalPaise, couponId: result.coupon.id };
  }
}

// Re-exported so tests can drive the failure path without a gateway.
export { markFailed, findPaymentByOrderId, findCouponByCode };
