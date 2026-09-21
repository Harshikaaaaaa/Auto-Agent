import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  TEST_DB_NAME,
  isMysqlAvailable,
  loadDbModules,
  restoreEnv,
  truncateAll,
} from '../../test/dbTestHelper.js';

/**
 * The webhook-driven grant path against real MySQL: a top-up adds PURCHASED
 * credits only after a captured payment, a subscription payment activates the
 * plan and grants monthly credits, and a DUPLICATE webhook never double-grants.
 */

const originalEnv = { ...process.env };
const mysqlAvailable = await isMysqlAvailable();

let pool;
let wallet;
let payments;
let packages;
let subscriptions;
let handleVerifiedWebhook;

const OWNER = 'owner-payment-test';

beforeAll(async () => {
  if (!mysqlAvailable) {
    console.warn('[paymentFlow.test] MySQL not reachable — skipping');
    return;
  }
  const m = await loadDbModules(vi, {
    DB_NAME: `${TEST_DB_NAME}_pay`,
    RAZORPAY_KEY_ID: 'rzp_test',
    RAZORPAY_KEY_SECRET: 'secret',
    RAZORPAY_WEBHOOK_SECRET: 'whsec',
  });
  pool = m.pool;
  wallet = m.wallet;
  payments = m.payments;
  packages = m.packages;
  subscriptions = m.subscriptions;
  ({ handleVerifiedWebhook } = await import('../routes.js'));
});

afterEach(async () => {
  if (mysqlAvailable && pool) await truncateAll(pool);
});

afterAll(async () => {
  if (mysqlAvailable && pool) await pool.closePool();
  restoreEnv(originalEnv);
});

const captured = (orderId, paymentId, amountPaise) => ({
  event: 'payment.captured',
  orderId,
  paymentId,
  status: 'captured',
  amountPaise,
});

describe.skipIf(!mysqlAvailable)('credit top-up via webhook', () => {
  it('adds purchased + bonus credits only after the captured webhook', async () => {
    const pkgs = await packages.listPackages();
    const pkg = pkgs.find((p) => p.code === 'pack_499'); // 50,000 + 2,500 bonus
    await payments.createPendingPayment({
      ownerId: OWNER,
      orderId: 'order_topup_1',
      type: 'CREDIT_TOPUP',
      amountPaise: pkg.pricePaise,
      creditsPurchased: pkg.credits + pkg.bonusCredits,
      packageId: pkg.id,
    });

    // Before the webhook: no credits.
    expect(await wallet.getWallet(OWNER)).toBeNull();

    const res = await handleVerifiedWebhook(captured('order_topup_1', 'pay_1', pkg.pricePaise));
    expect(res.handled).toBe(true);

    const w = await wallet.getWallet(OWNER);
    expect(w.purchasedCredits).toBe(pkg.credits); // 50,000 in the purchased bucket
    expect(w.bonusCredits).toBe(pkg.bonusCredits); // 2,500 bonus separate
  });

  it('does NOT double-grant when the same webhook is delivered twice', async () => {
    const pkgs = await packages.listPackages();
    const pkg = pkgs.find((p) => p.code === 'pack_99'); // 10,000, no bonus
    await payments.createPendingPayment({
      ownerId: OWNER,
      orderId: 'order_dup',
      type: 'CREDIT_TOPUP',
      amountPaise: pkg.pricePaise,
      packageId: pkg.id,
    });

    const first = await handleVerifiedWebhook(captured('order_dup', 'pay_x', pkg.pricePaise));
    const second = await handleVerifiedWebhook(captured('order_dup', 'pay_x', pkg.pricePaise));
    expect(first.handled).toBe(true);
    expect(second.handled).toBe(false);
    expect(second.alreadyPaid).toBe(true);

    const w = await wallet.getWallet(OWNER);
    expect(w.purchasedCredits).toBe(pkg.credits); // granted exactly once
    // Exactly one TOPUP ledger row.
    const tx = await wallet.listTransactions(OWNER);
    expect(tx.filter((t) => t.type === 'TOPUP')).toHaveLength(1);
  });

  it('grants no credits on a failed webhook, and marks the payment FAILED', async () => {
    await payments.createPendingPayment({
      ownerId: OWNER,
      orderId: 'order_pending',
      type: 'CREDIT_TOPUP',
      amountPaise: 9900,
      creditsPurchased: 10000,
    });
    const res = await handleVerifiedWebhook({
      event: 'payment.failed',
      orderId: 'order_pending',
      paymentId: 'pay_f',
      status: 'failed',
      amountPaise: 9900,
    });
    // The failed event is handled (recorded) but grants nothing.
    expect(res.failed).toBe(true);
    expect(await wallet.getWallet(OWNER)).toBeNull();
    const p = await payments.findPaymentByOrderId('order_pending');
    expect(p.status).toBe('FAILED');
  });

  it('ignores a webhook whose status is neither captured nor failed', async () => {
    const res = await handleVerifiedWebhook({
      event: 'payment.authorized',
      orderId: 'order_x',
      paymentId: 'pay_x',
      status: 'authorized',
      amountPaise: 9900,
    });
    expect(res.handled).toBe(false);
  });
});

