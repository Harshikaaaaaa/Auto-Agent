import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AiRequestError, requestPlan, requestNodeExecution, fetchAiConfig } from '../aiClient';

/**
 * The AI client is the browser's only route to a model. These tests pin the
 * contract that matters: it talks to our own API (never a provider directly),
 * and it turns server error shapes into actionable errors.
 */

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('aiClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => jsonResponse({ plan: { title: 'ok' }, meta: {} }));
    vi.stubGlobal('fetch', fetchMock);
  });

  it('posts to the app API, never to a provider endpoint', async () => {
    await requestPlan({ prompt: 'hello', catalog: [] });

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/ai/plan');
    expect(options.method).toBe('POST');
    // A provider host in a client request would mean a key is needed here.
    expect(url).not.toContain('openrouter.ai');
    expect(url).not.toContain('googleapis.com');
    expect(url).not.toContain('11434');
  });

  it('sends credentials so the session cookie travels with the request', async () => {
    await requestPlan({ prompt: 'hello', catalog: [] });
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(options.credentials).toBe('same-origin');
  });

  it('never includes an authorization header from the browser', async () => {
    await requestPlan({ prompt: 'hello', catalog: [] });
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = (options.headers ?? {}) as Record<string, string>;
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('authorization');
  });

  it('surfaces a validation failure with its issues', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          error: 'invalid_request',
          message: 'The request body did not match the expected shape.',
          issues: [{ path: 'prompt', message: 'Required' }],
        },
        400,
      ),
    );

    const error = await requestPlan({ prompt: '', catalog: [] }).catch((e) => e);
    expect(error).toBeInstanceOf(AiRequestError);
    expect(error.status).toBe(400);
    expect(error.code).toBe('invalid_request');
    expect(error.retryable).toBe(false);
    expect(error.issues?.[0]?.path).toBe('prompt');
  });

  it('marks a provider rate limit as retryable', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          error: 'provider_error',
          message: 'openrouter rate limit reached. Try again shortly.',
          retryable: true,
          provider: 'openrouter',
        },
        429,
      ),
    );

    const error = await requestPlan({ prompt: 'hi', catalog: [] }).catch((e) => e);
    expect(error.retryable).toBe(true);
    expect(error.provider).toBe('openrouter');
  });

  it('reports an unreachable server distinctly from a rejected request', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const error = await requestPlan({ prompt: 'hi', catalog: [] }).catch((e) => e);
    expect(error).toBeInstanceOf(AiRequestError);
    expect(error.code).toBe('network_error');
    expect(error.status).toBe(0);
    expect(error.retryable).toBe(true);
    expect(error.message).toMatch(/Is it running/i);
  });

  it('handles a non-JSON error body without throwing a parse error', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>502 Bad Gateway</html>', { status: 502 }));

    const error = await requestPlan({ prompt: 'hi', catalog: [] }).catch((e) => e);
    expect(error).toBeInstanceOf(AiRequestError);
    expect(error.status).toBe(502);
    expect(error.retryable).toBe(true);
  });

  it('returns node output on success', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ output: { summary: 'done' }, meta: { provider: 'ollama' } }),
    );

    const result = await requestNodeExecution({ nodeLabel: 'Summarize', outputKeys: ['summary'] });
    expect(result.output).toEqual({ summary: 'done' });
  });

  it('loads public AI config', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        defaultProvider: 'openrouter',
        allowProviderOverride: true,
        providers: { openrouter: { configured: true, model: 'm' } },
      }),
    );

    const config = await fetchAiConfig();
    expect(config.defaultProvider).toBe('openrouter');
    expect(config.providers.openrouter.configured).toBe(true);
  });
});
