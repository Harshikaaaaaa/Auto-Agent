import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleCallError, callGoogle, disconnectTool, fetchConnections } from '../googleClient';

/**
 * The browser's client for the server Google proxy.
 *
 * The whole point of Task 13 is that the browser holds no token, so these tests
 * assert the client only ever names an operation and reads a result — it never
 * sees, sends, or stores a token — and that failures carry a code the connectors
 * map onto the engine's failure taxonomy.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A fetch mock typed so `.mock.calls[i]` keeps its [url, init] shape. */
function stubFetch(impl: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  const mock = vi.fn(impl);
  vi.stubGlobal('fetch', mock);
  return mock;
}

describe('callGoogle', () => {
  it('posts the operation and params to the proxy and returns the result', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ result: { id: 'msg-1' } }));

    const result = await callGoogle('gmail_send_message', { raw: 'base64url' });

    expect(result).toEqual({ id: 'msg-1' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/google/call');
    expect(init?.credentials).toBe('same-origin');
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({ operation: 'gmail_send_message', params: { raw: 'base64url' } });
  });

  it('never receives a token — the request carries only operation and params', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ result: {} }));

    await callGoogle('gmail_list_messages', { maxResults: 5 });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(Object.keys(body)).toEqual(['operation', 'params']);
  });

  it('maps a 401 to a needsReconnect error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ error: 'google_auth_failed', message: 'Reconnect the tool.' }, 401),
      ),
    );

    const error = await callGoogle('gmail_send_message', {}).catch((e) => e);
    expect(error).toBeInstanceOf(GoogleCallError);
    expect(error.status).toBe(401);
    expect(error.needsReconnect).toBe(true);
    expect(error.message).toBe('Reconnect the tool.');
  });

  it('treats not_connected as needing reconnect regardless of status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ error: 'not_connected', message: 'Connect it first.' }, 401),
      ),
    );
    const error = await callGoogle('drive_list_files', {}).catch((e) => e);
    expect(error.needsReconnect).toBe(true);
  });

  it('does not flag an ordinary rejection as needing reconnect', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'google_rejected', message: 'Bad range.' }, 400)),
    );
    const error = await callGoogle('sheets_get_values', {}).catch((e) => e);
    expect(error.needsReconnect).toBe(false);
  });

  it('reports an unreachable server as a network error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    const error = await callGoogle('gmail_list_messages', {}).catch((e) => e);
    expect(error).toBeInstanceOf(GoogleCallError);
    expect(error.code).toBe('network_error');
    // The user-facing message must not be a raw TypeError.
    expect(error.message).toMatch(/could not reach/i);
  });
});

describe('fetchConnections', () => {
  it('returns the server snapshot', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          configured: true,
          supportedTools: ['gmail'],
          connections: [{ toolId: 'gmail', provider: 'google', connected: true, scopes: [] }],
        }),
      ),
    );

    const snapshot = await fetchConnections();
    expect(snapshot.configured).toBe(true);
    expect(snapshot.connections[0].toolId).toBe('gmail');
  });

  it('degrades to an empty snapshot when the server is down', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );

    // The UI's job when the server is unreachable is to show everything
    // disconnected, not to throw inside a render.
    const snapshot = await fetchConnections();
    expect(snapshot).toEqual({ configured: false, supportedTools: [], connections: [] });
  });

  it('degrades to an empty snapshot on a malformed body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ nonsense: true })),
    );
    const snapshot = await fetchConnections();
    expect(snapshot.connections).toEqual([]);
  });
});

describe('disconnectTool', () => {
  it('posts the toolId and resolves on success', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ toolId: 'gmail', removed: true }));

    await disconnectTool('gmail');
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).toEqual({ toolId: 'gmail' });
  });

  it('throws with the server message on failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ message: 'nope' }, 500)),
    );
    await expect(disconnectTool('gmail')).rejects.toThrow('nope');
  });
});