describe.skipIf(!mysqlAvailable)('browser verify-callback settlement (localhost path)', () => {
  it('settles a paid order once via settlePaidOrder, idempotent with the webhook', async () => {
    const { settlePaidOrder } = await import('../routes.js');
    const pkgs = await packages.listPackages();
    const pkg = pkgs.find((p) => p.code === 'pack_99'); // 10,000
    await payments.createPendingPayment({
      ownerId: OWNER,
      orderId: 'order_verify_1',
      type: 'CREDIT_TOPUP',
      amountPaise: pkg.pricePaise,
      packageId: pkg.id,
    });

    // The browser verify callback settles first (no webhook reached us).
    const first = await settlePaidOrder('order_verify_1', 'pay_v');
    expect(first.handled).toBe(true);

    // A later webhook for the same order is a no-op — credited exactly once.
    const late = await handleVerifiedWebhook(captured('order_verify_1', 'pay_v', pkg.pricePaise));
    expect(late.handled).toBe(false);
    expect(late.alreadyPaid).toBe(true);

    const w = await wallet.getWallet(OWNER);
    expect(w.purchasedCredits).toBe(pkg.credits);
  });
});

describe.skipIf(!mysqlAvailable)('subscription via webhook', () => {
  it('activates the plan and grants monthly credits on capture', async () => {
    const pro = await subscriptions.getPlanByCode('pro'); // 90,000 credits
    await payments.createPendingPayment({
      ownerId: OWNER,
      orderId: 'order_sub_1',
      type: 'SUBSCRIPTION',
      amountPaise: pro.pricePaise,
      subscriptionPlanId: pro.id,
    });

    await handleVerifiedWebhook(captured('order_sub_1', 'pay_s', pro.pricePaise));

    expect(await subscriptions.getActivePlanCode(OWNER)).toBe('pro');
    const w = await wallet.getWallet(OWNER);
    expect(w.subscriptionCredits).toBe(pro.includedCredits); // 90,000 monthly
  });
});

describe.skipIf(!mysqlAvailable)('coupon discount math', () => {
  it('applies a percentage discount with integer floor', async () => {
    const { applyDiscount } = await import('../../db/couponRepository.js');
    // 10% off ₹499 (49900 paise) = 4990 off -> 44910.
    const pct = { couponType: 'percentage', percentBps: 1000 };
    expect(applyDiscount(pct, 49900)).toEqual({ discountPaise: 4990, finalPaise: 44910 });
    // A fixed ₹100 (10000 paise) discount.
    const fixed = { couponType: 'fixed', fixedDiscountPaise: 10000 };
    expect(applyDiscount(fixed, 49900)).toEqual({ discountPaise: 10000, finalPaise: 39900 });
    // Discount can never exceed the amount.
    expect(applyDiscount(fixed, 5000)).toEqual({ discountPaise: 5000, finalPaise: 0 });
  });
});
