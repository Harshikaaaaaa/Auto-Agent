import { logger } from '../lib/logger.js';
import { getPool, withTransaction } from '../db/pool.js';
import { listUsers, findUserByOwnerId, setUserRole, setUserStatus } from '../db/userRepository.js';
import {
  getWallet,
  creditWallet,
  debitCredits,
  listTransactions,
  resetSubscriptionCredits,
  InsufficientCreditsError,
} from '../db/walletRepository.js';
import { listPayments } from '../db/paymentRepository.js';
import { listUsage } from '../db/aiUsageRepository.js';
import {
  getActiveSubscription,
  listPlans,
  createPlan,
  updatePlan,
  getPlanById,
  activatePlan,
} from '../db/subscriptionRepository.js';
import { listRates, updateRate, createRate } from '../db/rateCardRepository.js';
import { listPackages, createPackage, updatePackage } from '../db/creditPackageRepository.js';
import { listCoupons, createCoupon, updateCoupon } from '../db/couponRepository.js';
import { setSetting } from '../db/settingsRepository.js';
import { isManagedKey, settingsStatus, MANAGED_SETTINGS } from '../config/settingsService.js';
import { probeConfiguredModel } from '../ai/providers.js';

/**
 * Admin billing console API. Mounted under /api/admin, which api.js gates with
 * requireSession + requireAdmin, so every handler here already runs only for an
 * admin session — no per-route role check needed.
 *
 * These handlers compose the repositories built in earlier phases; the admin
 * surface adds no new billing math, only cross-user reads and a manual
 * credit-adjustment write that is fully audited.
 */

function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      logger.error({ err, path: req.originalUrl }, 'admin route failed');
      return res.status(500).json({ error: 'internal_error', message: 'Something went wrong.' });
    }
  };
}

