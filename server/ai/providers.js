import { env } from '../config/env.js';
import { emptyUsage, normalizeUsage, sumUsage, usdToMicros } from './usage.js';

/** Coerce a possibly-missing numeric field to a non-negative integer. */
function intFrom(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/**
 * Provider adapters for LLM calls.
 *
 * SECURITY: this module is the ONLY place API keys are read, and it runs
 * server-side exclusively. Keys must never be returned in a response body,
 * echoed into an error message, or logged.
 */

export class ProviderError extends Error {
  /**
   * @param {string} message  Safe, user-facing message (never contains a key).
   * @param {object} options
   * @param {number} options.status      HTTP status to return to the client.
   * @param {string} options.provider    Which provider failed.
   * @param {boolean} options.retryable  Whether a retry could succeed.
   * @param {unknown} [options.cause]
   */
  constructor(message, { status = 502, provider, retryable = false, cause } = {}) {
    super(message, { cause });
    this.name = 'ProviderError';
    this.status = status;
    this.provider = provider;
    this.retryable = retryable;
  }
}

/** Strip markdown code fences some models wrap JSON in. */
export function cleanJsonResponse(text) {
  let cleaned = String(text ?? '').trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/g, '');
  }
  return cleaned.trim();
}

/**
 * Some models emit prose around the JSON. Recover the outermost JSON object.
 * Returns null when nothing parseable is found, so callers can fail explicitly
 * rather than silently proceeding with a wrong shape.
 */
