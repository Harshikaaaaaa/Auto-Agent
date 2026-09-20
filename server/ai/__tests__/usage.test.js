import { describe, expect, it } from 'vitest';
import { emptyUsage, normalizeUsage, sumUsage, usdToMicros } from '../usage.js';

describe('normalizeUsage', () => {
  it('fills absent fields with zero and keeps a null cost null', () => {
    const u = normalizeUsage({ provider: 'gemini', model: 'g' });
    expect(u).toMatchObject({
      provider: 'gemini',
      model: 'g',
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      providerCostUsdMicros: null,
      requestId: null,
    });
  });

  it('rounds and floors token counts to non-negative integers', () => {
    const u = normalizeUsage({ inputTokens: 12.6, outputTokens: -5, cachedInputTokens: '30' });
    expect(u.inputTokens).toBe(13);
    expect(u.outputTokens).toBe(0);
    expect(u.cachedInputTokens).toBe(30);
  });

  it('treats explicit zero cost as zero, not null', () => {
    expect(normalizeUsage({ providerCostUsdMicros: 0 }).providerCostUsdMicros).toBe(0);
  });
});

describe('usdToMicros', () => {
  it('converts fractional USD to integer micro-dollars', () => {
    expect(usdToMicros(0.021)).toBe(21000);
    expect(usdToMicros(1)).toBe(1000000);
    expect(usdToMicros(0)).toBe(0);
  });
  it('returns null for missing or invalid values', () => {
    expect(usdToMicros(null)).toBeNull();
    expect(usdToMicros(undefined)).toBeNull();
    expect(usdToMicros(-1)).toBeNull();
    expect(usdToMicros('nope')).toBeNull();
  });
});

describe('sumUsage', () => {
  it('adds token counts and costs', () => {
    const a = normalizeUsage({ inputTokens: 100, outputTokens: 10, providerCostUsdMicros: 1000 });
    const b = normalizeUsage({ inputTokens: 120, outputTokens: 12, providerCostUsdMicros: 2000 });
    const s = sumUsage(a, b);
    expect(s.inputTokens).toBe(220);
    expect(s.outputTokens).toBe(22);
    expect(s.providerCostUsdMicros).toBe(3000);
  });

  it('keeps cost null only when BOTH sides are null', () => {
    const nullCost = normalizeUsage({ inputTokens: 1, providerCostUsdMicros: null });
    const known = normalizeUsage({ inputTokens: 1, providerCostUsdMicros: 500 });
    expect(sumUsage(nullCost, nullCost).providerCostUsdMicros).toBeNull();
    // One known cost yields a real partial figure.
    expect(sumUsage(nullCost, known).providerCostUsdMicros).toBe(500);
  });

  it('returns the other side when one is missing', () => {
    const a = normalizeUsage({ inputTokens: 5 });
    expect(sumUsage(null, a)).toBe(a);
    expect(sumUsage(a, null)).toBe(a);
  });
});

describe('emptyUsage', () => {
  it('is all zeros with a null cost', () => {
    const u = emptyUsage('openai', 'gpt-4o-mini');
    expect(u.inputTokens).toBe(0);
    expect(u.providerCostUsdMicros).toBeNull();
    expect(u.provider).toBe('openai');
  });
});
