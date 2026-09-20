import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Env validation must fail loudly and name the missing variable, so a
 * misconfigured deployment is caught at boot rather than mid-workflow.
 */

const originalEnv = { ...process.env };

/** Load a fresh copy of the env module under a controlled environment. */
/** Valid auth config, so tests can focus on whatever they actually assert. */
const VALID_AUTH = {
  APP_PASSWORD: 'test-operator-password',
  SESSION_SECRET: 'a'.repeat(64),
};

async function loadEnv(overrides) {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, {
    // Never read the developer's real .env files during tests.
    AUTOAGENT_SKIP_ENV_FILES: '1',
    ...VALID_AUTH,
    ...overrides,
  });
  vi.resetModules();
  return import('../env.js');
}

describe('server env validation', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    vi.restoreAllMocks();
  });

  it('fails startup when the selected provider has no credential', async () => {
    await expect(loadEnv({ AI_PROVIDER: 'openrouter' })).rejects.toThrow(
      /Invalid server configuration/,
    );
  });

  it('names the exact missing variable in the failure output', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(loadEnv({ AI_PROVIDER: 'gemini' })).rejects.toThrow();

    const output = errorSpy.mock.calls.flat().join('\n');
    expect(output).toContain('GEMINI_API_KEY');
    expect(output).toContain('AI_PROVIDER is "gemini"');
  });

  it('boots for ollama without any API key', async () => {
    const { env } = await loadEnv({ AI_PROVIDER: 'ollama' });
    expect(env.AI_PROVIDER).toBe('ollama');
    expect(env.OLLAMA_MODEL).toBe('deepseek-r1:8b');
  });

  it('boots when the selected provider does have its credential', async () => {
    const { env } = await loadEnv({
      AI_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: 'test-key-value-not-real',
    });
    expect(env.AI_PROVIDER).toBe('openrouter');
    expect(env.PORT).toBe(3234);
  });

  it('applies defaults and coerces types', async () => {
    const { env } = await loadEnv({
      AI_PROVIDER: 'ollama',
      PORT: '4001',
      WHATSAPP_ENABLED: 'true',
      CORS_ALLOWED_ORIGINS: 'https://a.example, https://b.example',
    });
    expect(env.PORT).toBe(4001);
    expect(env.WHATSAPP_ENABLED).toBe(true);
    expect(env.CORS_ALLOWED_ORIGINS).toEqual(['https://a.example', 'https://b.example']);
    // WhatsApp defaults off (Task 17) unless explicitly enabled.
    const { env: defaults } = await loadEnv({ AI_PROVIDER: 'ollama' });
    expect(defaults.WHATSAPP_ENABLED).toBe(false);
  });

  describe('production database TLS (Task 18)', () => {
    const prodBase = {
      NODE_ENV: 'production',
      AI_PROVIDER: 'ollama',
      DB_PASSWORD: 'a-real-db-password',
      DB_HOST: 'db', // a non-local host, e.g. a compose service
    };

    it('requires TLS when the DB host is not local and no trust flag is set', async () => {
      await expect(loadEnv({ ...prodBase, DB_SSL: 'false' })).rejects.toThrow(
        /Invalid server configuration/,
      );
    });

    it('accepts a private-network DB when DB_TRUST_PRIVATE_NETWORK is set', async () => {
      const { env } = await loadEnv({
        ...prodBase,
        DB_SSL: 'false',
        DB_TRUST_PRIVATE_NETWORK: 'true',
      });
      expect(env.DB_HOST).toBe('db');
      expect(env.DB_TRUST_PRIVATE_NETWORK).toBe(true);
    });

    it('accepts a non-local DB when DB_SSL is on, without the trust flag', async () => {
      const { env } = await loadEnv({ ...prodBase, DB_SSL: 'true' });
      expect(env.DB_SSL).toBe(true);
    });

    it('treats an empty GOOGLE_OAUTH_REDIRECT_URI as unset, not an invalid URL', async () => {
      // Containers and `${VAR:-}` compose substitutions routinely inject an empty
      // string; that must read as "not set", not fail validation.
      const { env } = await loadEnv({
        AI_PROVIDER: 'ollama',
        GOOGLE_OAUTH_REDIRECT_URI: '',
        GOOGLE_CLIENT_ID: '',
        GOOGLE_CLIENT_SECRET: '',
      });
      expect(env.GOOGLE_OAUTH_REDIRECT_URI).toBeUndefined();
    });

    // Base config that satisfies the OTHER production guards (DB password, DB
    // TLS trust), so these tests isolate the OAuth-redirect rule alone.
    const PROD_BASE = {
      AI_PROVIDER: 'ollama',
      NODE_ENV: 'production',
      SESSION_COOKIE_SECURE: 'true',
      DB_PASSWORD: 'prod-db-password',
      DB_TRUST_PRIVATE_NETWORK: 'true',
      CREDENTIAL_SECRET: 'c'.repeat(64),
      GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'secret',
    };

    it('rejects a plain-http OAuth redirect in production by default', async () => {
      await expect(
        loadEnv({
          ...PROD_BASE,
          GOOGLE_OAUTH_REDIRECT_URI: 'http://localhost:3234/api/oauth/google/callback',
        }),
      ).rejects.toThrow(/Invalid server configuration/);
    });

    it('allows a loopback http redirect in production when explicitly opted in', async () => {
      const { env } = await loadEnv({
        ...PROD_BASE,
        OAUTH_ALLOW_INSECURE_REDIRECT: 'true',
        GOOGLE_OAUTH_REDIRECT_URI: 'http://localhost:3234/api/oauth/google/callback',
      });
      expect(env.GOOGLE_OAUTH_REDIRECT_URI).toBe('http://localhost:3234/api/oauth/google/callback');
    });

    it('does not let the opt-in flag excuse a non-loopback http redirect', async () => {
      // The escape hatch is only for traffic that never leaves the machine.
      await expect(
        loadEnv({
          ...PROD_BASE,
          OAUTH_ALLOW_INSECURE_REDIRECT: 'true',
          GOOGLE_OAUTH_REDIRECT_URI: 'http://example.com/api/oauth/google/callback',
        }),
      ).rejects.toThrow(/Invalid server configuration/);
    });

    it('does not require TLS for a local DB in production', async () => {
      const { env } = await loadEnv({
        NODE_ENV: 'production',
        AI_PROVIDER: 'ollama',
        DB_PASSWORD: 'a-real-db-password',
        DB_HOST: '127.0.0.1',
        DB_SSL: 'false',
      });
      expect(env.DB_HOST).toBe('127.0.0.1');
    });
  });

  it('rejects an out-of-range port instead of silently defaulting', async () => {
    await expect(loadEnv({ AI_PROVIDER: 'ollama', PORT: '99999' })).rejects.toThrow(
      /Invalid server configuration/,
    );
  });

  it('never exposes credential values through publicAiConfig', async () => {
    const secret = 'super-secret-openrouter-key-abcdef123456';
    const { publicAiConfig } = await loadEnv({
      AI_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: secret,
      GEMINI_API_KEY: 'another-secret-value-xyz789',
    });

    const serialized = JSON.stringify(publicAiConfig());
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('another-secret-value-xyz789');
    // It does report *whether* a provider is usable.
    expect(publicAiConfig().providers.openrouter.configured).toBe(true);
    expect(publicAiConfig().providers.gemini.configured).toBe(true);
  });

  it('treats an empty or whitespace credential as unset, not invalid', async () => {
    // Container and CI configs routinely emit `KEY=` with no value; that must
    // behave the same as omitting it rather than failing validation.
    const { env, publicAiConfig } = await loadEnv({
      AI_PROVIDER: 'ollama',
      OPENROUTER_API_KEY: '',
      GEMINI_API_KEY: '   ',
    });

    expect(env.OPENROUTER_API_KEY).toBeUndefined();
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(publicAiConfig().providers.openrouter.configured).toBe(false);
    expect(publicAiConfig().providers.gemini.configured).toBe(false);
  });

  it('still fails when the selected provider key is empty rather than missing', async () => {
    await expect(loadEnv({ AI_PROVIDER: 'openrouter', OPENROUTER_API_KEY: '' })).rejects.toThrow(
      /Invalid server configuration/,
    );
  });

  it('reports a provider as unconfigured when its key is absent', async () => {
    const { publicAiConfig } = await loadEnv({ AI_PROVIDER: 'ollama' });
    expect(publicAiConfig().providers.openrouter.configured).toBe(false);
    expect(publicAiConfig().providers.gemini.configured).toBe(false);
    expect(publicAiConfig().providers.ollama.configured).toBe(true);
  });
});

