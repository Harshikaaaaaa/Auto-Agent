/**
 * Credit-cost arithmetic. Pure, deterministic, and INTEGER ONLY.
 *
 * No floating point ever touches money here. Every intermediate is a BigInt and
 * there is exactly one rounding step (ceiling, so a fractional credit always
 * rounds UP in the platform's favour), applied once at the very end.
 *
 * ---- The unit chain ----
 *   1 credit  = ₹0.01 = 1 paise                (so credits and paise are 1:1)
 *   provider cost is in MICRO-dollars          ($1 = 1_000_000 micros)
 *   exchange rate is paise per USD             (₹100/USD = 10_000 paise)
 *   markup is stored ×10                        (2.5x -> 25)
 *   OpenRouter fee is basis points              (5.5% -> 550)
 *
 *   paise           = costMicros × exchangeRatePaisePerUsd / 1_000_000
 *   rawCredits      = paise                     (1 credit == 1 paise)
 *   directCredits   = rawCredits × markupX10 / 10
 *   openRouterCredits = directCredits × (10_000 + feeBps) / 10_000
 *
 * ---- Worked examples (the tests assert these) ----
 *   $1 direct, ₹100/USD, 2.5x:
 *     1_000_000 × 10_000 / 1_000_000 = 10_000 raw × 25/10 = 25_000 credits
 *   $1 OpenRouter, 550 bps, 2.5x:
 *     25_000 × 10_550 / 10_000 = 26_375 credits
 */

const MICROS_PER_USD = 1_000_000n;
const BPS_DENOM = 10_000n;
const MARKUP_DENOM = 10n;

/** Ceiling division for non-negative BigInts. */
function ceilDiv(numerator, denominator) {
  if (denominator <= 0n) throw new Error('ceilDiv requires a positive denominator');
  if (numerator <= 0n) return 0n;
  return (numerator + denominator - 1n) / denominator;
}

/** Coerce to a non-negative BigInt; anything invalid becomes 0n. */
function big(value) {
  try {
    const n = BigInt(Math.trunc(Number(value)));
    return n > 0n ? n : 0n;
  } catch {
    return 0n;
  }
}

/**
 * The provider's cost for a call in MICRO-dollars.
 *
 * If the provider reported a dollar cost directly (OpenRouter with
 * usage.include), that authoritative figure is used. Otherwise it is derived
 * from the token counts and the rate card's per-1M-token prices:
 *
 *   micros = (inputTokens        × input_price_per_1m_micros
 *           + cachedInputTokens  × cached_input_price_per_1m_micros
 *           + outputTokens       × output_price_per_1m_micros
 *           + reasoningTokens    × reasoning_price_per_1m_micros) / 1_000_000
 *
 * (prices are micro-USD per 1M tokens, so dividing by 1M yields micro-USD.)
 *
 * @param {import('../ai/usage.js').NormalizedUsage} usage
 * @param {object} rate  a row from ai_model_rates
 * @returns {bigint} micro-USD, ceiling-rounded
 */
export function providerCostMicros(usage, rate) {
  if (usage?.providerCostUsdMicros !== null && usage?.providerCostUsdMicros !== undefined) {
    return big(usage.providerCostUsdMicros);
  }
  const raw =
    big(usage?.inputTokens) * big(rate?.input_price_per_1m_micros) +
    big(usage?.cachedInputTokens) * big(rate?.cached_input_price_per_1m_micros) +
    big(usage?.outputTokens) * big(rate?.output_price_per_1m_micros) +
    big(usage?.reasoningTokens) * big(rate?.reasoning_price_per_1m_micros);
  return ceilDiv(raw, 1_000_000n);
}

/**
 * Convert a provider cost (micro-USD) to customer credits, applying the FX
 * rate, markup, and — for OpenRouter — the platform fee. Rounds UP to a whole
 * credit and never returns less than the rate card's minimum charge (unless the
 * cost is genuinely zero, e.g. a free local model).
 *
 * @param {bigint|number} costMicros
 * @param {object} rate  a row from ai_model_rates (carries provider + factors)
 * @returns {number} whole credits
 */
export function costMicrosToCredits(costMicros, rate) {
  const micros = big(costMicros);
  const exchange = big(rate?.billing_exchange_rate_paise_usd); // paise per USD
  const markupX10 = big(rate?.markup_multiplier_x10); // e.g. 25 for 2.5x
  const feeBps = big(rate?.provider_fee_bps); // e.g. 550 for 5.5%
  const minCharge = big(rate?.minimum_credit_charge);

  if (micros === 0n) return 0;

  // One fused expression, one ceiling at the end, so no intermediate rounding
  // can drift. numerator/denominator keep it exact until the final divide.
  //   credits = micros × exchange × markupX10 × (BPS_DENOM + feeBps)
  //             / (MICROS_PER_USD × MARKUP_DENOM × BPS_DENOM)
  // OpenRouter carries feeBps > 0; direct providers carry 0, so the fee factor
  // collapses to 1 (BPS_DENOM/BPS_DENOM).
  const numerator = micros * exchange * markupX10 * (BPS_DENOM + feeBps);
  const denominator = MICROS_PER_USD * MARKUP_DENOM * BPS_DENOM;
  const credits = ceilDiv(numerator, denominator);

  const floored = credits < minCharge ? minCharge : credits;
  return Number(floored);
}

/**
 * Full path: normalized usage + rate card row -> whole credits charged.
 * @param {import('../ai/usage.js').NormalizedUsage} usage
 * @param {object} rate
 * @returns {number}
 */
export function usageToCredits(usage, rate) {
  return costMicrosToCredits(providerCostMicros(usage, rate), rate);
}

/**
 * The MAXIMUM credits a request could cost, for the pre-call reservation.
 *
 * Assumes the worst case: the whole allowance is output tokens (the priciest
 * lane) at the rate card's maximum_output_tokens, plus the estimated input.
 * Deliberately an over-estimate — the reconcile step releases whatever is not
 * actually used, so a generous reserve only briefly holds credits, never
 * overcharges.
 *
 * @param {object} rate
 * @param {{ estimatedInputTokens?: number }} [opts]
 * @returns {number} whole credits
 */
export function estimateMaxCredits(rate, { estimatedInputTokens = 0 } = {}) {
  const maxOut = big(rate?.maximum_output_tokens) || 8192n;
  const worstUsage = {
    inputTokens: Number(big(estimatedInputTokens)),
    cachedInputTokens: 0,
    outputTokens: Number(maxOut),
    reasoningTokens: 0,
    providerCostUsdMicros: null, // force token-based derivation
  };
  const credits = usageToCredits(worstUsage, rate);
  // Always reserve at least the minimum charge so a free-tier estimate of 0
  // still trips the balance check the way a real charge would.
  return Math.max(credits, Number(big(rate?.minimum_credit_charge)));
}