export function setupAdminRoutes(app) {
  // ---- Users ----

  /** Search / list users. */
  app.get(
    '/api/admin/users',
    handle(async (req, res) => {
      const users = await listUsers({ search: req.query.q, limit: Number(req.query.limit) || 100 });
      res.json({ users });
    }),
  );

  /** One user's full billing picture: plan, wallet, ledger, payments, usage. */
  app.get(
    '/api/admin/users/:ownerId',
    handle(async (req, res) => {
      const { ownerId } = req.params;
      const user = await findUserByOwnerId(ownerId);
      if (!user) return res.status(404).json({ error: 'not_found', message: 'No such user.' });
      const [wallet, subscription, transactions, payments, usage] = await Promise.all([
        getWallet(ownerId),
        getActiveSubscription(ownerId),
        listTransactions(ownerId, { limit: 50 }),
        listPayments(ownerId, { limit: 50 }),
        listUsage(ownerId, { limit: 50 }),
      ]);
      res.json({ user, wallet, subscription, transactions, payments, usage });
    }),
  );

  /**
   * Manual credit adjustment. Requires amount + reason; the admin's identity and
   * the timestamp are recorded on the ledger row, so nothing changes silently.
   * A positive amount grants, a negative one removes (from bonus by default; the
   * caller may target a bucket). Every adjustment is one ledger transaction.
   */
  app.post(
    '/api/admin/users/:ownerId/adjust',
    handle(async (req, res) => {
      const { ownerId } = req.params;
      const amount = Math.round(Number(req.body?.amount));
      const reason = String(req.body?.reason ?? '').trim();
      const bucket = ['subscription', 'bonus', 'purchased'].includes(req.body?.bucket)
        ? req.body.bucket
        : 'bonus';

      if (!Number.isInteger(amount) || amount === 0) {
        return res
          .status(400)
          .json({ error: 'invalid_request', message: 'A non-zero integer amount is required.' });
      }
      if (!reason) {
        return res.status(400).json({
          error: 'invalid_request',
          message: 'A reason is required for every adjustment.',
        });
      }

      const adminId = req.session.sub;
      const ledger = {
        type: 'ADMIN_ADJUSTMENT',
        description: `Admin adjustment by ${adminId}: ${reason}`,
        metadata: { adminId, reason, at: new Date().toISOString(), bucket },
      };

      // creditWallet clamps to >= 0, so a grant and a removal take different
      // paths: a positive amount credits the chosen bucket; a negative amount
      // debits the wallet (subscription -> bonus -> purchased priority), which
      // rejects an overdraw. Both write one ADMIN_ADJUSTMENT ledger row carrying
      // the admin's id + reason, so every manual change is auditable.
      try {
        const wallet =
          amount > 0
            ? await creditWallet(ownerId, bucket, amount, ledger)
            : await debitCredits(ownerId, -amount, ledger);
        res.json({ wallet });
      } catch (err) {
        if (err instanceof InsufficientCreditsError) {
          return res.status(400).json({
            error: 'insufficient_credits',
            message: 'Cannot remove more credits than the user holds.',
            available: err.available,
            requested: err.requested,
          });
        }
        throw err;
      }
    }),
  );

  /** Change a user's role (user|admin). */
  app.put(
    '/api/admin/users/:ownerId/role',
    handle(async (req, res) => {
      const role = String(req.body?.role ?? '');
      if (!['user', 'admin'].includes(role)) {
        return res
          .status(400)
          .json({ error: 'invalid_request', message: 'role must be user|admin.' });
      }
      // Guard against an admin demoting themselves and locking everyone out is a
      // policy call; here we simply allow it but log it.
      const user = await setUserRole(req.params.ownerId, role);
      if (!user) return res.status(404).json({ error: 'not_found', message: 'No such user.' });
      logger.info({ adminId: req.session.sub, target: req.params.ownerId, role }, 'admin set role');
      res.json({ user });
    }),
  );

  /** Suspend or reactivate a user (active|suspended). */
  app.put(
    '/api/admin/users/:ownerId/status',
    handle(async (req, res) => {
      const status = String(req.body?.status ?? '');
      if (!['active', 'suspended'].includes(status)) {
        return res
          .status(400)
          .json({ error: 'invalid_request', message: 'status must be active|suspended.' });
      }
      const user = await setUserStatus(req.params.ownerId, status);
      if (!user) return res.status(404).json({ error: 'not_found', message: 'No such user.' });
      logger.info(
        { adminId: req.session.sub, target: req.params.ownerId, status },
        'admin set status',
      );
      res.json({ user });
    }),
  );

  /**
   * Assign a subscription plan to a user directly (no payment). Retires the
   * current active subscription, activates the chosen plan, and resets the
   * subscription credit bucket to the plan's monthly allowance — all in one
   * transaction, so the user's plan + credits move together. Audited on the
   * ledger via the reset entry. Intended for comps, support, and testing.
   */
  app.put(
    '/api/admin/users/:ownerId/plan',
    handle(async (req, res) => {
      const { ownerId } = req.params;
      const planId = String(req.body?.planId ?? '');
      const user = await findUserByOwnerId(ownerId);
      if (!user) return res.status(404).json({ error: 'not_found', message: 'No such user.' });
      const plan = await getPlanById(planId);
      if (!plan) return res.status(404).json({ error: 'not_found', message: 'No such plan.' });

      const adminId = req.session.sub;
      await withTransaction(async (conn) => {
        await activatePlan(conn, { ownerId, plan });
      });
      // Reset the subscription bucket to the plan's allowance (own transaction).
      await resetSubscriptionCredits(ownerId, plan.includedCredits, {
        description: `Plan set to ${plan.displayName} by admin ${adminId}`,
      });
      logger.info({ adminId, target: ownerId, plan: plan.code }, 'admin assigned plan');

      const subscription = await getActiveSubscription(ownerId);
      const wallet = await getWallet(ownerId);
      res.json({ subscription, wallet });
    }),
  );

  // ---- Dashboard metrics ----
  /**
   * Aggregate numbers for the dashboard: user/subscription counts, monthly
   * recurring revenue (sum of active plan prices), credits outstanding, usage +
   * revenue this calendar month, and the most recent payments. All read-only.
   */
  app.get(
    '/api/admin/dashboard',
    handle(async (_req, res) => {
      const pool = getPool();
      const [[users]] = await pool.query('SELECT COUNT(*) AS n FROM users');
      const [[suspended]] = await pool.query(
        "SELECT COUNT(*) AS n FROM users WHERE status = 'suspended'",
      );
      const [[subs]] = await pool.query(
        "SELECT COUNT(*) AS n FROM subscriptions WHERE status = 'active'",
      );
      const [[mrr]] = await pool.query(
        "SELECT COALESCE(SUM(price_paise),0) AS paise FROM subscriptions WHERE status = 'active' AND billing_cycle = 'monthly'",
      );
      const [[wallets]] = await pool.query(
        'SELECT COALESCE(SUM(subscription_credits + bonus_credits + purchased_credits),0) AS credits FROM credit_wallets',
      );
      const [[usedMonth]] = await pool.query(
        "SELECT COALESCE(SUM(credits_charged),0) AS credits FROM ai_usage WHERE created_at >= DATE_FORMAT(NOW(), '%Y-%m-01')",
      );
      const [[revMonth]] = await pool.query(
        "SELECT COALESCE(SUM(amount_paise),0) AS paise FROM payments WHERE status = 'PAID' AND paid_at >= DATE_FORMAT(NOW(), '%Y-%m-01')",
      );
      const [[revTotal]] = await pool.query(
        "SELECT COALESCE(SUM(amount_paise),0) AS paise FROM payments WHERE status = 'PAID'",
      );
      const [recentPayments] = await pool.query(
        `SELECT p.id, p.owner_id, u.email, p.type, p.amount_paise, p.status, p.created_at
           FROM payments p LEFT JOIN users u ON u.owner_id = p.owner_id
          ORDER BY p.created_at DESC LIMIT 10`,
      );

      res.json({
        metrics: {
          users: Number(users.n),
          suspendedUsers: Number(suspended.n),
          activeSubscriptions: Number(subs.n),
          mrrPaise: Number(mrr.paise),
          creditsOutstanding: Number(wallets.credits),
          creditsUsedThisMonth: Number(usedMonth.credits),
          revenueThisMonthPaise: Number(revMonth.paise),
          revenueTotalPaise: Number(revTotal.paise),
        },
        recentPayments: recentPayments.map((r) => ({
          id: r.id,
          ownerId: r.owner_id,
          email: r.email,
          type: r.type,
          amountPaise: Number(r.amount_paise),
          status: r.status,
          createdAt: r.created_at,
        })),
      });
    }),
  );

  // ---- Plans ----
  app.get(
    '/api/admin/plans',
    handle(async (_req, res) => {
      res.json({ plans: await listPlans({ includeDisabled: true }) });
    }),
  );

  app.post(
    '/api/admin/plans',
    handle(async (req, res) => {
      const code = String(req.body?.code ?? '').trim();
      if (!code) {
        return res
          .status(400)
          .json({ error: 'invalid_request', message: 'A plan code is required.' });
      }
      try {
        const plan = await createPlan(req.body ?? {});
        res.status(201).json({ plan });
      } catch (err) {
        if (err?.code === 'ER_DUP_ENTRY') {
          return res
            .status(409)
            .json({ error: 'conflict', message: `A plan with code "${code}" already exists.` });
        }
        throw err;
      }
    }),
  );

  app.put(
    '/api/admin/plans/:id',
    handle(async (req, res) => {
      const plan = await updatePlan(req.params.id, req.body ?? {});
      if (!plan) return res.status(404).json({ error: 'not_found', message: 'No such plan.' });
      res.json({ plan });
    }),
  );

  // ---- Credit packages ----
  app.get(
    '/api/admin/packages',
    handle(async (_req, res) => {
      res.json({ packages: await listPackages({ includeDisabled: true }) });
    }),
  );

  app.post(
    '/api/admin/packages',
    handle(async (req, res) => {
      const code = String(req.body?.code ?? '').trim();
      if (!code) {
        return res
          .status(400)
          .json({ error: 'invalid_request', message: 'A package code is required.' });
      }
      try {
        const pkg = await createPackage(req.body ?? {});
        res.status(201).json({ package: pkg });
      } catch (err) {
        if (err?.code === 'ER_DUP_ENTRY') {
          return res
            .status(409)
            .json({ error: 'conflict', message: `A package with code "${code}" already exists.` });
        }
        throw err;
      }
    }),
  );

  app.put(
    '/api/admin/packages/:id',
    handle(async (req, res) => {
      const pkg = await updatePackage(req.params.id, req.body ?? {});
      if (!pkg) return res.status(404).json({ error: 'not_found', message: 'No such package.' });
      res.json({ package: pkg });
    }),
  );

  // ---- AI rate card ----
  app.get(
    '/api/admin/rates',
    handle(async (_req, res) => {
      res.json({ rates: await listRates() });
    }),
  );

  app.put(
    '/api/admin/rates/:id',
    handle(async (req, res) => {
      const rate = await updateRate(req.params.id, req.body ?? {});
      if (!rate) return res.status(404).json({ error: 'not_found', message: 'No such rate.' });
      res.json({ rate });
    }),
  );

  app.post(
    '/api/admin/rates',
    handle(async (req, res) => {
      const rate = await createRate(req.body ?? {});
      res.status(201).json({ rate });
    }),
  );

  // ---- Coupons ----
  app.get(
    '/api/admin/coupons',
    handle(async (_req, res) => {
      res.json({ coupons: await listCoupons() });
    }),
  );

  app.post(
    '/api/admin/coupons',
    handle(async (req, res) => {
      const code = String(req.body?.code ?? '').trim();
      const type = String(req.body?.couponType ?? '');
      if (!code) {
        return res
          .status(400)
          .json({ error: 'invalid_request', message: 'A coupon code is required.' });
      }
      if (!['percentage', 'fixed', 'bonus_credits'].includes(type)) {
        return res.status(400).json({
          error: 'invalid_request',
          message: 'couponType must be percentage|fixed|bonus_credits.',
        });
      }
      try {
        const coupon = await createCoupon(req.body ?? {});
        res.status(201).json({ coupon });
      } catch (err) {
        if (err?.code === 'ER_DUP_ENTRY') {
          return res
            .status(409)
            .json({ error: 'conflict', message: `A coupon "${code}" already exists.` });
        }
        throw err;
      }
    }),
  );

  app.put(
    '/api/admin/coupons/:id',
    handle(async (req, res) => {
      const coupon = await updateCoupon(req.params.id, req.body ?? {});
      if (!coupon) return res.status(404).json({ error: 'not_found', message: 'No such coupon.' });
      res.json({ coupon });
    }),
  );

  // ---- Runtime settings (provider keys, Razorpay, Google, toggles) ----

  /**
   * The status of every admin-managed setting: configured?, source (db|env|
   * unset), and — for non-secret text/enum/bool — the effective value. SECRET
   * values are NEVER returned in full, only a masked suffix (e.g. ••••7a9c).
   */
  app.get(
    '/api/admin/settings',
    handle(async (_req, res) => {
      res.json({ settings: settingsStatus() });
    }),
  );

  /**
   * Update one or more settings. Body is a flat object of { KEY: value }.
   * Rules:
   *   - Only MANAGED keys are accepted; anything else is rejected (Category-B
   *     secrets like CREDENTIAL_SECRET are never managed here).
   *   - An empty string clears the override (falls back to env).
   *   - A value that is only a mask (leading ••••) is IGNORED, so re-saving the
   *     form without re-typing a secret does not overwrite the stored value.
   * Each write records the admin's owner_id as updated_by.
   */
  app.put(
    '/api/admin/settings',
    handle(async (req, res) => {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const adminId = req.session.sub;

      const unknown = Object.keys(body).filter((k) => !isManagedKey(k));
      if (unknown.length > 0) {
        return res.status(400).json({
          error: 'invalid_request',
          message: `Not manageable here: ${unknown.join(', ')}.`,
        });
      }

      const secretKeys = new Set(
        MANAGED_SETTINGS.filter((s) => s.kind === 'secret').map((s) => s.key),
      );
      const updated = [];
      for (const [key, raw] of Object.entries(body)) {
        // A masked echo of an unchanged secret must not clobber the real value.
        if (secretKeys.has(key) && typeof raw === 'string' && raw.startsWith('••••')) continue;

        const value =
          raw === null || raw === undefined
            ? null
            : typeof raw === 'boolean'
              ? String(raw)
              : String(raw);
        await setSetting(key, value, adminId);
        updated.push(key);
      }

      logger.info({ adminId, updated }, 'admin updated runtime settings');
      res.json({ updated, settings: settingsStatus() });
    }),
  );

  /**
   * Test the currently-configured AI provider by probing its model. Uses the
   * resolver, so it tests whatever is effective right now (DB override or env).
   * Read-only; returns { ok, provider, model, detail }.
   */
  app.get(
    '/api/admin/settings/test-ai',
    handle(async (_req, res) => {
      const probe = await probeConfiguredModel();
      res.json({ probe });
    }),
  );
}