export function parseJsonLoose(text) {
  const cleaned = cleanJsonResponse(text);
  try {
    return JSON.parse(cleaned);
  } catch {
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first !== -1 && last > first) {
      try {
        return JSON.parse(cleaned.slice(first, last + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** Classify an upstream HTTP status into a safe, actionable error. */
function providerHttpError(provider, status, bodyText) {
  // Never include the raw body for auth failures: it can echo the key back.
  if (status === 401 || status === 403) {
    return new ProviderError(
      `The ${provider} credential was rejected. Check the server-side API key.`,
      { status: 502, provider, retryable: false },
    );
  }
  if (status === 429) {
    return new ProviderError(`${provider} rate limit reached. Try again shortly.`, {
      status: 429,
      provider,
      retryable: true,
    });
  }
  if (status >= 500) {
    return new ProviderError(`${provider} is temporarily unavailable.`, {
      status: 502,
      provider,
      retryable: true,
    });
  }
  const detail = String(bodyText ?? '').slice(0, 300);
  return new ProviderError(`${provider} rejected the request (${status}). ${detail}`, {
    status: 502,
    provider,
    retryable: false,
  });
}

async function fetchWithTimeout(url, options, provider) {
  try {
    return await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(env.AI_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw new ProviderError(
      timedOut
        ? `${provider} did not respond within ${env.AI_REQUEST_TIMEOUT_MS}ms.`
        : `Could not reach ${provider}.`,
      { status: 504, provider, retryable: true, cause: err },
    );
  }
}

// ---------------------------------------------------------------- OpenRouter

async function callOpenRouter({ prompt, model, jsonMode }) {
  if (!env.OPENROUTER_API_KEY) {
    throw new ProviderError('OpenRouter is not configured on the server.', {
      status: 503,
      provider: 'openrouter',
    });
  }

  const resolvedModel = model || env.OPENROUTER_MODEL;
  const body = {
    model: resolvedModel,
    messages: [{ role: 'user', content: prompt }],
    // Ask OpenRouter to include usage + the upstream dollar cost in the
    // response, so billing does not need a second /generation lookup.
    usage: { include: true },
  };
  if (jsonMode) body.response_format = { type: 'json_object' };

  const res = await fetchWithTimeout(
    `${env.OPENROUTER_BASE_URL}/chat/completions`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    'openrouter',
  );

  if (!res.ok) throw providerHttpError('openrouter', res.status, await res.text());

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new ProviderError('OpenRouter returned an empty response.', {
      status: 502,
      provider: 'openrouter',
      retryable: true,
    });
  }

  const u = data?.usage ?? {};
  const usage = normalizeUsage({
    provider: 'openrouter',
    model: resolvedModel,
    inputTokens: u.prompt_tokens,
    cachedInputTokens: u.prompt_tokens_details?.cached_tokens,
    outputTokens: u.completion_tokens,
    reasoningTokens: u.completion_tokens_details?.reasoning_tokens,
    // OpenRouter reports the real upstream cost in USD when usage.include is set.
    providerCostUsdMicros: usdToMicros(u.cost),
    requestId: data?.id,
  });
  return { content, usage };
}

// -------------------------------------------------------------------- Gemini

async function callGemini({ prompt, model, jsonMode }) {
  if (!env.GEMINI_API_KEY) {
    throw new ProviderError('Gemini is not configured on the server.', {
      status: 503,
      provider: 'gemini',
    });
  }

  const modelId = model || env.GEMINI_MODEL;
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
  };
  if (jsonMode) body.generationConfig = { responseMimeType: 'application/json' };

  const res = await fetchWithTimeout(
    `${env.GEMINI_BASE_URL}/models/${encodeURIComponent(modelId)}:generateContent`,
    {
      method: 'POST',
      headers: {
        // Header auth, not a query param: keeps the key out of URLs and logs.
        'x-goog-api-key': env.GEMINI_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    'gemini',
  );

  if (!res.ok) throw providerHttpError('gemini', res.status, await res.text());

  const data = await res.json();
  const content = data?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('');
  if (!content) {
    const blockReason = data?.promptFeedback?.blockReason;
    throw new ProviderError(
      blockReason
        ? `Gemini blocked the request (${blockReason}).`
        : 'Gemini returned an empty response.',
      { status: 502, provider: 'gemini', retryable: !blockReason },
    );
  }

  // Gemini reports token counts, not a dollar cost — leave cost null and let the
  // rate card derive it from tokens. `promptTokenCount` INCLUDES cached tokens,
  // so subtract the cached count to get the uncached input the rate card bills
  // at the full input price (cached tokens bill at the cached price).
  const m = data?.usageMetadata ?? {};
  const cached = intFrom(m.cachedContentTokenCount);
  const totalPrompt = intFrom(m.promptTokenCount);
  const usage = normalizeUsage({
    provider: 'gemini',
    model: modelId,
    inputTokens: Math.max(0, totalPrompt - cached),
    cachedInputTokens: cached,
    outputTokens: m.candidatesTokenCount,
    reasoningTokens: m.thoughtsTokenCount,
    providerCostUsdMicros: null,
  });
  return { content, usage };
}

// -------------------------------------------------------------------- Ollama

async function callOllama({ prompt, model, jsonMode }) {
  const body = {
    model: model || env.OLLAMA_MODEL,
    messages: [{ role: 'user', content: prompt }],
    stream: false,
  };
  if (jsonMode) body.format = 'json';

  const res = await fetchWithTimeout(
    `${env.OLLAMA_BASE_URL}/api/chat`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    'ollama',
  );

  if (!res.ok) throw providerHttpError('ollama', res.status, await res.text());

  const data = await res.json();
  const content = data?.message?.content;
  if (!content) {
    throw new ProviderError('Ollama returned an empty response.', {
      status: 502,
      provider: 'ollama',
      retryable: true,
    });
  }

  // Ollama is local and free; token counts are captured for analytics, but the
  // rate card prices it at zero.
  const usage = normalizeUsage({
    provider: 'ollama',
    model: model || env.OLLAMA_MODEL,
    inputTokens: data?.prompt_eval_count,
    outputTokens: data?.eval_count,
    providerCostUsdMicros: 0,
  });
  return { content, usage };
}

// -------------------------------------------------------------------- OpenAI

async function callOpenAI({ prompt, model, jsonMode }) {
  if (!env.OPENAI_API_KEY) {
    throw new ProviderError('OpenAI is not configured on the server.', {
      status: 503,
      provider: 'openai',
    });
  }

  const resolvedModel = model || env.OPENAI_MODEL;
  const body = {
    model: resolvedModel,
    messages: [{ role: 'user', content: prompt }],
  };
  if (jsonMode) body.response_format = { type: 'json_object' };

  const res = await fetchWithTimeout(
    `${env.OPENAI_BASE_URL}/chat/completions`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    'openai',
  );

  if (!res.ok) throw providerHttpError('openai', res.status, await res.text());

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new ProviderError('OpenAI returned an empty response.', {
      status: 502,
      provider: 'openai',
      retryable: true,
    });
  }

  // OpenAI reports token counts, not a dollar cost. prompt_tokens INCLUDES the
  // cached portion, so subtract it for the full-price uncached input.
  const u = data?.usage ?? {};
  const cached = intFrom(u.prompt_tokens_details?.cached_tokens);
  const promptTokens = intFrom(u.prompt_tokens);
  const usage = normalizeUsage({
    provider: 'openai',
    model: resolvedModel,
    inputTokens: Math.max(0, promptTokens - cached),
    cachedInputTokens: cached,
    outputTokens: u.completion_tokens,
    reasoningTokens: u.completion_tokens_details?.reasoning_tokens,
    providerCostUsdMicros: null,
    requestId: data?.id,
  });
  return { content, usage };
}

const PROVIDERS = {
  openrouter: callOpenRouter,
  gemini: callGemini,
  ollama: callOllama,
  openai: callOpenAI,
};

/**
 * Resolve which provider to use for a request.
 * A client hint is honoured only when the server allows overrides AND the
 * requested provider is actually configured.
 */
export function resolveProvider(requested) {
  if (!requested || requested === 'auto') return env.AI_PROVIDER;
  if (!env.AI_ALLOW_CLIENT_PROVIDER_OVERRIDE) return env.AI_PROVIDER;
  if (!PROVIDERS[requested]) return env.AI_PROVIDER;
  if (requested === 'openrouter' && !env.OPENROUTER_API_KEY) return env.AI_PROVIDER;
  if (requested === 'gemini' && !env.GEMINI_API_KEY) return env.AI_PROVIDER;
  if (requested === 'openai' && !env.OPENAI_API_KEY) return env.AI_PROVIDER;
  return requested;
}

/** Default model for a provider when the client does not pin one. */
export function defaultModelFor(provider) {
  switch (provider) {
    case 'openrouter':
      return env.OPENROUTER_MODEL;
    case 'gemini':
      return env.GEMINI_MODEL;
    case 'ollama':
      return env.OLLAMA_MODEL;
    case 'openai':
      return env.OPENAI_MODEL;
    default:
      return env.OPENROUTER_MODEL;
  }
}

/**
 * Call the resolved provider and return raw text plus normalized usage.
 * @returns {Promise<{ text: string, provider: string, model: string, usage: import('./usage.js').NormalizedUsage }>}
 */
export async function callProvider({ prompt, provider, model, jsonMode = true }) {
  const resolved = resolveProvider(provider);
  const call = PROVIDERS[resolved];
  if (!call) {
    throw new ProviderError(`Unknown AI provider "${resolved}".`, {
      status: 500,
      provider: resolved,
    });
  }
  const resolvedModel = model || defaultModelFor(resolved);
  const result = await call({ prompt, model: resolvedModel, jsonMode });
  return {
    text: result.content,
    provider: resolved,
    model: resolvedModel,
    usage: result.usage ?? emptyUsage(resolved, resolvedModel),
  };
}

/**
 * Call the provider and require a JSON object back.
 * Retries once on unparseable output, because a single bad completion is common
 * and cheap to redo; anything beyond that is surfaced as an error.
 */
export async function callProviderForJson({ prompt, provider, model }) {
  let lastText = '';
  // Both attempts are billable provider calls, so their usage sums.
  let usage = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await callProvider({ prompt, provider, model, jsonMode: true });
    lastText = result.text;
    usage = sumUsage(usage, result.usage);
    const parsed = parseJsonLoose(result.text);
    if (parsed && typeof parsed === 'object') {
      return { ...result, usage, json: parsed, attempts: attempt + 1 };
    }
  }
  throw new ProviderError('The model did not return valid JSON after two attempts.', {
    status: 502,
    provider: resolveProvider(provider),
    retryable: true,
    cause: new Error(`Last response began: ${lastText.slice(0, 200)}`),
  });
}

/**
 * Startup probe: confirm the configured model actually resolves.
 *
 * Deliberately NON-fatal. A network blip or a laptop without Ollama running
 * must not prevent the server from booting; the result is logged and exposed
 * on /api/ai/health so the problem is visible rather than silent.
 */
export async function probeConfiguredModel() {
  const provider = env.AI_PROVIDER;
  const model = defaultModelFor(provider);
  const result = { provider, model, ok: false, detail: '' };

  try {
    if (provider === 'openrouter') {
      const res = await fetchWithTimeout(
        `${env.OPENROUTER_BASE_URL}/models`,
        { headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}` } },
        'openrouter',
      );
      if (!res.ok) throw providerHttpError('openrouter', res.status, await res.text());
      const data = await res.json();
      const ids = (data?.data ?? []).map((m) => m.id);
      result.ok = ids.includes(model);
      result.detail = result.ok
        ? 'model listed by provider'
        : `model "${model}" was not in the provider's model list`;
    } else if (provider === 'gemini') {
      const res = await fetchWithTimeout(
        `${env.GEMINI_BASE_URL}/models/${encodeURIComponent(model)}`,
        { headers: { 'x-goog-api-key': env.GEMINI_API_KEY } },
        'gemini',
      );
      result.ok = res.ok;
      result.detail = res.ok ? 'model resolved' : `provider returned ${res.status} for this model`;
    } else if (provider === 'openai') {
      const res = await fetchWithTimeout(
        `${env.OPENAI_BASE_URL}/models/${encodeURIComponent(model)}`,
        { headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` } },
        'openai',
      );
      result.ok = res.ok;
      result.detail = res.ok ? 'model resolved' : `provider returned ${res.status} for this model`;
    } else {
      const res = await fetchWithTimeout(`${env.OLLAMA_BASE_URL}/api/tags`, {}, 'ollama');
      if (!res.ok) throw providerHttpError('ollama', res.status, await res.text());
      const data = await res.json();
      const names = (data?.models ?? []).map((m) => m.name);
      // Ollama tags are like "deepseek-r1:8b"; accept an exact or base match.
      result.ok = names.some((n) => n === model || n.split(':')[0] === model.split(':')[0]);
      result.detail = result.ok ? 'model pulled locally' : `model "${model}" is not pulled locally`;
    }
  } catch (err) {
    result.ok = false;
    result.detail = err instanceof ProviderError ? err.message : 'probe failed';
  }

  return result;
}
