/**
 * Normalized AI usage.
 *
 * Each provider reports token counts and (sometimes) cost in its own shape.
 * The billing engine must not know those shapes, so every provider function
 * parses its own response into this one structure and nothing above the
 * provider layer sees a raw response again.
 *
 * All token counts are integers. `providerCostUsdMicros` is the provider's own
 * cost for the call in MICRO-dollars ($1 = 1_000_000), an integer, so money
 * stays integer end to end. When the provider does not report a dollar cost
 * (Gemini and Ollama return only token counts), it is left null and Phase 3's
 * credit math derives the cost from the token counts × the rate card instead.
 *
 * @typedef {Object} NormalizedUsage
 * @property {string} provider
 * @property {string} model
 * @property {number} inputTokens
 * @property {number} cachedInputTokens
 * @property {number} outputTokens
 * @property {number} reasoningTokens
 * @property {number|null} providerCostUsdMicros
 * @property {string|null} requestId
 */

/** Coerce a value to a non-negative integer, defaulting to 0. */
function intOr0(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/** Build a NormalizedUsage, filling absent fields with safe defaults. */
export function normalizeUsage({
  provider,
  model,
  inputTokens,
  cachedInputTokens,
  outputTokens,
  reasoningTokens,
  providerCostUsdMicros,
  requestId,
} = {}) {
  return {
    provider: provider ?? 'unknown',
    model: model ?? 'unknown',
    inputTokens: intOr0(inputTokens),
    cachedInputTokens: intOr0(cachedInputTokens),
    outputTokens: intOr0(outputTokens),
    reasoningTokens: intOr0(reasoningTokens),
    providerCostUsdMicros:
      providerCostUsdMicros === null || providerCostUsdMicros === undefined
        ? null
        : intOr0(providerCostUsdMicros),
    requestId: requestId ? String(requestId) : null,
  };
}

/** A zero-usage record, for a call that produced no billable usage. */
export function emptyUsage(provider = 'unknown', model = 'unknown') {
  return normalizeUsage({ provider, model, providerCostUsdMicros: null });
}

/**
 * Add two usage records for the same provider/model.
 *
 * `callProviderForJson` may make two provider calls (a retry on unparseable
 * JSON); both are billable, so their token counts and costs sum. A null cost on
 * either side stays null only when BOTH are null — one known cost is still a
 * real (partial) figure the caller can use.
 */
export function sumUsage(a, b) {
  if (!a) return b;
  if (!b) return a;
  const cost =
    a.providerCostUsdMicros === null && b.providerCostUsdMicros === null
      ? null
      : (a.providerCostUsdMicros ?? 0) + (b.providerCostUsdMicros ?? 0);
  return {
    provider: b.provider ?? a.provider,
    model: b.model ?? a.model,
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    providerCostUsdMicros: cost,
    // The last call's id is the most recent generation; keep it for lookups.
    requestId: b.requestId ?? a.requestId,
  };
}

/**
 * Convert a fractional USD figure (e.g. OpenRouter's `usage.cost`) to integer
 * micro-dollars. Returns null for a missing/invalid value.
 */
export function usdToMicros(usd) {
  if (usd === null || usd === undefined) return null;
  const n = Number(usd);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 1_000_000);
}
