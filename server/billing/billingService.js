import { getWallet } from '../db/walletRepository.js';
import {
  captureReservation,
  releaseReservation,
  reserveCredits,
} from '../db/reservationRepository.js';
import { getModelRate, planAllowsRate } from '../db/rateCardRepository.js';
import { recordUsage } from '../db/aiUsageRepository.js';
import { getActivePlanCode } from '../db/subscriptionRepository.js';
import { estimateMaxCredits, usageToCredits, providerCostMicros } from './creditMath.js';
import { logger } from '../lib/logger.js';

/**
 * The billing orchestrator: RESERVE -> EXECUTE -> RECONCILE around an AI call.
 *
 * Keeps the wallet independent of the AI provider (it consumes NormalizedUsage,
 * not a provider response) and of the HTTP layer (it takes an ownerId, a
 * provider, a model, and a requestId). The AI route wraps a provider call with
 * `reserve()` before and `reconcile()` / `release()` after.
 *
 * Errors are typed so the route can map them: ModelAccessError (403),
 * InsufficientCreditsError (from the wallet, 402).
 */

export class ModelAccessError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ModelAccessError';
  }
}

/** Balances for the UI/analytics. */
export async function getCreditBalance(ownerId) {
  const wallet = await getWallet(ownerId);
  if (!wallet) {
    return {
      subscriptionCredits: 0,
      bonusCredits: 0,
      purchasedCredits: 0,
      totalCredits: 0,
      usedThisMonth: 0,
      lifetimeUsed: 0,
    };
  }
  return wallet;
}

/**
 * Resolve the rate row for a provider+model and confirm the owner's plan may
 * use it. Throws ModelAccessError when the model is unknown, disabled, or not
 * allowed on the plan.
 */
export async function resolveBillableModel(ownerId, provider, model) {
  const rate = await getModelRate(provider, model);
  if (!rate || !rate.enabled) {
    throw new ModelAccessError(`The model "${model}" is not available for billing on this server.`);
  }
  const planCode = await getActivePlanCode(ownerId);
  if (!planAllowsRate(rate, planCode)) {
    throw new ModelAccessError(
      `Your plan does not include the model "${model}". Upgrade your plan or choose another model.`,
    );
  }
  return { rate, planCode };
}

/** The maximum a request could cost, for the low-balance gate + reservation. */
export function estimateAIRequestCost(rate, opts = {}) {
  return estimateMaxCredits(rate, opts);
}

/**
 * RESERVE: confirm access, estimate the worst-case cost, and hold it. Throws
 * ModelAccessError / InsufficientCreditsError. Ollama (free) still reserves the
 * minimum charge so the flow is uniform, but reconciles to 0.
 *
 * @returns {Promise<{ rate, reservation, estimate }>}
 */
export async function reserveForRequest({
  ownerId,
  provider,
  model,
  requestId,
  estimatedInputTokens = 0,
}) {
  const { rate } = await resolveBillableModel(ownerId, provider, model);
  const estimate = estimateAIRequestCost(rate, { estimatedInputTokens });
  const reservation = await reserveCredits(ownerId, requestId, estimate);
  return { rate, reservation, estimate };
}

/**
 * RECONCILE: compute the actual credits from the provider's normalized usage +
 * the (snapshotted) rate, capture that from the wallet, release the rest, and
 * write the immutable usage row. Idempotent per requestId.
 *
 * @returns {Promise<{ creditsCharged: number }>}
 */
export async function reconcile({ ownerId, requestId, usage, rate }) {
  const costMicros = providerCostMicros(usage, rate);
  const credits = usageToCredits(usage, rate);

  const captured = await captureReservation(requestId, credits, {
    provider: usage.provider,
    model: usage.model,
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    providerCostUsdMicros: Number(costMicros),
    description: `AI usage — ${usage.provider}/${usage.model}`,
  });

  // Immutable usage record, snapshotting the rate + markup used right now.
  await recordUsage({
    requestId,
    ownerId,
    provider: usage.provider,
    model: usage.model,
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    providerCostUsdMicros: Number(costMicros),
    providerFeeBps: rate.provider_fee_bps,
    markupMultiplierX10: rate.markup_multiplier_x10,
    billingExchangeRatePaiseUsd: rate.billing_exchange_rate_paise_usd,
    creditsCharged: captured.captured ? captured.credits : 0,
    status: 'completed',
  });

  return { creditsCharged: captured.captured ? captured.credits : credits };
}

/**
 * RELEASE: the provider call produced no billable usage (a failure before any
 * output). Free the whole reservation and record a failed usage row for
 * analytics. Never charges.
 */
export async function releaseForRequest({ ownerId, requestId, provider, model, errorCode }) {
  await releaseReservation(requestId);
  try {
    await recordUsage({
      requestId,
      ownerId,
      provider: provider ?? 'unknown',
      model: model ?? 'unknown',
      creditsCharged: 0,
      status: 'failed',
      errorCode: errorCode ?? null,
    });
  } catch (err) {
    // A usage row is analytics, not money — never let it fail the release.
    logger.warn({ err, requestId }, 'could not record a failed-usage row');
  }
}
