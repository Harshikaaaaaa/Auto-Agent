import { logger } from '../lib/logger.js';
import { listUsers, findUserByOwnerId } from '../db/userRepository.js';
import {
  getWallet,
  creditWallet,
  debitCredits,
  listTransactions,
  InsufficientCreditsError,
} from '../db/walletRepository.js';
import { listPayments } from '../db/paymentRepository.js';
import { listUsage } from '../db/aiUsageRepository.js';
import { getActiveSubscription, listPlans } from '../db/subscriptionRepository.js';
import { listRates, updateRate, createRate } from '../db/rateCardRepository.js';
import { listPackages, createPackage } from '../db/creditPackageRepository.js';
import { listCoupons, createCoupon } from '../db/couponRepository.js';
import { setSetting } from '../db/settingsRepository.js';
import { isManagedKey, settingsStatus, MANAGED_SETTINGS } from '../config/settingsService.js';

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

  // ---- Plans ----
  app.get(
    '/api/admin/plans',
    handle(async (_req, res) => {
      res.json({ plans: await listPlans({ includeDisabled: true }) });
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
      const pkg = await createPackage(req.body ?? {});
      res.status(201).json({ package: pkg });
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
      const coupon = await createCoupon(req.body ?? {});
      res.status(201).json({ coupon });
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
}
