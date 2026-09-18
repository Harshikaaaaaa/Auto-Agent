import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The Google authorization-code flow, exercised without a database or a network.
 *
 * The credential repository is mocked so these tests stay about the OAuth logic —
 * PKCE, the token exchange, refresh, and revoke — rather than MySQL. Google is
 * mocked through the injectable `fetchImpl` every function accepts. A separate
 * suite covers the repository against a real schema.
 */

const BASE_ENV = {
  AUTOAGENT_SKIP_ENV_FILES: '1',
  // Ollama needs no provider key, so env validation passes without one.
  AI_PROVIDER: 'ollama',
  AUTH_ENABLED: 'false',
  CREDENTIAL_SECRET: 'oauth-test-credential-secret-32-characters-min',
  GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
  GOOGLE_OAUTH_REDIRECT_URI: 'http://localhost:3234/api/oauth/google/callback',
  LOG_LEVEL: 'silent',
};

/** In-memory stand-in for the credential repository. */
const store = new Map();
const saved = [];

async function loadGoogle() {
  vi.resetModules();
  for (const [key, value] of Object.entries(BASE_ENV)) process.env[key] = value;

  vi.doMock('../../db/credentialRepository.js', () => ({
    saveCredential: vi.fn(async (record) => {
      saved.push(record);
      store.set(`${record.ownerId}:${record.toolId}`, {
        provider: record.provider,
        accessToken: record.accessToken,
        refreshToken: record.refreshToken ?? null,
        expiresAt: record.expiresAt ?? null,
        scopes: record.scopes,
      });
    }),
    readCredential: vi.fn(async (ownerId, toolId) => store.get(`${ownerId}:${toolId}`) ?? null),
    updateAccessToken: vi.fn(async ({ ownerId, toolId, accessToken, expiresAt }) => {
      const key = `${ownerId}:${toolId}`;
      const current = store.get(key);
      if (current) store.set(key, { ...current, accessToken, expiresAt });
    }),
    deleteCredential: vi.fn(async (ownerId, toolId) => store.delete(`${ownerId}:${toolId}`)),
    listConnections: vi.fn(async () => []),
  }));

  return import('../google.js');
}

