import crypto from 'crypto';
import { getPool } from './pool.js';

/**
 * Per-request AI usage records. Each row SNAPSHOTS the exact rate + markup +
 * exchange rate used at request time, so a later edit to the rate card never
 * changes a historical charge. request_id is UNIQUE, so one AI call can be
 * recorded at most once (INSERT IGNORE makes a retried reconcile a no-op).
 *
 * This is the analytics source (usage by model/provider, tokens, credits over
 * time); the ledger is the money source. They agree because both are written in
 * the reconcile step.
 */

function toIsoString(value) {
  if (!value) return null;
  const asDate = value instanceof Date ? value : new Date(`${String(value).replace(' ', 'T')}Z`);
  return Number.isNaN(asDate.getTime()) ? null : asDate.toISOString();
}

/**
 * Record one usage row. Idempotent on request_id.
 * @returns {Promise<boolean>} true when a new row was written.
 */
export async function recordUsage(entry, { now = new Date() } = {}) {
  const [result] = await getPool().query(
    `INSERT IGNORE INTO ai_usage
       (id, request_id, owner_id, provider, model,
        input_tokens, cached_input_tokens, output_tokens, reasoning_tokens,
        provider_cost_usd_micros, provider_fee_bps, markup_multiplier_x10,
        billing_exchange_rate_paise_usd, credits_charged, status, error_code, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      crypto.randomUUID(),
      entry.requestId,
      entry.ownerId,
      entry.provider,
      entry.model,
      entry.inputTokens ?? 0,
      entry.cachedInputTokens ?? 0,
      entry.outputTokens ?? 0,
      entry.reasoningTokens ?? 0,
      entry.providerCostUsdMicros ?? 0,
      entry.providerFeeBps ?? 0,
      entry.markupMultiplierX10 ?? 25,
      entry.billingExchangeRatePaiseUsd ?? 10000,
      entry.creditsCharged ?? 0,
      entry.status ?? 'completed',
      entry.errorCode ?? null,
      now,
    ],
  );
  return result.affectedRows === 1;
}

/** A single usage row by request id (tests/diagnostics). */
export async function getUsage(requestId) {
  const [rows] = await getPool().query('SELECT * FROM ai_usage WHERE request_id = ?', [requestId]);
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    requestId: r.request_id,
    ownerId: r.owner_id,
    provider: r.provider,
    model: r.model,
    inputTokens: Number(r.input_tokens),
    cachedInputTokens: Number(r.cached_input_tokens),
    outputTokens: Number(r.output_tokens),
    reasoningTokens: Number(r.reasoning_tokens),
    providerCostUsdMicros: Number(r.provider_cost_usd_micros),
    markupMultiplierX10: Number(r.markup_multiplier_x10),
    creditsCharged: Number(r.credits_charged),
    status: r.status,
    createdAt: toIsoString(r.created_at),
  };
}

/** Recent usage for a user, newest first — the AI usage history surface. */
export async function listUsage(ownerId, { limit = 50 } = {}) {
  const safeLimit = Math.min(Math.max(Math.round(Number(limit) || 50), 1), 500);
  const [rows] = await getPool().query(
    `SELECT request_id, provider, model, input_tokens, output_tokens, credits_charged,
            status, created_at
       FROM ai_usage WHERE owner_id = ? ORDER BY created_at DESC LIMIT ?`,
    [ownerId, safeLimit],
  );
  return rows.map((r) => ({
    requestId: r.request_id,
    provider: r.provider,
    model: r.model,
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    creditsCharged: Number(r.credits_charged),
    status: r.status,
    createdAt: toIsoString(r.created_at),
  }));
}

/**
 * Aggregate usage for analytics: totals + breakdowns by provider and model over
 * a window. `sinceIso` optional (defaults to all-time).
 */
export async function summarizeUsage(ownerId, { since } = {}) {
  const params = [ownerId];
  let where = 'owner_id = ?';
  if (since) {
    where += ' AND created_at >= ?';
    params.push(since instanceof Date ? since : new Date(since));
  }

  const [totals] = await getPool().query(
    `SELECT COUNT(*) AS requests,
            COALESCE(SUM(input_tokens),0) AS input_tokens,
            COALESCE(SUM(output_tokens),0) AS output_tokens,
            COALESCE(SUM(credits_charged),0) AS credits
       FROM ai_usage WHERE ${where}`,
    params,
  );
  const [byProvider] = await getPool().query(
    `SELECT provider, COALESCE(SUM(credits_charged),0) AS credits, COUNT(*) AS requests
       FROM ai_usage WHERE ${where} GROUP BY provider ORDER BY credits DESC`,
    params,
  );
  const [byModel] = await getPool().query(
    `SELECT model, COALESCE(SUM(credits_charged),0) AS credits, COUNT(*) AS requests
       FROM ai_usage WHERE ${where} GROUP BY model ORDER BY credits DESC`,
    params,
  );

  return {
    requests: Number(totals[0].requests),
    inputTokens: Number(totals[0].input_tokens),
    outputTokens: Number(totals[0].output_tokens),
    credits: Number(totals[0].credits),
    byProvider: byProvider.map((r) => ({
      provider: r.provider,
      credits: Number(r.credits),
      requests: Number(r.requests),
    })),
    byModel: byModel.map((r) => ({
      model: r.model,
      credits: Number(r.credits),
      requests: Number(r.requests),
    })),
  };
}
