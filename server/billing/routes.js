import { logger } from '../lib/logger.js';
import { getCreditBalance } from './billingService.js';
import { listTransactions } from '../db/walletRepository.js';
import { listUsage, summarizeUsage } from '../db/aiUsageRepository.js';
import { getActiveSubscription } from '../db/subscriptionRepository.js';

/**
 * User-facing billing reads. All session-gated (mounted under /api/billing,
 * which api.js guards with requireSession), so each is scoped to the caller's
 * own owner_id — a user can only ever see their own wallet, ledger, and usage.
 *
 * Purchases and subscription changes (writes) are Phase 4; this is the read
 * surface the Phase 5 dashboard consumes.
 */

function ownerOf(req) {
  return req.session?.sub ?? 'unknown';
}

function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err?.code === 'ECONNREFUSED' || err?.code === 'PROTOCOL_CONNECTION_LOST') {
        logger.error({ err }, 'database unavailable');
        return res.status(503).json({
          error: 'database_unavailable',
          message: 'The billing service is not reachable right now.',
          retryable: true,
        });
      }
      logger.error({ err, path: req.originalUrl }, 'billing route failed');
      return res.status(500).json({ error: 'internal_error', message: 'Something went wrong.' });
    }
  };
}

/** Parse a ?range= filter into a `since` Date (null = all time). */
function sinceFromRange(range) {
  const now = Date.now();
  switch (range) {
    case 'today':
      return new Date(new Date().setHours(0, 0, 0, 0));
    case '7d':
      return new Date(now - 7 * 24 * 60 * 60 * 1000);
    case '30d':
      return new Date(now - 30 * 24 * 60 * 60 * 1000);
    default:
      return null;
  }
}

export function setupBillingRoutes(app) {
  /** The wallet: three balances + totals + used-this-month. */
  app.get(
    '/api/billing/balance',
    handle(async (req, res) => {
      const balance = await getCreditBalance(ownerOf(req));
      const subscription = await getActiveSubscription(ownerOf(req));
      res.json({ balance, subscription });
    }),
  );

  /** The immutable credit ledger, newest first. */
  app.get(
    '/api/billing/transactions',
    handle(async (req, res) => {
      const limit = Number(req.query.limit);
      const transactions = await listTransactions(ownerOf(req), {
        limit: Number.isFinite(limit) ? limit : undefined,
      });
      res.json({ transactions });
    }),
  );

  /** Recent AI usage rows, newest first. */
  app.get(
    '/api/billing/usage',
    handle(async (req, res) => {
      const limit = Number(req.query.limit);
      const usage = await listUsage(ownerOf(req), {
        limit: Number.isFinite(limit) ? limit : undefined,
      });
      res.json({ usage });
    }),
  );

  /** Aggregated usage analytics for a window (?range=today|7d|30d). */
  app.get(
    '/api/billing/usage/summary',
    handle(async (req, res) => {
      const summary = await summarizeUsage(ownerOf(req), {
        since: sinceFromRange(req.query.range),
      });
      res.json({ summary, range: req.query.range ?? 'all' });
    }),
  );
}
