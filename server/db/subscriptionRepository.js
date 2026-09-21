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

/** A plan by code, or null. */
export async function getPlanByCode(code) {
  const [rows] = await getPool().query('SELECT * FROM subscription_plans WHERE code = ? LIMIT 1', [
    code,
  ]);
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    code: r.code,
    displayName: r.display_name,
    pricePaise: Number(r.price_paise),
    billingCycle: r.billing_cycle,
    includedCredits: Number(r.included_credits),
    enabled: Boolean(r.enabled),
  };
}

/** A plan by id, or null. */
export async function getPlanById(id) {
  const [rows] = await getPool().query('SELECT * FROM subscription_plans WHERE id = ? LIMIT 1', [
    id,
  ]);
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    code: r.code,
    displayName: r.display_name,
    pricePaise: Number(r.price_paise),
    billingCycle: r.billing_cycle,
    includedCredits: Number(r.included_credits),
    enabled: Boolean(r.enabled),
  };
}

/**
 * Update the mutable fields of a plan (admin console). Editing a plan changes
 * what NEW subscribers get and what the pricing page shows; existing active
 * subscriptions keep the price/credits captured on their own row.
 * Returns the updated plan, or null when the id is unknown.
 */
export async function updatePlan(id, fields, { now = new Date() } = {}) {
  const columns = {
    displayName: 'display_name',
    pricePaise: 'price_paise',
    billingCycle: 'billing_cycle',
    includedCredits: 'included_credits',
    enabled: 'enabled',
    sortOrder: 'sort_order',
  };
  const sets = [];
  const params = [];
  for (const [key, col] of Object.entries(columns)) {
    if (fields[key] === undefined) continue;
    let value = fields[key];
    if (key === 'pricePaise' || key === 'includedCredits') value = Math.round(Number(value));
    if (key === 'sortOrder') value = Math.round(Number(value));
    if (key === 'enabled') value = value ? 1 : 0;
    sets.push(`${col} = ?`);
    params.push(value);
  }
  if (sets.length === 0) return getPlanById(id);
  sets.push('updated_at = ?');
  params.push(now, id);
  await getPool().query(`UPDATE subscription_plans SET ${sets.join(', ')} WHERE id = ?`, params);
  return getPlanById(id);
}

/** Create a plan (admin console). */
export async function createPlan(input, { now = new Date() } = {}) {
  const crypto = await import('crypto');
  const id = crypto.randomUUID();
  await getPool().query(
    `INSERT INTO subscription_plans
       (id, code, display_name, price_paise, billing_cycle, included_credits,
        features, model_access, request_limits, enabled, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      String(input.code ?? '').trim(),
      input.displayName ?? input.code,
      Math.round(Number(input.pricePaise ?? 0)),
      input.billingCycle ?? 'monthly',
      Math.round(Number(input.includedCredits ?? 0)),
      JSON.stringify(Array.isArray(input.features) ? input.features : []),
      JSON.stringify(input.modelAccess ?? {}),
      JSON.stringify(input.requestLimits ?? {}),
      input.enabled === false ? 0 : 1,
      Math.round(Number(input.sortOrder ?? 0)),
      now,
      now,
    ],
  );
  return getPlanById(id);
}

/** All enabled plans for the pricing page, cheapest first. */
export async function listPlans({ includeDisabled = false } = {}) {
  const where = includeDisabled ? '' : 'WHERE enabled = 1';
  const [rows] = await getPool().query(
    `SELECT * FROM subscription_plans ${where} ORDER BY sort_order, price_paise`,
  );
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    displayName: r.display_name,
    pricePaise: Number(r.price_paise),
    billingCycle: r.billing_cycle,
    includedCredits: Number(r.included_credits),
    features: r.features,
    enabled: Boolean(r.enabled),
    sortOrder: Number(r.sort_order),
  }));
}

/**
 * Activate (or switch to) a plan for an owner, inside a payment transaction.
 *
 * Ends any current active subscription (status -> 'cancelled', historical row
 * kept — never deleted), inserts a new ACTIVE row with a one-cycle period, and
 * resets the subscription credit bucket to the plan's monthly allowance. The
 * caller passes the connection so this shares the payment's transaction, making
 * "payment PAID" and "plan active + credits granted" atomic.
 *
 * @param conn a transaction connection
 * @returns the new subscription id
 */
export async function activatePlan(
  conn,
  { ownerId, plan, billingCycle = 'monthly', gatewaySubscriptionId = null },
  { now = new Date() } = {},
) {
  const crypto = await import('crypto');
  // Retire the current active subscription (keep the row).
  await conn.query(
    "UPDATE subscriptions SET status = 'cancelled', updated_at = ? WHERE owner_id = ? AND status = 'active'",
    [now, ownerId],
  );

  const periodDays = billingCycle === 'yearly' ? 365 : 30;
  const periodEnd = new Date(now.getTime() + periodDays * 24 * 60 * 60 * 1000);
  const id = crypto.randomUUID();
  await conn.query(
    `INSERT INTO subscriptions
       (id, owner_id, plan_id, status, billing_cycle, price_paise, included_credits,
        gateway_subscription_id, current_period_start, current_period_end, next_billing_at,
        cancel_at_period_end, created_at, updated_at)
     VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    [
      id,
      ownerId,
      plan.id,
      billingCycle,
      plan.pricePaise,
      plan.includedCredits,
      gatewaySubscriptionId,
      now,
      periodEnd,
      periodEnd,
      now,
      now,
    ],
  );
  return id;
}

/** Flag/unflag cancel-at-period-end. Access stays until the period ends. */
export async function setCancelAtPeriodEnd(ownerId, cancel, { now = new Date() } = {}) {
  const [result] = await getPool().query(
    "UPDATE subscriptions SET cancel_at_period_end = ?, updated_at = ? WHERE owner_id = ? AND status = 'active'",
    [cancel ? 1 : 0, now, ownerId],
  );
  return result.affectedRows > 0;
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