describe('render-tier fetch knobs', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    vi.restoreAllMocks();
  });

  it('defaults rendering to OFF with sane timeouts', async () => {
    const { env } = await loadEnv({ AI_PROVIDER: 'ollama' });
    expect(env.FETCH_RENDER_ENABLED).toBe(false);
    expect(env.FETCH_RENDER_TIMEOUT_MS).toBe(20_000);
    expect(env.FETCH_RENDER_SETTLE_MS).toBe(1_500);
  });

  it('defaults the JSON body limit generously so AI nodes are not size-capped', async () => {
    const { env } = await loadEnv({ AI_PROVIDER: 'ollama' });
    expect(env.JSON_BODY_LIMIT).toBe('50mb');
  });

  it('gives the render tier a larger byte cap than the plain fetch', async () => {
    const { env } = await loadEnv({ AI_PROVIDER: 'ollama' });
    // A rendered SPA is much bigger than raw HTML, so its cap must exceed the
    // plain-fetch cap or every rendered page is rejected as too large.
    expect(env.FETCH_RENDER_MAX_BYTES).toBeGreaterThan(env.FETCH_MAX_BYTES);
  });

  it('turns rendering on with a booleanish value', async () => {
    const { env } = await loadEnv({ AI_PROVIDER: 'ollama', FETCH_RENDER_ENABLED: 'true' });
    expect(env.FETCH_RENDER_ENABLED).toBe(true);
  });

  it('accepts overridden render timeouts within range', async () => {
    const { env } = await loadEnv({
      AI_PROVIDER: 'ollama',
      FETCH_RENDER_TIMEOUT_MS: '30000',
      FETCH_RENDER_SETTLE_MS: '3000',
    });
    expect(env.FETCH_RENDER_TIMEOUT_MS).toBe(30_000);
    expect(env.FETCH_RENDER_SETTLE_MS).toBe(3_000);
  });

  it('rejects a render timeout over the allowed maximum', async () => {
    await expect(
      loadEnv({ AI_PROVIDER: 'ollama', FETCH_RENDER_TIMEOUT_MS: '999999' }),
    ).rejects.toThrow(/Invalid server configuration/);
  });
});