/** A fetch that returns a fixed JSON body and records the request. */
function tokenFetch(body, status = 200) {
  return vi.fn(async (url, init) => {
    tokenFetch.calls.push({ url, init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}
tokenFetch.calls = [];

beforeEach(() => {
  store.clear();
  saved.length = 0;
  tokenFetch.calls = [];
});

afterEach(() => {
  for (const key of Object.keys(BASE_ENV)) delete process.env[key];
  vi.doUnmock('../../db/credentialRepository.js');
});

describe('authorization challenge', () => {
  it('produces a verifier, an S256 challenge, and CSRF state', async () => {
    const { createAuthorizationChallenge } = await loadGoogle();
    const a = createAuthorizationChallenge();
    const b = createAuthorizationChallenge();

    expect(a.codeVerifier).toBeTruthy();
    expect(a.codeChallenge).toBeTruthy();
    expect(a.state).toBeTruthy();
    // The challenge is a hash of the verifier, so they must not be equal.
    expect(a.codeChallenge).not.toBe(a.codeVerifier);
    // Fresh values every time.
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
    expect(a.state).not.toBe(b.state);
  });

  it('builds a consent URL requesting offline access and only the tool scopes', async () => {
    const { buildAuthorizationUrl, GOOGLE_TOOL_SCOPES } = await loadGoogle();
    const url = new URL(
      buildAuthorizationUrl({ toolId: 'gmail', codeChallenge: 'challenge', state: 'state123' }),
    );

    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe('challenge');
    expect(url.searchParams.get('state')).toBe('state123');
    expect(url.searchParams.get('scope')).toBe(GOOGLE_TOOL_SCOPES.gmail.join(' '));
    // The secret must never appear in a URL the browser follows.
    expect(url.searchParams.get('client_secret')).toBeNull();
  });

  it('refuses an unknown tool', async () => {
    const { buildAuthorizationUrl, OAuthError } = await loadGoogle();
    expect(() =>
      buildAuthorizationUrl({ toolId: 'dropbox', codeChallenge: 'c', state: 's' }),
    ).toThrow(OAuthError);
  });
});

describe('exchangeCodeForCredential', () => {
  it('stores the tokens and reports offline when a refresh token comes back', async () => {
    const { exchangeCodeForCredential } = await loadGoogle();
    const fetchImpl = tokenFetch({
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      expires_in: 3600,
      scope: 'https://www.googleapis.com/auth/gmail.send',
    });

    const result = await exchangeCodeForCredential({
      ownerId: 'operator',
      toolId: 'gmail',
      code: 'auth-code',
      codeVerifier: 'verifier',
      fetchImpl,
    });

    expect(result.offline).toBe(true);
    const stored = store.get('operator:gmail');
    expect(stored.accessToken).toBe('access-1');
    expect(stored.refreshToken).toBe('refresh-1');

    // The exchange sends the code, the verifier and the SECRET — server side only.
    const body = tokenFetch.calls[0].init.body;
    expect(body).toContain('code=auth-code');
    expect(body).toContain('code_verifier=verifier');
    expect(body).toContain('client_secret=test-client-secret');
  });

  it('reports offline=false when Google returns no refresh token', async () => {
    const { exchangeCodeForCredential } = await loadGoogle();
    const fetchImpl = tokenFetch({ access_token: 'access-1', expires_in: 3600, scope: '' });

    const result = await exchangeCodeForCredential({
      ownerId: 'operator',
      toolId: 'gmail',
      code: 'c',
      codeVerifier: 'v',
      fetchImpl,
    });

    expect(result.offline).toBe(false);
  });

  it('surfaces a Google rejection as an OAuthError without echoing the body', async () => {
    const { exchangeCodeForCredential, OAuthError } = await loadGoogle();
    const fetchImpl = tokenFetch({ error: 'invalid_grant' }, 400);

    await expect(
      exchangeCodeForCredential({
        ownerId: 'operator',
        toolId: 'gmail',
        code: 'bad',
        codeVerifier: 'v',
        fetchImpl,
      }),
    ).rejects.toMatchObject({ reason: 'invalid_grant', status: 401 });

    await expect(
      exchangeCodeForCredential({
        ownerId: 'operator',
        toolId: 'gmail',
        code: 'bad',
        codeVerifier: 'v',
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(OAuthError);
  });
});

describe('getAccessToken', () => {
  it('returns the stored token while it is still valid', async () => {
    const { getAccessToken } = await loadGoogle();
    store.set('operator:gmail', {
      provider: 'google',
      accessToken: 'still-good',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      scopes: [],
    });

    const fetchImpl = tokenFetch({});
    const token = await getAccessToken('operator', 'gmail', { fetchImpl });

    expect(token).toBe('still-good');
    // No refresh call was needed.
    expect(tokenFetch.calls).toHaveLength(0);
  });

  it('refreshes when the token is within the safety margin', async () => {
    const { getAccessToken } = await loadGoogle();
    store.set('operator:gmail', {
      provider: 'google',
      accessToken: 'about-to-expire',
      refreshToken: 'refresh-1',
      expiresAt: Date.now() + 30_000, // inside the 120s margin
      scopes: [],
    });

    const fetchImpl = tokenFetch({ access_token: 'fresh', expires_in: 3600 });
    const token = await getAccessToken('operator', 'gmail', { fetchImpl });

    expect(token).toBe('fresh');
    expect(tokenFetch.calls[0].init.body).toContain('grant_type=refresh_token');
    // The new token is persisted for next time.
    expect(store.get('operator:gmail').accessToken).toBe('fresh');
  });

  it('reports not_connected when there is no credential', async () => {
    const { getAccessToken } = await loadGoogle();
    await expect(
      getAccessToken('operator', 'gmail', { fetchImpl: tokenFetch({}) }),
    ).rejects.toMatchObject({ reason: 'not_connected', status: 401 });
  });

  it('reports refresh_unavailable rather than sending an expired token', async () => {
    const { getAccessToken } = await loadGoogle();
    store.set('operator:gmail', {
      provider: 'google',
      accessToken: 'expired',
      refreshToken: null, // implicit-flow leftover, nothing to refresh with
      expiresAt: Date.now() - 1000,
      scopes: [],
    });

    await expect(
      getAccessToken('operator', 'gmail', { fetchImpl: tokenFetch({}) }),
    ).rejects.toMatchObject({ reason: 'refresh_unavailable', status: 401 });
  });
});

describe('revokeCredential', () => {
  it('sends the token in the body, not the query string', async () => {
    const { revokeCredential } = await loadGoogle();
    store.set('operator:gmail', {
      provider: 'google',
      accessToken: 'a',
      refreshToken: 'refresh-to-revoke',
      expiresAt: null,
      scopes: [],
    });

    const fetchImpl = tokenFetch({});
    await revokeCredential('operator', 'gmail', { fetchImpl });

    const { url, init } = tokenFetch.calls[0];
    expect(url).toBe('https://oauth2.googleapis.com/revoke');
    // The old browser code put the token in the URL, where it lands in logs.
    expect(url).not.toContain('refresh-to-revoke');
    expect(init.body).toContain('token=refresh-to-revoke');
  });

  it('is a no-op for a tool that is not connected', async () => {
    const { revokeCredential } = await loadGoogle();
    const fetchImpl = tokenFetch({});
    expect(await revokeCredential('operator', 'gmail', { fetchImpl })).toBe(false);
    expect(tokenFetch.calls).toHaveLength(0);
  });
});

describe('configuration', () => {
  it('is configured when all three variables are present', async () => {
    const { isGoogleOAuthConfigured } = await loadGoogle();
    expect(isGoogleOAuthConfigured()).toBe(true);
  });
});
