import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Provider adapter behaviour, with the network stubbed.
 *
 * The security-critical assertion here is that an upstream auth failure never
 * echoes the API key back to the caller — an error body can contain it.
 */

const originalEnv = { ...process.env };
const REAL_KEY = 'sk-or-v1-thisisatestkeyvalue0123456789abcdef';

async function loadProviders(overrides = {}) {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, {
    AUTOAGENT_SKIP_ENV_FILES: '1',
    AI_PROVIDER: 'openrouter',
    OPENROUTER_API_KEY: REAL_KEY,
    // Auth config is required for the env module to validate; these tests are
    // about provider behaviour, not auth.
    APP_PASSWORD: 'test-operator-password',
    SESSION_SECRET: 'a'.repeat(64),
    ...overrides,
  });
  vi.resetModules();
  return import('../providers.js');
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('provider adapters', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('parseJsonLoose', () => {
    it('parses plain JSON', async () => {
      const { parseJsonLoose } = await loadProviders();
      expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
    });

    it('strips markdown fences', async () => {
      const { parseJsonLoose } = await loadProviders();
      expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    });

    it('recovers JSON wrapped in prose', async () => {
      const { parseJsonLoose } = await loadProviders();
      expect(parseJsonLoose('Sure! Here you go:\n{"a":1}\nHope that helps.')).toEqual({ a: 1 });
    });

    it('returns null when there is no JSON at all', async () => {
      const { parseJsonLoose } = await loadProviders();
      expect(parseJsonLoose('I cannot do that.')).toBeNull();
    });
  });

  describe('resolveProvider', () => {
    it('falls back to the server default for "auto"', async () => {
      const { resolveProvider } = await loadProviders();
      expect(resolveProvider('auto')).toBe('openrouter');
      expect(resolveProvider(undefined)).toBe('openrouter');
    });

    it('ignores a requested provider that has no credential', async () => {
      const { resolveProvider } = await loadProviders();
      // GEMINI_API_KEY is unset, so a gemini request must not be honoured.
      expect(resolveProvider('gemini')).toBe('openrouter');
    });

    it('honours a requested provider that is configured', async () => {
      const { resolveProvider } = await loadProviders({ GEMINI_API_KEY: 'gem-key-value-123456' });
      expect(resolveProvider('gemini')).toBe('gemini');
    });

    it('ignores client overrides when the server locks the provider', async () => {
      const { resolveProvider } = await loadProviders({
        GEMINI_API_KEY: 'gem-key-value-123456',
        AI_ALLOW_CLIENT_PROVIDER_OVERRIDE: 'false',
      });
      expect(resolveProvider('gemini')).toBe('openrouter');
    });

    it('ignores an unknown provider name', async () => {
      const { resolveProvider } = await loadProviders();
      expect(resolveProvider('definitely-not-a-provider')).toBe('openrouter');
    });
  });

  describe('error handling', () => {
    it('never leaks the API key when the provider rejects the credential', async () => {
      // A real provider 401 body can echo the key back. It must not propagate.
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(`{"error":"invalid key: ${REAL_KEY}"}`, { status: 401 })),
      );
      const { callProvider, ProviderError } = await loadProviders();

      const error = await callProvider({ prompt: 'hi' }).catch((e) => e);
      expect(error).toBeInstanceOf(ProviderError);
      expect(error.message).not.toContain(REAL_KEY);
      expect(error.message).toMatch(/credential was rejected/i);
      expect(error.retryable).toBe(false);
    });

    it('marks rate limiting as retryable and passes 429 through', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('slow down', { status: 429 })),
      );
      const { callProvider } = await loadProviders();

      const error = await callProvider({ prompt: 'hi' }).catch((e) => e);
      expect(error.status).toBe(429);
      expect(error.retryable).toBe(true);
    });

    it('marks upstream 5xx as retryable', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('boom', { status: 503 })),
      );
      const { callProvider } = await loadProviders();

      const error = await callProvider({ prompt: 'hi' }).catch((e) => e);
      expect(error.retryable).toBe(true);
      expect(error.message).toMatch(/temporarily unavailable/i);
    });

    it('never calls a provider that has no credential, even if asked to', async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse({ message: { content: '{"viaOllama":true}' } }),
      );
      vi.stubGlobal('fetch', fetchMock);
      // Server default is ollama; OpenRouter is deliberately unconfigured.
      const { callProvider } = await loadProviders({
        AI_PROVIDER: 'ollama',
        OPENROUTER_API_KEY: '',
      });

      const result = await callProvider({ prompt: 'hi', provider: 'openrouter' });

      // The request must have been redirected to the configured provider,
      // never sent to OpenRouter without a key.
      expect(result.provider).toBe('ollama');
      const calledUrl = String(fetchMock.mock.calls[0][0]);
      expect(calledUrl).toContain('/api/chat');
      expect(calledUrl).not.toContain('openrouter');
    });

    it('surfaces a timeout as a retryable 504', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          const err = new Error('timed out');
          err.name = 'TimeoutError';
          throw err;
        }),
      );
      const { callProvider } = await loadProviders();

      const error = await callProvider({ prompt: 'hi' }).catch((e) => e);
      expect(error.status).toBe(504);
      expect(error.retryable).toBe(true);
    });
  });

  describe('callProviderForJson', () => {
    it('returns parsed JSON on the first attempt', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse({ choices: [{ message: { content: '{"ok":true}' } }] })),
      );
      const { callProviderForJson } = await loadProviders();

      const result = await callProviderForJson({ prompt: 'hi' });
      expect(result.json).toEqual({ ok: true });
      expect(result.attempts).toBe(1);
      expect(result.provider).toBe('openrouter');
    });

    it('retries once when the first response is not JSON', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'not json' } }] }))
        .mockResolvedValueOnce(
          jsonResponse({ choices: [{ message: { content: '{"recovered":true}' } }] }),
        );
      vi.stubGlobal('fetch', fetchMock);
      const { callProviderForJson } = await loadProviders();

      const result = await callProviderForJson({ prompt: 'hi' });
      expect(result.json).toEqual({ recovered: true });
      expect(result.attempts).toBe(2);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('fails after two unparseable responses rather than guessing', async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse({ choices: [{ message: { content: 'still not json' } }] }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const { callProviderForJson } = await loadProviders();

      await expect(callProviderForJson({ prompt: 'hi' })).rejects.toThrow(/valid JSON/i);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('treats an empty completion as a retryable provider error', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse({ choices: [{ message: { content: '' } }] })),
      );
      const { callProviderForJson } = await loadProviders();

      const error = await callProviderForJson({ prompt: 'hi' }).catch((e) => e);
      expect(error.message).toMatch(/empty response/i);
    });
  });

  describe('request shape', () => {
    it('sends the key in a header and enables JSON mode for OpenRouter', async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse({ choices: [{ message: { content: '{"a":1}' } }] }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const { callProvider } = await loadProviders();

      await callProvider({ prompt: 'hello', jsonMode: true });

      const [url, options] = fetchMock.mock.calls[0];
      expect(String(url)).toContain('/chat/completions');
      expect(options.headers.Authorization).toBe(`Bearer ${REAL_KEY}`);
      expect(JSON.parse(options.body).response_format).toEqual({ type: 'json_object' });
      // The key must never appear in the URL, which gets logged by proxies.
      expect(String(url)).not.toContain(REAL_KEY);
    });

    it('uses header auth for Gemini so the key stays out of the URL', async () => {
      const geminiKey = 'AIzaTestKeyValue0123456789abcdefghijklmn';
      const fetchMock = vi.fn(async () =>
        jsonResponse({ candidates: [{ content: { parts: [{ text: '{"a":1}' }] } }] }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const { callProvider } = await loadProviders({
        AI_PROVIDER: 'gemini',
        GEMINI_API_KEY: geminiKey,
      });

      await callProvider({ prompt: 'hello' });

      const [url, options] = fetchMock.mock.calls[0];
      expect(String(url)).not.toContain(geminiKey);
      expect(options.headers['x-goog-api-key']).toBe(geminiKey);
    });

    it('reports a Gemini safety block distinctly from an empty response', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse({ promptFeedback: { blockReason: 'SAFETY' } })),
      );
      const { callProvider } = await loadProviders({
        AI_PROVIDER: 'gemini',
        GEMINI_API_KEY: 'gem-key-value-123456',
      });

      const error = await callProvider({ prompt: 'hello' }).catch((e) => e);
      expect(error.message).toMatch(/blocked the request \(SAFETY\)/);
      expect(error.retryable).toBe(false);
    });
  });

  describe('usage capture', () => {
    it('parses OpenRouter tokens + dollar cost and asks for usage.include', async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse({
          id: 'gen-abc123',
          choices: [{ message: { content: '{"a":1}' } }],
          usage: {
            prompt_tokens: 1200,
            completion_tokens: 340,
            prompt_tokens_details: { cached_tokens: 200 },
            completion_tokens_details: { reasoning_tokens: 50 },
            cost: 0.021, // USD
          },
        }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const { callProvider } = await loadProviders();

      const result = await callProvider({ prompt: 'hi' });
      expect(result.usage).toMatchObject({
        provider: 'openrouter',
        inputTokens: 1200,
        cachedInputTokens: 200,
        outputTokens: 340,
        reasoningTokens: 50,
        providerCostUsdMicros: 21000, // 0.021 * 1e6
        requestId: 'gen-abc123',
      });
      // The request opts in to usage reporting.
      const [, options] = fetchMock.mock.calls[0];
      expect(JSON.parse(options.body).usage).toEqual({ include: true });
    });

    it('parses Gemini token counts (cost null) and splits cached from input', async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse({
          candidates: [{ content: { parts: [{ text: '{"a":1}' }] } }],
          usageMetadata: {
            promptTokenCount: 1000, // INCLUDES the 300 cached
            cachedContentTokenCount: 300,
            candidatesTokenCount: 500,
            thoughtsTokenCount: 80,
          },
        }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const { callProvider } = await loadProviders({
        AI_PROVIDER: 'gemini',
        GEMINI_API_KEY: 'gem-key-value-123456',
      });

      const result = await callProvider({ prompt: 'hi' });
      expect(result.usage).toMatchObject({
        provider: 'gemini',
        inputTokens: 700, // 1000 - 300 cached
        cachedInputTokens: 300,
        outputTokens: 500,
        reasoningTokens: 80,
        providerCostUsdMicros: null,
      });
    });

    it('parses OpenAI token counts (cost null)', async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse({
          id: 'chatcmpl-1',
          choices: [{ message: { content: '{"a":1}' } }],
          usage: {
            prompt_tokens: 800,
            completion_tokens: 200,
            prompt_tokens_details: { cached_tokens: 100 },
          },
        }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const { callProvider } = await loadProviders({
        AI_PROVIDER: 'openai',
        OPENAI_API_KEY: 'sk-openai-test-value-0123456789',
      });

      const result = await callProvider({ prompt: 'hi' });
      expect(result.usage).toMatchObject({
        provider: 'openai',
        inputTokens: 700, // 800 - 100 cached
        cachedInputTokens: 100,
        outputTokens: 200,
        providerCostUsdMicros: null,
        requestId: 'chatcmpl-1',
      });
    });

    it('reports Ollama tokens with zero cost (local/free)', async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse({
          message: { content: '{"a":1}' },
          prompt_eval_count: 40,
          eval_count: 90,
        }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const { callProvider } = await loadProviders({ AI_PROVIDER: 'ollama' });

      const result = await callProvider({ prompt: 'hi' });
      expect(result.usage).toMatchObject({
        provider: 'ollama',
        inputTokens: 40,
        outputTokens: 90,
        providerCostUsdMicros: 0,
      });
    });

    it('sums usage across a two-attempt JSON retry', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            id: 'g1',
            choices: [{ message: { content: 'not json' } }],
            usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.001 },
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            id: 'g2',
            choices: [{ message: { content: '{"ok":true}' } }],
            usage: { prompt_tokens: 120, completion_tokens: 12, cost: 0.002 },
          }),
        );
      vi.stubGlobal('fetch', fetchMock);
      const { callProviderForJson } = await loadProviders();

      const result = await callProviderForJson({ prompt: 'hi' });
      expect(result.attempts).toBe(2);
      // Both billable calls sum.
      expect(result.usage.inputTokens).toBe(220);
      expect(result.usage.outputTokens).toBe(22);
      expect(result.usage.providerCostUsdMicros).toBe(3000); // (0.001 + 0.002) * 1e6
      expect(result.usage.requestId).toBe('g2');
    });
  });
});
