import { getPool } from './pool.js';

/**
 * Subscription reads used by billing. The full lifecycle (create/upgrade/
 * downgrade/cancel/resume, gateway ids, period rollover) lands in Phase 4; this
 * file starts with only what the billing engine needs: which plan a user is on,
 * for the model-access check.
 */

function toIsoString(value) {
  if (!value) return null;
  const asDate = value instanceof Date ? value : new Date(`${String(value).replace(' ', 'T')}Z`);
  return Number.isNaN(asDate.getTime()) ? null : asDate.toISOString();
}

/**
 * The plan CODE (free|starter|pro|business) of a user's ACTIVE subscription.
 * Defaults to 'free' when there is no active subscription, so access checks are
 * conservative rather than open.
 */
export async function getActivePlanCode(ownerId) {
  const [rows] = await getPool().query(
    `SELECT p.code AS code
       FROM subscriptions s
       JOIN subscription_plans p ON p.id = s.plan_id
      WHERE s.owner_id = ? AND s.status = 'active'
      ORDER BY s.created_at DESC
      LIMIT 1`,
    [ownerId],
  );
  return rows.length > 0 ? rows[0].code : 'free';
}

/** The active subscription with its plan, for the billing dashboard. */
export async function getActiveSubscription(ownerId) {
  const [rows] = await getPool().query(
    `SELECT s.*, p.code AS plan_code, p.display_name AS plan_name, p.price_paise AS plan_price_paise,
            p.included_credits AS plan_included_credits
       FROM subscriptions s
       JOIN subscription_plans p ON p.id = s.plan_id
      WHERE s.owner_id = ? AND s.status = 'active'
      ORDER BY s.created_at DESC
      LIMIT 1`,
    [ownerId],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    planCode: r.plan_code,
    planName: r.plan_name,
    status: r.status,
    billingCycle: r.billing_cycle,
    pricePaise: Number(r.plan_price_paise),
    includedCredits: Number(r.plan_included_credits),
    currentPeriodStart: toIsoString(r.current_period_start),
    currentPeriodEnd: toIsoString(r.current_period_end),
    nextBillingAt: toIsoString(r.next_billing_at),
    cancelAtPeriodEnd: Boolean(r.cancel_at_period_end),
  };
}
