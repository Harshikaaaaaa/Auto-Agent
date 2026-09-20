import crypto from 'crypto';
import { getPool } from './pool.js';

/**
 * The admin-configurable AI rate card. Read here for billing; edited by the
 * admin console (Phase 6). All prices are micro-USD per 1M tokens, markup is
 * ×10, fee is basis points, exchange is paise/USD — integers throughout.
 *
 * Editing a rate affects NEW requests only; ai_usage snapshots the values used
 * at request time (see aiUsageRepository), so history never moves.
 */

function toIsoString(value) {
  if (!value) return null;
  const asDate = value instanceof Date ? value : new Date(`${String(value).replace(' ', 'T')}Z`);
  return Number.isNaN(asDate.getTime()) ? null : asDate.toISOString();
}

function mapRate(row) {
  return {
    id: row.id,
    provider: row.provider,
    modelId: row.model_id,
    displayName: row.display_name,
    input_price_per_1m_micros: Number(row.input_price_per_1m_micros),
    cached_input_price_per_1m_micros: Number(row.cached_input_price_per_1m_micros),
    output_price_per_1m_micros: Number(row.output_price_per_1m_micros),
    reasoning_price_per_1m_micros: Number(row.reasoning_price_per_1m_micros),
    provider_fee_bps: Number(row.provider_fee_bps),
    markup_multiplier_x10: Number(row.markup_multiplier_x10),
    billing_exchange_rate_paise_usd: Number(row.billing_exchange_rate_paise_usd),
    minimum_credit_charge: Number(row.minimum_credit_charge),
    maximum_output_tokens:
      row.maximum_output_tokens === null ? null : Number(row.maximum_output_tokens),
    enabled: Boolean(row.enabled),
    freePlanAllowed: Boolean(row.free_plan_allowed),
    starterPlanAllowed: Boolean(row.starter_plan_allowed),
    proPlanAllowed: Boolean(row.pro_plan_allowed),
    businessPlanAllowed: Boolean(row.business_plan_allowed),
    updatedAt: toIsoString(row.updated_at),
  };
}

/** The rate row for a provider+model, or null when none is configured. */
export async function getModelRate(provider, modelId) {
  const [rows] = await getPool().query(
    'SELECT * FROM ai_model_rates WHERE provider = ? AND model_id = ? LIMIT 1',
    [provider, modelId],
  );
  return rows.length > 0 ? mapRate(rows[0]) : null;
}

/** Every rate row, for the admin rate-card screen. */
export async function listRates() {
  const [rows] = await getPool().query('SELECT * FROM ai_model_rates ORDER BY provider, model_id');
  return rows.map(mapRate);
}

/** Whether a plan may use a model, per the per-plan-allowed flags. */
export function planAllowsRate(rate, planCode) {
  if (!rate) return false;
  switch (planCode) {
    case 'free':
      return rate.freePlanAllowed;
    case 'starter':
      return rate.starterPlanAllowed;
    case 'pro':
      return rate.proPlanAllowed;
    case 'business':
      return rate.businessPlanAllowed;
    default:
      return rate.proPlanAllowed; // sensible default for an unknown plan
  }
}

/** Update the mutable pricing fields of a rate. Admin console (Phase 6). */
export async function updateRate(id, fields, { now = new Date() } = {}) {
  const allowed = [
    'input_price_per_1m_micros',
    'cached_input_price_per_1m_micros',
    'output_price_per_1m_micros',
    'reasoning_price_per_1m_micros',
    'provider_fee_bps',
    'markup_multiplier_x10',
    'billing_exchange_rate_paise_usd',
    'minimum_credit_charge',
    'maximum_output_tokens',
    'enabled',
    'free_plan_allowed',
    'starter_plan_allowed',
    'pro_plan_allowed',
    'business_plan_allowed',
  ];
  const sets = [];
  const params = [];
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      params.push(fields[key]);
    }
  }
  if (sets.length === 0) return null;
  sets.push('updated_at = ?');
  params.push(now, id);
  await getPool().query(`UPDATE ai_model_rates SET ${sets.join(', ')} WHERE id = ?`, params);
  const [rows] = await getPool().query('SELECT * FROM ai_model_rates WHERE id = ?', [id]);
  return rows.length > 0 ? mapRate(rows[0]) : null;
}

/** Create a rate row (admin). */
export async function createRate(input, { now = new Date() } = {}) {
  const id = crypto.randomUUID();
  await getPool().query(
    `INSERT INTO ai_model_rates
       (id, provider, model_id, display_name,
        input_price_per_1m_micros, cached_input_price_per_1m_micros,
        output_price_per_1m_micros, reasoning_price_per_1m_micros,
        provider_fee_bps, markup_multiplier_x10, billing_exchange_rate_paise_usd,
        minimum_credit_charge, maximum_output_tokens, enabled,
        free_plan_allowed, starter_plan_allowed, pro_plan_allowed, business_plan_allowed,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.provider,
      input.modelId,
      input.displayName ?? input.modelId,
      input.input_price_per_1m_micros ?? 0,
      input.cached_input_price_per_1m_micros ?? 0,
      input.output_price_per_1m_micros ?? 0,
      input.reasoning_price_per_1m_micros ?? 0,
      input.provider_fee_bps ?? 0,
      input.markup_multiplier_x10 ?? 25,
      input.billing_exchange_rate_paise_usd ?? 10000,
      input.minimum_credit_charge ?? 1,
      input.maximum_output_tokens ?? null,
      input.enabled === false ? 0 : 1,
      input.free_plan_allowed ? 1 : 0,
      input.starter_plan_allowed === false ? 0 : 1,
      input.pro_plan_allowed === false ? 0 : 1,
      input.business_plan_allowed === false ? 0 : 1,
      now,
      now,
    ],
  );
  return getModelRate(input.provider, input.modelId);
}
