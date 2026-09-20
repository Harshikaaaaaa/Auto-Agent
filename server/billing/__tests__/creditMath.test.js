import { describe, expect, it } from 'vitest';
import {
  costMicrosToCredits,
  estimateMaxCredits,
  providerCostMicros,
  usageToCredits,
} from '../creditMath.js';

// A direct-provider rate card row: 2.5x markup, ₹100/USD, no platform fee.
const DIRECT_RATE = {
  provider: 'openai',
  markup_multiplier_x10: 25,
  billing_exchange_rate_paise_usd: 10_000,
  provider_fee_bps: 0,
  minimum_credit_charge: 1,
  maximum_output_tokens: 8192,
  input_price_per_1m_micros: 150_000, // $0.15 / 1M
  cached_input_price_per_1m_micros: 75_000,
  output_price_per_1m_micros: 600_000, // $0.60 / 1M
  reasoning_price_per_1m_micros: 0,
};

// OpenRouter: same but with the 5.5% platform fee (550 bps).
const OPENROUTER_RATE = { ...DIRECT_RATE, provider: 'openrouter', provider_fee_bps: 550 };

describe('costMicrosToCredits — the profit formula', () => {
  it('charges 25,000 credits for $1 of direct provider cost (2.5x, ₹100/USD)', () => {
    // $1 = 1_000_000 micro-USD.
    expect(costMicrosToCredits(1_000_000, DIRECT_RATE)).toBe(25_000);
  });

  it('charges 26,375 credits for $1 of OpenRouter cost (adds 5.5% fee)', () => {
    expect(costMicrosToCredits(1_000_000, OPENROUTER_RATE)).toBe(26_375);
  });

  it('is linear: $0.02 direct -> 500 credits', () => {
    expect(costMicrosToCredits(20_000, DIRECT_RATE)).toBe(500);
  });

  it('rounds UP to a whole credit (never undercharges a fraction)', () => {
    // A cost that lands between whole credits must ceil, not floor.
    // 1 micro-USD × 10_000 × 25 / (1e6 × 10) = 0.025 credits -> 1.
    expect(costMicrosToCredits(1, DIRECT_RATE)).toBe(1);
  });

  it('applies the minimum_credit_charge floor for a tiny non-zero cost', () => {
    const rate = { ...DIRECT_RATE, minimum_credit_charge: 5 };
    // A cost that would be 1 credit is lifted to the 5-credit floor.
    expect(costMicrosToCredits(1, rate)).toBe(5);
  });

  it('charges nothing for a genuinely zero cost (free local model)', () => {
    const free = { ...DIRECT_RATE, minimum_credit_charge: 0 };
    expect(costMicrosToCredits(0, free)).toBe(0);
  });
});

describe('providerCostMicros', () => {
  it('uses the provider-reported dollar cost when present', () => {
    const usage = { providerCostUsdMicros: 21_000 };
    expect(providerCostMicros(usage, OPENROUTER_RATE)).toBe(21_000n);
  });

  it('derives cost from tokens × rate when the provider reports no dollar cost', () => {
    const usage = {
      providerCostUsdMicros: null,
      inputTokens: 1_000_000, // × 150_000 micros/1M = 150_000 micros
      cachedInputTokens: 0,
      outputTokens: 1_000_000, // × 600_000 micros/1M = 600_000 micros
      reasoningTokens: 0,
    };
    expect(providerCostMicros(usage, DIRECT_RATE)).toBe(750_000n);
  });

  it('prices cached input at the cached rate, and reasoning tokens too', () => {
    const rate = { ...DIRECT_RATE, reasoning_price_per_1m_micros: 300_000 };
    const usage = {
      providerCostUsdMicros: null,
      inputTokens: 0,
      cachedInputTokens: 1_000_000, // × 75_000 = 75_000
      outputTokens: 0,
      reasoningTokens: 1_000_000, // × 300_000 = 300_000
    };
    expect(providerCostMicros(usage, rate)).toBe(375_000n);
  });
});

describe('usageToCredits (end to end)', () => {
  it('derives cost from tokens then converts to credits', () => {
    const usage = {
      providerCostUsdMicros: null,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    };
    // 750_000 micros direct -> 750_000 × 10_000 × 25 / (1e6 × 10) = 18_750 credits.
    expect(usageToCredits(usage, DIRECT_RATE)).toBe(18_750);
  });

  it('adds the OpenRouter fee on the same usage', () => {
    const usage = {
      providerCostUsdMicros: null,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    };
    // 18_750 × 10_550 / 10_000 = 19_781.25 -> ceil 19_782.
    expect(usageToCredits(usage, OPENROUTER_RATE)).toBe(19_782);
  });
});

describe('estimateMaxCredits (reservation ceiling)', () => {
  it('reserves against the max output tokens (the priciest lane)', () => {
    // 8192 output × 600_000 micros/1M = ceil(8192×600000/1e6) = 4916 micros
    // -> 4916 × 10_000 × 25 / (1e6 × 10) = 122.9 -> 123 credits.
    expect(estimateMaxCredits(DIRECT_RATE)).toBe(123);
  });

  it('never estimates below the minimum charge', () => {
    const free = {
      ...DIRECT_RATE,
      output_price_per_1m_micros: 0,
      input_price_per_1m_micros: 0,
      minimum_credit_charge: 7,
    };
    expect(estimateMaxCredits(free)).toBe(7);
  });
});
